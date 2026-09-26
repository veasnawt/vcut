import { createClip, createTrack, findAsset, findClip, newId } from "../project/createProject.ts";
import type { Clip, ClipTransform, Project, Track } from "../project/types.ts";
import { IDENTITY_TRANSFORM } from "../project/types.ts";
import { EditError } from "./operations.ts";

/** A rectangle as fractions of the frame (0..1), top-left origin. */
export interface CellRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GridLayout {
  id: string;
  label: string;
  cells: CellRect[];
}

const even = (cols: number, rows: number): CellRect[] =>
  Array.from({ length: cols * rows }, (_, i) => ({ x: (i % cols) / cols, y: Math.floor(i / cols) / rows, w: 1 / cols, h: 1 / rows }));

/** Collage layouts. Cells are fractions of the frame; `gap` is applied when a layout is used. */
export const GRID_LAYOUTS: GridLayout[] = [
  { id: "side-by-side", label: "Side by side", cells: even(2, 1) },
  { id: "stacked", label: "Stacked", cells: even(1, 2) },
  { id: "grid-2x2", label: "2 × 2", cells: even(2, 2) },
  { id: "columns-3", label: "3 columns", cells: even(3, 1) },
  { id: "rows-3", label: "3 rows", cells: even(1, 3) },
  { id: "grid-3x3", label: "3 × 3", cells: even(3, 3) },
  {
    id: "big-left",
    label: "Big + 2",
    cells: [
      { x: 0, y: 0, w: 0.6, h: 1 },
      { x: 0.6, y: 0, w: 0.4, h: 0.5 },
      { x: 0.6, y: 0.5, w: 0.4, h: 0.5 },
    ],
  },
  {
    id: "big-top",
    label: "Big top + 2",
    cells: [
      { x: 0, y: 0, w: 1, h: 0.6 },
      { x: 0, y: 0.6, w: 0.5, h: 0.4 },
      { x: 0.5, y: 0.6, w: 0.5, h: 0.4 },
    ],
  },
];

export function findGridLayout(id: string): GridLayout | undefined {
  return GRID_LAYOUTS.find((layout) => layout.id === id);
}

/** A cell in frame pixels, shrunk by `gapPx` on every side that touches another cell or the frame edge. */
export function cellToPixels(cell: CellRect, frameWidth: number, frameHeight: number, gapPx: number): { x: number; y: number; w: number; h: number } {
  const half = gapPx / 2;
  const x = cell.x * frameWidth + half;
  const y = cell.y * frameHeight + half;
  return { x, y, w: Math.max(2, cell.w * frameWidth - gapPx), h: Math.max(2, cell.h * frameHeight - gapPx) };
}

/** The transform that makes a source of `sourceWidth × sourceHeight` fill `cell` (frame pixels), cropping the overflow —
 *  "cover", like a photo in a grid. Uses a symmetric crop so the visible part stays centred on the cell. Keeps the base
 *  transform's rotation out of it: a cell fill is unrotated. */
export function cellFillTransform(
  sourceWidth: number,
  sourceHeight: number,
  frameWidth: number,
  frameHeight: number,
  cell: { x: number; y: number; w: number; h: number },
  base: ClipTransform = IDENTITY_TRANSFORM
): ClipTransform {
  const fit = Math.min(frameWidth / sourceWidth, frameHeight / sourceHeight);
  const fitW = sourceWidth * fit;
  const fitH = sourceHeight * fit;
  const scale = Math.max(cell.w / fitW, cell.h / fitH);
  const visibleX = Math.min(1, cell.w / (fitW * scale));
  const visibleY = Math.min(1, cell.h / (fitH * scale));
  const cropX = (1 - visibleX) / 2;
  const cropY = (1 - visibleY) / 2;
  return {
    ...base,
    scale,
    rotationDeg: 0,
    offsetX: Math.round(cell.x + cell.w / 2 - frameWidth / 2),
    offsetY: Math.round(cell.y + cell.h / 2 - frameHeight / 2),
    crop: { top: cropY, bottom: cropY, left: cropX, right: cropX },
  };
}

function sourceSize(project: Project, clip: Clip): { width: number; height: number } {
  const asset = findAsset(project, clip.assetId);
  return { width: asset?.width || project.sequence.width, height: asset?.height || project.sequence.height };
}

const isPicture = (project: Project, clip: Clip): boolean => {
  const asset = findAsset(project, clip.assetId);
  return asset?.kind === "video" || asset?.kind === "image" || asset?.kind === "color";
};

function nextVideoTrackName(tracks: Track[]): string {
  let max = 0;
  for (const t of tracks) {
    if (t.kind !== "video") continue;
    const match = /^\D*(\d+)$/.exec(t.name);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `V${max + 1}`;
}

export interface GridOptions {
  /** Space between cells (and around the edge), in frame pixels. */
  gap: number;
  /** Cells with no clip get a copy of one of the selected clips (cycling through them) instead of staying empty. */
  fillWithCopies: boolean;
  /** Make the clips play at the same time: each starts where the earliest one starts, on a track of its own. Without this the
   *  clips keep their timing, and a collage only shows all its cells while they happen to overlap. */
  playTogether?: boolean;
}

/** One cell's content: an existing clip (by id), or a media file to add as a new clip in that cell. */
export type CellSource = string | { assetId: string };

const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number): boolean => aStart < bEnd - 1e-6 && bStart < aEnd - 1e-6;

/** Arranges clips into a layout's cells, in the order given (cell 1 first). Each entry is an existing clip (resized and cropped
 *  to fill its cell) or `{ assetId }`, media to add as a new clip in that cell — starting where the earliest existing clip starts
 *  and lasting as long as it does (a video shorter than that plays through once). With `playTogether`, the existing clips are
 *  first moved to start together, each on its own track. With `fillWithCopies`, leftover cells get copies on new tracks above
 *  the topmost source track. Returns the ids of every clip now in a cell, in cell order. */
export function applyGridLayout(project: Project, sources: readonly CellSource[], layoutId: string, options: GridOptions): { project: Project; clipIds: string[] } {
  const layout = findGridLayout(layoutId);
  if (!layout) throw new EditError("Unknown layout");
  const draft = structuredClone(project);
  const frameW = draft.sequence.width;
  const frameH = draft.sequence.height;

  type Found = NonNullable<ReturnType<typeof findClip>>;
  const slots = sources.slice(0, layout.cells.length).map((entry): { found: Found } | { assetId: string } | null => {
    if (typeof entry === "string") {
      const found = findClip(draft, entry);
      return found && isPicture(draft, found.clip) ? { found } : null;
    }
    const asset = findAsset(draft, entry.assetId);
    return asset && (asset.kind === "video" || asset.kind === "image" || asset.kind === "color") ? { assetId: entry.assetId } : null;
  });
  const existing: Found[] = slots.flatMap((slot) => (slot && "found" in slot ? [slot.found] : []));
  if (existing.length === 0 && !slots.some((slot) => slot && "assetId" in slot)) throw new EditError("Select a video or image clip first");

  const anchorStart = existing.length > 0 ? Math.min(...existing.map((f) => f.clip.timelineStart)) : 0;
  const anchorLength = existing.length > 0 ? Math.max(...existing.map((f) => f.clip.sourceOut - f.clip.sourceIn)) : 5;

  const trackIndexOf = (id: string) => draft.sequence.tracks.findIndex((t) => t.id === id);
  const usedTracks = new Set<string>();
  const insertAbove = () => Math.max(...existing.map((f) => trackIndexOf(f.track.id)), -1) + 1;
  const addTrackWith = (clip: Clip): void => {
    const track = createTrack("video", nextVideoTrackName(draft.sequence.tracks));
    track.clips = [clip];
    draft.sequence.tracks.splice(insertAbove(), 0, track);
    usedTracks.add(track.id);
  };
  const removeFromOwner = (trackId: string, clipId: string): void => {
    const owner = draft.sequence.tracks.find((t) => t.id === trackId)!;
    owner.clips = owner.clips.filter((c) => c.id !== clipId);
  };

  const placed: string[] = [];
  slots.forEach((slot, index) => {
    if (!slot) return;
    const px = cellToPixels(layout.cells[index], frameW, frameH, options.gap);
    if ("found" in slot) {
      const { clip, track } = slot.found;
      const size = sourceSize(draft, clip);
      const length = clip.sourceOut - clip.sourceIn;
      const needsMove = Boolean(options.playTogether) && clip.timelineStart !== anchorStart;
      const ownTrack = draft.sequence.tracks.find((t) => t.id === track.id)!;
      const clash = needsMove && ownTrack.clips.some((other) => other.id !== clip.id && overlaps(anchorStart, anchorStart + length, other.timelineStart, other.timelineStart + (other.sourceOut - other.sourceIn)));
      const sharesTrack = Boolean(options.playTogether) && usedTracks.has(track.id);
      if (clash || sharesTrack) {
        // Not free on its own track: take it out and give it a fresh track above the others.
        removeFromOwner(track.id, clip.id);
        const relocated: Clip = { ...clip, timelineStart: options.playTogether ? anchorStart : clip.timelineStart };
        relocated.transform = cellFillTransform(size.width, size.height, frameW, frameH, px, clip.transform);
        delete relocated.transformKeyframes;
        addTrackWith(relocated);
        placed.push(relocated.id);
        return;
      }
      if (needsMove) clip.timelineStart = anchorStart;
      usedTracks.add(track.id);
      clip.transform = cellFillTransform(size.width, size.height, frameW, frameH, px, clip.transform);
      delete clip.transformKeyframes;
      placed.push(clip.id);
    } else {
      const asset = findAsset(draft, slot.assetId)!;
      const length = asset.kind === "video" ? Math.min(asset.duration, anchorLength) : anchorLength;
      const added = createClip({ assetId: asset.id, sourceIn: 0, sourceOut: Math.max(0.1, length), timelineStart: anchorStart });
      const size = { width: asset.width || frameW, height: asset.height || frameH };
      added.transform = cellFillTransform(size.width, size.height, frameW, frameH, px, IDENTITY_TRANSFORM);
      addTrackWith(added);
      placed.push(added.id);
    }
  });

  const filled = slots.length;
  if (options.fillWithCopies && layout.cells.length > filled && placed.length > 0) {
    const pool = placed.map((id) => findClip(draft, id)!.clip);
    for (let cell = filled; cell < layout.cells.length; cell++) {
      const from = pool[(cell - filled) % pool.length];
      const size = sourceSize(draft, from);
      const px = cellToPixels(layout.cells[cell], frameW, frameH, options.gap);
      const copy: Clip = { ...structuredClone(from), id: newId("c") };
      copy.transform = cellFillTransform(size.width, size.height, frameW, frameH, px, from.transform);
      delete copy.transformKeyframes;
      addTrackWith(copy);
      placed.push(copy.id);
    }
  }
  draft.updatedAt = Date.now();
  return { project: draft, clipIds: placed };
}

export interface StackOptions {
  /** How many copies to make behind the clip. */
  count: number;
  /** Position step per copy, in frame pixels. */
  offsetX: number;
  offsetY: number;
  /** Each copy is this fraction smaller than the one in front (0..0.5). */
  scaleStep: number;
  /** Each copy fades by this much more than the one in front (0..1 over the whole stack). */
  fade: number;
  /** Each copy starts this many seconds later than the one in front. */
  delay: number;
}

/** Makes `count` copies of a clip stacked BEHIND it, each stepped in position, smaller and fainter — the "echo" / stacked
 *  subject look. The copies keep everything else (cutout, outline, effects), so an outlined cutout gives outlined copies.
 *  Returns the new clips' ids, nearest copy first. */
export function stackCopies(project: Project, clipId: string, options: StackOptions): { project: Project; clipIds: string[] } {
  const draft = structuredClone(project);
  const found = findClip(draft, clipId);
  if (!found) throw new EditError("That clip no longer exists");
  if (!isPicture(draft, found.clip)) throw new EditError("Stacking works on video and image clips");
  const count = Math.max(1, Math.min(8, Math.round(options.count)));
  const baseIndex = draft.sequence.tracks.findIndex((t) => t.id === found.track.id);
  const original = found.clip;
  const baseTransform = original.transform ?? IDENTITY_TRANSFORM;
  const baseOpacity = original.effects?.opacity ?? 1;
  const ids: string[] = [];

  // Farthest copy first at `baseIndex`, so the nearest ends up directly under the original.
  for (let i = count; i >= 1; i--) {
    const copy: Clip = { ...structuredClone(original), id: newId("c"), echoOf: original.id };
    copy.timelineStart = Math.max(0, original.timelineStart + options.delay * i);
    copy.transform = {
      ...baseTransform,
      offsetX: Math.round(baseTransform.offsetX + options.offsetX * i),
      offsetY: Math.round(baseTransform.offsetY + options.offsetY * i),
      scale: Math.max(0.05, baseTransform.scale * Math.pow(1 - Math.min(0.5, Math.max(0, options.scaleStep)), i)),
    };
    delete copy.transformKeyframes;
    const opacity = Math.max(0.05, baseOpacity * (1 - Math.min(1, Math.max(0, options.fade)) * (i / (count + 1))));
    if (opacity < 1) copy.effects = { ...(original.effects ?? { brightness: 0, contrast: 1, saturation: 1, blur: 0, opacity: 1 }), opacity };
    const track = createTrack("video", nextVideoTrackName(draft.sequence.tracks));
    track.clips = [copy];
    draft.sequence.tracks.splice(baseIndex + (count - i), 0, track);
    ids.unshift(copy.id);
  }
  draft.updatedAt = Date.now();
  return { project: draft, clipIds: ids };
}
