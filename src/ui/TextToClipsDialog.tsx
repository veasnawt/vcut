"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import type { TextStylePreset } from "../project/textStylePresets.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { NumberField } from "./NumberField.tsx";
import { TextStylePresetGrid } from "./TextStylePresetGrid.tsx";
import { useVisualViewportHeight } from "./useVisualViewportHeight.ts";

const DEFAULT_SECONDS_PER_LINE = 3;

/** Turns a pasted block of text — a script, lyrics, a caption list — into a run of text clips, one
 *  per non-empty line, placed back-to-back starting at the playhead. A purely client-side sibling to
 *  Auto Captions: same DESTINATION (`landCaptions` → `AddCaptionsCommand`, one new "Captions" text
 *  track, one undo-able step), but no audio, no transcription job, no server round-trip at all — the
 *  "timing" here is just `secondsPerLine * lineIndex`, computed locally the instant Generate is
 *  clicked, so this dialog needs none of Auto Captions' job/SSE/credentials machinery. */
export function TextToClipsDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslation();
  const landCaptions = useEditorStore((s) => s.landCaptions);
  const viewportHeight = useVisualViewportHeight();
  const [text, setText] = useState("");
  const [secondsPerLine, setSecondsPerLine] = useState(DEFAULT_SECONDS_PER_LINE);
  const [preset, setPreset] = useState<TextStylePreset | null>(null);

  // Blank lines are just formatting/spacing in a pasted script — they don't become empty clips (an
  // empty text clip has nothing to show and nothing meaningful to select/edit later).
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  function generate() {
    if (lines.length === 0) return;
    const playhead = useEditorStore.getState().playhead;
    const segments = lines.map((content, i) => ({
      content,
      start: playhead + i * secondsPerLine,
      end: playhead + (i + 1) * secondsPerLine,
    }));
    landCaptions(segments, preset ?? undefined);
    onClose();
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t("Import Text as Clips")}
    >
      {/* `flex flex-col` on the card, with the title fixed at top, the footer buttons fixed at
          bottom, and everything in between (description/textarea/options/Style grid) in its own
          `overflow-y-auto` middle section — on a short phone this content alone (an 8-row textarea
          plus a full style grid) can run taller than the viewport, and without a scrollable region
          ANYWHERE, the Cancel/Generate buttons below the fold were simply unreachable. Height capped
          against `useVisualViewportHeight` rather than a `max-h-[90vh]` class: the textarea's own
          `autoFocus` opens the on-screen keyboard the instant this dialog mounts, and a `vh`-based
          height keeps assuming the FULL, un-shrunk layout viewport is available regardless — content
          below the fold (the Style grid, the footer buttons) would sit behind the keyboard rather
          than merely need a scroll. */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ maxHeight: Math.max(240, viewportHeight - 32) }}
        className="flex w-full max-w-md flex-col rounded-xl border border-white/10 bg-[#12151c] p-5 shadow-2xl"
      >
        <h2 className="shrink-0 text-sm font-semibold text-white">{t("Import Text as Clips")}</h2>
        {/* `scrollbar-none` (see globals.css) — a visible OS scrollbar here would be the only one in a
            modal this size; swiping to reveal more is already obvious without it. `px-1`/`-mx-1`: the
            textarea's own `focus:ring-1` and a selected preset's `ring-1` both sit 1px OUTSIDE their
            element's box via `box-shadow`, and setting `overflow-y` to anything but `visible` forces
            `overflow-x` to compute as `auto` too (the CSS Overflow spec's own interaction rule) — with
            zero horizontal padding to spare, that silently clipped the ring right off the left/right
            edges. The `-mx-1` cancels the padding's own width impact so children stay visually flush
            with the title above. */}
        <div className="-mx-1 min-h-0 flex-1 overflow-y-auto scrollbar-none px-1">
          <p className="mt-2 text-xs leading-relaxed text-white/60">
            {t("Paste a script, lyrics, or a caption list — each line becomes its own text clip, placed back-to-back starting at the playhead.")}
          </p>

          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={8}
            autoFocus
            placeholder={t("One line per clip…")}
            // 16px below `lg`: same iOS Safari auto-zoom-on-focus reasoning every other text input in
            // this app already follows (see MediaLibrary's search box for the original instance).
            className="mt-3 w-full resize-none rounded bg-white/5 px-2.5 py-2 text-[16px] text-white placeholder:text-white/30 focus:outline-none focus:ring-1 focus:ring-sky-400/60 lg:text-[13px]"
          />

          <div className="mt-1 flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <NumberField
                label={t("Seconds per line")}
                value={secondsPerLine}
                suffix="s"
                step={0.5}
                min={0.5}
                max={10}
                onCommit={(v) => setSecondsPerLine(v)}
              />
            </div>
            <span className="shrink-0 text-[11px] text-white/35">{t("{n} clips", { n: lines.length })}</span>
          </div>

          {/* Chosen up front rather than after — these clips land as a batch, and restyling each one
              individually afterward is exactly the tedium a pre-picked look here avoids. No hover-preview
              (unlike Inspector's own version of this grid): no clip exists yet to preview onto. */}
          <div className="mt-3">
            <p className="mb-1.5 text-[11px] text-white/35">{t("Style")}</p>
            <button
              onClick={() => setPreset(null)}
              className={`mb-1.5 w-full rounded bg-white/5 py-1.5 text-[12px] text-white/70 transition hover:bg-white/10 hover:text-white ${
                preset === null ? "ring-1 ring-sky-400/60" : ""
              }`}
            >
              {t("Default")}
            </button>
            <TextStylePresetGrid selectedId={preset?.id} onPick={setPreset} />
          </div>
        </div>

        <div className="mt-4 flex shrink-0 items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-xs font-medium text-white/60 transition hover:bg-white/10 hover:text-white"
          >
            {t("Cancel")}
          </button>
          <button
            onClick={generate}
            disabled={lines.length === 0}
            className="rounded-md bg-sky-500 px-4 py-1.5 text-xs font-semibold text-white transition hover:bg-sky-400 disabled:opacity-50"
          >
            {t("Generate Clips")}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
