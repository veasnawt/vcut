import type { TextStyle } from "./types.ts";

const round = (n: number) => Math.round(n * 100) / 100;

/** Resize a text style as a whole: the font size scales to `fontSize`, and every size that is measured in pixels
 *  next to it (outline widths, shadow offsets and blur, glow, letter spacing, word bounce) scales by the same
 *  factor. Dragging a text's corner handle or pinching it should look like zooming the finished text, not grow the
 *  letters inside a border that stays the same thickness. Everything else (colours, alignment, position) is kept. */
export function scaleTextStyle(style: TextStyle, fontSize: number): TextStyle {
  if (!(style.fontSize > 0) || fontSize === style.fontSize) return { ...style, fontSize };
  const k = fontSize / style.fontSize;
  const next: TextStyle = { ...style, fontSize };
  next.strokeWidth = round(style.strokeWidth * k);
  if (style.strokeWidth2 !== undefined) next.strokeWidth2 = round(style.strokeWidth2 * k);
  next.shadowOffsetX = round(style.shadowOffsetX * k);
  next.shadowOffsetY = round(style.shadowOffsetY * k);
  if (style.shadowBlur !== undefined) next.shadowBlur = round(style.shadowBlur * k);
  if (style.shadows) next.shadows = style.shadows.map((s) => ({ ...s, offsetX: round(s.offsetX * k), offsetY: round(s.offsetY * k), blur: round(s.blur * k) }));
  if (style.glowBlur !== undefined) next.glowBlur = round(style.glowBlur * k);
  if (style.letterSpacing !== undefined) next.letterSpacing = round(style.letterSpacing * k);
  if (style.wordBounce !== undefined) next.wordBounce = round(style.wordBounce * k);
  return next;
}
