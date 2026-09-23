import type { Clip, SpeedCurvePoint } from "../project/types.ts";

export const MIN_CLIP_SPEED = 0.1;
export const MAX_CLIP_SPEED = 8;

export function clampClipSpeed(value: number): number {
  return Math.min(MAX_CLIP_SPEED, Math.max(MIN_CLIP_SPEED, Number.isFinite(value) ? value : 1));
}

export function normalizedSpeedCurve(points: SpeedCurvePoint[] | undefined, fallbackSpeed = 1): SpeedCurvePoint[] | null {
  if (!points || points.length < 2) return null;
  const sorted = points
    .filter((p) => Number.isFinite(p.position) && Number.isFinite(p.speed))
    .map((p) => ({ position: Math.min(1, Math.max(0, p.position)), speed: clampClipSpeed(p.speed) }))
    .sort((a, b) => a.position - b.position);
  const unique: SpeedCurvePoint[] = [];
  for (const point of sorted) {
    if (unique.length && Math.abs(unique[unique.length - 1].position - point.position) < 1e-6) unique[unique.length - 1] = point;
    else unique.push(point);
  }
  if (unique.length < 2) return null;
  if (unique[0].position > 0) unique.unshift({ position: 0, speed: unique[0].speed ?? clampClipSpeed(fallbackSpeed) });
  if (unique[unique.length - 1].position < 1) unique.push({ position: 1, speed: unique[unique.length - 1].speed });
  return unique;
}

function reciprocalIntegral(speed0: number, speed1: number, progressWidth: number): number {
  if (Math.abs(speed1 - speed0) < 1e-8) return progressWidth / speed0;
  return (progressWidth / (speed1 - speed0)) * Math.log(speed1 / speed0);
}

export function clipPlaybackDuration(clip: Pick<Clip, "sourceIn" | "sourceOut" | "speed" | "speedCurve">): number {
  const sourceSpan = Math.max(0, clip.sourceOut - clip.sourceIn);
  const curve = normalizedSpeedCurve(clip.speedCurve, clip.speed ?? 1);
  if (!curve) return sourceSpan / clampClipSpeed(clip.speed ?? 1);
  let durationFactor = 0;
  for (let i = 0; i < curve.length - 1; i++) {
    durationFactor += reciprocalIntegral(curve[i].speed, curve[i + 1].speed, curve[i + 1].position - curve[i].position);
  }
  return sourceSpan * durationFactor;
}

/** Playback progress (0..1 through the selected source window) at a clip-relative timeline time. */
export function clipProgressAtElapsed(clip: Pick<Clip, "sourceIn" | "sourceOut" | "speed" | "speedCurve">, elapsed: number): number {
  const span = Math.max(0, clip.sourceOut - clip.sourceIn);
  if (span <= 0) return 0;
  const duration = clipPlaybackDuration(clip);
  const target = Math.min(duration, Math.max(0, elapsed)) / span;
  const curve = normalizedSpeedCurve(clip.speedCurve, clip.speed ?? 1);
  if (!curve) return Math.min(1, target * clampClipSpeed(clip.speed ?? 1));
  let accumulated = 0;
  for (let i = 0; i < curve.length - 1; i++) {
    const a = curve[i];
    const b = curve[i + 1];
    const width = b.position - a.position;
    const segment = reciprocalIntegral(a.speed, b.speed, width);
    if (target <= accumulated + segment || i === curve.length - 2) {
      const localTime = Math.max(0, target - accumulated);
      const delta = b.speed - a.speed;
      const localProgress = Math.abs(delta) < 1e-8
        ? localTime * a.speed
        : (width * a.speed * (Math.exp((localTime * delta) / width) - 1)) / delta;
      return Math.min(1, Math.max(0, a.position + localProgress));
    }
    accumulated += segment;
  }
  return 1;
}

export function clipSourceTimeAtElapsed(
  clip: Pick<Clip, "sourceIn" | "sourceOut" | "speed" | "speedCurve" | "reverse">,
  elapsed: number
): number {
  const span = clip.sourceOut - clip.sourceIn;
  const duration = clipPlaybackDuration(clip);
  let progress: number;
  if (elapsed < 0) progress = (elapsed * clipSpeedAtElapsed(clip, 0)) / Math.max(1e-9, span);
  else if (elapsed > duration) progress = 1 + ((elapsed - duration) * clipSpeedAtElapsed(clip, duration)) / Math.max(1e-9, span);
  else progress = clipProgressAtElapsed(clip, elapsed);
  return clip.reverse ? clip.sourceOut - progress * span : clip.sourceIn + progress * span;
}

export function clipSpeedAtElapsed(clip: Pick<Clip, "sourceIn" | "sourceOut" | "speed" | "speedCurve">, elapsed: number): number {
  const curve = normalizedSpeedCurve(clip.speedCurve, clip.speed ?? 1);
  if (!curve) return clampClipSpeed(clip.speed ?? 1);
  const progress = clipProgressAtElapsed(clip, elapsed);
  for (let i = 0; i < curve.length - 1; i++) {
    const a = curve[i];
    const b = curve[i + 1];
    if (progress <= b.position || i === curve.length - 2) {
      const t = b.position === a.position ? 0 : (progress - a.position) / (b.position - a.position);
      return a.speed + (b.speed - a.speed) * Math.min(1, Math.max(0, t));
    }
  }
  return curve[curve.length - 1].speed;
}

/** Re-normalizes the part of a curve between two playback-progress positions for split/trim. */
export function sliceSpeedCurve(points: SpeedCurvePoint[] | undefined, from: number, to: number): SpeedCurvePoint[] | undefined {
  const curve = normalizedSpeedCurve(points);
  if (!curve || to - from <= 1e-6) return undefined;
  const speedAt = (position: number) => {
    for (let i = 0; i < curve.length - 1; i++) {
      const a = curve[i], b = curve[i + 1];
      if (position <= b.position || i === curve.length - 2) {
        const t = (position - a.position) / Math.max(1e-9, b.position - a.position);
        return a.speed + (b.speed - a.speed) * Math.min(1, Math.max(0, t));
      }
    }
    return curve[curve.length - 1].speed;
  };
  const selected = [
    { position: from, speed: speedAt(from) },
    ...curve.filter((p) => p.position > from && p.position < to),
    { position: to, speed: speedAt(to) },
  ];
  return selected.map((p) => ({ position: (p.position - from) / (to - from), speed: p.speed }));
}
