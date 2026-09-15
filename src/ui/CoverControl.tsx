"use client";

import React, { useEffect, useRef, useState } from "react";
import { Edit, Image as ImageIcon } from "@veasnawt/vicons";
import { SetExportCoverCommand } from "../commands/index.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { formatTimecode } from "../timeline/time.ts";

/** The track-header/toolbar control for picking the exported file's attached cover image (see
 *  `ExportSettings.cover`'s own doc comment) — moved out of `ExportDialog.tsx`, which used to only
 *  offer a "snapshot the current playhead" checkbox local to that dialog. A cover is now a project-
 *  wide, PERSISTED choice, settable any time the timeline is open rather than only at export time —
 *  so this reads/writes `project.exportSettings.cover` directly via `SetExportCoverCommand`, the same
 *  way any other undoable project edit does.
 *
 *  Two ways to set one, picked from this button's own menu:
 *  - "Use a frame from timeline": arms `{ kind: "frame", time: playhead }` as a starting point, which
 *    `Timeline.tsx`'s own draggable ruler marker (driven by this exact same `cover` field) then lets
 *    you drag anywhere across the WHOLE timeline to refine — see that file's `scrubCoverFrame`.
 *  - "Upload an image": imports a separate still image via the ordinary `importFiles` pipeline with
 *    `hiddenFromLibrary: true` (the same treatment a voiceover recording gets — a real project asset,
 *    just not one that clutters the Media Library), then sets `{ kind: "image", assetId }`.
 *
 *  Deliberately compact: this has to fit inside `Timeline.tsx`'s corner cell (156×26px, its own
 *  `HEADER_WIDTH`×`RULER_HEIGHT`) on desktop, or the toolbar's already-crowded zoom-control cluster on
 *  mobile — `compact` drops the text label, leaving just the icon, for the tighter mobile spot. */
export function CoverControl({ compact }: { compact?: boolean }) {
  const t = useTranslation();
  const run = useEditorStore((s) => s.run);
  const project = useEditorStore((s) => s.project);
  const playhead = useEditorStore((s) => s.playhead);
  const importFiles = useEditorStore((s) => s.importFiles);
  const importing = useEditorStore((s) => s.importing);

  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const cover = project?.exportSettings.cover ?? null;

  // Same "outside pointerdown or Escape closes it" contract `Dropdown.tsx` already establishes for
  // every other hand-rolled popup in this app.
  useEffect(() => {
    if (!menuOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  const Icon = cover?.kind === "image" ? ImageIcon : Edit;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setMenuOpen((o) => !o)}
        title={t("Cover")}
        aria-label={t("Cover")}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        className={`flex min-h-[26px] items-center justify-center gap-1 rounded px-1.5 text-[11px] font-semibold transition ${
          cover
            ? "bg-rose-500/20 text-rose-300 hover:bg-rose-500/30"
            : "text-white/45 hover:bg-white/10 hover:text-white/80"
        }`}
      >
        <Icon size={13} />
        {!compact && <span>{t("Cover")}</span>}
      </button>

      {menuOpen && (
        <div
          role="menu"
          className="absolute left-0 top-full z-50 mt-1 w-52 overflow-hidden rounded-md border border-white/10 bg-[#14161c] py-1 text-left shadow-xl"
        >
          <div className="px-2.5 py-1.5 text-[10px] uppercase tracking-wide text-white/35">
            {t("Exported file's cover")}
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              run(new SetExportCoverCommand({ kind: "frame", time: playhead }));
              setMenuOpen(false);
            }}
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-xs text-white/80 transition hover:bg-white/10"
          >
            <Edit size={13} />
            <span className="flex-1">
              {cover?.kind === "frame" ? t("Frame at {time}", { time: formatTimecode(cover.time, project?.sequence.fps ?? 30) }) : t("Use a frame from timeline")}
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={importing}
            onClick={() => fileInputRef.current?.click()}
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-xs text-white/80 transition hover:bg-white/10 disabled:opacity-40"
          >
            <ImageIcon size={13} />
            <span className="flex-1">{cover?.kind === "image" ? t("Change uploaded image") : t("Upload an image")}</span>
          </button>
          {cover && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                run(new SetExportCoverCommand(null));
                setMenuOpen(false);
              }}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-xs text-rose-300/90 transition hover:bg-rose-500/10"
            >
              {t("Remove cover")}
            </button>
          )}
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0] ?? null;
          e.target.value = "";
          setMenuOpen(false);
          if (!file) return;
          void importFiles([file], { hiddenFromLibrary: true }).then((assets) => {
            const asset = assets[0];
            if (asset) run(new SetExportCoverCommand({ kind: "image", assetId: asset.id }));
          });
        }}
      />
    </div>
  );
}
