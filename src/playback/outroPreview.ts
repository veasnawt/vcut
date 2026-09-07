import { createClip, createTextAsset, createTrack, sequenceDuration } from "../project/createProject.ts";
import type { Project } from "../project/types.ts";
import {
  OUTRO_BG_ASSET_ID,
  OUTRO_BG_SIZE,
  OUTRO_DURATION_SECONDS,
  OUTRO_FADE_SECONDS,
  OUTRO_LOGO_ASSET_ID,
  OUTRO_LOGO_HEIGHT,
  OUTRO_LOGO_SCALE,
  OUTRO_LOGO_WIDTH,
  OUTRO_TEXT_CONTENT,
  outroLogoOffsetY,
  outroTextStyle,
} from "../export/outro.ts";

/** Live-previews the outro end card `export/route.ts`'s own `buildOutroOnlyProject` actually renders
 *  at export time — same two synthetic assets (`OUTRO_BG_ASSET_ID`/`OUTRO_LOGO_ASSET_ID`, resolved by
 *  `Preview.tsx`'s own `mediaUrlFor` to `outroAssetUrl` instead of a real project asset's `relPath`),
 *  same background+logo track pair, same transform/crossfade values — every value shared from
 *  `export/outro.ts` specifically so this can never quietly drift from what actually gets appended.
 *  The ONE deliberate difference: the server's own version places both clips at `timelineStart: 0`
 *  (it's a standalone, throwaway project rendered on its own — see that function's own doc comment for
 *  why an ISOLATED render, not splicing into the real project, is what avoids a real OOM bug this
 *  feature hit once already); this one places them at `timelineStart: total` instead, since it's
 *  composited directly into a CLONE of the real, live project for the Preview canvas to draw — the
 *  same "throwaway clone, never touches the real project or its undo stack" category `composePreview.ts`'s
 *  own text-compose preview already established for exactly this kind of "show something before it's
 *  real" need.
 *
 *  Returns `project` itself unchanged (no clone) whenever the marker doesn't apply, matching
 *  `buildComposePreviewProject`'s own "no-op returns the same reference" convention. */
export function buildOutroPreviewProject(project: Project | null, showOutroMarker: boolean): Project | null {
  if (!project || !showOutroMarker) return project;
  const total = sequenceDuration(project);
  if (total <= 0) return project;

  const bgAsset = {
    id: OUTRO_BG_ASSET_ID,
    kind: "image" as const,
    name: "Outro background",
    relPath: "",
    duration: 0,
    hasAudio: false,
    sizeBytes: 0,
    importedAt: Date.now(),
    width: OUTRO_BG_SIZE,
    height: OUTRO_BG_SIZE,
  };
  const logoAsset = {
    id: OUTRO_LOGO_ASSET_ID,
    kind: "image" as const,
    name: "VCut logo",
    relPath: "",
    duration: 0,
    hasAudio: false,
    sizeBytes: 0,
    importedAt: Date.now(),
    width: OUTRO_LOGO_WIDTH,
    height: OUTRO_LOGO_HEIGHT,
  };

  const bgTrack = createTrack("video", "Outro Background");
  bgTrack.clips.push(createClip({ assetId: bgAsset.id, sourceIn: 0, sourceOut: OUTRO_DURATION_SECONDS, timelineStart: total }));

  const logoTrack = createTrack("video", "Outro Logo");
  const logoClip = createClip({ assetId: logoAsset.id, sourceIn: 0, sourceOut: OUTRO_DURATION_SECONDS, timelineStart: total });
  logoClip.transform = {
    offsetX: 0,
    offsetY: outroLogoOffsetY(project.sequence.width, project.sequence.height),
    scale: OUTRO_LOGO_SCALE,
    rotationDeg: 0,
    crop: { top: 0, right: 0, bottom: 0, left: 0 },
  };
  logoClip.transitionIn = { duration: OUTRO_FADE_SECONDS, type: "crossfade" };
  logoClip.transitionOut = { duration: OUTRO_FADE_SECONDS, type: "crossfade" };
  logoTrack.clips.push(logoClip);

  // The "VCut" wordmark below the logo — see `outroTextStyle`'s own doc comment for why its size/
  // position are computed from the sequence's own dimensions rather than fixed constants.
  const textAsset = createTextAsset(OUTRO_TEXT_CONTENT, outroTextStyle(project.sequence.width, project.sequence.height));
  const textTrack = createTrack("text", "Outro Text");
  const textClip = createClip({ assetId: textAsset.id, sourceIn: 0, sourceOut: OUTRO_DURATION_SECONDS, timelineStart: total });
  textClip.transitionIn = { duration: OUTRO_FADE_SECONDS, type: "crossfade" };
  textClip.transitionOut = { duration: OUTRO_FADE_SECONDS, type: "crossfade" };
  textTrack.clips.push(textClip);

  return {
    ...project,
    assets: [...project.assets, bgAsset, logoAsset, textAsset],
    sequence: { ...project.sequence, tracks: [...project.sequence.tracks, bgTrack, logoTrack, textTrack] },
  };
}
