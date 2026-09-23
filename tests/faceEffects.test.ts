import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SetClipEffectsCommand, SetClipFaceEffectsCommand } from "../src/commands/index.ts";
import { buildExportPlan, ExportError } from "../src/export/buildExportPlan.ts";
import { buildAudioOnlyExportPlan } from "../src/export/buildAudioOnlyExportPlan.ts";
import {
  FaceEffectsEngine,
  FaceEffectsError,
  faceEffectsUserMessage,
  type FaceEffectsFrame,
  type FaceEffectsProvider,
} from "../src/effects/FaceEffectsEngine.ts";
import {
  FACE_EFFECT_PRESETS,
  newFaceEffectInstance,
  type FaceEffectPreset,
  validateFaceEffectPreset,
} from "../src/effects/faceEffects.ts";
import { deserializeProject, serializeProject } from "../src/project/serialize.ts";
import { IDENTITY_EFFECTS } from "../src/project/types.ts";
import { addClip, setClipFaceEffects } from "../src/timeline/operations.ts";
import { UndoStack } from "../src/undo/UndoStack.ts";
import { audioAsset, clipsOf, emptyProject, imageAsset, videoTrackId } from "./fixture.ts";

const exportOptions = {
  inputPathFor: (assetId: string) => `/media/${assetId}.mp4`,
  outputPath: "/out/export.mp4",
  fontPathFor: (fileName: string) => `/fonts/${fileName}`,
  textFilePathFor: (clip: { id: string }) => `/tmp/${clip.id}.txt`,
};

function oneClipProject() {
  const base = emptyProject();
  const project = addClip(base, videoTrackId(base), "asset1", 0);
  return { project, clip: clipsOf(project, videoTrackId(project))[0] };
}

function effect(id = "face-effect-1", intensity = 0.8) {
  return { id, presetId: "big-mouth", intensity, target: { kind: "all" as const } };
}

function frame(): FaceEffectsFrame {
  return { width: 1, height: 1, rgba: new Uint8ClampedArray([1, 2, 3, 255]), timestampSeconds: 0 };
}

class FakeProvider implements FaceEffectsProvider {
  readonly id = "banuba" as const;
  initialized = 0;
  updated = 0;
  applied = 0;
  disposed = 0;
  faces = [{ trackingId: "face-1", confidence: 1, bounds: { x: 0, y: 0, width: 1, height: 1 } }];
  async initialize() { this.initialized++; }
  async detectFaces() { return this.faces; }
  async updateEffects() { this.updated++; }
  async applyEffects(input: FaceEffectsFrame) { this.applied++; return { ...input, rgba: new Uint8ClampedArray([9, 8, 7, 255]) }; }
  async dispose() { this.disposed++; }
}

const providerConfiguration = {
  provider: "banuba" as const,
  credential: "test-client-token",
  effectAssets: { "big-mouth": "/licensed-effects/big-mouth.zip" },
};

/** Test-only catalog entry. Production deliberately has no preset until a licensed asset is verified. */
const samplePreset: FaceEffectPreset = {
  id: "big-mouth",
  name: "Big Mouth",
  category: "face",
  providerEffects: { banuba: { assetKey: "big-mouth" } },
  morph: { mouthSize: 1 },
  defaultIntensity: 0.8,
  tags: ["mouth"],
  sortOrder: 10,
};

describe("Face Effect presets and project state", () => {
  it("keeps the production catalog empty and validates future preset definitions", () => {
    assert.equal(FACE_EFFECT_PRESETS.length, 0);
    assert.equal(validateFaceEffectPreset(samplePreset), samplePreset);
    assert.throws(() => validateFaceEffectPreset({ ...samplePreset, defaultIntensity: 2 }), /between 0 and 1/);
    assert.throws(() => validateFaceEffectPreset({ ...samplePreset, providerEffects: {} }), /provider asset/);
  });

  it("creates a one-click instance from preset metadata", () => {
    assert.deepEqual(newFaceEffectInstance(samplePreset, "fx-1"), {
      id: "fx-1", presetId: "big-mouth", intensity: 0.8, target: { kind: "all" },
    });
  });

  it("applies, clamps intensity, serializes, reopens, undoes, redoes, and removes", () => {
    const { project, clip } = oneClipProject();
    const stack = new UndoStack();
    const changed = stack.execute(project, new SetClipFaceEffectsCommand(clip.id, [effect("fx-1", 1.4)]));
    assert.equal(changed.sequence.tracks[0].clips[0].faceEffects?.[0].intensity, 1);
    const reopened = deserializeProject(serializeProject(changed));
    assert.deepEqual(reopened.sequence.tracks[0].clips[0].faceEffects, [effect("fx-1", 1)]);
    const undone = stack.undo(changed);
    assert.equal(undone.sequence.tracks[0].clips[0].faceEffects, undefined);
    const redone = stack.redo(undone);
    assert.deepEqual(redone.sequence.tracks[0].clips[0].faceEffects, [effect("fx-1", 1)]);
    assert.equal(setClipFaceEffects(redone, clip.id, null).sequence.tracks[0].clips[0].faceEffects, undefined);
  });

  it("preserves an ordered multi-effect stack alongside ordinary Filters", () => {
    const { project, clip } = oneClipProject();
    const filtered = new SetClipEffectsCommand(clip.id, { ...IDENTITY_EFFECTS, saturation: 0.5 }).apply(project);
    const changed = new SetClipFaceEffectsCommand(clip.id, [effect("fx-1"), effect("fx-2", 0.35)]).apply(filtered);
    const reopened = deserializeProject(serializeProject(changed)).sequence.tracks[0].clips[0];
    assert.equal(reopened.effects?.saturation, 0.5);
    assert.deepEqual(reopened.faceEffects?.map((item) => item.id), ["fx-1", "fx-2"]);
  });

  it("rejects duplicate effect ids and non-finite intensity before project mutation", () => {
    const { project, clip } = oneClipProject();
    assert.throws(() => setClipFaceEffects(project, clip.id, [effect("same"), effect("same")]), /unique id/);
    assert.throws(() => setClipFaceEffects(project, clip.id, [effect("nan", Number.NaN)]), /finite number/);
    assert.equal(project.sequence.tracks[0].clips[0].faceEffects, undefined);
  });

  it("accepts image clips and rejects audio clips", () => {
    const imageBase = emptyProject([imageAsset("image")]);
    const imageProject = addClip(imageBase, videoTrackId(imageBase), "image", 0);
    const imageClip = clipsOf(imageProject, videoTrackId(imageProject))[0];
    assert.deepEqual(setClipFaceEffects(imageProject, imageClip.id, [effect()]).sequence.tracks[0].clips[0].faceEffects, [effect()]);

    const audioBase = emptyProject([audioAsset("music")]);
    const audioTrack = audioBase.sequence.tracks.find((track) => track.kind === "audio")!;
    const audioProject = addClip(audioBase, audioTrack.id, "music", 0);
    const audioClip = clipsOf(audioProject, audioTrack.id)[0];
    assert.throws(() => setClipFaceEffects(audioProject, audioClip.id, [effect()]), /images and videos/);
  });

  it("keeps legacy projects unchanged and drops malformed stack entries safely", () => {
    const { project } = oneClipProject();
    const legacy = deserializeProject(serializeProject(project));
    assert.equal(legacy.sequence.tracks[0].clips[0].faceEffects, undefined);
    const raw = JSON.parse(serializeProject(project));
    raw.sequence.tracks[0].clips[0].faceEffects = [null, { id: "bad", presetId: "big-mouth", intensity: "high" }];
    assert.equal(deserializeProject(JSON.stringify(raw)).sequence.tracks[0].clips[0].faceEffects, undefined);
  });
});

describe("FaceEffectsEngine", () => {
  it("loads lazily, reuses its provider, applies frames, and disposes resources", async () => {
    const provider = new FakeProvider();
    let factories = 0;
    const engine = new FaceEffectsEngine(async () => { factories++; return provider; }, providerConfiguration, [samplePreset]);
    assert.equal(factories, 0);
    const first = await engine.apply(frame(), [effect()]);
    await engine.apply(frame(), [effect()]);
    assert.deepEqual([...first.rgba], [9, 8, 7, 255]);
    assert.equal(factories, 1);
    assert.equal(provider.initialized, 1);
    assert.equal(provider.applied, 2);
    await engine.dispose();
    await engine.dispose();
    assert.equal(provider.disposed, 1);
  });

  it("returns the original frame at zero intensity without loading a provider", async () => {
    let factories = 0;
    const engine = new FaceEffectsEngine(async () => { factories++; return new FakeProvider(); }, providerConfiguration, [samplePreset]);
    const input = frame();
    assert.equal(await engine.apply(input, [effect("fx", 0)]), input);
    assert.equal(factories, 0);
  });

  it("reports missing configuration, unavailable provider, missing assets, and no face cleanly", async () => {
    await assert.rejects(new FaceEffectsEngine(null, null, [samplePreset]).apply(frame(), [effect()]), (error) => {
      assert.ok(error instanceof FaceEffectsError);
      assert.equal(error.code, "missing-configuration");
      assert.equal(faceEffectsUserMessage(error), "Face Effects aren't available right now.");
      return true;
    });
    await assert.rejects(new FaceEffectsEngine(null, providerConfiguration, [samplePreset]).apply(frame(), [effect()]), { code: "provider-unavailable" });
    await assert.rejects(new FaceEffectsEngine(async () => new FakeProvider(), { ...providerConfiguration, effectAssets: {} }, [samplePreset]).apply(frame(), [effect()]), { code: "missing-effect-asset" });
    const provider = new FakeProvider();
    provider.faces = [];
    await assert.rejects(new FaceEffectsEngine(async () => provider, providerConfiguration, [samplePreset]).apply(frame(), [effect()]), (error) => {
      assert.equal(faceEffectsUserMessage(error), "VCut couldn't find a face in this frame. Try another clip or frame.");
      return true;
    });
  });
});

describe("Face Effects export boundary", () => {
  it("refuses to silently omit an active Face Effect", () => {
    const { project, clip } = oneClipProject();
    const changed = new SetClipFaceEffectsCommand(clip.id, [effect()]).apply(project);
    assert.throws(() => buildExportPlan(changed, exportOptions), (error) => {
      assert.ok(error instanceof ExportError);
      assert.match(error.message, /export provider is not configured/);
      return true;
    });
  });

  it("does not require visual preprocessing for an audio-only transcription mix", () => {
    const { project, clip } = oneClipProject();
    const changed = new SetClipFaceEffectsCommand(clip.id, [effect()]).apply(project);
    const plan = buildAudioOnlyExportPlan(changed, { inputPathFor: exportOptions.inputPathFor, outputPath: "/out/audio.mp3" });
    assert.ok(plan.args.includes("/media/asset1.mp4"));
  });

  it("uses the provider-rendered replacement after a successful preprocessing pass", () => {
    const { project, clip } = oneClipProject();
    const changed = new SetClipFaceEffectsCommand(clip.id, [effect()]).apply(project);
    const plan = buildExportPlan(changed, {
      ...exportOptions,
      faceEffectInputPathFor: () => "/tmp/provider-rendered.mp4",
    });
    assert.ok(plan.args.includes("/tmp/provider-rendered.mp4"));
    assert.ok(!plan.args.includes("/media/asset1.mp4"));
  });
});
