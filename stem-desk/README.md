# StemMixer

Synchronized multi-stem playback on the Web Audio API. This is the mixing engine
for a stem-separation app: N stems play as one, each with its own fader, mute and
solo, under a single transport.

This is the part with no prior art in VoiceStudio. Its separation pipeline, job
queue and progress streaming all exist and work; multi-stem synchronized playback
does not, because dubbing does not need it.

## The sync guarantee

The one thing this engine must never get wrong is drift. Six stems that start
independently will phase against each other audibly within a minute, and the bug
is silent — nothing throws, the audio just slowly smears.

The guarantee is enforced in one place. Every source for a playback run is
scheduled at **one shared `startAt` timestamp** with **one shared buffer offset**,
in a loop that never awaits:

```js
const startAt = ctx.currentTime + lookahead;
for (const [name, stem] of this.stems) {
  const source = ctx.createBufferSource();
  source.buffer = stem.buffer;
  source.connect(stem.gain);
  source.start(startAt, offset);   // same startAt, same offset, every stem
}
```

`AudioBufferSourceNode` is one-shot: once stopped it can never restart. Seeking
therefore tears down every source and builds a fresh set. That is not a
workaround, it is the API's intended use.

## Graph

```
AudioBufferSourceNode ─┐
                       ├─> GainNode (fader / mute / solo) ─> destination
      one per stem ────┘
```

## Usage

```js
import { StemMixer } from "./src/StemMixer.js";

const ctx = new AudioContext();
const mixer = new StemMixer(ctx);

mixer.load({ vocals, drums, bass, guitar, piano, other });  // AudioBuffers

mixer.play();
mixer.setFader("vocals", 0);      // instrumental
mixer.setSolo("drums", true);     // drums alone
mixer.seek(90);
mixer.pause();

mixer.on("ended", () => { /* ... */ });
const snapshot = mixer.state();   // everything a channel strip needs
```

### Gain resolution

Mute always wins. A solo anywhere silences everything not soloed. Otherwise the
fader stands. A soloed stem keeps its own fader position rather than jumping to
unity.

```
mute            -> 0
anySolo && !solo -> 0
otherwise        -> fader
```

Fader moves are applied with `setTargetAtTime`, not assignment — a step change on
a running signal clicks.

## Tests

```
npm test           # 35 transport/gain tests against a fake AudioContext
npm run test:browser   # 10 checks in real Chromium against real Web Audio
npm run test:all
```

The fake context has a manual clock, so position math, pause/resume and seek are
tested deterministically rather than with sleeps. It records every scheduled
start, which is how the sync guarantee is asserted rather than assumed.

The browser smoke test exists because a fake cannot tell you the engine survives
a real `AudioContext` — one-shot source semantics and `InvalidStateError` on
restart only show up against the real thing.

## Dev harness

```
npm run demo   # http://localhost:8080/demo/index.html
```

Load your own stem files, or hit **Synthesize test tones** for four harmonically
related tones with a pulse every second. If the engine ever drifts, those pulses
separate audibly — it is a faster sync check than listening to real stems.

## Not done yet

- Waveform rendering per channel
- Backend wiring to the Demucs job pipeline (`htdemucs_6s`, six stems)
- Keyboard transport shortcuts
- Persisting a mix across reloads
