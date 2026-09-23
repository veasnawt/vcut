"use client";

/** The overlapping-frames mark used at timeline cut junctions and every Transition entry point. */
export function TransitionGlyph({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 14 14" width={size} height={size} className={className} fill="none">
      <rect x="1" y="2" width="7" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.2" fill="currentColor" fillOpacity="0.25" />
      <rect x="6" y="4" width="7" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.2" fill="currentColor" fillOpacity="0.6" />
    </svg>
  );
}
