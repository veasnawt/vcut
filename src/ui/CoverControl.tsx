"use client";

import { useState } from "react";
import { Edit } from "@veasnawt/vicons";
import { mediaUrl, thumbnailUrl } from "../api/client.ts";
import { findAsset } from "../project/createProject.ts";
import type { Project } from "../project/types.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { clipAtTime } from "../timeline/queries.ts";
import { CoverPickerDialog } from "./CoverPickerDialog.tsx";
import { VideoFrameThumbnail } from "./VideoFrameThumbnail.tsx";

/** Finds whichever video/image clip is actually visible at `time` across every video track — same
 *  "first visible track wins" order `PlaybackEngine.drawVideoLayer` composites in, just picking ONE
 *  representative clip to preview instead of compositing every track's own frame (a real composite
 *  would need the full canvas engine — see `CoverPickerDialog.tsx`'s own doc comment for why that's
 *  reserved for the big preview there, not this small tile). */
function findRepresentativeClip(project: Project, time: number) {
  for (const track of project.sequence.tracks) {
    if (track.kind !== "video" || !track.visible) continue;
    const clip = clipAtTime(track, time);
    if (!clip) continue;
    const asset = findAsset(project, clip.assetId);
    if (asset && (asset.kind === "video" || asset.kind === "image")) return { clip, asset };
  }
  return null;
}

/** The exported file's own attached-cover control (see `ExportSettings.cover`'s own doc comment) —
 *  a real thumbnail tile, not an icon: shows whatever the cover CURRENTLY resolves to, exactly the
 *  same way the export itself would resolve it — an explicit `image` cover's own picture, an explicit
 *  `frame` cover's own real frame (seeked live via `VideoFrameThumbnail`, same technique the template
 *  flow's own retrim-thumbnail fix uses), or — with nothing explicit set yet — the real DEFAULT the
 *  export would fall back to (the first visible video/image clip's own frame at time 0), so this tile
 *  never shows a generic placeholder color when there's genuinely something real to preview. Lives in
 *  `TrackHeader.tsx`'s own video-track row now (a real CapCut-style reference screenshot), not a
 *  separate global control — see that file's own doc comment for why. */
export function CoverControl() {
  const t = useTranslation();
  const project = useEditorStore((s) => s.project);
  const projectId = useEditorStore((s) => s.projectId);
  const [open, setOpen] = useState(false);

  if (!project || !projectId) return null;
  const cover = project.exportSettings.cover ?? null;

  let previewUrl: string | null = null;
  let previewIsVideo = false;
  let previewTime = 0;

  if (cover?.kind === "image") {
    const asset = project.assets.find((a) => a.id === cover.assetId);
    if (asset) previewUrl = thumbnailUrl(projectId, asset);
  } else {
    // No explicit cover (or an explicit `frame` one) both resolve the same way: find what's actually
    // on screen at the relevant time and preview THAT — `0` is the export's own real default when
    // nothing has been picked at all.
    const time = cover?.kind === "frame" ? cover.time : 0;
    const found = findRepresentativeClip(project, time);
    if (found) {
      if (found.asset.kind === "image") {
        previewUrl = thumbnailUrl(projectId, found.asset);
      } else {
        previewIsVideo = true;
        previewUrl = mediaUrl(projectId, found.asset.relPath, Boolean(found.asset.libraryMediaId));
        previewTime = found.clip.sourceIn + Math.max(0, time - found.clip.timelineStart);
      }
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        title={t("Cover")}
        aria-label={t("Cover")}
        aria-haspopup="dialog"
        className="relative block h-full w-full overflow-hidden rounded-md border border-white/15 bg-white/5 transition hover:border-white/35"
      >
        {previewUrl ? (
          previewIsVideo ? (
            <VideoFrameThumbnail src={previewUrl} time={previewTime} className="absolute inset-0 h-full w-full object-cover" />
          ) : (
            <img src={previewUrl} alt="" className="absolute inset-0 h-full w-full object-cover" draggable={false} />
          )
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-white/30">
            <Edit size={12} />
          </div>
        )}
        <span className="absolute bottom-0.5 right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-black/70 text-white">
          <Edit size={8} />
        </span>
      </button>
      {open && <CoverPickerDialog onClose={() => setOpen(false)} />}
    </>
  );
}
