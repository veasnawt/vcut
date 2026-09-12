"use client";

import { useState } from "react";
import { useTranslation } from "../i18n/useTranslation.ts";
import { AiGeneratePanel } from "./AiGeneratePanel.tsx";
import { MediaLibrary } from "./MediaLibrary.tsx";
import { StockSearchPanel } from "./StockSearchPanel.tsx";

type Mode = "library" | "stock" | "generate";

/** Thin tab wrapper over `MediaLibrary` (the project's own imported assets), `StockSearchPanel`
 *  (Pixabay search), and `AiGeneratePanel` (Replicate-backed image/video generation) — kept as a
 *  separate wrapper rather than merging the tab strip INTO any of them so none has to know the others
 *  exist: `MediaLibrary`'s own drag/touch/native-picker logic is already intricate enough that
 *  threading unrelated modes through it would be real risk for no benefit, and the other two stay
 *  plain, independent panels this way too. Owns the shared panel chrome (border/background) all three
 *  used to draw themselves, so switching modes never causes a visible flash of mismatched styling at
 *  the seam. */
export function MediaPanel({ onAssetAdded }: { onAssetAdded?: () => void } = {}) {
  const t = useTranslation();
  const [mode, setMode] = useState<Mode>("library");

  return (
    <section className="flex h-full min-h-0 flex-col border-r border-white/10 bg-[#0d0f14]">
      <div className="flex shrink-0 border-b border-white/10">
        {(
          [
            ["library", t("Media")],
            ["stock", t("Stock")],
            ["generate", t("AI")],
          ] as const
        ).map(([m, label]) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`flex-1 px-3 py-2 text-xs font-semibold uppercase tracking-wider transition ${
              mode === m ? "border-b-2 border-sky-400 text-white" : "border-b-2 border-transparent text-white/40 hover:text-white/70"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {/* All three stay mounted, toggled via `hidden` rather than conditionally rendered — an AI video
          job can run for minutes, and `AiGeneratePanel`'s own `watchAiVideo` SSE subscription would
          otherwise be torn down by its unmount the moment a user glanced at another tab mid-generation,
          silently orphaning a job that was still running server-side with no way left to learn how it
          finished. Keeping all three alive also means `StockSearchPanel`'s query and `AiGeneratePanel`'s
          own generation history survive a tab switch instead of resetting. */}
      <div className="min-h-0 flex-1">
        <div hidden={mode !== "library"} className="h-full min-h-0">
          <MediaLibrary onAssetAdded={onAssetAdded} />
        </div>
        <div hidden={mode !== "stock"} className="h-full min-h-0">
          <StockSearchPanel onAssetAdded={onAssetAdded} />
        </div>
        <div hidden={mode !== "generate"} className="h-full min-h-0">
          <AiGeneratePanel onAssetAdded={onAssetAdded} />
        </div>
      </div>
    </section>
  );
}
