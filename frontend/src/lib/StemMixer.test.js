import { describe, test, expect, beforeEach } from "vitest";
import { StemMixer } from "./StemMixer.js";
import { FakeAudioContext, sixStems, buffer } from "../test/fakeAudio.js";

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
    expect(starts.length).toBe(6);
    const when = new Set(starts.map((s) => s.when));
    const offset = new Set(starts.map((s) => s.offset));
    expect(when.size).toBe(1);
    expect(offset.size).toBe(1);
  });

  test("startAt is in the future by exactly the lookahead", () => {
    mixer.play();
    expect(ctx._scheduled[0].started.when).toBe(10.06);
  });

  test("seeking re-schedules all stems together at the new offset", () => {
    mixer.play();
    ctx.advance(5);
    ctx._scheduled.length = 0;

    mixer.seek(120);
    const starts = ctx._scheduled.map((s) => s.started);
    expect(starts.length).toBe(6);
    expect(new Set(starts.map((s) => s.when)).size).toBe(1);
    expect([...new Set(starts.map((s) => s.offset))]).toEqual([120]);
  });

  test("a spent source is never restarted", () => {
    mixer.play();
    const first = ctx._scheduled[0];
    mixer.seek(30);
    // seek() must have built fresh nodes, not reused the old one.
    expect(first._startCount).toBe(1);
    expect(ctx._scheduled.length).toBe(12);
    expect(ctx._scheduled[6]).not.toBe(first);
  });
});

describe("position", () => {
  test("reads as the offset before the lookahead window elapses", () => {
    mixer.seek(42);
    mixer.play();
    expect(mixer.position).toBe(42);
    ctx.advance(0.03); // half the lookahead
    expect(mixer.position).toBe(42);
  });

  test("advances with the context clock once playback begins", () => {
    mixer.play();
    ctx.advance(0.06); // reach startAt
    expect(mixer.position).toBe(0);
    ctx.advance(30);
    expect(mixer.position).toBe(30);
  });

  test("survives pause and resume without drifting", () => {
    mixer.play();
    ctx.advance(0.06 + 30);
    mixer.pause();
    expect(mixer.position).toBe(30);

    ctx.advance(600); // a long pause must not move the playhead
    expect(mixer.position).toBe(30);

    mixer.play();
    ctx.advance(0.06 + 10);
    expect(mixer.position).toBe(40);
  });

  test("clamps at duration rather than running past the end", () => {
    mixer.play();
    ctx.advance(0.06 + 5000);
    expect(mixer.position).toBe(210);
  });

  test("seek clamps to the track bounds", () => {
    mixer.seek(-50);
    expect(mixer.position).toBe(0);
    mixer.seek(99999);
    expect(mixer.position).toBe(210);
  });
});

describe("gain resolution", () => {
  test("fader passes through when nothing is muted or soloed", () => {
    mixer.setFader("vocals", 0.5);
    expect(mixer.effectiveGain("vocals")).toBe(0.5);
    expect(mixer.effectiveGain("drums")).toBe(1);
  });

  test("mute beats a raised fader", () => {
    mixer.setFader("vocals", 1);
    mixer.setMute("vocals", true);
    expect(mixer.effectiveGain("vocals")).toBe(0);
  });

  test("a solo silences every stem not soloed", () => {
    mixer.setSolo("vocals", true);
    expect(mixer.effectiveGain("vocals")).toBe(1);
    for (const name of ["drums", "bass", "guitar", "piano", "other"]) {
      expect(mixer.effectiveGain(name)).toBe(0);
    }
  });

  test("mute still beats solo on the same stem", () => {
    mixer.setSolo("vocals", true);
    mixer.setMute("vocals", true);
    expect(mixer.effectiveGain("vocals")).toBe(0);
  });

  test("multiple solos are additive", () => {
    mixer.setSolo("vocals", true);
    mixer.setSolo("drums", true);
    expect(mixer.effectiveGain("vocals")).toBe(1);
    expect(mixer.effectiveGain("drums")).toBe(1);
    expect(mixer.effectiveGain("bass")).toBe(0);
  });

  test("clearing the last solo restores everyone", () => {
    mixer.setSolo("vocals", true);
    expect(mixer.effectiveGain("bass")).toBe(0);
    mixer.setSolo("vocals", false);
    expect(mixer.effectiveGain("bass")).toBe(1);
    expect(mixer.anySolo).toBe(false);
  });

  test("soloed stems keep their own fader position", () => {
    mixer.setFader("vocals", 0.25);
    mixer.setSolo("vocals", true);
    expect(mixer.effectiveGain("vocals")).toBe(0.25);
  });

  test("fader input is clamped to 0..1", () => {
    mixer.setFader("vocals", 5);
    expect(mixer.effectiveGain("vocals")).toBe(1);
    mixer.setFader("vocals", -3);
    expect(mixer.effectiveGain("vocals")).toBe(0);
  });
});

describe("gain is ramped, not stepped", () => {
  test("fader moves schedule a ramp so they do not click", () => {
    for (const stem of mixer.stems.values()) stem.gain.gain.calls.length = 0;
    mixer.setFader("vocals", 0.3);

    const moved = mixer.stems.get("vocals").gain.gain.calls;
    expect(moved.length).toBe(1);
    expect(moved[0].type).toBe("setTargetAtTime");
    expect(moved[0].value).toBe(0.3);

    // Every stem is reconciled on each change, because a solo elsewhere can
    // change a stem's effective gain without its own fader moving.
    for (const [name, stem] of mixer.stems) {
      expect(stem.gain.gain.calls.length, `${name} reconciled once`).toBe(1);
    }
  });

  test("initial load sets gain immediately, no ramp from zero", () => {
    const fresh = new StemMixer(new FakeAudioContext(0));
    fresh.load(sixStems(10));
    const calls = fresh.stems.get("vocals").gain.gain.calls;
    expect(calls.at(-1).type).toBe("setValueAtTime");
  });
});

describe("transport state machine", () => {
  test("play is idempotent — no double scheduling", () => {
    mixer.play();
    mixer.play();
    expect(ctx._scheduled.length).toBe(6);
  });

  test("pause on a stopped mixer is a no-op", () => {
    expect(() => mixer.pause()).not.toThrow();
    expect(mixer.playing).toBe(false);
  });

  test("stop rewinds to zero", () => {
    mixer.play();
    ctx.advance(0.06 + 60);
    mixer.stop();
    expect(mixer.playing).toBe(false);
    expect(mixer.position).toBe(0);
  });

  test("playing from the end restarts at zero", () => {
    mixer.seek(210);
    mixer.play();
    expect(ctx._scheduled[0].started.offset).toBe(0);
  });

  test("stopped sources are disconnected", () => {
    mixer.play();
    const sources = [...ctx._scheduled];
    mixer.pause();
    for (const s of sources) {
      expect(s.stopped).not.toBe(null);
      expect(s.connectedTo).toBe(null);
    }
  });
});

describe("natural end", () => {
  test("fires ended once, from the longest stem only", () => {
    let count = 0;
    mixer.on("ended", () => count++);
    mixer.play();
    for (const s of ctx._scheduled) if (s.onended) s.onended();
    expect(count).toBe(1);
    expect(mixer.playing).toBe(false);
    expect(mixer.position).toBe(210);
  });

  test("does not fire when the stop was intentional", () => {
    let fired = false;
    mixer.on("ended", () => (fired = true));
    mixer.play();
    mixer.pause();
    expect(fired).toBe(false);
  });
});

describe("uneven stem lengths", () => {
  test("duration is the longest stem", () => {
    const m = new StemMixer(new FakeAudioContext(0));
    m.load({ vocals: buffer(200), drums: buffer(210.5), bass: buffer(199) });
    expect(m.duration).toBe(210.5);
  });

  test("mismatches are reported so the UI can warn", () => {
    const m = new StemMixer(new FakeAudioContext(0));
    m.load({ vocals: buffer(210), drums: buffer(210), bass: buffer(207) });
    const bad = m.lengthMismatches();
    expect(bad.length).toBe(1);
    expect(bad[0].name).toBe("bass");
    expect(Math.abs(bad[0].delta - 3) < 1e-9).toBeTruthy();
  });

  test("equal-length stems report no mismatch", () => {
    expect(mixer.lengthMismatches()).toEqual([]);
  });
});

describe("errors and edges", () => {
  test("unknown stem names throw rather than silently no-op", () => {
    expect(() => mixer.setFader("theremin", 0.5)).toThrow(/Unknown stem/);
    expect(() => mixer.setMute("theremin", true)).toThrow(/Unknown stem/);
  });

  test("load with no stems throws", () => {
    expect(() => mixer.load({})).toThrow(/at least one stem/);
  });

  test("constructing without a context throws", () => {
    expect(() => new StemMixer(null)).toThrow(/requires an AudioContext/);
  });

  test("a throwing listener does not corrupt transport state", () => {
    mixer.on("play", () => {
      throw new Error("listener blew up");
    });
    mixer.play();
    expect(mixer.playing).toBe(true);
  });

  test("reload replaces the previous set and rewinds", () => {
    mixer.play();
    ctx.advance(0.06 + 30);
    mixer.load({ vocals: buffer(60), drums: buffer(60) });
    expect(mixer.stems.size).toBe(2);
    expect(mixer.duration).toBe(60);
    expect(mixer.position).toBe(0);
    expect(mixer.playing).toBe(false);
  });
});

describe("state snapshot", () => {
  test("reports what a channel strip needs to render", () => {
    mixer.setFader("vocals", 0.4);
    mixer.setSolo("drums", true);
    const s = mixer.state();
    expect(s.anySolo).toBe(true);
    expect(s.stems.vocals.fader).toBe(0.4);
    expect(s.stems.vocals.effective).toBe(0);
    expect(s.stems.drums.effective).toBe(1);
    expect(s.duration).toBe(210);
  });
});
