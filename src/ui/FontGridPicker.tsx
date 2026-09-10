"use client";

import { useMemo, useState } from "react";
import type { CustomFontAsset } from "../project/types.ts";
import { FONT_REGISTRY } from "../project/fonts.ts";
import { sampleTextFor } from "./FontPickerGrid.tsx";

interface FontGridEntry {
  id: string;
  label: string;
  cssFamily: string;
}

/** General-purpose font grid+search picker for the Inspector's Properties panel (both the single-clip
 *  Text section and the multi-select batch one) — replaced the old searchable `Dropdown`-based font
 *  picker, which rendered each match as one row of plain text set in its own font. A grid of real tiles
 *  previews the font MUCH more legibly at a glance (comparing several side by side, the same reason
 *  Auto Captions' `FontPickerGrid` exists) — search stayed exactly because a 30+ bundled entry list (or
 *  more, with a project's own custom fonts on top) is still too long to just scroll through blind.
 *
 *  Unlike `FontPickerGrid` (Auto Captions' Khmer-only-or-not split), this shows EVERY font — bundled
 *  AND the project's own uploaded ones — since Properties has no "current language" to filter by; a
 *  user picking a font for hand-typed text could mean any script. Each tile still uses `sampleTextFor`
 *  (shared with `FontPickerGrid`) to preview Khmer-script faces with real Khmer sample text rather than
 *  a meaningless "Ag", exactly the same as that grid. */
export function FontGridPicker({
  customFonts,
  selectedId,
  onPick,
  onHover,
  searchPlaceholder,
}: {
  customFonts: CustomFontAsset[];
  selectedId: string;
  onPick: (fontId: string) => void;
  /** Mirrors the old `Dropdown`'s own `onHoverOption` — fired with an id on hover, `null` on
   *  mouse-leave/unmount, so a caller (the single-clip Properties panel) can live-preview a font on the
   *  real canvas before it's actually committed. Omitted by the multi-select caller, which has no
   *  single clip to preview onto. */
  onHover?: (fontId: string | null) => void;
  searchPlaceholder?: string;
}) {
  const [query, setQuery] = useState("");
  // Custom fonts FIRST — same "just imported it, almost certainly want it" precedent the old dropdown's
  // own option-ordering already established (see that code's own removed comment), preserved here.
  const entries = useMemo<FontGridEntry[]>(
    () => [
      ...customFonts.map((f) => ({ id: f.id, label: f.name, cssFamily: f.cssFamily })),
      ...FONT_REGISTRY.map((f) => ({ id: f.id, label: f.label, cssFamily: f.cssFamily })),
    ],
    [customFonts]
  );
  const trimmed = query.trim().toLowerCase();
  const visible = trimmed ? entries.filter((f) => f.label.toLowerCase().includes(trimmed)) : entries;

  return (
    <div>
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={searchPlaceholder}
        className="mb-1.5 w-full rounded-md bg-white/5 px-2.5 py-1.5 text-[12px] text-white placeholder:text-white/30 focus:outline-none focus:ring-1 focus:ring-sky-400/60"
      />
      <div className="grid max-h-52 grid-cols-3 gap-1.5 overflow-y-auto scrollbar-none pr-0.5">
        {visible.length === 0 && <p className="col-span-3 py-2 text-center text-[11px] text-white/40">No matches</p>}
        {visible.map((font) => (
          <button
            key={font.id}
            onClick={() => onPick(font.id)}
            onMouseEnter={() => onHover?.(font.id)}
            onMouseLeave={() => onHover?.(null)}
            className={`flex min-w-0 flex-col items-center gap-1 rounded p-1 transition hover:bg-white/10 ${
              selectedId === font.id ? "bg-sky-500/20" : ""
            }`}
          >
            <span
              className="flex h-[42px] w-full items-center justify-center overflow-hidden rounded border border-white/10 bg-black/40 px-1 text-[15px] text-white"
              style={{ fontFamily: `"${font.cssFamily}"` }}
            >
              {sampleTextFor(font.label)}
            </span>
            <span className="truncate text-[10px] text-white/60">{font.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
