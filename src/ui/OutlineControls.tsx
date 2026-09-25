"use client";

import { useTranslation } from "../i18n/useTranslation.ts";
import type { ClipOutline } from "../project/types.ts";
import { NumberField } from "./NumberField.tsx";

const PRESETS: { name: string; outline: ClipOutline }[] = [
  { name: "Red glow", outline: { color: "#ff2a2a", width: 4, glow: 24 } },
  { name: "White edge", outline: { color: "#ffffff", width: 6, glow: 0 } },
  { name: "Neon", outline: { color: "#ffffff", width: 3, glow: 30, glowColor: "#22d3ee" } },
  { name: "Gold", outline: { color: "#ffd166", width: 4, glow: 18, glowColor: "#ff9f1c" } },
  { name: "Pink", outline: { color: "#ff5fa2", width: 4, glow: 26 } },
  { name: "Shadow", outline: { color: "#000000", width: 5, glow: 14 } },
];

const SWATCHES = ["#ffffff", "#000000", "#ff2a2a", "#ff9f1c", "#ffd166", "#22d3ee", "#3b82f6", "#ff5fa2", "#a855f7", "#22c55e"];

/** How an outline will look, drawn in CSS on a stand-in shape — an approximation for choosing (the real result follows the
 *  clip's own outline), so a preset reads at a glance without applying it. */
function LookSwatch({ outline, size = 34 }: { outline: ClipOutline; size?: number }) {
  const glowColor = outline.glowColor ?? outline.color;
  const ring = Math.min(6, outline.width * 0.7);
  return (
    <span className="flex items-center justify-center rounded-md bg-black/70" style={{ width: size + 12, height: size + 12 }}>
      <span
        className="block rounded-full bg-[#5b6b8c]"
        style={{
          width: size * 0.55,
          height: size * 0.55,
          boxShadow: `0 0 0 ${ring}px ${outline.color}${outline.glow > 0 ? `, 0 0 ${Math.min(16, outline.glow * 0.6)}px ${Math.min(8, outline.glow * 0.3)}px ${glowColor}` : ""}`,
        }}
      />
    </span>
  );
}

/** Inspector controls for a clip's outline and glow: presets you can see before choosing them, colour swatches, thickness and
 *  glow sliders, and a glow colour that follows the outline unless you choose otherwise. Every change is one undoable edit
 *  (`onChange`); `null` removes the effect. */
export function OutlineControls({ outline, onChange }: { outline: ClipOutline | undefined; onChange: (outline: ClipOutline | null) => void }) {
  const t = useTranslation();
  const sameGlowColor = outline ? outline.glowColor === undefined : true;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-1.5">
        {PRESETS.map((preset) => {
          const active = outline !== undefined && outline.color === preset.outline.color && outline.width === preset.outline.width && outline.glow === preset.outline.glow;
          return (
            <button
              key={preset.name}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(preset.outline)}
              className={`flex flex-col items-center gap-1 rounded-lg border p-1.5 transition ${active ? "border-sky-400/50 bg-sky-500/10" : "border-white/10 hover:bg-white/5"}`}
            >
              <LookSwatch outline={preset.outline} />
              <span className="text-[10px] text-white/65">{t(preset.name)}</span>
            </button>
          );
        })}
      </div>

      {outline && (
        <>
          <div>
            <p className="mb-1.5 text-[11px] text-white/45">{t("Outline color")}</p>
            <div className="flex flex-wrap items-center gap-1.5">
              {SWATCHES.map((color) => (
                <button
                  key={color}
                  type="button"
                  aria-label={color}
                  aria-pressed={outline.color === color}
                  onClick={() => onChange({ ...outline, color })}
                  className={`h-6 w-6 rounded-full border transition ${outline.color === color ? "border-white ring-2 ring-sky-400/70" : "border-white/20"}`}
                  style={{ backgroundColor: color }}
                />
              ))}
              <label className="relative flex h-6 w-6 cursor-pointer items-center justify-center overflow-hidden rounded-full border border-dashed border-white/40 text-[13px] text-white/60" title={t("Custom color")}>
                +
                <input
                  type="color"
                  value={outline.color}
                  onChange={(e) => onChange({ ...outline, color: e.target.value })}
                  className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                />
              </label>
            </div>
          </div>

          <div>
            <NumberField label={t("Thickness")} value={outline.width} suffix="px" step={1} min={0} max={24} onCommit={(v) => onChange({ ...outline, width: v })} />
            <NumberField label={t("Glow")} value={outline.glow} suffix="px" step={2} min={0} max={60} onCommit={(v) => onChange({ ...outline, glow: v })} />
          </div>

          <div className="flex items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-[12px] text-white/70">
              <input
                type="checkbox"
                className="h-4 w-4 accent-sky-400"
                checked={sameGlowColor}
                onChange={(e) => {
                  const { glowColor: _unused, ...rest } = outline;
                  void _unused;
                  onChange(e.target.checked ? rest : { ...outline, glowColor: outline.color });
                }}
              />
              {t("Glow matches outline")}
            </label>
            {!sameGlowColor && (
              <input
                type="color"
                value={outline.glowColor ?? outline.color}
                onChange={(e) => onChange({ ...outline, glowColor: e.target.value })}
                aria-label={t("Glow color")}
                className="h-7 w-11 cursor-pointer rounded border border-white/10 bg-transparent"
              />
            )}
          </div>

          <p className="text-[11px] leading-relaxed text-white/35">{t("The outline follows the clip's visible shape — best on a cutout subject or a sticker with a transparent background.")}</p>

          <button
            type="button"
            onClick={() => onChange(null)}
            className="w-full rounded-md bg-white/5 py-1.5 text-[12px] text-white/60 transition hover:bg-white/10 hover:text-white"
          >
            {t("Remove outline")}
          </button>
        </>
      )}
    </div>
  );
}
