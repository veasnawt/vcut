import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { closestResolutionPreset } from "../src/project/types.ts";

describe("closestResolutionPreset", () => {
  it("maps common media shapes to the three presets", () => {
    const label = (w: number, h: number) => closestResolutionPreset(w, h).label.split(" ")[0];
    assert.equal(label(1080, 1920), "Vertical");
    assert.equal(label(720, 1280), "Vertical");
    assert.equal(label(1080, 1350), "Vertical"); // 4:5
    assert.equal(label(1920, 1080), "Landscape");
    assert.equal(label(1440, 1080), "Landscape"); // 4:3
    assert.equal(label(1000, 1000), "Square");
    assert.equal(label(1080, 1080), "Square");
  });
  it("falls back to Vertical for unusable sizes", () => {
    assert.equal(closestResolutionPreset(0, 0).label.split(" ")[0], "Vertical");
    assert.equal(closestResolutionPreset(NaN, 5).label.split(" ")[0], "Vertical");
  });
});
