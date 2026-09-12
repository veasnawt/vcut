import { createClip, createColorAsset, createProject, createTextAsset, createTrack, newId } from "./createProject.ts";
import type { Asset, Project, Track } from "./types.ts";

/** What a saved template actually stores — deliberately NOT a full `Project`. A template exists to
 *  seed a new project's STRUCTURE (aspect ratio, tracks, any text/color-matte clips already laid
 *  out), never real footage: there's no file to carry forward for a video/audio/image clip the way
 *  there is for a text or color-matte asset (see `createTextAsset`/`createColorAsset`'s own doc
 *  comments — neither has a backing file at all, which is exactly what makes them safe to duplicate
 *  freely into a brand-new project with no import step). `tracks`/`assets` here are the SANITIZED
 *  subset `sanitizeProjectForTemplate` below produces, not a live project's own arrays. */
export interface TemplateProjectData {
  width: number;
  height: number;
  fps: number;
  tracks: Track[];
  assets: Asset[];
}

/** Strips a real project down to the shape a template actually stores — every clip whose asset is
 *  real media (video/audio/image) is dropped (the track itself stays, just without that clip); a
 *  text or color-matte clip carries over as-is, ids included, since this is a self-contained snapshot
 *  that hasn't been instantiated into a real project yet (fresh ids only get minted once it actually
 *  is — see `buildProjectFromTemplate` below — matching `createProject.ts`'s own "always mint fresh
 *  ids at construction time" convention rather than pre-emptively renaming ids in a document nothing
 *  else references yet). */
export function sanitizeProjectForTemplate(project: Project): TemplateProjectData {
  const keptAssetIds = new Set<string>();
  const tracks: Track[] = project.sequence.tracks.map((track) => {
    const clips = track.clips
      .filter((clip) => {
        const asset = project.assets.find((a) => a.id === clip.assetId);
        return Boolean(asset && (asset.kind === "text" || asset.kind === "color"));
      })
      .map((clip) => {
        keptAssetIds.add(clip.assetId);
        return { ...clip };
      });
    return { ...track, clips };
  });
  const assets = project.assets.filter((a) => keptAssetIds.has(a.id));
  return { width: project.sequence.width, height: project.sequence.height, fps: project.sequence.fps, tracks, assets };
}

/** The reverse of `sanitizeProjectForTemplate` — builds a brand-new, fully valid `Project` seeded
 *  from a saved template's structure, for the "start a new project from this template" flow.
 *  `createProject` handles every field a template doesn't care about (schemaVersion, a fresh project
 *  id, `luts`/`customFonts`/`customSfx`, `exportSettings` matching the template's own dimensions) —
 *  this only needs to replace its default single video+audio track pair with the template's own
 *  tracks/assets, reconstructed through the SAME `createTrack`/`createClip`/`createTextAsset`/
 *  `createColorAsset` constructors real authoring already goes through, so every id is freshly
 *  minted rather than copied verbatim (the same template used twice must never produce two projects
 *  that quietly share an asset or clip id). */
export function buildProjectFromTemplate(bpProjectId: string, name: string, template: TemplateProjectData): Project {
  const project = createProject(bpProjectId, name, { width: template.width, height: template.height, fps: template.fps });

  const assetIdMap = new Map<string, string>();
  const assets: Asset[] = template.assets.map((asset) => {
    const fresh =
      asset.kind === "color"
        ? createColorAsset(asset.color ?? "#000000")
        : createTextAsset(asset.textContent ?? "Text", asset.textStyle);
    assetIdMap.set(asset.id, fresh.id);
    return fresh;
  });

  const tracks: Track[] = template.tracks.map((track) => {
    const fresh = createTrack(track.kind, track.name);
    fresh.locked = track.locked;
    fresh.visible = track.visible;
    fresh.muted = track.muted;
    fresh.solo = track.solo;
    if (track.gain !== undefined) fresh.gain = track.gain;
    if (track.pan !== undefined) fresh.pan = track.pan;
    fresh.clips = track.clips
      .map((clip) => {
        const assetId = assetIdMap.get(clip.assetId);
        if (!assetId) return null;
        return createClip({ assetId, sourceIn: clip.sourceIn, sourceOut: clip.sourceOut, timelineStart: clip.timelineStart });
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);
    return fresh;
  });

  project.assets = assets;
  project.sequence.tracks = tracks;
  return project;
}

/** A fresh, app-generated id for a template row — same shape `newId` already gives everything else
 *  in a project, reused here rather than a raw `crypto.randomUUID()` so a template id is
 *  self-describing the same way. */
export function newTemplateId(): string {
  return newId("tpl");
}
