import { createClip, createTextAsset, createTrack } from "../project/createProject.ts";
import type { Project } from "../project/types.ts";
import { defaultClipDuration } from "../timeline/operations.ts";
import type { EditorState } from "../store/editorStore.ts";

/** How long one loop of the phantom's animation preview lasts. */
const COMPOSE_PREVIEW_CYCLE_SECONDS = 2.6;

/** Lets `Preview`'s canvas show what a new text clip will actually look like WHILE it's still being
 *  typed in `NewTextComposer` — before anything real exists to select/render. Rather than teach the
 *  renderer a second, parallel "phantom clip" code path, this builds a throwaway `Project` — the real
 *  one plus one extra, never-persisted text track holding exactly one clip for the live draft — and
 *  hands THAT to `PlaybackEngine` for this frame only; every existing draw routine (text layer,
 *  transitions, the lot) already knows how to render a track/clip/asset, so reusing them here for a
 *  clip that merely doesn't exist in the undo-tracked project yet costs nothing new. Appended last so
 *  it composites on top, matching where a freshly-added track would actually land.
 *
 *  Returns `project` itself (no clone) whenever there's nothing to preview, so a component doing a
 *  reference-equality check (nothing here does today, but `PlaybackEngine` might reasonably start)
 *  never sees a new object for a frame where nothing actually changed. */
export function buildComposePreviewProject(
  project: Project | null,
  composeText: EditorState["composeText"],
  playhead: number,
  nowSeconds?: number
): Project | null {
  if (!project || !composeText || composeText.content.trim() === "") return project;

  const asset = createTextAsset(composeText.content, composeText.style);
  const duration = defaultClipDuration(asset);
  // While the draft has any animation, the phantom LOOPS it in real time: the clip's start is slid back by
  // however far through its own duration `nowSeconds` says we are, so the (paused) playhead lands
  // that far into it and the entrance, the loop and the exit all play over and over as you compose.
  // Static drafts keep the exact old placement.
  const animated = Boolean(composeText.animation || composeText.animationIn || composeText.animationOut || (composeText.hover && (composeText.hover.animation || composeText.hover.animationIn || composeText.hover.animationOut)));
  // A short cycle (not the clip's full default length) so the entrance AND the exit come round every couple
  // of seconds — waiting out a 5s default to see a slide-in twice a loop made the preview feel dead.
  const cycle = animated ? Math.min(duration, COMPOSE_PREVIEW_CYCLE_SECONDS) : duration;
  const loopOffset = animated && nowSeconds !== undefined && cycle > 0 ? nowSeconds % cycle : 0;
  const clip = createClip({ assetId: asset.id, sourceIn: 0, sourceOut: cycle, timelineStart: Math.max(0, playhead) - loopOffset });
  const hover = composeText.hover;
  const loop = hover && "animation" in hover ? hover.animation : composeText.animation;
  const animIn = hover && "animationIn" in hover ? hover.animationIn : composeText.animationIn;
  const animOut = hover && "animationOut" in hover ? hover.animationOut : composeText.animationOut;
  if (loop) clip.textAnimation = loop;
  if (animIn) clip.textAnimationIn = animIn;
  if (animOut) clip.textAnimationOut = animOut;
  const track = createTrack("text", "");
  track.clips.push(clip);

  return {
    ...project,
    assets: [...project.assets, asset],
    sequence: { ...project.sequence, tracks: [...project.sequence.tracks, track] },
  };
}
