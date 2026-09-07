import { createClip, createTextAsset, createTrack } from "../project/createProject.ts";
import type { Project } from "../project/types.ts";
import { defaultClipDuration } from "../timeline/operations.ts";
import type { EditorState } from "../store/editorStore.ts";

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
  playhead: number
): Project | null {
  if (!project || !composeText || composeText.content.trim() === "") return project;

  const asset = createTextAsset(composeText.content, composeText.style);
  const duration = defaultClipDuration(asset);
  const clip = createClip({ assetId: asset.id, sourceIn: 0, sourceOut: duration, timelineStart: Math.max(0, playhead) });
  const track = createTrack("text", "");
  track.clips.push(clip);

  return {
    ...project,
    assets: [...project.assets, asset],
    sequence: { ...project.sequence, tracks: [...project.sequence.tracks, track] },
  };
}
