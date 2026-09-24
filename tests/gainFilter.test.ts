import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildGainVolumeExpr } from "../src/export/gainFilter.ts";

function n(value: number): string {
  return value.toFixed(6);
}

/** Evaluates the tiny subset of FFmpeg's expression language `buildGainVolumeExpr` actually emits
 *  (`if`, `lte`, `+`, `-`, `*`, `/`, parens, and the one free variable `t`) — enough to check the
 *  generated expression against `resolveClipGain`'s own JS math without needing a real FFmpeg binary.
 *  Implements `if`/`lte` as real JS functions and evaluates the expression text as-is against them
 *  (renaming `if(` to the free identifier `if_(` first, since `if` itself isn't a valid JS
 *  expression-position identifier) rather than attempting a text-level rewrite to JS ternaries, which
 *  can't correctly re-balance parens across nested `if(...)` calls. */
function evalExpr(expr: string, t: number): number {
  // eslint-disable-next-line no-new-func
  const fn = new Function("t", "lte", "if_", `return (${expr.replace(/\bif\(/g, "if_(")});`);
  return fn(t, (a: number, b: number) => (a <= b ? 1 : 0), (cond: number, then: number, otherwise: number) => (cond ? then : otherwise));
}

describe("buildGainVolumeExpr", () => {
  it("is a constant when only one keyframe exists", () => {
    const expr = buildGainVolumeExpr([{ time: 0, value: 0.5 }], 0, n);
    assert.equal(expr, "0.500000");
  });

  it("holds the first value before the first keyframe", () => {
    const expr = buildGainVolumeExpr(
      [
        { time: 1, value: 0.2 },
        { time: 2, value: 1 },
      ],
      0,
      n
    );
    assert.ok(Math.abs(evalExpr(expr, 0) - 0.2) < 1e-6);
  });

  it("holds the last value after the last keyframe", () => {
    const expr = buildGainVolumeExpr(
      [
        { time: 0, value: 0.2 },
        { time: 1, value: 1 },
      ],
      0,
      n
    );
    assert.ok(Math.abs(evalExpr(expr, 5) - 1) < 1e-6);
  });

  it("linearly interpolates between two keyframes", () => {
    const expr = buildGainVolumeExpr(
      [
        { time: 0, value: 0 },
        { time: 2, value: 4 },
      ],
      0,
      n
    );
    assert.ok(Math.abs(evalExpr(expr, 1) - 2) < 1e-6);
    assert.ok(Math.abs(evalExpr(expr, 0.5) - 1) < 1e-6);
  });

  it("selects the correct segment across three keyframes", () => {
    const expr = buildGainVolumeExpr(
      [
        { time: 0, value: 0 },
        { time: 1, value: 1 },
        { time: 2, value: 0 },
      ],
      0,
      n
    );
    assert.ok(Math.abs(evalExpr(expr, 0.5) - 0.5) < 1e-6);
    assert.ok(Math.abs(evalExpr(expr, 1) - 1) < 1e-6);
    assert.ok(Math.abs(evalExpr(expr, 1.5) - 0.5) < 1e-6);
  });

  it("shifts by offsetSeconds — a mid-clip segment sees the same clip-elapsed curve", () => {
    const keyframes = [
      { time: 0, value: 0 },
      { time: 2, value: 4 },
    ];
    // Without an offset, local t=1 would read the midpoint (2). With offsetSeconds=1 (this segment
    // starts 1 clip-second in), local t=0 must ALREADY read the midpoint instead.
    const withOffset = buildGainVolumeExpr(keyframes, 1, n);
    assert.ok(Math.abs(evalExpr(withOffset, 0) - 2) < 1e-6);
  });

  it("steps immediately at a zero-width span instead of dividing by zero", () => {
    const expr = buildGainVolumeExpr(
      [
        { time: 1, value: 0 },
        { time: 1, value: 1 },
      ],
      0,
      n
    );
    const value = evalExpr(expr, 1);
    assert.ok(Number.isFinite(value));
  });
});
