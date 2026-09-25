import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IDENTITY_TRANSFORM } from "../src/project/types.ts";
import { clampPointToRect, computeTransformedBox, cropAfterEdgeDrag, rotatedPoint, snapRotationDegrees } from "../src/playback/transformGeometry.ts";
import { closeTo } from "./fixture.ts";

describe("computeTransformedBox", () => {
  it("letterboxes a wider-than-tall source into a taller-than-wide frame at identity", () => {
    // 16:9 source into a 9:16 frame — width is the constraint, so the fit scale comes from width.
    const box = computeTransformedBox(1920, 1080, 1080, 1920, IDENTITY_TRANSFORM)!;

    assert.ok(closeTo(box.width, 1080));
    assert.ok(closeTo(box.height, 1080 * (1080 / 1920)));
    assert.ok(closeTo(box.centerX, 540));
    assert.ok(closeTo(box.centerY, 960));
  });

  it("keeps the original fit while cropping instead of zooming the remainder back to fill", () => {
    const transform = { ...IDENTITY_TRANSFORM, crop: { top: 0, bottom: 0, left: 0.28, right: 0.28 } };
    const box = computeTransformedBox(1920, 1080, 1080, 1920, transform)!;
    const croppedWidth = 1920 * (1 - 0.28 - 0.28);
    const expectedFitScale = Math.min(1080 / 1920, 1920 / 1080);

    assert.ok(closeTo(box.cropWidth, croppedWidth));
    assert.ok(closeTo(box.cropHeight, 1080));
    assert.ok(closeTo(box.width, croppedWidth * expectedFitScale));
    assert.ok(closeTo(box.height, 1080 * expectedFitScale));
    const uncropped = computeTransformedBox(1920, 1080, 1080, 1920, IDENTITY_TRANSFORM)!;
    assert.ok(closeTo(box.height, uncropped.height));
    assert.ok(box.width < uncropped.width);
  });

  it("moves only the cropped edge and keeps the opposite edge fixed", () => {
    const uncropped = computeTransformedBox(1920, 1080, 1080, 1920, IDENTITY_TRANSFORM)!;
    const leftCrop = computeTransformedBox(1920, 1080, 1080, 1920, {
      ...IDENTITY_TRANSFORM,
      crop: { top: 0, right: 0, bottom: 0, left: 0.25 },
    })!;

    assert.ok(closeTo(leftCrop.centerX + leftCrop.width / 2, uncropped.centerX + uncropped.width / 2));
    assert.ok(leftCrop.centerX - leftCrop.width / 2 > uncropped.centerX - uncropped.width / 2);
  });

  it("applies the user scale multiplier on top of the fit scale", () => {
    const fit = computeTransformedBox(1920, 1080, 1080, 1920, IDENTITY_TRANSFORM)!;
    const zoomed = computeTransformedBox(1920, 1080, 1080, 1920, { ...IDENTITY_TRANSFORM, scale: 2 })!;

    assert.ok(closeTo(zoomed.width, fit.width * 2));
    assert.ok(closeTo(zoomed.height, fit.height * 2));
  });

  it("offsets the center without affecting size", () => {
    const box = computeTransformedBox(1920, 1080, 1080, 1920, { ...IDENTITY_TRANSFORM, offsetX: 40, offsetY: -25 })!;

    assert.ok(closeTo(box.centerX, 540 + 40));
    assert.ok(closeTo(box.centerY, 960 - 25));
  });

  it("returns null for a crop that would leave nothing visible", () => {
    // setClipTransform always clamps against this in practice, but the geometry function itself
    // shouldn't divide by zero or return a negative-size box if it's ever handed one anyway.
    const box = computeTransformedBox(1920, 1080, 1080, 1920, {
      ...IDENTITY_TRANSFORM,
      crop: { top: 0, bottom: 0, left: 0.6, right: 0.6 },
    });

    assert.equal(box, null);
  });
});

describe("rotatedPoint", () => {
  it("returns the local offset unrotated at 0 degrees", () => {
    const p = rotatedPoint(500, 500, 100, 0, 0);
    assert.ok(closeTo(p.x, 600));
    assert.ok(closeTo(p.y, 500));
  });

  it("rotates a point 90 degrees clockwise around the pivot", () => {
    // A point 100px to the right of the pivot, rotated 90°, ends up 100px BELOW it (screen Y grows
    // downward) — the same direction `TransformHandles`'/`TextTransformHandles`' own rotate handles
    // already visibly sweep in the running app.
    const p = rotatedPoint(500, 500, 100, 0, 90);
    assert.ok(closeTo(p.x, 500));
    assert.ok(closeTo(p.y, 600));
  });

  it("rotates a point 180 degrees to the opposite side of the pivot", () => {
    const p = rotatedPoint(500, 500, 100, 0, 180);
    assert.ok(closeTo(p.x, 400, 1e-6));
    assert.ok(closeTo(p.y, 500, 1e-6));
  });

  it("matches the pre-refactor inline anchor formula TransformHandles used to compute directly", () => {
    // Regression pin: the exact expression `beginDrag`'s scale-anchor computation used before it was
    // extracted into this shared helper (cssCenter + local rotated by theta), for a representative
    // scale/rotation combination.
    const cssCenterX = 320;
    const cssCenterY = 480;
    const localX = -150;
    const localY = 90;
    const rotationDeg = 37;
    const theta = (rotationDeg * Math.PI) / 180;
    const expectedX = cssCenterX + localX * Math.cos(theta) - localY * Math.sin(theta);
    const expectedY = cssCenterY + localX * Math.sin(theta) + localY * Math.cos(theta);

    const p = rotatedPoint(cssCenterX, cssCenterY, localX, localY, rotationDeg);

    assert.ok(closeTo(p.x, expectedX));
    assert.ok(closeTo(p.y, expectedY));
  });
});

describe("clampPointToRect", () => {
  const rect = { left: 0, top: 0, right: 200, bottom: 100 };

  it("leaves an in-bounds point unchanged", () => {
    const p = clampPointToRect({ x: 50, y: 50 }, rect, 10);
    assert.deepEqual(p, { x: 50, y: 50 });
  });

  it("clamps a point past the right edge on the X axis only", () => {
    const p = clampPointToRect({ x: 500, y: 50 }, rect, 10);
    assert.ok(closeTo(p.x, 190));
    assert.ok(closeTo(p.y, 50));
  });

  it("clamps a point past the left edge on the X axis only", () => {
    const p = clampPointToRect({ x: -500, y: 50 }, rect, 10);
    assert.ok(closeTo(p.x, 10));
    assert.ok(closeTo(p.y, 50));
  });

  it("clamps a point past the top/bottom edges on the Y axis only", () => {
    const below = clampPointToRect({ x: 50, y: 500 }, rect, 10);
    assert.ok(closeTo(below.y, 90));
    const above = clampPointToRect({ x: 50, y: -500 }, rect, 10);
    assert.ok(closeTo(above.y, 10));
  });

  it("clamps a point past a corner on both axes at once", () => {
    const p = clampPointToRect({ x: 9999, y: -9999 }, rect, 10);
    assert.ok(closeTo(p.x, 190));
    assert.ok(closeTo(p.y, 10));
  });

  it("never inverts min/max for a rect narrower/shorter than 2×margin", () => {
    const tinyRect = { left: 0, top: 0, right: 10, bottom: 4 };
    const p = clampPointToRect({ x: 9999, y: 9999 }, tinyRect, 50);
    // Margin caps to half the axis extent, so the clamped bounds collapse to the rect's own midline
    // rather than crossing over each other.
    assert.ok(closeTo(p.x, 5));
    assert.ok(closeTo(p.y, 2));
  });
});

describe("cropAfterEdgeDrag", () => {
  const base = { ...IDENTITY_TRANSFORM, crop: { top: 0.1, right: 0.1, bottom: 0.1, left: 0.1 } };

  it("moves each edge in the expected local direction", () => {
    assert.ok(closeTo(cropAfterEdgeDrag(base, "left", 20, 0, 200, 100).left, 0.2));
    assert.ok(closeTo(cropAfterEdgeDrag(base, "right", -20, 0, 200, 100).right, 0.2));
    assert.ok(closeTo(cropAfterEdgeDrag(base, "top", 0, 10, 200, 100).top, 0.2));
    assert.ok(closeTo(cropAfterEdgeDrag(base, "bottom", 0, -10, 200, 100).bottom, 0.2));
  });

  it("unrotates the pointer delta into clip-local axes", () => {
    const rotated = { ...base, rotationDeg: 90 };
    assert.ok(closeTo(cropAfterEdgeDrag(rotated, "left", 0, 20, 200, 100).left, 0.2));
    assert.ok(closeTo(cropAfterEdgeDrag(rotated, "top", -10, 0, 200, 100).top, 0.2));
  });

  it("never crosses the opposing edge or produces a negative crop", () => {
    assert.equal(cropAfterEdgeDrag(base, "left", -1000, 0, 200, 100).left, 0);
    assert.ok(closeTo(cropAfterEdgeDrag(base, "left", 1000, 0, 200, 100).left, 0.88));
  });
});

describe("snapRotationDegrees", () => {
  it("snaps to a cardinal angle within tolerance", () => {
    assert.equal(snapRotationDegrees(2, 4), 0);
    assert.equal(snapRotationDegrees(-2, 4), 0);
    assert.equal(snapRotationDegrees(88, 4), 90);
    assert.equal(snapRotationDegrees(92, 4), 90);
    assert.equal(snapRotationDegrees(178, 4), 180);
    assert.equal(snapRotationDegrees(272, 4), 270);
    assert.equal(snapRotationDegrees(357, 4), 360);
  });

  it("leaves a deliberate off-angle rotation untouched, just outside tolerance", () => {
    assert.equal(snapRotationDegrees(85, 4), 85);
    assert.equal(snapRotationDegrees(45, 4), 45);
  });

  it("snaps every quarter turn of a multi-turn (unwrapped) spin, not just the first", () => {
    assert.equal(snapRotationDegrees(451, 4), 450);
    assert.equal(snapRotationDegrees(-451, 4), -450);
  });

  it("is exact at zero tolerance — only a perfect cardinal angle snaps", () => {
    assert.equal(snapRotationDegrees(90, 0), 90);
    assert.equal(snapRotationDegrees(90.5, 0), 90.5);
  });
});
