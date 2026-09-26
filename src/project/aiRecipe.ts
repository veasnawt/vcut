import { clipDuration } from "./createProject.ts";
import { AI_EDIT_IMAGE_CREDITS, aiEditVideoCredits } from "./aiEdit.ts";
import type { AiRecipeStep, Asset, Clip } from "./types.ts";

/** Credit prices of the AI tools, mirrored from the routes that charge them (`ai-background-remove`, `ai-edit`,
 *  `ai-video-cutout`, `inpaint/predict`) so a template can quote its total BEFORE anyone runs it. Keep in step with
 *  the server constants. */
export const AI_CUTOUT_CREDITS = 3;
export const AI_EDIT_CREDITS = AI_EDIT_IMAGE_CREDITS;
export const VIDEO_CUTOUT_CREDITS_PER_SECOND = 2;
export const VIDEO_CUTOUT_MIN_CREDITS = 3;
export const REMOVE_OBJECT_IMAGE_CREDITS = 16;
export const REMOVE_OBJECT_CREDITS_PER_SECOND_RATE = 16;

/** Estimated credits for running one step on a clip of `seconds` (a still image has no length). */
export function estimateAiStepCredits(step: AiRecipeStep, seconds: number, isImage: boolean): number {
  switch (step.tool) {
    case "cutout":
      return AI_CUTOUT_CREDITS;
    case "ai-edit":
      return isImage ? AI_EDIT_CREDITS : aiEditVideoCredits(seconds);
    case "video-cutout":
      return Math.max(VIDEO_CUTOUT_MIN_CREDITS, Math.ceil(Math.max(0, seconds) * VIDEO_CUTOUT_CREDITS_PER_SECOND));
    case "remove-object":
      return isImage ? REMOVE_OBJECT_IMAGE_CREDITS : Math.ceil(Math.max(1, seconds)) * REMOVE_OBJECT_CREDITS_PER_SECOND_RATE;
  }
}

/** A short human label for a step ("Cutout", "AI Edit: make it anime"). */
export function aiStepLabel(step: AiRecipeStep): string {
  switch (step.tool) {
    case "cutout":
    case "video-cutout":
      return "Cutout";
    case "ai-edit":
      return step.prompt ? `AI Edit: ${step.prompt}` : "AI Edit";
    case "remove-object":
      return "Remove Object";
  }
}

/** The chain of AI steps that produced `asset`, oldest first, and the original asset they started from. Stops if a
 *  source is missing from the project (then the asset itself is treated as the original) or after a few links, so a
 *  corrupt cycle can't loop. */
export function resolveAiOrigin(assets: readonly Asset[], asset: Asset): { root: Asset; steps: AiRecipeStep[] } {
  const steps: AiRecipeStep[] = [];
  let current = asset;
  for (let depth = 0; depth < 6 && current.aiOrigin; depth++) {
    const source = assets.find((a) => a.id === current.aiOrigin!.sourceAssetId);
    if (!source) break;
    steps.unshift(current.aiOrigin.step);
    current = source;
  }
  return { root: current, steps };
}

export interface TemplateAiSummary {
  /** Total steps across the whole template (a step is counted once per clip it runs on). */
  steps: number;
  /** Estimated credits to run every step once. */
  credits: number;
}

/** What a template's AI steps add up to — from the stored template alone (works on `TemplateProjectData`'s tracks). */
export function templateAiSummary(tracks: readonly { clips: readonly Clip[] }[], assets: readonly Asset[]): TemplateAiSummary {
  let steps = 0;
  let credits = 0;
  // Clips of the same footage with the same step and length share ONE run (the template runner reuses the result), so the cost is
  // counted once — e.g. a cutout used for a subject and its stacked echo copies.
  const seen = new Set<string>();
  for (const track of tracks) {
    for (const clip of track.clips) {
      if (!clip.templateAiSteps?.length) continue;
      const asset = assets.find((a) => a.id === clip.assetId);
      const isImage = asset?.kind === "image";
      const seconds = clipDuration(clip);
      for (const step of clip.templateAiSteps) {
        const key = `${clip.assetId}|${JSON.stringify(step)}|${Math.round(seconds * 100)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        steps += 1;
        credits += estimateAiStepCredits(step, seconds, isImage);
      }
    }
  }
  return { steps, credits };
}

/** Tags an AI-made asset with where it came from and what was done, so a template can repeat it. */
export function withAiOrigin(asset: Asset, sourceAssetId: string, step: AiRecipeStep): Asset {
  return { ...asset, aiOrigin: { sourceAssetId, step } };
}

/** The drawn Remove Object box as fractions of the source frame (or undefined if the source's size is unknown). */
export function normalizeRegion(
  rect: { x: number; y: number; width: number; height: number },
  source: Pick<Asset, "width" | "height">
): AiRecipeStep["region"] | undefined {
  if (!source.width || !source.height) return undefined;
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  return {
    x: clamp(rect.x / source.width),
    y: clamp(rect.y / source.height),
    width: clamp(rect.width / source.width),
    height: clamp(rect.height / source.height),
  };
}

/** The reverse of `normalizeRegion`, for the media that filled a template slot. */
export function denormalizeRegion(
  region: NonNullable<AiRecipeStep["region"]>,
  target: Pick<Asset, "width" | "height">
): { x: number; y: number; width: number; height: number } | null {
  if (!target.width || !target.height) return null;
  return {
    x: Math.round(region.x * target.width),
    y: Math.round(region.y * target.height),
    width: Math.max(1, Math.round(region.width * target.width)),
    height: Math.max(1, Math.round(region.height * target.height)),
  };
}
