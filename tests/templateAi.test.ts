import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { denormalizeRegion, estimateAiStepCredits, normalizeRegion, resolveAiOrigin, templateAiSummary, withAiOrigin } from "../src/project/aiRecipe.ts";
import { deserializeProject, serializeProject } from "../src/project/serialize.ts";
import {
  buildProjectFromTemplate,
  completeTemplateAiStep,
  fillTemplateSlot,
  pendingTemplateAiTasks,
  sanitizeProjectForTemplate,
  skipTemplateAiSteps,
  templateSlotCandidates,
  templateSlots,
} from "../src/project/template.ts";
import type { AiRecipeStep, Asset, Clip, Project } from "../src/project/types.ts";
import { emptyProject } from "./fixture.ts";

const video = (id: string, extra: Partial<Asset> = {}): Asset =>
  ({ id, kind: "video", name: id, relPath: `${id}.mp4`, duration: 20, hasAudio: true, sizeBytes: 1, importedAt: 0, width: 1080, height: 1920, ...extra }) as Asset;
const image = (id: string, extra: Partial<Asset> = {}): Asset =>
  ({ id, kind: "image", name: id, relPath: `${id}.png`, duration: 0, hasAudio: false, sizeBytes: 1, importedAt: 0, width: 1080, height: 1920, ...extra }) as Asset;
const clip = (id: string, assetId: string, extra: Partial<Clip> = {}): Clip => ({ id, assetId, timelineStart: 0, sourceIn: 0, sourceOut: 5, ...extra }) as Clip;

function build(assets: Asset[], tracks: Clip[][]): Project {
  const base = emptyProject();
  return {
    ...base,
    assets: [...base.assets, ...assets],
    sequence: {
      ...base.sequence,
      tracks: tracks.map((clips, i) => ({ id: `t${i}`, kind: "video" as const, name: `V${i}`, locked: false, visible: true, muted: false, solo: false, clips })),
    },
  };
}

const cutoutStep: AiRecipeStep = { tool: "video-cutout", keepAudio: true };
const editStep: AiRecipeStep = { tool: "ai-edit", prompt: "make it anime", strength: "balanced" };

describe("AI recipe helpers", () => {
  it("follows the chain back to the original footage, oldest step first", () => {
    const raw = video("raw");
    const edited = withAiOrigin(image("edited"), "raw", editStep);
    const cut = withAiOrigin(image("cut"), "edited", { tool: "cutout" });
    const { root, steps } = resolveAiOrigin([raw, edited, cut], cut);
    assert.equal(root.id, "raw");
    assert.deepEqual(steps.map((s) => s.tool), ["ai-edit", "cutout"]);
  });

  it("treats an asset whose source is gone as its own original, and survives a cycle", () => {
    const orphan = withAiOrigin(image("orphan"), "missing", { tool: "cutout" });
    assert.equal(resolveAiOrigin([orphan], orphan).root.id, "orphan");
    const a = withAiOrigin(image("a"), "b", { tool: "cutout" });
    const b = withAiOrigin(image("b"), "a", { tool: "cutout" });
    assert.ok(resolveAiOrigin([a, b], a).steps.length <= 6);
  });

  it("prices each tool like its route", () => {
    assert.equal(estimateAiStepCredits({ tool: "cutout" }, 0, true), 3);
    assert.equal(estimateAiStepCredits({ tool: "ai-edit" }, 0, true), 16);
    assert.equal(estimateAiStepCredits({ tool: "ai-edit" }, 4, false), 120);
    assert.equal(estimateAiStepCredits({ tool: "video-cutout" }, 6, false), 12);
    assert.equal(estimateAiStepCredits({ tool: "video-cutout" }, 1, false), 3);
    assert.equal(estimateAiStepCredits({ tool: "remove-object" }, 3.2, false), 64);
  });

  it("keeps a drawn region lined up on media of another size", () => {
    const region = normalizeRegion({ x: 108, y: 192, width: 216, height: 384 }, { width: 1080, height: 1920 })!;
    assert.deepEqual(region, { x: 0.1, y: 0.1, width: 0.2, height: 0.2 });
    assert.deepEqual(denormalizeRegion(region, { width: 720, height: 1280 }), { x: 72, y: 128, width: 144, height: 256 });
    assert.equal(normalizeRegion({ x: 1, y: 1, width: 1, height: 1 }, {}), undefined);
  });
});

describe("saving an AI edit as a template", () => {
  it("makes the ORIGINAL footage the slot and records the steps on the clip", () => {
    const raw = video("raw");
    const cutout = withAiOrigin(video("cutout", { duration: 5 }), "raw", cutoutStep);
    const project = build([raw, cutout], [[clip("c1", "cutout", { chromaKey: { color: "#78ff9b", similarity: 0.2, smoothness: 0.08 } })]]);
    const template = sanitizeProjectForTemplate(project);
    const placeholders = template.assets.filter((a) => a.templatePlaceholder);
    assert.equal(placeholders.length, 1);
    assert.equal(placeholders[0].name, "raw");
    const saved = template.tracks[0].clips[0];
    assert.equal(saved.assetId, placeholders[0].id);
    assert.deepEqual(saved.templateAiSteps, [cutoutStep]);
    assert.equal(template.assets.some((a) => a.id === "cutout"), false);
    assert.deepEqual(templateSlotCandidates(project).map((c) => c.asset.id), ["raw"]);
  });

  it("a raw clip and its cutout layer share ONE slot (Text Behind Subject)", () => {
    const raw = video("raw");
    const cutout = withAiOrigin(video("cutout", { duration: 5 }), "raw", { tool: "video-cutout", overlay: true });
    const project = build([raw, cutout], [[clip("base", "raw")], [clip("top", "cutout")]]);
    const template = sanitizeProjectForTemplate(project);
    assert.equal(template.assets.filter((a) => a.templatePlaceholder).length, 1);
    assert.equal(template.tracks[0].clips[0].templateAiSteps, undefined);
    assert.equal(template.tracks[1].clips[0].templateAiSteps?.[0].overlay, true);
  });

  it("chains several steps in order and survives a save and reload", () => {
    const raw = image("raw");
    const edited = withAiOrigin(image("edited"), "raw", editStep);
    const cut = withAiOrigin(image("cut"), "edited", { tool: "cutout" });
    const project = build([raw, edited, cut], [[clip("c1", "cut")]]);
    const template = sanitizeProjectForTemplate(project);
    assert.deepEqual(template.tracks[0].clips[0].templateAiSteps?.map((s) => s.tool), ["ai-edit", "cutout"]);
    const rebuilt = buildProjectFromTemplate("p", "n", template);
    const reloaded = deserializeProject(serializeProject(rebuilt));
    assert.deepEqual(reloaded.sequence.tracks[0].clips[0].templateAiSteps?.map((s) => s.tool), ["ai-edit", "cutout"]);
    assert.equal(reloaded.sequence.tracks[0].clips[0].templateAiSteps?.[0].prompt, "make it anime");
  });

  it("keeps the AI result as-is when the author chooses to keep that footage fixed", () => {
    const raw = image("raw");
    const edited = withAiOrigin(image("edited"), "raw", editStep);
    const template = sanitizeProjectForTemplate(build([raw, edited], [[clip("c1", "edited")]]), new Set(["raw"]));
    assert.equal(template.assets.filter((a) => a.templatePlaceholder).length, 0);
    assert.equal(template.tracks[0].clips[0].templateAiSteps, undefined);
    assert.equal(template.assets.find((a) => a.id === "edited")?.templateBundledAudio, true);
  });

  it("an ordinary template has no AI steps and no summary", () => {
    const template = sanitizeProjectForTemplate(build([video("raw")], [[clip("c1", "raw")]]));
    assert.equal(templateAiSummary(template.tracks, template.assets).steps, 0);
  });

  it("quotes the total credits from the stored template", () => {
    const raw = video("raw");
    const cutout = withAiOrigin(video("cutout", { duration: 5 }), "raw", cutoutStep);
    const template = sanitizeProjectForTemplate(build([raw, cutout], [[clip("c1", "cutout")]]));
    const summary = templateAiSummary(template.tracks, template.assets);
    assert.equal(summary.steps, 1);
    assert.equal(summary.credits, 10);
  });
});

describe("using an AI template", () => {
  function opened() {
    const raw = video("raw");
    const cutout = withAiOrigin(video("cutout", { duration: 5 }), "raw", cutoutStep);
    const layer = withAiOrigin(video("layer", { duration: 5 }), "raw", { tool: "video-cutout", overlay: true });
    const template = sanitizeProjectForTemplate(build([raw, cutout, layer], [[clip("plain", "cutout")], [clip("over", "layer")]]));
    return buildProjectFromTemplate("p", "n", template);
  }

  it("has nothing to run until the slot is filled, then one step per clip", () => {
    const project = opened();
    assert.equal(pendingTemplateAiTasks(project).length, 0);
    const [slot] = templateSlots(project);
    const filled = fillTemplateSlot(project, slot.assetId, video("mine", { duration: 12 }));
    const tasks = pendingTemplateAiTasks(filled);
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0].credits, 10);
  });

  it("completing a step moves on; a finished clip has no steps left", () => {
    const project = opened();
    const filled = fillTemplateSlot(project, templateSlots(project)[0].assetId, video("mine", { duration: 12 }));
    const clipId = pendingTemplateAiTasks(filled)[0].clipId;
    const next = completeTemplateAiStep(filled, clipId);
    assert.equal(pendingTemplateAiTasks(next).some((t) => t.clipId === clipId), false);
    assert.equal(pendingTemplateAiTasks(next).length, 1);
  });

  it("'use the original' keeps a normal clip, but drops an overlay layer instead of covering the footage", () => {
    const project = opened();
    const filled = fillTemplateSlot(project, templateSlots(project)[0].assetId, video("mine", { duration: 12 }));
    const tasks = pendingTemplateAiTasks(filled);
    const plainId = tasks.find((t) => !t.step.overlay)!.clipId;
    const overlayId = tasks.find((t) => t.step.overlay)!.clipId;
    const kept = skipTemplateAiSteps(filled, plainId);
    assert.equal(kept.sequence.tracks.flatMap((t) => t.clips).some((c) => c.id === plainId), true);
    assert.equal(pendingTemplateAiTasks(kept).some((t) => t.clipId === plainId), false);
    const dropped = skipTemplateAiSteps(filled, overlayId);
    assert.equal(dropped.sequence.tracks.flatMap((t) => t.clips).some((c) => c.id === overlayId), false);
  });
});

describe("template AI cost", () => {
  it("counts one run for clips of the same footage, step and length (a cutout and its stacked copies)", () => {
    const raw = video("raw");
    const cutout = withAiOrigin(video("cutout", { duration: 5 }), "raw", cutoutStep);
    const template = sanitizeProjectForTemplate(build([raw, cutout], [[clip("a", "cutout")], [clip("b", "cutout")], [clip("c", "cutout", { sourceOut: 4 })]]));
    const summary = templateAiSummary(template.tracks, template.assets);
    // two lengths (3 s x2 -> one run, 4 s -> another)
    assert.equal(summary.steps, 2);
  });

  it("counts ONE run for an image edit even across different trim lengths — a still has no 'which frames' to disagree about", () => {
    // A real, reported case: a review screen's own itemized list correctly collapsed several stacked
    // copies of the same AI-edited photo into one row, but this function's own separate dedup key still
    // counted each distinct trim LENGTH as its own edit, quoting an inflated "Estimated total" (one
    // edit's worth of credits times how many different lengths happened to appear) that disagreed with
    // the single row shown right below it.
    const raw = image("raw");
    const edited = withAiOrigin(image("edited"), "raw", editStep);
    const template = sanitizeProjectForTemplate(build([raw, edited], [[clip("a", "edited")], [clip("b", "edited", { sourceOut: 3 })], [clip("c", "edited", { sourceOut: 8 })]]));
    const summary = templateAiSummary(template.tracks, template.assets);
    assert.equal(summary.steps, 1);
  });
});
