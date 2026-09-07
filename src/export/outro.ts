import { DEFAULT_TEXT_STYLE } from "../project/types.ts";
import type { TextStyle } from "../project/types.ts";

/** Shared between the server (`studios/vcut/app/api/vcut/export/route.ts`, which actually renders and
 *  appends the end card) and the client (`Preview.tsx`'s own live preview of it, and `Timeline.tsx`'s
 *  non-editable end-of-timeline marker) so the two can never drift apart — a duration/scale/asset-id
 *  change on one side with no matching change on the other would make the CLIENT's preview stop
 *  matching what the server actually appends. Every value here is exactly what `export/route.ts`'s own
 *  `buildOutroOnlyProject` already used before this file existed — moved here, not duplicated, so
 *  there's still exactly one source of truth for each. */

/** Bump this whenever ANY function/constant in this file changes what the outro actually LOOKS like
 *  (a duration, a scale, a color, the text/position math, ...) — `export/route.ts`'s own
 *  `getOrRenderOutroVariant` folds this into its persistent, disk-cached render's filename
 *  (`outro-v{N}-{width}x{height}-{fps}fps.mp4`, under `VCUT_ROOT`, which survives restarts/redeploys).
 *  Confirmed a real, reported bug, not hypothetical: adding the "VCut" wordmark (and later re-centering
 *  it) changed what `buildOutroOnlyProject` renders, but every resolution/fps combination some earlier
 *  export had ALREADY rendered and cached kept serving that stale, pre-change file indefinitely —
 *  nothing about the cache key itself ever changed, so nothing ever invalidated it. Bumping this is
 *  the one required step any FUTURE visual change here also needs, or it will hit the exact same bug:
 *  the code will be correct, but already-cached exports won't reflect it until this changes too. */
export const OUTRO_CACHE_VERSION = 2;

/** Total on-screen time for the appended outro end card. */
export const OUTRO_DURATION_SECONDS = 2.5;
/** How long the fade in/out each take, at the very start and very end of `OUTRO_DURATION_SECONDS` —
 *  short enough not to eat into the "hold" time in between, long enough to read as a deliberate
 *  animation rather than a jarring pop. */
export const OUTRO_FADE_SECONDS = 0.5;
/** How large the logo appears, as `ClipTransform.scale`'s multiplier on top of the automatic
 *  "fit inside frame" base — see that field's own doc comment. `1` would fill the shorter dimension of
 *  the sequence edge-to-edge (this is a square logo); a fraction of that reads as a proper end-card
 *  mark instead of a full-bleed image. */
export const OUTRO_LOGO_SCALE = 0.45;
/** The bundled logo's own real pixel dimensions (`packages/vcut/assets/images/vcut-transparent.png`)
 *  — needed on the synthetic `Asset` both the server's real render AND the client's live preview
 *  build: `buildExportPlan`'s (and `PlaybackEngine`'s) base "fit inside frame" scale is computed FROM
 *  the asset's own `width`/`height`, so getting these wrong would letterbox or stretch the logo
 *  incorrectly regardless of any transform multiplier on top. 600×600 — downscaled from the source
 *  file's original 1254×1254 (still what the app's own header branding uses, a separate file with no
 *  other consumer) for real, confirmed memory-pressure reasons; see git history for the original
 *  measurement this number came from. */
export const OUTRO_LOGO_WIDTH = 600;
export const OUTRO_LOGO_HEIGHT = 600;
/** The bundled outro background's own real pixel size (a plain solid-black square) — see
 *  `outroAssets.ts`'s own top comment for why this is a real bundled image, not
 *  `Asset.kind === "color"`. Its exact value matters far less than the logo's: a flat black image
 *  letterboxes to any sequence size or aspect ratio with black padding either way, so it reads as a
 *  solid black frame regardless. */
export const OUTRO_BG_SIZE = 64;
/** A fixed id, not a freshly-generated one like a real imported asset would get — both the server's
 *  `inputPathFor` (resolving to the bundled PNG on disk) and the client's own `mediaUrlFor` (resolving
 *  to `outroAssetUrl`'s public URL for the same file) match on this exact value instead of a real
 *  asset's `relPath`, which these synthetic assets don't have. Safe from ever colliding with a genuine
 *  asset id: those are always freshly randomly generated, never this fixed string, and this asset only
 *  ever exists in a throwaway, never-persisted `Project` built for one render or one preview frame. */
export const OUTRO_LOGO_ASSET_ID = "outro-logo-vcut";
/** Same reasoning as `OUTRO_LOGO_ASSET_ID`, for the background. */
export const OUTRO_BG_ASSET_ID = "outro-bg-vcut";

/** The two bundled image files themselves — served to the browser by
 *  `studios/vcut/app/api/vcut/outro-assets/[file]/route.ts` (same `publicAssetRoute` convention as
 *  `fonts/[file]`) and read straight off disk server-side by `_lib/outroAssets.ts`'s
 *  `outroLogoPath`/`outroBackgroundPath`. Filenames, not full paths — where they actually live differs
 *  between the two (a public URL vs. a bundled-images directory), only the filename itself is shared. */
export const OUTRO_LOGO_FILE = "vcut-transparent.png";
export const OUTRO_BG_FILE = "vcut-outro-bg.png";

/** The wordmark text drawn below the logo — a real, explicit "the outro should say VCut too, not just
 *  show the mark" request, not something either render path invents its own copy of. */
export const OUTRO_TEXT_CONTENT = "VCut";

/** The logo-plus-wordmark's shared vertical layout — the one place both the logo clip's own
 *  `transform.offsetY` (`outroLogoOffsetY`) and the text's `TextStyle.offsetY` (`outroTextStyle`) come
 *  from, so the two can never be positioned from independent math that drifts apart.
 *
 *  Confirmed a real, reported "only the logo looks centered, the text doesn't" complaint: centering the
 *  LOGO ALONE (`offsetY: 0`, dead center) and then placing the text some fixed gap below it is exactly
 *  what produces that look — the text's own height makes the combined block taller than the logo alone,
 *  so a logo centered on ITS own no longer sits at the center of the whole two-element group; the
 *  extra empty space above the logo versus below the text is the visible symptom. The fix here treats
 *  logo+text as ONE block spanning from the logo's own top edge to the text's own bottom edge, and
 *  shifts BOTH elements up by half that block's height so the BLOCK's center — not the logo's — lands
 *  on the frame's actual center. */
function outroGroupLayout(sequenceWidth: number, sequenceHeight: number): { logoOffsetY: number; textOffsetY: number; fontSize: number } {
  const shortEdge = Math.min(sequenceWidth, sequenceHeight);
  const logoHalfHeight = (shortEdge * OUTRO_LOGO_SCALE) / 2;
  const fontSize = Math.round(shortEdge * 0.085);
  const margin = shortEdge * 0.05;
  const textHalfHeight = (fontSize * DEFAULT_TEXT_STYLE.lineHeightMultiplier) / 2;
  // Both measured from the frame's own center (0) BEFORE any group shift — logo centered on itself,
  // text placed `margin` below the logo's own bottom edge, same gap `outroTextStyle` used before this
  // existed.
  const textOffsetYBeforeShift = logoHalfHeight + margin + textHalfHeight;
  const groupTop = -logoHalfHeight;
  const groupBottom = textOffsetYBeforeShift + textHalfHeight;
  const shift = -(groupTop + groupBottom) / 2;
  return {
    logoOffsetY: Math.round(shift),
    textOffsetY: Math.round(textOffsetYBeforeShift + shift),
    fontSize,
  };
}

/** How far to shift the logo clip's own `transform.offsetY` off dead-center so the logo+wordmark GROUP
 *  (not the logo alone) ends up vertically centered — see `outroGroupLayout`'s own doc comment. Always
 *  negative (shifts the logo UP) since the wordmark always adds height below it. */
export function outroLogoOffsetY(sequenceWidth: number, sequenceHeight: number): number {
  return outroGroupLayout(sequenceWidth, sequenceHeight).logoOffsetY;
}

/** `TextStyle` for the outro's wordmark, as a function of the sequence's own size rather than a fixed
 *  pixel constant — `buildOutroOnlyProject`/`buildOutroPreviewProject` both run against whatever
 *  resolution/aspect ratio the REAL project happens to use, and a fixed font size or offset would sit
 *  right for one and look tiny (or collide with the logo) at another. Scaled off `Math.min(width,
 *  height)` — the same "shorter edge" quantity `computeTransformedBox`'s own `fitScale` uses for the
 *  logo itself (see `OUTRO_LOGO_SCALE`'s own doc comment), so the wordmark's size and its gap below the
 *  logo both grow/shrink in lockstep with the logo across every aspect ratio instead of only being
 *  tuned for one. `offsetY` comes from `outroGroupLayout`, NOT computed independently here — see that
 *  function's own doc comment for why the two positions have to be derived together. */
export function outroTextStyle(sequenceWidth: number, sequenceHeight: number): TextStyle {
  const { textOffsetY, fontSize } = outroGroupLayout(sequenceWidth, sequenceHeight);
  return {
    ...DEFAULT_TEXT_STYLE,
    fontSize,
    bold: true,
    offsetY: textOffsetY,
  };
}
