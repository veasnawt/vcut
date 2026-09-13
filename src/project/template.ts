import { clipDuration, createColorAsset, createProject, createTextAsset, createTrack, newId } from "./createProject.ts";
import type { Asset, Clip, Project, Track } from "./types.ts";

/** What a saved template actually stores — deliberately NOT a full `Project`, but (unlike this
 *  feature's own first version) not a structure-only skeleton either. A template exists to let someone
 *  ELSE reuse an entire edited look — every clip's timing, trim points, transform/effects/color-
 *  grading/keyframes, and transitions — with their OWN photos/videos standing in for whatever
 *  video/image footage the original edit used, while any music/voiceover just carries over unchanged
 *  (asked for directly — a template's song is part of its own identity, the same way CapCut's own
 *  templates keep theirs). `tracks`/`assets` here are the SANITIZED output `sanitizeProjectForTemplate`
 *  below produces: every clip survives as-is, but a VIDEO/IMAGE clip's asset points at a PLACEHOLDER
 *  (`Asset.templatePlaceholder` set, no real file — the original was never something safe to hand to a
 *  stranger's project) while an AUDIO clip's asset keeps a real, playable file, just bundled with the
 *  TEMPLATE itself rather than referencing the project that happened to save it (`Asset.
 *  templateBundledAudio` — see its own doc comment for why audio is handled so differently from video/
 *  image here). The actual audio-file copying (into `_lib/paths.ts`'s own `templateAudioPaths`, and
 *  later out of it into each new project) is server-side I/O this pure function can't do itself —
 *  `templates/route.ts`'s own POST handler is what actually performs it, right after calling this. */
export interface TemplateProjectData {
  width: number;
  height: number;
  fps: number;
  tracks: Track[];
  assets: Asset[];
}

/** One open slot a "fill in your media" step needs to ask about — see `templateSlots` below. Audio is
 *  deliberately never a slot at all (see `Asset.templateBundledAudio`'s own doc comment) — only visual
 *  content is meant to be replaced. */
export interface TemplateSlot {
  /** The placeholder `Asset.id` this slot fills — what `fillTemplateSlot` needs to find and replace. */
  assetId: string;
  slotIndex: number;
  /** What the ORIGINAL clip was — a real pick can still be either kind (see `fillTemplateSlot`'s own
   *  doc comment), this is just what the template author actually used, shown so a slot reads as
   *  "Video · 4.2s" rather than a bare number. */
  kind: "video" | "image";
  requiredDuration: number;
}

/** Strips a real project down to the shape a template actually stores. Every clip is kept, ids and
 *  all — a template is a self-contained snapshot that hasn't been instantiated into a real project
 *  yet, so nothing needs fresh ids until `buildProjectFromTemplate` actually mints one (matching
 *  `createProject.ts`'s own "always mint fresh ids at construction time" convention rather than
 *  pre-emptively renaming ids in a document nothing else references yet). A text or color-matte asset
 *  carries over verbatim (see `createTextAsset`/`createColorAsset`'s own doc comments — neither has a
 *  backing file at all, so there's nothing to strip). A VIDEO/IMAGE asset is replaced with a
 *  placeholder: same `kind`/`name`/dimensions/`hasAudio` (what the "fill in your media" step needs to
 *  describe the slot and validate a pick against), no real file (`relPath: ""`, `sizeBytes: 0` — the
 *  same "no backing file" convention a text asset's own empty `relPath` already uses), and a fresh
 *  `templatePlaceholder` marker. `slotIndex` is assigned across the WHOLE timeline in chronological
 *  order (by `clip.timelineStart`, tracks considered together) — not per-track — since that's the
 *  order a person filling in slots would actually expect ("the first thing that happens," not "every
 *  video-track clip, then every other track's own").
 *
 *  One slot per ORIGINAL asset, not per clip — asked for directly: a DUPLICATED clip (the same source
 *  footage placed more than once, however differently each copy has since been styled/effects/trimmed
 *  — a common way to build a before/after or split-screen look) shares ONE slot, rather than asking the
 *  user to pick the same footage over again for every copy. `requiredDuration` on a shared slot is the
 *  LONGEST of every clip using it (so a pick long enough for every one of them gets asked for up front)
 *  — `fillTemplateSlot` still gives each individual clip its OWN correctly-sized trim off of whatever
 *  actually gets picked, using that clip's own current duration rather than this shared, display-only
 *  number, so two copies needing different lengths of the new footage both still come out right.
 *
 *  An AUDIO asset is never turned into a slot at all — it carries over marked `templateBundledAudio:
 *  true`, its real `relPath` left UNCHANGED (still relative to the SOURCE project's own `mediaDir` at
 *  this point) specifically so `templates/route.ts`'s own POST handler, which calls this function,
 *  knows exactly which file to actually copy into the template's own storage next — this function
 *  itself never touches the filesystem. */
export function sanitizeProjectForTemplate(project: Project): TemplateProjectData {
  const mediaClipOrder = project.sequence.tracks
    .flatMap((track) => track.clips.map((clip) => ({ track, clip })))
    .filter(({ clip }) => {
      const asset = project.assets.find((a) => a.id === clip.assetId);
      return Boolean(asset) && (asset!.kind === "video" || asset!.kind === "image");
    })
    .sort((a, b) => a.clip.timelineStart - b.clip.timelineStart);

  // Keyed by the ORIGINAL asset's own id — see this function's own doc comment on why duplicated clips
  // share one slot instead of getting their own. `slotIndex` is fixed at each id's FIRST occurrence
  // (insertion order into this Map, which follows `mediaClipOrder`'s own chronological sort);
  // `requiredDuration` grows to the longest clip seen so far for that same asset on every later one.
  const placeholderByOriginalAssetId = new Map<string, Asset>();
  for (const { clip } of mediaClipOrder) {
    const original = project.assets.find((a) => a.id === clip.assetId)!;
    const existing = placeholderByOriginalAssetId.get(original.id);
    if (existing) {
      existing.templatePlaceholder!.requiredDuration = Math.max(existing.templatePlaceholder!.requiredDuration, clipDuration(clip));
      continue;
    }
    placeholderByOriginalAssetId.set(original.id, {
      id: newId("tplasset"),
      kind: original.kind as "video" | "image",
      name: original.name,
      relPath: "",
      duration: clipDuration(clip),
      ...(original.width != null ? { width: original.width } : null),
      ...(original.height != null ? { height: original.height } : null),
      ...(original.fps != null ? { fps: original.fps } : null),
      hasAudio: original.hasAudio,
      sizeBytes: 0,
      importedAt: 0,
      templatePlaceholder: { slotIndex: placeholderByOriginalAssetId.size, requiredDuration: clipDuration(clip) },
    });
  }

  // Covers text/color (carried over verbatim) AND audio (carried over as a real, still-to-be-bundled
  // file — see this function's own doc comment) — everything that ISN'T becoming a placeholder slot.
  const keptAssetIds = new Set<string>();
  const tracks: Track[] = project.sequence.tracks.map((track) => ({
    ...track,
    clips: track.clips.map((clip): Clip => {
      const asset = project.assets.find((a) => a.id === clip.assetId);
      const placeholder = asset && placeholderByOriginalAssetId.get(asset.id);
      if (placeholder) return { ...clip, assetId: placeholder.id };
      keptAssetIds.add(clip.assetId);
      return { ...clip };
    }),
  }));

  const assets: Asset[] = [
    ...project.assets
      .filter((a) => keptAssetIds.has(a.id))
      .map((a) => (a.kind === "audio" ? { ...a, templateBundledAudio: true as const } : a)),
    ...placeholderByOriginalAssetId.values(),
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
 *  A resulting project's own placeholder (video/image) assets are NOT yet fillable content — every one
 *  of them still has `templatePlaceholder` set, exactly like the template's own stored version, just
 *  with a fresh `id` (`assetIdMap` is what lets each clip find its own new placeholder). `templateSlots`
 *  below is what a "fill in your media" UI calls next to find out what to ask for.
 *
 *  An AUDIO asset (`templateBundledAudio` set) comes out of THIS function still pointing at the
 *  TEMPLATE's own bundled-audio storage, not the new project's — same "pure function, no filesystem
 *  access" limit `sanitizeProjectForTemplate`'s own doc comment explains. `project/route.ts`'s own POST
 *  handler, which calls this function, is what actually copies the real file into the new project's own
 *  `mediaDir` right afterward and rewrites this entry to a completely normal, real asset before ever
 *  persisting or returning the project — by the time anything else sees it, `templateBundledAudio` is
 *  already gone. */
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
    // video/image (still a placeholder) or audio (still bundled-but-not-yet-copied) — either way, a
    // freshly-minted id like every other asset here; `project/route.ts`'s own POST handler resolves
    // the audio case into a real asset right after this returns (see this function's own doc comment).
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
  // Permanent, never cleared even once every slot is filled — see `Project.templateOrigin`'s own doc
  // comment for why the normal timeline editor stays off-limits for this project forever, not just
  // until its slots are filled.
  project.templateOrigin = true;
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
      kind: a.kind as "video" | "image",
      requiredDuration: a.templatePlaceholder.requiredDuration,
    }))
    .sort((a, b) => a.slotIndex - b.slotIndex);
}

/** Binds a real, already-imported/generated/downloaded `Asset` into one template slot — EVERY clip
 *  that referenced `currentAssetId` is repointed at `realAsset.id` instead (see
 *  `sanitizeProjectForTemplate`'s own doc comment: more than one clip shares a slot when the original
 *  was a duplicated clip), each with its own trim window reset to start from the real media's own
 *  beginning.
 *
 *  Works whether `currentAssetId` is still an open PLACEHOLDER or already a REAL asset from an earlier
 *  pick — a real, reported gap otherwise: `TemplateFillScreen.tsx`'s own slot chips let you click an
 *  already-filled one and pick something else, but this function used to silently refuse to do
 *  anything unless the target still had `templatePlaceholder` set, so a change-of-mind pick looked
 *  like it worked (the grid closed, nothing else complained) while actually doing nothing at all. There
 *  simply needs to be at least one clip CURRENTLY pointing at `currentAssetId` — this function doesn't
 *  care why.
 *
 *  Each clip's OWN required length comes from ITS OWN current `sourceOut - sourceIn` — not a
 *  placeholder's single, shared `requiredDuration` (which only ever reflected the LONGEST clip in the
 *  group, for display purposes) — so two duplicated clips that originally used different lengths of
 *  the same source footage both still come out correctly sized from whatever gets picked, rather than
 *  both being forced to the same, longer length; the same logic naturally also re-derives the right
 *  length on a SECOND pick, since it always reads the clip's OWN current trim, not anything from the
 *  first pick.
 *
 *  A picked IMAGE always fully satisfies a clip's own required length — a still frame has no real
 *  length of its own to run short on, unlike video/audio, which uses only as much of the real file as
 *  it actually has (`Math.min`): asked for directly — auto-trimming from the start is the simplest,
 *  most predictable behavior, and a source shorter than required is used in full (the clip's own
 *  timeline length shrinks to match) rather than looped or held on its last frame, the same "never
 *  synthesize frames that were never really there" reasoning every other trim operation in this app
 *  already follows. The caller (a "fill in your media" UI) is what decides whether to warn about a
 *  short pick before calling this — this function just does the bind unconditionally.
 *
 *  `realAsset` is added to `project.assets` if it isn't already there (the common case — a fresh
 *  import/generation/stock download made specifically to fill this slot); already-present is handled
 *  too (picking something already in the project's own library elsewhere) without duplicating it. The
 *  asset previously at `currentAssetId` is dropped from `project.assets` if nothing else references it
 *  — for a library-backed one, this only ever unlinks it from THIS project; the real file stays exactly
 *  where it was, same as removing any other library-backed asset. */
export function fillTemplateSlot(project: Project, currentAssetId: string, realAsset: Asset): Project {
  const hasMatchingClip = project.sequence.tracks.some((t) => t.clips.some((c) => c.assetId === currentAssetId));
  if (!hasMatchingClip) return project;

  const assets = project.assets.filter((a) => a.id !== currentAssetId);
  if (!assets.some((a) => a.id === realAsset.id)) assets.push(realAsset);

  const tracks = project.sequence.tracks.map((track) => ({
    ...track,
    clips: track.clips.map((clip) => {
      if (clip.assetId !== currentAssetId) return clip;
      const neededDuration = clip.sourceOut - clip.sourceIn;
      const sourceOut = realAsset.kind === "image" ? neededDuration : Math.min(neededDuration, realAsset.duration);
      return { ...clip, assetId: realAsset.id, sourceIn: 0, sourceOut };
    }),
  }));

  return { ...project, assets, sequence: { ...project.sequence, tracks } };
}

/** Every distinct real audio asset currently playing in a template-origin project — what
 *  `TemplatePreviewScreen.tsx` shows a "Replace" row for, one row per clip GROUP the same way
 *  `sanitizeProjectForTemplate` grouped duplicated video/image clips into one slot: a duplicated audio
 *  clip (the same bundled track placed more than once) surfaces as one row, not two, since replacing
 *  "the music" should replace every copy of it at once. Ordered by each group's first clip's own
 *  `timelineStart`, matching `templateSlots`'s own chronological convention.
 *
 *  Unlike `templateSlots`, there's no separate "still open" state to track here — audio never becomes a
 *  placeholder (see `Asset.templateBundledAudio`'s own doc comment), so this is read LIVE off whatever
 *  `project.assets`/clips currently are, and a replacement is visible on the very next call rather than
 *  needing anything like `TemplateFillScreen.tsx`'s own `filledBySlotId` to track across picks.
 *  `fillTemplateSlot` (its own doc comment covers why) needs no dedicated audio-replace function of its
 *  own — passing one of these rows' own `id` as `currentAssetId` already does the right thing. */
export function templateAudioAssets(project: Project): Asset[] {
  const seen = new Set<string>();
  const rows: Asset[] = [];
  project.sequence.tracks
    .flatMap((track) => track.clips.map((clip) => ({ track, clip })))
    .filter(({ track }) => track.kind === "audio")
    .sort((a, b) => a.clip.timelineStart - b.clip.timelineStart)
    .forEach(({ clip }) => {
      if (seen.has(clip.assetId)) return;
      seen.add(clip.assetId);
      const asset = project.assets.find((a) => a.id === clip.assetId);
      if (asset) rows.push(asset);
    });
  return rows;
}

/** A fresh, app-generated id for a template row — same shape `newId` already gives everything else
 *  in a project, reused here rather than a raw `crypto.randomUUID()` so a template id is
 *  self-describing the same way. */
export function newTemplateId(): string {
  return newId("tpl");
}
