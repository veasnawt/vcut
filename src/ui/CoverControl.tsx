"use client";

import { useState } from "react";
import { Edit, Image as ImageIcon } from "@veasnawt/vicons";
import { useTranslation } from "../i18n/useTranslation.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { CoverPickerDialog } from "./CoverPickerDialog.tsx";

/** The track-header/toolbar trigger for the exported file's attached cover image (see
 *  `ExportSettings.cover`'s own doc comment) — moved out of `ExportDialog.tsx`, which used to only
 *  offer a "snapshot the current playhead" checkbox local to that dialog. Just a button: the actual
 *  picking UI is `CoverPickerDialog.tsx`, a full-screen modal (a real, provided CapCut-style reference
 *  screenshot) with a big live preview, a "Select from video" / "Select from album" tab switch, and a
 *  swipeable whole-timeline filmstrip — this component only owns the icon/label reflecting whatever's
 *  currently saved (`project.exportSettings.cover`) and opens/closes that dialog. */
export function CoverControl({ compact }: { compact?: boolean }) {
  const t = useTranslation();
  const project = useEditorStore((s) => s.project);
  const [open, setOpen] = useState(false);
  const cover = project?.exportSettings.cover ?? null;
  const Icon = cover?.kind === "image" ? ImageIcon : Edit;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={t("Cover")}
        aria-label={t("Cover")}
        aria-haspopup="dialog"
        className={`flex min-h-[26px] items-center justify-center gap-1 rounded px-1.5 text-[11px] font-semibold transition ${
          cover ? "bg-rose-500/20 text-rose-300 hover:bg-rose-500/30" : "text-white/45 hover:bg-white/10 hover:text-white/80"
        }`}
      >
        <Icon size={13} />
        {!compact && <span>{t("Cover")}</span>}
      </button>

      {open && <CoverPickerDialog onClose={() => setOpen(false)} />}
    </>
  );
}
