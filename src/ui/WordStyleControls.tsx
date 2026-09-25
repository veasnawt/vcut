"use client";

import { useTranslation } from "../i18n/useTranslation.ts";
import type { TextStyle } from "../project/types.ts";
import { NumberField } from "./NumberField.tsx";

const MAX_WORD_COLORS = 4;
const DEFAULT_WORD_COLORS = ["#ff5f8f", "#ff9a3d"];
const DEFAULT_BADGE_COLOR = "#ffe066";

/** Inspector controls for designed-text-sticker lettering: a colour for each word (cycled), the lean and bounce of
 *  neighbouring words, and a bubble behind every other word. Each control writes straight into the text style
 *  (`onPatch`), so the preview updates live and the whole thing is one undoable edit per change — same as every
 *  other text control beside it. Turning a feature off removes its fields entirely, so an untouched style stays
 *  byte-identical to before this existed. */
export function WordStyleControls({ style, onPatch }: { style: TextStyle; onPatch: (patch: Partial<TextStyle>) => void }) {
  const t = useTranslation();
  const colors = style.wordColors ?? [];
  const badgeColors = style.wordBadgeColors ?? [];
  // The badge UI edits one colour that lands behind every SECOND word (the pattern of the reference lockups); a
  // preset can set richer patterns, which this shows as its first non-transparent colour.
  const badgeColor = badgeColors.find((c) => c && c !== "transparent");
  const hasBadge = Boolean(badgeColor);

  return (
    <div className="my-1 rounded-md border border-white/10 bg-white/[0.03] p-2">
      <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-white/40">{t("Word style")}</p>

      <div className="flex items-center justify-between gap-2 py-1.5">
        <span className="text-[12px] text-white/50">{t("Word colors")}</span>
        <div className="flex items-center gap-1">
          {colors.map((color, index) => (
            <input
              key={index}
              type="color"
              value={color}
              aria-label={t("Word color {n}", { n: index + 1 })}
              onChange={(e) => onPatch({ wordColors: colors.map((c, i) => (i === index ? e.target.value : c)) })}
              className="h-6 w-7 cursor-pointer rounded border border-white/10 bg-transparent"
            />
          ))}
          {colors.length < MAX_WORD_COLORS && (
            <button
              type="button"
              onClick={() => onPatch({ wordColors: colors.length === 0 ? [...DEFAULT_WORD_COLORS] : [...colors, colors[colors.length - 1]] })}
              aria-label={t("Add a word color")}
              title={t("Add a word color")}
              className="flex h-6 w-6 items-center justify-center rounded bg-white/10 text-[13px] text-white/70 transition hover:bg-white/20 hover:text-white"
            >
              +
            </button>
          )}
          {colors.length > 0 && (
            <button
              type="button"
              onClick={() => onPatch({ wordColors: colors.length > 1 ? colors.slice(0, -1) : undefined })}
              aria-label={t("Remove a word color")}
              title={t("Remove a word color")}
              className="flex h-6 w-6 items-center justify-center rounded bg-white/10 text-[13px] text-white/70 transition hover:bg-white/20 hover:text-white"
            >
              −
            </button>
          )}
        </div>
      </div>

      <NumberField
        label={t("Word tilt")}
        value={style.wordTiltDeg ?? 0}
        suffix="°"
        step={1}
        min={-30}
        max={30}
        onCommit={(v) => onPatch({ wordTiltDeg: v === 0 ? undefined : v })}
      />
      <NumberField
        label={t("Word bounce")}
        value={style.wordBounce ?? 0}
        suffix="px"
        step={1}
        min={-200}
        max={200}
        onCommit={(v) => onPatch({ wordBounce: v === 0 ? undefined : v })}
      />

      <label className="flex items-center justify-between gap-2 py-1.5 text-[12px] text-white/70">
        <span>{t("Word badge")}</span>
        <input
          type="checkbox"
          className="h-3.5 w-3.5 accent-sky-400"
          checked={hasBadge}
          onChange={(e) =>
            onPatch(
              e.target.checked
                ? { wordBadgeColors: ["transparent", DEFAULT_BADGE_COLOR], wordBadgeShape: style.wordBadgeShape ?? "pill" }
                : { wordBadgeColors: undefined, wordBadgeShape: undefined, wordBadgeOutline: undefined }
            )
          }
        />
      </label>
      {hasBadge && (
        <>
          <label className="flex items-center justify-between gap-2 py-1.5">
            <span className="text-[12px] text-white/50">{t("Badge color")}</span>
            <input
              type="color"
              value={badgeColor}
              onChange={(e) => onPatch({ wordBadgeColors: badgeColors.map((c) => (c && c !== "transparent" ? e.target.value : c)) })}
              className="h-7 w-11 cursor-pointer rounded border border-white/10 bg-transparent"
            />
          </label>
          <div className="flex items-center justify-between gap-2 py-1.5">
            <span className="text-[12px] text-white/50">{t("Badge shape")}</span>
            <div className="flex gap-1">
              {(["pill", "oval"] as const).map((shape) => (
                <button
                  key={shape}
                  type="button"
                  onClick={() => onPatch({ wordBadgeShape: shape })}
                  className={`rounded px-2 py-1 text-[11px] transition ${
                    (style.wordBadgeShape ?? "pill") === shape ? "bg-sky-500/30 text-white" : "bg-white/5 text-white/60 hover:bg-white/10 hover:text-white"
                  }`}
                >
                  {t(shape === "pill" ? "Pill" : "Oval")}
                </button>
              ))}
            </div>
          </div>
          <label className="flex items-center justify-between gap-2 py-1.5 text-[12px] text-white/70">
            <span>{t("Badge outline")}</span>
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-sky-400"
              checked={Boolean(style.wordBadgeOutline)}
              onChange={(e) => onPatch({ wordBadgeOutline: e.target.checked ? "#ffffff" : undefined })}
            />
          </label>
        </>
      )}
    </div>
  );
}
