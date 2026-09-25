"use client";

import { DEFAULT_FONT_ID, FONT_REGISTRY, type FontDefinition } from "../project/fonts.ts";

/** Shared by both Auto Captions entry points (`AutoCaptionsDialog.tsx`, `Inspector.tsx`'s own
 *  `AutoCaptionsSection`) rather than duplicated — unlike most small pieces those two intentionally
 *  keep as separate copies (see their own comments), this one is real logic, not just UI, so drift
 *  between two copies would be a genuine correctness risk, not just a cosmetic inconsistency.
 *
 *  Khmer defaults to Koulen (a display face that actually reads well at caption size) rather than
 *  `DEFAULT_FONT_ID` (Lato — no Khmer glyphs at all, previously landing every Khmer caption in
 *  whatever fallback glyphs the renderer's browser harness happened to substitute, never a real,
 *  deliberate choice). Every other language keeps the existing global default. */
export function defaultFontIdFor(language: string): string {
  return language === "km" ? "koulen" : DEFAULT_FONT_ID;
}

/** Bundled Khmer-script faces are flagged with `FontDefinition.khmer` (their labels no longer carry a "(Khmer)"
 *  tag). Custom uploaded fonts have no such flag, so this name check stays as their fallback: it takes a bare
 *  string so `FontGridPicker.tsx`'s custom-font entries can reuse it against their own `name`. */
export function isKhmerFontLabel(label: string): boolean {
  return label.includes("Khmer");
}

function isKhmerFont(font: FontDefinition): boolean {
  return font.khmer === true || isKhmerFontLabel(font.label);
}

const KHMER_SAMPLE = "អក្សរខ្មែរ";
const LATIN_SAMPLE = "Ag";

/** Which sample text a tile should preview a font with, by label/name — shared with
 *  `FontGridPicker.tsx` so the two font grids in this app never pick DIFFERENT sample text for the
 *  same font. */
export function sampleTextFor(label: string, khmer?: boolean): string {
  return khmer || isKhmerFontLabel(label) ? KHMER_SAMPLE : LATIN_SAMPLE;
}

/** Font tile grid for Auto Captions' Font tab — same selectable-tile pattern as `TextStylePresetGrid`/
 *  `TextAnimationPickerGrid`, but each tile previews the font DIRECTLY (a real `@font-face`, no static
 *  thumbnail image) via `style={{ fontFamily: font.cssFamily }}` — the exact family already registered
 *  in globals.css for real clip rendering, so the preview and the actual generated caption can never
 *  drift apart the way a pre-rendered thumbnail could. `khmerOnly` filters to Khmer-script faces (Auto
 *  Captions' Khmer path always passes `true`) or away from them (every other language passes `false`) —
 *  a Latin-only face has no Khmer glyphs to render at all, and vice versa, so showing the other bucket
 *  would just be a grid full of choices that render as tofu/fallback for whatever's actually selected.
 *  Omit `khmerOnly` for Script, where the pasted text itself may mix scripts and the user needs the
 *  complete bundled font library. */
export function FontPickerGrid({
  khmerOnly,
  selectedId,
  onPick,
}: {
  khmerOnly?: boolean;
  selectedId: string;
  onPick: (fontId: string) => void;
}) {
  const fonts = khmerOnly === undefined ? FONT_REGISTRY : FONT_REGISTRY.filter((f) => isKhmerFont(f) === khmerOnly);
  return (
    <div className="grid grid-cols-3 gap-1.5">
      {fonts.map((font) => (
        <button
          key={font.id}
          onClick={() => onPick(font.id)}
          className={`flex min-w-0 flex-col items-center gap-1 rounded p-1 transition hover:bg-white/10 ${
            selectedId === font.id ? "bg-sky-500/20" : ""
          }`}
        >
          <span
            className="flex h-[42px] w-full items-center justify-center overflow-hidden rounded border border-white/10 bg-black/40 px-1 text-[15px] text-white"
            style={{ fontFamily: font.cssFamily }}
          >
            {sampleTextFor(font.label, font.khmer)}
          </span>
          <span className="truncate text-[10px] text-white/60">{font.label}</span>
        </button>
      ))}
    </div>
  );
}
