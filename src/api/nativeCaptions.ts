import { registerPlugin } from "@capacitor/core";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { buildAudioOnlyExportPlan } from "../export/buildAudioOnlyExportPlan.ts";
import { trimProjectToRange } from "../export/trimForExport.ts";
import { clipDuration, findAsset, findClip, newId, sequenceDuration } from "../project/createProject.ts";
import type { Project } from "../project/types.ts";
import { ApiRequestError } from "./client.ts";

/** On-device counterpart of `studios/vcut/app/api/vcut/captions/route.ts`'s `POST` — the LOCAL
 *  extraction half of Auto Captions (see that route's own doc comment for the full "two routes" story).
 *  Only this half needs a native branch at all: the REMOTE half (`captions/transcribe`) is already
 *  reached through `centralFetch`/`centralSseUrl` in `client.ts`, which route straight to the live
 *  vcut.io deployment on every platform, mobile included (`captions/transcribe/route.ts` is explicitly
 *  CORS-enabled and doc-commented as "desktop/mobile call this") — so `startCaptions`/`watchCaptions`
 *  only need this file for the part the server route does with real local media files: reading the
 *  ranges' audio via FFmpeg and concatenating them into one small file to upload.
 *
 *  The plugin registration, path-resolution helpers, and asset-path-map pattern below are deliberately
 *  duplicated from `nativeExport.ts` rather than imported from it — see that file's own doc comment on
 *  `collectTextClips`/`textFileKey` for why: keeping each native-pipeline file self-contained avoids a
 *  change to the (already working, real-device-tested) export path ever being forced by a captions-only
 *  need, at the cost of a small, stable, rarely-changing block of duplication. */

interface FfmpegRunOptions {
  jobId: string;
  args: string[];
  duration: number;
}
interface FfmpegEventPayload {
  jobId: string;
  error?: string;
}
interface FfmpegPluginApi {
  run(options: FfmpegRunOptions): Promise<void>;
  addListener(
    eventName: "done" | "failed" | "cancelled",
    listenerFunc: (payload: FfmpegEventPayload) => void
  ): Promise<{ remove: () => Promise<void> }>;
}

const Ffmpeg = registerPlugin<FfmpegPluginApi>("Ffmpeg");

const DIRECTORY = Directory.Data;
const ROOT = "vcut-projects";
const SCRATCH_DIR = "vcut-captions";

function mediaDir(projectId: string): string {
  return `${ROOT}/${projectId}/media`;
}

/** Same distinction `nativeExport.ts`'s own `stripFileScheme` draws — FFmpeg wants a plain filesystem
 *  path, not the `file://`-scheme URI `Filesystem.getUri` returns. */
function stripFileScheme(uri: string): string {
  return uri.startsWith("file://") ? uri.slice("file://".length) : uri;
}

async function nativePathFor(path: string): Promise<string> {
  const { uri } = await Filesystem.getUri({ path, directory: DIRECTORY });
  return stripFileScheme(uri);
}

async function cachePathFor(path: string): Promise<string> {
  const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache });
  return stripFileScheme(uri);
}

async function resolveAssetPaths(projectId: string, project: Project): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  await Promise.all(
    project.assets
      .filter((asset) => asset.relPath)
      .map(async (asset) => {
        map.set(asset.id, await nativePathFor(`${mediaDir(projectId)}/${asset.relPath}`));
      })
  );
  return map;
}

/** Runs one FFmpeg job to completion — unlike export (which streams live progress to a UI), this local
 *  extraction step is fast enough (a few seconds even for a long sequence, same as the server route's
 *  own doc comment says) that callers don't need fractional progress, just "done or not." */
function runFfmpegAndWait(args: string[], duration: number): Promise<void> {
  const jobId = newId("capjob");
  return new Promise((resolve, reject) => {
    let settled = false;
    const handles: Promise<{ remove: () => Promise<void> }>[] = [];

    function stop(): void {
      for (const handle of handles) void handle.then((h) => h.remove()).catch(() => {});
    }
    function settle(fn: () => void): void {
      if (settled) return;
      settled = true;
      stop();
      fn();
    }
    function listen(eventName: "done" | "failed" | "cancelled", onMatch: (payload: FfmpegEventPayload) => void): void {
      handles.push(Ffmpeg.addListener(eventName, (payload) => {
        if (payload.jobId !== jobId) return;
        onMatch(payload);
      }));
    }

    listen("done", () => settle(resolve));
    listen("failed", (payload) => settle(() => reject(new ApiRequestError(payload.error ?? "FFmpeg job failed", 500, "ffmpeg-failed"))));
    listen("cancelled", () => settle(() => reject(new ApiRequestError("FFmpeg job was cancelled", 499, "ffmpeg-cancelled"))));

    Ffmpeg.run({ jobId, args, duration }).catch((err: unknown) => {
      settle(() => reject(err instanceof Error ? err : new Error(String(err))));
    });
  });
}

export interface CaptionRange {
  start: number;
  end: number;
}

/** Mirrors `captions/route.ts`'s own `POST` range-resolution exactly (same tolerance for a deleted or
 *  audio-less clip in a multi-clip selection, same chronological sort, same fallback to the whole
 *  sequence) so the ranges a native caller gets match what the server route would have produced for the
 *  identical selection. */
function resolveRanges(project: Project, clipIds?: string[]): CaptionRange[] {
  if (clipIds && clipIds.length > 0) {
    const ranges = clipIds
      .map((clipId) => {
        const found = findClip(project, clipId);
        if (!found) return null;
        const asset = findAsset(project, found.clip.assetId);
        if (!asset?.hasAudio) return null;
        const start = found.clip.timelineStart;
        const end = start + clipDuration(found.clip);
        return end > start ? { start, end } : null;
      })
      .filter((r): r is CaptionRange => r !== null)
      .sort((a, b) => a.start - b.start);
    if (ranges.length === 0) throw new ApiRequestError("None of the selected clips have audio to transcribe", 400, "no-audio");
    return ranges;
  }
  const total = sequenceDuration(project);
  if (total <= 0) throw new ApiRequestError("There is nothing on the timeline to transcribe", 400, "empty-range");
  return [{ start: 0, end: total }];
}

export interface ExtractedCaptionAudio {
  audioBase64: string;
  ranges: CaptionRange[];
  durations: number[];
}

/** The local half of `startCaptions` on native: extracts each requested range's audio via the on-device
 *  FFmpeg plugin, concatenating multiple ranges into one file exactly like the server route's own
 *  concat-demuxer step, then reads the result back as base64 for the caller to hand to
 *  `centralFetch("/captions/transcribe", …)` unchanged. */
export async function nativeExtractCaptionAudio(projectId: string, project: Project, clipIds?: string[]): Promise<ExtractedCaptionAudio> {
  const ranges = resolveRanges(project, clipIds);
  const assetPaths = await resolveAssetPaths(projectId, project);
  await Filesystem.mkdir({ path: SCRATCH_DIR, directory: Directory.Cache, recursive: true }).catch(() => {});

  const token = newId("cap");
  const partRelPaths: string[] = [];
  const durations: number[] = [];
  let concatRelPath: string | null = null;
  let finalRelPath: string;

  try {
    for (let i = 0; i < ranges.length; i++) {
      const range = ranges[i];
      const trimmed = trimProjectToRange(project, range.start, range.end);
      const partRelPath = `${SCRATCH_DIR}/${token}-part${i}.mp3`;
      partRelPaths.push(partRelPath);
      const partPath = await cachePathFor(partRelPath);
      const plan = buildAudioOnlyExportPlan(trimmed, {
        inputPathFor: (assetId) => {
          const path = assetPaths.get(assetId);
          if (!path) throw new ApiRequestError("A clip references media that is no longer in the project", 400, "missing-asset");
          return path;
        },
        outputPath: partPath,
      });
      durations.push(plan.duration);
      await runFfmpegAndWait(plan.args, plan.duration);
    }

    if (partRelPaths.length > 1) {
      concatRelPath = `${SCRATCH_DIR}/${token}-concat.txt`;
      const partPaths = await Promise.all(partRelPaths.map(cachePathFor));
      const concatListContents = partPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
      await Filesystem.writeFile({ path: concatRelPath, directory: Directory.Cache, data: concatListContents, encoding: Encoding.UTF8 });
      const concatListPath = await cachePathFor(concatRelPath);
      finalRelPath = `${SCRATCH_DIR}/${token}-audio.mp3`;
      const finalPath = await cachePathFor(finalRelPath);
      const totalDuration = durations.reduce((a, b) => a + b, 0);
      await runFfmpegAndWait(["-y", "-f", "concat", "-safe", "0", "-i", concatListPath, "-c", "copy", finalPath], totalDuration);
    } else {
      finalRelPath = partRelPaths[0];
    }

    const { data } = await Filesystem.readFile({ path: finalRelPath, directory: Directory.Cache });
    return { audioBase64: data as string, ranges, durations };
  } finally {
    const cleanup = [...partRelPaths, ...(concatRelPath ? [concatRelPath] : [])];
    await Promise.all(cleanup.map((p) => Filesystem.deleteFile({ path: p, directory: Directory.Cache }).catch(() => {})));
    if (partRelPaths.length > 1) {
      await Filesystem.deleteFile({ path: `${SCRATCH_DIR}/${token}-audio.mp3`, directory: Directory.Cache }).catch(() => {});
    }
  }
}
