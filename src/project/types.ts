/** The core project model. Everything here is PLAIN SERIALIZABLE DATA — no class instances, no
 *  functions, no Dates — so `structuredClone` and a JSON round-trip are both trivially lossless.
 *  That property is what makes undo (which clones state) and save/reopen (which JSON-round-trips it)
 *  correct by construction rather than by careful maintenance. */

import { DEFAULT_FONT_ID } from "./fonts.ts";
import type { AssetAnimation, AssetStickerSource } from "./stickers.ts";

/** Bumped whenever a change to these types would make an older `project.json` misread rather than
 *  merely incomplete. `deserializeProject` refuses anything newer than it understands instead of
 *  silently mangling a project a future version wrote. */
export const PROJECT_SCHEMA_VERSION = 1;

export type AssetKind = "video" | "audio" | "image" | "text" | "color";
export type TrackKind = "video" | "audio" | "text";

/** An imported media file. `relPath` is relative to the project's own media folder — never an
 *  absolute machine path, so a project folder stays portable between machines and between dev and
 *  the packaged app. */
export interface Asset {
  id: string;
  kind: AssetKind;
  /** Original filename as imported, shown in the library. */
  name: string;
  /** Path relative to the project's media directory (e.g. "clip-a1b2.mp4"). */
  relPath: string;
  /** Path relative to the project's thumbnails directory; absent until one is generated (images
   *  use themselves, audio has none). One SINGLE representative frame — what the Media Library shows,
   *  where one frame is the more useful preview than a filmstrip would be. */
  thumbnailRelPath?: string;
  /** A small H.264 copy of a video the browser couldn't play (ProRes, DNxHD, MPEG-2, HEVC on browsers without
   *  it...), used for PREVIEW ONLY and made on demand the first time playback fails — see
   *  `export/proxyCommands.ts`. Export always reads the original `relPath`. Video assets only. */
  proxyRelPath?: string;
  /** Path to a SPRITE SHEET of several evenly-spaced frames from across the source, tiled in a single
   *  row — video only. What the Timeline tiles across a clip's width for an actual (if approximate)
   *  filmstrip, as opposed to `thumbnailRelPath`'s one frame: tiling that single frame repeatedly
   *  looks like a stamp, not a filmstrip, since it's the exact same image over and over rather than
   *  different points in the source. Optional/absent (not a hard failure) the same way
   *  `thumbnailRelPath` is — a project imported before this existed, or a source FFmpeg couldn't
   *  sample enough distinct frames from, still opens and just falls back to the single-frame tiling
   *  `TimelineClip` already had. */
  filmstripRelPath?: string;
  /** Path to a PNG waveform image (peaks over the asset's FULL duration, transparent background) —
   *  audio only. One static image per asset, the same "generate once at import, let CSS handle
   *  per-clip positioning" split `filmstripRelPath` uses: `TimelineClip` stretches/offsets it via
   *  `background-size`/`background-position` percentages to match each clip's own trim and on-screen
   *  width, rather than regenerating a new image per placement. Optional/absent the same way the other
   *  two are — a project imported before this existed, or a source FFmpeg couldn't read, still opens
   *  and just shows a flat-color clip. */
  waveformRelPath?: string;
  /** Seconds. Images have no intrinsic duration — they get `IMAGE_DEFAULT_DURATION` when placed. */
  duration: number;
  width?: number;
  height?: number;
  fps?: number;
  hasAudio: boolean;
  sizeBytes: number;
  /** Epoch millis. A number rather than a Date specifically to keep this JSON-round-trippable. */
  importedAt: number;
  /** Set when the file backing this asset can't be found on disk — the UI shows "Media Offline"
   *  and offers Relink rather than pretending the clip is fine. */
  offline?: boolean;
  /** Set on an asset created by `VoiceoverRecorder` — it still exists as a normal `Asset` (a placed
   *  clip references it by id like any other), but `MediaLibrary` excludes it from the list. A quick
   *  voiceover take is meant to live on the timeline, not clutter the library with one-off recordings
   *  the user never deliberately "imported" — absent (the default) for everything else, including a
   *  plain drag-dropped audio file. */
  hiddenFromLibrary?: boolean;
  /** Set only on an asset created by AI image/video generation (`generateAiImage`/
   *  `startAiVideoGeneration` in `editorStore.ts`) — carries just enough to rebuild the AI tab's own
   *  generation-history tile (`AiGeneratePanel.tsx`'s `aiGenerations`, a plain in-memory list with no
   *  persistence of its own) after a reload. Without this, refreshing the browser mid-session made
   *  every past generation's tile vanish even though the real asset it produced was never lost — it
   *  was sitting right there in `project.assets`, just with nothing left connecting it back to "this
   *  came from a generation, here's the prompt that made it." */
  aiGeneration?: { prompt: string; aspectRatio: string; model?: string };
  /** Set on an asset an AI tool made FROM another asset (a cutout, an AI edit, an object removal): which asset it came
   *  from and the recipe that was applied. Lets "Save as template" turn the slot into the ORIGINAL footage and repeat the
   *  same AI step on whatever media a template user picks. */
  aiOrigin?: { sourceAssetId: string; step: AiRecipeStep };
  /** Present ONLY on a VIDEO or IMAGE asset inside a saved template's own stored structure (see
   *  `sanitizeProjectForTemplate` in `template.ts`) — and, transiently, on the placeholder a brand-new
   *  project-from-template starts with, before "fill in your media" replaces it with a real asset. NOT
   *  used for audio — see `templateBundledAudio` below for why music/voiceover is handled differently.
   *  Marks this as a stand-in for a real file that was deliberately stripped when the template was
   *  saved: `relPath` is `""` (no real file, same convention a text asset's own empty `relPath` already
   *  uses), and `duration`/`width`/`height`/`hasAudio` describe what the ORIGINAL clip needed, not
   *  anything actually playable yet. Never present on a real project's own asset once every slot has
   *  been filled — `fillTemplateSlot` (`template.ts`) removes it the moment a real asset is bound in. */
  templatePlaceholder?: {
    /** Ordering across every placeholder in the template, timeline order — what the "fill in your
     *  media" picker's own numbered slots key off (see `templateSlots` in `template.ts`). */
    slotIndex: number;
    /** Seconds — the trim window's own length the ORIGINAL clip used (`sourceOut - sourceIn`). The
     *  media a user picks to fill this slot needs to cover at least this much; shorter source media is
     *  used in full (the clip's own timeline length shrinks to match) rather than looped or held,
     *  same "an editor should never silently synthesize frames that were never really there" reasoning
     *  every other trim operation in this app already follows. */
    requiredDuration: number;
  };
  /** Present ONLY on an audio asset inside a saved template's own stored structure — asked for
   *  directly: unlike a video/image clip (which is deliberately turned into a fillable slot, since the
   *  whole visual content is meant to be replaced), a template's background music/voiceover is part of
   *  its own identity and should just carry over unchanged for every future use, the same way CapCut's
   *  own templates keep their song. The real audio FILE is bundled with the template itself (see
   *  `_lib/paths.ts`'s own `templateAudioPaths`, server-side) rather than referencing whichever project
   *  happened to save the template — `relPath` still points at a real, playable file the whole time
   *  (unlike `templatePlaceholder`'s always-empty one), just relative to the TEMPLATE's own storage
   *  once saved, and copied into each new project's own `mediaDir` fresh (a real, independent file, not
   *  a shared/symlinked one) the moment someone starts a project from it — never present on a real
   *  project's own asset for that reason: by the time it reaches `project.assets`, it's indistinguishable
   *  from any other imported audio file. */
  templateBundledAudio?: true;
  /** Present only on an ANIMATED image — a sticker or GIF from the Stickers tool. `relPath` is then an
   *  animated PNG that export loops, and this describes the preview sprite sheet and frame timing. See
   *  `stickers.ts` for how preview and export stay on the same frame. */
  animation?: AssetAnimation;
  /** Present only on an asset added from the Stickers tool — which provider and item it came from. */
  stickerSource?: AssetStickerSource;
  /** Present only when `kind === "text"`. A text asset has no backing file — `relPath` is an empty
   *  string and `hasAudio` is always false — its "content" is this string, authored directly rather
   *  than imported. Lives on the ASSET (not the clip) for the same reason a video's pixels do: it's
   *  what the asset intrinsically IS, not something that varies per placement on the timeline. */
  textContent?: string;
  /** Present only when `kind === "text"`, alongside `textContent`. */
  textStyle?: TextStyle;
  /** Present only when `kind === "color"` — a solid-fill "color matte" background asset, same
   *  no-backing-file shape as a text asset (`relPath` empty, `hasAudio` false, `duration` 0): its
   *  "content" is this one hex value, authored directly rather than imported. Hex, e.g. "#224466".
   *  Read by `PlaybackEngine.drawVideoClip`'s `kind === "color"` branch (a flat-fill canvas stands in
   *  as the `drawImage` source, sized to the FRAME itself since a color matte has no intrinsic
   *  width/height of its own — see `TransformHandles.tsx`'s matching `assetWidth`/`assetHeight`
   *  fallback to `project.sequence.width/height`) and `buildExportPlan.ts`'s equivalent export-time
   *  branch, both of which then run the result through the exact same crop/scale/transform/effects
   *  pipeline every other video-track clip already goes through — a color matte is just a video-track
   *  clip whose "source" is a solid fill instead of a decoded frame. */
  color?: string;
  /** Set only when this asset's real file lives in the user's OWN account-wide media library
   *  (`user_media` in Supabase — see that table's own migration comment) rather than this project's
   *  own storage — the id of that library row. `relPath`/`thumbnailRelPath`/`filmstripRelPath`/
   *  `waveformRelPath` are still populated exactly as they always are (so every existing consumer —
   *  playback, export, thumbnail URLs — keeps working completely unchanged), just resolved against
   *  the library's own media/thumbnails directories instead of this project's, wherever a file
   *  actually gets read off disk (see `media/raw/route.ts`'s own branch on this field). Reusing the
   *  SAME asset (imported or AI-generated once) across many projects is the whole point — see
   *  `user_media`'s own migration comment for the full reasoning. Absent for a plain project-local
   *  asset, exactly as every asset already was before this field existed. */
  libraryMediaId?: string;
  /** Set only on an asset built from a bundled `SFX_REGISTRY` catalog entry (`SfxPanel.tsx`'s "Add",
   *  when `sfxMetadata.generated.ts` has an entry for it) — `relPath` is the entry's own `file`,
   *  resolved against the app's SHARED, immutable `packages/vcut/assets/sfx/` directory instead of this
   *  project's own media (or the account library's), and `waveformRelPath` similarly names a sibling
   *  file in that same bundled directory. Never copied anywhere: the exact same file every user's
   *  export of the same catalog sound reads (`sfxAssetUrl`/`sfxAssetPath`, both keyed by plain
   *  filename) — a real, reported waste otherwise, since a stock sound effect is identical for every
   *  user and doesn't need its own private copy per placement the way a real upload does. Also implies
   *  `hiddenFromLibrary: true` (set alongside this) for the same "already reachable from its own
   *  browsable panel" reasoning that field's own doc comment gives — even though this asset was never
   *  actually imported at all, so there's nothing to keep OUT of the library that could ever have
   *  reached it in the first place; kept for symmetry with older bundled-SFX clips placed before this
   *  field existed, which DID go through the ordinary import path. */
  bundledSfx?: true;
  /** Set on any audio asset added as a SOUND EFFECT — a bundled catalog entry or a "My Sounds" pick
   *  (`SfxPanel.tsx`) — as opposed to music, a voiceover or an ordinary audio import. `bundledSfx` alone
   *  can't say this: a "My Sounds" pick is a plain import, and saving a template (then starting a
   *  project from it) re-imports every audio file as a fresh, ordinary asset, dropping `bundledSfx`
   *  along the way. This one is carried through both steps, so a template project can still tell its
   *  sound effects apart from its music (`isSoundEffectAsset`). */
  soundEffect?: true;
}

export interface TextGradientStop {
  offset: number; // 0 to 1
  color: string;  // Hex or CSS color string
}

export interface TextGradient {
  type: "linear" | "radial";
  angleDeg?: number; // Linear angle in degrees (default 180 = top-to-bottom)
  stops: TextGradientStop[];
}

/** One AI tool application, recorded so a template can run it again. `region` (Remove Object) is normalized 0..1 of the
 *  source frame so it still lines up on media of another size. */
export interface AiRecipeStep {
  tool: "cutout" | "video-cutout" | "ai-edit" | "remove-object";
  prompt?: string;
  strength?: "subtle" | "balanced" | "creative";
  region?: { x: number; y: number; width: number; height: number };
  /** Video cutout: the matted clip carries the original's sound (a replacement) rather than sitting silently above it. */
  keepAudio?: boolean;
  /** This clip is an extra layer above a raw copy of the same footage (Text Behind Subject's cutout layer): if the AI
   *  step can't run, the layer is dropped instead of covering the original with an identical copy. */
  overlay?: boolean;
}

export interface TextShadow {
  color: string;
  offsetX: number;
  offsetY: number;
  blur: number;
}

/** Visual style for a text asset. Simpler than `ClipTransform`: font size already controls "how big"
 *  (no separate scale multiplier), and there's no crop — but position AND rotation are real, on-canvas-
 *  draggable properties, same as a video clip's. */
export interface TextStyle {
  /** A `FontDefinition.id` from the registry in `fonts.ts` — never a raw font-family string, so every
   *  text clip is guaranteed to reference a font this build actually bundles a file for. An unknown id
   *  (an older project, or one hand-edited) falls back to the default font — see `fontById`. */
  fontFamily: string;
  /** Pixels, in SEQUENCE space (matches `fontSize`'s own unit) — font size is resolution-relative,
   *  not resolution-independent the way `ClipTransform`'s crop fractions are, since text needs to be
   *  legible at the sequence's actual pixel size in both the preview and the export. Doubles as the
   *  "resize" handle's target: dragging a corner scales this value directly rather than introducing a
   *  separate multiplier redundant with it. */
  fontSize: number;
  /** Hex, e.g. "#ffffff". */
  color: string;
  bold: boolean;
  italic: boolean;
  align: "left" | "center" | "right";
  /** Hex; absent means no background box — plain text, the more common "title" look. Present enables
   *  a solid box behind the text block, the more common "caption" look. */
  backgroundColor?: string;
  /** Background box opacity multiplier (0..1). Absent means fully opaque. */
  backgroundOpacity?: number;
  /** Background box padding in sequence pixels (absent defaults to TEXT_BOX_PADDING = 12). */
  backgroundPadding?: number;
  /** Background box corner radius in pixels (absent defaults to 0). */
  backgroundCornerRadius?: number;
  /** Hex; absent means no outline. Present draws a `strokeWidth`-pixel border around each glyph — the
   *  classic "white text, black outline" caption look, legible over any footage without needing
   *  `backgroundColor`'s solid box. Both FFmpeg's `drawtext` (`bordercolor`/`borderw`) and Canvas2D
   *  (`strokeText`) draw this the same way: shadow, then outline, then fill, in that order — see
   *  `PlaybackEngine.drawText`'s and `buildExportPlan`'s shared `buildDrawTextStyleParams` comment. */
  strokeColor?: string;
  /** Pixels; only meaningful when `strokeColor` is set — kept as a plain always-present number (not
   *  bundled into an optional sub-object) for the same reason `offsetX`/`offsetY` are, matching this
   *  style object's existing flat shape. */
  strokeWidth: number;
  /** Secondary/outer stroke color for multi-layer / comic / sports outlines. */
  strokeColor2?: string;
  /** Secondary stroke width in sequence pixels. */
  strokeWidth2?: number;
  /** Fill colours cycled across the WORDS of the text (word 1 gets the first, word 2 the second, then it wraps) —
   *  the multi-coloured lettering of a designed text "sticker" ("SKIN" pink, "CARE" orange). Overrides `color` and
   *  `gradient` for the fill only; outlines and shadows are unchanged. Words come from `Intl.Segmenter`, so Khmer
   *  (no spaces) splits into real words too. Absent = one colour. */
  wordColors?: string[];
  /** Degrees each word is rotated, alternating direction (word 1 leans one way, word 2 the other) for a hand-placed,
   *  bouncy sticker look. 0/absent = straight. */
  wordTiltDeg?: number;
  /** Pixels each word is lifted or dropped from the baseline, alternating (odd words up, even words down). */
  wordBounce?: number;
  /** A filled bubble drawn behind words, cycled like `wordColors` (word 1 gets the first entry, and so on).
   *  `"transparent"` (or any empty entry) means no badge for that word — so `["transparent", "#ffe066"]` puts a
   *  yellow bubble behind every second word, the "MY" in "SKINCARE MY DAY". Drawn under the outlines, with the
   *  word's own lean and lift. */
  wordBadgeColors?: string[];
  /** The badge's shape: a rounded `pill` (default) or an `oval`. */
  wordBadgeShape?: "pill" | "oval";
  /** Colour of a thin outline around each badge; absent = no outline. */
  wordBadgeOutline?: string;
  /** Hex; absent means no drop shadow. */
  shadowColor?: string;
  /** Pixels; only meaningful when `shadowColor` is set. FFmpeg's `drawtext` shadow is a hard-edged
   *  offset duplicate of the glyphs, not a blurred shadow — there's no blur radius to control, so
   *  neither renderer has one (Canvas2D's `shadowBlur` is left at 0 to match). */
  shadowOffsetX: number;
  shadowOffsetY: number;
  /** Shadow blur radius in pixels for soft drop shadows. */
  shadowBlur?: number;
  /** Layered multi-shadows for high-end cinematic or pop-art depth. */
  shadows?: TextShadow[];
  /** Radiant glow color. */
  glowColor?: string;
  /** Radiant glow blur radius in sequence pixels. */
  glowBlur?: number;
  /** Multi-stop gradient fill. When set, renders gradient fill on canvas, falling back to `color` on FFmpeg drawtext. */
  gradient?: TextGradient;
  /** Extra letter spacing in sequence pixels. */
  letterSpacing?: number;
  /** Casing transform: uppercase, lowercase, capitalize, or none. */
  textTransform?: "none" | "uppercase" | "lowercase" | "capitalize";
  /** Text decoration: underline or line-through. */
  textDecoration?: "none" | "underline" | "line-through";
  /** Overall text opacity multiplier (0..1). */
  opacity?: number;
  /** Canvas compositing blend mode (e.g. screen, overlay, multiply). */
  blendMode?: GlobalCompositeOperation;
  /** Multiplies `fontSize` to get the vertical space each line occupies — was a hardcoded constant
   *  (`textLayout.ts`'s old `LINE_HEIGHT_MULTIPLIER`) until this became a real per-style field. */
  lineHeightMultiplier: number;
  /** Pixels from center, SEQUENCE space — same convention as `ClipTransform.offsetX/Y`. 0,0 is
   *  centered. */
  offsetX: number;
  offsetY: number;
  /** Degrees, clockwise, around the text block's OWN center (not the frame's) — same "never clamped,
   *  a multi-turn drag can exceed 360" convention as `ClipTransform.rotationDeg`. */
  rotationDeg: number;
}

/** The default a freshly-created text asset starts with. Exported so every consumer (creation,
 *  Inspector reset, tests) starts from the same values. Centered, unrotated, no background box, no
 *  outline, no shadow — the "title" look, since that's the more neutral default; captions are a
 *  background-color (or stroke, or shadow) click away. `strokeWidth`/`shadowOffsetX/Y` carry sensible
 *  values ready for the moment `strokeColor`/`shadowColor` gets set, the same way `backgroundColor`
 *  being unset doesn't stop `TEXT_BOX_PADDING` from already being a sensible constant. */
export const DEFAULT_TEXT_STYLE: TextStyle = {
  fontFamily: DEFAULT_FONT_ID,
  // 96, not the original 64 — a real, explicit "make new text bigger by default" request. 64px on a
  // typical 1080-wide sequence read as noticeably small relative to the frame, closer to a caption
  // than the bold, easy-to-read-at-a-glance title text most short-form video text overlays actually
  // want as their starting point (font size here is always true SEQUENCE pixels, not CSS/preview
  // pixels — see this field's own doc comment).
  fontSize: 96,
  color: "#ffffff",
  bold: false,
  italic: false,
  align: "center",
  strokeWidth: 3,
  shadowOffsetX: 2,
  shadowOffsetY: 2,
  lineHeightMultiplier: 1.2,
  offsetX: 0,
  offsetY: 0,
  rotationDeg: 0,
};

/** Position/scale/rotation/crop for a video or image clip, applied identically by the preview
 *  compositor and by export (see PlaybackEngine's `drawTransformed` and buildExportPlan's per-clip
 *  filter chain) so what's previewed is what gets rendered.
 *
 *  Pipeline order, fixed and identical on both renderers: crop the source rect (in the source's own
 *  unrotated pixel space) → scale-to-fit the CROPPED dimensions into the sequence frame → apply the
 *  user `scale` multiplier on top → rotate around center → translate by offset. */
export interface ClipTransform {
  /** Pixels in SEQUENCE space, additional translation from center. 0,0 is centered. */
  offsetX: number;
  offsetY: number;
  /** Multiplier on top of the automatic "fit inside frame" scale. 1 is the untransformed fit — values
   *  above 1 zoom in, which combined with offset is what makes "resize to fill" possible without a
   *  separate mode. */
  scale: number;
  /** Degrees, clockwise. Deliberately never clamped or wrapped — a multi-turn drag can exceed 360,
   *  and rotating by an exact 90° or 270° isn't treated specially. Any real number is valid. */
  rotationDeg: number;
  /** Fractions (0..1) of the SOURCE's own width/height, cropped before any other stage — resolution-
   *  independent regardless of the source's native size. Each pair (`top`+`bottom`, `left`+`right`)
   *  is clamped by `setClipTransform` to leave at least a sliver visible; a crop can never produce a
   *  zero or negative-size rect. */
  crop: { top: number; right: number; bottom: number; left: number };
}

export type ClipMaskShape = "rectangle" | "ellipse";

/** A non-destructive mask in the transformed clip's normalized local space. */
export interface ClipMask {
  shape: ClipMaskShape;
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  /** Soft edge as a fraction of the smaller masked dimension. */
  feather: number;
  invert: boolean;
}

export const DEFAULT_CLIP_MASK: ClipMask = {
  shape: "rectangle",
  centerX: 0.5,
  centerY: 0.5,
  width: 0.75,
  height: 0.75,
  feather: 0,
  invert: false,
};

/** One point on a variable-speed curve. `position` is normalized playback progress through the
 *  selected source window; `speed` is the instantaneous source-seconds/timeline-second multiplier. */
export interface SpeedCurvePoint {
  position: number;
  speed: number;
}

/** The untransformed default — what an absent `Clip.transform` means. Exported so every consumer
 *  (Inspector fields, TransformHandles, tests) starts from the same values rather than each hand-
 *  rolling `{ offsetX: 0, ... }` and risking one of them drifting out of sync. */
export const IDENTITY_TRANSFORM: ClipTransform = {
  offsetX: 0,
  offsetY: 0,
  scale: 1,
  rotationDeg: 0,
  crop: { top: 0, right: 0, bottom: 0, left: 0 },
};

/** Whether a transform is a no-op — either absent, or explicitly set to values equivalent to
 *  `IDENTITY_TRANSFORM`. Both `setClipTransform` (which deletes the field entirely rather than
 *  storing an identity object, so undoing a transform edit restores a truly absent field rather than
 *  a structurally-different "empty" one) and `buildExportPlan` (which picks the plain, already-tested
 *  scale+pad filter chain instead of the full crop/scale/rotate/overlay one) key off this. */
export function isIdentityTransform(transform: ClipTransform | undefined): boolean {
  if (!transform) return true;
  return (
    transform.offsetX === 0 &&
    transform.offsetY === 0 &&
    transform.scale === 1 &&
    transform.rotationDeg === 0 &&
    transform.crop.top === 0 &&
    transform.crop.right === 0 &&
    transform.crop.bottom === 0 &&
    transform.crop.left === 0
  );
}

/** Frame-space rectangular crop for a TEXT clip — CSS `overflow: hidden` over the rendered text, NOT
 *  `ClipTransform.crop`'s pre-scale source-pixel crop (text has no source pixels to crop from). Shaped
 *  identically to `ClipTransform.crop` (4 edge-inset fractions, 0..1 — but of the SEQUENCE FRAME's own
 *  width/height, not the text's own dynamically-measured bounding box) purely because that's the
 *  closest existing UI/data precedent in this codebase, not because the two mean the same thing: text
 *  keeps rendering at its normal computed position (`TextStyle.offsetX/offsetY`/`align`), and this crop
 *  is an independent mask over the FRAME on top of that, not a repositioning of the text block itself.
 *  This is the STATIC value — see `Clip.textCropKeyframes` for the animated counterpart, LERP-
 *  interpolated exactly like `ClipTransform.crop` (every field here is plain numeric, so unlike
 *  `ColorGrading`'s curves there's no "no natural correspondence between keyframes" problem to hold
 *  instead of blend). */
export interface TextCrop {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** The untransformed default — full frame visible, no clipping. Mirrors `IDENTITY_TRANSFORM`. */
export const IDENTITY_TEXT_CROP: TextCrop = { top: 0, right: 0, bottom: 0, left: 0 };

/** Mirrors `isIdentityTransform` — both `setClipTextCrop` (identity-collapse) and `buildExportPlan`
 *  (plain vs. isolate/crop/pad/overlay filter chain) key off this. */
export function isIdentityTextCrop(crop: TextCrop | undefined): boolean {
  if (!crop) return true;
  return crop.top === 0 && crop.right === 0 && crop.bottom === 0 && crop.left === 0;
}

/** Static (non-animating) per-clip color/blur adjustments. Video/image clips only — text has its own
 *  separate `TextStyle` system.
 *
 *  Each field's range/convention is picked so preview (Canvas2D `context.filter`) and export
 *  (FFmpeg's `eq`/`gblur` filters) agree as exactly as possible — `opacity`/`saturation`/`contrast`
 *  are exact matches (both renderers already share the same multiplicative convention, 1 = unchanged,
 *  for the latter two), while `brightness` and `blur` are documented APPROXIMATIONS: FFmpeg's
 *  `eq=brightness=` is additive (0 = unchanged) but CSS `brightness()` is multiplicative, and CSS
 *  `blur(Xpx)` uses a different kernel than FFmpeg's `gblur=sigma=X` — close enough for a slider, not
 *  pixel-identical. Same spirit as `textLayout.ts`'s own documented multi-line-alignment
 *  approximation: state the gap plainly rather than silently pretend it doesn't exist. */
export interface ClipEffects {
  /** -1..1, additive, 0 = unchanged (FFmpeg's own `eq` convention). */
  brightness: number;
  /** 0..2, multiplicative, 1 = unchanged. */
  contrast: number;
  /** 0..2, multiplicative, 1 = unchanged; 0 = fully grayscale. */
  saturation: number;
  /** 0..60 sequence pixels (a Gaussian sigma, export's `gblur=sigma=`), 0 = unchanged (no blur). The
   *  preview scales it to the canvas's own device pixels so it looks the same as the export. */
  blur: number;
  /** 0..1, 1 = fully opaque. */
  opacity: number;
}

/** The untransformed default — what an absent `Clip.effects` means. Mirrors `IDENTITY_TRANSFORM`. */
export const IDENTITY_EFFECTS: ClipEffects = {
  brightness: 0,
  contrast: 1,
  saturation: 1,
  blur: 0,
  opacity: 1,
};

/** Mirrors `isIdentityTransform` — both `setClipEffects` (which deletes the field entirely rather
 *  than storing an explicit identity object) and `buildExportPlan` (which picks the plain, already-
 *  tested filter chain instead of the effects-aware one) key off this. */
export function isIdentityEffects(effects: ClipEffects | undefined): boolean {
  if (!effects) return true;
  return (
    effects.brightness === 0 &&
    effects.contrast === 1 &&
    effects.saturation === 1 &&
    effects.blur === 0 &&
    effects.opacity === 1
  );
}

/** Chroma key (green/blue screen) settings for a video/image clip — makes pixels near `color`
 *  transparent so whatever's on the track(s) beneath shows through. Mirrors FFmpeg's own `colorkey`
 *  filter parameters closely (`similarity`→`similarity`, `smoothness`→`blend`) rather than inventing a
 *  different model, specifically so preview (Canvas2D, `PlaybackEngine.applyChromaKey`) and export
 *  (`buildExportPlan`'s `colorkey=` filter) agree as exactly as possible — same "state the algorithm,
 *  don't just approximate it" spirit `ClipEffects`'s own doc comment already follows for
 *  brightness/blur. Static per-clip data, not keyframed — a green screen's key color doesn't need to
 *  animate over a clip's own duration the way position/effects sometimes do, same "not everything needs
 *  a keyframe track" reasoning `textAnimation`/`transitionIn` already follow. */
export interface ChromaKeySettings {
  /** Hex, e.g. "#00ff00" — the color to key OUT (make transparent). */
  color: string;
  /** 0..1, FFmpeg's own `similarity` convention: a pixel within this normalized color-distance of
   *  `color` is keyed out entirely. Larger keys out more shades/lighting variation around `color`, at
   *  the risk of also eating into the subject if it shares that color. */
  similarity: number;
  /** 0..1, FFmpeg's own `blend` convention: pixels JUST beyond `similarity`'s cutoff ramp from fully
   *  transparent to fully opaque over this additional distance, instead of a hard edge — the standard
   *  "feather the key's boundary" control every chroma-key tool exposes, just named for what it does
   *  (how smooth the cutoff is) rather than FFmpeg's more implementation-flavored `blend`. */
  smoothness: number;
}

/** The default a freshly-enabled chroma key starts with — standard green screen, FFmpeg's own
 *  similarity default (0.01) nudged up to 0.4 since that default keys out almost nothing in practice
 *  (real green-screen footage has far more color variation than a studio-perfect 0x00FF00 sample), plus
 *  a touch of smoothness so the cutout edge isn't a hard, aliased line by default. */
export const DEFAULT_CHROMA_KEY: ChromaKeySettings = {
  color: "#00ff00",
  similarity: 0.4,
  smoothness: 0.1,
};

/** One control point of a `ColorCurve`, both axes normalized 0..1 (input level → output level). */
export interface CurvePoint {
  x: number;
  y: number;
}

/** Control points for one tone curve, sorted ascending by `x`. Always includes the two fixed endpoint
 *  anchors (x=0 and x=1) — the UI (`CurveEditor`) never lets those be deleted, only dragged vertically;
 *  interior points are optional. This type only stores the raw editable points — `timeline/colorCurves.ts`'s
 *  spline evaluator is what turns a `ColorCurve` into an actually renderable/appliable LUT. */
export type ColorCurve = CurvePoint[];

/** The untransformed default — a flat diagonal, (0,0) to (1,1), no adjustment. */
export const IDENTITY_CURVE: ColorCurve = [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
];

/** Per-clip RGB curves color grading — four independently-editable curves (the combined "master" tab
 *  plus one per channel), composed per-channel as `master(channel(input))` — see
 *  `timeline/colorCurves.ts`'s `composeLuts` for why that specific order (channel first, master on top),
 *  verified against FFmpeg's own `libavfilter/vf_curves.c` composition loop. This order matters because
 *  export hands these SAME control points straight to FFmpeg's `curves=` filter (`export/curvesFilter.ts`)
 *  rather than a precomputed LUT, so preview and export need to agree on composition order to actually
 *  look the same. */
export interface ColorGrading {
  master: ColorCurve;
  red: ColorCurve;
  green: ColorCurve;
  blue: ColorCurve;
}

/** The untransformed default — every channel a flat diagonal. Mirrors `IDENTITY_EFFECTS`. */
export const IDENTITY_COLOR_GRADING: ColorGrading = {
  master: IDENTITY_CURVE,
  red: IDENTITY_CURVE,
  green: IDENTITY_CURVE,
  blue: IDENTITY_CURVE,
};

/** Mirrors `isIdentityEffects` — both `setClipColorGrading` (identity-collapse) and `buildExportPlan`
 *  (plain vs. curves-aware filter chain) key off this. A curve counts as identity only when it's EXACTLY
 *  the two-point diagonal `IDENTITY_CURVE` is. */
export function isIdentityColorGrading(grading: ColorGrading | undefined): boolean {
  if (!grading) return true;
  const isIdentity = (c: ColorCurve) =>
    c.length === 2 && c[0].x === 0 && c[0].y === 0 && c[1].x === 1 && c[1].y === 1;
  return (
    isIdentity(grading.master) &&
    isIdentity(grading.red) &&
    isIdentity(grading.green) &&
    isIdentity(grading.blue)
  );
}

/** One point in a keyframed animation for a clip property-group (`ClipTransform`, `ClipEffects`, or
 *  `ColorGrading` — never a single field of any of them — see `Clip.transformKeyframes`'s own doc
 *  comment for why). `time` is CLIP-WINDOW-relative seconds (0 = this clip's own `timelineStart`) — the
 *  same "elapsed" space `timeline/textAnimation.ts`'s `elapsedSeconds` and `PlaybackEngine`'s own
 *  repeated inline `time - clip.timelineStart` already use, NOT source-media time. `value` is the FULL
 *  object, never a sparse per-field patch — matches this codebase's pervasive "whole value stored, never
 *  a partial patch" convention (`ClipOverride`, `patchTransform`'s merge-then-replace-whole-object
 *  shape). `id` is a stable identifier (`newId("kf")`) so the UI can select/drag/delete one keyframe
 *  without relying on array index, which shifts under insert. */
export interface Keyframe<T> {
  id: string;
  time: number;
  value: T;
}
export type TransformKeyframe = Keyframe<ClipTransform>;
export type EffectsKeyframe = Keyframe<ClipEffects>;
export type TextStyleKeyframe = Keyframe<TextStyle>;
/** `Keyframe<T>`'s one instance where `T` is a plain `number` rather than a property-group object —
 *  see `Clip.gainKeyframes`'s own doc comment for why gain doesn't need the object-shaped treatment
 *  `TransformKeyframe`/`EffectsKeyframe` do. */
export type GainKeyframe = Keyframe<number>;
/** Held (never interpolated) between keyframes — see `Clip.colorGradingKeyframes`'s own doc comment for
 *  why smoothly cross-fading between two differently-shaped curves isn't attempted in v1. */
export type ColorGradingKeyframe = Keyframe<ColorGrading>;
/** LERP-interpolated between keyframes, like `TransformKeyframe` — see `TextCrop`'s own doc comment. */
export type TextCropKeyframe = Keyframe<TextCrop>;

/** Every transition style either renderer can produce. The live preview
 *  (`PlaybackEngine.compositeTransitionFrame`/`compositeSoloReveal`) and export
 *  (`buildExportPlan`'s `pushTransitionBlend`/`pushSoloTransitionStages`) build each one to the same
 *  shape, sharing their easing and per-style curves through `timeline/transitionMotion.ts`. The names
 *  of the wipe/slide styles follow FFmpeg's `xfade` (`wipeLeft` = `wipeleft`), which export still uses
 *  for those two (re-timed onto the shared easing curve); every other style is composed from native
 *  filters, since `xfade`'s own slice and circle shapes don't match the preview.
 *
 *  `dissolve` is kept only so older projects still load: it is no longer offered in any picker, and
 *  renders exactly like `crossfade`. It used to export as `xfade=dissolve` — a grainy per-pixel noise
 *  reveal — while the preview showed a plain crossfade, so the two looked identical while editing and
 *  different in the file; a crossfade is what anyone who picked it saw and chose.
 *
 *  `glitchCut`/`waterRippleCut`/`zoomBlur`/`whipPanLeft`/`whipPanRight`/`flashZoom` are video/image
 *  clips only — text export (`drawtext`) has no per-pixel pre-pass, so a text clip always fades (see
 *  `TransitionPickerMenu`'s `isTextTrack`). */
export type TransitionType =
  | "crossfade"
  | "dissolve"
  | "wipeLeft"
  | "wipeRight"
  | "wipeUp"
  | "wipeDown"
  | "slideLeft"
  | "slideRight"
  | "slideUp"
  | "slideDown"
  | "sliceUp"
  | "sliceDown"
  | "circleOpen"
  | "circleClose"
  | "glitchCut"
  | "waterRippleCut"
  | "zoomBlur"
  | "whipPanLeft"
  | "whipPanRight"
  | "flashZoom";

/** A continuous MOTION effect for a text clip, distinct from `transitionIn`/`transitionOut` — those
 *  are one-shot events at a clip's own edges (a cut blended/wiped/dissolved into or out of), rendered
 *  identically in preview and export; this is a periodic or progressive effect that plays across the
 *  clip's own ENTIRE visible duration, exactly like the "Bounce"/"Pulse"/"Typewriter" text presets a
 *  captioning or short-form-video tool would offer. `timeline/textAnimation.ts` is the one place the
 *  actual motion math lives (`computeTextAnimationTransform`/`typewriterVisibleContent`) — kept as pure
 *  functions of elapsed time so they're directly unit-testable without a canvas, the same reasoning
 *  `PlaybackEngine.transitionFamily` already follows.
 *
 *  `bounce`/`pulse`/`wiggle`/`typewriter` all render for real in export (see `buildExportPlan.ts`'s
 *  `buildDrawTextFilter`/`buildRotatedDrawTextFilter`) — `bounce`/`pulse` as time-varying `y=`/
 *  `fontsize=` FFmpeg expressions (verified: `x`/`y` there are already `text_w`/`text_h`-relative
 *  expressions FFmpeg re-evaluates every frame, so they re-center correctly on their own as the size/
 *  position animates), `wiggle` via the same ROTATED-text pipeline a static `style.rotationDeg` already
 *  uses (a time-varying `rotate` angle with a FIXED worst-case buffer size — `rotate`'s own `ow=`/`oh=`
 *  can't themselves depend on `t`), and `typewriter` via one chained `drawtext` per revealed-prefix
 *  state (`buildTypewriterDrawTextCalls`), gated to its own `enable=` window. A nonzero STATIC
 *  `style.rotationDeg` combined with `bounce`/`pulse`/`typewriter` is a documented scope cut — that
 *  combination renders as plain static rotated text, animation ignored (the rotated path's frame-center
 *  pivot and the plain path's `text_w`-relative centering are mutually exclusive constructions).
 *
 *  `wordHighlight` renders for real too, but through an entirely different FFmpeg filter —
 *  `subtitles=` (libass), not `drawtext` — since coloring individual WORDS within one string is beyond
 *  what `drawtext` can express, and there's no way to feed one `drawtext` call's measured `text_w` into
 *  another's `x=` (confirmed by re-deriving the filtergraph's actual data-flow model). libass already
 *  links HarfBuzz/FreeType/FriBidi, so it shapes Khmer's complex script (subscript consonants, vowel-
 *  sign reordering) correctly — the reason this reuses libass rather than this app computing its own
 *  glyph advance widths, which would NOT reproduce that shaping correctly. See
 *  `buildWordHighlightSubtitlesFilter`'s own comment for the full reasoning, and `AssFontMetrics` in
 *  `project/fonts.ts` for how a font's real (non-`cssFamily`) name and correct on-screen size are
 *  resolved for libass specifically. Falls back to plain static full text (same as before this existed)
 *  when the exporter hasn't wired up ASS support — currently true only for native/mobile export, where
 *  the bundled FFmpeg engine's own libass support hasn't been confirmed.
 *
 *  `wordHighlight` is the odd one out here: a karaoke/lyrics-style effect where exactly one word is
 *  drawn in a highlight color at a time, jumping word-to-word left-to-right as the clip plays, timed to
 *  spread evenly across the clip's own duration (see `timeline/textAnimation.ts`'s `activeWordIndex`).
 *  Its highlight color is genuinely configurable (`Clip.textAnimation.highlightColor`) — the other four
 *  are fixed motion curves with nothing meaningful to expose as a setting yet. */
export type TextAnimationType = "bounce" | "pulse" | "wiggle" | "float" | "shake" | "heartbeat" | "typewriter" | "wordHighlight";

/** A one-shot text entrance ("In") or exit ("Out") animation — played over the first/last
 *  `TextInOutAnimation.duration` seconds of a text clip, independent of (and stacking with) the clip's
 *  looping `textAnimation`. An "Out" is its "In" played backwards over the clip's final seconds, so each
 *  type here is defined once as an entrance (see `timeline/textAnimation.ts`'s `computeTextInOutTransform`)
 *  and mirrored for exit. Every type is a pure position/scale/opacity change — deliberately no rotation,
 *  so export can express all of them as plain `drawtext` expressions. */
export type TextInOutType =
  | "fade"
  | "slideUp"
  | "slideDown"
  | "slideLeft"
  | "slideRight"
  | "rise"
  | "drop"
  | "pop"
  | "zoomIn"
  | "zoomOut"
  // Cascades: one letter / word at a time, staggered — see `timeline/textAnimation.ts`'s `CASCADE_TYPES`.
  | "letterRise"
  | "letterDrop"
  | "letterFade"
  | "letterPop"
  | "wordRise"
  | "wordFade"
  | "wordPop";

export interface TextInOutAnimation {
  type: TextInOutType;
  /** Seconds. Absent means `TEXT_INOUT_DEFAULT_DURATION`; always clamped to at most half the clip so an
   *  In and an Out on the same clip can never overlap. */
  duration?: number;
}

/** A continuous per-pixel image-processing effect for a video/image clip — glitch (digital-corruption
 *  RGB-channel-split + slice-shift + noise) or water-ripple (a wavy, underwater-reflection sine
 *  displacement) — see `timeline/pixelEffects.ts`'s own `applyGlitch`/`applyWaterRipple` for the pure
 *  canvas functions both preview (`PlaybackEngine.drawTransformed`) and, for the TRANSITION-flavored
 *  version of the same two looks, export's own `buildGlitchCorruptionFilter`/
 *  `buildWaterRippleCorruptionFilter` (`export/buildExportPlan.ts`) implement against. Distinct from
 *  `TransitionType`'s own `glitchCut`/`waterRippleCut` — those are one-shot events at a clip's own
 *  edges; this instead plays across a clip's ENTIRE visible duration, same relationship
 *  `TextAnimationType` has to `transitionIn`/`transitionOut`. */
export type PixelEffectType = "glitch" | "waterRipple";

/** Stable id for a face-effect definition. Kept as a string in saved projects so a preset supplied
 * by a licensed provider can be added or retired without requiring a project-schema migration. The
 * active registry validates ids before a user can apply one; deserialization preserves a safe id so
 * an older project can report a missing preset instead of silently losing the edit. */
export type FaceEffectPresetId = string;

/** The selection model deliberately starts with all faces while leaving a forward-compatible seam
 * for a tracked person. VCut does not expose per-person selection until a provider can prove stable
 * identity tracking across seeking, trimming, preview, and export. */
export type FaceEffectTarget =
  | { kind: "all" }
  | { kind: "trackedFace"; trackingId: string };

/** One non-destructive face manipulation in a clip's ordered face-effect stack. `intensity` is
 * normalized to 0..1; zero is an exact visual identity. The instance id belongs to the edit, while
 * `presetId` identifies reusable rendering metadata. */
export interface FaceEffectInstance {
  id: string;
  presetId: FaceEffectPresetId;
  intensity: number;
  target: FaceEffectTarget;
  /** Disabled effects remain editable and serializable without participating in preview/export. */
  enabled?: boolean;
}

/** How a visual clip combines with already-rendered tracks below it. Canvas and FFmpeg use these
 * exact names, which keeps preview/export mapping explicit and serialization easy to validate. */
export const CLIP_BLEND_MODES = ["normal", "overlay", "screen", "darken", "lighten"] as const;
export type ClipBlendMode = (typeof CLIP_BLEND_MODES)[number];

/** One clip on a track. The heart of non-destructive editing: a clip is a *reference* to a slice of
 *  a source asset plus a position, never a copy of media. Trimming a 10-minute source down to 15
 *  seconds only moves `sourceIn`/`sourceOut` — the file on disk is never touched. */
export interface Clip {
  id: string;
  assetId: string;
  /** Seconds into the source media where this clip begins. */
  sourceIn: number;
  /** Seconds into the source media where this clip ends (exclusive). Always > `sourceIn`. */
  sourceOut: number;
  /** Seconds along the timeline where this clip begins. */
  timelineStart: number;
  /** Mirrors the source around its visual vertical axis. Absent/false is the identity value. Kept
   *  separately from `ClipTransform.scale` so crop geometry, resize handles, and transform
   *  keyframes retain their existing positive-scale contract. */
  flipHorizontal?: boolean;
  /** `flipHorizontal`'s own counterpart — mirrors the source around its visual HORIZONTAL axis
   *  (top/bottom swap) instead of the vertical one. Same identity/independence/composition rules as
   *  `flipHorizontal`: absent/false is the identity value, and a clip can have both flips active at
   *  once (equivalent to a 180° rotation, but tracked as its own pair of flags rather than folded into
   *  `ClipTransform.rotationDeg` — keeps "flip" and "rotate" independently toggleable/undoable, the
   *  same reasoning `flipHorizontal` was already kept out of `ClipTransform.scale` for). */
  flipVertical?: boolean;
  /** Plays a video clip's selected source window from `sourceOut` back to `sourceIn`. */
  reverse?: boolean;
  /** Constant playback multiplier. Absent is the identity value 1. */
  speed?: number;
  /** Variable playback multiplier. When present with at least two points, this replaces `speed`. */
  speedCurve?: SpeedCurvePoint[];
  /** Optional local-space visual mask for image and video clips. */
  mask?: ClipMask;
  /** Absent is Normal/source-over. Only image and video clips expose this in the Inspector. */
  blendMode?: ClipBlendMode;
  /** Absent means untransformed (equivalent to `IDENTITY_TRANSFORM`) — an untouched clip's JSON stays
   *  small, an older `project.json` written before this field existed loads unchanged, and both
   *  renderers can take a cheaper, already-tested code path when there's nothing to apply. */
  transform?: ClipTransform;
  /** Absent means `IDENTITY_EFFECTS` — same reasoning as `transform`. */
  effects?: ClipEffects;
  /** Absent means `IDENTITY_COLOR_GRADING` — same reasoning as `transform`/`effects`. Video/image clips
   *  only, same gating as `effects`. See `ColorGrading`'s own doc comment for the master/channel
   *  composition order this relies on. */
  colorGrading?: ColorGrading;
  /** Present only when Transform keyframing is ARMED for this clip — ordered ascending by `time`, each
   *  `time` clamped to `[0, clipDuration(clip)]`. When present and non-empty, this — NOT `transform` —
   *  is what both renderers resolve, via `timeline/keyframes.ts`'s `resolveClipTransform`. `transform`
   *  itself is left untouched underneath (never read nor deleted while keyframes exist) specifically so
   *  disarming keyframing has a well-defined static value to bake down to. Absent means "not
   *  keyframed" — the existing single-`transform` behavior, completely unchanged; every clip that never
   *  uses this feature sees zero difference. One keyframe = the FULL `ClipTransform` moving together
   *  (all of offsetX/offsetY/scale/rotationDeg/crop at once), not independent per-field sub-tracks —
   *  matches this codebase's "whole object, never a sparse patch stored" convention and keeps the
   *  Inspector UI to one mini-timeline per property-group rather than nine. Video/image clips only,
   *  same gating as `transform` itself. */
  transformKeyframes?: TransformKeyframe[];
  /** Mirrors `transformKeyframes`, for `ClipEffects` — see its own doc comment for the full reasoning. */
  effectsKeyframes?: EffectsKeyframe[];
  /** Mirrors `transformKeyframes`, for `ColorGrading` — same "present+non-empty is what both renderers
   *  resolve, absent means not keyframed" contract, EXCEPT interpolation: unlike transform/effects
   *  (plain numeric `lerp()`), a keyframed curve is HELD, not blended, between keyframes —
   *  `resolveClipColorGrading` (`timeline/keyframes.ts`) just picks whichever keyframe currently applies.
   *  Control points have no natural pointwise correspondence between two differently-shaped curves
   *  (different point counts/positions), so cross-fading control points (or blending the derived LUTs,
   *  which can't be re-edited back into control points for the UI) isn't attempted in v1 — mirrors
   *  `resolveTextStyle`'s own existing precedent of holding non-numeric fields rather than interpolating
   *  them. A clip with two very different curve keyframes will visibly SNAP at the keyframe boundary
   *  rather than crossfade — a deliberate v1 simplification, not an oversight. */
  colorGradingKeyframes?: ColorGradingKeyframe[];
  /** Mirrors `transformKeyframes`, for a TEXT clip's `TextStyle` — same "present+non-empty is what both
   *  renderers resolve, absent means not keyframed" contract. Lives on the CLIP (not the `Asset`, where
   *  the rest of `TextStyle` lives) for the same reason `transformKeyframes` does: `Keyframe.time` is
   *  clip-window-relative, a placement concept, not an asset one — if the same text asset were ever
   *  placed as two clips, each placement needs its own independent keyframe timeline. `resolveTextStyle`
   *  (`timeline/keyframes.ts`) only animates TextStyle's numeric fields (offsetX/offsetY/fontSize/
   *  rotationDeg/strokeWidth/shadowOffsetX/shadowOffsetY/lineHeightMultiplier) — font/color/bold/italic/
   *  align/backgroundColor/strokeColor/shadowColor have no sensible continuous interpolation, so a
   *  bracketing pair holds the EARLIER keyframe's value for those, same "lerp what's numeric, hold what
   *  isn't" split `resolveTextStyle`'s own comment documents. Video/image clips never carry this field —
   *  same gating as `transformKeyframes` itself. */
  textStyleKeyframes?: TextStyleKeyframe[];
  /** Absent means no chroma key (plain opaque video) — same "small JSON, cheap default path"
   *  reasoning as `transform`. Video/image clips only, same gating as `transform`/`effects` — see
   *  `ChromaKeySettings`'s own doc comment for the full reasoning and the preview/export parity goal. */
  chromaKey?: ChromaKeySettings;
  /** A crossfade FROM whatever clip immediately precedes this one on the same track, INTO this one —
   *  or, when there's no such predecessor (this clip opens the track, or a gap opened up before it),
   *  a fade in from black (video/image), from fully transparent (text), or from silence (audio)
   *  instead. Absent means a plain hard cut — same "small JSON, cheap default path" reasoning as
   *  `transform`.
   *
   *  Deliberately NOT validated or repaired by any edit operation (`moveClip`/`trimClip`/`splitClip`/
   *  `carveRange` all stay completely unaware of this field) — `timeline/transitions.ts`'s
   *  `findTransitionPartner` resolves it fresh, AT USE TIME, into whichever of the two shapes above
   *  currently applies: adjacent (`clipEnd(prev) === this.timelineStart`, zero gap) resolves to a
   *  real blend partner; anything else (no predecessor, or one that's since drifted away) resolves to
   *  a solo fade — `duration` is clamped to fit the CURRENT clip length either way, never dropped
   *  outright. So an edit that breaks adjacency (dragging a gap open, trimming a clip too short)
   *  doesn't need cleanup logic threaded through every existing edit path — the transition just
   *  quietly becomes a solo fade instead of erroring or vanishing. Also valid on a TEXT or AUDIO clip,
   *  not just video/image — `findTransitionPartner` itself is track-kind-agnostic, and every renderer
   *  blends an adjacent pair the same way it blends video ones (text: see
   *  `PlaybackEngine.drawTextLayer`'s own comment; audio: `buildExportPlan.ts`'s
   *  `buildAudioTrackStream`, which always renders `type` as a plain FFmpeg `acrossfade` regardless of
   *  which of the 12 `TransitionType` values is stored — the video-only wipe/slide/circle shapes have
   *  no audio analog, so the Inspector's Style picker doesn't even offer them for an audio clip). */
  transitionIn?: { duration: number; type: TransitionType };
  /** A fade OUT to black (video/image), to fully transparent (text), or to silence (audio), over this
   *  clip's own final `duration` seconds. Unlike `transitionIn`, there is no "blend into the next
   *  clip" shape here — that boundary is already fully described by the NEXT clip's own
   *  `transitionIn` (see its doc comment), so `transitionOut` is ALWAYS a solo effect:
   *  `timeline/transitions.ts`'s `findTransitionOut` resolves it to `null` — same as absent —
   *  whenever a genuine successor exists at all on this track, whether or not that successor actually
   *  set a `transitionIn` of its own. Meaningful only when nothing follows this clip (it's the last
   *  one on the track, or a gap opens up right after it). Absent means no fade-out, same "small JSON,
   *  cheap default path" reasoning as `transform`. Also valid on a TEXT or AUDIO clip, not just
   *  video/image — same reasoning as `transitionIn`. */
  transitionOut?: { duration: number; type: TransitionType };
  /** A continuous motion effect over this clip's own visible duration — see `TextAnimationType`'s own
   *  doc comment for what it is and its preview-only export scope cut. Meaningful only on a TEXT clip
   *  (a video/image clip can carry the field structurally, same "never validated up front" reasoning
   *  as `transitionIn`, but `PlaybackEngine`/`buildExportPlan` only ever look at it on the text render
   *  path). Absent means no animation, same "small JSON, cheap default path" reasoning as `transform`.
   *  `highlightColor` only means anything for `type: "wordHighlight"` (see its own doc comment) —
   *  structurally present-but-ignored for the other four, same "valid but inert" shape `strokeWidth`
   *  already has when `strokeColor` is unset. `speed` is a multiplier on elapsed time (absent/1 = the
   *  animation's own normal pace, 2 = twice as fast, 0.5 = half) applied uniformly by
   *  `PlaybackEngine.drawAnimatedText` BEFORE calling any of `timeline/textAnimation.ts`'s pure
   *  functions — so none of them need their own notion of speed, they just see a bigger or smaller
   *  elapsed-time number than the clip's real playhead position. */
  textAnimation?: { type: TextAnimationType; highlightColor?: string; speed?: number };
  /** Entrance / exit animations — see `TextInOutType`. Independent of `textAnimation` (a clip can have a
   *  slide-in, a heartbeat loop and a fade-out at once). Text clips only, same as `textAnimation`. */
  textAnimationIn?: TextInOutAnimation;
  textAnimationOut?: TextInOutAnimation;
  /** Template clips only: the AI steps to run on whatever media fills this clip's slot, in order (see `Asset.aiOrigin`). */
  templateAiSteps?: AiRecipeStep[];
  /** Real per-word timing for `textAnimation.type === "wordHighlight"`, CLIP-RELATIVE seconds (same
   *  "elapsed" space every other per-clip timing value in this codebase uses) — one entry per word
   *  `timeline/textAnimation.ts`'s `splitWords(asset.textContent)` finds, in the same order. Only ever
   *  set by Auto Captions when the transcription provider actually returned real per-word timestamps
   *  (currently: Kiri, for Khmer — see `AddCaptionsCommand`'s own doc comment); absent for everything
   *  else (manually typed word-highlight text, a provider/language with no real per-word alignment),
   *  which keeps the OLD "spread evenly across the clip's own duration" approximation as the honest
   *  fallback (`timeline/textAnimation.ts`'s `wordBoundaries`) rather than fabricating timing that was
   *  never real. A length mismatch against `splitWords`'s own count (e.g. the caption text was hand-
   *  edited after landing, adding/removing a word) is treated as "may as well be absent" the same way,
   *  for the same reason — see `wordBoundaries`'s own doc comment. */
  wordTimings?: { start: number; end: number }[];
  /** Meaningful only on a TEXT clip, same gating as `textAnimation`. Absent means no crop (full frame
   *  visible), same "small JSON, cheap default path" reasoning as `transform`. See `TextCrop`'s own doc
   *  comment for why this is a separate, frame-space mask rather than reusing `ClipTransform.crop`. */
  textCrop?: TextCrop;
  /** Mirrors `transformKeyframes`, for a TEXT clip's `TextCrop` — same "present+non-empty is what both
   *  renderers resolve, absent means not keyframed" contract, and the same clip-scoped (not asset-
   *  scoped) placement `textStyleKeyframes` uses. `resolveTextCrop` (`timeline/keyframes.ts`) LERPs
   *  between keyframes, matching `transformKeyframes`'s own convention — every `TextCrop` field is
   *  plain numeric, so unlike `colorGradingKeyframes` there's no "no natural correspondence between two
   *  keyframes' shapes" problem forcing a HOLD instead. Meaningful only on a TEXT clip, same gating as
   *  `textCrop` itself. */
  textCropKeyframes?: TextCropKeyframe[];
  /** Silences this clip's OWN embedded audio, independent of the track it's on. Distinct from a
   *  video track's `visible` flag (which already silences a hidden clip's audio as a side effect of
   *  hiding it — muting a clip you can still SEE is a genuinely different thing to ask for) and from
   *  an audio track's `muted`/`solo` (which apply to every clip on that track uniformly). Absent
   *  means audible, same "small JSON, cheap default path" reasoning as `transform`. */
  mutedAudio?: boolean;
  /** Linear volume multiplier for this clip's OWN embedded audio, applied independently of
   *  `mutedAudio` (a hard override — a muted clip stays silent regardless of `gain`; see
   *  `AudioMixEngine.syncVideoClipAudio`, which folds both into one target on a dedicated `GainNode`).
   *  Routed through Web Audio (`AudioMixEngine`), not a `<video>`/`<audio>` element's native `.volume`
   *  (which the browser caps at 1) — so this can genuinely exceed 1 for real amplification, not just
   *  attenuation; see `setClipGain`'s own ceiling for the UI-facing bound. Absent means `1` (unchanged),
   *  same "small JSON, cheap default path" reasoning as `transform`/`effects`. This is the KEYFRAMED
   *  property's own base/identity value — see `gainKeyframes`' own doc comment for how the two
   *  compose, the same "flat field is the fallback, keyframes array is what's actually read once
   *  present" relationship `transform`/`transformKeyframes` already have. */
  gain?: number;
  /** Stereo pan for this clip's OWN embedded audio, downstream of `gain` in the signal chain — the
   *  exact per-clip counterpart of `Track.pan` (same equal-power law, same `AudioMixEngine`
   *  `StereoPannerNode` mechanism, same `[-1,1]` range/`0`-is-center identity), just scoped to one
   *  clip instead of a whole track; the two compose exactly the way `Clip.gain`/`Track.gain` already
   *  do (see `AudioMixEngine`'s own per-clip-then-per-track node-chain comment). Video and audio
   *  clips only — a text clip has no audio of its own to pan. Absent means `0` (center), same "small
   *  JSON, cheap default path" reasoning as `gain`; the `[-1,1]` clamp `setClipPan` applies is the
   *  same ordinary input-sanity bound `setTrackPan` uses. Deliberately NOT keyframed (unlike `gain`
   *  below) — a listener rarely wants a clip's stereo position to move mid-clip the way its LOUDNESS
   *  routinely does (duck under dialogue, fade in/out), and export has no established time-varying
   *  stereo-balance primitive the way `volume`'s `eval=frame` gives gain (see `gainKeyframes`' own
   *  doc comment) — a flat per-clip control is the honestly-scoped v1 here, not an oversight. */
  pan?: number;
  /** This clip's own `gain` KEYFRAMED over its duration — `Clip.transformKeyframes`' own doc comment's
   *  "present+non-empty is what both renderers resolve, absent means not keyframed" contract, `T`
   *  narrowed to a plain `number` here (not a property-GROUP object like `ClipTransform`/`ClipEffects`)
   *  because gain genuinely IS just one scalar — there's no sibling field it would make sense to bundle
   *  it with the way offsetX/offsetY/scale/rotationDeg belong together as one Transform. LERP-
   *  interpolated between keyframes, like `TransformKeyframe` (a plain crossfade in volume between two
   *  levels is exactly what "ramp the gain" should mean — unlike `ColorGradingKeyframe`'s HELD curves,
   *  there's no "shape mismatch between two keyframes" problem for a single number). Falls back to
   *  `clip.gain ?? 1` when absent/empty, the same zero-behavior-change-until-armed contract every other
   *  keyframe field here has.
   *
   *  Export support is real but deliberately narrower than preview: `buildExportPlan.ts` renders this
   *  as a genuine time-varying FFmpeg `volume=eval=frame` expression (piecewise-linear, mirroring
   *  `resolveClipGain`'s own hold-before/lerp-between/hold-after shape exactly — see `gainFilter.ts`),
   *  but ONLY for a clip playing at a constant rate. A clip with a non-trivial `speedCurve` already
   *  routes its audio through a per-segment `atempo`+`concat` rebuild whose own local timeline is not
   *  1:1 with clip-elapsed time partway through a slice (only at each slice's own start) — composing
   *  that correctly with a keyframed gain sampled by real output-time is real, unsolved work, so that
   *  one combination exports the clip's flat `gain` instead (keyframes ignored), a documented scope cut
   *  matching this codebase's existing precedent for narrow, deliberately-unhandled interaction
   *  combinations (see `zoomBlur`/`flashZoom`'s own solo-case history). Preview always renders the real
   *  keyframed envelope regardless of speed curve — Web Audio's per-tick `AudioParam` update has no
   *  equivalent "local time resets each slice" problem to begin with. Video/audio clips only, same
   *  gating as `gain`/`pan`. */
  gainKeyframes?: GainKeyframe[];
  /** A `LutAsset.id` from the project's own `luts` library — applied AFTER color grading (both
   *  preview's `PlaybackEngine.drawTransformed` and export's matching filter chain apply curves, then
   *  the LUT, on top of the same already-color-graded pixels), same "resolve to a real file only at
   *  render time" pattern `TextStyle.fontFamily` uses for a font id. Absent means no LUT, same "small
   *  JSON, cheap default path" reasoning as `transform`. Video/image clips only, same gating as
   *  `chromaKey`/`colorGrading`. Deliberately NOT validated against `project.luts` here — same
   *  reasoning `transitionIn` isn't validated against its own partner clip: a LUT deleted out from
   *  under a clip that still references it should degrade gracefully (the renderer's own `lutUrlFor`
   *  simply returns `null` for an unresolvable id — see `PlaybackEngine.PlaybackHost`'s own doc
   *  comment), not corrupt the edit. */
  lutId?: string;
  /** How strongly `lutId` is applied, `0..1` — `1` (absent) is the LUT at full strength, `0` is the
   *  untouched image. A straight blend between the source and the fully-LUT'd pixels, implemented by
   *  blending the LUT LATTICE itself (`timeline/lut.ts`'s `blendLut3D`) so preview and export apply the
   *  exact same math with no extra per-pixel pass or FFmpeg filter branch. Meaningless without `lutId`;
   *  not keyframeable, same reasoning as `lutId`. */
  lutIntensity?: number;
  /** A continuous glitch/water-ripple pixel effect over this clip's own visible duration — see
   *  `PixelEffectType`'s own doc comment for what it is and how it differs from the TRANSITION-flavored
   *  `glitchCut`/`waterRippleCut`. `speed` mirrors `textAnimation.speed`'s exact convention (a
   *  multiplier on elapsed time fed into `applyGlitch`/`applyWaterRipple`'s own `elapsedSeconds`
   *  parameter — absent/1 is the effect's own normal pace). Absent means no effect, same "small JSON,
   *  cheap default path" reasoning as `transform`. Video/image clips only, same gating as `lutId`. Not
   *  keyframeable — see `PlaybackEngine.drawTransformed`'s own comment on why a spatial displacement
   *  runs LAST, after every color operation, and has no natural per-keyframe interpolation the way a
   *  numeric transform field does. */
  pixelEffect?: { type: PixelEffectType; speed?: number };
  /** Ordered face-manipulation stack. This is separate from color Filters (`effects`/color grading)
   * and standard pixel effects (`pixelEffect`) because face tracking needs a licensed provider and a
   * frame-processing stage of its own. The separation lets all three coexist and gives export a
   * precise pre-processing boundary instead of pretending FFmpeg can reproduce an SDK morph. */
  faceEffects?: FaceEffectInstance[];
}

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  clips: Clip[];
  locked: boolean;
  /** Video and text tracks — hidden tracks are skipped by the compositor and by export. */
  visible: boolean;
  /** Audio tracks only. */
  muted: boolean;
  solo: boolean;
  /** Linear volume multiplier for every clip on this track, on top of each clip's OWN `Clip.gain` —
   *  the two multiply together (see `PlaybackEngine.activeAudioClips`), the same "track fader on top
   *  of a per-clip trim" relationship a real mixing console has. Audio tracks only, same scope cut as
   *  `muted`/`solo` — structurally present-but-ignored on a video/text track. Routed through a
   *  dedicated per-track `GainNode` in `AudioMixEngine`, not folded into each clip's own node,
   *  specifically so dragging this fader live doesn't restart any `AudioBufferSourceNode` — only the
   *  one scalar on the shared node moves. Absent means `1` (unchanged), same "small JSON, cheap
   *  default path" reasoning as `Clip.gain`; the `[0,4]` clamp `setTrackGain` applies is an ordinary
   *  input-sanity bound, not a `GainNode` ceiling. */
  gain?: number;
  /** Stereo pan for every clip on this track, applied via the equal-power law (a plain crossfade
   *  between L/R, not a simple L/R gain split — the same algorithm a native Web Audio `StereoPannerNode`
   *  computes, and what `AudioMixEngine`'s per-track `StereoPannerNode` uses directly for live preview).
   *  -1 is hard left, 0 is center, 1 is hard right. Applied AFTER `gain` in the signal chain — see
   *  `AudioMixEngine`'s own per-track node-chain comment for why panning sits downstream of the fader
   *  rather than upstream of it. Audio tracks only, same scope cut as `muted`/`solo`/`gain` —
   *  structurally present-but-ignored on a video/text track. Absent means `0` (center), same "small
   *  JSON, cheap default path" reasoning as `Clip.gain`/`Track.gain`; the `[-1,1]` clamp `setTrackPan`
   *  applies is an ordinary input-sanity bound matching `StereoPannerNode.pan`'s own natural range. Not
   *  applied to the master bus — see `Sequence.masterGain`'s sibling comment on why there's no
   *  `Sequence.masterPan`: panning the whole mix isn't a per-channel routing question the same way it is
   *  for an individual track, so the Mixer's Master strip has a fader but no pan knob. */
  pan?: number;
}

export interface Sequence {
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  tracks: Track[];
  /** Overall mix level — the single master fader in the Mixer dialog, multiplying every audio track's
   *  already-track-gained, already-clip-gained signal. Lives here (not a separate mixer-settings
   *  object) because there's exactly one per sequence, same cardinality as `width`/`height`/`fps`.
   *  Absent means `1`, same convention as `Track.gain`/`Clip.gain`. Applied live via
   *  `AudioMixEngine.setMasterGain` (its `masterGain` node has existed since the engine's own
   *  constructor, reserved for exactly this) and at export time as a final `volume=` stage after the
   *  last `amix`, in both `buildExportPlan.ts` and `buildAudioOnlyExportPlan.ts`. */
  masterGain?: number;
}

export interface ExportSettings {
  width: number;
  height: number;
  fps: number;
  /** H.264 CRF — lower is higher quality. 18 is visually near-lossless, 23 is FFmpeg's default. */
  crf: number;
  audioBitrateKbps: number;
  /** What to embed as the exported file's own attached cover/poster image (an `attached_pic`-
   *  disposition stream in the MP4 container — the same mechanism iTunes-style cover art uses,
   *  recognized by QuickTime/Photos/most players/messaging apps as the file's preview without needing
   *  to decode/seek into the real video stream at all). `null`/absent means no cover is embedded — the
   *  export behaves exactly as it always has, a player falls back to its own default (usually the real
   *  first frame).
   *
   *  Two independent ways to pick one, hence the discriminated union rather than two optional fields
   *  (which would leave "both set" an ambiguous, unvalidated state to reason about at every consumer):
   *  - `{ kind: "frame", time }`: a timeline-seconds position, TIMELINE (not clip-local) time, matching
   *    `playhead`'s own space — set by scrubbing the whole sequence via the track-header cover control
   *    (`Timeline.tsx`). `export/route.ts`'s post-encode step extracts this exact frame FROM the
   *    already-composited main output (not a raw source clip) so the cover always matches whatever
   *    crop/overlay/text/color-grading the real export produced.
   *  - `{ kind: "image", assetId }`: an `Asset.id` for a separately-uploaded still image (imported via
   *    the ordinary `importFiles` pipeline with `hiddenFromLibrary: true`, same treatment a voiceover
   *    recording gets — it's a real project asset, just not one that clutters the Media Library) —
   *    `export/route.ts` muxes that file in directly, no frame extraction needed.
   *  Deliberately NOT validated against `project.assets` here — same "resolve to a real file only at
   *  use time, degrade gracefully if it's gone" reasoning `Clip.lutId` documents; an `image` cover whose
   *  asset was since deleted just falls back to no-cover-embedded at export time. */
  cover?: CoverSelection | null;
}

/** See `ExportSettings.cover`'s own doc comment. */
export type CoverSelection = { kind: "frame"; time: number } | { kind: "image"; assetId: string };

/** A `.cube` 3D LUT imported into the project's own reusable library — "My LUTs" in the Inspector's
 *  LUT picker, referenced by `Clip.lutId`. Same id/name/relPath/importedAt shape `Asset` itself uses
 *  (portable, JSON-round-trippable, relative to the project's own media folder), kept as a SEPARATE
 *  library rather than folded into `Project.assets` because a LUT is never placed on the timeline as
 *  its own clip the way an `Asset` is — it's applied TO a clip, a relationship `Clip.lutId` already
 *  captures directly, so there's no `Track`/`Clip` machinery a LUT itself would ever need. */
export interface LutAsset {
  id: string;
  /** Shown in the Inspector's "My LUTs" picker — the uploaded filename by default, same convention
   *  `Asset.name` uses. */
  name: string;
  /** Path relative to the project's media directory, same portability contract as `Asset.relPath`. */
  relPath: string;
  /** The parsed `LUT_3D_SIZE` dimension (N in the NxNxN lattice) — mirrors `timeline/lut.ts`'s own
   *  `Lut3D.size` exactly, cached here at import time so the library list can show a LUT's resolution
   *  without re-fetching/re-parsing its `.cube` file on every render. */
  size: number;
  importedAt: number;
}

/** A user-uploaded font, registered into the project's own reusable library — "My Fonts" in the
 *  Inspector's font picker, referenced by `TextStyle.fontFamily` exactly like a bundled
 *  `FontDefinition.id` (see that field's own doc comment) — `resolveFont` (`project/fonts.ts`) is what
 *  tries this library FIRST, before falling back to the bundled `FONT_REGISTRY`. Single-file, unlike a
 *  bundled `FontDefinition` (no separate bold/italic/boldItalic uploads in v1 — a custom font always
 *  renders as its own one regular face, same "single-weight display face" shape `FontDefinition.files`
 *  already allows for a bundled font that ships only a `regular`). */
export interface CustomFontAsset {
  id: string;
  /** Shown in the Inspector's font picker, same role `FontDefinition.label` plays for a bundled font. */
  name: string;
  /** Path relative to the project's media directory, same portability contract as `Asset.relPath`. */
  relPath: string;
  /** The `@font-face` family name this font is registered under, once loaded — same role
   *  `FontDefinition.cssFamily` plays for a bundled font (see its own doc comment for why every font
   *  needs one: both the browser's `context.font` string and, eventually, a real `@font-face` rule need
   *  a stable family name distinct from any bundled font or the page's own). */
  cssFamily: string;
  importedAt: number;
}

/** A user-uploaded sound effect, registered into the project's own reusable "My Sounds" library —
 *  listed above the bundled `SFX_REGISTRY` catalog in `SfxPanel.tsx`. Deliberately NOT a plain `Asset`
 *  the way an imported media file is: "Add to timeline" (`SfxPanel.tsx`'s `addToTimeline`) always
 *  re-imports a fresh COPY through the ordinary `importFiles` pipeline to get a real `Asset` id a clip
 *  can reference, the same hand-off a bundled catalog entry goes through — a `CustomSfxAsset` is the
 *  reusable SOURCE a user can preview/re-add/delete from the library, not itself a placeable clip
 *  reference, same "LUT/font-shaped library, not a timeline asset" relationship `LutAsset`/
 *  `CustomFontAsset` have to `Clip.lutId`/`TextStyle.fontFamily`. */
export interface CustomSfxAsset {
  id: string;
  /** Shown in "My Sounds" and used as the imported clip's display name — mirrors `SfxDefinition.label`
   *  for a bundled entry. */
  label: string;
  /** Path relative to the project's media directory, same portability contract as `Asset.relPath` —
   *  also doubles as the filename handed to `importFiles` when "Add to timeline" re-imports a copy
   *  (`SfxPanel.tsx`), mirroring how a bundled entry's own `SfxDefinition.file` is reused for the same
   *  purpose. */
  relPath: string;
  importedAt: number;
}

export interface Project {
  schemaVersion: number;
  id: string;
  /** The BP Studio project this belongs to — how a VCut project is located on disk. */
  bpProjectId: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  assets: Asset[];
  sequence: Sequence;
  exportSettings: ExportSettings;
  /** The project's own reusable LUT library — see `LutAsset`'s own doc comment. Always present (never
   *  optional): `createProject` seeds it as `[]`, and `deserializeProject` backfills `[]` for a project
   *  file saved before this field existed, so every consumer (`SfxPanel`-style "My ___" list,
   *  `PlaybackEngine.PlaybackHost.lutUrlFor`) can read it directly without an `?? []` at every call
   *  site. */
  luts: LutAsset[];
  /** The project's own reusable custom-font library — see `CustomFontAsset`'s own doc comment. Same
   *  always-present, backfilled-on-load contract as `luts`. */
  customFonts: CustomFontAsset[];
  /** The project's own reusable "My Sounds" library — see `CustomSfxAsset`'s own doc comment. Same
   *  always-present, backfilled-on-load contract as `luts`. */
  customSfx: CustomSfxAsset[];
  /** The Supabase user id that owns this project — only ever set in the hosted web deployment (see
   *  `studios/vcut/app/api/vcut/_lib/localOnly.ts`'s `VCUT_HOSTED` branch), stamped once at creation
   *  and never changed afterward. `undefined` for every LOCAL project (desktop, dev) — there is no
   *  concept of "owner" outside hosted mode, the same single-implicit-user assumption the rest of the
   *  local storage layer already makes. Deliberately optional rather than a required `string`: adding
   *  a REQUIRED field would force every local `project.json` ever written before this existed to fail
   *  `deserializeProject`'s validation the instant it's opened again. */
  ownerId?: string;
  /** Set once, permanently, by `buildProjectFromTemplate` — never by anything else, and never cleared
   *  afterward, even once every slot has been filled. Marks this as a guided, export-only project: the
   *  normal timeline/clip editor is never shown for one of these (`VCutApp.tsx`'s own top-level branch
   *  on this field), regardless of whether it still has open `templateSlots` or not — asked for
   *  directly, to keep the packaged template EXPERIENCE consistent (what a template promises is what
   *  comes out) rather than opening it up to the same free-form editing any other project gets, which
   *  could otherwise drift the result away from the template's own intended look. `undefined` for every
   *  ordinary project — including one created via the OLDER "start from a template" flow, before this
   *  field existed, which stays fully editable exactly as it always was. */
  templateOrigin?: true;
}

/** How long a still image occupies the timeline when first placed, in seconds. */
export const IMAGE_DEFAULT_DURATION = 5;

/** How long a text clip occupies the timeline when first placed, in seconds — same reasoning as
 *  `IMAGE_DEFAULT_DURATION`: text has no intrinsic duration of its own. Shorter than a still image's
 *  own default: a title/caption is typically read in a couple of seconds, and a short default clip is
 *  easier to nudge/extend to fit a specific beat than a long one is to trim down. */
export const TEXT_DEFAULT_DURATION = 3;

/** The "Short" preset from the product spec — vertical 1080×1920 @ 30fps, the default because
 *  short-form vertical video is VCut's primary target. */
export const SHORT_PRESET = { width: 1080, height: 1920, fps: 30 } as const;

export const RESOLUTION_PRESETS = [
  { label: "Vertical 1080 × 1920", width: 1080, height: 1920 },
  { label: "Landscape 1920 × 1080", width: 1920, height: 1080 },
  { label: "Square 1080 × 1080", width: 1080, height: 1080 },
] as const;

export const FPS_PRESETS = [24, 25, 30, 50, 60] as const;
