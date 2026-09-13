"use client";

import { useState } from "react";
import { Add, Image as ImageIcon, Music, Video } from "@veasnawt/vicons";
import { assetFromLibraryMedia, previewAssetFromLibraryMedia, thumbnailUrl, type LibraryMediaItem } from "../api/client.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import type { Asset } from "../project/types.ts";
import { templateSlots, type TemplateSlot } from "../project/template.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { formatDuration } from "../timeline/time.ts";
import { useLibraryMedia } from "./useLibraryMedia.ts";

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
export function TemplateFillScreen({ onAllFilled }: { onAllFilled: () => void }) {
  const t = useTranslation();
  const project = useEditorStore((s) => s.project);
  const projectId = useEditorStore((s) => s.projectId);
  const importFiles = useEditorStore((s) => s.importFiles);
  const fillTemplateSlotAction = useEditorStore((s) => s.fillTemplateSlot);
  const library = useLibraryMedia(true);

  const [allSlots] = useState<TemplateSlot[]>(() => (project ? templateSlots(project) : []));
  const [filledBySlotId, setFilledBySlotId] = useState<Record<string, Asset>>({});
  const [activeSlotAssetId, setActiveSlotAssetId] = useState<string | null>(allSlots[0]?.assetId ?? null);
  const [uploading, setUploading] = useState(false);

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
      <div className="shrink-0 border-b border-white/10 px-4 py-3">
        <h1 className="text-sm font-semibold text-white">{t("Add your own media")}</h1>
        <p className="mt-1 text-xs text-white/50">
          {activeSlot
            ? t("Pick a photo or video for slot {n} — {duration} needed", {
                n: allSlots.indexOf(activeSlot) + 1,
                duration: formatDuration(activeSlot.requiredDuration),
              })
            : allFilled
              ? t("All set — tap Preview below to see your video.")
              : t("This template keeps its original timing, effects, and music.")}
        </p>
      </div>

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
            const thumb = filled ? thumbnailUrl(projectId, filled) : null;
            return (
              <button
                key={slot.assetId}
                onClick={() => setActiveSlotAssetId(slot.assetId)}
                title={t("Slot {n}", { n: i + 1 })}
                className={`relative h-16 w-16 shrink-0 overflow-hidden rounded-xl border-2 transition ${
                  isActive ? "border-sky-400" : filled ? "border-emerald-400/50" : "border-white/15 hover:border-white/30"
                }`}
              >
                {thumb ? (
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
