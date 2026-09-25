"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "../i18n/useTranslation.ts";
import { useEditorStore } from "../store/editorStore.ts";

/** Shown when a save was refused because the project was saved from another tab or device after this copy was
 *  opened (see the server's `_lib/projectRevision.ts`). Autosave is paused meanwhile and nothing is lost —
 *  this tab's edits stay in memory — so this is a genuine either/or the user has to make: keep the other
 *  version (discarding what's here) or overwrite it with this one. Deliberately not dismissible: an
 *  unanswered conflict means nothing is being saved. */
export function SaveConflictDialog() {
  const saveConflict = useEditorStore((s) => s.saveConflict);
  const loadLatest = useEditorStore((s) => s.resolveConflictLoadLatest);
  const keepMine = useEditorStore((s) => s.resolveConflictKeepMine);
  const t = useTranslation();
  const [busy, setBusy] = useState(false);

  if (!saveConflict) return null;

  async function run(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4" role="alertdialog" aria-modal="true" aria-labelledby="save-conflict-title">
      <div className="w-full max-w-sm rounded-xl border border-white/10 bg-[#181b22] p-5 shadow-2xl">
        <h2 id="save-conflict-title" className="text-[15px] font-semibold text-white">
          {t("Changed somewhere else")}
        </h2>
        <p className="mt-2 text-[13px] leading-relaxed text-white/60">
          {t("This project was saved from another tab or device after you opened it. Your changes here are safe — choose which version to keep.")}
        </p>
        <div className="mt-4 flex flex-col gap-2">
          <button
            disabled={busy}
            onClick={() => void run(loadLatest)}
            className="rounded-md bg-sky-500 px-3 py-2 text-[13px] font-semibold text-white transition hover:bg-sky-400 disabled:opacity-50"
          >
            {t("Load the latest version")}
            <span className="block text-[11px] font-normal text-white/80">{t("Discards the changes made in this tab")}</span>
          </button>
          <button
            disabled={busy}
            onClick={() => void run(keepMine)}
            className="rounded-md bg-white/10 px-3 py-2 text-[13px] font-medium text-white transition hover:bg-white/20 disabled:opacity-50"
          >
            {t("Keep my version")}
            <span className="block text-[11px] font-normal text-white/60">{t("Overwrites the version saved elsewhere")}</span>
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
