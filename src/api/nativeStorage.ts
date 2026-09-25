import { Capacitor } from "@capacitor/core";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { getAccessToken } from "@veasnawt/auth";
import { kindForExtension } from "../import/mediaFormats.ts";
import { createProject, newId } from "../project/createProject.ts";
import { deserializeProject, serializeProject } from "../project/serialize.ts";
import type { TemplateProjectData } from "../project/template.ts";
import type { Asset, AssetKind, Project } from "../project/types.ts";
import { SHORT_PRESET } from "../project/types.ts";
import { writeBlobInChunks } from "./chunkedWrite.ts";
import { ApiRequestError } from "./client.ts";

/** On-device counterpart of `studios/vcut/app/api/vcut/**`'s filesystem routes, for the native
 *  (Capacitor) shell where there is no server at all — see the "native iOS/Android apps" plan. Mirrors
 *  the server's `.vcut/<projectId>/{project.json,media/}` layout one-for-one, just rooted under
 *  Capacitor's app-private `Directory.Data` instead of `VCUT_ROOT`.
 *
 *  What this deliberately does NOT do yet: generate thumbnails/filmstrips/waveforms, or export — both
 *  need real FFmpeg, which only exists here once the native `ffmpeg-kit` plugin (plan Step 5) lands.
 *  A native-imported asset simply has no `thumbnailRelPath`/etc., which every existing caller already
 *  treats as "no preview available" rather than an error (see `client.ts`'s `thumbnailUrl` and
 *  friends) — so import/edit/preview work now, export waits on the plugin. */

const DIRECTORY = Directory.Data;
const ROOT = "vcut-projects";

function projectDir(projectId: string): string {
  return `${ROOT}/${projectId}`;
}
function mediaDir(projectId: string): string {
  return `${projectDir(projectId)}/media`;
}
function projectFile(projectId: string): string {
  return `${projectDir(projectId)}/project.json`;
}

// `mediaUrl` (below) has to be SYNCHRONOUS — every existing caller (`<video src>`, `<img src>`, …)
// calls it directly in render, and changing that shape would ripple through every UI component. But
// resolving a `Directory.Data`-relative path to a real native URI is only available async
// (`Filesystem.getUri`). Splitting the difference: the native media directory's URI is resolved ONCE
// per project (primed by `loadProject`, which every screen already awaits before rendering anything
// that could call `mediaUrl`), then reused synchronously from this cache for the rest of the session.
const mediaBaseUriCache = new Map<string, string>();

async function primeMediaBaseUri(projectId: string): Promise<void> {
  await Filesystem.mkdir({ path: mediaDir(projectId), directory: DIRECTORY, recursive: true }).catch(() => {
    /* already exists */
  });
  const { uri } = await Filesystem.getUri({ path: mediaDir(projectId), directory: DIRECTORY });
  mediaBaseUriCache.set(projectId, uri);
}

export function nativeMediaUrl(projectId: string, relPath: string): string {
  const base = mediaBaseUriCache.get(projectId);
  // Only reachable if something calls this before `loadProject` has resolved, which shouldn't happen
  // in practice — every screen loads the project first. An empty src is a harmless no-op image/video
  // rather than a thrown error mid-render.
  if (!base) return "";
  return Capacitor.convertFileSrc(`${base}/${relPath}`);
}

/** `project.json`'s crash-safety sibling: a save writes here first, then swaps it into place. */
function projectTempFile(projectId: string): string {
  return `${projectFile(projectId)}.tmp`;
}

async function readTextFile(path: string): Promise<string | null> {
  try {
    const { data } = await Filesystem.readFile({ path, directory: DIRECTORY, encoding: Encoding.UTF8 });
    return typeof data === "string" ? data : await data.text();
  } catch {
    return null;
  }
}

function tryParseProject(text: string | null): Project | null {
  if (text === null) return null;
  try {
    return deserializeProject(text);
  } catch {
    return null;
  }
}

/** Of the main project file and a leftover temp copy from an interrupted save, the one to open: the temp
 *  copy only wins when it parses and was updated strictly later — otherwise the main file stands. */
export function pickNewerProject(main: Project, temp: Project | null): Project {
  return temp && temp.updatedAt > main.updatedAt ? temp : main;
}

export async function nativeLoadProject(projectId: string, projectName?: string): Promise<Project> {
  await primeMediaBaseUri(projectId);
  const mainText = await readTextFile(projectFile(projectId));
  const main = tryParseProject(mainText);
  const tempText = await readTextFile(projectTempFile(projectId));
  const temp = tryParseProject(tempText);
  // Normally the temp file is gone (a save moved it into place). One that's still there and parses is a
  // complete copy left by an interrupted save — use whichever of the two is newer.
  if (main) return pickNewerProject(main, temp);

  // The main file is missing or unreadable. A save that was interrupted between removing the old file and
  // moving the new one into place leaves the complete, newer copy in the `.tmp` sibling — recover from it
  // (and put it back) before concluding anything is lost.
  const recovered = temp;
  if (recovered) {
    await Filesystem.writeFile({ path: projectFile(projectId), directory: DIRECTORY, data: serializeProject(recovered), encoding: Encoding.UTF8 }).catch(() => {});
    return recovered;
  }

  // A file that EXISTS but won't parse is damage, not "a new project": the old code fell through to creating a
  // blank project and writing it over the top, destroying whatever was salvageable. Surface it instead.
  if (mainText !== null && mainText.trim() !== "") {
    throw new Error("This project's file is damaged and could not be opened");
  }

  const name = projectName?.trim() ? projectName.trim().slice(0, 120) : undefined;
  const project = createProject(projectId, name);
  await Filesystem.mkdir({ path: projectDir(projectId), directory: DIRECTORY, recursive: true }).catch(() => {});
  await Filesystem.writeFile({ path: projectFile(projectId), directory: DIRECTORY, data: serializeProject(project), encoding: Encoding.UTF8 });
  return project;
}

/** Saves without ever leaving a truncated `project.json`: the new content is written IN FULL to a sibling
 *  first and only then moved over the real file, so a kill or crash mid-write leaves either the old complete
 *  file or the new complete one (`nativeLoadProject` recovers from the sibling in the one gap between). The
 *  old direct overwrite could be cut off partway, leaving JSON that no longer parsed. */
export async function nativeSaveProject(projectId: string, project: Project): Promise<void> {
  const main = projectFile(projectId);
  const tmp = projectTempFile(projectId);
  await Filesystem.writeFile({ path: tmp, directory: DIRECTORY, data: serializeProject(project), encoding: Encoding.UTF8 });
  try {
    await Filesystem.rename({ from: tmp, to: main, directory: DIRECTORY });
  } catch {
    // Some platforms won't rename onto an existing file: remove the old one, then move.
    await Filesystem.deleteFile({ path: main, directory: DIRECTORY }).catch(() => {});
    await Filesystem.rename({ from: tmp, to: main, directory: DIRECTORY });
  }
}

// `Blob`, not `File` — every current caller passes a real `File`, but `File` is-a `Blob`, and
// `nativeCreateProjectFromTemplate` (below) needs this same base64 conversion for a downloaded
// `fetch().blob()` response body, which is never a `File`.
function readFileAsBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // "data:<mime>;base64,<payload>" — Filesystem.writeFile wants just the payload when no
      // `encoding` is passed (its default is raw base64 bytes).
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

/** Writes `blob` to `path` under `DIRECTORY` in slices (`chunkedWrite.ts`) so a large import never holds the
 *  whole file — or its 1.33x base64 form — in memory at once. Removes the partial file if anything fails. */
async function writeMediaFile(path: string, blob: Blob, onProgress?: (fraction: number) => void): Promise<void> {
  await writeBlobInChunks(
    blob,
    {
      encode: readFileAsBase64,
      write: (data) => Filesystem.writeFile({ path, directory: DIRECTORY, data }).then(() => undefined),
      append: (data) => Filesystem.appendFile({ path, directory: DIRECTORY, data }),
      discard: () => Filesystem.deleteFile({ path, directory: DIRECTORY }),
    },
    { onProgress }
  );
}

/** Reads duration/dimensions/audio-presence straight from the WebView's own media decoder — the
 *  on-device equivalent of the server's `ffprobe` call, needing no native plugin at all. Not as
 *  exhaustive as ffprobe (no `fps`), but everything `Asset` actually requires is here. */
function probeViaMediaElement(kind: AssetKind, objectUrl: string): Promise<{ duration: number; width?: number; height?: number; hasAudio: boolean; noVideoStream: boolean }> {
  return new Promise((resolve, reject) => {
    if (kind === "image") {
      const img = new Image();
      img.onload = () => resolve({ duration: 0, width: img.naturalWidth, height: img.naturalHeight, hasAudio: false, noVideoStream: false });
      img.onerror = () => reject(new Error("That file couldn't be read as an image"));
      img.src = objectUrl;
      return;
    }
    const el = document.createElement(kind === "video" ? "video" : "audio");
    el.preload = "metadata";
    el.onloadedmetadata = () => {
      const video = el as HTMLVideoElement;
      const width = kind === "video" ? video.videoWidth : undefined;
      const height = kind === "video" ? video.videoHeight : undefined;
      // A "video"-extension file (e.g. a MediaRecorder .webm voiceover) with no actual video stream
      // decodes with videoWidth/Height === 0 — the same reclassification signal the server's ffprobe
      // path uses, just read off the decoder directly instead of a probe tool.
      const noVideoStream = kind === "video" && width === 0 && height === 0;
      // In-band AudioTrackList isn't universally populated on every WebView build; default to "has
      // audio" when it can't be determined, since a wrongly-present silent track is harmless while a
      // wrongly-absent one would hide real audio behind the mute-toggle UI.
      const audioTracks = (el as unknown as { audioTracks?: { length: number } }).audioTracks;
      const hasAudio = kind === "audio" || noVideoStream || audioTracks === undefined || audioTracks.length > 0;
      const finish = (duration: number) => resolve({ duration, width, height, hasAudio, noVideoStream });

      if (Number.isFinite(el.duration)) {
        finish(el.duration);
        return;
      }
      // A MediaRecorder-captured file (any `VoiceoverRecorder` take) has no Duration written into its
      // container at all — see the server-side `remuxForDuration`'s own comment for the full mechanism
      // — which WebKit/Blink surface here as `duration === Infinity`, not a normal number. There's no
      // FFmpeg on this code path to remux with (see this module's own doc comment on why), but seeking
      // to a huge out-of-range time forces the decoder to scan for the real end of the stream and fire
      // `durationchange` with the actual value — the standard browser-side workaround for this exact
      // MediaRecorder quirk. Falls back to the old `0` (import rejected) if that scan somehow never
      // resolves, so a genuinely broken file still fails the same way it always did rather than hanging.
      const fallback = setTimeout(() => finish(0), 4000);
      el.ondurationchange = () => {
        if (!Number.isFinite(el.duration)) return;
        clearTimeout(fallback);
        el.ondurationchange = null;
        el.currentTime = 0;
        finish(el.duration);
      };
      el.currentTime = 1e101;
    };
    el.onerror = () => reject(new Error("That file couldn't be read as media"));
    el.src = objectUrl;
  });
}

export async function nativeImportMedia(projectId: string, file: File): Promise<Asset> {
  const ext = `.${file.name.split(".").pop()?.toLowerCase() ?? ""}`;
  const kind = kindForExtension(ext);
  if (!kind) {
    throw new ApiRequestError(`VCut can't import "${ext || file.name}" on this device.`, 400, "unsupported-format");
  }

  const objectUrl = URL.createObjectURL(file);
  let probe;
  try {
    probe = await probeViaMediaElement(kind, objectUrl);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
  if (kind !== "image" && probe.duration <= 0) {
    throw new ApiRequestError("That file contains no playable audio or video", 400, "empty-media");
  }
  const resolvedKind: AssetKind = probe.noVideoStream ? "audio" : kind;

  const safeName = file.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "media";
  const dotIndex = safeName.lastIndexOf(".");
  const stem = dotIndex > 0 ? safeName.slice(0, dotIndex) : safeName;
  const suffix = dotIndex > 0 ? safeName.slice(dotIndex) : "";
  const relPath = `${stem}-${newId("m")}${suffix}`;

  await writeMediaFile(`${mediaDir(projectId)}/${relPath}`, file);

  return {
    id: newId("a"),
    kind: resolvedKind,
    name: file.name,
    relPath,
    duration: probe.duration,
    hasAudio: probe.hasAudio,
    sizeBytes: file.size,
    importedAt: Date.now(),
    ...(probe.width ? { width: probe.width } : null),
    ...(probe.height ? { height: probe.height } : null),
  };
}

export async function nativeDeleteMedia(projectId: string, asset: Asset): Promise<void> {
  if (!asset.relPath) return;
  await Filesystem.deleteFile({ path: `${mediaDir(projectId)}/${asset.relPath}`, directory: DIRECTORY }).catch(() => {
    /* already gone */
  });
}

/** On-device counterpart of `studios/vcut/app/api/vcut/projects/route.ts`'s `ProjectSummary` — what
 *  the Home/Projects tabs list. `coverAsset` stands in for that route's server-resolved `thumbnail`:
 *  native never generates `Asset.thumbnailRelPath` (no FFmpeg — see this file's own top doc comment),
 *  so there's no separate rendered thumbnail file to point at. Instead this names the representative
 *  asset itself (kind + its OWN `relPath`) and lets the caller render it live — a video via
 *  `VideoFrameThumbnail` (already built for exactly this: painting a real frame from a plain `<video>`
 *  element, no server round trip), a still image via a plain `<img>` — both resolved through
 *  `nativeMediaUrl`, same as any other asset. */
export interface LocalProjectSummary {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  clipCount: number;
  width: number;
  height: number;
  coverAsset?: { kind: "video" | "image"; relPath: string };
}

/** Same selection rule `projects/route.ts`'s own `summarize` uses (prefer a video, fall back to a
 *  still image, skip a template placeholder's empty `relPath`) — adapted for native's own "no
 *  server-rendered thumbnail" reality: keys off the asset's real `relPath` directly rather than a
 *  `thumbnailRelPath` that native imports never populate. */
function summarizeLocal(project: Project): LocalProjectSummary {
  const coverAsset =
    project.assets.find((a) => a.kind === "video" && a.relPath && !a.templatePlaceholder) ??
    project.assets.find((a) => a.kind === "image" && a.relPath && !a.templatePlaceholder);
  return {
    id: project.bpProjectId,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    clipCount: project.sequence.tracks.reduce((n, t) => n + t.clips.length, 0),
    width: project.sequence.width,
    height: project.sequence.height,
    ...(coverAsset ? { coverAsset: { kind: coverAsset.kind as "video" | "image", relPath: coverAsset.relPath } } : null),
  };
}

/** Every project on this device — a plain directory listing, same reasoning `projects/route.ts`'s own
 *  local branch already gives for why that's fine at the scale a single device's project count ever
 *  reaches: the project folders themselves are the source of truth, no separate index to drift out of
 *  sync. A folder whose `project.json` fails to parse (corrupted, or caught mid-write) is skipped
 *  rather than failing the whole list, same as the server's own handling. */
export async function nativeListProjects(): Promise<LocalProjectSummary[]> {
  const summaries: LocalProjectSummary[] = [];
  let entries;
  try {
    ({ files: entries } = await Filesystem.readdir({ path: ROOT, directory: DIRECTORY }));
  } catch {
    return summaries; // ROOT doesn't exist yet — no projects created on this device yet.
  }
  for (const entry of entries) {
    if (entry.type !== "directory") continue;
    try {
      const { data } = await Filesystem.readFile({ path: projectFile(entry.name), directory: DIRECTORY, encoding: Encoding.UTF8 });
      summaries.push(summarizeLocal(deserializeProject(typeof data === "string" ? data : await data.text())));
    } catch {
      // Skip — see this function's own doc comment.
    }
  }
  summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  return summaries;
}

export async function nativeCreateProject(
  name: string,
  preset: { width: number; height: number; fps: number } = SHORT_PRESET
): Promise<Project> {
  const bpProjectId = newId("proj");
  const project = createProject(bpProjectId, name, preset);
  await Filesystem.mkdir({ path: projectDir(bpProjectId), directory: DIRECTORY, recursive: true }).catch(() => {});
  await Filesystem.writeFile({ path: projectFile(bpProjectId), directory: DIRECTORY, data: serializeProject(project), encoding: Encoding.UTF8 });
  return project;
}

export async function nativeDeleteProject(projectId: string): Promise<void> {
  await Filesystem.rmdir({ path: projectDir(projectId), directory: DIRECTORY, recursive: true }).catch(() => {
    /* already gone */
  });
  mediaBaseUriCache.delete(projectId);
}

const TEMPLATES_ORIGIN = "https://vcut.io";

async function centralAuthHeaders(): Promise<HeadersInit> {
  const token = await getAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Native's own counterpart of `client.ts`'s `loadTemplateForDraft` — templates only ever live on the
 *  live vcut.io deployment (see `studios/vcut/app/api/vcut/_lib/localOnly.ts`'s own doc comment), so
 *  this is a plain central fetch, not a local read; there is no on-device copy of a template to open. */
export async function nativeLoadTemplateForDraft(templateId: string): Promise<{ name: string; project: TemplateProjectData }> {
  const response = await fetch(`${TEMPLATES_ORIGIN}/api/vcut/templates/${encodeURIComponent(templateId)}/project`, {
    headers: await centralAuthHeaders(),
  });
  if (!response.ok) throw new ApiRequestError("Couldn't open that template", response.status);
  return (await response.json()) as { name: string; project: TemplateProjectData };
}

/** Native's own counterpart of `client.ts`'s `createProjectFromTemplate` — the hosted server's own
 *  version (`project/route.ts`'s POST) builds the project via `buildProjectFromTemplate` and then
 *  copies each bundled-audio asset's real file server-side (`resolveTemplateBundledAudio`, filesystem
 *  to filesystem). Takes the ALREADY-BUILT draft `Project` (`editorStore.ts`'s `loadTemplateDraft`
 *  already ran `buildProjectFromTemplate` once, in memory, to show the fill/preview screens) rather than
 *  re-fetching the template and rebuilding it a second time — just needs a real `bpProjectId` in place
 *  of the draft's placeholder one, and its bundled-audio assets resolved into real local files (a
 *  download from the one new route built for exactly this, `templates/[id]/audio/[file]/route.ts`, into
 *  this brand-new project's own `mediaDir`, in place of the server's filesystem-to-filesystem copy).
 *
 *  A kept STICKER (`asset.animation` set alongside `templateBundledAudio` — see `resolveTemplateBundled
 *  Audio`'s own doc comment on why that's a separate branch server-side) is left unresolved here rather
 *  than mirrored — a narrower, deliberate scope cut: real, but rare (an author has to have explicitly
 *  chosen to keep a sticker fixed rather than let it become a slot), and mirroring
 *  `copyTemplateStickerToLibrary`'s own account-wide-library semantics has no local equivalent worth
 *  building for this one case yet. Its clip still plays back FROM the template's own now-inaccessible
 *  bundled storage (same silent-placeholder tolerance `nativeStorage.ts`'s own top doc comment already
 *  documents for a native import with no generated thumbnail) rather than crashing the whole flow. */
export async function nativeCreateProjectFromTemplate(templateId: string, draftProject: Project): Promise<{ projectId: string; name: string }> {
  const bpProjectId = newId("proj");
  const project: Project = { ...draftProject, bpProjectId };

  await Filesystem.mkdir({ path: mediaDir(bpProjectId), directory: DIRECTORY, recursive: true }).catch(() => {});
  const headers = await centralAuthHeaders();
  project.assets = await Promise.all(
    project.assets.map(async (asset): Promise<Asset> => {
      if (!asset.templateBundledAudio || asset.animation || !asset.relPath) return asset;
      try {
        const response = await fetch(
          `${TEMPLATES_ORIGIN}/api/vcut/templates/${encodeURIComponent(templateId)}/audio/${encodeURIComponent(asset.relPath)}`,
          { headers }
        );
        if (!response.ok) return asset; // best-effort — see this function's own doc comment
        const blob = await response.blob();
        await writeMediaFile(`${mediaDir(bpProjectId)}/${asset.relPath}`, blob);
        const { templateBundledAudio: _templateBundledAudio, ...resolved } = asset;
        return resolved;
      } catch {
        return asset;
      }
    })
  );

  await Filesystem.mkdir({ path: projectDir(bpProjectId), directory: DIRECTORY, recursive: true }).catch(() => {});
  await Filesystem.writeFile({ path: projectFile(bpProjectId), directory: DIRECTORY, data: serializeProject(project), encoding: Encoding.UTF8 });
  return { projectId: bpProjectId, name: project.name };
}

/** Total bytes under `vcut-projects/` — what the "Me" tab's storage row shows, in place of the hosted
 *  account's own server-computed `/api/vcut/media/library` usage figure (there's no account-wide
 *  library here, just this device's project files). `Filesystem.readdir`'s own `FileInfo` already
 *  carries each entry's `size`, so no separate `Filesystem.stat` call per file is needed — just walk
 *  every directory level and sum. */
export async function nativeStorageUsage(): Promise<number> {
  async function walk(path: string): Promise<number> {
    let entries;
    try {
      ({ files: entries } = await Filesystem.readdir({ path, directory: DIRECTORY }));
    } catch {
      return 0;
    }
    let total = 0;
    for (const entry of entries) {
      if (entry.type === "directory") total += await walk(`${path}/${entry.name}`);
      else total += entry.size ?? 0;
    }
    return total;
  }
  return walk(ROOT);
}
