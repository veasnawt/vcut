"use client";

import { useState } from "react";
import { Close, Delete, Image as ImageIcon, Lock, Music, Text as TextIcon, Video } from "@veasnawt/vicons";
import { mediaUrl, thumbnailUrl } from "../api/client.ts";
import { RemoveTemplateGroupCommand, ReplaceTemplateClipCommand } from "../commands/index.ts";
import { templateGroupClips, templateGroupItems, templateGroupTracks, type TemplateGroupItem } from "../project/template.ts";
import type { Asset } from "../project/types.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { formatDuration } from "../timeline/time.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { REPLACE_AUDIO, REPLACE_FOOTAGE, ReplaceMediaDialog, type ReplaceTarget } from "./ReplaceMediaDialog.tsx";

const KIND_ICON = { video: Video, image: ImageIcon, text: TextIcon, audio: Music } as const;

/** "Manage this group" — opened from the small badge `TrackHeader.tsx` shows on every track a single
 *  "Insert into Timeline" (the in-editor Templates tool) created together (`Track.templateGroup`). Lists
 *  every clip across every track in the group, in timeline order, so a user can find and replace any of
 *  them from one place instead of hunting across whichever tracks the insert happened to land on — the
 *  direct reason this exists: those tracks are ordinary now (never locked into the guided template-only
 *  screens `TemplateFillScreen`/`TemplatePreviewScreen` give a project started FROM a template), so they
 *  have no other "here's everything from that template" view of their own.
 *
 *  Replacing video/image/audio reuses `ReplaceMediaDialog` exactly as the guided flow's own per-clip
 *  Replace does. A text clip has no separate replace step here — its own content is best edited through
 *  the normal composer/Inspector already open to any selected clip — so its row just selects it and
 *  closes this panel, landing the user right where they'd edit it. "Remove template" deletes every track
 *  in the group in one undoable step, for backing out of an insert entirely without picking through
 *  individual tracks by hand. */
export function TemplateGroupPanel({ groupId, onClose }: { groupId: string; onClose: () => void }) {
  const t = useTranslation();
  const project = useEditorStore((s) => s.project);
  const projectId = useEditorStore((s) => s.projectId);
  const run = useEditorStore((s) => s.run);
  const select = useEditorStore((s) => s.select);
  const setPlayhead = useEditorStore((s) => s.setPlayhead);
  const setStatus = useEditorStore((s) => s.setStatus);

  const [replaceTarget, setReplaceTarget] = useState<(ReplaceTarget & { clipId: string }) | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  if (!project || !projectId) return null;
  // The header's own count is the TRUE number of clips (so "44 clips from this template" still means
  // what it says); the rendered list below groups them by shared asset instead (`TemplateGroupItem`'s
  // own doc comment) — the two numbers deliberately don't have to match.
  const clipCount = templateGroupClips(project, groupId).length;
  const items = templateGroupItems(project, groupId);
  const groupName = templateGroupTracks(project, groupId)[0]?.templateGroup?.name;

  function jumpTo(entry: TemplateGroupItem) {
    select([entry.clip.id]);
    setPlayhead(entry.clip.timelineStart);
    onClose();
  }

  function removeGroup() {
    run(new RemoveTemplateGroupCommand(groupId));
    setStatus(t('Removed "{name}"', { name: groupName ?? t("template") }));
    setConfirmRemove(false);
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center sm:p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t("Template")}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[80dvh] w-full max-w-sm flex-col overflow-hidden rounded-t-2xl border border-white/10 bg-[#12151c] shadow-2xl sm:rounded-xl"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-white">{groupName ?? t("Template")}</h2>
            <p className="text-[11px] text-white/50">{t("{n} clips from this template", { n: clipCount })}</p>
          </div>
          <button onClick={onClose} aria-label={t("Close")} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white/50 transition hover:bg-white/10 hover:text-white">
            <Close size={16} />
          </button>
        </div>

        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-3">
          {items.length === 0 ? (
            <p className="px-1 py-6 text-center text-xs text-white/40">{t("This template's tracks are gone.")}</p>
          ) : (
            <div className="space-y-1.5">
              {items.map((entry) => {
                const Icon = KIND_ICON[entry.asset.kind as keyof typeof KIND_ICON] ?? Video;
                const isFootage = entry.asset.kind === "video" || entry.asset.kind === "image";
                const isAudio = entry.asset.kind === "audio";
                // Locked footage (`Clip.templateLocked`'s own doc comment) is the template author's own
                // fixed intro/logo/background/sticker — never a slot, so it never offers "Replace" here,
                // same "content editable, structure locked" boundary the guided template flow already
                // draws. Audio stays replaceable regardless (`templateAudioAssets`'s own convention).
                const isLocked = isFootage && entry.clip.templateLocked === true;
                const thumb = isFootage ? thumbnailUrl(projectId, entry.asset) : null;
                return (
                  <div key={entry.clip.id} className="flex items-center gap-2.5 rounded-lg bg-white/[0.03] px-2.5 py-2">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md bg-black/40 text-white/40">
                      {thumb ? <img src={thumb} alt="" className="h-full w-full object-cover" draggable={false} /> : <Icon size={15} />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs text-white/85">{entry.asset.kind === "text" ? entry.asset.textContent || t("Text") : entry.asset.name}</p>
                      <p className="text-[10px] text-white/40">
                        {isLocked ? t("Fixed by the template") : formatDuration(entry.clip.sourceOut - entry.clip.sourceIn)}
                        {entry.clipIds.length > 1 ? t(" · used in {n} clips", { n: entry.clipIds.length }) : ""}
                      </p>
                    </div>
                    {isLocked ? (
                      <span title={t("This clip can't be replaced")} className="flex shrink-0 items-center gap-1 rounded-md px-2.5 py-1.5 text-[11px] font-medium text-white/35">
                        <Lock size={12} />
                      </span>
                    ) : isFootage || isAudio ? (
                      <button
                        onClick={() => setReplaceTarget({ ...(isAudio ? REPLACE_AUDIO : REPLACE_FOOTAGE), assetId: entry.asset.id, clipId: entry.clip.id })}
                        className="shrink-0 rounded-md bg-white/10 px-2.5 py-1.5 text-[11px] font-medium text-white/80 transition hover:bg-white/20"
                      >
                        {t("Replace")}
                      </button>
                    ) : (
                      <button onClick={() => jumpTo(entry)} className="shrink-0 rounded-md bg-white/10 px-2.5 py-1.5 text-[11px] font-medium text-white/80 transition hover:bg-white/20">
                        {t("Select")}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="shrink-0 border-t border-white/10 p-3">
          <button
            onClick={() => setConfirmRemove(true)}
            disabled={clipCount === 0}
            className="flex w-full items-center justify-center gap-1.5 rounded-md border border-rose-500/25 bg-rose-500/10 py-2 text-xs font-medium text-rose-300 transition hover:bg-rose-500/20 disabled:opacity-40"
          >
            <Delete size={13} />
            {t("Remove this template from the timeline")}
          </button>
        </div>
      </div>

      {replaceTarget && (
        <ReplaceMediaDialog
          target={replaceTarget}
          onClose={() => setReplaceTarget(null)}
          onPick={(asset: Asset) => {
            run(new ReplaceTemplateClipCommand(replaceTarget.clipId, asset));
            setReplaceTarget(null);
          }}
        />
      )}

      {confirmRemove && (
        <ConfirmDialog
          title={t("Remove this template?")}
          message={t('Every track "{name}" added will be deleted. This can be undone with Undo.', { name: groupName ?? t("This template") })}
          confirmLabel={t("Remove")}
          onConfirm={removeGroup}
          onCancel={() => setConfirmRemove(false)}
        />
      )}
    </div>
  );
}
