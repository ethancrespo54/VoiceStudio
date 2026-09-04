import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { StemMixer } from "../src/StemMixer.js";
import { FakeAudioContext, sixStems, buffer } from "./fakeAudio.js";

let ctx;
let mixer;

beforeEach(() => {
  ctx = new FakeAudioContext(10); // non-zero start time catches bad clock math
  mixer = new StemMixer(ctx, { lookahead: 0.06 });
  mixer.load(sixStems(210));
});

describe("sync guarantee", () => {
  test("every stem is scheduled at one shared startAt and offset", () => {
    mixer.play();
    const starts = ctx._scheduled.map((s) => s.started);
    assert.equal(starts.length, 6, "all six stems scheduled");
    const when = new Set(starts.map((s) => s.when));
    const offset = new Set(starts.map((s) => s.offset));
    assert.equal(when.size, 1, "one startAt across all stems");
    assert.equal(offset.size, 1, "one offset across all stems");
  });

  test("startAt is in the future by exactly the lookahead", () => {
    mixer.play();
    assert.equal(ctx._scheduled[0].started.when, 10.06);
  });

  test("seeking re-schedules all stems together at the new offset", () => {
    mixer.play();
    ctx.advance(5);
    ctx._scheduled.length = 0;

    mixer.seek(120);
    const starts = ctx._scheduled.map((s) => s.started);
    assert.equal(starts.length, 6);
    assert.equal(new Set(starts.map((s) => s.when)).size, 1);
    assert.deepEqual([...new Set(starts.map((s) => s.offset))], [120]);
  });

  test("a spent source is never restarted", () => {
    mixer.play();
    const first = ctx._scheduled[0];
    mixer.seek(30);
    // seek() must have built fresh nodes, not reused the old one.
    assert.equal(first._startCount, 1);
    assert.equal(ctx._scheduled.length, 12);
    assert.notEqual(ctx._scheduled[6], first);
  });
});

describe("position", () => {
  test("reads as the offset before the lookahead window elapses", () => {
    mixer.seek(42);
    mixer.play();
    assert.equal(mixer.position, 42, "still 42 during lookahead");
    ctx.advance(0.03); // half the lookahead
    assert.equal(mixer.position, 42, "still 42 — playback has not begun");
  });

  test("advances with the context clock once playback begins", () => {
    mixer.play();
    ctx.advance(0.06); // reach startAt
    assert.equal(mixer.position, 0);
    ctx.advance(30);
    assert.equal(mixer.position, 30);
  });

  test("survives pause and resume without drifting", () => {
    mixer.play();
    ctx.advance(0.06 + 30);
    mixer.pause();
    assert.equal(mixer.position, 30);

    ctx.advance(600); // a long pause must not move the playhead
    assert.equal(mixer.position, 30);

    mixer.play();
    ctx.advance(0.06 + 10);
    assert.equal(mixer.position, 40);
  });

  test("clamps at duration rather than running past the end", () => {
    mixer.play();
    ctx.advance(0.06 + 5000);
    assert.equal(mixer.position, 210);
  });

  test("seek clamps to the track bounds", () => {
    mixer.seek(-50);
    assert.equal(mixer.position, 0);
    mixer.seek(99999);
    assert.equal(mixer.position, 210);
  });
});

describe("gain resolution", () => {
  test("fader passes through when nothing is muted or soloed", () => {
    mixer.setFader("vocals", 0.5);
    assert.equal(mixer.effectiveGain("vocals"), 0.5);
    assert.equal(mixer.effectiveGain("drums"), 1);
  });

  test("mute beats a raised fader", () => {
    mixer.setFader("vocals", 1);
    mixer.setMute("vocals", true);
    assert.equal(mixer.effectiveGain("vocals"), 0);
  });

  test("a solo silences every stem not soloed", () => {
    mixer.setSolo("vocals", true);
    assert.equal(mixer.effectiveGain("vocals"), 1);
    for (const name of ["drums", "bass", "guitar", "piano", "other"]) {
      assert.equal(mixer.effectiveGain(name), 0, `${name} silenced by solo`);
    }
  });

  test("mute still beats solo on the same stem", () => {
    mixer.setSolo("vocals", true);
    mixer.setMute("vocals", true);
    assert.equal(mixer.effectiveGain("vocals"), 0);
  });

  test("multiple solos are additive", () => {
    mixer.setSolo("vocals", true);
    mixer.setSolo("drums", true);
    assert.equal(mixer.effectiveGain("vocals"), 1);
    assert.equal(mixer.effectiveGain("drums"), 1);
    assert.equal(mixer.effectiveGain("bass"), 0);
  });

  test("clearing the last solo restores everyone", () => {
    mixer.setSolo("vocals", true);
    assert.equal(mixer.effectiveGain("bass"), 0);
    mixer.setSolo("vocals", false);
    assert.equal(mixer.effectiveGain("bass"), 1);
    assert.equal(mixer.anySolo, false);
  });

  test("soloed stems keep their own fader position", () => {
    mixer.setFader("vocals", 0.25);
    mixer.setSolo("vocals", true);
    assert.equal(mixer.effectiveGain("vocals"), 0.25);
  });

  test("fader input is clamped to 0..1", () => {
    mixer.setFader("vocals", 5);
    assert.equal(mixer.effectiveGain("vocals"), 1);
    mixer.setFader("vocals", -3);
    assert.equal(mixer.effectiveGain("vocals"), 0);
  });
});

describe("gain is ramped, not stepped", () => {
  test("fader moves schedule a ramp so they do not click", () => {
    for (const stem of mixer.stems.values()) stem.gain.gain.calls.length = 0;
    mixer.setFader("vocals", 0.3);

    const moved = mixer.stems.get("vocals").gain.gain.calls;
    assert.equal(moved.length, 1);
    assert.equal(moved[0].type, "setTargetAtTime", "ramped, not stepped");
    assert.equal(moved[0].value, 0.3);

    // Every stem is reconciled on each change, because a solo elsewhere can
    // change a stem's effective gain without its own fader moving.
    for (const [name, stem] of mixer.stems) {
      assert.equal(stem.gain.gain.calls.length, 1, `${name} reconciled once`);
    }
  });

  test("initial load sets gain immediately, no ramp from zero", () => {
    const fresh = new StemMixer(new FakeAudioContext(0));
    fresh.load(sixStems(10));
    const calls = fresh.stems.get("vocals").gain.gain.calls;
    assert.equal(calls.at(-1).type, "setValueAtTime");
  });
});

describe("transport state machine", () => {
  test("play is idempotent — no double scheduling", () => {
    mixer.play();
    mixer.play();
    assert.equal(ctx._scheduled.length, 6);
  });

  test("pause on a stopped mixer is a no-op", () => {
    assert.doesNotThrow(() => mixer.pause());
    assert.equal(mixer.playing, false);
  });

  test("stop rewinds to zero", () => {
    mixer.play();
    ctx.advance(0.06 + 60);
    mixer.stop();
    assert.equal(mixer.playing, false);
    assert.equal(mixer.position, 0);
  });

  test("playing from the end restarts at zero", () => {
    mixer.seek(210);
    mixer.play();
    assert.equal(ctx._scheduled[0].started.offset, 0);
  });

  test("stopped sources are disconnected", () => {
    mixer.play();
    const sources = [...ctx._scheduled];
    mixer.pause();
    for (const s of sources) {
      assert.notEqual(s.stopped, null, "stop() called");
      assert.equal(s.connectedTo, null, "disconnected");
    }
  });
});

describe("natural end", () => {
  test("fires ended once, from the longest stem only", () => {
    let count = 0;
    mixer.on("ended", () => count++);
    mixer.play();
    for (const s of ctx._scheduled) if (s.onended) s.onended();
    assert.equal(count, 1);
    assert.equal(mixer.playing, false);
    assert.equal(mixer.position, 210);
  });

  test("does not fire when the stop was intentional", () => {
    let fired = false;
    mixer.on("ended", () => (fired = true));
    mixer.play();
    mixer.pause();
    assert.equal(fired, false);
  });
});

describe("uneven stem lengths", () => {
  test("duration is the longest stem", () => {
    const m = new StemMixer(new FakeAudioContext(0));
    m.load({ vocals: buffer(200), drums: buffer(210.5), bass: buffer(199) });
    assert.equal(m.duration, 210.5);
  });

  test("mismatches are reported so the UI can warn", () => {
    const m = new StemMixer(new FakeAudioContext(0));
    m.load({ vocals: buffer(210), drums: buffer(210), bass: buffer(207) });
    const bad = m.lengthMismatches();
    assert.equal(bad.length, 1);
    assert.equal(bad[0].name, "bass");
    assert.ok(Math.abs(bad[0].delta - 3) < 1e-9);
  });

  test("equal-length stems report no mismatch", () => {
    assert.deepEqual(mixer.lengthMismatches(), []);
  });
});

describe("errors and edges", () => {
  test("unknown stem names throw rather than silently no-op", () => {
    assert.throws(() => mixer.setFader("theremin", 0.5), /Unknown stem/);
    assert.throws(() => mixer.setMute("theremin", true), /Unknown stem/);
  });

  test("load with no stems throws", () => {
    assert.throws(() => mixer.load({}), /at least one stem/);
  });

  test("constructing without a context throws", () => {
    assert.throws(() => new StemMixer(null), /requires an AudioContext/);
  });

  test("a throwing listener does not corrupt transport state", () => {
    mixer.on("play", () => {
      throw new Error("listener blew up");
    });
    mixer.play();
    assert.equal(mixer.playing, true, "still transitioned to playing");
  });

  test("reload replaces the previous set and rewinds", () => {
    mixer.play();
    ctx.advance(0.06 + 30);
    mixer.load({ vocals: buffer(60), drums: buffer(60) });
    assert.equal(mixer.stems.size, 2);
    assert.equal(mixer.duration, 60);
    assert.equal(mixer.position, 0);
    assert.equal(mixer.playing, false);
  });
});

describe("state snapshot", () => {
  test("reports what a channel strip needs to render", () => {
    mixer.setFader("vocals", 0.4);
    mixer.setSolo("drums", true);
    const s = mixer.state();
    assert.equal(s.anySolo, true);
    assert.equal(s.stems.vocals.fader, 0.4);
    assert.equal(s.stems.vocals.effective, 0, "silenced by the drums solo");
    assert.equal(s.stems.drums.effective, 1);
    assert.equal(s.duration, 210);
  });
});
