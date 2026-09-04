/**
 * StemMixer — synchronized multi-stem playback on the Web Audio API.
 *
 * The whole point of this class is that N stems stay sample-accurate against
 * each other for the life of the session. That is achieved by never starting a
 * source on its own clock: every source for a given playback run is scheduled
 * at ONE shared `startAt` timestamp with ONE shared buffer offset, and the Web
 * Audio scheduler aligns them. Any design where sources are started
 * independently (e.g. inside a loop that awaits, or on separate user events)
 * will drift audibly within a minute.
 *
 * AudioBufferSourceNode is one-shot: once stopped it can never restart. Seeking
 * therefore tears down every source and builds a fresh set. That is not a
 * workaround, it is how the API is meant to be used.
 *
 * Graph, per stem:
 *   AudioBufferSourceNode -> GainNode (fader/mute/solo) -> destination
 */

const DEFAULTS = {
  /** Seconds of scheduling headroom so every source is queued before the clock
   *  reaches startAt. Too small and the first stems can start late on a busy
   *  main thread; too large and play() feels sluggish. */
  lookahead: 0.06,
  /** setTargetAtTime time constant for fader moves. ~10ms reaches the target in
   *  roughly 30ms, which removes zipper noise without an audible slew. */
  rampTimeConstant: 0.01,
};

export class StemMixer {
  /**
   * @param {BaseAudioContext} context
   * @param {{lookahead?: number, rampTimeConstant?: number}} [options]
   */
  constructor(context, options = {}) {
    if (!context) throw new Error("StemMixer requires an AudioContext");
    this.context = context;
    this.options = { ...DEFAULTS, ...options };

    /** @type {Map<string, {buffer: AudioBuffer, gain: GainNode, fader: number, mute: boolean, solo: boolean}>} */
    this.stems = new Map();
    /** @type {Map<string, AudioBufferSourceNode>} */
    this._sources = new Map();

    this._playing = false;
    this._startedAt = 0; // context time the current run was scheduled to begin
    this._offset = 0; // buffer position that run began from
    this._duration = 0;
    this._tearingDown = false; // suppresses onended during an intentional stop
    this._listeners = new Map();
  }

  // ---------------------------------------------------------------- loading

  /**
   * Install decoded stems. Replaces any existing set.
   * @param {Record<string, AudioBuffer>} buffers
   */
  load(buffers) {
    const names = Object.keys(buffers);
    if (names.length === 0) throw new Error("load() needs at least one stem");

    this.stop();
    this._disconnectAll();
    this.stems.clear();

    let longest = 0;
    for (const name of names) {
      const buffer = buffers[name];
      if (!buffer) throw new Error(`Stem "${name}" has no buffer`);

      const gain = this.context.createGain();
      gain.gain.value = 1;
      gain.connect(this.context.destination);

      this.stems.set(name, { buffer, gain, fader: 1, mute: false, solo: false });
      longest = Math.max(longest, buffer.duration);
    }

    this._duration = longest;
    this._offset = 0;
    this._applyGains(true);
    this._emit("load", { names, duration: longest });
    return this;
  }

  /** Stems whose length differs from the longest by more than `tolerance`
   *  seconds. Demucs returns equal-length stems, so a non-empty result here
   *  means something upstream re-encoded or trimmed them and sync is at risk. */
  lengthMismatches(tolerance = 0.001) {
    const out = [];
    for (const [name, stem] of this.stems) {
      const delta = this._duration - stem.buffer.duration;
      if (delta > tolerance) out.push({ name, duration: stem.buffer.duration, delta });
    }
    return out;
  }

  // -------------------------------------------------------------- transport

  get playing() {
    return this._playing;
  }

  get duration() {
    return this._duration;
  }

  /** Current playback position in seconds. Valid whether playing or paused. */
  get position() {
    if (!this._playing) return this._offset;
    const elapsed = this.context.currentTime - this._startedAt;
    // During the lookahead window elapsed is negative: the run has not begun.
    if (elapsed <= 0) return this._offset;
    return Math.min(this._offset + elapsed, this._duration);
  }

  play() {
    if (this._playing || this.stems.size === 0) return this;
    if (this._offset >= this._duration) this._offset = 0;

    const startAt = this.context.currentTime + this.options.lookahead;
    const offset = this._offset;

    // One timestamp, one offset, every source. Do not await inside this loop.
    let longestName = null;
    let longestDuration = -1;
    for (const [name, stem] of this.stems) {
      const source = this.context.createBufferSource();
      source.buffer = stem.buffer;
      source.connect(stem.gain);
      source.start(startAt, offset);
      this._sources.set(name, source);
      if (stem.buffer.duration > longestDuration) {
        longestDuration = stem.buffer.duration;
        longestName = name;
      }
    }

    // Only the longest stem reports natural completion, so `ended` fires once.
    const anchor = this._sources.get(longestName);
    if (anchor) {
      anchor.onended = () => {
        if (this._tearingDown) return;
        this._playing = false;
        this._offset = this._duration;
        this._sources.clear();
        this._emit("ended", { position: this._duration });
      };
    }

    this._startedAt = startAt;
    this._playing = true;
    this._emit("play", { position: offset, startAt });
    return this;
  }

  pause() {
    if (!this._playing) return this;
    const at = this.position;
    this._teardownSources();
    this._offset = at;
    this._playing = false;
    this._emit("pause", { position: at });
    return this;
  }

  /** Stop and rewind to zero. */
  stop() {
    if (this._playing) this._teardownSources();
    this._playing = false;
    this._offset = 0;
    return this;
  }

  /**
   * Move the playhead. Resumes playing if it was playing, which requires a
   * fresh set of source nodes — the old ones are spent.
   * @param {number} seconds
   */
  seek(seconds) {
    const target = Math.max(0, Math.min(seconds, this._duration));
    const wasPlaying = this._playing;
    if (wasPlaying) this._teardownSources();
    this._playing = false;
    this._offset = target;
    if (wasPlaying) this.play();
    this._emit("seek", { position: target });
    return this;
  }

  // ------------------------------------------------------------------ mixer

  /**
   * @param {string} name
   * @param {number} value 0..1 linear
   */
  setFader(name, value) {
    const stem = this._require(name);
    stem.fader = Math.max(0, Math.min(value, 1));
    this._applyGains();
    this._emit("fader", { name, value: stem.fader });
    return this;
  }

  setMute(name, muted) {
    const stem = this._require(name);
    stem.mute = Boolean(muted);
    this._applyGains();
    this._emit("mute", { name, muted: stem.mute });
    return this;
  }

  setSolo(name, soloed) {
    const stem = this._require(name);
    stem.solo = Boolean(soloed);
    this._applyGains();
    this._emit("solo", { name, soloed: stem.solo, anySolo: this.anySolo });
    return this;
  }

  toggleMute(name) {
    return this.setMute(name, !this._require(name).mute);
  }

  toggleSolo(name) {
    return this.setSolo(name, !this._require(name).solo);
  }

  clearSolo() {
    for (const stem of this.stems.values()) stem.solo = false;
    this._applyGains();
    this._emit("solo", { name: null, soloed: false, anySolo: false });
    return this;
  }

  get anySolo() {
    for (const stem of this.stems.values()) if (stem.solo) return true;
    return false;
  }

  /**
   * The gain a stem should actually be at. Mute always wins; a solo elsewhere
   * silences everything not soloed; otherwise the fader stands.
   * @returns {number}
   */
  effectiveGain(name) {
    const stem = this._require(name);
    if (stem.mute) return 0;
    if (this.anySolo && !stem.solo) return 0;
    return stem.fader;
  }

  /** Snapshot for UI rendering. */
  state() {
    const stems = {};
    for (const [name, stem] of this.stems) {
      stems[name] = {
        fader: stem.fader,
        mute: stem.mute,
        solo: stem.solo,
        effective: this.effectiveGain(name),
        duration: stem.buffer.duration,
      };
    }
    return {
      playing: this._playing,
      position: this.position,
      duration: this._duration,
      anySolo: this.anySolo,
      stems,
    };
  }

  // ------------------------------------------------------------------ events

  on(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
    return () => this.off(type, fn);
  }

  off(type, fn) {
    const set = this._listeners.get(type);
    if (set) set.delete(fn);
    return this;
  }

  _emit(type, detail) {
    const set = this._listeners.get(type);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(detail);
      } catch (err) {
        // A listener throwing must not corrupt transport state.
        console.error(`StemMixer listener for "${type}" threw:`, err);
      }
    }
  }

  // ----------------------------------------------------------------- private

  _require(name) {
    const stem = this.stems.get(name);
    if (!stem) throw new Error(`Unknown stem "${name}"`);
    return stem;
  }

  _applyGains(immediate = false) {
    const now = this.context.currentTime;
    for (const [name, stem] of this.stems) {
      const target = this.effectiveGain(name);
      const param = stem.gain.gain;
      if (immediate) {
        param.setValueAtTime(target, now);
      } else {
        // Ramp rather than assign: a step change on a running signal clicks.
        param.setTargetAtTime(target, now, this.options.rampTimeConstant);
      }
    }
  }

  _teardownSources() {
    this._tearingDown = true;
    for (const source of this._sources.values()) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Already stopped or never started; nothing to unwind.
      }
      try {
        source.disconnect();
      } catch {
        /* not connected */
      }
    }
    this._sources.clear();
    this._tearingDown = false;
  }

  _disconnectAll() {
    for (const stem of this.stems.values()) {
      try {
        stem.gain.disconnect();
      } catch {
        /* not connected */
      }
    }
  }

  /** Release every node. The mixer is unusable afterwards. */
  dispose() {
    this.stop();
    this._disconnectAll();
    this.stems.clear();
    this._listeners.clear();
  }
}

export default StemMixer;
