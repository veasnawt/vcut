"use client";

import { useEffect, useRef, useState } from "react";
import { Close, Pause, Play } from "@veasnawt/vicons";
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
  // Plays just the selected window, on a loop — so a pick can be judged by watching it, not only by
  // scrubbing its first frame. Read through a ref inside the playback loop, since the window can move
  // while it plays.
  const [playing, setPlaying] = useState(false);
  const [playFraction, setPlayFraction] = useState(0);
  const sourceInRef = useRef(sourceIn);
  sourceInRef.current = sourceIn;

  function seekPreview(value: number) {
    if (videoRef.current) videoRef.current.currentTime = value;
  }

  function pausePreview() {
    videoRef.current?.pause();
    setPlaying(false);
  }

  function togglePlay() {
    const video = videoRef.current;
    if (!video) return;
    if (playing) {
      pausePreview();
      return;
    }
    const start = sourceInRef.current;
    if (video.currentTime < start || video.currentTime >= start + requiredLength - 0.05) video.currentTime = start;
    // With sound — the tap itself is the gesture that allows it. Falls back to silent playback if the
    // browser still refuses, rather than not playing at all.
    video.muted = false;
    video.play().then(
      () => setPlaying(true),
      () => {
        video.muted = true;
        video.play().then(
          () => setPlaying(true),
          () => setPlaying(false)
        );
      }
    );
  }

  // Loops the window: checked every frame rather than on `timeupdate` (only ~4 times a second, which
  // would run a quarter-second past the window's end before jumping back).
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      const video = videoRef.current;
      if (!video) return;
      const start = sourceInRef.current;
      if (video.currentTime >= start + requiredLength || video.ended) {
        video.currentTime = start;
        if (video.paused) void video.play().catch(() => setPlaying(false));
      }
      setPlayFraction(Math.min(1, Math.max(0, (video.currentTime - start) / requiredLength)));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, requiredLength]);

  // `onLoadedMetadata` alone missed a real case: if the browser already had this video's metadata
  // cached (a re-open of the same dialog, or the asset was recently played elsewhere), `loadedmetadata`
  // can fire before React's own listener is attached, leaving the preview stuck on frame 0 regardless
  // of `sourceIn` until the user actually dragged. Checking `readyState` on mount catches that case —
  // same "don't rely on an event that might have already fired" pattern `VideoFrameThumbnail.tsx` uses.
  useEffect(() => {
    if (videoRef.current && videoRef.current.readyState >= 1) seekPreview(sourceIn);
    // Only on mount (and if the asset itself changes) — every subsequent seek during a drag already
    // goes through `beginDrag`'s own `seekPreview` calls; re-running this on every `sourceIn` change
    // would fight a live drag by re-seeking to the STALE value this closure captured.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset.id]);

  function beginDrag(event: React.MouseEvent | React.TouchEvent) {
    const track = trackRef.current;
    if (!track || maxSourceIn <= 0) return;
    preventDefaultIfMouse(event);
    // Moving the window means choosing a new spot — stop playing and scrub instead.
    if (playing) pausePreview();
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
          <div className="relative">
            <video
              ref={videoRef}
              src={mediaUrl(projectId, asset.relPath, Boolean(asset.libraryMediaId))}
              muted
              playsInline
              preload="auto"
              onLoadedMetadata={() => seekPreview(sourceIn)}
              onClick={togglePlay}
              className="aspect-video w-full cursor-pointer rounded-lg bg-black object-contain"
            />
            <button
              onClick={togglePlay}
              aria-label={playing ? t("Pause") : t("Play")}
              title={playing ? t("Pause") : t("Play")}
              className="absolute bottom-2 left-2 flex h-9 w-9 items-center justify-center rounded-full bg-black/60 text-white backdrop-blur-sm transition hover:bg-black/80"
            >
              {playing ? <Pause size={16} /> : <Play size={16} />}
            </button>
          </div>

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
              {playing && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-y-1 w-0.5 rounded-full bg-white shadow"
                  style={{ left: `${playFraction * 100}%` }}
                />
              )}
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
