"use client";

import { useEffect, useRef, useState } from "react";
import { compositeTransitionFrame } from "../playback/PlaybackEngine.ts";
import type { TransitionType } from "../project/types.ts";

const TILE_WIDTH = 96;
const TILE_HEIGHT = 54;
/** One full 0 -> 1 sweep, in ms. Sweeps back down to 0 afterward rather than jump-cutting — a
 *  thumbnail that's supposed to demonstrate smooth motion shouldn't itself stutter on every loop. */
const LOOP_MS = 1400;

/** Builds one panel canvas — plain black, or (once the real thumbnail has loaded) that image
 *  cover-fit into the tile, same crop math as CSS `object-fit: cover`. Black is both the "no adjacent
 *  clip on this side" case AND the "still loading"/"adjacent clip has no thumbnail at all" case
 *  (a text/color-matte neighbor, or a video whose thumbnail hasn't generated yet) — deliberately not
 *  distinguished from each other: either way there's nothing real yet to show, and a real, reported
 *  ask was specifically "show black" for exactly this, not a placeholder color standing in for it. */
function buildPanel(image: HTMLImageElement | null): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = TILE_WIDTH;
  canvas.height = TILE_HEIGHT;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, TILE_WIDTH, TILE_HEIGHT);
  if (image && image.naturalWidth > 0 && image.naturalHeight > 0) {
    const scale = Math.max(TILE_WIDTH / image.naturalWidth, TILE_HEIGHT / image.naturalHeight);
    const drawWidth = image.naturalWidth * scale;
    const drawHeight = image.naturalHeight * scale;
    ctx.drawImage(image, (TILE_WIDTH - drawWidth) / 2, (TILE_HEIGHT - drawHeight) / 2, drawWidth, drawHeight);
  }
  return canvas;
}

/** Loads `url` as an `HTMLImageElement`, `null` while there's nothing to load or it hasn't resolved
 *  yet — a real, reported request: these tiles used to show two flat placeholder colors regardless of
 *  what was actually on the timeline, which didn't help distinguish (say) two different wipe tiles from
 *  each other any more than real footage would, AND misled about what the transition will actually look
 *  like against this project's own content. `cancelled` guards against a slow-loading image finishing
 *  after `url` has already changed (a fast re-hover onto a different clip) from stomping a newer load. */
function useThumbnailImage(url: string | null): HTMLImageElement | null {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!url) {
      setImage(null);
      return;
    }
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (!cancelled) setImage(img);
    };
    img.src = url;
    return () => {
      cancelled = true;
    };
  }, [url]);
  return image;
}

/** How a resting (unhovered) tile is drawn: paused at the MIDPOINT of the sweep, not progress 0 — a
 *  flat color block at 0 looks identical across every type (nothing has moved yet), while the
 *  midpoint is where a wipe/slide/circle's actual geometry is most recognizable at a glance without
 *  needing to hover at all. */
const REST_PROGRESS = 0.5;

/** One thumbnail in the transition picker grid — renders `type` through the exact same
 *  `compositeTransitionFrame` a real clip's canvas preview uses, fed the REAL outgoing/incoming clip's
 *  own thumbnail (or plain black when that side has no adjacent clip, or the clip has no thumbnail —
 *  see `buildPanel`'s own comment) instead of a generic placeholder. A faithful, project-specific
 *  preview (the real wipe edge, the real slide direction, AND what will actually be on each side of
 *  it), not a decorative stand-in. Only animates on hover — sitting at `REST_PROGRESS` otherwise — so
 *  a 13-tile grid isn't running 13 concurrent rAF loops the instant it opens; a static frame per idle
 *  tile is plenty until the user actually points at one. */
export function TransitionPreviewTile({
  type,
  outgoingThumbnailUrl,
  incomingThumbnailUrl,
}: {
  type: TransitionType;
  /** The clip content on the FADING-OUT side — the previous clip's thumbnail for an "In" preview, or
   *  the clip being edited's own thumbnail for an "Out" preview. `null` shows plain black. */
  outgoingThumbnailUrl: string | null;
  /** The clip content on the FADING-IN side — the clip being edited's own thumbnail for an "In"
   *  preview, or the next clip's thumbnail for an "Out" preview. `null` shows plain black. */
  incomingThumbnailUrl: string | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hovered, setHovered] = useState(false);
  const outgoingImage = useThumbnailImage(outgoingThumbnailUrl);
  const incomingImage = useThumbnailImage(incomingThumbnailUrl);

  // Sizing/DPR setup only — runs once per mount, independent of `hovered` toggling below, so hovering
  // on and off doesn't repeatedly reset the canvas's own backing store for no reason.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = TILE_WIDTH * dpr;
    canvas.height = TILE_HEIGHT * dpr;
    canvas.getContext("2d")?.scale(dpr, dpr);
  }, []);

  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    const outgoing = buildPanel(outgoingImage);
    const incoming = buildPanel(incomingImage);

    function paint(progress: number) {
      ctx!.clearRect(0, 0, TILE_WIDTH, TILE_HEIGHT);
      compositeTransitionFrame(ctx!, TILE_WIDTH, TILE_HEIGHT, type, progress, outgoing, incoming);
    }

    if (!hovered) {
      paint(REST_PROGRESS);
      return;
    }

    let frameId: number;
    function draw(now: number) {
      const t = (now % LOOP_MS) / LOOP_MS;
      const progress = t < 0.5 ? t * 2 : 2 - t * 2;
      paint(progress);
      frameId = requestAnimationFrame(draw);
    }
    frameId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frameId);
  }, [type, hovered, outgoingImage, incomingImage]);

  return (
    <canvas
      ref={canvasRef}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ width: TILE_WIDTH, height: TILE_HEIGHT }}
      className="rounded border border-white/10 bg-black/40"
    />
  );
}
