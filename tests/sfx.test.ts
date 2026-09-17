import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { assetFromBundledSfx, isSoundEffectAsset, SFX_REGISTRY, sfxById } from "../src/project/sfx.ts";
import { deserializeProject, serializeProject } from "../src/project/serialize.ts";
import { audioAsset, emptyProject } from "./fixture.ts";
import { SFX_METADATA } from "../src/project/sfxMetadata.generated.ts";

const SFX_DIR = path.resolve(import.meta.dirname, "..", "assets", "sfx");

describe("SFX_REGISTRY", () => {
  it("every entry has a unique id", () => {
    const ids = new Set<string>();
    for (const sfx of SFX_REGISTRY) {
      assert.ok(!ids.has(sfx.id), `duplicate sfx id: ${sfx.id}`);
      ids.add(sfx.id);
    }
  });

  it("every entry's file genuinely exists on disk — the registry never lies about what it ships", () => {
    for (const sfx of SFX_REGISTRY) {
      const filePath = path.join(SFX_DIR, sfx.file);
      assert.ok(fs.existsSync(filePath), `${sfx.id} points at a missing file: ${filePath}`);
    }
  });

  it("covers every category the panel groups by", () => {
    const categories = new Set(SFX_REGISTRY.map((s) => s.category));
    for (const category of ["UI", "Whoosh", "Impact", "Riser", "Chime", "Ambience", "Meme"] as const) {
      assert.ok(categories.has(category), `no registry entry uses category "${category}"`);
    }
  });

  // The zero-copy path (`assetFromBundledSfx`) is only ever as good as `SFX_METADATA` staying in sync
  // with the registry it describes — these would catch a registry entry added without ever re-running
  // `studios/vcut/scripts/generate-sfx-metadata.cjs`, which `assetFromBundledSfx` itself only handles
  // gracefully (a silent fallback to the old fetch-and-import path), not something a test should treat
  // as equally fine — every bundled entry SHOULD be zero-copy.
  it("has precomputed metadata for every registry entry", () => {
    for (const sfx of SFX_REGISTRY) {
      assert.ok(SFX_METADATA[sfx.file], `${sfx.id} (${sfx.file}) has no SFX_METADATA entry — run generate-sfx-metadata.cjs`);
    }
  });

  it("every entry's precomputed waveform file genuinely exists on disk", () => {
    for (const sfx of SFX_REGISTRY) {
      const waveformFile = SFX_METADATA[sfx.file]?.waveformFile;
      assert.ok(waveformFile, `${sfx.id} has no waveformFile in SFX_METADATA`);
      assert.ok(fs.existsSync(path.join(SFX_DIR, waveformFile)), `${sfx.id} points at a missing waveform: ${waveformFile}`);
    }
  });
});

describe("assetFromBundledSfx", () => {
  it("builds a real, placeable audio asset for a known registry entry", () => {
    const def = sfxById("click-soft")!;
    const asset = assetFromBundledSfx(def);
    assert.ok(asset);
    assert.equal(asset.kind, "audio");
    assert.equal(asset.name, def.label);
    assert.equal(asset.relPath, def.file);
    assert.equal(asset.hasAudio, true);
    assert.ok(asset.duration > 0);
    assert.equal(asset.waveformRelPath, SFX_METADATA[def.file].waveformFile);
  });

  it("marks the asset bundledSfx and hiddenFromLibrary", () => {
    const asset = assetFromBundledSfx(sfxById("click-soft")!)!;
    assert.equal(asset.bundledSfx, true);
    assert.equal(asset.hiddenFromLibrary, true);
  });

  it("mints a fresh id on every call — two placements of the same sound are independent assets", () => {
    const def = sfxById("click-soft")!;
    const first = assetFromBundledSfx(def)!;
    const second = assetFromBundledSfx(def)!;
    assert.notEqual(first.id, second.id);
  });

  it("returns null when there is no precomputed metadata for the file", () => {
    const asset = assetFromBundledSfx({ id: "made-up", label: "Made Up", category: "UI", file: "does-not-exist.mp3" });
    assert.equal(asset, null);
  });
});

describe("sfxById", () => {
  it("finds an entry by its id", () => {
    assert.equal(sfxById("click-soft")?.label, "Click (Soft)");
  });

  it("returns undefined for an unknown id — no lenient fallback, unlike fontById", () => {
    assert.equal(sfxById("does-not-exist"), undefined);
    assert.equal(sfxById(""), undefined);
  });
});

describe("isSoundEffectAsset", () => {
  it("recognizes a bundled catalog sound and marks new ones explicitly", () => {
    const asset = assetFromBundledSfx(SFX_REGISTRY.find((def) => SFX_METADATA[def.file])!)!;
    assert.equal(asset.soundEffect, true);
    assert.equal(isSoundEffectAsset(asset), true);
  });

  it("recognizes a re-imported sound effect by its marker alone", () => {
    assert.equal(isSoundEffectAsset({ ...audioAsset("sfx", 1), name: "anything.m4a", soundEffect: true }), true);
  });

  it("recognizes a catalog sound saved into a template before the marker existed, by name", () => {
    const label = SFX_REGISTRY[0].label;
    assert.equal(isSoundEffectAsset({ ...audioAsset("legacy", 1), name: `${label}.mp3` }), true);
    assert.equal(isSoundEffectAsset({ ...audioAsset("legacy", 1), name: label.toUpperCase() }), true);
  });

  it("leaves music and other audio alone", () => {
    assert.equal(isSoundEffectAsset({ ...audioAsset("song", 180), name: "My Song.mp3" }), false);
    assert.equal(isSoundEffectAsset({ ...audioAsset("vo", 12), name: "Voiceover 1.webm", hiddenFromLibrary: true }), false);
  });

  it("never treats a non-audio asset as a sound effect", () => {
    const project = emptyProject();
    assert.equal(isSoundEffectAsset({ ...project.assets[0], soundEffect: true }), false);
  });

  it("survives a save and load", () => {
    const project = emptyProject([{ ...audioAsset("sfx", 1), soundEffect: true }]);
    const loaded = deserializeProject(serializeProject(project));
    assert.equal(loaded.assets[0].soundEffect, true);
  });
});
