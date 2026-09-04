/**
 * A minimal but faithful stand-in for the slice of Web Audio that StemMixer
 * touches. The clock is manual so tests can advance time deterministically.
 *
 * It records every scheduled start so tests can assert the sync guarantee:
 * all stems in one run must share a startAt and an offset.
 */

export class FakeAudioParam {
  constructor(value = 1) {
    this.value = value;
    this.calls = [];
  }
  setValueAtTime(v, t) {
    this.value = v;
    this.calls.push({ type: "setValueAtTime", value: v, time: t });
    return this;
  }
  setTargetAtTime(v, t, tc) {
    // Real setTargetAtTime approaches asymptotically; for assertions we treat
    // the target as reached, which is what callers care about.
    this.value = v;
    this.calls.push({ type: "setTargetAtTime", value: v, time: t, timeConstant: tc });
    return this;
  }
  linearRampToValueAtTime(v, t) {
    this.value = v;
    this.calls.push({ type: "linearRampToValueAtTime", value: v, time: t });
    return this;
  }
  cancelScheduledValues(t) {
    this.calls.push({ type: "cancelScheduledValues", time: t });
    return this;
  }
}

export class FakeGainNode {
  constructor(ctx) {
    this.context = ctx;
    this.gain = new FakeAudioParam(1);
    this.connectedTo = null;
    this.disconnectCount = 0;
  }
  connect(dest) {
    this.connectedTo = dest;
    return dest;
  }
  disconnect() {
    this.connectedTo = null;
    this.disconnectCount++;
  }
}

export class FakeBufferSource {
  constructor(ctx) {
    this.context = ctx;
    this.buffer = null;
    this.onended = null;
    this.connectedTo = null;
    this.started = null; // {when, offset}
    this.stopped = null; // when
    this._startCount = 0;
  }
  connect(dest) {
    this.connectedTo = dest;
    return dest;
  }
  disconnect() {
    this.connectedTo = null;
  }
  start(when = 0, offset = 0) {
    // Mirrors the real one-shot contract.
    if (this._startCount > 0) throw new Error("InvalidStateError: cannot start twice");
    this._startCount++;
    this.started = { when, offset };
    this.context._scheduled.push(this);
  }
  stop(when) {
    if (this._startCount === 0) throw new Error("InvalidStateError: not started");
    this.stopped = when ?? this.context.currentTime;
  }
}

export class FakeAudioContext {
  constructor(startTime = 0) {
    this.currentTime = startTime;
    this.destination = { name: "destination" };
    this.sampleRate = 44100;
    this._scheduled = [];
  }
  createGain() {
    return new FakeGainNode(this);
  }
  createBufferSource() {
    return new FakeBufferSource(this);
  }
  /** Advance the clock. Does not auto-fire onended; tests do that explicitly. */
  advance(seconds) {
    this.currentTime += seconds;
    return this.currentTime;
  }
}

/** Build a fake AudioBuffer of a given length. */
export function buffer(duration, sampleRate = 44100) {
  return {
    duration,
    sampleRate,
    length: Math.round(duration * sampleRate),
    numberOfChannels: 2,
  };
}

/** The six stems htdemucs_6s produces, all the same length. */
export function sixStems(duration = 210) {
  return {
    vocals: buffer(duration),
    drums: buffer(duration),
    bass: buffer(duration),
    guitar: buffer(duration),
    piano: buffer(duration),
    other: buffer(duration),
  };
}
