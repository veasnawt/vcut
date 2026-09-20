"use client";

import React, { useRef, useState } from "react";

/** A junction control spans both neighbors. The centered strip represents the blend duration;
 *  it does not move either clip's cut or change the export's source-handle timing. */
export function TransitionJunction({
  cut,
  duration,
  maxDuration,
  pixelsPerSecond,
  fps,
  mobile,
  locked,
  label,
  durationLabel,
  onOpen,
  onDurationChange,
}: {
  cut: number;
  duration: number | null;
  maxDuration: number;
  pixelsPerSecond: number;
  fps: number;
  mobile: boolean;
  locked: boolean;
  label: string;
  durationLabel: string;
  onOpen: (rect: DOMRect) => void;
  onDurationChange: (duration: number) => void;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const drag = useRef<{ x: number; initial: number; value: number; side: number; pointer: number } | null>(null);
  const minimum = Math.min(1 / fps, maxDuration);
  const clamp = (value: number) => Math.min(maxDuration, Math.max(minimum, Math.round(value * fps) / fps));
  const value = Math.min(draft ?? duration ?? 0, maxDuration);
  const active = duration !== null;
  const width = active ? Math.max(28, value * pixelsPerSecond) : 28;
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
        left: cut - width / 2,
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
                  <svg viewBox="0 0 14 14" className="h-3 w-3 shrink-0 text-sky-300" fill="none">
                    <rect x="1" y="2" width="7" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.2" fill="currentColor" fillOpacity="0.25" />
                    <rect x="6" y="4" width="7" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.2" fill="currentColor" fillOpacity="0.6" />
                  </svg>
                  <span className="text-[10px] font-semibold leading-none tabular-nums text-white/95">{value.toFixed(1)}s</span>
                </div>
              ) : (
                <div className="flex h-5 w-5 items-center justify-center rounded-full border border-sky-400/40 bg-slate-950/90 shadow-sm">
                  <svg viewBox="0 0 14 14" className="h-2.5 w-2.5 shrink-0 text-sky-300" fill="none">
                    <rect x="1" y="2" width="7" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.2" fill="currentColor" fillOpacity="0.25" />
                    <rect x="6" y="4" width="7" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.2" fill="currentColor" fillOpacity="0.6" />
                  </svg>
                </div>
              )}
            </div>
          </>
        ) : (
          /* Inactive cut point button */
          <svg aria-hidden viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M4 4v12M16 4v12M7 10h6M10 7v6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
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
            aria-valuemax={maxDuration}
            aria-valuenow={value}
            aria-valuetext={`${value.toFixed(2)}s`}
            data-transition-handle={side < 0 ? "left" : "right"}
            className="group absolute top-0 flex h-full touch-none cursor-ew-resize items-center justify-center rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-300"
            style={{ width: mobile ? 22 : 12, [side < 0 ? "left" : "right"]: mobile ? -11 : -6 }}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              e.stopPropagation();
              drag.current = { x: e.clientX, initial: value, value, side, pointer: e.pointerId };
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              const current = drag.current;
              if (!current || current.pointer !== e.pointerId) return;
              e.stopPropagation();
              current.value = clamp(current.initial + ((current.side * 2 * (e.clientX - current.x)) / pixelsPerSecond));
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
              else if (e.key === "End") next = maxDuration;
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
