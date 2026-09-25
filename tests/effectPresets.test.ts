import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EFFECT_PRESETS, presetLook, presetMatches } from "../src/project/effectPresets.ts";
import { IDENTITY_EFFECTS } from "../src/project/types.ts";

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

const byId = (id: string) => EFFECT_PRESETS.find((p) => p.id === id)!.values;

// Reported: select a blur filter, then a filter WITHOUT blur -- the clip stayed blurred. Presets list only
// the fields they set, and the edit path merges onto the clip's current effects, so anything the previous
// preset set and the next doesn't mention leaked through. A preset must write its WHOLE look.
describe("presetLook", () => {
  it("resets every field a preset doesn't mention to identity", () => {
    assert.deepEqual(presetLook(byId("vivid")), { brightness: 0.03, contrast: 1.15, saturation: 1.4, blur: 0 });
    assert.equal(presetLook(byId("vivid")).blur, IDENTITY_EFFECTS.blur);
  });

  it("switching from a blurred preset to an unblurred one leaves no blur (the merge the edit path does)", () => {
    const afterSoftFocus = { ...IDENTITY_EFFECTS, ...presetLook(byId("soft-focus")) };
    assert.ok(afterSoftFocus.blur > 0);
    const afterVivid = { ...afterSoftFocus, ...presetLook(byId("vivid")) };
    assert.equal(afterVivid.blur, 0);
  });

  it("clears leftover brightness/contrast/saturation too, not just blur", () => {
    const afterDreamy = { ...IDENTITY_EFFECTS, ...presetLook(byId("dreamy")) };
    const afterNoir = { ...afterDreamy, ...presetLook(byId("noir")) };
    assert.equal(afterNoir.brightness, 0, "Dreamy's brightness must not survive picking Noir");
    assert.equal(afterNoir.blur, 0);
  });

  it("never touches opacity", () => {
    for (const preset of EFFECT_PRESETS) assert.ok(!("opacity" in presetLook(preset.values)), `${preset.id} must not write opacity`);
    const faded = { ...IDENTITY_EFFECTS, opacity: 0.4 };
    assert.equal({ ...faded, ...presetLook(byId("vivid")) }.opacity, 0.4);
  });
});

describe("presetMatches", () => {
  it("matches exactly the preset just applied, and only that one", () => {
    const applied = { ...IDENTITY_EFFECTS, ...presetLook(byId("soft-focus")) };
    assert.equal(presetMatches(applied, byId("soft-focus")), true);
    assert.equal(presetMatches(applied, byId("dreamy")), false);
  });

  it("ignores opacity -- a clip faded to 50% still shows its preset as active", () => {
    const applied = { ...IDENTITY_EFFECTS, ...presetLook(byId("vivid")), opacity: 0.5 };
    assert.equal(presetMatches(applied, byId("vivid")), true);
  });

  it("stops matching once an unrelated field is hand-tweaked", () => {
    const tweaked = { ...IDENTITY_EFFECTS, ...presetLook(byId("vivid")), blur: 4 };
    assert.equal(presetMatches(tweaked, byId("vivid")), false);
  });
});
