# VCut handoff: Claude review after Codex

Updated: 2026-09-23 (Asia/Bangkok).

## Latest release: Shared tool panels and Script typography/animation - 2026-09-23

### Tool-panel UX

- Added `src/ui/ToolPanelFrame.tsx`, based on the established Sticker panel: toolbar-opened tools are
  full-width bottom sheets on phones and centered, fixed-height cards on larger screens. Each tool
  keeps its header/actions visible while its own body scrolls.
- Script, Auto Captions, Voice Record, Music, Sound Effects, Stickers, and AI Edit now use the shared
  shell. Compact anchored pickers such as Font, Color, Animation, and Transitions remain anchored to
  their toolbar buttons because their position is part of their editing context.
- Close/backdrop behavior is still workflow-aware: recording/review, caption generation, and AI Edit
  cannot be dismissed while their existing busy states say it is unsafe to do so.

### Script Font and Animation

- Script now has the same `Font / Style / Animation` tab flow as Auto Captions. It uses the existing
  font and animation pickers rather than adding another registry or rendering path.
- A generated Script batch passes the selected font and animation through the existing
  `landCaptions` -> `AddCaptionsCommand` path. The whole batch remains one undo step and persists via
  the existing text style, clip animation, serialization, preview, and export implementations.
- Script exposes the full bundled font library because pasted text can mix scripts. With no explicit
  pick, Khmer text defaults to Koulen and other text defaults to Lato.

### Verification and 0.2.3 artifacts

- Package and hosted-app TypeScript: pass. Production Next.js, Capacitor/Vite, Electron, Android
  `assembleDebug`, Android sync, and iOS sync: pass. Native iOS compilation/signing still requires
  macOS with CocoaPods/Xcode.
- Full package suite: **1,125 pass / 0 fail / 0 skip** across 187 suites.
- Real-browser checks pass at 1280x800 and 390x844 for Script, Auto Captions, Voice, Music, SFX, and
  Stickers. The mobile panels are full-width and bottom-aligned; the desktop panels share the same
  centered 80vh layout. Script keeps Font/Style/Animation and Generate reachable at both sizes.
- End-to-end Script check generated and saved a real text clip with `fontFamily: "roboto"` and
  `textAnimation.type: "bounce"`, then undid/saved and confirmed the test asset was removed.
- Windows installer: `apps/vcut-desktop/release/VCut Setup 0.2.3.exe` (232,524,562 bytes; SHA-256
  `987051F32FE6C801097EE80DFDEFED09861FAC4564C034F25B83338C5C22CE93`).
- Android APK: `apps/mobile/android/app/build/outputs/apk/debug/VCut-0.2.3.apk` (200,419,071 bytes;
  SHA-256 `CECB15BAE79808D484CDEBAEC92456B2C80BF42F15A1C3DBA1631CAB11A1C1F1`).
- GitHub releases: `vcut-desktop-v0.2.3` and `vcut-mobile-v0.2.3`, both targeting package commit
  `f2866f179653d29ceb9a3e0b784d51654c87020a`. GitHub's uploaded-asset digests match the local
  SHA-256 values above.
- Railway deployment `7566d676-83f9-4fd9-bf82-d2af92b66dba` reached `SUCCESS`. `https://vcut.io/`
  and `/edit` return HTTP 200, and the production Permissions-Policy still enables microphone,
  camera, and display capture for the same origin.

## Latest release: Timeline precision and interaction quality - 2026-09-23

### Timing and coordinate fixes

- Added `src/timeline/interaction.ts` as the shared frame-aware interaction layer for pointer-to-time
  conversion, zoom anchoring, snap thresholds, group movement, trim previews, transition-duration
  bounds, presentation-only minimum widths, and virtualized ruler ticks.
- Clip drags now use absolute timeline time from the scroll container instead of only `clientX` delta.
  Scrolling during a drag therefore no longer changes where the clip lands. Multi-selected clips use
  their outer bounds, clamp as one group at time zero, and retain every internal gap.
- Move and trim previews are frame-quantized before commit. Retimed, reversed, and speed-curve trim
  previews use the same timeline-to-source mapping as playback/export; source time is kept fractional
  where required so a frame-aligned timeline edit does not change duration when released.
- Snapping remains pixel-friendly but is capped to a small frame window at overview zoom, preventing
  a 16 px target from becoming a several-second magnet. Clip edges, playhead, and export in/out
  markers participate where representable. A vertical amber guide and exact timecode show the target.
- Cross-track drops now reject locked or wrong-kind rows during the preview itself, matching commit.
  No-op drags/trims no longer add undo entries.

### Ruler, zoom, playhead, and transitions

- Ruler ticks are generated from integer frame indices and only around the visible viewport. Deep
  zoom reaches 1,200 px/s and shows frame ticks without creating a whole-project DOM tree.
- Mouse-wheel, pinch, button, keyboard, and reset zoom share one anchor equation. Reset preserves the
  time under the viewport center instead of jumping. Mobile uses the same equation with its leading
  pad and fixed-center playhead.
- The ruler supports frame stepping with Arrow keys, 10-frame stepping with Shift, and Home/End.
  ARIA values and hover timecodes now retain frame precision.
- Transition junctions now receive cut time in seconds rather than pre-multiplied pixels, remain
  centered on the cut, and use scroll-aware pointer time while resizing. Minimum clip/junction widths
  are visual only and never feed back into saved duration.
- Existing authored transition durations remain exact for compatibility and export fidelity; new
  timeline handle adjustments are frame-stepped.

### Verification, artifacts, and deployment

- Package and host TypeScript: pass.
- Full package suite: **1,125 pass / 0 fail / 0 skip** across 187 suites. The new focused suite adds
  pointer/zoom inverses, zoom-independent snapping, group bounds, retimed/reversed trims, minimum
  visual widths, integer-frame ruler ticks, frame-bounded transition handles, and exact retimed
  split/trim coverage.
- Production Next.js web build, Capacitor mobile build, Android/iOS `cap sync`, Electron packaging,
  and Android `assembleDebug`: pass. iOS compilation/signing still requires macOS with CocoaPods/Xcode.
- `scripts/timeline-check/check-timeline.cjs` passes against the packaged editor at 1440 px and 390 px.
  It exercises real frame seeking, anchored zoom, scroll/playhead sync, snap-guide visibility, exact
  saved move/trim positions, undo, and a cut-centered transition junction with no browser errors.
- Windows installer: `apps/vcut-desktop/release/VCut Setup 0.2.2-timeline-precision.exe`
  (232,524,139 bytes; SHA-256 `7EC0782A95031416DDDF8BEA942F8580FADA90DE6BB28B4257E9E50F9374FAC0`).
- Android APK: `apps/mobile/android/app/build/outputs/apk/debug/VCut-0.2.2-timeline-precision.apk`
  (200,756,195 bytes; SHA-256 `84B983887674F3010A0A9C338703F35EEBBF59E8BEF0FE60E93D8049E8B52120`).
- Railway deployment `1c71a499-abef-483e-934f-fe2582ae6818` reached `SUCCESS`. The release is live at
  `https://vcut.io`; `/` and `/edit` return HTTP 200 and the editor retains its microphone, camera,
  and display-capture permissions policy.

No commit or push was made. The implementation remains in the `packages/vcut` submodule working tree.

## Latest release: Properties panel and clip Blend modes - 2026-09-23

### Properties and AI Tools

- Simplified the Inspector into a quieter card hierarchy with compact spacing, normal-case headings,
  and a responsive segmented tab grid. The old Transform tab is now labelled Visual; all existing
  controls and section state remain in the same Inspector architecture.
- AI Tools now starts with one short explanation and three task cards: Creative AI, Remove Object,
  and Auto Captions when the selected clip has audio. Only the selected workflow is rendered, so
  users no longer scroll through several unrelated, simultaneously-expanded AI panels.
- Remove Object still opens directly when its canvas workflow is armed. Video/image, audio, text,
  transition, filter, LUT, chroma-key, source, and timeline behavior remains available behind the
  same asset/track gates as before.

### Blend implementation

- Added optional `Clip.blendMode` with validated values `normal`, `overlay`, `screen`, `darken`, and
  `lighten`. Absent/Normal remains the identity value for old project compatibility and compact JSON.
- Added the existing pure-operation + command-stack flow (`setClipBlendMode` and
  `SetClipBlendModeCommand`) with locked-track checks and exact undo/redo restoration.
- Canvas preview maps the modes to `globalCompositeOperation` per visual layer and switches the
  active mode at the midpoint of centered junction transitions.
- FFmpeg export composites each upper video track over the accumulated lower frame. Non-Normal
  modes preserve the upper clip's original alpha before overlay, so crop, rotation, masks, opacity,
  and transparent letterboxing do not create black rectangles. A real FFmpeg Darken render verifies
  both the blended center and untouched transparent corners.

### Verification and artifacts

- Package TypeScript: pass.
- Full package suite: **1,117 pass / 0 fail / 0 skip** across 185 suites.
- Focused editing/serialization/operations/undo/export suite: **535 pass / 0 fail**.
- Production web, Capacitor mobile, and Electron builds: pass.
- Responsive packaged-app check: pass at 1440px and 390px. It exercises Blend save + undo through
  the real UI, switches all AI task cards, checks applicable tabs, and finds no horizontal overflow
  or browser errors.
- Android and iOS native projects were synced. iOS compilation/signing still requires macOS with
  CocoaPods/Xcode.
- Android APK: `apps/mobile/android/app/build/outputs/apk/debug/VCut-0.2.2-properties-blend.apk`
  (200,754,492 bytes; SHA-256 `9AD856DFB3C65FF2602A065B29B0C1B9F6C91D8ACFBBD6F8B69EF40180BE4CDF`).
- Windows installer: `apps/vcut-desktop/release/VCut Setup 0.2.2-properties-blend.exe`
  (232,519,955 bytes; SHA-256 `5D86424EF9E4F65B95EB2CACA73F39C00C67914D3183B05ABF06C7361A386C2E`).
- Railway deployment `4a10e1dc-2069-43d1-bfe9-8e9201514808` reached `SUCCESS`; the new release is
  live at `https://vcut.io`, and `https://vcut.io/edit` returns HTTP 200.

No commit or push was made. The implementation remains in the `packages/vcut` submodule working tree.

## Latest release: Flip, Reverse, Mask, and Speed/Time Remapping — 2026-09-23

### Implementation

- Extended the existing `Clip` model with optional `flipHorizontal`, `reverse`, `mask`, `speed`, and
  `speedCurve` fields. `serialize.ts` validates and restores every field, so old projects retain
  identity behavior and edited projects round-trip without a parallel storage format.
- Added `timeline/clipTiming.ts` as the shared timeline-to-source mapping. Constant speed and linear
  speed curves use the same duration integral/inverse mapping in timeline layout, preview, trimming,
  splitting, transition handles, and FFmpeg export. Reversed clips use the same mapping in the
  opposite source direction.
- Added undoable commands and pure operations for all four tools. Changing speed ripples later clips
  on the same track and the existing track-scoped command memento restores the whole track on undo.
  Duplicate, paste, split, trim, range trim, and overwrite carving preserve the new properties and
  correctly slice/rebase curves and keyframes.
- Preview now mirrors images/videos on canvas, frame-seeks reversed video, schedules reversed embedded
  audio through Web Audio, applies rectangle/ellipse masks with feather/invert, and follows variable
  speed continuously. Mask fields use live preview overrides while editing and commit once to undo.
- Export now emits `hflip`, `reverse`/`areverse`, matching alpha masks, constant `setpts`/`atempo`, and
  piecewise time-remap expressions. Curve audio is divided at control points, retimed, and concatenated
  to the same boundary times as video.
- Inspector UI exposes Flip Horizontal and Mask for images/videos, plus Normal/Curve speed modes,
  presets, editable curve points, and Reverse Playback for video clips.

### Verification and artifacts

- Package TypeScript: pass.
- Full package suite: **1,115 pass / 0 fail / 0 skip** in 73.2 seconds.
- New real-FFmpeg integration renders flip + reverse + feathered ellipse mask + speed curve together.
- Focused operations/export/undo regression suite: **499 pass / 0 fail**.
- Production Next web build: pass.
- Capacitor mobile build and `cap sync`: pass for Android and iOS. Windows cannot run Xcode/CocoaPods;
  the iOS native project contains the current web assets and plugin metadata for the next Mac build.
- Android APK: `apps/mobile/android/app/build/outputs/apk/debug/VCut-0.2.2-editing-tools.apk`
  (200,753,020 bytes; SHA-256 `256D313AA96946257034B4C9B8FD249C5747D69AD1FF410D845A1F92C0A54D73`).
- Windows portable ZIP: `apps/vcut-desktop/release/VCut-0.2.2-editing-tools-win-x64.zip`
  (305,094,870 bytes; SHA-256 `2D837D49455DBBF0AD0CFC889D265B2C09C16E948F16BA0E9CE61B9F7F1F0F61`).
  The unpacked Electron app built correctly. NSIS failed twice at its 249 MB mmap step on this machine,
  so the invalid 230 KB partial installer was renamed with `.failed-partial.exe` and must not be shipped.
- Railway deployment `826f613e-e828-4f9c-b215-56a4eaa10ab2` reached `SUCCESS` and replaced the prior
  release. `https://vcut.io/edit` returned HTTP 200 from the new container; the existing microphone,
  camera, and display-capture permissions policy is present. This release is live.

No commit or push was made. The implementation remains in the `packages/vcut` submodule working tree;
the root repository only reports that submodule as modified. Production deployment was made from this
working tree, so a later commit must preserve it exactly.

## Latest release: Canvas Controls UX & Fit Zoom Alignment — 2026-09-23

### 1. Floating Canvas Controls & Rotation Clean-Up (`src/ui/TransformHandles.tsx`, `src/i18n/translations.ts`)
- **Reset Button Resets Rotation**: In crop mode, the Reset button now resets both crop fractions and rotation (`rotationDeg: 0`), and disables only when both crop is all zeros and `rotationDeg === 0`.
- **Crop & Rotate Icon Button**: Replaced the text "Crop" button in the collapsed floating pill with a dedicated `CropRotateIcon` (representing crop brackets with rotation arrow), matching the Keyframe icon button size (`w-6 h-6`) and aesthetics.
- **Removed Green Rotation Handler**: Removed the green rotation dot button and stem line from the canvas overlay. Rotation is now cleanly and smoothly controlled via the straighten ruler dial inside the Crop & Rotate floating menu, preventing canvas visual clutter.
- **User-Friendly Bottom-Center Positioning**:
  - Previously, the toolbar checked `rightGap >= dockWidth + 12` and was pushed into the empty margin far to the right of the canvas, or collapsed right on top of the bottom-right resize handle.
  - Re-anchored the floating toolbar horizontally to the canvas center (`canvasCenterX = (canvasRect.left + canvasRect.right) / 2`), clamped within the stage.
  - Re-anchored vertically to the bottom of the canvas (`canvasRect.bottom - 24` when collapsed, `canvasRect.bottom - 46` in crop mode), providing clean clearance for bottom crop handles while keeping controls comfortably accessible directly above the timeline.
- **Khmer Localization**: Added `"Crop & Rotate": "កាត់ទំហំ និងបង្វិល"` to `KM_TRANSLATIONS`.

### 2. Handle Alignment & Stage Breathing Room at Fit Zoom (`src/ui/Preview.tsx`)
- **Problem**: In the editor preview, transform handles looked correct at 80% zoom, but at "Fit" zoom (`previewZoom = 1`), the handles looked broken: the top green rotate handle was clamped 40px downward directly inside the top edge of the clip, the connecting stem line was hidden, and the 4 corner resize handles were forced 12px inward away from the clip's corners while the blue bounding box shot 12px past them.
- **Root Cause**:
  - `Preview.tsx`'s `recompute()` letterboxed the canvas against raw `box.clientWidth` and `box.clientHeight` with zero padding at `previewZoom = 1`. For a 9:16 portrait video in a standard studio layout, the canvas filled 100% of `box.clientHeight`, touching the top and bottom edges of `previewBoxRef` with 0px slack.
  - `previewBoxRef.current` was passed as `stageEl` to `TransformHandles` and `TextTransformHandles`, which clamped handles into `stageRect` inset by `margin = HANDLE_SIZE / 2 = 12px`.
  - Because `canvasRect.top === stageRect.top`, the true rotate point at `canvasRect.top - 28px` and top corner handles at `canvasRect.top` were pushed downward to `stageRect.top + 12px` (inside the video), while bottom corner handles were pushed upward to `stageRect.bottom - 12px`.
  - At 80% zoom, the 20% slack (~45px top/bottom) kept all handles unclamped, which is why 80% looked correct.
- **Solution**:
  - In `Preview.tsx`, updated `recompute()` to reserve fit clearance (`fitPadX = 32px`, `fitPadY = 48px`) when computing `scale` for normal preview mode, while retaining edge-to-edge letterboxing in fullscreen mode (`fitPadX = 0`, `fitPadY = 0`).
  - The corner resize handles sit precisely on the 4 corners of the clip and bounding box.

## Previous release: Centered Transition Timing & Production "Remove Object" Fix — 2026-09-23

### 1. Transition Timing Alignment (`[cut - D/2, cut + D/2]`)
- **Problem**: Previously, transitions between adjacent clips rendered exclusively on the incoming clip starting at the cut point (`[cut, cut + D]`), while the timeline UI displayed transitions centered symmetrically across the junction spanning `[cut - D/2, cut + D/2]`. This caused a severe visual and audio mismatch between the editor timeline and the rendered export/playback.
- **Timeline & Playback Geometry (`src/timeline/transitions.ts`, `src/playback/PlaybackEngine.ts`)**:
  - `findActiveTransitionAtTime(track, time)`: Accurately identifies junction transitions spanning `[cut - D/2, cut + D/2]`, calculating `progress = (time - (cut - D/2)) / D`, `fromSourceTime = transitionPartnerSourceTime(fromClip, elapsed - D/2)`, and `toSourceTime = toClip.sourceIn - D/2 + elapsed`.
  - `transitionPartnerSourceTime`: Handles negative `elapsedPastCut` values before the cut without clamping to 0, ensuring smooth lead-in playback across the predecessor clip before the junction seam.
  - `transitionTailExtension`: Computes `blend.duration / 2` for the outgoing clip, allowing audio mix scheduling to seamlessly play outgoing audio through the junction midpoint into silence or tail handles.
  - `resolveAudioTransitionGain`: Ramps both outgoing and incoming audio channels across `[cut - D/2, cut + D/2]`, crossing at `gain: 0.5` at the cut seam.
  - `PlaybackEngine`: Visual layer rendering (`drawVisualLayers`, `drawVideoClip`, `drawTransitionPartner`, and text layers) utilizes `findActiveTransitionAtTime` to composite centered transition frames during playback.
- **Export Filtergraph Generation (`src/export/buildExportPlan.ts`, `src/export/buildAudioOnlyExportPlan.ts`)**:
  - `buildSegments`:
    - Snaps `halfD = snapToFrame(D / 2, fps)` to the project frame grid so that all video cuts align with discrete frame boundaries.
    - Predecessor's solo segment duration is shortened by `halfD`.
    - Transition segment is emitted with `from.sourceIn = partner.sourceOut - halfD` and `to.sourceIn = clip.sourceIn - halfD`.
    - Successor's solo segment starts at `clip.sourceIn + (D - halfD)` with duration `fullDuration - (D - halfD)`.
    - Total sequence duration is strictly conserved to the microsecond.
  - Head underflow handling (`pushVideoSourceInput`, `pushKeyframedAudio`, `buildAudioTrackStream`): When `to.sourceIn < 0`, inputs seek at `-ss 0` with read duration `D - underflow`, video is padded using `tpad=start_mode=clone:start_duration=${underflow}`, and audio is synchronized using `adelay=${underflowMs}`.
  - `buildAudioTrackStream`: Refactored to utilize centered `fromSourceIn` and `toSourceIn` with `adelay` for audio-track crossfades.
- **Test Suite Updates**:
  - Updated `tests/transitionMotion.test.ts`, `tests/transitions.test.ts`, `tests/export.test.ts`, `tests/buildAudioOnlyExportPlan.test.ts`, `tests/transitionRender.test.ts`, and `tests/transitionHandlesRender.test.ts` to assert the centered transition model.

### 2. Production "Remove Object" Web Architecture Root Cause & Fix
- **Problem**: On the production web app (`https://vcut.io`), clicking "Remove Object" reported: *"FFmpeg isn't available — reinstall dependencies to use this."*
- **Root Cause Analysis**:
  - On the desktop app, Remove Object relies on locally installed ffmpeg.
  - On the hosted web app, client `inpaintAvailable()` performs a `HEAD /api/vcut/inpaint` probe to verify server capabilities.
  - All capability `HEAD` handlers (`/api/vcut/inpaint`, `/api/vcut/inpaint/predict`, `/api/vcut/export`, `/api/vcut/captions`, `/api/vcut/captions/transcribe`, `/api/vcut/ai-video`) were wrapped in `hostedSessionRoute` / `hostedSessionRouteCors`.
  - In hosted mode, `hostedSessionRoute` requires an active authenticated user session (`resolveHostedSessionOrUnauthorized`). For unauthenticated or guest users, it returned `401 Unauthorized`.
  - Frontend `inpaintAvailable()` in `src/ui/Inspector.tsx` received the 401 response and returned `false`.
  - The Inspector UI defaulted to showing the desktop-specific message *"FFmpeg isn't available — reinstall dependencies to use this."*
- **Permanent Solution**:
  - Switched capability probe handlers (`HEAD`) across `studios/vcut/app/api/vcut/*` from `hostedSessionRoute` to `publicSessionRoute` and `publicSessionRouteCors`. These routes now report capability availability without requiring login.
  - Updated `src/ui/Inspector.tsx` fallback messaging: in hosted/web mode, when AI inpainting is unavailable, it renders *"Remove Object is temporarily unavailable — please try again later."* instead of the irrelevant desktop FFmpeg dependency notice.

### 3. Verification
- **All 1,104 tests pass** across 183 test suites in `packages/vcut` (`npm test`).
- **Zero TypeScript errors** in `packages/vcut` (`npx tsc --noEmit`).
- **Zero TypeScript errors** in `studios/vcut` (`npx tsc --noEmit`).
- **Production build succeeds** in `studios/vcut` (`next build --webpack`).

## Latest release: one-edge crop and one-click transform keyframes

Crop no longer re-fits and recenters the remaining image. Top, Right, Bottom, and Left move independently while the opposite edge stays fixed in preview and export, including rotated clips. The Inspector exposes one direction at a time plus **Edit crop on preview**. The preview toolbar now has a diamond that adds/updates a transform keyframe at the playhead in one click and removes the current keyframe when clicked again.

Commit `5cb2add` is pushed. All 1,102 tests pass, both production builds pass, responsive browser checks pass at 1440px/390px, and a real FFmpeg render verifies one-sided crop output. Railway deployment `c7cae957-439d-4203-b63b-9ffcc13f0723` is live with `SUCCESS`. Fresh artifacts are `VCut Setup 0.2.2-crop-keyframe-update.exe` (SHA-256 `189A0214B85960F327B83AF2191E63266BFA09ED71742838181C26D0E9DF11B9`) and `VCut-0.2.2-crop-keyframe-update.apk` (SHA-256 `FEAFF19EA095806BAAC2358A6ECEAF4E9A5FDDD6B76863831E539F2BFA66C40D`). iOS assets are synced; compilation/signing requires a Mac.

## Latest release: preview crop and resize UX

The selected clip now offers an on-canvas Crop mode with draggable, rotation-aware edge handles, a rule-of-thirds grid, live visible-area percentages, Reset/Done controls, mobile-safe handle placement, a live resize percentage, keyboard-accessible crop/resize, and one-step undo. The Inspector also has Reset crop. Relevant files are `src/ui/TransformHandles.tsx`, `src/playback/transformGeometry.ts`, `src/ui/Inspector.tsx`, `tests/transformGeometry.test.ts`, and `scripts/transform-check/check-crop.cjs`.

Verification: 1,100 VCut tests pass; Studios production build and strict mobile wrapper build pass; Playwright crop workflows pass at 1440px and 390px. Commit `341b057` is pushed. Railway deployment `6f03935b-d439-4f25-824a-1dfd6e908be3` is live with `SUCCESS`. Fresh artifacts are `VCut Setup 0.2.2-crop-preview-update.exe` (SHA-256 `B22C3D5A2E54EE2500C7521FC1ADD54F6751EDD50189D5D2663864CD9D22EEF6`) and `VCut-0.2.2-crop-preview-update.apk` (SHA-256 `2727A87361EAC51FAD511221443B118292BAC3D7F7B28C4A6B592A56FEE93112`). The iOS assets are synced; compiling/signing them still requires macOS with CocoaPods/Xcode.

## Text Style Presets System, Toolbar Font/Style Tools & Preview Fidelity Overhaul — 2026-09-22

### Overview & Architecture
Delivered a production-ready, extensible Text Style Presets system giving VCut users a polished, CapCut/Canva-like library of instantly applicable text styles while keeping all text fully vector/text-based and editable.

1. **Reusable TextStylePreset Schema & Curated Library (`src/project/textStylePresets.ts`, `src/project/types.ts`):**
   - Strongly typed `TextStylePreset` schema representing combinations of: font family, font size, font weight, font style, letter spacing, line height, text alignment, text transform (`uppercase`, `lowercase`, `capitalize`, `none`), solid fill color, multi-stop linear/radial gradients (`TextGradientFill`), dual-stroke outlines (primary `strokeColor`/`strokeWidth` + secondary outer `strokeColor2`/`strokeWidth2`), multiple shadows & glows (`glowSpread`, `color`, `blur`, `offsetX`, `offsetY`), snug background badge highlights (`backgroundColor`, `backgroundOpacity`, `backgroundPadding`, `backgroundCornerRadius`), opacity, blur, blend modes, and text decoration.
   - 86 curated, distinct presets across 18 categories: *Trending*, *Minimal*, *Bold*, *Cinematic*, *Social*, *Subtitle*, *Neon*, *Glow*, *Retro*, *Y2K*, *Chrome*, *Gaming*, *Comic*, *Luxury*, *Cute*, *Gradient*, *Meme*, and *Editorial*.
   - Validation & sanitization helpers: `validateTextStylePreset`, `sanitizeTextStylePreset`, `isPresetDark`, `parseColorLuminance`.
2. **Multi-Pass Canvas2D Rendering Pipeline (`src/playback/textLayout.ts`, `drawTextFrame`):**
   - Render passes:
     1. Rounded background badge pill (using measured layout bounds, padding, and corner radius).
     2. Outer secondary stroke (`strokeColor2`, `strokeWidth2 + strokeWidth`).
     3. Primary stroke (`strokeColor`, `strokeWidth`) with glow/shadow.
     4. Inner fill (solid or linear/radial gradient) rendered cleanly over strokes to eliminate anti-aliased edge bleeding.
   - Dynamic text transformation (`applyTextTransform`) and letter spacing via canvas context with character fallback.
3. **Command Pipeline & Timeline State (`src/commands/index.ts`, `src/store/editorStore.ts`):**
   - `buildTextStylePresetCommand` & `buildTextStylePatchCommand`:
     - Applies preset properties directly to asset style while preserving existing clip timing, duration, position (`transform.x`, `transform.y`), scale, and user text content.
     - Synchronizes `textStyleKeyframes` via `SetClipTextStyleKeyframesCommand` so that keyframed text clips remain synchronized.
     - Supports batch application to multiple selected text clips simultaneously.
     - Auto-targeting: when no clip is selected, automatically targets the text clip intersecting the current playhead.
     - Live hover preview: `setLivePreviewOverrides({ [clipId]: { style: previewStyle } })` enables instantaneous canvas updates on preset card hover, reverting smoothly on mouse leave.
4. **Toolbar Font Tool & Style Picker Menus (`src/ui/FontPickerMenu.tsx`, `src/ui/StylePickerMenu.tsx`, `src/ui/VCutApp.tsx`):**
   - Added dedicated **Font** tool button (`Type` icon) and **Styles** button (`Sparkles` icon) directly in the editor toolbar.
   - `FontPickerMenu`: Dropdown menu with categorized typography (Sans, Serif, Display, Monospace, Handwriting, Khmer), font preview renderings, and live hover preview on canvas.
   - `StylePickerMenu`: Dropdown floating popover with embedded `TextStylePresetGrid` providing quick one-click style access without navigating away to the Inspector panel.
   - Bidirectional state synchronization between Toolbar menus and Inspector panel.
5. **Adaptive Contrast for Dark Presets (`src/project/textStylePresets.ts`, `src/ui/TextStylePresetGrid.tsx`):**
   - Solved dark text preset invisibility (*Minimal Black*, *Charcoal Clean*, *Stealth*) against dark editor theme backgrounds.
   - Implemented `parseColorLuminance(color)` and `isPresetDark(preset)`. Preset cards dynamically evaluate visual luminance (accounting for fills, strokes, and backgrounds) and render an adaptive light-neutral checkerboard/card canvas (`bg-neutral-100 text-neutral-900`) for dark presets, while preserving dark backgrounds for bright/neon presets and bright highlight badges.
6. **Preset Thumbnail Fidelity Overhaul (`src/ui/TextStylePresetGrid.tsx`):**
   - Redesigned `PresetThumbnail` using a stacked layered structure:
     - Outer secondary stroke layer.
     - Inner primary stroke layer.
     - Top fill layer (`z-10 relative`) with gradient clip (`background-clip: text`), completely preventing WebKit stroke-over-gradient clipping.
     - Snug inline-block badge for presets with background highlights (`preset.style.backgroundColor`).
   - Added automatic font preloading on mount: `preloadAllFonts()` + `document.fonts.ready` triggers a clean re-render once all web fonts are loaded.

### Verification & Deployment
- Package TypeScript (`packages/vcut`): 0 errors (`--noEmit --incremental false`).
- Host TypeScript (`studios/vcut`): 0 errors (`--noEmit --incremental false`).
- Full test suite: 1,097 passed, 0 failed across 181 test suites (including 27 dedicated tests in `textStylePresets.test.ts`).
- Production Deployment: Railway service `vcut` deployment `219ab461-f907-48bd-876e-9144fdf25cc2` (SUCCESS). Live endpoint `https://vcut.io/edit` returning 200 OK.
- Git Commits Pushed:
  - `veasnawt/vcut`: `1865f78`, `903be7c`, `c6c0047`, `5e5d60c`
  - `veasna-os`: `6d18404`, `b27395c`, `9668bea`, `b75b397`

## Music Tool Audio Preview, Waveform Visualization & Duration Fixes — 2026-09-22

### Root Cause & Investigation
- Preview playback showed a static blue duration bar instead of an active waveform animation.
- Running duration counter was missing during audio playback.
- Adding music to the timeline used an artificially clamped/short duration or looped unexpectedly instead of accurately respecting the authentic 30s preview clip duration.

### Changes Made
1. `packages/vcut/src/ui/MusicPanel.tsx`: Added an animated dancing waveform bar visualizer during audio playback with real-time timestamp counter (`mm:ss / mm:ss`).
2. Replaced artificial audio looping with authentic one-shot preview playback.
3. Extracted accurate duration on import (`item.duration` passed to `api.downloadMusic`) and properly placed full-duration audio clips onto the timeline without premature truncation.

### Verification & Deployment
- Commits: `packages/vcut` `62e44cf`, `veasna-os` `2db8d71`.
- Verified in browser preview with waveform animation, accurate 30s timeline placement, and 0 console errors.

## HTTP Security Headers & MDN Observatory Compliance — 2026-09-21

- **Problem:** Resolving MDN Observatory failures for CSP, HSTS, X-Content-Type-Options, X-Frame-Options/frame-ancestors, and Referrer-Policy on `vcut.io`.
- **Audit & Configuration (`studios/vcut/next.config.ts`):**
  - Audited all required origins: Supabase (`https://*.supabase.co`, `wss://*.supabase.co`), Stock & media (`*.pexels.com`, `images.pexels.com`, `*.giphy.com`, `*.klipy.com`), Stripe (`checkout.stripe.com`), Google avatars (`lh3.googleusercontent.com`), blob/data/mediastream schemes, Next.js script/style hydration requirements (`'unsafe-inline'`), and bundled fonts (`/api/vcut/fonts/*`).
  - Added full CSP with `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, and `form-action 'self' https://*.supabase.co`.
  - Audited all 88 production client chunks for `eval` and dynamic code evaluation. Verified zero occurrences in runtime code (only a dead-code globalThis detection fallback in Webpack polyfills). Removed `'unsafe-eval'` from `script-src`.
  - Retained `'unsafe-inline'` for `script-src`: Next.js App Router relies on inline `self.__next_f.push` flight payloads for streaming/hydration; nonces require dynamic SSR which would destroy static prerendering and edge caching.
  - Added HSTS with a short initial rollout max-age: `max-age=86400; includeSubDomains`.
  - Added `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and `Referrer-Policy: strict-origin-when-cross-origin`.
  - Preserved existing `Permissions-Policy: microphone=(self), camera=(self), display-capture=(self)` for voiceover recording.
  - Omitted COEP/COOP to avoid breaking cross-origin media rendering or OAuth popups.
- **Verification:**
  - `studios/vcut` TypeScript check: 0 errors. Next.js production build passed (38s).
  - Test suite in `packages/vcut`: 1,075 passed, 0 failed across 177 suites.
  - All 13 static pages generated cleanly (`○ (Static)` preserved).
  - Verified auth, editor playback, media, workers, and Stripe functionality intact.

## Test Account & Password Sign-in Flow — 2026-09-21

- **Problem:** Needed a dedicated test account (`test@vcut.io`) on `vcut.io`. Because `@vcut.io` has no accessible mailbox to click magic links, entering this email needed to bypass the OTP email dispatch and instead prompt for a password.
- **Backend Setup:**
  - Configured user `test@vcut.io` in Supabase (`fd01e785-fb53-48e8-800e-a12d79492c9c`) with password `VCutTest#2026` and `email_confirm: true`.
  - Configured `profiles` row with Pro plan, 50 credits, and display name "VCut Tester".
- **Web & Desktop (`studios/vcut/app/login/page.tsx`):**
  - Added `isPasswordAccount(email)` check. When typing `test@vcut.io` (or `@vcut.io`) and clicking "Send sign-in link", the form transitions to password mode with show/hide toggle.
  - Submits via `supabase.auth.signInWithPassword()`. Validated with incorrect and correct passwords; redirects to `/projects` (or desktop `vcut://` handoff if `?desktop=1`).
- **Mobile (`packages/vcut/src/ui/MobileSignInDialog.tsx`):**
  - Added `"password"` phase. Typing `test@vcut.io` and pressing "Send code" switches to the password input, verifying with `signInWithPassword()`.
- **Deployed:** Railway production deployment `c33cf451-5c54-43ff-b1f2-d80b6f955920` (SUCCESS). Tested and approved by user.

## Native Desktop & Mobile Builds — 2026-09-21 (Tested & Approved)

- **Desktop (Windows)**:
  - Built with Next.js standalone and electron-builder: `apps/vcut-desktop/release/VCut Setup 0.2.2.exe` (installer) and `apps/vcut-desktop/release/win-unpacked/VCut.exe`.
- **Android**:
  - Web bundle built (`vcut-mobile`), synced with Capacitor, and compiled via Gradle: `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk` (~200 MB).
- **iOS**:
  - Web bundle built and Capacitor synced (`@capacitor/ios`) to `apps/mobile/ios/App/App/public`.
- **User Approval**: Builds tested and approved by user for git commit and push.

## Cross Transition Timeline UI Redesign — 2026-09-21

### Root Cause & Investigation
- The timeline junction for cross transitions (`TransitionJunction.tsx`) previously rendered corner-to-corner crossing diagonal lines (`M0 0L100 100M0 100L100 0`), which resembled an "X" or wireframe placeholder across the transition zone.
- User requested redesigning this to a clean, modern UI.

### Changes Made
- In `packages/vcut/src/ui/TransitionJunction.tsx`:
  - Removed the diagonal "X" lines entirely.
  - Added a clean translucent blend ribbon (`border-sky-400/50 bg-sky-950/80 rounded-md`) with soft opposing gradients and a hairline cut divider.
  - Added a floating dark-glass center badge with an overlapping-frames transition glyph + live duration text (`0.5s`) that scales and updates during drag adjustments.
  - Refined inactive cut buttons and drag handles.

### Verification & Deployment
- Package TypeScript (`packages/vcut`): 0 errors (`--noEmit --incremental false`).
- Host TypeScript (`studios/vcut`): 0 errors (`--noEmit --incremental false`).
- Full test suite: 1,075 passed, 0 failed across 177 test suites.
- Production Deployment: Railway service `vcut` deployment `f6097bbc-d2cf-40e8-9ea1-8e3e4052dc44` (SUCCESS). Live endpoint `https://vcut.io/edit` returning 200 OK.

## WebKit AudioSession Fix & Direct Record UI Overhaul — 2026-09-21

### Root Cause & Investigation
- When requesting audio capture on iOS Safari after preview playback had initialized, WebKit rejected `getUserMedia` with `InvalidStateError`.
- In WebKit's source code (`Source/WebCore/Modules/mediastream/MediaDevices.cpp`), `getUserMedia` throws `InvalidStateError` if the current `AudioSession` category is `"playback"`. In `AudioMixEngine.ts`, `navigator.audioSession.type = "playback"` was set to keep playback from being muted by iOS silent switch.
- User also requested removing the separate "Enable microphone" button gate so that the circular record button is always rendered immediately upon opening the modal on all platforms (web, iOS, Android).

### Changes Made
1. `packages/vcut/src/ui/useVoiceRecording.ts`: Added `setAudioSessionType(type: "playback" | "play-and-record")`. Switched `audioSession.type` to `"play-and-record"` immediately before `getUserMedia`, and reset to `"playback"` upon stream release or error. Added `micRequestPromiseRef` to safely share in-flight promises across pointer handlers and `start()`.
2. `packages/vcut/src/ui/VoiceRecordModal.tsx`: Completely removed the prerequisite "Enable microphone" button gate. The circular record button is always displayed. Pointer events trigger microphone preparation in the user activation turn, seamlessly starting countdown on tap or holding to record.

### Verification & Deployment
- Package TypeScript (`packages/vcut`): 0 errors (`--noEmit --incremental false`).
- Host TypeScript (`studios/vcut`): 0 errors (`--noEmit --incremental false`).
- Full test suite: 1,075 passed, 0 failed across 177 test suites.
- Production Deployment: Railway service `vcut` deployment `8a223dbc-f687-4353-85c1-7d55fddde98c` (SUCCESS). Live endpoint `https://vcut.io/edit` returning 200 OK.

## iOS Safari Microphone Access & Permissions-Policy Fix — 2026-09-21

### Root Cause & Investigation
On iOS Safari (vcut.io web), tapping "Enable microphone" triggered "Microphone access was denied" (`NotAllowedError`).
- iOS enforces system-level audio DSP (echo cancellation, noise suppression, and automatic gain control) at the hardware/WebKit layer.
- `useVoiceRecording.ts` previously used a static `RAW_AUDIO_CONSTRAINTS = { echoCancellation: false, noiseSuppression: false, autoGainControl: false }`. On desktop, this prevents the browser's aggressive canceller from distorting voice during sequence playback. But on iOS WebKit, requesting to disable these is an unsatisfiable constraint and WebKit rejects the promise with `NotAllowedError`.
- Additionally, Railway's reverse proxy and browser defaults benefit from an explicit `Permissions-Policy` HTTP response header allowing microphone access on `vcut.io`.

### Changes Made
1. `packages/vcut/src/ui/useVoiceRecording.ts`: Replaced static constraints with `audioConstraints(): MediaTrackConstraints | true`. Detects iOS / iPadOS user-agents and returns `true` (standard browser constraints). Desktop continues to receive raw constraints.
2. `studios/vcut/next.config.ts`: Added response `headers()` configuration returning `Permissions-Policy: microphone=(self), camera=(self), display-capture=(self)` for all routes.
3. String formatting: Ensured all status/error messages use proper UTF-8 em-dashes `—` matching `src/i18n/translations.ts`.

### Verification & Deployment
- Package TypeScript (`packages/vcut`): 0 errors (`--noEmit --incremental false`).
- Host TypeScript (`studios/vcut`): 0 errors (`--noEmit --incremental false`).
- Full test suite: 1,075 passed / 0 failed / 0 skipped.
- Railway production deployment: `1f785dfd-8f55-4469-b32e-d9e8ba970be9` (supersedes `943b2b83-ef06-4535-ae91-9f55996b5477`) completed with `SUCCESS`.
- Two-tier fallback in place: on any constraints rejection or `OverconstrainedError`, `getUserMedia` automatically retries with bare `{ audio: true }`.
- Live production check:
  - `GET https://vcut.io/` -> HTTP 200
  - `GET https://vcut.io/edit` -> HTTP 200, includes header `permissions-policy: microphone=(self), camera=(self), display-capture=(self)`
  - Active bundle `1521-084f999cfd6d98e6.js` verified live.
- No commits or pushes performed (preserved in working tree per standing rule).

## Codex continuation after Antigravity review — 2026-09-20

Antigravity performed review/verification only and explicitly reported no source edits. Codex read this handoff and continued the outstanding running-app checks. The historical review below is retained; its artifact and deployment statements are superseded by the latest release section of `HANDOFF_CODEX_REVIEW.md`. vcut.io is already deployed with user authorization, and the current downloads are the `transitions-update` desktop/APK files plus the prepared iOS project ZIP. No commits or pushes have been made.

Added `scripts/transition-check/check-app.cjs`: runs the actual packaged Next editor in headless Chromium against an isolated temporary workspace with three synthetic color clips. Passed at **1440x900 and 390x900**:

- Cut junction opens the picker; its bounds fit the viewport.
- In/Out context labels and style selection modify the correct incoming neighboring clip in the persisted project.
- Apply-to-every-cut updates both cuts; one undo restores the previous distinct styles.
- Duration slider drag does not persist draft changes; release commits, and one undo restores the prior duration.
- Escape closes the popup; no browser page errors.

Save assertions wait for the real `All changes saved` indicator (an initial fixed 350ms wait was flaky and was replaced). Screenshots were inspected at both sizes. The script removes only its own validated temporary workspace and stops its server/browser. It uses the packaged build; rebuild desktop first if testing subsequent application source edits. This continuation changed only verification code and documentation, so existing release builds remain current.

Run from the monorepo root with local dependencies:

```powershell
$env:PLAYWRIGHT_MODULE='C:/Users/Vergenzee/AppData/Local/npm-cache/_npx/ac56acf9ae97d38a/node_modules/playwright-core'
$env:CHROMIUM_PATH='D:/pw-browsers/chromium-1234/chrome-win64/chrome.exe'
node packages/vcut/scripts/transition-check/check-app.cjs
```

Still pending: actual Android/iOS device exports, Mac/Xcode signing/build access, human listening checks for transition audio, and the six user-supplied Khmer translations (requested again during this continuation; not invented). Existing real-render/audio and EOF tests remain evidence for automated behavior; this browser check uses silent color clips and does not substitute for listening or testing source video playback. No new commit/push approval is being assumed.

## Subsequent Auto Captions fix

See `HANDOFF_CODEX_REVIEW.md` for the hosted voiceover path fix and successful deployment `62d2ccf9-ef3b-4c07-ada6-0d0e5c07ff22`. The extraction route wrongly ignored account-library media; it now resolves from the authenticated owner library. Three real-FFmpeg regression cases and host TypeScript passed. Root repo source and test script are uncommitted in addition to the existing submodule changes.

## Context

This agent (Claude, via Antigravity) reviewed the full Codex handover and verified the working tree. **No source files were edited.** This document records what was verified, what still needs doing, and what the next agent or human needs to know.

Read these first:
- [`HANDOFF_TRANSITIONS.md`](HANDOFF_TRANSITIONS.md) — Claude (original agent)'s design rationale and architecture decisions.
- [`HANDOFF_CODEX_REVIEW.md`](HANDOFF_CODEX_REVIEW.md) — Codex's review, bug fixes, and implementation continuation.

## Verification completed — 2026-09-20 19:58 Asia/Bangkok

All three checks passed on the current uncommitted working tree:

```
packages/vcut TypeScript:  0 errors  (--noEmit --incremental false)
studios/vcut TypeScript:   0 errors  (--noEmit --incremental false)
Test suite:                1,075 pass / 0 fail / 0 skip (82.8 seconds)
```

Run from `packages/vcut`:

```powershell
node --test tests/*.test.ts
node node_modules/typescript/bin/tsc --noEmit --incremental false -p .
# Also from studios/vcut:
node node_modules/typescript/bin/tsc --noEmit --incremental false -p .
```

The test count (1,075) is 6 higher than Codex's last recorded run (1,069), consistent with test files that were updated alongside the transition work.

## Code review findings

### All Codex claims verified

Every file, function, and fix described in `HANDOFF_CODEX_REVIEW.md` was independently verified by reading the source:

| Claim | Verified |
|-------|----------|
| `mediaEnd.ts` — EOF hold, prevents browser restart | ✅ 12-line module, 3 test cases |
| `transitionMotion.ts` — single source of truth for preview + export | ✅ 194 lines, pure functions, no side effects |
| `buildExportPlan.ts` — all 19 styles rewritten with native FFmpeg filters | ✅ +818 lines; `pushTransitionBlend` + `pushSoloTransitionStages` |
| `transitions.ts` — outgoing clips continue past sourceOut (NLE handles) | ✅ `transitionPartnerSourceTime` + `transitionTailExtension` |
| `operations.ts` — `MAX_BLUR` raised from 20 → 60 | ✅ Line 691 |
| `nativeExport.ts` — `drawtextTextAlign: false` for Android | ✅ Line 284–285 in `src/api/nativeExport.ts` |
| `TransitionPickerMenu.tsx` — viewport clamping, pointer capture, draft-commit pattern | ✅ 272 lines, portal-based, ResizeObserver |
| `TransitionJunction.tsx` — new junction button with draggable duration handles | ✅ 94 lines, keyboard accessible |
| 5 new test files exist and cover the claimed scenarios | ✅ All present with correct content |
| Desktop + Android builds produced | ✅ SHA-256 hashes in Codex handover; not re-built |

### Architecture quality

- **Single source of truth** (`transitionMotion.ts`) is the right pattern. Preview and export share identical easing, slice bounds, glitch burst math.
- **Export performance**: moved from per-pixel `xfade=custom` (~1s/frame) to native filter chains (~0.6–1.5s/style at 360×640). Orders of magnitude faster.
- **EOF handling** (`holdMediaAtEnd`): compact, defensive, correctly handles NaN/Infinity duration, seeking-in-flight, and already-ended elements.
- **Android compat**: feature-flagged `drawtextTextAlign` is a clean capability pattern, not a platform hack.
- **Picker UX**: proper portal rendering, viewport-aware positioning, pointer capture lifecycle, draft-commit-on-release for duration slider (avoids undo stack thrashing).

### Minor observations (no action needed now)

1. **CRLF warnings**: 7 files show `LF → CRLF` in `git diff`. Normal for Windows; consider a `.gitattributes` rule eventually.
2. **Path reference**: Codex handover mentions `src/export/nativeExport.ts` in one place, but the actual file is `src/api/nativeExport.ts`. Documentation-only discrepancy, not a code issue.
3. **`package.json` missing `"type": "module"`**: Node emits `MODULE_TYPELESS_PACKAGE_JSON` warnings during test runs. Tests still pass; this is cosmetic.

## Current working tree state

`packages/vcut` is a separate Git repository (submodule). Current HEAD: `c3f0d7e` on `main`.

### Modified files (19)

```
src/api/nativeExport.ts                  (+11)
src/export/buildAudioOnlyExportPlan.ts   (+11)
src/export/buildExportPlan.ts            (+818)
src/playback/AudioMixEngine.ts           (+18)
src/playback/PlaybackEngine.ts           (+780/-780)
src/project/types.ts                     (+45)
src/store/editorStore.ts                 (+11)
src/timeline/operations.ts               (+2)
src/timeline/pixelEffects.ts             (+62)
src/timeline/transitions.ts              (+57)
src/ui/Inspector.tsx                     (+2)
src/ui/Timeline.tsx                      (+27)
src/ui/TimelineClip.tsx                  (+6)
src/ui/TransitionPickerMenu.tsx          (+129)
src/ui/VCutApp.tsx                       (+71)
tests/buildAudioOnlyExportPlan.test.ts   (+6)
tests/export.test.ts                     (+407/-407)
tests/operations.test.ts                 (+16)
tests/transitions.test.ts               (+4)
```

### New untracked files (12)

```
HANDOFF_CODEX_REVIEW.md
HANDOFF_TRANSITIONS.md
HANDOFF_CLAUDE_REVIEW.md            ← this file
assets/images/vcut-100x100.png
scripts/transition-check/           (3 scripts)
src/playback/mediaEnd.ts
src/timeline/transitionMotion.ts
src/ui/TransitionJunction.tsx
tests/mediaEnd.test.ts
tests/transitionHandlesRender.test.ts
tests/transitionMotion.test.ts
tests/transitionRender.test.ts
tests/transitionZoomRender.test.ts
```

## Remaining work

### 1. Manual app testing (not done by any agent)

No agent has tested the running app interactively. This requires a human or browser automation:

- Tap cut junctions on the timeline, verify popup placement on mobile widths
- Pick transition styles from both In/Out tabs, verify labels match context
- Drag the duration slider, verify draft-commit behavior
- "Apply to every cut on this track" + single undo
- Play through a blend with an outgoing clip that has real source handles — listen for audio clicks
- Play through a blend where outgoing footage is exhausted — verify held frame + silence
- Test on desktop widths and mobile widths

### 2. Six Khmer translations

Still needed in `src/i18n/translations.ts` (`KM_TRANSLATIONS`). `Duration` and `Fade out` already have entries. Missing:

| English key | Khmer (user to provide) |
|---|---|
| `From previous clip` | — |
| `Into next clip` | — |
| `Apply to every cut on this track` | — |
| `Applied to every cut on this track` | — |
| `Add transition` | — |
| `Change transition` | — |

Ask the user for these translations. Do not invent them.

### 3. Commit and push

**Standing rule: ask the user before any `git commit` or `git push`.**

When approved:
1. Commit in `packages/vcut` first (it's a separate repo/submodule)
2. Commit the bumped submodule pointer in the monorepo root (style: `chore: bump vcut — <summary>`)
3. Deployment is a separate decision — ask

### 4. Optional follow-ups

- Multiline text alignment parity on mobile (left justification only; Codex noted this)
- Transition picker thumbnail blur scaling (deliberately unscaled for performance)
- `.gitattributes` for line-ending consistency
- `"type": "module"` in `package.json` to suppress Node warnings

## Build artifacts (not rebuilt by this review)

Codex produced these; SHA-256 hashes are in `HANDOFF_CODEX_REVIEW.md`:

- **Windows x64 installer**: `apps/vcut-desktop/release/VCut Setup 0.2.2-zoom-fix.exe` (232 MB, unsigned)
- **Android debug APK**: `apps/mobile/android/app/build/outputs/apk/debug/VCut-0.2.2-export-fixes.apk` (200 MB, debug signed)

Both include the text_align fix + zoom geometry fix. Neither was installed, published, or deployed by any agent.

## Tools and environment

- Node `v22.23.1`
- FFmpeg: `node_modules/.pnpm/ffmpeg-static@5.3.0_supports-color@8.1.1/node_modules/ffmpeg-static/ffmpeg.exe`
- Chromium: `D:/pw-browsers/chromium-1234/chrome-win64/chrome.exe`
- Playwright: `C:/Users/Vergenzee/AppData/Local/npm-cache/_npx/ac56acf9ae97d38a/node_modules/playwright-core`
- Workspace: `D:/Veasna/App Development/veasna-os`
