"use client";

import { TEXT_STYLE_PRESETS, type TextStylePreset } from "../project/textStylePresets.ts";
import { useTranslation } from "../i18n/useTranslation.ts";

/** The quick-apply "look" tile grid — shared by Inspector's single-clip and multi-select Styles
 *  sections, the toolbar's Text-tool style picker, and the Script/Captions creation dialogs. Each
 *  tile renders its own look directly via inline style (color/bold/background/outline/shadow), the
 *  same sample glyph regardless of which preset — comparing several at a glance is the entire point,
 *  so every tile needs the identical baseline to differ from. `onPreview`/`onPreviewEnd` are optional:
 *  Inspector's single-clip section uses them to live-preview a hover on the actual selected clip;
 *  creation-time callers (no clip exists yet to preview onto) omit them and rely on `selectedId`
 *  instead to show which preset is currently chosen. */
export function TextStylePresetGrid({
  selectedId,
  onPick,
  onPreview,
  onPreviewEnd,
}: {
  selectedId?: string;
  onPick: (preset: TextStylePreset) => void;
  onPreview?: (preset: TextStylePreset) => void;
  onPreviewEnd?: () => void;
}) {
  const t = useTranslation();
  return (
    <div className="grid grid-cols-3 gap-1.5">
      {TEXT_STYLE_PRESETS.map((preset) => (
        <button
          key={preset.id}
          onClick={() => onPick(preset)}
          onMouseEnter={() => onPreview?.(preset)}
          onMouseLeave={onPreviewEnd}
          className={`flex flex-col items-center gap-1 rounded p-1 transition hover:bg-white/10 ${
            selectedId === preset.id ? "bg-sky-500/20" : ""
          }`}
        >
          <span
            className="flex h-[42px] w-full items-center justify-center overflow-hidden rounded border border-white/10 bg-black/40 text-[15px]"
            style={{
              color: preset.color,
              fontWeight: preset.bold ? 700 : 400,
              backgroundColor: preset.backgroundColor ?? undefined,
              WebkitTextStroke: preset.strokeColor ? `1px ${preset.strokeColor}` : undefined,
              textShadow: preset.shadowColor
                ? `${preset.shadowOffsetX ?? 2}px ${preset.shadowOffsetY ?? 2}px 0 ${preset.shadowColor}`
                : undefined,
            }}
          >
            Ag
          </span>
          <span className="truncate text-[10px] text-white/60">{t(preset.label)}</span>
        </button>
      ))}
    </div>
  );
}
