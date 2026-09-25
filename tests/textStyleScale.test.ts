import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scaleTextStyle } from "../src/project/textStyleScale.ts";
import { DEFAULT_TEXT_STYLE } from "../src/project/types.ts";

describe("scaleTextStyle", () => {
  const base = {
    ...DEFAULT_TEXT_STYLE,
    fontSize: 100,
    strokeColor: "#000",
    strokeWidth: 4,
    strokeWidth2: 2,
    shadowColor: "#000",
    shadowOffsetX: 6,
    shadowOffsetY: 8,
    shadowBlur: 10,
    shadows: [{ color: "#f00", offsetX: 2, offsetY: 4, blur: 6 }],
    glowBlur: 20,
    letterSpacing: 3,
    wordBounce: 5,
  };

  it("scales outline, shadow, glow, spacing and bounce with the font size", () => {
    const s = scaleTextStyle(base, 200);
    assert.equal(s.fontSize, 200);
    assert.equal(s.strokeWidth, 8);
    assert.equal(s.strokeWidth2, 4);
    assert.deepEqual([s.shadowOffsetX, s.shadowOffsetY, s.shadowBlur], [12, 16, 20]);
    assert.deepEqual(s.shadows, [{ color: "#f00", offsetX: 4, offsetY: 8, blur: 12 }]);
    assert.equal(s.glowBlur, 40);
    assert.equal(s.letterSpacing, 6);
    assert.equal(s.wordBounce, 10);
  });

  it("leaves absent optional fields absent and does not mutate the input", () => {
    const plain = { ...DEFAULT_TEXT_STYLE, fontSize: 50 };
    const s = scaleTextStyle(plain, 100);
    assert.equal(s.shadows, undefined);
    assert.equal(s.glowBlur, undefined);
    assert.equal(base.strokeWidth, 4);
  });
});
