import type { ClipOutline } from "../project/types.ts";

/** The most outline a clip can have, in sequence pixels (each pixel of thickness is one filter pass on export). */
export const MAX_OUTLINE_WIDTH = 24;
/** The most glow blur, in sequence pixels. */
export const MAX_OUTLINE_GLOW = 60;

/** True when the outline changes nothing (no thickness and no glow). */
export function isIdentityOutline(outline: ClipOutline | undefined): boolean {
  return !outline || (outline.width <= 0 && outline.glow <= 0);
}

/** Extra transparent space added around a clip so its outline and glow have room to be drawn. */
export function outlineMargin(outline: ClipOutline): number {
  return Math.ceil(Math.max(0, outline.width) + Math.max(0, outline.glow) * 2) + 2;
}

function rgb(hex: string): { r: number; g: number; b: number } {
  const valid = /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : "#ffffff";
  return { r: parseInt(valid.slice(1, 3), 16), g: parseInt(valid.slice(3, 5), 16), b: parseInt(valid.slice(5, 7), 16) };
}

/** FFmpeg filter lines that draw a coloured outline (`width` px around the clip's visible shape) and a soft glow behind
 *  the clip, from the stream labelled `input` to `output`. The clip is padded first so nothing is cut off; the padding is
 *  even on every side, so the clip stays centred where it was.
 *
 *  How: the visible shape is the alpha channel. Growing it by `width` passes of `dilation` gives the outline's shape; a
 *  flat-colour copy of the clip given that alpha is the outline. The glow is the same shape blurred (`gblur`) and
 *  brightened, in its own colour, under the outline. The original clip goes on top. `n` formats numbers the way the rest
 *  of the export graph does. */
export function buildOutlineLines(input: string, output: string, outline: ClipOutline, n: (value: number) => string): string[] {
  const width = Math.min(MAX_OUTLINE_WIDTH, Math.max(0, Math.round(outline.width)));
  const glow = Math.min(MAX_OUTLINE_GLOW, Math.max(0, outline.glow));
  const margin = outlineMargin({ ...outline, width, glow });
  const line = rgb(outline.color);
  const glowRgb = rgb(outline.glowColor ?? outline.color);
  const key = `${output}_o`;
  const hasGlow = glow > 0;
  const lines: string[] = [];

  const copies = 2 + (hasGlow ? 1 : 0);
  const labels = ["base", "line", ...(hasGlow ? ["glow"] : []), "shape"];
  lines.push(
    `[${input}]format=rgba,pad=w=iw+${2 * margin}:h=ih+${2 * margin}:x=${margin}:y=${margin}:color=black@0,split=${labels.length}` +
      labels.map((l) => `[${key}_${l}]`).join("")
  );
  void copies;

  // The grown shape (or just the clip's own shape when there's only a glow).
  const dilate = Array.from({ length: width }, () => "dilation").join(",");
  lines.push(`[${key}_shape]alphaextract${dilate ? `,${dilate}` : ""},split=${hasGlow ? 2 : 1}[${key}_m1]${hasGlow ? `[${key}_m2]` : ""}`);

  lines.push(`[${key}_line]lutrgb=r=${line.r}:g=${line.g}:b=${line.b}[${key}_linec]`);
  lines.push(`[${key}_linec][${key}_m1]alphamerge[${key}_outline]`);

  let under = `${key}_outline`;
  if (hasGlow) {
    lines.push(`[${key}_m2]gblur=sigma=${n(glow / 2)},lut=y='clip(val*2,0,255)'[${key}_gm]`);
    lines.push(`[${key}_glow]lutrgb=r=${glowRgb.r}:g=${glowRgb.g}:b=${glowRgb.b}[${key}_glowc]`);
    lines.push(`[${key}_glowc][${key}_gm]alphamerge[${key}_glowl]`);
    lines.push(`[${key}_glowl][${key}_outline]overlay=format=auto[${key}_under]`);
    under = `${key}_under`;
  }
  lines.push(`[${under}][${key}_base]overlay=format=auto[${output}]`);
  return lines;
}
