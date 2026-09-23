import { clipDuration } from "../project/createProject.ts";
import type { Asset, Clip } from "../project/types.ts";
import { clipSourceTimeAtElapsed } from "./clipTiming.ts";
import { frameDuration, snapToFrame } from "./time.ts";

export const DEFAULT_TIMELINE_PIXELS_PER_SECOND = 60;
export const MIN_TIMELINE_PIXELS_PER_SECOND = 4;
export const MAX_TIMELINE_PIXELS_PER_SECOND = 1200;

export function clampTimelineZoom(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TIMELINE_PIXELS_PER_SECOND;
  return Math.min(MAX_TIMELINE_PIXELS_PER_SECOND, Math.max(MIN_TIMELINE_PIXELS_PER_SECOND, value));
}

/** Converts client-space X to timeline seconds. This is the single inverse of the timeline's
 * `time * pixelsPerSecond + leadingPad - scrollLeft` drawing equation. */
export function timelineTimeAtClientX(params: {
  clientX: number;
  viewportLeft: number;
  scrollLeft: number;
  leadingPad: number;
  pixelsPerSecond: number;
}): number {
  const { clientX, viewportLeft, scrollLeft, leadingPad, pixelsPerSecond } = params;
  if (!Number.isFinite(pixelsPerSecond) || pixelsPerSecond <= 0) return 0;
  return (clientX - viewportLeft + scrollLeft - leadingPad) / pixelsPerSecond;
}

/** Scroll position which keeps `time` under the same client-space anchor after zooming. */
export function timelineScrollLeftForAnchor(params: {
  time: number;
  clientX: number;
  viewportLeft: number;
  leadingPad: number;
  pixelsPerSecond: number;
}): number {
  return params.time * params.pixelsPerSecond - (params.clientX - params.viewportLeft) + params.leadingPad;
}

/** A minimum width is presentation only. It never feeds back into clip time or duration. */
export function timelineSpanPixels(duration: number, pixelsPerSecond: number, minimumPixels = 0): number {
  return Math.max(minimumPixels, Math.max(0, duration) * Math.max(0, pixelsPerSecond));
}

/** Pixel-based snapping stays usable across zoom levels, while the frame cap prevents a 16px magnet
 * from silently becoming several seconds wide at overview zoom. */
export function timelineSnapThreshold(
  pixelRadius: number,
  pixelsPerSecond: number,
  fps: number,
  maximumFrames = 8
): number {
  if (!(pixelsPerSecond > 0)) return 0;
  const pixelSeconds = Math.max(0, pixelRadius) / pixelsPerSecond;
  const frameCap = frameDuration(fps) * Math.max(1, maximumFrames);
  return frameCap > 0 ? Math.min(pixelSeconds, frameCap) : pixelSeconds;
}

function nearlyEqual(a: number, b: number, epsilon = 1e-7): boolean {
  return Math.abs(a - b) <= epsilon;
}

function isFrameAligned(time: number, fps: number): boolean {
  return nearlyEqual(time, snapToFrame(time, fps));
}

export interface TimelineSnapResult {
  /** Always on the sequence frame grid, even when no magnetic point is close enough. */
  time: number;
  /** The exact magnetic point reached, or null when this was only ordinary frame quantization. */
  target: number | null;
}

/** Resolves one editable timeline edge. Non-frame-aligned derived edges (for example the end of a
 * speed-ramped clip) are deliberately not advertised as exact snap targets when the model cannot
 * represent that edit without moving off the sequence frame grid. */
export function resolveTimelineSnap(params: {
  rawTime: number;
  points: number[];
  pixelsPerSecond: number;
  fps: number;
  pixelRadius: number;
  maximumFrames?: number;
}): TimelineSnapResult {
  const threshold = timelineSnapThreshold(
    params.pixelRadius,
    params.pixelsPerSecond,
    params.fps,
    params.maximumFrames
  );
  let bestTarget: number | null = null;
  let bestDistance = threshold + 1e-9;
  for (const point of params.points) {
    if (!Number.isFinite(point) || !isFrameAligned(point, params.fps)) continue;
    const distance = Math.abs(point - params.rawTime);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestTarget = point;
    }
  }
  return bestTarget === null
    ? { time: snapToFrame(params.rawTime, params.fps), target: null }
    : { time: bestTarget, target: bestTarget };
}

export interface MoveDragResult {
  /** Frame-aligned delta applied identically to every member of the selection. */
  delta: number;
  /** Edge point reached by the group, used by the UI's vertical snap guide. */
  target: number | null;
}

/** Resolves a move using the selected group's outer timeline bounds. Snapping the delta rather than
 * each clip independently preserves every relative gap and keeps group previews identical to commit. */
export function resolveMoveDrag(params: {
  rawDelta: number;
  selectionStart: number;
  selectionEnd: number;
  points: number[];
  pixelsPerSecond: number;
  fps: number;
  pixelRadius: number;
  maximumFrames?: number;
}): MoveDragResult {
  const minimumDelta = -Math.max(0, params.selectionStart);
  const threshold = timelineSnapThreshold(
    params.pixelRadius,
    params.pixelsPerSecond,
    params.fps,
    params.maximumFrames
  );
  let bestDelta: number | null = null;
  let bestTarget: number | null = null;
  let bestDistance = threshold + 1e-9;

  for (const point of params.points) {
    if (!Number.isFinite(point)) continue;
    for (const boundary of [params.selectionStart, params.selectionEnd]) {
      const candidate = point - boundary;
      if (candidate < minimumDelta - 1e-9 || !isFrameAligned(candidate, params.fps)) continue;
      const distance = Math.abs(candidate - params.rawDelta);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestDelta = candidate;
        bestTarget = point;
      }
    }
  }

  if (bestDelta !== null) return { delta: Math.max(minimumDelta, bestDelta), target: bestTarget };
  return { delta: Math.max(minimumDelta, snapToFrame(params.rawDelta, params.fps)), target: null };
}

export interface TrimPreview {
  start: number;
  duration: number;
  sourceIn: number;
  sourceOut: number;
}

/** Pure live-trim geometry matching `trimClip`. Retimed/reversed video uses the same timeline-to-source
 * mapping as playback and export, so the preview cannot promise an edge that commit later moves. */
export function calculateTrimPreview(params: {
  clip: Clip;
  asset: Pick<Asset, "kind" | "duration"> | undefined;
  edge: "in" | "out";
  targetTime: number;
  fps: number;
}): TrimPreview {
  const { clip, asset, edge, fps } = params;
  const oldDuration = clipDuration(clip);
  const min = frameDuration(fps);
  const end = clip.timelineStart + oldDuration;
  const target = snapToFrame(params.targetTime, fps);
  const hasFixedSourceLength = Boolean(asset) && !["image", "text", "color"].includes(asset!.kind);
  const retimed = asset?.kind === "video" && (clip.reverse || clip.speedCurve || Math.abs((clip.speed ?? 1) - 1) > 1e-6);

  if (retimed) {
    if (edge === "in") {
      const applied = Math.min(Math.max(target - clip.timelineStart, 0), Math.max(0, oldDuration - min));
      const sourceAt = clipSourceTimeAtElapsed(clip, applied);
      return {
        start: clip.timelineStart + applied,
        duration: oldDuration - applied,
        sourceIn: clip.reverse ? clip.sourceIn : sourceAt,
        sourceOut: clip.reverse ? sourceAt : clip.sourceOut,
      };
    }
    const duration = Math.min(oldDuration, Math.max(min, target - clip.timelineStart));
    const sourceAt = clipSourceTimeAtElapsed(clip, duration);
    return {
      start: clip.timelineStart,
      duration,
      sourceIn: clip.reverse ? sourceAt : clip.sourceIn,
      sourceOut: clip.reverse ? clip.sourceOut : sourceAt,
    };
  }

  if (edge === "in") {
    const lower = Math.max(0, hasFixedSourceLength ? clip.timelineStart - clip.sourceIn : Number.NEGATIVE_INFINITY);
    const nextStart = Math.min(Math.max(target, lower), end - min);
    const delta = nextStart - clip.timelineStart;
    return {
      start: nextStart,
      duration: end - nextStart,
      sourceIn: clip.sourceIn + delta,
      sourceOut: clip.sourceOut,
    };
  }

  const sourceLimit = hasFixedSourceLength ? asset!.duration : Number.POSITIVE_INFINITY;
  const nextEnd = Math.min(Math.max(target, clip.timelineStart + min), clip.timelineStart + (sourceLimit - clip.sourceIn));
  return {
    start: clip.timelineStart,
    duration: nextEnd - clip.timelineStart,
    sourceIn: clip.sourceIn,
    sourceOut: clip.sourceIn + (nextEnd - clip.timelineStart),
  };
}

/** Frame-bounded duration for transition handles. The maximum is floored to a complete frame so the
 * visual handle, saved value, preview window, and exported frame count share one boundary. */
export function clampFrameDuration(value: number, maximum: number, fps: number): number {
  if (!(maximum > 0)) return 0;
  const min = frameDuration(fps);
  if (!(min > 0)) return Math.min(maximum, Math.max(0, value));
  const frameMaximum = Math.floor((maximum + 1e-9) * fps) / fps;
  if (frameMaximum < min) return maximum;
  return Math.min(frameMaximum, Math.max(min, snapToFrame(value, fps)));
}

export interface RulerTick {
  frame: number;
  seconds: number;
  major: boolean;
}

function rulerStepFrames(pixelsPerSecond: number, fps: number): { major: number; minor: number } {
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 30;
  const targetFrames = (90 * safeFps) / Math.max(MIN_TIMELINE_PIXELS_PER_SECOND, pixelsPerSecond);
  const preferred = [1, 2, 3, 5, 10, 15, 30, 60, 90, 150, 300, 450, 900, 1800, 3600, 9000, 18000];
  const major = preferred.find((frames) => frames >= targetFrames) ?? Math.ceil(targetFrames / 18000) * 18000;
  const divisors = [5, 3, 2];
  const divisor = divisors.find((candidate) => major % candidate === 0) ?? 1;
  return { major, minor: Math.max(1, major / divisor) };
}

/** Only builds ticks around the visible viewport. Frame indices are the source of truth, avoiding
 * cumulative floating-point drift and huge off-screen DOM trees on long, highly-zoomed projects. */
export function visibleRulerTicks(params: {
  visibleStart: number;
  visibleEnd: number;
  pixelsPerSecond: number;
  fps: number;
  totalDuration: number;
}): RulerTick[] {
  const fps = Number.isFinite(params.fps) && params.fps > 0 ? params.fps : 30;
  const { major, minor } = rulerStepFrames(params.pixelsPerSecond, fps);
  const first = Math.max(0, Math.floor((Math.max(0, params.visibleStart) * fps) / minor) * minor - major);
  const last = Math.ceil((Math.min(params.totalDuration, Math.max(params.visibleStart, params.visibleEnd)) * fps) / minor) * minor + major;
  const maxFrame = Math.ceil(params.totalDuration * fps);
  const ticks: RulerTick[] = [];
  for (let frame = first; frame <= Math.min(last, maxFrame); frame += minor) {
    ticks.push({ frame, seconds: frame / fps, major: frame % major === 0 });
  }
  return ticks;
}
