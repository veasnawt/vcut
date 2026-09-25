import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyLut3D, blendLut3D, LutParseError, normalizeLutIntensity, parseCubeLut, serializeCubeLut } from "../src/timeline/lut.ts";

// A minimal, valid 2x2x2 identity LUT — rows in the .cube spec's own "red fastest" order.
const IDENTITY_2_CUBE = `TITLE "Identity"
LUT_3D_SIZE 2

0.0 0.0 0.0
1.0 0.0 0.0
0.0 1.0 0.0
1.0 1.0 0.0
0.0 0.0 1.0
1.0 0.0 1.0
0.0 1.0 1.0
1.0 1.0 1.0
`;

describe("parseCubeLut", () => {
  it("parses a valid 2x2x2 LUT: size, default domain, and data in file order", () => {
    const lut = parseCubeLut(IDENTITY_2_CUBE);
    assert.equal(lut.size, 2);
    assert.deepEqual(lut.domainMin, [0, 0, 0]);
    assert.deepEqual(lut.domainMax, [1, 1, 1]);
    assert.equal(lut.data.length, 2 * 2 * 2 * 3);
    // First row (0,0,0) -> black.
    assert.deepEqual(Array.from(lut.data.slice(0, 3)), [0, 0, 0]);
    // Second row, lattice coord (1,0,0) -> red-fastest means this is index 1 -> pure red.
    assert.deepEqual(Array.from(lut.data.slice(3, 6)), [1, 0, 0]);
    // Last row (1,1,1) -> white.
    assert.deepEqual(Array.from(lut.data.slice(21, 24)), [1, 1, 1]);
  });

  it("parses explicit DOMAIN_MIN/DOMAIN_MAX lines", () => {
    const text = `LUT_3D_SIZE 2
DOMAIN_MIN 0.1 0.1 0.1
DOMAIN_MAX 0.9 0.9 0.9
0 0 0
1 0 0
0 1 0
1 1 0
0 0 1
1 0 1
0 1 1
1 1 1
`;
    const lut = parseCubeLut(text);
    assert.deepEqual(lut.domainMin, [0.1, 0.1, 0.1]);
    assert.deepEqual(lut.domainMax, [0.9, 0.9, 0.9]);
  });

  it("skips blank lines and # comments", () => {
    const text = `# a comment

LUT_3D_SIZE 2
# another comment
0 0 0
1 0 0
0 1 0
1 1 0

0 0 1
1 0 1
0 1 1
1 1 1
`;
    assert.doesNotThrow(() => parseCubeLut(text));
  });

  it("throws LutParseError when LUT_3D_SIZE is missing entirely", () => {
    assert.throws(() => parseCubeLut("0 0 0\n1 1 1\n"), LutParseError);
  });

  it("throws LutParseError for a LUT_1D_SIZE-only file, with a message naming the 1D scope cut", () => {
    const text = `LUT_1D_SIZE 2
0 0 0
1 1 1
`;
    assert.throws(() => parseCubeLut(text), (err: unknown) => {
      assert.ok(err instanceof LutParseError);
      assert.match(err.message, /1D/);
      return true;
    });
  });

  it("throws LutParseError when the data row count doesn't match size^3 exactly", () => {
    const text = `LUT_3D_SIZE 2
0 0 0
1 0 0
0 1 0
`;
    assert.throws(() => parseCubeLut(text), LutParseError);
  });
});

describe("applyLut3D", () => {
  it("is a passthrough (within interpolation rounding) for an identity LUT", () => {
    const lut = parseCubeLut(IDENTITY_2_CUBE);
    const imageData = { data: new Uint8ClampedArray([10, 128, 250, 200, 0, 64, 255, 77]) };
    const before = Array.from(imageData.data);
    applyLut3D(imageData, lut);
    for (let i = 0; i < before.length; i += 4) {
      assert.ok(Math.abs(imageData.data[i] - before[i]) <= 1, `R mismatch at pixel ${i / 4}`);
      assert.ok(Math.abs(imageData.data[i + 1] - before[i + 1]) <= 1, `G mismatch at pixel ${i / 4}`);
      assert.ok(Math.abs(imageData.data[i + 2] - before[i + 2]) <= 1, `B mismatch at pixel ${i / 4}`);
    }
  });

  it("never touches alpha", () => {
    const lut = parseCubeLut(IDENTITY_2_CUBE);
    const imageData = { data: new Uint8ClampedArray([10, 20, 30, 42]) };
    applyLut3D(imageData, lut);
    assert.equal(imageData.data[3], 42);
  });

  it("applies a non-identity LUT (channel swap) correctly", () => {
    // A LUT that swaps R and B — index order still red-fastest, but each row's OUTPUT has r/b swapped
    // versus the identity cube above.
    const text = `LUT_3D_SIZE 2
0 0 0
0 0 1
0 1 0
0 1 1
1 0 0
1 0 1
1 1 0
1 1 1
`;
    const lut = parseCubeLut(text);
    const imageData = { data: new Uint8ClampedArray([255, 0, 0, 255]) }; // pure red in
    applyLut3D(imageData, lut);
    // Pure red (1,0,0) should map to pure blue (0,0,1) under an R/B swap LUT.
    assert.ok(imageData.data[0] < 5, `expected R~0, got ${imageData.data[0]}`);
    assert.ok(imageData.data[2] > 250, `expected B~255, got ${imageData.data[2]}`);
  });
});

// A 2x2x2 LUT that fully inverts every channel — the user-visible "invert-test.cube" case: at strength 1
// white becomes black, at 0 the image is untouched, at 0.5 everything collapses to mid-grey.
const INVERT_2_CUBE = `LUT_3D_SIZE 2
1.0 1.0 1.0
0.0 1.0 1.0
1.0 0.0 1.0
0.0 0.0 1.0
1.0 1.0 0.0
0.0 1.0 0.0
1.0 0.0 0.0
0.0 0.0 0.0
`;

function applyTo(lut: ReturnType<typeof parseCubeLut>, rgb: [number, number, number]): number[] {
  const image = { data: new Uint8ClampedArray([rgb[0], rgb[1], rgb[2], 255]) };
  applyLut3D(image, lut);
  return [image.data[0], image.data[1], image.data[2]];
}

describe("blendLut3D (LUT intensity)", () => {
  const invert = parseCubeLut(INVERT_2_CUBE);

  it("returns the same LUT at full strength", () => {
    assert.equal(blendLut3D(invert, 1), invert);
  });

  it("at 0 is an identity — pixels come out untouched", () => {
    const zero = blendLut3D(invert, 0);
    assert.deepEqual(applyTo(zero, [200, 40, 90]), [200, 40, 90]);
  });

  it("at 0.5 lands exactly halfway between the source and the inverted pixel", () => {
    const half = blendLut3D(invert, 0.5);
    // invert(200)=55, midpoint of 200 and 55 = 127.5; invert(40)=215 -> 127.5; 90 -> 165 -> 127.5
    for (const channel of applyTo(half, [200, 40, 90])) assert.ok(Math.abs(channel - 127.5) <= 1, `got ${channel}`);
  });

  it("is monotonic: more intensity moves a pixel further toward the LUT's result", () => {
    const at = (k: number) => applyTo(blendLut3D(invert, k), [255, 255, 255])[0];
    assert.ok(at(0) > at(0.25) && at(0.25) > at(0.5) && at(0.5) > at(0.75) && at(0.75) > at(1));
  });

  it("honors a non-default input domain when computing the identity it blends toward", () => {
    const rows = "0 0 0\n".repeat(8);
    const wide = parseCubeLut(`LUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 2 2 2\n${rows}`);
    const zero = blendLut3D(wide, 0);
    // identity at lattice index 1 on a 0..2 domain is 2, not 1
    assert.equal(zero.data[(1 + 0 * 2 + 0 * 4) * 3], 2);
  });
});

describe("serializeCubeLut", () => {
  it("round-trips through parseCubeLut", () => {
    const original = parseCubeLut(INVERT_2_CUBE);
    const again = parseCubeLut(serializeCubeLut(original));
    assert.equal(again.size, original.size);
    assert.deepEqual([...again.data], [...original.data]);
    assert.deepEqual(again.domainMax, original.domainMax);
  });

  it("writes a blended LUT FFmpeg can read back to the same values", () => {
    const blended = blendLut3D(parseCubeLut(INVERT_2_CUBE), 0.25);
    const again = parseCubeLut(serializeCubeLut(blended));
    for (let i = 0; i < blended.data.length; i++) assert.ok(Math.abs(again.data[i] - blended.data[i]) < 1e-5);
  });
});

describe("normalizeLutIntensity", () => {
  it("treats absent / non-finite as full strength and clamps to 0..1", () => {
    assert.equal(normalizeLutIntensity(undefined), 1);
    assert.equal(normalizeLutIntensity(Number.NaN), 1);
    assert.equal(normalizeLutIntensity(-3), 0);
    assert.equal(normalizeLutIntensity(7), 1);
    assert.equal(normalizeLutIntensity(0.456), 0.46);
  });
});
