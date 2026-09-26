"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Close, Search } from "@veasnawt/vicons";
import { ApiRequestError, importTemplateIntoProject, listTemplatesForImport } from "../api/client.ts";
import { startCheckout } from "../api/billing.ts";
import { templatePosterUrl, templatePreviewUrl, type TemplateRow } from "../api/templates.ts";
import { InsertTemplateCommand } from "../commands/index.ts";
import { createProject } from "../project/createProject.ts";
import { fillTemplateSlot, templateSlots, type TemplateSlot } from "../project/template.ts";
import type { Asset, Project } from "../project/types.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { formatDuration } from "../timeline/time.ts";
import { REPLACE_FOOTAGE, ReplaceMediaDialog } from "./ReplaceMediaDialog.tsx";
import { useHorizontalScroll } from "./useHorizontalScroll.ts";

type FeedMode = "mine" | "discover";

/** The in-editor "Templates" tool: browse a template (your own, or anyone's published one) and drop its
 *  own edit straight onto the CURRENTLY OPEN project's timeline — as opposed to the Templates TAB's own
 *  "Use this template," which always starts a brand-new, permanently-locked project instead (see
 *  `InsertTemplateCommand`'s own doc comment for exactly how the two differ).
 *
 *  Two steps: BROWSE (search + tag chips over "My Templates"/"Discover", the same client-side filtering
 *  the Templates tab itself uses) then FILL (once a template is picked and resolved — real audio, but
 *  every video/image clip still an open `templatePlaceholder` slot — every slot needs real media before
 *  it can actually be inserted; reuses `ReplaceMediaDialog` exactly as `TemplatePreviewScreen`'s own
 *  per-clip Replace does, since filling a slot is the identical action either way). The half-filled
 *  result lives entirely in this component's own state (a throwaway scratch `Project`, never touching
 *  the store) until "Insert," so backing out mid-fill leaves the real project untouched. */
export function ImportTemplateDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslation();
  const projectId = useEditorStore((s) => s.projectId);
  const project = useEditorStore((s) => s.project);
  const playhead = useEditorStore((s) => s.playhead);
  const run = useEditorStore((s) => s.run);
  const setStatus = useEditorStore((s) => s.setStatus);

  const [mode, setMode] = useState<FeedMode>("discover");
  const [templates, setTemplates] = useState<TemplateRow[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const chipsRef = useHorizontalScroll();

  const [resolving, setResolving] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<{ message: string; needsPro: boolean } | null>(null);
  const [upgrading, setUpgrading] = useState(false);

  // The template being filled, once picked: its own scratch project (never the real, open one) plus the
  // name it was saved under, shown in the header while filling.
  const [draft, setDraft] = useState<Project | null>(null);
  const [draftName, setDraftName] = useState("");
  const [fillTarget, setFillTarget] = useState<TemplateSlot | null>(null);
  const [inserting, setInserting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setTemplates(null);
    setListError(null);
    setSearch("");
    setActiveTag(null);
    listTemplatesForImport(mode)
      .then((rows) => {
        if (!cancelled) setTemplates(rows);
      })
      .catch((err: unknown) => {
        if (!cancelled) setListError(err instanceof Error ? err.message : "Couldn't load templates.");
      });
    return () => {
      cancelled = true;
    };
    // Deliberately just `[mode]` — `t` (`useTranslation()`) returns a brand-new function every render
    // (no memoization of its own), and this component also subscribes to `playhead`/`project`, which
    // change often during ordinary use. Including `t` here re-ran this fetch on every one of those
    // renders — cancelling the in-flight request before it ever resolved, so the list never left
    // "Loading…" (a real bug, caught live: reproduced against the deployed app, not just reasoned
    // about). The one string built inside this effect skips `t()` for the same reason `TemplateViewer.
    // tsx`'s own identical-shaped effect already does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const availableTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const tpl of templates ?? []) for (const tag of tpl.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 12)
      .map(([tag]) => tag);
  }, [templates]);

  const filtered = useMemo(() => {
    if (!templates) return null;
    const query = search.trim().toLowerCase();
    return templates.filter((tpl) => {
      if (activeTag && !tpl.tags.includes(activeTag)) return false;
      if (!query) return true;
      return tpl.name.toLowerCase().includes(query) || tpl.tags.some((tag) => tag.includes(query));
    });
  }, [templates, search, activeTag]);

  async function pickTemplate(tpl: TemplateRow) {
    if (!projectId || resolving) return;
    setResolving(tpl.id);
    setResolveError(null);
    try {
      const resolved = await importTemplateIntoProject(tpl.id, projectId);
      const scratch = createProject(`draft_${tpl.id}`, resolved.name, {
        width: resolved.project.width,
        height: resolved.project.height,
        fps: resolved.project.fps,
      });
      scratch.assets = resolved.project.assets;
      scratch.sequence.tracks = resolved.project.tracks;
      setDraft(scratch);
      setDraftName(resolved.name);
    } catch (err) {
      // The server's own message already says exactly why (your own private template needs Pro to
      // reuse, OR — regardless of ownership — a template that repeats AI effects needs Pro to run
      // them) — see `requirePro`/`requireProForAiTemplate`'s own doc comments for the two distinct
      // reasons this same "pro-required" code can mean.
      const needsPro = err instanceof ApiRequestError && err.code === "pro-required";
      setResolveError({ message: err instanceof Error ? err.message : t("Couldn't load that template."), needsPro });
    } finally {
      setResolving(null);
    }
  }

  async function upgrade() {
    setUpgrading(true);
    try {
      window.location.href = await startCheckout();
    } catch {
      setUpgrading(false);
    }
  }

  const openSlots = draft ? templateSlots(draft) : [];
  // Every clip instance for a slot, so a filled tile can show what actually landed there (the same
  // asset can fill more than one clip via one slot — see `fillTemplateSlot`'s own doc comment).
  const filledEntries = draft
    ? draft.assets.filter((a) => !a.templatePlaceholder && draft.sequence.tracks.some((tr) => tr.clips.some((c) => c.assetId === a.id)))
    : [];

  function pickAspectMismatch(): boolean {
    if (!draft || !project) return false;
    const templateRatio = draft.sequence.width / draft.sequence.height;
    const projectRatio = project.sequence.width / project.sequence.height;
    return Math.abs(templateRatio - projectRatio) > 0.05;
  }

  function insert() {
    if (!draft || openSlots.length > 0 || inserting) return;
    setInserting(true);
    try {
      run(
        new InsertTemplateCommand(
          { width: draft.sequence.width, height: draft.sequence.height, fps: draft.sequence.fps, tracks: draft.sequence.tracks, assets: draft.assets },
          playhead
        )
      );
      setStatus(t('Inserted "{name}" into the timeline', { name: draftName }));
      onClose();
    } finally {
      setInserting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center sm:p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t("Templates")}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex h-[85dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl border border-white/10 bg-[#12151c] shadow-2xl sm:h-[80vh] sm:rounded-xl"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-white">{draft ? t("Fill in this template") : t("Templates")}</h2>
            {draft && <p className="truncate text-[11px] text-white/50">{draftName}</p>}
          </div>
          <button
            onClick={draft ? () => setDraft(null) : onClose}
            aria-label={draft ? t("Back") : t("Close")}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white/50 transition hover:bg-white/10 hover:text-white"
          >
            <Close size={16} />
          </button>
        </div>

        {!draft ? (
          <>
            <div className="flex shrink-0 gap-2 px-4 pt-3">
              <button
                onClick={() => setMode("mine")}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${mode === "mine" ? "bg-white/15 text-white" : "text-white/50 hover:text-white/80"}`}
              >
                {t("My Templates")}
              </button>
              <button
                onClick={() => setMode("discover")}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${mode === "discover" ? "bg-white/15 text-white" : "text-white/50 hover:text-white/80"}`}
              >
                {t("Discover")}
              </button>
            </div>

            {templates && templates.length > 0 && (
              <div className="mt-3 shrink-0 space-y-2 px-4">
                <div className="relative">
                  <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-white/35" />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder={t("Search by name or tag…")}
                    className="w-full rounded-md border border-white/10 bg-white/[0.03] py-1.5 pl-8 pr-3 text-xs text-white placeholder:text-white/30 outline-none focus:border-sky-400"
                  />
                </div>
                {availableTags.length > 0 && (
                  <div ref={chipsRef} className="scrollbar-none -mx-4 flex gap-1.5 overflow-x-auto px-4">
                    {availableTags.map((tag) => (
                      <button
                        key={tag}
                        onClick={() => setActiveTag((prev) => (prev === tag ? null : tag))}
                        className={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-medium transition ${
                          activeTag === tag ? "border-sky-400 bg-sky-500/20 text-white" : "border-white/10 text-white/50 hover:border-white/25 hover:text-white/80"
                        }`}
                      >
                        #{tag}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-4 py-3">
              {listError ? (
                <p className="text-xs text-amber-200/80">{listError}</p>
              ) : templates === null ? (
                <p className="text-xs text-white/40">{t("Loading…")}</p>
              ) : templates.length === 0 ? (
                <p className="text-xs text-white/40">
                  {mode === "mine" ? t("Nothing saved yet.") : t("Nothing published yet — check back later.")}
                </p>
              ) : filtered && filtered.length === 0 ? (
                <p className="text-xs text-white/40">{t("Nothing matches that search.")}</p>
              ) : (
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                  {filtered?.map((tpl) => (
                    <button
                      key={tpl.id}
                      onClick={() => void pickTemplate(tpl)}
                      disabled={resolving !== null}
                      className="group relative aspect-[9/16] overflow-hidden rounded-lg border border-white/10 bg-black text-left transition hover:border-white/25 disabled:opacity-60"
                    >
                      <video src={templatePreviewUrl(tpl.id)} poster={templatePosterUrl(tpl.id)} muted playsInline className="h-full w-full object-cover" />
                      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/30 to-transparent px-2 pb-1.5 pt-6">
                        <p className="truncate text-[11px] font-medium text-white">{tpl.name}</p>
                        {tpl.aiCredits !== undefined && (
                          <p className="mt-0.5 flex items-center gap-1 text-[9px] text-white/70">
                            <span className="rounded-sm bg-amber-400 px-1 text-[8px] font-bold leading-[1.4] text-black">PRO</span>~{tpl.aiCredits}
                          </p>
                        )}
                      </div>
                      {resolving === tpl.id && (
                        <div className="absolute inset-0 flex items-center justify-center bg-black/60">
                          <div className="h-6 w-6 animate-spin rounded-full border-2 border-sky-400 border-t-transparent" />
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {resolveError && (
              <div className="mx-4 mb-3 shrink-0 rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
                <p>{resolveError.message}</p>
                {resolveError.needsPro && (
                  <button
                    onClick={() => void upgrade()}
                    disabled={upgrading}
                    className="mt-1.5 rounded-md bg-sky-500 px-3 py-1 text-[11px] font-semibold text-white transition hover:bg-sky-400 disabled:opacity-60"
                  >
                    {upgrading ? t("One moment…") : t("Upgrade to Pro")}
                  </button>
                )}
              </div>
            )}
          </>
        ) : (
          <>
            <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-4 py-3">
              {pickAspectMismatch() && (
                <p className="mb-3 rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-200">
                  {t("This template was made for a different shape ({w}×{h}) than your project — clips may not line up. You can still insert it and adjust them after.", {
                    w: draft.sequence.width,
                    h: draft.sequence.height,
                  })}
                </p>
              )}

              {filledEntries.length > 0 && (
                <div className="mb-3 flex flex-wrap gap-2">
                  {filledEntries.map((asset) => (
                    <div key={asset.id} className="flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-[11px] text-emerald-300">
                      <Check size={11} />
                      <span className="max-w-[8rem] truncate">{asset.name}</span>
                    </div>
                  ))}
                </div>
              )}

              {openSlots.length === 0 ? (
                <p className="text-xs text-white/40">{t("Every clip is filled — ready to insert.")}</p>
              ) : (
                <>
                  <p className="mb-2 text-[11px] font-medium text-white/50">
                    {t("Fill each open clip with your own photo or video")} ({openSlots.length})
                  </p>
                  <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                    {openSlots.map((slot) => (
                      <button
                        key={slot.assetId}
                        onClick={() => setFillTarget(slot)}
                        className="group relative flex aspect-square flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-white/20 bg-white/[0.03] text-center transition hover:border-sky-400/60 hover:bg-white/[0.06]"
                      >
                        <span className="text-[10px] font-semibold text-white/70">#{slot.slotIndex + 1}</span>
                        <span className="text-[9px] text-white/40">{slot.kind === "image" ? t("Photo") : t("Video")}</span>
                        <span className="text-[9px] tabular-nums text-white/40">{formatDuration(slot.requiredDuration)}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>

            <div className="shrink-0 border-t border-white/10 px-4 py-3">
              <button
                onClick={insert}
                disabled={openSlots.length > 0 || inserting}
                className="w-full rounded-md bg-sky-500 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-400 disabled:cursor-default disabled:bg-white/10 disabled:text-white/30"
              >
                {inserting ? t("Inserting…") : openSlots.length > 0 ? t("Fill every clip to continue") : t("Insert into Timeline")}
              </button>
            </div>
          </>
        )}
      </div>

      {fillTarget && draft && (
        <ReplaceMediaDialog
          target={{ ...REPLACE_FOOTAGE, assetId: fillTarget.assetId }}
          onClose={() => setFillTarget(null)}
          onPick={(asset: Asset) => {
            setDraft((prev) => (prev ? fillTemplateSlot(prev, fillTarget.assetId, asset) : prev));
            setFillTarget(null);
          }}
        />
      )}
    </div>
  );
}
