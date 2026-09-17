"use client";

import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Check } from "@veasnawt/vicons";
import { thumbnailUrl } from "../api/client.ts";
import { templateSlotCandidates } from "../project/template.ts";
import { formatDuration } from "../timeline/time.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import { useEditorStore } from "../store/editorStore.ts";

/** Names the new template before saving it — same portal/overlay shape `ConfirmDialog.tsx`'s own doc
 *  comment explains (this can be triggered from deep inside the header, so a portal is what keeps the
 *  overlay covering the whole screen regardless of any `transform`-ed ancestor). A real dialog rather
 *  than a bare `window.prompt()`: a template name deserves the same visual weight `MobileSignInDialog`
 *  gives a one-field input, and a native prompt can't be styled to match the rest of this editor at
 *  all. Defaults to the project's own current name — the common case (templating the project you're
 *  already looking at) needs zero typing, just confirm.
 *
 *  Below the name: a checklist of every clip that would otherwise become a fill-in-your-own-media slot
 *  (`templateSlotCandidates`) — every one starts CHECKED ("replaceable"), matching the feature's
 *  existing default exactly, so an author who never touches this gets today's behavior unchanged.
 *  Unchecking a tile keeps that one exact clip fixed in the template instead (a logo bumper, a
 *  branded background) — `saveAsTemplate`'s own `keepAssetIds` param is just "every candidate NOT
 *  checked", computed at save time rather than tracking a second, redundant "excluded" set. */
export function SaveAsTemplateDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslation();
  const project = useEditorStore((s) => s.project);
  const projectId = useEditorStore((s) => s.projectId);
  const projectName = project?.name ?? "";
  const saveAsTemplate = useEditorStore((s) => s.saveAsTemplate);
  const [name, setName] = useState(projectName);
  const [busy, setBusy] = useState(false);

  const candidates = useMemo(() => (project ? templateSlotCandidates(project) : []), [project]);
  const [uncheckedIds, setUncheckedIds] = useState<Set<string>>(new Set());

  function toggle(assetId: string) {
    setUncheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(assetId)) next.delete(assetId);
      else next.add(assetId);
      return next;
    });
  }

  async function save() {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    await saveAsTemplate(trimmed, [...uncheckedIds]);
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
      <div onClick={(e) => e.stopPropagation()} className="flex max-h-[85vh] w-full max-w-sm flex-col rounded-xl border border-white/10 bg-[#12151c] p-5 shadow-2xl">
        <h2 className="shrink-0 text-sm font-semibold text-white">{t("Save as template")}</h2>
        <p className="mt-2 shrink-0 text-xs leading-relaxed text-white/60">
          {t("Saves the whole edit — timing, effects, transitions, music, text — for anyone to reuse with their own photos and videos.")}
        </p>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void save()}
          placeholder={t("Template name")}
          autoFocus
          className="mt-3 w-full shrink-0 rounded-md border border-white/15 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/30 outline-none focus:border-sky-400"
        />

        {candidates.length > 0 && projectId && (
          <div className="mt-4 flex min-h-0 flex-1 flex-col">
            <p className="shrink-0 text-[11px] font-medium text-white/50">{t("Which clips can people replace?")}</p>
            <p className="mt-0.5 shrink-0 text-[11px] leading-relaxed text-white/35">
              {t("Checked clips let people swap in their own photos and videos. Uncheck one to keep it exactly as it is.")}
            </p>
            <div className="scrollbar-thin mt-2 min-h-0 flex-1 overflow-y-auto">
              <div className="grid grid-cols-3 gap-2 pb-0.5 pr-0.5">
                {candidates.map(({ asset, requiredDuration }) => {
                  const checked = !uncheckedIds.has(asset.id);
                  const thumb = thumbnailUrl(projectId, asset);
                  return (
                    <button
                      key={asset.id}
                      type="button"
                      onClick={() => toggle(asset.id)}
                      title={checked ? t("Replaceable — click to keep this exact clip") : t("Kept fixed — click to make it replaceable")}
                      className={`group relative aspect-square overflow-hidden rounded-lg bg-black/40 text-left transition ${
                        checked ? "ring-1 ring-sky-400/60" : "opacity-50"
                      }`}
                    >
                      {thumb ? (
                        <img src={thumb} alt="" className="absolute inset-0 h-full w-full object-cover" draggable={false} />
                      ) : (
                        <div className="absolute inset-0 flex items-center justify-center text-[10px] text-white/40">{t("No preview")}</div>
                      )}
                      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/30 to-transparent px-1 pb-0.5 pt-3">
                        <p className="truncate text-[9px] font-medium text-white/85">{formatDuration(requiredDuration)}</p>
                      </div>
                      <span
                        className={`absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full border transition ${
                          checked ? "border-sky-400 bg-sky-500 text-white" : "border-white/50 bg-black/50"
                        }`}
                      >
                        {checked && <Check size={10} />}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        <div className="mt-5 flex shrink-0 items-center justify-end gap-2">
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
