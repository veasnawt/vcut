"use client";

import { useState } from "react";
import { useTranslation } from "../i18n/useTranslation.ts";
import { ExportDialog } from "./ExportDialog.tsx";
import { Preview } from "./Preview.tsx";

/** What a template-origin project (`Project.templateOrigin`) shows once every slot is filled — the
 *  finished-looking video, ready to export, with no way to reach the normal timeline/clip editor at
 *  all (asked for directly: a template's whole point is a consistent, guaranteed-to-look-right result,
 *  which free-form editing could otherwise drift away from). Reuses `Preview.tsx` exactly as the
 *  normal editor does — same canvas, same playback engine, same play/pause transport bar — just
 *  without any of the surrounding timeline/panels chrome; `onResizeStart` is a no-op since there's no
 *  resizable layout here for its drag handle to actually resize. `ExportDialog` is mounted directly
 *  (not via the normal editor's own `exportOpen` state, which doesn't exist on this screen) — it reads
 *  everything it needs straight from the store, same as it always has. */
export function TemplatePreviewScreen() {
  const t = useTranslation();
  const [exportOpen, setExportOpen] = useState(false);

  return (
    <div className="flex h-full flex-col bg-[#0a0c10] text-white">
      <div className="shrink-0 border-b border-white/10 px-4 py-3">
        <h1 className="text-sm font-semibold text-white">{t("Your video is ready")}</h1>
        <p className="mt-1 text-xs text-white/50">{t("Preview it below, then export when you're happy with it.")}</p>
      </div>

      <div className="min-h-0 flex-1 p-3">
        <Preview onResizeStart={() => {}} />
      </div>

      <div className="shrink-0 border-t border-white/10 p-3">
        <button
          onClick={() => setExportOpen(true)}
          className="w-full rounded-md bg-sky-500 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-400"
        >
          {t("Export")}
        </button>
      </div>

      {exportOpen && <ExportDialog onClose={() => setExportOpen(false)} />}
    </div>
  );
}
