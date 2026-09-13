import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyManualEffects } from "../src/playback/PlaybackEngine.ts";
import { IDENTITY_EFFECTS, type ClipEffects } from "../src/project/types.ts";

/** Node has no native `ImageData` — same stub `tests/pixelEffects.test.ts` already uses, matching just
 *  the shape (`width`/`height`/`data`) the function under test actually reads. */
function makeImageData(width: number, height: number): ImageData {
  return { width, height, data: new Uint8ClampedArray(width * height * 4), colorSpace: "srgb" } as ImageData;
}

function setPixel(imageData: ImageData, x: number, y: number, r: number, g: number, b: number, a = 255): void {
  const i = (y * imageData.width + x) * 4;
  imageData.data[i] = r;
  imageData.data[i + 1] = g;
  imageData.data[i + 2] = b;
  imageData.data[i + 3] = a;
}

function getPixel(imageData: ImageData, x: number, y: number): [number, number, number, number] {
  const i = (y * imageData.width + x) * 4;
  return [imageData.data[i], imageData.data[i + 1], imageData.data[i + 2], imageData.data[i + 3]];
}

describe("applyManualEffects", () => {
  it("identity effects leave every pixel exactly as it was", () => {
    const image = makeImageData(20, 10);
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 20; x++) setPixel(image, x, y, (x * 7) % 255, (y * 13) % 255, (x + y) % 255);
    }
    const before = image.data.slice();
    applyManualEffects(image, IDENTITY_EFFECTS);
    assert.deepEqual(Array.from(image.data), Array.from(before), "identity effects must be a no-op");
  });

  it("brightness is additive in normalized [0,1] space, matching FFmpeg's eq convention", () => {
    const image = makeImageData(1, 1);
    setPixel(image, 0, 0, 100, 100, 100);
    const effects: ClipEffects = { ...IDENTITY_EFFECTS, brightness: 0.2 };
    applyManualEffects(image, effects);
    // (100/255) + 0.2, back to a byte.
    const expected = Math.round(((100 / 255 - 0.5) * 1 + 0.5 + 0.2) * 255);
    assert.deepEqual(getPixel(image, 0, 0).slice(0, 3), [expected, expected, expected]);
  });

  it("contrast pivots around the normalized midpoint (0.5), not around zero", () => {
    const image = makeImageData(1, 1);
    setPixel(image, 0, 0, 255, 255, 255);
    const effects: ClipEffects = { ...IDENTITY_EFFECTS, contrast: 2 };
    applyManualEffects(image, effects);
    // (1 - 0.5) * 2 + 0.5 = 1.0 -> white stays white at the top of the range.
    assert.deepEqual(getPixel(image, 0, 0).slice(0, 3), [255, 255, 255]);

    const mid = makeImageData(1, 1);
    setPixel(mid, 0, 0, 128, 128, 128);
    applyManualEffects(mid, effects);
    // Midpoint is a fixed point of any pure contrast scale.
    const [r] = getPixel(mid, 0, 0);
    assert.ok(Math.abs(r - 128) <= 1, `midpoint gray should stay near 128, got ${r}`);
  });

  it("saturation=0 collapses to the BT.601 luma value FFmpeg's eq filter uses", () => {
    const image = makeImageData(1, 1);
    setPixel(image, 0, 0, 200, 50, 10);
    const effects: ClipEffects = { ...IDENTITY_EFFECTS, saturation: 0 };
    applyManualEffects(image, effects);
    const rNorm = 200 / 255;
    const gNorm = 50 / 255;
    const bNorm = 10 / 255;
    const gray = Math.round((0.299 * rNorm + 0.587 * gNorm + 0.114 * bNorm) * 255);
    const [r, g, b] = getPixel(image, 0, 0).slice(0, 3);
    assert.ok(Math.abs(r - gray) <= 1 && Math.abs(g - gray) <= 1 && Math.abs(b - gray) <= 1, `expected all channels near gray=${gray}, got [${r},${g},${b}]`);
    assert.equal(r, g, "fully desaturated pixel must have equal channels");
    assert.equal(g, b, "fully desaturated pixel must have equal channels");
  });

  it("blur smooths a hard edge instead of leaving it untouched", () => {
    const width = 20;
    const height = 1;
    const image = makeImageData(width, height);
    for (let x = 0; x < width; x++) setPixel(image, x, 0, x < width / 2 ? 0 : 255, x < width / 2 ? 0 : 255, x < width / 2 ? 0 : 255);
    const effects: ClipEffects = { ...IDENTITY_EFFECTS, blur: 3 };
    applyManualEffects(image, effects);
    // Right at the old edge, a blurred pixel should land strictly between the two original extremes.
    const [r] = getPixel(image, Math.floor(width / 2), 0);
    assert.ok(r > 0 && r < 255, `expected a smoothed intermediate value at the edge, got ${r}`);
  });

  it("blur=0 leaves the image untouched by the blur step (only brightness/contrast/saturation apply)", () => {
    const image = makeImageData(10, 1);
    for (let x = 0; x < 10; x++) setPixel(image, x, 0, x < 5 ? 0 : 255, x < 5 ? 0 : 255, x < 5 ? 0 : 255);
    const before = image.data.slice();
    applyManualEffects(image, IDENTITY_EFFECTS);
    assert.deepEqual(Array.from(image.data), Array.from(before), "identity effects (blur=0 included) must be a no-op");
  });

  it("leaves alpha untouched", () => {
    const image = makeImageData(1, 1);
    setPixel(image, 0, 0, 100, 100, 100, 77);
    applyManualEffects(image, { ...IDENTITY_EFFECTS, brightness: 0.3, contrast: 1.5, saturation: 0.2 });
    assert.equal(getPixel(image, 0, 0)[3], 77, "alpha channel must not be modified");
  });
});
