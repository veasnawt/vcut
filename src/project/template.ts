import { clipDuration, createColorAsset, createProject, createTextAsset, createTrack, newId } from "./createProject.ts";
import type { Asset, Clip, Project, Track } from "./types.ts";

/** What a saved template actually stores — deliberately NOT a full `Project`, but (unlike this
 *  feature's own first version) not a structure-only skeleton either. A template exists to let someone
 *  ELSE reuse an entire edited look — every clip's timing, trim points, transform/effects/color-
 *  grading/keyframes, transitions, and any music — with their OWN photos/videos standing in for
 *  whatever video/audio/image footage the original edit used. `tracks`/`assets` here are the SANITIZED
 *  output `sanitizeProjectForTemplate` below produces: every clip survives as-is, but a clip whose
 *  asset is real media points at a PLACEHOLDER asset (`Asset.templatePlaceholder` set, no real file)
 *  instead of the original file, which was never something safe to hand to a stranger's project in the
 *  first place. */
export interface TemplateProjectData {
  width: number;
  height: number;
  fps: number;
  tracks: Track[];
  assets: Asset[];
}

/** One open slot a "fill in your media" step needs to ask about — see `templateSlots` below. */
export interface TemplateSlot {
  /** The placeholder `Asset.id` this slot fills — what `fillTemplateSlot` needs to find and replace. */
  assetId: string;
  slotIndex: number;
  /** What the ORIGINAL clip was — a real pick can still be either kind (see `fillTemplateSlot`'s own
   *  doc comment), this is just what the template author actually used, shown so a slot reads as
   *  "Video · 4.2s" rather than a bare number. */
  kind: "video" | "audio" | "image";
  requiredDuration: number;
}

/** Strips a real project down to the shape a template actually stores. Every clip is kept, ids and
 *  all — a template is a self-contained snapshot that hasn't been instantiated into a real project
 *  yet, so nothing needs fresh ids until `buildProjectFromTemplate` actually mints one (matching
 *  `createProject.ts`'s own "always mint fresh ids at construction time" convention rather than
 *  pre-emptively renaming ids in a document nothing else references yet). A text or color-matte asset
 *  carries over verbatim (see `createTextAsset`/`createColorAsset`'s own doc comments — neither has a
 *  backing file at all, so there's nothing to strip). A video/audio/image asset is replaced with a
 *  placeholder: same `kind`/`name`/dimensions/`hasAudio` (what the "fill in your media" step needs to
 *  describe the slot and validate a pick against), no real file (`relPath: ""`, `sizeBytes: 0` — the
 *  same "no backing file" convention a text asset's own empty `relPath` already uses), and a fresh
 *  `templatePlaceholder` marker. `slotIndex` is assigned across the WHOLE timeline in chronological
 *  order (by `clip.timelineStart`, tracks considered together) — not per-track — since that's the
 *  order a person filling in slots would actually expect ("the first thing that happens," not "every
 *  video-track clip, then every audio-track clip"). Each CLIP gets its OWN placeholder asset even when
 *  two clips originally shared one real asset (the same file used twice): asking a user to pick media
 *  for "slot 3" twice is a simpler, more predictable contract than tracking which slots secretly need
 *  to stay linked. */
export function sanitizeProjectForTemplate(project: Project): TemplateProjectData {
  const mediaClipOrder = project.sequence.tracks
    .flatMap((track) => track.clips.map((clip) => ({ track, clip })))
    .filter(({ clip }) => {
      const asset = project.assets.find((a) => a.id === clip.assetId);
      return Boolean(asset) && (asset!.kind === "video" || asset!.kind === "audio" || asset!.kind === "image");
    })
    .sort((a, b) => a.clip.timelineStart - b.clip.timelineStart);

  // Keyed by the clip's own id (not assetId — see the doc comment above on why each clip gets its own
  // placeholder rather than sharing one across clips that originally pointed at the same real asset).
  const placeholderAssetByClipId = new Map<string, Asset>();
  mediaClipOrder.forEach(({ clip }, slotIndex) => {
    const original = project.assets.find((a) => a.id === clip.assetId)!;
    placeholderAssetByClipId.set(clip.id, {
      id: newId("tplasset"),
      kind: original.kind as "video" | "audio" | "image",
      name: original.name,
      relPath: "",
      duration: clipDuration(clip),
      ...(original.width != null ? { width: original.width } : null),
      ...(original.height != null ? { height: original.height } : null),
      ...(original.fps != null ? { fps: original.fps } : null),
      hasAudio: original.hasAudio,
      sizeBytes: 0,
      importedAt: 0,
      templatePlaceholder: { slotIndex, requiredDuration: clipDuration(clip) },
    });
  });

  const keptTextColorAssetIds = new Set<string>();
  const tracks: Track[] = project.sequence.tracks.map((track) => ({
    ...track,
    clips: track.clips.map((clip): Clip => {
      const placeholder = placeholderAssetByClipId.get(clip.id);
      if (placeholder) return { ...clip, assetId: placeholder.id };
      keptTextColorAssetIds.add(clip.assetId);
      return { ...clip };
    }),
  }));

  const assets: Asset[] = [
    ...project.assets.filter((a) => keptTextColorAssetIds.has(a.id)),
    ...placeholderAssetByClipId.values(),
  ];

  return { width: project.sequence.width, height: project.sequence.height, fps: project.sequence.fps, tracks, assets };
}

/** The reverse of `sanitizeProjectForTemplate` — builds a brand-new, fully valid `Project` seeded
 *  from a saved template's structure, for the "start a new project from this template" flow.
 *  `createProject` handles every field a template doesn't care about (schemaVersion, a fresh project
 *  id, `luts`/`customFonts`/`customSfx`, `exportSettings` matching the template's own dimensions) —
 *  this only needs to replace its default single video+audio track pair with the template's own
 *  tracks/assets.
 *
 *  Every clip's OWN fields (transform, effects, color grading, every keyframe array, chroma key,
 *  transitions, text animation — everything beyond the four fields the old version of this function
 *  reconstructed through `createClip`) are preserved by copying the whole stored clip object rather
 *  than rebuilding it field-by-field: that's the entire point of a template being worth using at all
 *  — the exact edited LOOK has to survive, not just which clip sits where. Only `id` (freshly minted —
 *  the same template used twice must never produce two projects that quietly share a clip id) and
 *  `assetId` (remapped to the freshly-minted asset below) actually change.
 *
 *  A resulting project's own placeholder assets are NOT yet fillable content — every one of them still
 *  has `templatePlaceholder` set, exactly like the template's own stored version, just with a fresh
 *  `id` (`assetIdMap` is what lets each clip find its own new placeholder). `templateSlots` below is
 *  what a "fill in your media" UI calls next to find out what to ask for. */
export function buildProjectFromTemplate(bpProjectId: string, name: string, template: TemplateProjectData): Project {
  const project = createProject(bpProjectId, name, { width: template.width, height: template.height, fps: template.fps });

  const assetIdMap = new Map<string, string>();
  const assets: Asset[] = template.assets.map((asset) => {
    if (asset.kind === "color") {
      const fresh = createColorAsset(asset.color ?? "#000000");
      assetIdMap.set(asset.id, fresh.id);
      return fresh;
    }
    if (asset.kind === "text") {
      const fresh = createTextAsset(asset.textContent ?? "Text", asset.textStyle);
      assetIdMap.set(asset.id, fresh.id);
      return fresh;
    }
    // video/audio/image — still a placeholder (`sanitizeProjectForTemplate` never stores anything
    // else for these kinds), just with a freshly-minted id like every other asset here.
    const freshId = newId("tplasset");
    assetIdMap.set(asset.id, freshId);
    return { ...asset, id: freshId };
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
      .map((clip): Clip | null => {
        const assetId = assetIdMap.get(clip.assetId);
        if (!assetId) return null;
        return { ...clip, id: newId("c"), assetId };
      })
      .filter((c): c is Clip => c !== null);
    return fresh;
  });

  project.assets = assets;
  project.sequence.tracks = tracks;
  return project;
}

/** Every open slot in a project built from a template, oldest-first (matches the order a "fill in your
 *  media" picker should present them in — the same chronological order `sanitizeProjectForTemplate`
 *  assigned `slotIndex` in to begin with). Returns `[]` for an ordinary project — every asset there
 *  lacks `templatePlaceholder` — so a caller can unconditionally check this after creating ANY new
 *  project and just skip the picker step when it's empty, no separate "was this from a template" flag
 *  to thread through. */
export function templateSlots(project: Project): TemplateSlot[] {
  return project.assets
    .filter((a): a is Asset & { templatePlaceholder: NonNullable<Asset["templatePlaceholder"]> } => Boolean(a.templatePlaceholder))
    .map((a) => ({
      assetId: a.id,
      slotIndex: a.templatePlaceholder.slotIndex,
      kind: a.kind as "video" | "audio" | "image",
      requiredDuration: a.templatePlaceholder.requiredDuration,
    }))
    .sort((a, b) => a.slotIndex - b.slotIndex);
}

/** Binds a real, already-imported/generated/downloaded `Asset` into one open template slot, replacing
 *  the placeholder — every clip that referenced `placeholderAssetId` is repointed at `realAsset.id`
 *  instead, with its trim window reset to start from the real media's own beginning.
 *
 *  A picked IMAGE always fully satisfies the slot at its exact `requiredDuration` — a still frame has
 *  no real length of its own to run short on, unlike video/audio, which use only as much of the real
 *  file as it actually has (`Math.min`): asked for directly — auto-trimming from the start is the
 *  simplest, most predictable behavior, and a source shorter than required is used in full (the
 *  clip's own timeline length shrinks to match) rather than looped or held on its last frame, the same
 *  "never synthesize frames that were never really there" reasoning every other trim operation in this
 *  app already follows. The caller (a "fill in your media" UI) is what decides whether to warn about a
 *  short pick before calling this — this function just does the bind unconditionally.
 *
 *  `realAsset` is added to `project.assets` if it isn't already there (the common case — a fresh
 *  import/generation/stock download made specifically to fill this slot); already-present is handled
 *  too (picking something already in the project's own library elsewhere) without duplicating it. */
export function fillTemplateSlot(project: Project, placeholderAssetId: string, realAsset: Asset): Project {
  const placeholder = project.assets.find((a) => a.id === placeholderAssetId);
  if (!placeholder?.templatePlaceholder) return project;
  const requiredDuration = placeholder.templatePlaceholder.requiredDuration;
  const sourceOut = realAsset.kind === "image" ? requiredDuration : Math.min(requiredDuration, realAsset.duration);

  const assets = project.assets.filter((a) => a.id !== placeholderAssetId);
  if (!assets.some((a) => a.id === realAsset.id)) assets.push(realAsset);

  const tracks = project.sequence.tracks.map((track) => ({
    ...track,
    clips: track.clips.map((clip) =>
      clip.assetId === placeholderAssetId ? { ...clip, assetId: realAsset.id, sourceIn: 0, sourceOut } : clip
    ),
  }));

  return { ...project, assets, sequence: { ...project.sequence, tracks } };
}

/** A fresh, app-generated id for a template row — same shape `newId` already gives everything else
 *  in a project, reused here rather than a raw `crypto.randomUUID()` so a template id is
 *  self-describing the same way. */
export function newTemplateId(): string {
  return newId("tpl");
}
