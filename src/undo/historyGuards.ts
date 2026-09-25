import type { Project } from "../project/types.ts";
import type { HistoryGuard } from "./UndoStack.ts";

/** Ids of clips whose asset is no longer in the project's asset list. */
export function orphanedClipIds(project: Project): string[] {
  const assetIds = new Set(project.assets.map((a) => a.id));
  const orphans: string[] = [];
  for (const track of project.sequence.tracks) {
    for (const clip of track.clips) if (!assetIds.has(clip.assetId)) orphans.push(clip.id);
  }
  return orphans;
}

/** Refuses an undo/redo that would bring back a clip pointing at media that has since been removed.
 *
 *  Removing media is not an undoable edit (it deletes the file), so this sequence used to be possible: delete a
 *  clip, remove its media from the library, undo the delete. The clip came back referencing an asset that no
 *  longer exists, and the serializer silently dropped it on the next save — the user saw it reappear, then
 *  vanish for good. Only clips that are NEWLY orphaned by this step count: a project that already contained
 *  orphans (older data) must not block every undo. */
export const refuseOrphanedClips: HistoryGuard = (before, after) => {
  const already = new Set(orphanedClipIds(before));
  const introduced = orphanedClipIds(after).filter((id) => !already.has(id));
  return introduced.length > 0 ? "That can't be undone — the media it used has been removed from the project" : null;
};
