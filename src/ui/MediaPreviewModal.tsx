"use client";

import { createPortal } from "react-dom";
import { Close } from "@veasnawt/vicons";
import { mediaUrl } from "../api/client.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import type { Asset } from "../project/types.ts";

/** A quick look at a Media Library item's ACTUAL content — playing the real video/audio, or the image
 *  at a real size — without placing it on the timeline first. Confirmed as a real gap: the library's
 *  own thumbnail (one static frame, or a short filmstrip strip) is enough to recognize a clip you
 *  already know, but not enough to tell two similarly-thumbnailed takes apart, or to actually hear an
 *  audio file before committing it to a track. `Asset.kind === "text" | "color"` never gets a call
 *  site for this (see `MediaLibrary.tsx`'s own gating) — neither has real media to preview, only the
 *  same on-canvas representation already visible via their own icon/color swatch.
 *
 *  Same portal-into-`document.body` + backdrop-click-to-close pattern as `ConfirmDialog.tsx` — see its
 *  own doc comment for why a portal specifically (an ancestor `transform` elsewhere in the tree would
 *  otherwise hijack this modal's `fixed` positioning). */
export function MediaPreviewModal({ asset, projectId, onClose }: { asset: Asset; projectId: string; onClose: () => void }) {
  const t = useTranslation();
  const src = mediaUrl(projectId, asset.relPath);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={asset.name}
    >
      <div onClick={(e) => e.stopPropagation()} className="relative flex max-h-full max-w-3xl flex-col items-center">
        <button
          onClick={onClose}
          aria-label={t("Close")}
          title={t("Close")}
          className="absolute -top-11 right-0 rounded-full bg-white/10 p-2 text-white/80 transition hover:bg-white/20 hover:text-white"
        >
          <Close size={18} />
        </button>

        {asset.kind === "video" && (
          // `playsInline`: without it, iOS Safari hijacks playback into its own full-screen native
          // player the instant `autoPlay` fires — confirmed the actual behavior on a real device, not
          // a defensive guess — which would fight this modal's own overlay/close button for control.
          <video src={src} controls autoPlay playsInline className="max-h-[80vh] max-w-full rounded-lg bg-black" />
        )}

        {asset.kind === "audio" && (
          <div className="flex w-[min(90vw,26rem)] flex-col items-center gap-4 rounded-lg bg-[#12151c] p-6 shadow-2xl">
            <p className="w-full truncate text-center text-sm font-medium text-white">{asset.name}</p>
            <audio src={src} controls autoPlay className="w-full" />
          </div>
        )}

        {asset.kind === "image" && <img src={src} alt={asset.name} className="max-h-[80vh] max-w-full rounded-lg object-contain" />}
      </div>
    </div>,
    document.body
  );
}
