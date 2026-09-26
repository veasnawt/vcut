"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check } from "@veasnawt/vicons";
import { thumbnailUrl } from "../api/client.ts";
import { templateAiSummary } from "../project/aiRecipe.ts";
import { sequenceDuration } from "../project/createProject.ts";
import { sanitizeProjectForTemplate, templateSlotCandidates } from "../project/template.ts";
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
  // The AI tools used in this edit (cutouts, AI edits, object removal) are saved with the template and repeated on the
  // media people pick, which spends their credits — so say so here, and the template becomes Pro-only to use.
  const aiSummary = useMemo(() => {
    if (!project) return null;
    const sanitized = sanitizeProjectForTemplate(project);
    const summary = templateAiSummary(sanitized.tracks, sanitized.assets);
    return summary.steps > 0 ? summary : null;
  }, [project]);
  const [uncheckedIds, setUncheckedIds] = useState<Set<string>>(new Set());

  // Free-form search words ("intro", "outro", "vlog", ...) — set once here, at save time (see
  // `sanitizeTemplateTags` server-side for how these get normalized: lowercased, deduped, capped at 8
  // tags of 24 characters). `tagInput` is whatever's still being typed, not yet committed to `tags`.
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  function addTag(raw: string) {
    const tag = raw.trim().toLowerCase().replace(/^#+/, "").slice(0, 24);
    if (!tag || tags.includes(tag) || tags.length >= 8) return;
    setTags((prev) => [...prev, tag]);
  }
  function commitTagInput() {
    addTag(tagInput);
    setTagInput("");
  }
  function removeTag(tag: string) {
    setTags((prev) => prev.filter((t) => t !== tag));
  }
  // A few common ones, one tap each — the exact "intro"/"outro" case this feature was asked for, plus
  // the other shapes a template search would realistically group by.
  const TAG_SUGGESTIONS = ["intro", "outro", "vlog", "transition", "meme", "slideshow"];

  // The cover: whatever frame the preview shows at the chosen time, grabbed from the editor's own canvas (so it is exactly
  // what the author sees), and sent along with the save. Without one the server grabs a frame from the rendered preview.
  const setPlayhead = useEditorStore((s) => s.setPlayhead);
  const startPlayhead = useRef(useEditorStore.getState().playhead);
  const duration = project ? sequenceDuration(project) : 0;
  const [coverTime, setCoverTime] = useState(() => {
    const at = useEditorStore.getState().playhead;
    // A playhead parked at 0 is usually a flash or a fade-in: start a little way in instead.
    return at > 0.05 ? at : Math.min(duration * 0.15, Math.max(0, duration - 0.1));
  });
  const [cover, setCover] = useState<{ dataUrl: string; base64: string } | null>(null);
  useEffect(() => {
    if (duration <= 0) return;
    setPlayhead(coverTime);
    // Waits for the preview to finish seeking and draw the frame.
    const timer = window.setTimeout(() => {
      const source = document.querySelector<HTMLCanvasElement>("canvas[data-vcut-preview-canvas]");
      if (!source || source.width === 0) return;
      const scale = Math.min(1, 540 / source.width);
      const out = document.createElement("canvas");
      out.width = Math.max(2, Math.round(source.width * scale));
      out.height = Math.max(2, Math.round(source.height * scale));
      const ctx = out.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(source, 0, 0, out.width, out.height);
      try {
        const dataUrl = out.toDataURL("image/jpeg", 0.86);
        setCover({ dataUrl, base64: dataUrl.slice(dataUrl.indexOf(",") + 1) });
      } catch {
        setCover(null);
      }
    }, 900);
    return () => window.clearTimeout(timer);
  }, [coverTime, duration, setPlayhead]);

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
    await saveAsTemplate(trimmed, [...uncheckedIds], cover?.base64, tags);
    setBusy(false);
    setPlayhead(startPlayhead.current);
    onClose();
  }

  function cancel() {
    setPlayhead(startPlayhead.current);
    onClose();
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={cancel}
      role="dialog"
      aria-modal="true"
      aria-label={t("Save as template")}
    >
      <div onClick={(e) => e.stopPropagation()} className="flex max-h-[85vh] w-full max-w-sm flex-col rounded-xl border border-white/10 bg-[#12151c] p-5 shadow-2xl">
        <h2 className="shrink-0 text-sm font-semibold text-white">{t("Save as template")}</h2>
        <p className="mt-2 shrink-0 text-xs leading-relaxed text-white/60">
          {t("Saves the whole edit — timing, effects, transitions, music, text — for anyone to reuse with their own photos and videos.")}
        </p>
        {aiSummary && (
          <p className="mt-2 shrink-0 rounded-md bg-amber-300/[0.08] px-2.5 py-2 text-[11px] leading-relaxed text-amber-200">
            {t("This edit uses AI tools. They'll run again on each person's own media (about {n} credits), and the template will be Pro-only to use.", { n: aiSummary.credits })}
          </p>
        )}
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void save()}
          placeholder={t("Template name")}
          autoFocus
          className="mt-3 w-full shrink-0 rounded-md border border-white/15 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/30 outline-none focus:border-sky-400"
        />

        <div className="mt-3 shrink-0">
          <p className="text-[11px] font-medium text-white/50">
            {t("Tags")} <span className="font-normal text-white/30">{t("(optional — helps people find it later)")}</span>
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 rounded-md border border-white/15 bg-white/5 px-2 py-1.5 focus-within:border-sky-400">
            {tags.map((tag) => (
              <span key={tag} className="flex items-center gap-1 rounded-full bg-sky-500/20 py-0.5 pl-2.5 pr-1 text-[11px] text-sky-200">
                #{tag}
                <button type="button" onClick={() => removeTag(tag)} aria-label={t("Remove tag {tag}", { tag })} className="rounded-full p-0.5 text-sky-200/70 hover:bg-white/10 hover:text-white">
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                    <path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" />
                  </svg>
                </button>
              </span>
            ))}
            {tags.length < 8 && (
              <input
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === ",") {
                    e.preventDefault();
                    commitTagInput();
                  } else if (e.key === "Backspace" && !tagInput && tags.length > 0) {
                    removeTag(tags[tags.length - 1]);
                  }
                }}
                onBlur={commitTagInput}
                placeholder={tags.length === 0 ? t("intro, outro, vlog…") : ""}
                className="min-w-[6rem] flex-1 bg-transparent py-0.5 text-xs text-white placeholder:text-white/30 outline-none"
              />
            )}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {TAG_SUGGESTIONS.filter((s) => !tags.includes(s)).map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => addTag(suggestion)}
                className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-white/50 transition hover:border-white/25 hover:text-white/80"
              >
                +{suggestion}
              </button>
            ))}
          </div>
        </div>

        {duration > 0 && (
          <div className="mt-4 flex shrink-0 items-center gap-3">
            <div className="flex h-24 w-[3.4rem] shrink-0 items-center justify-center overflow-hidden rounded-md border border-white/10 bg-black/50" style={{ aspectRatio: project ? `${project.sequence.width} / ${project.sequence.height}` : undefined, width: "auto" }}>
              {cover ? <img src={cover.dataUrl} alt={t("Cover")} className="h-full w-auto object-contain" draggable={false} /> : <span className="px-1 text-center text-[9px] text-white/35">{t("Loading…")}</span>}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-medium text-white/50">{t("Cover")} · {formatDuration(coverTime)}</p>
              <input
                type="range"
                min={0}
                max={Math.max(0.1, duration)}
                step={0.05}
                value={Math.min(coverTime, duration)}
                onChange={(e) => setCoverTime(Number(e.target.value))}
                aria-label={t("Cover frame")}
                className="h-9 w-full cursor-pointer accent-sky-400"
              />
              <p className="text-[10px] leading-snug text-white/35">{t("The picture shown on the template before it plays.")}</p>
            </div>
          </div>
        )}

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
          <button onClick={cancel} disabled={busy} className="rounded-md px-3 py-1.5 text-xs font-medium text-white/60 transition hover:bg-white/10 hover:text-white disabled:opacity-50">
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
