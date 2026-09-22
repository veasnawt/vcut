import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_TEXT_STYLE, type TextStyle } from "../src/project/types.ts";
import {
  applyTextStylePreset,
  isPresetDark,
  parseColorLuminance,
  PRESET_CATEGORIES,
  sanitizeTextStylePreset,
  TEXT_STYLE_PRESETS,
  validateTextStylePreset,
  type TextStylePreset,
} from "../src/project/textStylePresets.ts";
import { applyTextTransform } from "../src/playback/textLayout.ts";
import { deserializeProject, serializeProject } from "../src/project/serialize.ts";
import { createTrack } from "../src/project/createProject.ts";
import { buildTextStylePatchCommand, buildTextStylePresetCommand } from "../src/commands/index.ts";
import { setTextAsset } from "../src/timeline/operations.ts";
import { emptyProject } from "./fixture.ts";

describe("TextStylePreset Library & Schema", () => {
  it("every preset id is unique", () => {
    const ids = TEXT_STYLE_PRESETS.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("library contains at least 60 distinct presets (has 70+)", () => {
    assert.ok(TEXT_STYLE_PRESETS.length >= 60, `Expected at least 60 presets, got ${TEXT_STYLE_PRESETS.length}`);
  });

  it("every category in PRESET_CATEGORIES has presets assigned", () => {
    for (const cat of PRESET_CATEGORIES) {
      const matching = TEXT_STYLE_PRESETS.filter((p) => p.category === cat.id);
      assert.ok(matching.length > 0, `Category '${cat.id}' has no presets`);
    }
  });

  it("every preset passes schema validation", () => {
    for (const preset of TEXT_STYLE_PRESETS) {
      const res = validateTextStylePreset(preset);
      assert.equal(res.valid, true, `Preset '${preset.id}' failed validation: ${res.errors?.join(", ")}`);
    }
  });

  it("validateTextStylePreset catches invalid inputs", () => {
    assert.equal(validateTextStylePreset(null).valid, false);
    assert.equal(validateTextStylePreset({}).valid, false);
    assert.equal(validateTextStylePreset({ id: "test", label: "Test" }).valid, false); // missing color & bold
    assert.equal(validateTextStylePreset({ id: "", label: "Test", color: "#fff", bold: true }).valid, false); // empty id
  });

  it("sanitizeTextStylePreset safely coerces incomplete AI presets", () => {
    const sanitized = sanitizeTextStylePreset({
      id: "ai-neon",
      label: "AI Generated Neon",
      color: "#00ffcc",
      glowColor: "#00ffcc",
    });
    assert.equal(sanitized.id, "ai-neon");
    assert.equal(sanitized.label, "AI Generated Neon");
    assert.equal(sanitized.color, "#00ffcc");
    assert.equal(sanitized.bold, false);
    assert.equal(sanitized.glowColor, "#00ffcc");
    assert.equal(sanitized.category, "trending");
  });
});

describe("applyTextStylePreset", () => {
  it("sets color and bold from the preset", () => {
    const preset = TEXT_STYLE_PRESETS.find((p) => p.id === "bold-caption")!;
    const result = applyTextStylePreset(DEFAULT_TEXT_STYLE, preset);
    assert.equal(result.color, "#ffffff");
    assert.equal(result.bold, true);
  });

  it("sets strokeColor/strokeWidth when the preset defines them", () => {
    const preset = TEXT_STYLE_PRESETS.find((p) => p.id === "bold-caption")!;
    const result = applyTextStylePreset(DEFAULT_TEXT_STYLE, preset);
    assert.equal(result.strokeColor, "#000000");
    assert.equal(result.strokeWidth, 4);
  });

  it("clears strokeColor when switching to a preset that doesn't define one", () => {
    const withStroke = applyTextStylePreset(DEFAULT_TEXT_STYLE, TEXT_STYLE_PRESETS.find((p) => p.id === "bold-caption")!);
    assert.ok(withStroke.strokeColor);

    const cleared = applyTextStylePreset(withStroke, TEXT_STYLE_PRESETS.find((p) => p.id === "clean-white")!);
    assert.equal(cleared.strokeColor, undefined);
    assert.ok(!("strokeColor" in cleared));
  });

  it("clears backgroundColor/shadowColor the same way when a preset doesn't define them", () => {
    const withBg = applyTextStylePreset(DEFAULT_TEXT_STYLE, TEXT_STYLE_PRESETS.find((p) => p.id === "subtitle-box")!);
    assert.ok(withBg.backgroundColor);
    const clearedBg = applyTextStylePreset(withBg, TEXT_STYLE_PRESETS.find((p) => p.id === "clean-white")!);
    assert.ok(!("backgroundColor" in clearedBg));

    const withShadow = applyTextStylePreset(DEFAULT_TEXT_STYLE, TEXT_STYLE_PRESETS.find((p) => p.id === "soft-shadow")!);
    assert.ok(withShadow.shadowColor);
    const clearedShadow = applyTextStylePreset(withShadow, TEXT_STYLE_PRESETS.find((p) => p.id === "clean-white")!);
    assert.ok(!("shadowColor" in clearedShadow));
  });

  it("never touches fontSize, align, or position", () => {
    const base: TextStyle = {
      ...DEFAULT_TEXT_STYLE,
      fontFamily: "moul",
      fontSize: 88,
      align: "left",
      offsetX: 12,
      offsetY: -5,
      rotationDeg: 15,
    };
    const result = applyTextStylePreset(base, TEXT_STYLE_PRESETS.find((p) => p.id === "neon-pink")!);
    assert.equal(result.fontFamily, "moul"); // neon-pink has no fontFamily override
    assert.equal(result.fontSize, 88);
    assert.equal(result.align, "left");
    assert.equal(result.offsetX, 12);
    assert.equal(result.offsetY, -5);
    assert.equal(result.rotationDeg, 15);
  });

  it("applies font family when defined by preset, but allows preserveFont override", () => {
    const base: TextStyle = { ...DEFAULT_TEXT_STYLE, fontFamily: "lato" };
    const blockbuster = TEXT_STYLE_PRESETS.find((p) => p.id === "cinematic-blockbuster")!;
    assert.equal(blockbuster.fontFamily, "montserrat");

    // Default: applies preset's curated font
    const withPresetFont = applyTextStylePreset(base, blockbuster);
    assert.equal(withPresetFont.fontFamily, "montserrat");

    // With preserveFont: keeps user's chosen font
    const withPreservedFont = applyTextStylePreset(base, blockbuster, { preserveFont: true });
    assert.equal(withPreservedFont.fontFamily, "lato");
  });

  it("applies and cleans up advanced styling properties (glow, gradients, double-stroke, rounded box)", () => {
    const base = { ...DEFAULT_TEXT_STYLE };
    const retro = TEXT_STYLE_PRESETS.find((p) => p.id === "retro-70s-groove")!;
    assert.ok(retro.strokeColor2);
    assert.ok(retro.strokeWidth2);

    const withRetro = applyTextStylePreset(base, retro);
    assert.equal(withRetro.strokeColor2, "#78350f");
    assert.equal(withRetro.strokeWidth2, 3);

    // Switch to sunset vibes (gradient)
    const sunset = TEXT_STYLE_PRESETS.find((p) => p.id === "trending-sunset-vibes")!;
    const withSunset = applyTextStylePreset(withRetro, sunset);
    assert.ok(withSunset.gradient);
    assert.equal(withSunset.strokeColor2, undefined);
    assert.ok(!("strokeColor2" in withSunset));

    // Switch to clean aesthetic (background box)
    const aesthetic = TEXT_STYLE_PRESETS.find((p) => p.id === "trending-clean-aesthetic")!;
    const withBox = applyTextStylePreset(withSunset, aesthetic);
    assert.ok(withBox.backgroundColor);
    assert.equal(withBox.backgroundPadding, 10);
    assert.equal(withBox.backgroundCornerRadius, 8);
    assert.equal(withBox.gradient, undefined);
    assert.ok(!("gradient" in withBox));

    // Switch to clean white (minimal)
    const clean = applyTextStylePreset(withBox, TEXT_STYLE_PRESETS.find((p) => p.id === "clean-white")!);
    assert.equal(clean.backgroundColor, undefined);
    assert.equal(clean.backgroundPadding, undefined);
    assert.equal(clean.backgroundCornerRadius, undefined);
  });
});

describe("applyTextTransform", () => {
  it("handles uppercase transform", () => {
    assert.equal(applyTextTransform("hello world", "uppercase"), "HELLO WORLD");
  });

  it("handles lowercase transform", () => {
    assert.equal(applyTextTransform("HELLO WORLD", "lowercase"), "hello world");
  });

  it("handles capitalize transform", () => {
    assert.equal(applyTextTransform("hello world", "capitalize"), "Hello World");
  });

  it("returns original text when transform is none or undefined", () => {
    assert.equal(applyTextTransform("Hello World", "none"), "Hello World");
    assert.equal(applyTextTransform("Hello World", undefined), "Hello World");
  });
});

describe("Serialization & Project Roundtrip with Advanced Text Styles", () => {
  it("serializes and deserializes advanced text styles with 100% fidelity", () => {
    const project = emptyProject();
    const advancedStyle: TextStyle = {
      ...DEFAULT_TEXT_STYLE,
      fontFamily: "montserrat",
      fontSize: 120,
      color: "#ff007f",
      letterSpacing: 4,
      textTransform: "uppercase",
      textDecoration: "underline",
      opacity: 0.95,
      glowColor: "#00e5ff",
      glowBlur: 16,
      strokeColor: "#000000",
      strokeWidth: 3,
      strokeColor2: "#ffffff",
      strokeWidth2: 2,
      shadowColor: "rgba(0,0,0,0.8)",
      shadowOffsetX: 4,
      shadowOffsetY: 4,
      shadowBlur: 8,
      backgroundColor: "#1e1b4b",
      backgroundOpacity: 0.9,
      backgroundPadding: 14,
      backgroundCornerRadius: 8,
      gradient: {
        type: "linear",
        angleDeg: 90,
        stops: [
          { offset: 0, color: "#ff007f" },
          { offset: 1, color: "#38bdf8" },
        ],
      },
      shadows: [
        { color: "#ff0000", offsetX: 2, offsetY: 2, blur: 4 },
        { color: "#0000ff", offsetX: -2, offsetY: -2, blur: 4 },
      ],
    };

    project.assets.push({
      id: "text-asset-1",
      kind: "text",
      name: "Title",
      relPath: "text-1",
      duration: 5,
      hasAudio: false,
      textContent: "Hello Antigravity",
      textStyle: advancedStyle,
      sizeBytes: 100,
      importedAt: 0,
    });

    const json = serializeProject(project);
    const restored = deserializeProject(json);
    const asset = restored.assets.find((a) => a.id === "text-asset-1")!;
    assert.ok(asset.textStyle);
    assert.equal(asset.textStyle.fontFamily, "montserrat");
    assert.equal(asset.textStyle.letterSpacing, 4);
    assert.equal(asset.textStyle.textTransform, "uppercase");
    assert.equal(asset.textStyle.textDecoration, "underline");
    assert.equal(asset.textStyle.opacity, 0.95);
    assert.equal(asset.textStyle.glowColor, "#00e5ff");
    assert.equal(asset.textStyle.glowBlur, 16);
    assert.equal(asset.textStyle.strokeColor2, "#ffffff");
    assert.equal(asset.textStyle.strokeWidth2, 2);
    assert.equal(asset.textStyle.backgroundColor, "#1e1b4b");
    assert.equal(asset.textStyle.backgroundOpacity, 0.9);
    assert.equal(asset.textStyle.backgroundPadding, 14);
    assert.equal(asset.textStyle.backgroundCornerRadius, 8);
    assert.ok(asset.textStyle.gradient);
    assert.equal(asset.textStyle.gradient.type, "linear");
    assert.equal(asset.textStyle.gradient.stops.length, 2);
    assert.ok(asset.textStyle.shadows);
    assert.equal(asset.textStyle.shadows.length, 2);
  });

  it("loads older legacy text clips without optional styling properties gracefully", () => {
    const legacyJson = JSON.stringify({
      id: "proj-legacy",
      bpProjectId: "bp-test",
      name: "Legacy Project",
      schemaVersion: 1,
      createdAt: 1000,
      updatedAt: 1000,
      sequence: {
        id: "seq",
        name: "Main",
        fps: 30,
        width: 1080,
        height: 1920,
        tracks: [],
      },
      assets: [
        {
          id: "old-text",
          kind: "text",
          name: "Old Text",
          relPath: "old-text",
          duration: 5,
          textContent: "Simple caption",
          textStyle: {
            fontFamily: "roboto",
            fontSize: 64,
            color: "#ffffff",
            bold: false,
            italic: false,
            align: "center",
            strokeWidth: 3,
            shadowOffsetX: 2,
            shadowOffsetY: 2,
            lineHeightMultiplier: 1.2,
            offsetX: 0,
            offsetY: 0,
            rotationDeg: 0,
          },
        },
      ],
    });

    const restored = deserializeProject(legacyJson);
    const asset = restored.assets.find((a) => a.id === "old-text")!;
    assert.ok(asset.textStyle);
    assert.equal(asset.textStyle.fontFamily, "roboto");
    assert.equal(asset.textStyle.fontSize, 64);
    assert.equal(asset.textStyle.gradient, undefined);
    assert.equal(asset.textStyle.shadows, undefined);
    assert.equal(asset.textStyle.backgroundColor, undefined);
  });

  it("buildTextStylePresetCommand updates both asset textStyle and clip textStyleKeyframes", () => {
    const project = emptyProject();
    project.assets.push({
      id: "txt-asset",
      kind: "text",
      name: "Title",
      relPath: "txt-1",
      duration: 5,
      hasAudio: false,
      textContent: "Keyframed Text",
      textStyle: { ...DEFAULT_TEXT_STYLE, color: "#111111" },
      sizeBytes: 100,
      importedAt: 0,
    });
    const track = createTrack("text", "Text Track");
    track.id = "txt-track";
    track.clips.push({
      id: "clip-txt-1",
      assetId: "txt-asset",
      sourceIn: 0,
      sourceOut: 5,
      timelineStart: 0,
      textStyleKeyframes: [
        { id: "kf-1", time: 0, value: { ...DEFAULT_TEXT_STYLE, color: "#111111" } },
        { id: "kf-2", time: 2, value: { ...DEFAULT_TEXT_STYLE, color: "#222222" } },
      ],
    });
    project.sequence.tracks.push(track);

    const preset = TEXT_STYLE_PRESETS[0];
    const cmd = buildTextStylePresetCommand(project, ["clip-txt-1"], preset);
    assert.ok(cmd);
    const nextProject = cmd.apply(project);
    const asset = nextProject.assets.find((a) => a.id === "txt-asset")!;
    assert.equal(asset.textStyle?.color, preset.color);
    const foundTrack = nextProject.sequence.tracks.find((t) => t.id === "txt-track")!;
    const clip = foundTrack.clips.find((c) => c.id === "clip-txt-1")!;
    assert.ok(clip.textStyleKeyframes);
    assert.equal(clip.textStyleKeyframes.length, 2);
    assert.equal(clip.textStyleKeyframes[0].value.color, preset.color);
    assert.equal(clip.textStyleKeyframes[1].value.color, preset.color);
  });

  it("buildTextStylePatchCommand patches fontFamily onto both asset and keyframes", () => {
    const project = emptyProject();
    project.assets.push({
      id: "txt-asset-2",
      kind: "text",
      name: "Font Test",
      relPath: "txt-2",
      duration: 5,
      hasAudio: false,
      textContent: "Font Clip",
      textStyle: { ...DEFAULT_TEXT_STYLE, fontFamily: "roboto" },
      sizeBytes: 100,
      importedAt: 0,
    });
    const track2 = createTrack("text", "Text Track");
    track2.id = "txt-track-2";
    track2.clips.push({
      id: "clip-txt-2",
      assetId: "txt-asset-2",
      sourceIn: 0,
      sourceOut: 5,
      timelineStart: 0,
      textStyleKeyframes: [
        { id: "kf-3", time: 0, value: { ...DEFAULT_TEXT_STYLE, fontFamily: "roboto" } },
      ],
    });
    project.sequence.tracks.push(track2);

    const cmd = buildTextStylePatchCommand(project, ["clip-txt-2"], { fontFamily: "cinzel" });
    assert.ok(cmd);
    const nextProject = cmd.apply(project);
    const asset = nextProject.assets.find((a) => a.id === "txt-asset-2")!;
    assert.equal(asset.textStyle?.fontFamily, "cinzel");
    const foundTrack2 = nextProject.sequence.tracks.find((t) => t.id === "txt-track-2")!;
    const clip = foundTrack2.clips.find((c) => c.id === "clip-txt-2")!;
    assert.equal(clip.textStyleKeyframes?.[0].value.fontFamily, "cinzel");
  });

  it("setTextAsset sanitizes non-finite numbers without NaN corrupting styles", () => {
    const project = emptyProject();
    project.assets.push({
      id: "nan-asset",
      kind: "text",
      name: "NaN Test",
      relPath: "nan",
      duration: 5,
      hasAudio: false,
      textContent: "Hello",
      textStyle: DEFAULT_TEXT_STYLE,
      sizeBytes: 100,
      importedAt: 0,
    });

    const dirtyStyle: TextStyle = {
      ...DEFAULT_TEXT_STYLE,
      fontSize: NaN,
      strokeWidth: Infinity,
      lineHeightMultiplier: -Infinity,
    };
    const nextProject = setTextAsset(project, "nan-asset", "Hello", dirtyStyle);
    const asset = nextProject.assets.find((a) => a.id === "nan-asset")!;
    assert.ok(Number.isFinite(asset.textStyle?.fontSize));
    assert.ok(Number.isFinite(asset.textStyle?.strokeWidth));
    assert.ok(Number.isFinite(asset.textStyle?.lineHeightMultiplier));
  });
});

describe("Contrast and Dark Preset Thumbnail Visibility", () => {
  it("parseColorLuminance calculates correct luminance values", () => {
    assert.equal(parseColorLuminance("#000000"), 0);
    assert.equal(parseColorLuminance("#ffffff"), 1);
    assert.equal(parseColorLuminance("black"), 0);
    assert.equal(parseColorLuminance("white"), 1);
    assert.equal(parseColorLuminance("transparent"), 0);

    const charcoal = parseColorLuminance("#1e293b");
    assert.ok(charcoal > 0 && charcoal < 0.2, `Expected charcoal to be dark, got ${charcoal}`);

    const yellow = parseColorLuminance("#ffe600");
    assert.ok(yellow > 0.7, `Expected yellow to be bright, got ${yellow}`);
  });

  it("isPresetDark detects dark presets without bright background or stroke", () => {
    const minimalBlack = TEXT_STYLE_PRESETS.find((p) => p.id === "minimal-black")!;
    assert.equal(isPresetDark(minimalBlack), true, "Minimal Black must be detected as dark");

    const minimalCharcoal = TEXT_STYLE_PRESETS.find((p) => p.id === "minimal-charcoal-clean")!;
    assert.equal(isPresetDark(minimalCharcoal), true, "Minimal Charcoal Clean must be detected as dark");
  });

  it("isPresetDark returns false for bright presets", () => {
    const cleanWhite = TEXT_STYLE_PRESETS.find((p) => p.id === "clean-white")!;
    assert.equal(isPresetDark(cleanWhite), false, "Clean White does not need contrast bg");

    const boldCaption = TEXT_STYLE_PRESETS.find((p) => p.id === "bold-caption")!;
    assert.equal(isPresetDark(boldCaption), false, "Bold Caption does not need contrast bg");

    const hyperGlow = TEXT_STYLE_PRESETS.find((p) => p.id === "trending-hyper-glow")!;
    assert.equal(isPresetDark(hyperGlow), false, "Hyper Cyan Glow does not need contrast bg");
  });

  it("isPresetDark returns false for black text that already has a bright background box", () => {
    const yellowHighlight = TEXT_STYLE_PRESETS.find((p) => p.id === "yellow-highlight")!;
    assert.equal(isPresetDark(yellowHighlight), false, "Yellow Highlight has its own bright background box");

    const comicSpeechBubble = TEXT_STYLE_PRESETS.find((p) => p.id === "comic-speech-bubble")!;
    assert.equal(isPresetDark(comicSpeechBubble), false, "Comic Speech Bubble has its own white background box");

    const memeBottomText = TEXT_STYLE_PRESETS.find((p) => p.id === "meme-bottom-text")!;
    assert.equal(isPresetDark(memeBottomText), false, "Meme Bottom Text has its own yellow background box");
  });

  it("isPresetDark returns false for transparent text with bright outline", () => {
    const outlineOnly = TEXT_STYLE_PRESETS.find((p) => p.id === "minimal-outline-only")!;
    assert.equal(isPresetDark(outlineOnly), false, "Minimal Outline has a bright white outline on dark");
  });
});

