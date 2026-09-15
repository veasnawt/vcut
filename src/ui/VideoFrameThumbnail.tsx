"use client";

import { useEffect, useRef } from "react";

/** Renders the REAL frame at `time` seconds into a video, live — not a pre-generated static image.
 *  Built for exactly one gap: `Asset.thumbnailRelPath` is generated ONCE at import time (near the
 *  start of the file) and never regenerated afterward, so any UI showing it went stale the moment a
 *  clip's own `sourceIn` moved away from that fixed offset — confirmed as a real, reported bug in the
 *  guided template flow (`TemplateFillScreen.tsx`'s slot chips, `TemplatePreviewScreen.tsx`'s own
 *  filmstrip tiles): re-trimming which portion of a video is used never changed what those thumbnails
 *  showed.
 *
 *  A paused `<video>` element still PAINTS whatever frame it's currently seeked to — the same
 *  mechanism `TemplateTrimDialog.tsx`'s own live drag-preview already relies on, just held at one fixed
 *  time instead of following a drag. No canvas capture, no server round trip, no new thumbnail file to
 *  generate/store: the browser already does the seek-and-paint for free once `currentTime` is set past
 *  `loadedmetadata`. Re-seeks whenever `time` itself changes (a fresh trim) — `src` changing (a
 *  Replace) naturally resets `readyState`, so the `loadedmetadata` listener path below still fires. */
export function VideoFrameThumbnail({ src, time, className }: { src: string; time: number; className?: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    function seek() {
      if (video && Math.abs(video.currentTime - time) > 0.01) video.currentTime = time;
    }
    if (video.readyState >= 1) seek();
    else video.addEventListener("loadedmetadata", seek, { once: true });
  }, [src, time]);

  return <video ref={videoRef} src={src} muted playsInline preload="metadata" className={className} />;
}
