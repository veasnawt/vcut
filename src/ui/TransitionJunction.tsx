"use client";

import React, { useRef, useState } from "react";
import { clampFrameDuration, timelineSpanPixels } from "../timeline/interaction.ts";
import { TransitionGlyph } from "./TransitionGlyph.tsx";

/** A junction control spans both neighbors. The centered strip represents the blend duration;
 *  it does not move either clip's cut or change the export's source-handle timing. */
export function TransitionJunction({
  cutSeconds,
  duration,
  maxDuration,
  pixelsPerSecond,
  fps,
  mobile,
  locked,
  label,
  durationLabel,
  timeAtClientX,
  onOpen,
  onDurationChange,
}: {
  cutSeconds: number;
  duration: number | null;
  maxDuration: number;
  pixelsPerSecond: number;
  fps: number;
  mobile: boolean;
  locked: boolean;
  label: string;
  durationLabel: string;
  timeAtClientX: (clientX: number) => number;
  onOpen: (rect: DOMRect) => void;
  onDurationChange: (duration: number) => void;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const drag = useRef<{ time: number; initial: number; value: number; side: number; pointer: number } | null>(null);
  const boundedMaximum = clampFrameDuration(maxDuration, maxDuration, fps);
  const minimum = Math.min(1 / fps, boundedMaximum);
  const clamp = (value: number) => clampFrameDuration(value, boundedMaximum, fps);
  const value = Math.min(draft ?? duration ?? 0, boundedMaximum);
  const active = duration !== null;
  const width = active ? timelineSpanPixels(value, pixelsPerSecond, 28) : 28;
  const size = mobile ? 30 : 26;
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  function finish(e: React.PointerEvent<HTMLDivElement>, commit: boolean) {
    const current = drag.current;
    if (!current || current.pointer !== e.pointerId) return;
    e.stopPropagation();
    drag.current = null;
    setDraft(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (commit && current.value !== current.initial) onDurationChange(current.value);
  }

  return (
    <div
      data-transition-junction
      style={{
        position: "absolute",
        left: cutSeconds * pixelsPerSecond - width / 2,
        width,
        height: size,
        top: `calc(50% - ${size / 2}px)`,
        zIndex: 20,
      }}
      onMouseDown={stop}
      onTouchStart={stop}
      onClick={stop}
    >
      <button
        type="button"
        disabled={locked}
        aria-label={label}
        title={active ? `${label} · ${value.toFixed(2)}s` : label}
        onPointerDown={stop}
        onClick={(e) => {
          e.stopPropagation();
          onOpen(e.currentTarget.getBoundingClientRect());
        }}
        className={`absolute inset-0 flex w-full items-center justify-center overflow-hidden rounded-md border shadow-sm transition-colors disabled:cursor-default ${
          active
            ? "border-sky-400/50 bg-sky-950/80 hover:border-sky-300 hover:bg-sky-900/80"
            : "border-white/20 bg-[#1e232d]/90 text-white/70 hover:border-sky-400 hover:bg-slate-800 hover:text-white"
        }`}
      >
        {active ? (
          <>
            {/* Subtle horizontal blend gradient across the transition span */}
            <div className="pointer-events-none absolute inset-0 flex">
              <div className="h-full w-1/2 bg-gradient-to-r from-sky-500/20 to-sky-500/5" />
              <div className="h-full w-1/2 bg-gradient-to-r from-white/5 to-white/15" />
            </div>

            {/* Hairline cut seam divider at 50% width */}
            <div className="pointer-events-none absolute bottom-0 left-1/2 top-0 w-px -translate-x-1/2 bg-sky-300/40" />

            {/* Floating center badge with overlapping-frames glyph + live duration */}
            <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
              {width >= 56 ? (
                <div className="flex items-center gap-1.5 rounded-full border border-sky-400/40 bg-slate-950/90 px-2 py-0.5 shadow-sm">
                  <TransitionGlyph size={12} className="shrink-0 text-sky-300" />
                  <span className="text-[10px] font-semibold leading-none tabular-nums text-white/95">{value.toFixed(1)}s</span>
                </div>
              ) : (
                <div className="flex h-5 w-5 items-center justify-center rounded-full border border-sky-400/40 bg-slate-950/90 shadow-sm">
                  <TransitionGlyph size={10} className="shrink-0 text-sky-300" />
                </div>
              )}
            </div>
          </>
        ) : (
          /* Inactive cut point button */
          <TransitionGlyph size={14} />
        )}
      </button>
      {active &&
        !locked &&
        [-1, 1].map((side) => (
          <div
            key={side}
            role="slider"
            tabIndex={0}
            aria-label={durationLabel}
            aria-orientation="horizontal"
            aria-valuemin={minimum}
            aria-valuemax={boundedMaximum}
            aria-valuenow={value}
            aria-valuetext={`${value.toFixed(2)}s`}
            data-transition-handle={side < 0 ? "left" : "right"}
            className="group absolute top-0 flex h-full touch-none cursor-ew-resize items-center justify-center rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-300"
            style={{ width: mobile ? 22 : 12, [side < 0 ? "left" : "right"]: mobile ? -11 : -6 }}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              e.stopPropagation();
              drag.current = { time: timeAtClientX(e.clientX), initial: value, value, side, pointer: e.pointerId };
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              const current = drag.current;
              if (!current || current.pointer !== e.pointerId) return;
              e.stopPropagation();
              current.value = clamp(current.initial + current.side * 2 * (timeAtClientX(e.clientX) - current.time));
              setDraft(current.value);
            }}
            onPointerUp={(e) => finish(e, true)}
            onPointerCancel={(e) => finish(e, false)}
            onLostPointerCapture={(e) => finish(e, false)}
            onKeyDown={(e) => {
              let next: number;
              if (e.key === "ArrowRight" || e.key === "ArrowUp") next = value + ((e.shiftKey ? 10 : 1) / fps);
              else if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = value - ((e.shiftKey ? 10 : 1) / fps);
              else if (e.key === "Home") next = minimum;
              else if (e.key === "End") next = boundedMaximum;
              else return;
              e.preventDefault();
              e.stopPropagation();
              next = clamp(next);
              if (next !== value) onDurationChange(next);
            }}
          >
            <span aria-hidden className="h-3.5 w-1 rounded-full border border-slate-900/60 bg-white/90 shadow-sm transition-colors group-hover:bg-sky-300" />
          </div>
        ))}
    </div>
  );
}
