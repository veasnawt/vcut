"use client";

import { buildCanvasFilterString } from "../playback/PlaybackEngine.ts";
import { EFFECT_PRESETS } from "../project/effectPresets.ts";
import type { ClipEffects } from "../project/types.ts";
import { IDENTITY_EFFECTS } from "../project/types.ts";
import { useTranslation } from "../i18n/useTranslation.ts";

/** The preset-swatch grid shared by the Inspector's own Effects section and the toolbar's Effects
 *  button popover (`EffectsPickerMenu.tsx`) — one place this UI is written so the two stay identical
 *  rather than drifting into two almost-the-same grids.
 *
 *  Each swatch previews its preset directly on top of the SELECTED CLIP's own thumbnail (via CSS
 *  `filter`, the exact same `buildCanvasFilterString` the real preview canvas uses) instead of a
 *  generic gradient — "what does Vivid look like" is a much more useful question answered against this
 *  footage than against an abstract color wheel. Falls back to the neutral gradient only when there's
 *  genuinely no thumbnail to show (a color-matte clip, or a video whose thumbnail hasn't generated
 *  yet) — a blank/broken-image swatch would read as an error, not as "no preview available". */
/** Whether applying `preset` is what CURRENTLY produced `current` — full-object equality against what
 *  `onPick(preset.values)` would itself produce (`{ ...IDENTITY_EFFECTS, ...preset.values }`), not just
 *  a check of the fields the preset happens to set. A preset represents a WHOLE look, the same way
 *  "Reset filters" resets the whole object rather than clearing individual fields — so a clip that
 *  matches a preset on every field it sets but has since had an UNRELATED field hand-tweaked (e.g. a
 *  slider dragged in the Inspector after picking a preset) no longer counts as "still this preset",
 *  the same way it wouldn't visually still look like it either. */
function matchesPreset(current: ClipEffects, preset: Partial<ClipEffects>): boolean {
  const resolved = { ...IDENTITY_EFFECTS, ...preset };
  return (
    current.brightness === resolved.brightness &&
    current.contrast === resolved.contrast &&
    current.saturation === resolved.saturation &&
    current.blur === resolved.blur &&
    current.opacity === resolved.opacity
  );
}

/** How much of a preset's blur (sequence pixels) a swatch tile shows. A tile is ~50-60px wide while the
 *  sequence it represents is ~1080px, so drawing the raw blur value on it (what this did) blurred the
 *  swatch ~20x harder, relative to its size, than applying the preset blurs the real frame — Soft Focus
 *  looked heavily blurred in the grid and then barely changed anything once applied. Scaled to the tile
 *  instead so what the swatch shows is what you get. */
const SWATCH_BLUR_SCALE = 0.06;

export function EffectPresetGrid({
  thumbnailUrl,
  currentEffects,
  onPick,
  onPreview,
  onClearPreview,
  swatchHeight = 28,
}: {
  thumbnailUrl: string | null;
  /** The clip's own current (resolved) effects, absent meaning untouched/identity — same convention
   *  `Clip.effects` itself uses. Compared against each preset via `matchesPreset` to decide which tile
   *  (if any) gets the active highlight; a real, reported gap before this existed at all — the grid
   *  never showed which preset, if any, was currently applied. */
  currentEffects: ClipEffects | undefined;
  onPick: (values: Partial<ClipEffects>) => void;
  onPreview: (values: Partial<ClipEffects>) => void;
  onClearPreview: () => void;
  /** Inspector's own narrow sidebar and the toolbar's wider popover both use this grid at different
   *  natural widths — a taller swatch reads as a genuinely useful thumbnail-preview in the popover,
   *  while the Inspector's default stays exactly what it already was (no visual change there). */
  swatchHeight?: number;
}) {
  const t = useTranslation();
  const resolvedCurrent = currentEffects ?? IDENTITY_EFFECTS;
  return (
    <div className="grid grid-cols-4 gap-1.5">
      {EFFECT_PRESETS.map((preset) => {
        const active = matchesPreset(resolvedCurrent, preset.values);
        return (
          <button
            key={preset.id}
            onClick={() => onPick(preset.values)}
            onMouseEnter={() => onPreview(preset.values)}
            onMouseLeave={onClearPreview}
            aria-pressed={active}
            className={`flex flex-col items-center gap-1 rounded p-1 transition hover:bg-white/10 ${active ? "bg-sky-500/20" : ""}`}
          >
            <span
              aria-hidden
              style={{
                height: swatchHeight,
                background: thumbnailUrl ? `center / cover no-repeat url(${thumbnailUrl})` : "linear-gradient(135deg, #f59e0b, #6366f1, #10b981)",
                filter: buildCanvasFilterString({ ...IDENTITY_EFFECTS, ...preset.values }, SWATCH_BLUR_SCALE),
              }}
              className={`w-full rounded border ${active ? "border-sky-400" : "border-white/10"}`}
            />
            <span className={`text-[10px] ${active ? "text-white" : "text-white/60"}`}>{t(preset.label)}</span>
          </button>
        );
      })}
    </div>
  );
}
