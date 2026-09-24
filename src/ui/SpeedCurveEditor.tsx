"use client";

import { Fragment, useRef, useState } from "react";
import type { SpeedCurvePoint } from "../project/types.ts";
import { MAX_CLIP_SPEED, MIN_CLIP_SPEED } from "../timeline/clipTiming.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import { addDragListeners, clientPoint, preventDefaultIfMouse } from "./pointerEvents.ts";

interface Props {
  points: SpeedCurvePoint[];
  /** Always the FULL next point list — same "whole value back, never a patch" convention
   *  `CurveEditor.onCommit` uses for the identical reason (a keyframe-array-shaped edit). No
   *  `onPreview` here, unlike `CurveEditor`: a speed change re-times the clip's own playback (which
   *  source frame shows at which moment), not just which pixels a frame shows — there's no
   *  `ClipOverride.speedCurve` field to preview it through the way transform/effects/mask can, and
   *  adding one is real, separate work (re-seeking the live element mid-drag) out of scope here. The
   *  drawn LINE still responds instantly while dragging (see `dragPoints` below); only the canvas
   *  doesn't scrub live until release. */
  onCommit: (points: SpeedCurvePoint[]) => void;
}

/** SVG viewBox units, both axes — matches `CurveEditor`'s own convention. */
const GRAPH_SIZE = 100;
/** Minimum x-gap enforced between adjacent control points — same value and reasoning as
 *  `CurveEditor.MIN_POINT_GAP`: keeps a drag or a click-to-add from collapsing two points onto the
 *  same `position`. */
const MIN_POINT_GAP = 0.02;

/** `speed`'s own two endpoints, log-mapped for display (see `toSvgY`'s own comment for why). */
const LOG_MIN = Math.log10(MIN_CLIP_SPEED);
const LOG_MAX = Math.log10(MAX_CLIP_SPEED);

function toSvgX(position: number): number {
  return position * GRAPH_SIZE;
}

/** Curve-space is Y-UP (faster = higher, the same "up is more" convention `CurveEditor`'s own
 *  `toSvgY` uses for brightness) but SVG/screen space is Y-DOWN, so this flips through both that AND
 *  a log10 remap: speed is a MULTIPLIER, not a linear quantity — 0.5x and 2x are equally far from 1x
 *  perceptually (half as slow / twice as fast), which only reads that way on a log scale. A plain
 *  linear 0.1..8 mapping would cram the entire practically-useful 0.1x-2x range most speed ramps
 *  actually use into the graph's bottom quarter. */
function toSvgY(speed: number): number {
  const clamped = Math.min(MAX_CLIP_SPEED, Math.max(MIN_CLIP_SPEED, speed));
  const norm = (Math.log10(clamped) - LOG_MIN) / (LOG_MAX - LOG_MIN);
  return (1 - norm) * GRAPH_SIZE;
}

/** Inverse of `toSvgY` — a fraction of the graph's own height (0 at the bottom, 1 at the top, already
 *  Y-flipped) back to a real speed multiplier. */
function fractionToSpeed(fraction: number): number {
  const norm = 1 - Math.min(1, Math.max(0, fraction));
  return Math.min(MAX_CLIP_SPEED, Math.max(MIN_CLIP_SPEED, Math.pow(10, LOG_MIN + norm * (LOG_MAX - LOG_MIN))));
}

/** How many sub-samples each SEGMENT (the straight run between two adjacent control points) gets
 *  before being drawn — `clipSpeedAtElapsed` interpolates `speed` plain-LINEARLY between adjacent
 *  points (see its own doc comment in `clipTiming.ts`), so a segment is only a straight line in REAL
 *  speed-space; once put through this graph's own log-scaled `toSvgY`, that same straight relationship
 *  reads as a gently curved line on screen. Sampling (rather than drawing one straight SVG segment
 *  per pair of points) is what keeps the drawn shape an honest picture of what `clipSpeedAtElapsed`
 *  actually computes — the same accuracy commitment `CurveEditor`'s own doc comment makes for its
 *  spline sampling, just plain lerp instead of a spline since that's genuinely all the real
 *  interpolation is here. */
const SEGMENT_SAMPLE_STEPS = 12;

/** The speed-curve counterpart of `CurveEditor` — same draggable-point-on-an-SVG-graph interaction
 *  (built on the identical `addDragListeners`/`clientPoint` toolkit), adapted to `SpeedCurvePoint`'s
 *  own `{position, speed}` shape and log-scaled `speed` axis instead of color's linear 0..1 one. Two
 *  structural differences from `CurveEditor`, both already covered above: no spline (plain lerp
 *  between points, matching the real interpolation), and no `onPreview` (a speed change has no
 *  cheap, pixel-only live-preview path yet). */
export function SpeedCurveEditor({ points, onCommit }: Props) {
  const t = useTranslation();
  const svgRef = useRef<SVGSVGElement>(null);

  // Same "local state mirrors the drag, external prop mirrors the committed value" split
  // `CurveEditor.dragPoints`/`dragPointsRef` uses, and for the identical reason: the drawn line needs
  // to track the pointer every frame without that meaning a real commit (and so a new undo entry) on
  // every pixel of movement.
  const [dragPoints, setDragPoints] = useState<SpeedCurvePoint[] | null>(null);
  const dragPointsRef = useRef<SpeedCurvePoint[] | null>(null);
  const displayPoints = dragPoints ?? points;

  function clientToCurveSpace(clientX: number, clientY: number): { position: number; speed: number } {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return { position: 0, speed: 1 };
    const fx = (clientX - rect.left) / rect.width;
    const fy = (clientY - rect.top) / rect.height;
    return { position: Math.min(1, Math.max(0, fx)), speed: fractionToSpeed(1 - fy) };
  }

  function beginDragPoint(event: React.MouseEvent | React.TouchEvent, index: number): void {
    event.stopPropagation();
    const isTouch = "touches" in event;
    if (!isTouch && (event as React.MouseEvent).button !== 0) return;
    preventDefaultIfMouse(event);
    const basePoints = points;
    const isEndpoint = index === 0 || index === basePoints.length - 1;

    function onMove(moveEvent: MouseEvent | TouchEvent): void {
      const point = clientPoint(moveEvent);
      const curvePoint = clientToCurveSpace(point.x, point.y);
      const current = dragPointsRef.current ?? basePoints;
      const prevX = index > 0 ? current[index - 1].position + MIN_POINT_GAP : 0;
      const nextX = index < current.length - 1 ? current[index + 1].position - MIN_POINT_GAP : 1;
      const next = current.map((p, i) =>
        i === index
          ? { position: isEndpoint ? p.position : Math.min(nextX, Math.max(prevX, curvePoint.position)), speed: curvePoint.speed }
          : p
      );
      dragPointsRef.current = next;
      setDragPoints(next);
    }

    function onUp(): void {
      removeListeners();
      const final = dragPointsRef.current;
      dragPointsRef.current = null;
      setDragPoints(null);
      if (final) onCommit(final);
    }

    const removeListeners = addDragListeners(onMove, onUp);
  }

  function addPointAt(clientX: number, clientY: number): void {
    const curvePoint = clientToCurveSpace(clientX, clientY);
    if (points.some((p) => Math.abs(p.position - curvePoint.position) < MIN_POINT_GAP)) return;
    onCommit([...points, curvePoint].sort((a, b) => a.position - b.position));
  }

  function removePoint(index: number): void {
    if (index === 0 || index === points.length - 1) return; // endpoints are permanent
    onCommit(points.filter((_, i) => i !== index));
  }

  const segments: string[] = [];
  for (let i = 0; i < displayPoints.length - 1; i++) {
    const a = displayPoints[i];
    const b = displayPoints[i + 1];
    for (let step = 0; step <= SEGMENT_SAMPLE_STEPS; step++) {
      const t2 = step / SEGMENT_SAMPLE_STEPS;
      const position = a.position + (b.position - a.position) * t2;
      const speed = a.speed + (b.speed - a.speed) * t2;
      segments.push(`${i === 0 && step === 0 ? "M" : "L"} ${toSvgX(position).toFixed(2)} ${toSvgY(speed).toFixed(2)}`);
    }
  }
  const pathD = segments.join(" ");
  const oneXLevel = toSvgY(1);

  return (
    <div className="mb-2.5">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${GRAPH_SIZE} ${GRAPH_SIZE}`}
        className="mx-auto aspect-square w-full max-w-[260px] touch-none select-none overflow-visible rounded bg-black/30"
      >
        {/* Full-area click target for "add a point here" — same `pointerEvents: all` + first-in-DOM-
            order convention `CurveEditor`'s own identical rect uses, for the identical reason. */}
        <rect
          x={0}
          y={0}
          width={GRAPH_SIZE}
          height={GRAPH_SIZE}
          fill="transparent"
          style={{ pointerEvents: "all" }}
          onClick={(e) => addPointAt(e.clientX, e.clientY)}
        />
        {[0.25, 0.5, 0.75].map((f) => (
          <Fragment key={f}>
            <line x1={toSvgX(f)} y1={0} x2={toSvgX(f)} y2={GRAPH_SIZE} stroke="white" strokeOpacity={0.06} style={{ pointerEvents: "none" }} />
          </Fragment>
        ))}
        {/* The one horizontal reference line worth drawing explicitly (unlike the vertical thirds
            above, evenly spaced only because `position` itself is linear): 1x — everything above it
            on this log axis reads as sped up, everything below as slowed down. */}
        <line
          x1={0}
          y1={oneXLevel}
          x2={GRAPH_SIZE}
          y2={oneXLevel}
          stroke="white"
          strokeOpacity={0.15}
          strokeDasharray="2 2"
          style={{ pointerEvents: "none" }}
        />
        <path d={pathD} fill="none" stroke="#fbbf24" strokeWidth={1.5} style={{ pointerEvents: "none" }} />
        {displayPoints.map((p, i) => {
          const isEndpoint = i === 0 || i === displayPoints.length - 1;
          return (
            <circle
              key={i}
              cx={toSvgX(p.position)}
              cy={toSvgY(p.speed)}
              r={2.75}
              tabIndex={0}
              role="slider"
              aria-label={t("Speed curve point, {speed}x", { speed: p.speed.toFixed(2) })}
              aria-valuenow={p.speed}
              fill="#fbbf24"
              stroke="black"
              strokeWidth={0.5}
              className="cursor-pointer outline-none focus:stroke-sky-300"
              onMouseDown={(e) => beginDragPoint(e, i)}
              onTouchStart={(e) => beginDragPoint(e, i)}
              onDoubleClick={(e) => {
                e.stopPropagation();
                removePoint(i);
              }}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (!isEndpoint && (e.key === "Delete" || e.key === "Backspace")) {
                  e.preventDefault();
                  removePoint(i);
                }
              }}
            />
          );
        })}
      </svg>
      <p className="mt-1 text-center text-[10px] text-white/30">
        {t("Drag a point to reshape. Click to add, double-click to remove.")}
      </p>
    </div>
  );
}
