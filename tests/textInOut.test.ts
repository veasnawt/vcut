import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildTextInOutExpressions,
  computeClipTextInOut,
  computeTextAnimationTransform,
  computeTextInOutTransform,
  TEXT_INOUT_DEFAULT_DURATION,
  TEXT_INOUT_TYPE_OPTIONS,
  textInOutDuration,
} from "../src/timeline/textAnimation.ts";
import { deserializeProject, serializeProject } from "../src/project/serialize.ts";
import { addClip } from "../src/timeline/operations.ts";
import { emptyProject, videoTrackId } from "./fixture.ts";

/** Evaluates one of `buildTextInOutExpressions`' FFmpeg expression strings in JS — the functions it uses
 *  (`pow`, `min`, `max`) all have direct `Math` equivalents, so a tiny shim is enough to check the export
 *  formula against the JS one the preview draws from. */
function evalExpression(expression: string): number {
  return new Function("pow", "min", "max", `return (${expression});`)(Math.pow, Math.min, Math.max) as number;
}

describe("computeTextInOutTransform", () => {
  it("is fully settled (neutral) at progress 1 for every type", () => {
    for (const type of TEXT_INOUT_TYPE_OPTIONS) {
      const t = computeTextInOutTransform(type, 1, 96);
      assert.ok(Math.abs(t.dx) < 1e-9 && Math.abs(t.dy) < 1e-9, `${type} offsets settle`);
      assert.ok(Math.abs(t.scale - 1) < 1e-9, `${type} scale settles`);
      assert.ok(Math.abs(t.alpha - 1) < 1e-9, `${type} alpha settles`);
    }
  });

  it("starts hidden or displaced at progress 0 for every type", () => {
    for (const type of TEXT_INOUT_TYPE_OPTIONS) {
      const t = computeTextInOutTransform(type, 0, 96);
      const changed = t.alpha < 1 || t.scale !== 1 || t.dx !== 0 || t.dy !== 0;
      assert.ok(changed, `${type} must visibly differ from rest at the start`);
    }
  });

  it("slides come from the direction their name says", () => {
    assert.ok(computeTextInOutTransform("slideUp", 0, 100).dy > 0, "slide up starts below");
    assert.ok(computeTextInOutTransform("slideDown", 0, 100).dy < 0, "slide down starts above");
    assert.ok(computeTextInOutTransform("slideLeft", 0, 100).dx > 0, "slide left starts to the right");
    assert.ok(computeTextInOutTransform("slideRight", 0, 100).dx < 0, "slide right starts to the left");
  });

  it("pop overshoots past full size before settling, and never reaches a zero font size", () => {
    const peak = Math.max(...Array.from({ length: 100 }, (_, i) => computeTextInOutTransform("pop", i / 99, 96).scale));
    assert.ok(peak > 1.05, `expected an overshoot, got ${peak}`);
    assert.ok(computeTextInOutTransform("pop", 0, 96).scale > 0);
  });

  it("clamps progress outside 0..1", () => {
    assert.deepEqual(computeTextInOutTransform("fade", -5, 96), computeTextInOutTransform("fade", 0, 96));
    assert.deepEqual(computeTextInOutTransform("fade", 9, 96), computeTextInOutTransform("fade", 1, 96));
  });
});

describe("buildTextInOutExpressions matches the JS math (preview/export parity)", () => {
  for (const type of TEXT_INOUT_TYPE_OPTIONS) {
    it(`${type}`, () => {
      for (let i = 0; i <= 20; i++) {
        const p = i / 20;
        const js = computeTextInOutTransform(type, p, 96);
        const ex = buildTextInOutExpressions(type, String(p), 96);
        assert.ok(Math.abs(evalExpression(ex.dx) - js.dx) < 1e-6, `${type} dx @${p}`);
        assert.ok(Math.abs(evalExpression(ex.dy) - js.dy) < 1e-6, `${type} dy @${p}`);
        assert.ok(Math.abs(evalExpression(ex.scale) - js.scale) < 1e-6, `${type} scale @${p}`);
        assert.ok(Math.abs(evalExpression(ex.alpha) - js.alpha) < 1e-6, `${type} alpha @${p}`);
      }
    });
  }
});

describe("textInOutDuration", () => {
  it("defaults, clamps to half the clip, and is 0 when absent", () => {
    assert.equal(textInOutDuration(undefined, 5), 0);
    assert.equal(textInOutDuration({ type: "fade" }, 5), TEXT_INOUT_DEFAULT_DURATION);
    assert.equal(textInOutDuration({ type: "fade", duration: 4 }, 2), 1, "never more than half the clip");
    assert.equal(textInOutDuration({ type: "fade", duration: 0.01 }, 5), 0.1, "never below the minimum");
  });
});

describe("computeClipTextInOut", () => {
  it("is neutral in the middle of a clip and non-neutral at both ends", () => {
    const inn = { type: "slideUp" as const };
    const out = { type: "fade" as const };
    const mid = computeClipTextInOut(inn, out, 2.5, 5, 96);
    assert.deepEqual(mid, { dx: 0, dy: 0, scale: 1, alpha: 1 });
    assert.ok(computeClipTextInOut(inn, out, 0, 5, 96).alpha < 1);
    assert.ok(computeClipTextInOut(inn, out, 5, 5, 96).alpha < 1, "the exit is fully faded on the last frame");
  });

  it("an exit mirrors its entrance", () => {
    const inn = computeClipTextInOut({ type: "slideUp" }, undefined, 0.2, 5, 96);
    const out = computeClipTextInOut(undefined, { type: "slideUp" }, 5 - 0.2, 5, 96);
    for (const key of ["dx", "dy", "scale", "alpha"] as const) assert.ok(Math.abs(inn[key] - out[key]) < 1e-9, key);
  });

  it("no animations means no change", () => {
    assert.deepEqual(computeClipTextInOut(undefined, undefined, 1, 5, 96), { dx: 0, dy: 0, scale: 1, alpha: 1 });
  });
});

describe("new loop animations", () => {
  it("float sways both above and below rest, shake moves sideways only, heartbeat only ever grows", () => {
    const samples = Array.from({ length: 200 }, (_, i) => i * 0.02);
    const floatDy = samples.map((t) => computeTextAnimationTransform("float", t).dy);
    assert.ok(Math.min(...floatDy) < -5 && Math.max(...floatDy) > 5);
    const shake = samples.map((t) => computeTextAnimationTransform("shake", t));
    assert.ok(shake.every((s) => s.dy === 0) && Math.max(...shake.map((s) => Math.abs(s.dx))) > 2);
    const beat = samples.map((t) => computeTextAnimationTransform("heartbeat", t).scale);
    assert.ok(Math.min(...beat) >= 1 - 1e-9 && Math.max(...beat) > 1.05);
  });
});

describe("serialization", () => {
  it("round-trips a clip's In/Out and drops unknown types / absurd durations", () => {
    const base = emptyProject();
    const withClip = addClip(base, videoTrackId(base), "asset1", 0);
    const json = JSON.parse(serializeProject(withClip));
    const clipJson = json.sequence.tracks.find((t: { clips: unknown[] }) => t.clips.length > 0).clips[0];
    clipJson.textAnimationIn = { type: "pop", duration: 0.4 };
    clipJson.textAnimationOut = { type: "warp", duration: 9 };
    const clip = deserializeProject(JSON.stringify(json)).sequence.tracks.flatMap((t) => t.clips)[0];
    assert.deepEqual(clip.textAnimationIn, { type: "pop", duration: 0.4 });
    assert.equal(clip.textAnimationOut, undefined);
  });
});
