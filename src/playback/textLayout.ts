/** Layout constants shared by BOTH text renderers — `PlaybackEngine`'s canvas compositor and
 *  `buildExportPlan`'s FFmpeg `drawtext` chain — so the numbers themselves can't drift apart even
 *  though the two sites can't share the actual positioning FORMULA (FFmpeg's `x`/`y` are expression
 *  strings evaluated by FFmpeg itself against `text_w`/`text_h`, which only exist once FreeType has
 *  actually shaped the glyphs — there's no number for a JS function here to compute up front).
 *
 *  ## Alignment for multi-line text
 *
 *  `style.align` does TWO jobs, both needed for true per-line alignment: it anchors the overall block
 *  to the frame's left/center/right edge (the `anchorX`/`blockLeft` math below — unchanged, and the
 *  only part single-line text ever needed), and it decides how each individual line sits WITHIN that
 *  block when lines differ in width. `lineWidths` below exists for the second job: `PlaybackEngine
 *  .drawText` uses it to offset each line by `(blockWidth - lineWidths[i])` scaled by `align`, so a
 *  3-line "center" clip centers each line on its own, not just the block as a whole. FFmpeg's
 *  `drawtext` gets the equivalent behavior for free via its own `text_align` option (confirmed live
 *  against this repo's bundled ffmpeg via a real multi-line render — `left`/`center`/`right` map 1:1
 *  onto `TextStyle.align`), which needs no extra geometry from here at all; see
 *  `buildDrawTextStyleParams` in `buildExportPlan.ts`. */

import type { Clip, CustomFontAsset, TextStyle } from "../project/types.ts";
import { resolveFont, resolveFontVariant } from "../project/fonts.ts";
import {
  activeWordIndexFromBoundaries,
  computeClipTextInOut,
  computeTextAnimationTransform,
  DEFAULT_WORD_HIGHLIGHT_COLOR,
  segmentLine,
  splitWords,
  typewriterVisibleContent,
  wordBoundaries,
  type WordTiming,
} from "../timeline/textAnimation.ts";

/** Sequence pixels from the frame edge that `align: "left"`/`"right"` anchor to. */
export const TEXT_MARGIN_PX = 40;

/** Padding around the text block, in sequence pixels, when `TextStyle.backgroundColor` is set. */
export const TEXT_BOX_PADDING = 12;

export interface TextBlockLayout {
  lines: string[];
  lineHeight: number;
  /** Vertical distance from the block's own top edge down to the FIRST line's baseline — derived from
   *  the browser's own real font metrics, not a fontSize-based guess (see `computeTextBlock`'s own
   *  comment on why: Khmer's tall vowel signs and deep subscript consonant stacks give it a much
   *  larger, far-from-symmetric ascent/descent than Latin has, so a Latin-tuned approximation visibly
   *  crowds one edge of the text's own background box instead of centering within it). */
  baselineOffset: number;
  /** Top-left corner and size of the (unrotated) text block, in canvas backing-store (sequence)
   *  pixels — `offsetX`/`offsetY` and the align anchor are already baked in. Rotation, when
   *  `style.rotationDeg` is nonzero, happens AROUND this box's own center — see `PlaybackEngine
   *  .drawText` and `buildExportPlan`'s `buildRotatedDrawTextFilter` for the two (necessarily
   *  different — a `CanvasRenderingContext2D` can rotate around any point directly, FFmpeg's `rotate`
   *  filter can only rotate a buffer around ITS OWN center) ways each renderer achieves the same
   *  visual result. */
  blockLeft: number;
  blockTop: number;
  blockWidth: number;
  blockHeight: number;
  /** Each line's own measured width, same order/index as `lines` — what `PlaybackEngine.drawText`
   *  uses to offset an individual line within `blockWidth` for true per-line center/right alignment
   *  (see this file's own top-of-file comment). `blockWidth` alone (the max) isn't enough for that: it
   *  tells you how WIDE the block is, not how far short of that width any single shorter line falls. */
  lineWidths: number[];
}

export function applyTextTransform(text: string, transform?: "none" | "uppercase" | "lowercase" | "capitalize"): string {
  if (!transform || transform === "none") return text;
  if (transform === "uppercase") return text.toUpperCase();
  if (transform === "lowercase") return text.toLowerCase();
  if (transform === "capitalize") {
    return text.replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return text;
}

/** Measures and positions a text block — the ONE place this math is written, shared by
 *  `PlaybackEngine.drawText` (which then draws it) and `TextTransformHandles` (which needs the same
 *  box, unrotated, to position on-canvas drag/resize/rotate handles). Mutates `context.font`/
 *  `textAlign`/`textBaseline` as a side effect (needed for `measureText` below to measure the right
 *  font) — callers that go on to actually draw rely on this, so they must NOT reset those between
 *  calling this and calling `fillText`.
 *
 *  Resolves `style.fontFamily` via the registry (`fonts.ts`) and clamps `bold`/`italic` to whichever
 *  face that font actually has a file for (`resolveFontVariant`) — so a family missing italic (every
 *  bundled Khmer font) never shows a browser-faked slant here that FFmpeg's export could never
 *  reproduce (it has no file to fake one from). */
export function computeTextBlock(
  context: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  content: string,
  style: TextStyle,
  customFonts: CustomFontAsset[] = []
): TextBlockLayout {
  const transformed = applyTextTransform(content, style.textTransform);
  const lines = transformed.length > 0 ? transformed.split("\n") : [""];
  const font = resolveFont(style.fontFamily, customFonts);
  const variant = resolveFontVariant(font, style.bold, style.italic);
  const weight = variant.bold ? "bold" : "normal";
  const slant = variant.italic ? "italic" : "normal";
  context.font = `${slant} ${weight} ${style.fontSize}px "${font.cssFamily}", sans-serif`;
  context.textBaseline = "alphabetic";
  context.textAlign = "left"; // always left — `blockLeft` below already encodes the align setting.

  if ("letterSpacing" in context) {
    (context as unknown as { letterSpacing: string }).letterSpacing = style.letterSpacing ? `${style.letterSpacing}px` : "0px";
  }

  const lineHeight = style.fontSize * style.lineHeightMultiplier;
  const blockHeight = lineHeight * lines.length;

  const lineMetrics = lines.map((line) => context.measureText(line || " "));
  const lineWidths = lineMetrics.map((m) => m.width);
  const blockWidth = Math.max(...lineWidths);
  const ascent = Math.max(...lineMetrics.map((m) => m.actualBoundingBoxAscent ?? 0)) || style.fontSize * 0.8;
  const descent = Math.max(...lineMetrics.map((m) => m.actualBoundingBoxDescent ?? 0)) || style.fontSize * 0.2;
  const baselineOffset = ascent + (lineHeight - (ascent + descent)) / 2;

  const anchorX = canvasWidth / 2 + style.offsetX;
  const blockLeft = anchorX - blockWidth / 2;
  const blockTop = canvasHeight / 2 + style.offsetY - blockHeight / 2;

  return { lines, lineHeight, baselineOffset, blockLeft, blockTop, blockWidth, blockHeight, lineWidths };
}

/** Draws a text block onto `context` exactly as `PlaybackEngine`'s canvas preview does — extracted out
 *  of `PlaybackEngine.drawText` (which is now a one-line wrapper calling this) so a Khmer-script text
 *  clip's export-time render harness (a headless-browser page, see `khmerTextRenderer.ts`) can call the
 *  IDENTICAL function the live preview uses instead of reimplementing it, guaranteeing byte-for-byte
 *  parity rather than a "should match" approximation. Has no dependency on `PlaybackEngine` itself —
 *  only ever touches its own parameters and `computeTextBlock`, which is why the extraction was a pure
 *  mechanical move with no behavior change. */
export function drawTextFrame(
  context: CanvasRenderingContext2D,
  frameWidth: number,
  frameHeight: number,
  content: string,
  style: TextStyle,
  wordHighlight?: { activeWordIndex: number; highlightColor: string },
  customFonts: CustomFontAsset[] = []
): void {
  const block = computeTextBlock(context, frameWidth, frameHeight, content, style, customFonts);
  const drawLeft = style.rotationDeg !== 0 ? block.blockLeft - style.offsetX : block.blockLeft;
  const drawTop = style.rotationDeg !== 0 ? block.blockTop - style.offsetY : block.blockTop;
  const frameCenterX = frameWidth / 2;
  const frameCenterY = frameHeight / 2;

  context.save();
  if (style.rotationDeg !== 0) {
    context.translate(style.offsetX, style.offsetY);
    context.translate(frameCenterX, frameCenterY);
    context.rotate((style.rotationDeg * Math.PI) / 180);
    context.translate(-frameCenterX, -frameCenterY);
  }

  if (style.opacity !== undefined) {
    context.globalAlpha *= Math.max(0, Math.min(1, style.opacity));
  }
  if (style.blendMode) {
    context.globalCompositeOperation = style.blendMode;
  }

  if (style.backgroundColor) {
    const pad = style.backgroundPadding ?? TEXT_BOX_PADDING;
    const bgX = drawLeft - pad;
    const bgY = drawTop - pad;
    const bgW = block.blockWidth + pad * 2;
    const bgH = block.blockHeight + pad * 2;
    const radius = style.backgroundCornerRadius ?? 0;

    context.save();
    if (style.backgroundOpacity !== undefined) {
      context.globalAlpha *= Math.max(0, Math.min(1, style.backgroundOpacity));
    }
    context.fillStyle = style.backgroundColor;
    if (radius > 0 && typeof (context as unknown as { roundRect?: Function }).roundRect === "function") {
      context.beginPath();
      (context as unknown as { roundRect: Function }).roundRect(bgX, bgY, bgW, bgH, radius);
      context.fill();
    } else {
      context.fillRect(bgX, bgY, bgW, bgH);
    }
    context.restore();
  }

  const firstBaseline = drawTop + block.baselineOffset;
  const lineX = (i: number) => {
    if (style.align === "left") return drawLeft;
    const gap = block.blockWidth - block.lineWidths[i];
    return style.align === "right" ? drawLeft + gap : drawLeft + gap / 2;
  };
  const drawLines = (draw: (line: string, x: number, y: number) => void) =>
    block.lines.forEach((line, i) => draw(line, lineX(i), firstBaseline + block.lineHeight * i));

  if ("letterSpacing" in context) {
    (context as unknown as { letterSpacing: string }).letterSpacing = style.letterSpacing ? `${style.letterSpacing}px` : "0px";
  }

  if (style.glowColor) {
    context.shadowColor = style.glowColor;
    context.shadowOffsetX = 0;
    context.shadowOffsetY = 0;
    context.shadowBlur = style.glowBlur ?? 16;
  } else if (style.shadowColor) {
    context.shadowColor = style.shadowColor;
    context.shadowOffsetX = style.shadowOffsetX;
    context.shadowOffsetY = style.shadowOffsetY;
    context.shadowBlur = style.shadowBlur ?? 0;
  }

  // Secondary outer stroke (layered outlines)
  if (style.strokeColor2 && style.strokeWidth2 && style.strokeWidth2 > 0) {
    context.save();
    context.strokeStyle = style.strokeColor2;
    context.lineWidth = (style.strokeWidth + style.strokeWidth2) * 2;
    context.lineJoin = "round";
    drawLines((line, x, y) => context.strokeText(line, x, y));
    context.restore();
  }

  // Primary stroke
  if (style.strokeColor) {
    context.strokeStyle = style.strokeColor;
    context.lineWidth = style.strokeWidth * 2;
    context.lineJoin = "round";
    drawLines((line, x, y) => context.strokeText(line, x, y));
  }

  // Multi-shadow layers if specified
  if (style.shadows && style.shadows.length > 0) {
    for (const sh of style.shadows) {
      context.save();
      context.shadowColor = sh.color;
      context.shadowOffsetX = sh.offsetX;
      context.shadowOffsetY = sh.offsetY;
      context.shadowBlur = sh.blur;
      context.fillStyle = sh.color;
      drawLines((line, x, y) => context.fillText(line, x, y));
      context.restore();
    }
  }

  // Determine fill (gradient or solid)
  let fill: string | CanvasGradient = style.color;
  if (style.gradient && style.gradient.stops && style.gradient.stops.length >= 2) {
    if (style.gradient.type === "radial") {
      const cx = drawLeft + block.blockWidth / 2;
      const cy = drawTop + block.blockHeight / 2;
      const r = Math.max(block.blockWidth, block.blockHeight) / 2;
      const grad = context.createRadialGradient(cx, cy, 0, cx, cy, r);
      for (const stop of style.gradient.stops) {
        grad.addColorStop(stop.offset, stop.color);
      }
      fill = grad;
    } else {
      const angleRad = ((style.gradient.angleDeg ?? 180) * Math.PI) / 180;
      const cx = drawLeft + block.blockWidth / 2;
      const cy = drawTop + block.blockHeight / 2;
      const halfW = block.blockWidth / 2;
      const halfH = block.blockHeight / 2;
      const r = Math.hypot(halfW, halfH);
      const x0 = cx - Math.sin(angleRad) * r;
      const y0 = cy + Math.cos(angleRad) * r;
      const x1 = cx + Math.sin(angleRad) * r;
      const y1 = cy - Math.cos(angleRad) * r;
      const grad = context.createLinearGradient(x0, y0, x1, y1);
      for (const stop of style.gradient.stops) {
        grad.addColorStop(stop.offset, stop.color);
      }
      fill = grad;
    }
  }

  if (wordHighlight) {
    let globalWordIndex = 0;
    block.lines.forEach((line, i) => {
      const y = firstBaseline + block.lineHeight * i;
      let x = lineX(i);
      for (const token of segmentLine(line)) {
        if (token.text.length === 0) continue;
        if (!token.isWord) {
          x += context.measureText(token.text).width;
          continue;
        }
        context.fillStyle = globalWordIndex === wordHighlight.activeWordIndex ? wordHighlight.highlightColor : fill;
        context.fillText(token.text, x, y);
        x += context.measureText(token.text).width;
        globalWordIndex++;
      }
    });
  } else {
    context.fillStyle = fill;
    drawLines((line, x, y) => context.fillText(line, x, y));
  }

  // Text decorations (underline / line-through)
  if (style.textDecoration && style.textDecoration !== "none") {
    context.save();
    context.strokeStyle = typeof fill === "string" ? fill : style.color;
    context.lineWidth = Math.max(2, Math.round(style.fontSize * 0.06));
    block.lines.forEach((_line, i) => {
      const y = firstBaseline + block.lineHeight * i;
      const x = lineX(i);
      const w = block.lineWidths[i];
      if (style.textDecoration === "underline") {
        const lineY = y + Math.round(style.fontSize * 0.1);
        context.beginPath();
        context.moveTo(x, lineY);
        context.lineTo(x + w, lineY);
        context.stroke();
      } else if (style.textDecoration === "line-through") {
        const lineY = y - Math.round(style.fontSize * 0.28);
        context.beginPath();
        context.moveTo(x, lineY);
        context.lineTo(x + w, lineY);
        context.stroke();
      }
    });
    context.restore();
  }

  context.restore();
}

/** `drawTextFrame`, plus whatever `animation` asks for — extracted out of `PlaybackEngine
 *  .drawAnimatedText` (now a one-line wrapper calling this) for the same reason `drawTextFrame` itself
 *  was extracted: a Khmer-script text clip's export-time render harness needs to reproduce EXACTLY what
 *  the live preview draws for a given elapsed time — including bounce/pulse/typewriter/wordHighlight
 *  state — not a second, potentially-drifting reimplementation of the same animation math.
 *  `elapsedSeconds` is simply `time - clip.timelineStart`, the same value every other per-clip timing
 *  calculation in this codebase already uses. `clipDurationSeconds` is only ever consulted for
 *  `wordHighlight` (see `wordBoundaries`'s own doc comment on why it needs the clip's own length,
 *  unlike every other animation type here). `wordTimings` is `Clip.wordTimings` verbatim — real
 *  per-word timing when Auto Captions' transcription provider returned it (currently Kiri, for Khmer),
 *  `undefined` otherwise, in which case `wordHighlight` timing falls back to spreading evenly across
 *  `clipDurationSeconds` exactly as it always has (see `Clip.wordTimings`'s own doc comment). */
function drawAnimatedTextFrameLoop(
  context: CanvasRenderingContext2D,
  frameWidth: number,
  frameHeight: number,
  content: string,
  style: TextStyle,
  animation: Clip["textAnimation"],
  elapsedSeconds: number,
  clipDurationSeconds: number,
  customFonts: CustomFontAsset[],
  wordTimings?: WordTiming[]
): void {
  if (!animation) {
    drawTextFrame(context, frameWidth, frameHeight, content, style, undefined, customFonts);
    return;
  }
  // `speed` scales the effective elapsed time fed to EVERY animation type uniformly — applied once,
  // here, rather than threading a speed parameter through `computeTextAnimationTransform`/
  // `typewriterVisibleContent`/`wordBoundaries` individually. None of those functions need their own
  // notion of speed this way; they just see a bigger or smaller elapsed-time number than the clip's
  // real playhead position implies.
  const elapsed = elapsedSeconds * (animation.speed ?? 1);

  if (animation.type === "typewriter") {
    drawTextFrame(context, frameWidth, frameHeight, typewriterVisibleContent(content, elapsed), style, undefined, customFonts);
    return;
  }
  if (animation.type === "wordHighlight") {
    const words = splitWords(content);
    const boundaries = wordBoundaries(words.length, clipDurationSeconds, wordTimings);
    const active = activeWordIndexFromBoundaries(boundaries, elapsed);
    drawTextFrame(
      context,
      frameWidth,
      frameHeight,
      content,
      style,
      { activeWordIndex: active, highlightColor: animation.highlightColor ?? DEFAULT_WORD_HIGHLIGHT_COLOR },
      customFonts
    );
    return;
  }

  const { dx, dy, scale, rotationDeg } = computeTextAnimationTransform(animation.type, elapsed);
  // Pivots around the text BLOCK's own real center, from `computeTextBlock`'s `blockLeft`/`blockTop`
  // — which, since the block's own screen position no longer depends on `align` at all (see this
  // file's own top-of-file comment), is now always exactly `frameWidth/2 + style.offsetX` /
  // `frameHeight/2 + style.offsetY` regardless of `align`. Still going through `computeTextBlock`
  // rather than that simpler formula directly: it's the one place this math is written, and staying
  // consistent with it costs nothing (redundant with the measurement `drawTextFrame` below does again
  // via its own `computeTextBlock` call — real but cheap, `measureText` on a short string).
  const block = computeTextBlock(context, frameWidth, frameHeight, content, style, customFonts);
  const pivotX = block.blockLeft + block.blockWidth / 2;
  const pivotY = block.blockTop + block.blockHeight / 2;
  context.save();
  context.translate(dx, dy);
  context.translate(pivotX, pivotY);
  context.rotate((rotationDeg * Math.PI) / 180);
  context.scale(scale, scale);
  context.translate(-pivotX, -pivotY);
  drawTextFrame(context, frameWidth, frameHeight, content, style, undefined, customFonts);
  context.restore();
}

/** Draws one text clip's frame with everything animated: the looping `animation` (bounce, typewriter,
 *  word highlight...) plus the one-shot entrance/exit (`inOut`) layered on top — offsets add, scale is
 *  applied around the text block's own center, opacity multiplies. `inOut` absent (or neutral at this
 *  instant, i.e. mid-clip) takes the exact pre-existing path untouched. Shared by the live preview and the
 *  Khmer browser-render export harness, so both get In/Out for free. */
export function drawAnimatedTextFrame(
  context: CanvasRenderingContext2D,
  frameWidth: number,
  frameHeight: number,
  content: string,
  style: TextStyle,
  animation: Clip["textAnimation"],
  elapsedSeconds: number,
  clipDurationSeconds: number,
  customFonts: CustomFontAsset[],
  wordTimings?: WordTiming[],
  inOut?: { in?: Clip["textAnimationIn"]; out?: Clip["textAnimationOut"] }
): void {
  const io = inOut && (inOut.in || inOut.out) ? computeClipTextInOut(inOut.in, inOut.out, elapsedSeconds, clipDurationSeconds, style.fontSize) : null;
  if (!io || (io.alpha === 1 && io.scale === 1 && io.dx === 0 && io.dy === 0)) {
    drawAnimatedTextFrameLoop(context, frameWidth, frameHeight, content, style, animation, elapsedSeconds, clipDurationSeconds, customFonts, wordTimings);
    return;
  }
  // Pivot on the block's real center, same as the loop animations' own scale/rotate.
  const block = computeTextBlock(context, frameWidth, frameHeight, content, style, customFonts);
  const pivotX = block.blockLeft + block.blockWidth / 2;
  const pivotY = block.blockTop + block.blockHeight / 2;
  context.save();
  context.globalAlpha *= io.alpha;
  context.translate(io.dx, io.dy);
  context.translate(pivotX, pivotY);
  context.scale(io.scale, io.scale);
  context.translate(-pivotX, -pivotY);
  drawAnimatedTextFrameLoop(context, frameWidth, frameHeight, content, style, animation, elapsedSeconds, clipDurationSeconds, customFonts, wordTimings);
  context.restore();
}
