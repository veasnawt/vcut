"use client";

import { useRef, useState } from "react";
import { Close } from "@veasnawt/vicons";
import { mediaUrl } from "../api/client.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import type { Asset } from "../project/types.ts";
import { formatDuration } from "../timeline/time.ts";
import { addDragListeners, clientPoint, preventDefaultIfMouse } from "./pointerEvents.ts";

/** Lets a picked video's own shared trim start point (`Asset.duration` vs. what the slot actually
 *  needs — `requiredLength`) be dragged to a different part of the source, after the fact — see
 *  `trimTemplateSlot`'s own doc comment for why slot-filling always used to lock in exactly the first
 *  `requiredLength` seconds regardless of whether that was the most interesting part. A fixed-width
 *  window (its own width IS `requiredLength`, unchangeable here — only WHERE it sits along the source
 *  can move) dragged across a bar spanning the source's full duration, same mouse/touch drag shape
 *  `MediaLibrary.tsx`'s own asset drag uses (`addDragListeners`/`clientPoint`). The `<video>` preview
 *  seeks to the window's own start on every drag frame, so picking a spot is "scrub until it looks
 *  right," not reading timestamps. Never shown for an IMAGE pick — a still frame has no "which portion"
 *  of itself to choose (`TemplatePreviewScreen.tsx`'s own gating, not this component's). */
export function TemplateTrimDialog({
  asset,
  projectId,
  requiredLength,
  currentSourceIn,
  onClose,
  onConfirm,
}: {
  asset: Asset;
  projectId: string;
  requiredLength: number;
  currentSourceIn: number;
  onClose: () => void;
  onConfirm: (sourceIn: number) => void;
}) {
  const t = useTranslation();
  const trackRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const maxSourceIn = Math.max(0, asset.duration - requiredLength);
  const [sourceIn, setSourceIn] = useState(() => Math.min(currentSourceIn, maxSourceIn));

  function seekPreview(value: number) {
    if (videoRef.current) videoRef.current.currentTime = value;
  }

  function beginDrag(event: React.MouseEvent | React.TouchEvent) {
    const track = trackRef.current;
    if (!track || maxSourceIn <= 0) return;
    preventDefaultIfMouse(event);
    const trackRect = track.getBoundingClientRect();
    const start = clientPoint(event);
    // Where inside the window the drag actually grabbed, in seconds — keeps the window from jumping
    // so its LEFT EDGE snaps under the pointer on the very first move frame, the same "grab where you
    // clicked" feel any slider/scrubber drag needs.
    const grabOffsetSeconds = (start.x - trackRect.left) / trackRect.width * asset.duration - sourceIn;

    function onMove(moveEvent: MouseEvent | TouchEvent) {
      const point = clientPoint(moveEvent);
      const raw = ((point.x - trackRect.left) / trackRect.width) * asset.duration - grabOffsetSeconds;
      const clamped = Math.max(0, Math.min(raw, maxSourceIn));
      setSourceIn(clamped);
      seekPreview(clamped);
    }
    function onEnd() {
      removeListeners();
    }
    const removeListeners = addDragListeners(onMove, onEnd);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center sm:p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t("Trim clip")}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md overflow-hidden rounded-t-xl border border-white/10 bg-[#12151c] shadow-2xl sm:rounded-xl"
      >
        <div className="flex items-center justify-between border-b border-white/10 p-4">
          <h2 className="text-sm font-semibold text-white">{t("Trim clip")}</h2>
          <button onClick={onClose} className="rounded p-1 text-white/50 transition hover:bg-white/10 hover:text-white">
            <Close size={16} />
          </button>
        </div>

        <div className="p-4">
          <video
            ref={videoRef}
            src={mediaUrl(projectId, asset.relPath, Boolean(asset.libraryMediaId))}
            muted
            playsInline
            preload="auto"
            onLoadedMetadata={() => seekPreview(sourceIn)}
            className="aspect-video w-full rounded-lg bg-black object-contain"
          />

          <p className="mt-3 text-center text-xs text-white/60">
            {t("Showing {start} – {end} of {total}", {
              start: formatDuration(sourceIn),
              end: formatDuration(sourceIn + requiredLength),
              total: formatDuration(asset.duration),
            })}
          </p>

          <div ref={trackRef} className="relative mt-2 h-10 touch-none rounded-md bg-white/5" onMouseDown={beginDrag} onTouchStart={beginDrag}>
            <div
              className="absolute inset-y-0 flex cursor-grab items-center justify-center rounded-md bg-sky-500/80 text-white/90 shadow-lg active:cursor-grabbing"
              style={{
                left: `${(sourceIn / asset.duration) * 100}%`,
                width: `${(requiredLength / asset.duration) * 100}%`,
              }}
            >
              <span className="text-[10px] font-medium">{formatDuration(requiredLength)}</span>
            </div>
          </div>

          {maxSourceIn <= 0 && (
            <p className="mt-2 text-center text-[11px] text-white/40">{t("This clip is exactly the length needed — nothing to trim.")}</p>
          )}
        </div>

        <div className="flex gap-2 border-t border-white/10 p-4">
          <button
            onClick={onClose}
            className="flex-1 rounded-md bg-white/10 py-2 text-sm font-medium text-white/80 transition hover:bg-white/15"
          >
            {t("Cancel")}
          </button>
          <button
            onClick={() => onConfirm(sourceIn)}
            className="flex-1 rounded-md bg-sky-500 py-2 text-sm font-semibold text-white transition hover:bg-sky-400"
          >
            {t("Use this")}
          </button>
        </div>
      </div>
    </div>
  );
}
