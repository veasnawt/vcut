import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { drawTextFrame } from "../src/playback/textLayout.ts";
import { needsTextStyleBrowserRender } from "../src/export/buildExportPlan.ts";
import { DEFAULT_TEXT_STYLE, type TextStyle } from "../src/project/types.ts";
import { applyTextStylePreset, TEXT_STYLE_PRESETS } from "../src/project/textStylePresets.ts";
import { deserializeProject, serializeProject } from "../src/project/serialize.ts";
import { emptyProject } from "./fixture.ts";

/** A recording stand-in for a canvas context: enough of the 2D API for `drawTextFrame`, noting each `fillText` with
 *  the fill colour and total rotation in force when it happened. */
function recordingContext() {
  const fills: { text: string; color: string; rotated: number }[] = [];
  const events: string[] = [];
  const badges: { color: string; shape: string }[] = [];
  let pendingShape = "";
  let rotationTotal = 0;
  const stack: number[] = [];
  let fillStyle: unknown = "#000";
  const ctx = {
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    letterSpacing: "0px",
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    shadowColor: "",
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    shadowBlur: 0,
    strokeStyle: "",
    lineWidth: 0,
    lineJoin: "miter",
    get fillStyle() {
      return fillStyle;
    },
    set fillStyle(v: unknown) {
      fillStyle = v;
    },
    save: () => void stack.push(rotationTotal),
    restore: () => void (rotationTotal = stack.pop() ?? 0),
    translate: () => {},
    scale: () => {},
    rotate: (radians: number) => void (rotationTotal += radians),
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => {},
    fillRect: () => {},
    rect: () => void (pendingShape = "rect"),
    roundRect: () => void (pendingShape = "pill"),
    ellipse: () => void (pendingShape = "oval"),
    fill: () => {
      badges.push({ color: String(fillStyle), shape: pendingShape });
      events.push("badge");
    },
    strokeText: () => void events.push("stroke"),
    fillText: (text: string) => {
      events.push("text");
      fills.push({ text, color: String(fillStyle), rotated: rotationTotal });
    },
    measureText: (text: string) => ({ width: text.length * 10, actualBoundingBoxAscent: 20, actualBoundingBoxDescent: 5 }),
    createLinearGradient: () => ({ addColorStop: () => {} }),
    createRadialGradient: () => ({ addColorStop: () => {} }),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, fills, badges, events };
}

const plainStyle: TextStyle = { ...DEFAULT_TEXT_STYLE, color: "#111111" };

describe("per-word lettering (designed text stickers)", () => {
  it("fills each word in its own colour, cycling through the palette", () => {
    const { ctx, fills } = recordingContext();
    drawTextFrame(ctx, 1080, 1920, "one two three", { ...plainStyle, wordColors: ["#ff0000", "#00ff00"] }, undefined, []);
    assert.deepEqual(
      fills.map((f) => [f.text.trim(), f.color]),
      [["one", "#ff0000"], ["two", "#00ff00"], ["three", "#ff0000"]]
    );
  });

  it("splits Khmer (no spaces) into real words too", () => {
    const { ctx, fills } = recordingContext();
    drawTextFrame(ctx, 1080, 1920, "សួស្តីអ្នករាល់គ្នា", { ...plainStyle, wordColors: ["#ff0000", "#00ff00"] }, undefined, []);
    assert.ok(fills.length >= 2, `expected several words, got ${fills.length}`);
    assert.notEqual(fills[0].color, fills[1].color);
  });

  it("leans neighbouring words in opposite directions", () => {
    const { ctx, fills } = recordingContext();
    drawTextFrame(ctx, 1080, 1920, "aa bb", { ...plainStyle, wordTiltDeg: 5 }, undefined, []);
    assert.equal(fills.length, 2);
    assert.ok(fills[0].rotated * fills[1].rotated < 0, "opposite lean");
    assert.ok(Math.abs(Math.abs(fills[0].rotated) - (5 * Math.PI) / 180) < 1e-9);
  });

  it("leaves a plain style on the ordinary whole-line path (one fillText per line, no rotation)", () => {
    const { ctx, fills } = recordingContext();
    drawTextFrame(ctx, 1080, 1920, "one two three", plainStyle, undefined, []);
    assert.deepEqual(fills.map((f) => f.text), ["one two three"]);
    assert.equal(fills[0].rotated, 0);
  });
});

describe("word badges (a bubble behind chosen words)", () => {
  const words = "skin my day";

  it("draws a bubble only behind the words that have a colour, cycling the list", () => {
    const { ctx, badges } = recordingContext();
    drawTextFrame(ctx, 1080, 1920, words, { ...plainStyle, wordBadgeColors: ["transparent", "#ffe066", "transparent"] }, undefined, []);
    assert.deepEqual(badges.map((b) => b.color), ["#ffe066"]);
  });

  it("honours the shape (pill by default, oval when asked)", () => {
    const pill = recordingContext();
    drawTextFrame(pill.ctx, 1080, 1920, words, { ...plainStyle, wordBadgeColors: ["#ffe066"] }, undefined, []);
    assert.ok(pill.badges.every((b) => b.shape === "pill"));
    const oval = recordingContext();
    drawTextFrame(oval.ctx, 1080, 1920, words, { ...plainStyle, wordBadgeColors: ["#ffe066"], wordBadgeShape: "oval" }, undefined, []);
    assert.ok(oval.badges.every((b) => b.shape === "oval"));
  });

  it("is drawn BEFORE the text, so the letters sit on top of it", () => {
    const { ctx, events } = recordingContext();
    drawTextFrame(ctx, 1080, 1920, words, { ...plainStyle, strokeColor: "#fff", wordBadgeColors: ["transparent", "#ffe066"] }, undefined, []);
    assert.ok(events.indexOf("badge") >= 0 && events.indexOf("badge") < events.indexOf("stroke"), "badge before outlines");
    assert.ok(events.indexOf("badge") < events.indexOf("text"), "badge before fill");
  });

  it("draws nothing extra when every entry is transparent", () => {
    const { ctx, badges } = recordingContext();
    drawTextFrame(ctx, 1080, 1920, words, { ...plainStyle, wordBadgeColors: ["transparent", "transparent"] }, undefined, []);
    assert.equal(badges.length, 0);
  });

  it("routes badges through the browser-render export path", () => {
    assert.equal(needsTextStyleBrowserRender({ ...plainStyle, wordBadgeColors: ["transparent", "#ffe066"] }), true);
    assert.equal(needsTextStyleBrowserRender({ ...plainStyle, wordBadgeColors: ["transparent"] }), false);
  });

  it("survives a save and reload, and a plain preset clears it", () => {
    const badgePreset = TEXT_STYLE_PRESETS.find((p) => p.id === "sticker-skincare-badge")!;
    const styled = applyTextStylePreset(DEFAULT_TEXT_STYLE, badgePreset);
    assert.deepEqual(styled.wordBadgeColors, badgePreset.wordBadgeColors);
    assert.equal(styled.wordBadgeShape, "oval");
    const project = emptyProject();
    const asset = { id: "t", kind: "text" as const, name: "t", relPath: "", duration: 0, hasAudio: false, sizeBytes: 0, importedAt: 0, textContent: "hi", textStyle: styled };
    const reloaded = deserializeProject(serializeProject({ ...project, assets: [...project.assets, asset] })).assets.find((a) => a.id === "t")!.textStyle!;
    assert.deepEqual(reloaded.wordBadgeColors, badgePreset.wordBadgeColors);
    const plain = TEXT_STYLE_PRESETS.find((p) => !p.wordColors && !p.wordBadgeColors && !p.wordTiltDeg && !p.wordBounce)!;
    const cleared = applyTextStylePreset(styled, plain);
    assert.equal(cleared.wordBadgeColors, undefined);
    assert.equal(cleared.wordBadgeShape, undefined);
  });
});

describe("per-word styling is exported through the browser-render path", () => {
  it("routes wordColors / tilt / bounce to it, and not a plain style", () => {
    assert.equal(needsTextStyleBrowserRender({ ...plainStyle, wordColors: ["#f00", "#0f0"] }), true);
    assert.equal(needsTextStyleBrowserRender({ ...plainStyle, wordTiltDeg: 3 }), true);
    assert.equal(needsTextStyleBrowserRender({ ...plainStyle, wordBounce: 4 }), true);
    assert.equal(needsTextStyleBrowserRender(plainStyle), false);
  });
});

describe("sticker presets", () => {
  const stickers = TEXT_STYLE_PRESETS.filter((p) => p.category === "sticker");

  it("there is a healthy set of them, several with per-word colours", () => {
    assert.ok(stickers.length >= 20, `got ${stickers.length}`);
    assert.ok(stickers.filter((p) => (p.wordColors?.length ?? 0) >= 2).length >= 6);
  });

  it("applying one sets the word styling; applying a plain preset afterwards clears it (a preset is a whole look)", () => {
    const duo = stickers.find((p) => p.id === "sticker-skincare")!;
    const styled = applyTextStylePreset(DEFAULT_TEXT_STYLE, duo);
    assert.deepEqual(styled.wordColors, duo.wordColors);
    assert.equal(styled.wordTiltDeg, duo.wordTiltDeg);
    const plain = TEXT_STYLE_PRESETS.find((p) => !p.wordColors && !p.wordTiltDeg && !p.wordBounce)!;
    const cleared = applyTextStylePreset(styled, plain);
    assert.equal(cleared.wordColors, undefined);
    assert.equal(cleared.wordTiltDeg, undefined);
    assert.equal(cleared.wordBounce, undefined);
  });

  it("word styling survives a save and reload", () => {
    const project = emptyProject();
    const asset = {
      id: "t",
      kind: "text" as const,
      name: "t",
      relPath: "",
      duration: 0,
      hasAudio: false,
      sizeBytes: 0,
      importedAt: 0,
      textContent: "hi",
      textStyle: { ...DEFAULT_TEXT_STYLE, wordColors: ["#f00", "#0f0"], wordTiltDeg: 4, wordBounce: 6 },
    };
    const reloaded = deserializeProject(serializeProject({ ...project, assets: [...project.assets, asset] }));
    const style = reloaded.assets.find((a) => a.id === "t")!.textStyle!;
    assert.deepEqual(style.wordColors, ["#f00", "#0f0"]);
    assert.equal(style.wordTiltDeg, 4);
    assert.equal(style.wordBounce, 6);
  });
});
