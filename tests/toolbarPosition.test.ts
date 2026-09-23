import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { effectiveToolbarPosition, readToolbarPosition, TOOLBAR_POSITION_STORAGE_KEY } from "../src/ui/toolbarPosition.ts";

describe("toolbar position preference", () => {
  it("defaults to left and accepts only the two supported values", () => {
    assert.equal(readToolbarPosition({ getItem: () => null }), "left");
    assert.equal(readToolbarPosition({ getItem: () => "left" }), "left");
    assert.equal(readToolbarPosition({ getItem: (key) => key === TOOLBAR_POSITION_STORAGE_KEY ? "bottom" : null }), "bottom");
    assert.equal(readToolbarPosition({ getItem: () => "other" }), "left");
  });

  it("keeps the mobile toolbar at the bottom regardless of desktop preference", () => {
    assert.equal(effectiveToolbarPosition("left", false), "bottom");
    assert.equal(effectiveToolbarPosition("bottom", false), "bottom");
    assert.equal(effectiveToolbarPosition("left", true), "left");
    assert.equal(effectiveToolbarPosition("bottom", true), "bottom");
  });

  it("falls back safely when preference storage is unavailable", () => {
    assert.equal(readToolbarPosition({ getItem: () => { throw new Error("denied"); } }), "left");
  });
});
