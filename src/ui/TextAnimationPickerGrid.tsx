"use client";

import { Close } from "@veasnawt/vicons";
import type { Clip } from "../project/types.ts";
import { TEXT_ANIMATION_TYPE_LABEL, TEXT_ANIMATION_TYPE_OPTIONS } from "../timeline/textAnimation.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import { TextAnimationPreviewTile } from "./TextAnimationPreviewTile.tsx";

/** The None + 5-tile animation-type grid — shared by Inspector's single-clip Animation section, its
 *  multi-select counterpart, and the toolbar's promoted Animation tool. Scoped to TYPE only: `speed`/
 *  `highlightColor` fine-tuning stays Inspector-only, single-clip — bulk-applying a whole selection
 *  to a specific speed doesn't have the same obvious "one right answer" a type choice does, so it's
 *  left out of what this shared grid covers rather than guessed at. `current` picks which tile (if
 *  any) reads as active; pass `undefined` when the answer would be ambiguous (e.g. a multi-select
 *  whose clips don't all share one animation) so nothing is highlighted rather than showing a
 *  misleading one. */
export function TextAnimationPickerGrid({
  current,
  onPick,
}: {
  current: Clip["textAnimation"] | null | undefined;
  onPick: (next: Clip["textAnimation"] | null) => void;
}) {
  const t = useTranslation();
  return (
    <div className="grid grid-cols-3 gap-1.5">
      <button
        onClick={() => onPick(null)}
        className={`flex flex-col items-center gap-1 rounded p-1 transition hover:bg-white/10 ${!current ? "bg-sky-500/20" : ""}`}
      >
        <div className="flex items-center justify-center rounded border border-white/10 bg-black/40 text-white/30" style={{ width: 84, height: 48 }}>
          <Close size={14} />
        </div>
        <span className="text-[10px] text-white/70">{t("None")}</span>
      </button>
      {TEXT_ANIMATION_TYPE_OPTIONS.map((type) => (
        <button
          key={type}
          onClick={() =>
            // Switching TYPE keeps whatever `speed`/`highlightColor` was already set on `current` —
            // same reasoning as Inspector's original single-clip version of this grid.
            onPick({
              type,
              ...(current?.highlightColor ? { highlightColor: current.highlightColor } : null),
              ...(current?.speed ? { speed: current.speed } : null),
            })
          }
          className={`flex flex-col items-center gap-1 rounded p-1 transition hover:bg-white/10 ${
            current?.type === type ? "bg-sky-500/20" : ""
          }`}
        >
          <TextAnimationPreviewTile type={type} />
          <span className="text-[10px] text-white/70">{t(TEXT_ANIMATION_TYPE_LABEL[type])}</span>
        </button>
      ))}
    </div>
  );
}
