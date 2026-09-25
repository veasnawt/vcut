"use client";

import { useEffect, useRef } from "react";
import { layoutUnits } from "../playback/textLayout.ts";
import { CASCADE_TYPES, computeTextInOutTransform, computeUnitTextInOut, isCascadeInOutType, TEXT_INOUT_DEFAULT_DURATION } from "../timeline/textAnimation.ts";
import type { TextInOutType } from "../project/types.ts";

const TILE_WIDTH = 84;
const TILE_HEIGHT = 48;
const SAMPLE_TEXT = "ABC123";
const FONT_SIZE = 13;
const BASE_COLOR = "#38bdf8";
/** One preview loop: the animation plays, the text rests, then it repeats — long enough to read the motion
 *  and short enough that the tile keeps demonstrating it. */
const LOOP_SECONDS = 2.2;
/** The tile plays the same curve a real clip does, but a touch slower than the default 0.6s so the motion
 *  reads at thumbnail size. */
const TILE_DURATION = TEXT_INOUT_DEFAULT_DURATION + 0.2;
/** A cascade needs more room for its stagger to read at thumbnail size. */
const CASCADE_TILE_DURATION = 1.3;
const WORD_SAMPLE_TEXT = "ABC 123";

/** One always-animating thumbnail in the In / Out animation grid — draws the sample through
 *  `computeTextInOutTransform`, the same pure function the live preview and (as FFmpeg expressions) the
 *  export are built from. `mode` picks the entrance (progress 0 -> 1 at the start of the loop) or the
 *  exit (1 -> 0 at the end of it). */
export function TextInOutPreviewTile({ type, mode }: { type: TextInOutType; mode: "in" | "out" }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = TILE_WIDTH * dpr;
    canvas.height = TILE_HEIGHT * dpr;
    ctx.scale(dpr, dpr);

    let frameId: number;
    // Cascades draw one letter / word at a time through the same `computeUnitTextInOut` a real clip uses.
    const cascade = isCascadeInOutType(type) ? CASCADE_TYPES[type] : null;
    const cascadeText = cascade?.unit === "word" ? WORD_SAMPLE_TEXT : SAMPLE_TEXT;
    function drawCascade(elapsed: number) {
      const spec = { type, duration: CASCADE_TILE_DURATION };
      const units = layoutUnits([cascadeText], cascade!.unit)[0];
      ctx!.font = `700 ${FONT_SIZE}px sans-serif`;
      ctx!.textAlign = "left";
      ctx!.textBaseline = "alphabetic";
      ctx!.fillStyle = BASE_COLOR;
      const total = ctx!.measureText(cascadeText).width;
      const baseX = TILE_WIDTH / 2 - total / 2;
      const y = TILE_HEIGHT / 2 + FONT_SIZE * 0.35;
      ctx!.clearRect(0, 0, TILE_WIDTH, TILE_HEIGHT);
      for (const unit of units) {
        const tr = computeUnitTextInOut(mode === "in" ? spec : undefined, mode === "out" ? spec : undefined, elapsed, LOOP_SECONDS, FONT_SIZE, unit.info);
        if (tr.alpha <= 0.002) continue;
        const x = baseX + ctx!.measureText(cascadeText.slice(0, unit.start)).width;
        const px = x + ctx!.measureText(unit.text).width / 2;
        const py = y - FONT_SIZE * 0.35;
        ctx!.save();
        ctx!.globalAlpha = Math.min(1, tr.alpha);
        ctx!.translate(tr.dx, tr.dy);
        ctx!.translate(px, py);
        ctx!.scale(tr.scale, tr.scale);
        ctx!.translate(-px, -py);
        ctx!.fillText(unit.text, x, y);
        ctx!.restore();
      }
    }
    function draw(now: number) {
      const elapsed = (now / 1000) % LOOP_SECONDS;
      if (cascade) {
        drawCascade(elapsed);
        frameId = requestAnimationFrame(draw);
        return;
      }
      const progress = mode === "in" ? elapsed / TILE_DURATION : (LOOP_SECONDS - elapsed) / TILE_DURATION;
      const { dx, dy, scale, alpha } = computeTextInOutTransform(type, progress, FONT_SIZE);
      ctx!.clearRect(0, 0, TILE_WIDTH, TILE_HEIGHT);
      ctx!.font = `700 ${FONT_SIZE}px sans-serif`;
      ctx!.textAlign = "center";
      ctx!.textBaseline = "middle";
      ctx!.fillStyle = BASE_COLOR;
      ctx!.globalAlpha = alpha;
      ctx!.save();
      ctx!.translate(TILE_WIDTH / 2 + dx, TILE_HEIGHT / 2 + dy);
      ctx!.scale(scale, scale);
      ctx!.fillText(SAMPLE_TEXT, 0, 0);
      ctx!.restore();
      ctx!.globalAlpha = 1;
      frameId = requestAnimationFrame(draw);
    }
    frameId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frameId);
  }, [type, mode]);

  return <canvas ref={canvasRef} style={{ width: TILE_WIDTH, height: TILE_HEIGHT }} className="rounded border border-white/10 bg-black/40" />;
}
