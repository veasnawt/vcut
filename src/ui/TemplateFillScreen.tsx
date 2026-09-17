"use client";

import { useState } from "react";
import { Add, Edit, Image as ImageIcon, Music, Video } from "@veasnawt/vicons";
import { assetFromLibraryMedia, mediaUrl, previewAssetFromLibraryMedia, thumbnailUrl, type LibraryMediaItem } from "../api/client.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import type { Asset } from "../project/types.ts";
import { templateSlotRequiredLength, templateSlots, type TemplateSlot } from "../project/template.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { formatDuration } from "../timeline/time.ts";
import { TemplateTrimDialog } from "./TemplateTrimDialog.tsx";
import { TemplateScreenHeader } from "./TemplateScreenHeader.tsx";
import { useLibraryMedia } from "./useLibraryMedia.ts";
import { VideoFrameThumbnail } from "./VideoFrameThumbnail.tsx";

/** Covers `LibraryGridTile`'s own general `LibraryMediaItem.kind` (video/audio/image — a user's
 *  library can hold all three) even though a slot's own `TemplateSlot["kind"]` only ever needs
 *  "video"/"image" — audio is deliberately never a slot at all (see `Asset.templateBundledAudio`'s
 *  own doc comment: a template's music carries over automatically, nothing to pick for it here), so
 *  the "audio" entry only exists for this Record to stay total; nothing in this file ever actually
 *  looks it up. */
const KIND_ICON: Record<"video" | "audio" | "image", typeof Video> = { video: Video, audio: Music, image: ImageIcon };

/** Full-screen "add your media" step for a project just started from a Pro template — never a modal
 *  overlaid on the normal editor (unlike this feature's own first version): a template-origin project
 *  (`Project.templateOrigin`) never shows the timeline editor at all, so this and `TemplatePreviewScreen`
 *  ARE the whole app until export. A grid of the user's own account-wide photos/videos fills whichever
 *  slot is currently active (music/voiceover isn't pickable here at all — it carries over from the
 *  template automatically); the slots themselves sit as a horizontally-scrollable row of square, rounded
 *  tiles below the grid, each showing its own required duration — tapping one makes IT the active slot,
 *  so any pick can be revisited before moving on.
 *
 *  `allSlots` is captured ONCE, on mount, from `templateSlots(project)` — that function's own live
 *  result would shrink every time a slot gets filled (a filled slot's placeholder asset is gone
 *  entirely from `project.assets`), which would reorder/resize this screen's own chip row mid-flow.
 *  Capturing the full list up front and tracking fill state in `filledBySlotId` (this component's own
 *  state, updated the instant a pick is made — before `project` even finishes propagating the change)
 *  keeps every chip visible for the whole flow, whether still empty or already showing a pick. */
export function TemplateFillScreen({ onAllFilled, onBack }: { onAllFilled: () => void; onBack?: () => void }) {
  const t = useTranslation();
  const project = useEditorStore((s) => s.project);
  const projectId = useEditorStore((s) => s.projectId);
  const importFiles = useEditorStore((s) => s.importFiles);
  const fillTemplateSlotAction = useEditorStore((s) => s.fillTemplateSlot);
  const trimTemplateSlotAction = useEditorStore((s) => s.trimTemplateSlot);
  const library = useLibraryMedia(true);

  const [allSlots] = useState<TemplateSlot[]>(() => (project ? templateSlots(project) : []));
  const [filledBySlotId, setFilledBySlotId] = useState<Record<string, Asset>>({});
  const [activeSlotAssetId, setActiveSlotAssetId] = useState<string | null>(allSlots[0]?.assetId ?? null);
  const [uploading, setUploading] = useState(false);
  // Offered immediately after a pick, not tucked away in the later Preview screen — see
  // `TemplateTrimDialog.tsx`'s own doc comment for why a video's own first `requiredDuration` seconds
  // are rarely its most interesting part; asked for directly, right here at fill time, rather than
  // only ever being reachable from `TemplatePreviewScreen.tsx`'s own Trim button one screen later.
  const [trimmingAsset, setTrimmingAsset] = useState<Asset | null>(null);

  if (!project || !projectId) return null;
  const activeSlot = allSlots.find((s) => s.assetId === activeSlotAssetId) ?? null;
  // `.every()` on an empty array is `true` — exactly right for a template with no media slots at all
  // (pure text/color, from before this feature could keep any footage): nothing to fill means already
  // done, not permanently stuck behind a button that can never enable.
  const allFilled = allSlots.every((s) => filledBySlotId[s.assetId]);

  function assign(slot: TemplateSlot, asset: Asset) {
    // On a first pick, the slot's own placeholder (`slot.assetId`) is still what every clip in the
    // group actually references — `fillTemplateSlot` matches on that. On a CHANGE OF MIND (this slot
    // already has a pick — clicking its own chip again re-activates it, same as any other), the
    // placeholder is long gone; the clips now reference THAT earlier pick's own asset id instead, so
    // that's what has to be passed as the thing being replaced this time.
    const currentAssetId = filledBySlotId[slot.assetId]?.id ?? slot.assetId;
    fillTemplateSlotAction(currentAssetId, asset);
    setFilledBySlotId((prev) => {
      const next = { ...prev, [slot.assetId]: asset };
      // Auto-advance to the next still-empty slot, computed off the just-updated map (not `prev`,
      // which wouldn't yet reflect the pick this very call is making) — stays put (no active slot)
      // once every slot has something.
      setActiveSlotAssetId(allSlots.find((s) => !next[s.assetId])?.assetId ?? null);
      return next;
    });
    // Only when there's real room to trim (a video genuinely longer than the slot needs) — same
    // `canTrim` condition `TemplatePreviewScreen.tsx`'s own `VideoTabContent` gates its Trim button on.
    // Never for an image (no "which portion" of a still to choose) or an exact-length video pick.
    if (asset.kind === "video" && asset.duration > slot.requiredDuration) setTrimmingAsset(asset);
  }

  async function uploadForActiveSlot(file: File) {
    if (!activeSlot) return;
    setUploading(true);
    const imported = await importFiles([file]);
    setUploading(false);
    if (imported[0]) assign(activeSlot, imported[0]);
  }

  const compatibleLibraryItems = activeSlot ? library.items?.filter((i) => i.kind === "video" || i.kind === "image") ?? [] : [];

  return (
    <div className="flex h-full flex-col bg-[#0a0c10] text-white">
      <TemplateScreenHeader
        onBack={onBack}
        subtitle={
          activeSlot
            ? t("Pick a photo or video for slot {n} — {duration} needed", {
                n: allSlots.indexOf(activeSlot) + 1,
                duration: formatDuration(activeSlot.requiredDuration),
              })
            : allFilled
              ? t("All set — tap Preview below to see your video.")
              : t("This template keeps its original timing, effects, and music.")
        }
      />

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-3">
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {/* Upload — same "first tile in the grid, not a separate button" convention MediaLibrary.tsx's
              own Import tile already uses. */}
          <label className="group relative flex aspect-square cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-white/25 bg-white/5 transition hover:border-sky-400/50 hover:bg-white/10">
            <input
              type="file"
              className="hidden"
              disabled={uploading || !activeSlot}
              accept=".mp4,.mov,.webm,.mkv,.avi,.m4v,.png,.jpg,.jpeg,.webp,.gif"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void uploadForActiveSlot(file);
              }}
            />
            <Add size={22} className="text-white/50 transition group-hover:text-white/80" />
            <span className="text-[11px] font-medium text-white/70">{uploading ? t("Uploading…") : t("Upload")}</span>
          </label>

          {compatibleLibraryItems.map((item) => (
            <LibraryGridTile
              key={item.id}
              item={item}
              projectId={projectId}
              onPick={() => activeSlot && assign(activeSlot, assetFromLibraryMedia(item))}
            />
          ))}
        </div>
        {activeSlot && library.items !== null && compatibleLibraryItems.length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-white/40">{t("Nothing usable in your media yet — upload something above.")}</p>
        )}
      </div>

      <div className="shrink-0 border-t border-white/10 p-3">
        <div className="scrollbar-thin flex gap-2 overflow-x-auto pb-1">
          {allSlots.map((slot, i) => {
            const filled = filledBySlotId[slot.assetId];
            const isActive = activeSlotAssetId === slot.assetId;
            const Icon = KIND_ICON[slot.kind];
            // A video's own static thumbnail is generated once at import time and never reflects a
            // later retrim — see `VideoFrameThumbnail`'s own doc comment. `sourceIn` comes from
            // whichever real clip currently references this pick, the same lookup
            // `TemplatePreviewScreen.tsx`'s own trim dialog already does.
            const filledClipSourceIn = filled
              ? (project.sequence.tracks.flatMap((tr) => tr.clips).find((c) => c.assetId === filled.id)?.sourceIn ?? 0)
              : 0;
            const videoSrc = filled?.kind === "video" ? mediaUrl(projectId, filled.relPath, Boolean(filled.libraryMediaId)) : null;
            const thumb = filled && filled.kind !== "video" ? thumbnailUrl(projectId, filled) : null;
            // Same `canTrim` condition as the pick-time offer above and `TemplatePreviewScreen.tsx`'s
            // own gating — re-openable here too, not just the one time right after picking, since a
            // user may want to revisit the choice after seeing how the rest of the fill turned out.
            const canTrimFilled = filled && filled.kind === "video" && filled.duration > slot.requiredDuration;
            return (
              <div key={slot.assetId} className="relative h-16 w-16 shrink-0">
                <button
                  onClick={() => setActiveSlotAssetId(slot.assetId)}
                  title={t("Slot {n}", { n: i + 1 })}
                  className={`absolute inset-0 overflow-hidden rounded-xl border-2 transition ${
                    isActive ? "border-sky-400" : filled ? "border-emerald-400/50" : "border-white/15 hover:border-white/30"
                  }`}
                >
                  {videoSrc ? (
                    <VideoFrameThumbnail src={videoSrc} time={filledClipSourceIn} className="absolute inset-0 h-full w-full object-cover" />
                  ) : thumb ? (
                    <img src={thumb} alt="" className="absolute inset-0 h-full w-full object-cover" draggable={false} />
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center bg-white/5 text-white/40">
                      <Icon size={18} />
                    </div>
                  )}
                  {!filled && (
                    <span className="absolute left-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-black/70 text-[9px] font-bold text-white">
                      {i + 1}
                    </span>
                  )}
                  <span className="absolute bottom-0.5 right-0.5 rounded bg-black/80 px-1 text-[9px] tabular-nums text-white">
                    {formatDuration(slot.requiredDuration)}
                  </span>
                </button>
                {canTrimFilled && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setTrimmingAsset(filled);
                    }}
                    title={t("Trim")}
                    aria-label={t("Trim")}
                    className="absolute -right-1.5 -top-1.5 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-sky-500 text-white shadow transition hover:bg-sky-400"
                  >
                    <Edit size={11} />
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <button
          onClick={onAllFilled}
          disabled={!allFilled}
          className="mt-3 w-full rounded-md bg-sky-500 py-2 text-sm font-semibold text-white transition hover:bg-sky-400 disabled:cursor-default disabled:opacity-40"
        >
          {allFilled ? t("Preview") : t("Fill every slot to continue")}
        </button>
      </div>

      {trimmingAsset && (
        <TemplateTrimDialog
          asset={trimmingAsset}
          projectId={projectId}
          requiredLength={templateSlotRequiredLength(project, trimmingAsset.id)}
          currentSourceIn={project.sequence.tracks.flatMap((tr) => tr.clips).find((c) => c.assetId === trimmingAsset.id)?.sourceIn ?? 0}
          onClose={() => setTrimmingAsset(null)}
          onConfirm={(sourceIn) => {
            trimTemplateSlotAction(trimmingAsset.id, sourceIn);
            setTrimmingAsset(null);
          }}
        />
      )}
    </div>
  );
}

function LibraryGridTile({ item, projectId, onPick }: { item: LibraryMediaItem; projectId: string; onPick: () => void }) {
  const Icon = KIND_ICON[item.kind];
  const url = thumbnailUrl(projectId, previewAssetFromLibraryMedia(item));
  return (
    <button
      onClick={onPick}
      title={item.name}
      className="group relative aspect-square overflow-hidden rounded-lg bg-black transition hover:ring-2 hover:ring-sky-400/60"
    >
      {url ? (
        <img src={url} alt="" className="absolute inset-0 h-full w-full object-cover" draggable={false} />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center bg-white/5 text-white/40">
          <Icon size={18} />
        </div>
      )}
      {item.kind !== "image" && (
        <span className="absolute bottom-1 right-1 rounded bg-black/75 px-1 text-[10px] tabular-nums text-white/90">
          {formatDuration(item.duration)}
        </span>
      )}
    </button>
  );
}
