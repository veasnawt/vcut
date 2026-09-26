"use client";

import { useState } from "react";
import { Add, Close, Image as ImageIcon, Music, Video } from "@veasnawt/vicons";
import { assetFromLibraryMedia, previewAssetFromLibraryMedia, thumbnailUrl, type LibraryMediaItem } from "../api/client.ts";
import { isSoundEffectName } from "../project/sfx.ts";
import type { Asset } from "../project/types.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { formatDuration } from "../timeline/time.ts";
import { useLibraryMedia } from "./useLibraryMedia.ts";

/** What a "Replace" picker offers/uploads/labels itself with — audio and video/image are different
 *  enough (a plain list vs. a thumbnail grid; different accepted extensions) that `ReplaceMediaDialog`
 *  needs to know which it's showing, but the picking/uploading MECHANICS underneath are identical
 *  either way — see that component's own doc comment. `assetId` is excluded from the library list — the
 *  thing already playing there (or, filling a freshly-inserted template's own placeholder slot, that
 *  placeholder's own synthetic id, which never appears in a real library and so excludes nothing) is a
 *  pointless choice to "replace" with itself. */
export interface ReplaceTarget {
  assetId: string;
  kinds: Array<"audio" | "video" | "image">;
  title: string;
  accept: string;
}

export const REPLACE_AUDIO: Omit<ReplaceTarget, "assetId"> = {
  kinds: ["audio"],
  title: "Replace music",
  accept: ".mp3,.wav,.m4a,.aac,.ogg,.flac",
};

export const REPLACE_FOOTAGE: Omit<ReplaceTarget, "assetId"> = {
  kinds: ["video", "image"],
  title: "Replace clip",
  accept: ".mp4,.mov,.webm,.mkv,.avi,.m4v,.png,.jpg,.jpeg,.webp,.gif",
};

/** A picker for "put different media here": your own account-wide library (`useLibraryMedia`, every
 *  project's own uploads/generations pooled together) plus an "Upload a file" button that goes straight
 *  through the CURRENTLY OPEN project's own import (`importFiles` — a new file lands in that project's
 *  media exactly like dragging it onto the Media panel would). Originally built for
 *  `TemplatePreviewScreen`'s own per-clip Replace/per-track music Replace; reused as-is by the in-editor
 *  Templates tool (`ImportTemplateDialog`) to fill a freshly-inserted template's own open slots — the
 *  mechanics are identical either way, only what the caller DOES with the picked `Asset` differs. */
export function ReplaceMediaDialog({ target, onClose, onPick }: { target: ReplaceTarget; onClose: () => void; onPick: (asset: Asset) => void }) {
  const t = useTranslation();
  const projectId = useEditorStore((s) => s.projectId);
  const importFiles = useEditorStore((s) => s.importFiles);
  const library = useLibraryMedia(true);
  const [uploading, setUploading] = useState(false);

  // Sound effects left out of an audio replacement's choices, same as the Audio tab's own rows — a
  // template's sound effects land in the library when a project is started from it.
  const items =
    library.items?.filter(
      (i) => target.kinds.includes(i.kind) && i.id !== target.assetId && !(i.kind === "audio" && isSoundEffectName(i.name))
    ) ?? [];
  const isGrid = target.kinds.includes("video") || target.kinds.includes("image");

  async function uploadReplacement(file: File) {
    setUploading(true);
    const imported = await importFiles([file]);
    setUploading(false);
    if (imported[0]) onPick(imported[0]);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center sm:p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t(target.title)}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[80vh] w-full max-w-md overflow-y-auto rounded-t-xl border border-white/10 bg-[#12151c] p-4 shadow-2xl sm:rounded-xl"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white">{t(target.title)}</h2>
          <button onClick={onClose} className="rounded p-1 text-white/50 transition hover:bg-white/10 hover:text-white">
            <Close size={16} />
          </button>
        </div>

        <label className="mb-2 flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-white/25 bg-white/5 py-3 text-xs font-medium text-white/70 transition hover:border-sky-400/50 hover:bg-white/10">
          <input
            type="file"
            className="hidden"
            disabled={uploading}
            accept={target.accept}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void uploadReplacement(file);
            }}
          />
          <Add size={16} />
          {uploading ? t("Uploading…") : t("Upload a file")}
        </label>

        {isGrid ? (
          <div className="grid grid-cols-3 gap-2">
            {items.map((item) => (
              <ReplaceGridTile key={item.id} item={item} projectId={projectId} onPick={() => onPick(assetFromLibraryMedia(item))} />
            ))}
          </div>
        ) : (
          <div className="space-y-1">
            {items.map((item) => (
              <button
                key={item.id}
                onClick={() => onPick(assetFromLibraryMedia(item))}
                className="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left transition hover:bg-white/10"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Music size={15} className="shrink-0 text-white/40" />
                  <span className="truncate text-xs text-white/80">{item.name}</span>
                </span>
                <span className="shrink-0 text-[11px] tabular-nums text-white/40">{formatDuration(item.duration)}</span>
              </button>
            ))}
          </div>
        )}
        {library.items !== null && items.length === 0 && (
          <p className="px-2 py-4 text-center text-xs text-white/40">{t("Nothing usable in your media yet — upload something above.")}</p>
        )}
      </div>
    </div>
  );
}

function ReplaceGridTile({ item, projectId, onPick }: { item: LibraryMediaItem; projectId: string | null; onPick: () => void }) {
  const Icon = item.kind === "image" ? ImageIcon : Video;
  const url = projectId ? thumbnailUrl(projectId, previewAssetFromLibraryMedia(item)) : null;
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
