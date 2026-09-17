/** Animated stickers and GIFs (the Stickers tool — `StickersPanel.tsx`, `stickers/route.ts`).
 *
 *  An animated sticker is an ordinary IMAGE asset (`Asset.kind === "image"`) that also carries
 *  `Asset.animation` — so everything an image clip already gets (overlay tracks, transform handles,
 *  keyframes, effects, stretching to any length) works unchanged, and only the two places that actually
 *  read pixels over time need to know it moves:
 *
 *  - Preview (`PlaybackEngine`) draws the current frame out of a SPRITE SHEET (`animation.spriteRelPath`,
 *    every frame tiled in a grid). Not the animated file itself: Safari still can't decode an animated
 *    image frame by frame (no `ImageDecoder`), and an `<img>` animates on its own wall clock, which
 *    would never line up with the timeline, scrubbing, or export.
 *  - Export (`buildExportPlan.ts`) loops the animated PNG at `relPath` (`-stream_loop -1`) and trims
 *    to the clip's starting point inside the loop in the filter graph.
 *
 *  Both sides pick frames with the same rule — `animationFrameIndex` — at a constant frame rate the
 *  import normalized the source to, so preview and export show the same frame at the same time. */

export interface AssetAnimation {
  /** Frames in one loop. Always ≥ 2 — a single-frame source imports as a plain still image. */
  frameCount: number;
  /** Constant playback rate every frame is held for. The import resamples the source's own (often
   *  uneven, GIF-style) frame delays to this. */
  fps: number;
  /** The preview sprite sheet, relative to the thumbnails directory (served like a thumbnail). Frames
   *  run left to right, then top to bottom. */
  spriteRelPath: string;
  columns: number;
  rows: number;
  /** One frame's size inside the sprite sheet — smaller than the asset's own `width`/`height` (the
   *  full-size animated PNG export uses), same aspect ratio. */
  frameWidth: number;
  frameHeight: number;
}

/** Where a picked sticker or GIF came from — for attribution, and so the panel can tell what's already
 *  in the project. */
export interface AssetStickerSource {
  provider: StickerProvider;
  type: StickerType;
  id: string;
}

export type StickerProvider = "klipy" | "giphy";
export type StickerType = "stickers" | "gifs";

/** Credits one GIPHY sticker or GIF costs to add (hosted only). GIPHY's production API is a paid
 *  license; KLIPY's is free, so KLIPY picks cost nothing. Searching is always free. */
export const GIPHY_ITEM_CREDITS = 2;

const MAX_FPS = 30;
/** Keeps the sprite sheet (and the animated PNG) a sane size for long GIFs: past this many frames the
 *  frame rate drops instead. */
const MAX_FRAMES = 240;
/** Longest source kept — anything longer is cut to its first this-many seconds. */
export const MAX_ANIMATION_SECONDS = 20;
/** Long edge of the full-size animated PNG export reads. Sticker/GIF sources are rarely larger. */
const EXPORT_MAX_EDGE = 720;
/** Long edge of one preview frame, and of the whole sprite sheet. 4096 stays inside every mobile
 *  browser's image-size limits; a frame's decoded memory is what the preview canvas actually shows. */
const SPRITE_FRAME_MAX_EDGE = 360;
const SPRITE_MAX_EDGE = 4096;

export interface AnimationPlan {
  fps: number;
  frameCount: number;
  exportWidth: number;
  exportHeight: number;
  frameWidth: number;
  frameHeight: number;
  columns: number;
  rows: number;
}

/** Decides how a probed animated source gets normalized: a constant frame rate, how many frames that
 *  yields, the export size, and the sprite sheet's grid and frame size. Pure, so the import route and
 *  tests agree on the exact numbers. `frames` is the source's own frame count (for its average rate). */
export function planAnimation(source: { width: number; height: number; duration: number; frames: number }): AnimationPlan {
  const duration = Math.min(Math.max(source.duration, 0.05), MAX_ANIMATION_SECONDS);
  const sourceFps = source.frames > 0 && source.duration > 0 ? source.frames / source.duration : 10;
  const fps = Math.max(1, Math.min(MAX_FPS, Math.round(sourceFps), Math.floor(MAX_FRAMES / duration)));
  const frameCount = Math.max(2, Math.round(duration * fps));

  const exportScale = Math.min(1, EXPORT_MAX_EDGE / Math.max(source.width, source.height));
  const exportWidth = Math.max(2, Math.round(source.width * exportScale));
  const exportHeight = Math.max(2, Math.round(source.height * exportScale));

  return { fps, frameCount, exportWidth, exportHeight, ...spriteGrid(frameCount, exportWidth, exportHeight) };
}

/** The sprite sheet's grid and per-frame size for `frameCount` frames of an `exportWidth`×`exportHeight`
 *  animation — split out so the import can redo it with the frame count the conversion actually
 *  produced, when resampling lands a frame off the plan. */
export function spriteGrid(frameCount: number, exportWidth: number, exportHeight: number): Pick<AnimationPlan, "columns" | "rows" | "frameWidth" | "frameHeight"> {
  const columns = Math.ceil(Math.sqrt(frameCount));
  const rows = Math.ceil(frameCount / columns);
  const frameEdge = Math.min(SPRITE_FRAME_MAX_EDGE, Math.floor(SPRITE_MAX_EDGE / Math.max(columns, rows)));
  const frameScale = Math.min(1, frameEdge / Math.max(exportWidth, exportHeight));
  return {
    columns,
    rows,
    frameWidth: Math.max(1, Math.round(exportWidth * frameScale)),
    frameHeight: Math.max(1, Math.round(exportHeight * frameScale)),
  };
}

export function animationLoopDuration(animation: Pick<AssetAnimation, "frameCount" | "fps">): number {
  return animation.frameCount / animation.fps;
}

/** `sourceTime` wrapped into one loop — where inside the animation a clip is at that source time. */
export function animationLoopOffset(animation: Pick<AssetAnimation, "frameCount" | "fps">, sourceTime: number): number {
  const loop = animationLoopDuration(animation);
  const wrapped = sourceTime % loop;
  return wrapped < 0 ? wrapped + loop : wrapped;
}

/** Which frame shows at `sourceTime` (the clip's `sourceIn` plus time into the clip) — the frame whose
 *  start time is the latest one not after it, which is also the frame FFmpeg's `overlay` picks on
 *  export. The small epsilon keeps a time that lands exactly on a frame boundary from rounding down to
 *  the previous frame through float error — including the loop point, which wraps to frame 0. */
export function animationFrameIndex(animation: Pick<AssetAnimation, "frameCount" | "fps">, sourceTime: number): number {
  const offset = animationLoopOffset(animation, sourceTime);
  return Math.floor(offset * animation.fps + 1e-6) % animation.frameCount;
}

/** The sprite-sheet rectangle for one frame. */
export function animationFrameRect(animation: AssetAnimation, frameIndex: number): { x: number; y: number; width: number; height: number } {
  return {
    x: (frameIndex % animation.columns) * animation.frameWidth,
    y: Math.floor(frameIndex / animation.columns) * animation.frameHeight,
    width: animation.frameWidth,
    height: animation.frameHeight,
  };
}

/** Lenient parse for `Asset.animation` from a saved project — anything malformed means "not
 *  animated" (the asset still shows as a still image) rather than a project that won't open. */
export function parseAssetAnimation(value: unknown): AssetAnimation | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const r = value as Record<string, unknown>;
  const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
  if (
    !positive(r.frameCount) ||
    r.frameCount < 2 ||
    !positive(r.fps) ||
    typeof r.spriteRelPath !== "string" ||
    !r.spriteRelPath ||
    !positive(r.columns) ||
    !positive(r.rows) ||
    !positive(r.frameWidth) ||
    !positive(r.frameHeight)
  ) {
    return undefined;
  }
  return {
    frameCount: Math.round(r.frameCount),
    fps: r.fps,
    spriteRelPath: r.spriteRelPath,
    columns: Math.round(r.columns),
    rows: Math.round(r.rows),
    frameWidth: Math.round(r.frameWidth),
    frameHeight: Math.round(r.frameHeight),
  };
}

export function parseStickerSource(value: unknown): AssetStickerSource | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const r = value as Record<string, unknown>;
  if ((r.provider !== "klipy" && r.provider !== "giphy") || (r.type !== "stickers" && r.type !== "gifs") || typeof r.id !== "string") {
    return undefined;
  }
  return { provider: r.provider, type: r.type, id: r.id };
}
