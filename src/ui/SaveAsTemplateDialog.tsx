"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "../i18n/useTranslation.ts";
import { useEditorStore } from "../store/editorStore.ts";

/** Names the new template before saving it — same portal/overlay shape `ConfirmDialog.tsx`'s own doc
 *  comment explains (this can be triggered from deep inside the header, so a portal is what keeps the
 *  overlay covering the whole screen regardless of any `transform`-ed ancestor). A real dialog rather
 *  than a bare `window.prompt()`: a template name deserves the same visual weight `MobileSignInDialog`
 *  gives a one-field input, and a native prompt can't be styled to match the rest of this editor at
 *  all. Defaults to the project's own current name — the common case (templating the project you're
 *  already looking at) needs zero typing, just confirm. */
export function SaveAsTemplateDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslation();
  const projectName = useEditorStore((s) => s.project?.name ?? "");
  const saveAsTemplate = useEditorStore((s) => s.saveAsTemplate);
  const [name, setName] = useState(projectName);
  const [busy, setBusy] = useState(false);

  async function save() {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    await saveAsTemplate(trimmed);
    setBusy(false);
    onClose();
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t("Save as template")}
    >
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-sm rounded-xl border border-white/10 bg-[#12151c] p-5 shadow-2xl">
        <h2 className="text-sm font-semibold text-white">{t("Save as template")}</h2>
        <p className="mt-2 text-xs leading-relaxed text-white/60">
          {t("Saves the aspect ratio, tracks, and any text or color clips — not the media itself. Use it to start new projects from this same structure.")}
        </p>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void save()}
          placeholder={t("Template name")}
          autoFocus
          className="mt-3 w-full rounded-md border border-white/15 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/30 outline-none focus:border-sky-400"
        />
        <div className="mt-5 flex items-center justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="rounded-md px-3 py-1.5 text-xs font-medium text-white/60 transition hover:bg-white/10 hover:text-white disabled:opacity-50">
            {t("Cancel")}
          </button>
          <button
            onClick={() => void save()}
            disabled={busy || !name.trim()}
            className="rounded-md bg-sky-500 px-4 py-1.5 text-xs font-semibold text-white transition hover:bg-sky-400 disabled:cursor-default disabled:opacity-50"
          >
            {busy ? t("Saving…") : t("Save template")}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
