# Handover: VCut transitions + blur overhaul (in progress)

Written 2026-09-20 for whichever agent picks this up next (e.g. GPT-6 Astra). You have no prior
context, so everything you need is here. Nothing below is committed yet.

## Continuation update from Codex - 2026-09-20

Read **[HANDOFF_CODEX_REVIEW.md](HANDOFF_CODEX_REVIEW.md)** first for current implementation status, regression details, and reproducible checks. The original sections below are retained as design history.

The user authorized edits. Codex fixed EOF playback restart, solo transition endpoint flashes, the blur clamp, audio preroll after EOF, dropped keyframed export frames, transparent flash compositing, and picker positioning/state issues. Updated tests and added real FFmpeg coverage for all 19 styles, source handles, overlays, keyframed clips, and EOF audio. Full suite: **1,018 pass, 0 fail, 0 skipped**; package and host type-checks pass. Isolated Chromium playback checks pass.

Original remaining-work items 1, 2, 3, and 6 are addressed (item 2 through automated real-export render tests). Item 4 still needs manual running-app/device interaction; isolated headless checks do not replace it. Item 5 still needs six user-provided Khmer translations; Duration and Fade out already exist. Nothing has been committed or pushed. The user subsequently authorized a vcut.io deployment, now live; see the latest release section in HANDOFF_CODEX_REVIEW.md for the 1,075 passing tests, new adjacent controls, mobile flash fix, current desktop/APK artifacts, and prepared iOS project. Preserve the standing commit/push approval rule.

## Repo facts you need first

- Monorepo root: `D:\Veasna\App Development\veasna-os`. **`packages/vcut` is its own git repo (a
  submodule)** — commit there first, then commit the bumped submodule pointer in the root repo
  (root commit style: `chore: bump vcut — <summary>`; see `git log` in both).
- **Ask the user before any `git commit`/`push`.** Standing rule: never auto-commit.
- Windows machine, Git Bash available. Node 22 runs `.ts` directly (type stripping).
- Type-check: `cd packages/vcut && npx tsc --noEmit -p .` (currently clean).
- Tests: `cd packages/vcut && node --test tests/*.test.ts` (took ~5 min; last run: 851 pass / 11 fail —
  the failures are expected, see "Remaining work" #1).
- Bundled FFmpeg (same 6.1.1 build desktop/server/mobile use):
  `node_modules/.pnpm/ffmpeg-static@5.3.0_supports-color@8.1.1/node_modules/ffmpeg-static/ffmpeg.exe`
- Playwright Chromium for headless canvas checks: `D:/pw-browsers/chromium-1234/chrome-win64/chrome.exe`,
  playwright-core at `C:/Users/Vergenzee/AppData/Local/npm-cache/_npx/ac56acf9ae97d38a/node_modules/playwright-core`.

## What the user asked for

1. Crossfade vs Dissolve — difference, and should one be removed?
2. Better UX for applying a transition between two adjacent clips.
3. Clip **Blur** effect: export much weaker than preview.
4. Slice Up/Down, Circle Open/Close, Zoom Blur wrong after export.
5. Glitch Cut wrong in preview and export; preview lags.
6. Water Ripple wrong in preview (export OK).
7. Make transitions smoother; fix all related bugs.

## Root causes found (all verified, not guessed)

- **Blur**: Chrome's canvas `filter: blur(Npx)` ignores the canvas transform (measured with Playwright:
  identical spread at scale 1 and 0.25). The preview draws a 1080-wide sequence onto a much smaller
  backing canvas, so the same value blurred 2–3× harder in preview than export's `gblur`. The Safari
  fallback also used ONE box pass (σ≈r/√3, boxy) and measured the radius in source pixels.
- **Slice**: FFmpeg `vuslice`/`vdslice` are horizontal bands; the preview draws a vertical-strip cascade.
- **Circle**: FFmpeg `circleopen/close` are a very soft blob that barely moves until late (frame dumps).
- **Zoom Blur / Glitch** export: fixed-strength pre-pass for the whole transition → hard pop at both
  ends; preview ramped. Glitch preview processed two full 1080×1920 frames per frame on the CPU with a
  `Math.sin` per pixel → lag.
- **Water Ripple preview**: passed 0..1 progress as "seconds" (wave barely moved) + full-res CPU cost.
- **Dissolve**: export used `xfade=dissolve` (grainy per-pixel noise) while preview showed a plain
  crossfade, so they looked identical while editing and different in the file.
- **Solo fades** (first clip's fade-in / last clip's fade-out): export always used a plain `fade`
  regardless of style; preview showed the style.
- **Two-clip "replay" bug (big one for request #2)**: the blend window sits at the start of the
  incoming clip B, and the outgoing clip A was sourced from `sourceOut - D` — so A's last D seconds
  played TWICE (once normally, again under the blend). Preview meanwhile PAUSED A (frozen frame) and
  cut its audio. Both now continue A past its out-point instead (see below).
- **Picker "Out" tab** did nothing between two touching clips (a clip's `transitionOut` only applies
  with no successor — `findTransitionOut`).

## What has been changed (all in `packages/vcut`)

- NEW `src/timeline/transitionMotion.ts` — single source of truth shared by preview and export:
  `transitionFamily` (moved here; re-exported from PlaybackEngine), `easeTransition` (ease-in-out
  cubic) + `easeTransitionExpr` (same curve as an FFmpeg expression), slice stagger + `sliceStripBounds`,
  `midpointIntensity`, and all Glitch Cut burst math (`glitchCutBurst`, `glitchCutShowsIncoming`, …).
- `src/timeline/pixelEffects.ts` — `applyGlitchCut` (new), `pixelScale` param on `applyWaterRipple`
  / `applyHorizontalBlur` so they can run on a downscaled working buffer.
- `src/playback/PlaybackEngine.ts`
  - `compositeTransitionFrame` rewritten: eased wipe/slide/slice/circle/whip; new glitch cut (hard
    flickering switch, one side processed per frame); ripple with real seconds; all per-pixel work at
    ≤640px working size (`applyPixelFxAtWorkScale`); whip pan no longer dims the incoming side.
    New optional last arg `durationSeconds`.
  - `compositeSoloReveal` takes a `SoloRevealTiming` arg; eased; same working-size processing.
  - Blur: `deviceScaleOf(context)` scales every canvas `blur()`; `buildCanvasFilterString(effects,
    blurScale = 1)`; Safari path uses `applyGaussianBlur` (3-pass box ≈ Gaussian) in the right units.
  - Text clips always preview as crossfade (text export has no per-style geometry).
  - Outgoing clip in a blend now keeps PLAYING (`syncMedia` + `syncVideoClipAudio` with fading gain)
    instead of being paused; `drawVideoLayer` protects it from `pauseInactive`.
  - `activeAudioClips` passes `sourceEnd` so audio-track clips play on into the blend.
- `src/playback/AudioMixEngine.ts` — `ActiveAudioTrackClip.sourceEnd`, used by `startTrackClip`.
- `src/timeline/transitions.ts` — `dissolve` removed from `TRANSITION_TYPE_OPTIONS` (serializer maps
  unknown/legacy `dissolve` → `crossfade` on load); new `transitionPartnerSourceTime` (outgoing
  continues past `sourceOut`, clamped to source end) and `transitionTailExtension`.
- `src/export/buildExportPlan.ts`
  - `TRANSITION_XFADE_NAME`, `applyTransitionCorruptionPass`, `applySoloCorruptionPass` removed.
  - New `pushTransitionBlend` (two-clip) and `pushSoloTransitionStages` (solo), plus helpers
    `sendcmd`, `frameTimesIn`, `piecewiseExpr`, `pushGlitchCutCorruption`, `blurSchedule`,
    `zoomBlurStages`, `flashStages`, `whipBlurStages`, `pushRipple` (uses `displace` with a 2px-wide
    `geq` map), `pushCircleMask` (quarter-res `geq` mask, upscaled), `pushMaskedAlpha`.
  - Only native filters on the hot paths. Measured: per-pixel `xfade=custom` ≈1 s/frame and full-res
    `geq` ≈0.3 s/frame at 1080×1920 — do NOT reintroduce them. Current exports of the test project
    take 0.6–1.5 s per style at 360×640 (previously up to 31 s).
  - Wipe/slide use built-in `xfade` re-timed onto the ease curve (`settb=1/1000000,setpts=…`, then
    `setpts=N/(fps*TB)`). Slice = per-strip `crop`+`overlay` with `t` expressions. Circle = mask +
    `alphamerge`. Zoom = `scale …:eval=frame` + `crop` + `gblur` driven by `sendcmd`. Flash =
    `colorlevels` via `sendcmd`. Glitch = `rgbashift` via `sendcmd` + cropped bands overlaid;
    switch via `overlay … enable=`. **Gotcha**: a runtime `gblur sigma` command does not update
    `sigmaV`; always send both.
  - Solo windows: `split` → main copy blanked with window-gated `drawbox` → other copy `trim`med to
    the window, styled, `overlay`ed back (`eof_action=pass`). Flash stage runs after the alpha fade.
  - Outgoing side of a transition now starts at `sourceOut` (`pushVideoSourceInput` holds the last
    frame with `tpad` if the file ends early; audio padded with `apad=whole_dur`). Same in the
    audio-track stream and `buildAudioOnlyExportPlan.ts`.
- `src/project/types.ts` — docs for `TransitionType` / `ClipEffects.blur` updated.
- `src/ui/Inspector.tsx` — Blur max 20 → 60 (preview no longer exaggerates, so users need headroom).
- `src/store/editorStore.ts` — `transitionPickerRequest` + setter.
- `src/ui/Timeline.tsx` — `TransitionJunctionButton` on every cut between touching video clips;
  opens the picker for that junction.
- `src/ui/TransitionPickerMenu.tsx` — tabs say "From previous clip"/"Into next clip" (or "Fade
  in"/"Fade out"), smart default tab, stays open after picking, duration slider (commit on release),
  "Apply to every cut on this track" (one `BatchCommand`).
- `src/ui/VCutApp.tsx` — wiring: Out tab edits the successor's `transitionIn` when one exists;
  junction requests open the picker anchored at the button.

## Verification done so far

- `scripts/transition-check/render.ts` builds a 2-clip project per style (solo fade-in, blend, solo
  fade-out), runs the REAL export plan through FFmpeg, and tiles frames:
  `node scripts/transition-check/render.ts <outDir> [comma,separated,types]` (env `SOLO=0` for blend
  only). Rows: fade-in 0–1 s, blend 3–4 s, fade-out 5–6 s. All 12 styles render and match the
  intended shapes.
- `scripts/transition-check/preview-render.cjs` bundles the real `compositeTransitionFrame`
  (`esbuild preview-entry.ts --bundle --format=iife --outfile=preview.js`, esbuild at
  `node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild`) and renders it in Chromium
  for side-by-side comparison. It expects `r/A.mp4` next to it (run render.ts with outDir `…/r` first)
  and its paths assume it lives in its own folder. Shapes matched export.

## Remaining work (in order)

1. **Update tests** in `tests/export.test.ts` (+ audio-only / transition tests). The 11 known
   failures assert the old strings (`vuslice`, `rgbashift=rh=8…`, `boxblur`, fixed `crop` zoom,
   `circleopen`, `dissolve`). More will fail from the replay fix (`-ss sourceOut - D` → `-ss sourceOut`,
   new `apad`). Rewrite them to assert the new graph shapes; add unit tests for
   `transitionMotion.ts` and `transitionPartnerSourceTime`/`transitionTailExtension`. The
   `transitionFamily.test.ts` import should still work (re-exported).
2. Re-run `render.ts` once more including: (a) media LONGER than the clip (so the outgoing clip's
   handle is used, not the `tpad` hold), (b) an overlay (non-base) video track (transparent path),
   (c) keyframed clips on both sides of a transition.
3. `npx tsc --noEmit` in `studios/vcut` too (it consumes this package).
4. Manual check in the running app (web, desktop): junction button placement/tapping on mobile
   widths, picker labels, slider, apply-to-all + single undo, and that preview playback through a
   blend is smooth with the outgoing clip moving and its audio fading (no click at the end).
5. Khmer strings for new UI text (`src/i18n/translations.ts`, `KM_TRANSLATIONS`): "From previous
   clip", "Into next clip", "Fade out", "Duration", "Apply to every cut on this track", "Applied to
   every cut on this track", "Add transition", "Change transition". They fall back to English now;
   ask the user for translations rather than inventing them.
6. Clean the one mis-wrapped doc comment in `buildExportPlan.ts` above `pushRipple` ("…stretched
   across the" line break).
7. Ask the user, then commit (vcut repo, then root submodule bump). Release/deploy is a separate
   decision — ask.

## Known limitations (deliberate, tell the user)

- Transition picker thumbnails and Filters preset swatches still use unscaled blur (tiny tiles;
  scaling them would cost too much per frame).
- The outgoing clip now shows footage past its out-point during a blend (standard NLE "handles").
  If that footage doesn't exist, it holds its last frame and its audio goes silent for the rest of
  the blend.
- Text clips only offer Crossfade (export limitation, unchanged).
