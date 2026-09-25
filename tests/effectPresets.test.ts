import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EFFECT_PRESETS } from "../src/project/effectPresets.ts";

// A preset that blurs must blur enough to SEE. The two blurring presets shipped at 3 and 2 sequence
// pixels, which measured as imperceptible in the live preview (avg 0.2-0.6 of 255 on a detailed frame)
// once the preview stopped exaggerating blur -- reported as "the blur doesn't work".
describe("EFFECT_PRESETS blur strength", () => {
  const MIN_VISIBLE_BLUR = 5;
  for (const preset of EFFECT_PRESETS) {
    if (preset.values.blur === undefined) continue;
    it(`${preset.label} blurs enough to be visible`, () => {
      assert.ok(preset.values.blur! >= MIN_VISIBLE_BLUR, `${preset.id} blur ${preset.values.blur} is below ${MIN_VISIBLE_BLUR}`);
    });
  }

  it("still has both blurring presets (so the guard above isn't vacuous)", () => {
    assert.deepEqual(EFFECT_PRESETS.filter((p) => p.values.blur !== undefined).map((p) => p.id).sort(), ["dreamy", "soft-focus"]);
  });
});
