/** Preview proxies: a small, universally playable copy of a video the browser can't play itself.
 *
 *  Browsers only play a handful of codecs. A ProRes, DNxHD, MPEG-2, WMV or (outside Safari/Chrome-with-hardware)
 *  HEVC file imports fine — the server probes and thumbnails it with FFmpeg — but the preview `<video>` just
 *  errors, leaving a black canvas with no explanation. Export never has the problem (FFmpeg reads the original),
 *  so the fix is a lightweight H.264 copy used for PREVIEW only, made the first time the browser reports it
 *  can't play the original. This module is the pure part: names and command lines. */

/** Longest side of the proxy's shorter dimension. 720p is plenty for a preview canvas and keeps it fast to make. */
export const PROXY_MAX_HEIGHT = 720;

/** `clip.mov` -> `clip-proxy.mp4`, next to the original. Idempotent for a name that is already a proxy. */
export function proxyRelPathFor(relPath: string): string {
  const dot = relPath.lastIndexOf(".");
  const stem = dot > 0 ? relPath.slice(0, dot) : relPath;
  return stem.endsWith("-proxy") ? `${stem}.mp4` : `${stem}-proxy.mp4`;
}

/** Whether `relPath` is itself a generated proxy (never proxy a proxy). */
export function isProxyRelPath(relPath: string): boolean {
  const dot = relPath.lastIndexOf(".");
  return (dot > 0 ? relPath.slice(0, dot) : relPath).endsWith("-proxy");
}

/** FFmpeg arguments for the proxy: H.264 yuv420p (plays everywhere), scaled down to at most `PROXY_MAX_HEIGHT`
 *  tall (never up), constant frame rate (so seeking is frame-accurate even when the source is variable-rate —
 *  phone footage often is), AAC audio, `+faststart` so playback can begin before the file is fully downloaded.
 *  `fps` is the source's frame rate when known, clamped to 24..60. */
export function buildProxyArgs(input: string, output: string, fps?: number): string[] {
  const rate = fps && Number.isFinite(fps) ? Math.min(60, Math.max(24, Math.round(fps))) : 30;
  return [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    input,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-vf",
    `scale=-2:'min(${PROXY_MAX_HEIGHT},ih)',fps=${rate},format=yuv420p`,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "26",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    output,
  ];
}
