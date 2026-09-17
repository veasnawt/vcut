"use client";

import { Capacitor } from "@capacitor/core";
import { Share } from "@capacitor/share";
import { Check, Close } from "@veasnawt/vicons";
import { useEffect, useId, useRef, useState } from "react";
import {
  ApiRequestError,
  cancelExport,
  exportAvailable,
  exportUrl,
  findRunningExport,
  startExport,
  watchExport,
} from "../api/client.ts";
import { nativeExportUrl, nativeSaveExportToGallery } from "../api/nativeExport.ts";
import { OUTRO_DURATION_SECONDS } from "../export/outro.ts";
import { trimProjectToRange } from "../export/trimForExport.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import { sequenceDuration } from "../project/createProject.ts";
import { FPS_PRESETS, RESOLUTION_PRESETS } from "../project/types.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { formatDuration, formatTimecode } from "../timeline/time.ts";
import { Dropdown } from "./Dropdown.tsx";
import { useHostedCreditsGate } from "./useHostedCreditsGate.ts";

type Phase = "idle" | "running" | "done" | "failed" | "cancelled";

/** Gap between the preview's own edge and the progress stroke that travels around it, and that
 *  stroke's width — the stroke sits OUTSIDE the video, never over its pixels. */
const RING_GAP = 7;
const RING_STROKE = 3.5;
const PREVIEW_RADIUS = 14;

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslation();
  const project = useEditorStore((s) => s.project);
  const projectId = useEditorStore((s) => s.projectId);
  const save = useEditorStore((s) => s.save);
  const exportRangeStart = useEditorStore((s) => s.exportRangeStart);
  const exportRangeEnd = useEditorStore((s) => s.exportRangeEnd);
  const clearExportRange = useEditorStore((s) => s.clearExportRange);

  const hasRange = exportRangeStart !== null || exportRangeEnd !== null;
  // Read through the store's own clamped/sorted resolver (re-evaluated on every render — the
  // `exportRangeStart`/`exportRangeEnd`/`project` subscriptions above are what trigger those).
  const { start: rangeStart, end: rangeEnd } = useEditorStore.getState().exportRange();

  const [width, setWidth] = useState(project?.exportSettings.width ?? 1080);
  const [height, setHeight] = useState(project?.exportSettings.height ?? 1920);
  const [fps, setFps] = useState(project?.exportSettings.fps ?? 30);
  const [crf, setCrf] = useState(project?.exportSettings.crf ?? 20);

  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  // The server's own sub-phase message for everything before FFmpeg exists to report real numeric
  // progress (see `ExportProgress.message`'s own doc comment) — `null` once encoding starts, where
  // the percentage below already says everything worth saying. Kept separate from `phase` (this
  // component's OWN idle/running/done/failed/cancelled) rather than folding into it: this is a
  // sub-state of "running" specifically, not a new top-level phase the rest of the UI needs to branch
  // on.
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [etaSeconds, setEtaSeconds] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  // Native only — an export left sitting only in the app's own private storage is easy to lose track
  // of, so a finished render is copied into the device's Gallery automatically (see
  // `nativeSaveExportToGallery`) rather than requiring a manual "Save / Share" tap just to keep a
  // copy. That button stays for picking a specific app to send it to.
  const [gallerySave, setGallerySave] = useState<"idle" | "saving" | "done" | "failed">("idle");

  const isNative = Capacitor.isNativePlatform();

  // Same rule the server's `shouldIncludeOutro` applies (and `Preview.tsx`'s outro marker mirrors): a
  // hosted Free-plan export gets the branded end card appended, so FFmpeg's progress fraction spans
  // the range PLUS the outro. Native exports never add one.
  const { hosted, credits } = useHostedCreditsGate();
  const outroSeconds = !isNative && hosted && credits !== null && credits.plan !== "pro" ? OUTRO_DURATION_SECONDS : 0;
  const shownProgress = useExportPreviewSync({
    active: phase === "running" || phase === "done",
    target: phase === "done" ? 1 : phase === "running" && statusMessage !== null ? 0 : progress,
    rangeStart,
    rangeEnd,
    outroSeconds,
  });

  const jobIdRef = useRef<string | null>(null);
  const unwatchRef = useRef<(() => void) | null>(null);
  // Where encoding progress was first seen, for the time-left estimate — measured from the first real
  // FFmpeg number rather than from the click, so the save/upload/text-render lead-in (which reports no
  // numeric progress at all) doesn't inflate every estimate after it.
  const encodeStartRef = useRef<{ at: number; progress: number } | null>(null);

  // Checked up front rather than on click: if export can't work, the dialog says so plainly instead
  // of presenting a button that fails.
  useEffect(() => {
    void exportAvailable().then(({ available, reason }) => {
      setAvailable(available);
      setUnavailableReason(reason ?? null);
    });
  }, []);

  useEffect(() => () => unwatchRef.current?.(), []);

  // Recovers a project's already-running export on mount — a page reload, a second tab, or just
  // closing and reopening this dialog all lose `jobIdRef`, which used to leave nothing behind but the
  // POST route's own 409 the next time someone clicked Export, with no way to see progress or even
  // cancel it short of restarting the whole server. Checking here means the dialog picks the export
  // back up and shows it running normally instead, the same as if it had never lost track at all.
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    void findRunningExport(projectId).then((jobId) => {
      if (jobId && !cancelled) resume(jobId, null);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-checks when the dialog is opened for a (possibly new) project, not on every render
  }, [projectId]);

  async function autoSaveToGallery(name: string) {
    if (!projectId) return;
    setGallerySave("saving");
    try {
      await nativeSaveExportToGallery(projectId, name);
      setGallerySave("done");
    } catch {
      // Not surfaced as a full export failure — the render itself succeeded, this is just the
      // automatic copy-to-gallery step; the "Save / Share" button below still works as a fallback.
      setGallerySave("failed");
    }
  }

  // Shared by a fresh `startExport` success AND by recovering an export this dialog didn't itself
  // start (see the mount effect above, and `begin`'s own 409 handling below) — either way, from this
  // point on watching an in-flight job looks identical regardless of how its id was found.
  function resume(jobId: string, knownFileName: string | null): void {
    setError(null);
    setPhase("running");
    jobIdRef.current = jobId;
    encodeStartRef.current = null;
    setEtaSeconds(null);
    if (knownFileName) setFileName(knownFileName);

    unwatchRef.current = watchExport(
      jobId,
      (update) => {
        setProgress(update.progress);
        setStatusMessage(update.message ?? null);
        if (!knownFileName) setFileName(update.fileName);
        if (update.status === "running" && !update.message && update.progress > 0) {
          const now = performance.now();
          encodeStartRef.current ??= { at: now, progress: update.progress };
          const elapsed = (now - encodeStartRef.current.at) / 1000;
          const advanced = update.progress - encodeStartRef.current.progress;
          // Too little measured yet and the estimate swings wildly — better to say nothing for the
          // first moment than to flash "about 9:41 left" and then correct itself to "0:12".
          setEtaSeconds(advanced > 0.02 && elapsed > 1.5 ? (elapsed / advanced) * (1 - update.progress) : null);
        }
        if (update.status === "done") {
          setPhase("done");
          if (isNative) void autoSaveToGallery(update.fileName);
        } else if (update.status === "failed") {
          setPhase("failed");
          setError(update.error ?? t("Export failed"));
        } else if (update.status === "cancelled") setPhase("cancelled");
      },
      (message) => {
        // A dropped connection the server closed for good (as opposed to a blip the browser is
        // already retrying — see `watchExport`'s own comment) is ambiguous from here: it could be a
        // job that's still running behind a flaky connection, or a job the server has no record of
        // any more because its process restarted mid-export (jobs live only in memory — see
        // `export/route.ts`'s own `jobs` map — so a restart silently drops every job it was tracking).
        // Checking which one actually happened turns a vague "may still be running" into an honest
        // answer instead of leaving the user to guess why a render that looked fine just vanished.
        setPhase("failed");
        if (!projectId) {
          setError(message);
          return;
        }
        void findRunningExport(projectId)
          .then((runningJobId) => {
            setError(
              runningJobId
                ? message
                : t("The server restarted while exporting — please try again.")
            );
          })
          .catch(() => setError(message));
      }
    );
  }

  async function begin() {
    if (!project || !projectId) return;
    setError(null);
    setProgress(0);
    setEtaSeconds(null);
    setStatusMessage(t("Saving project…"));
    setPhase("running");
    setGallerySave("idle");

    // The export renders whatever the SERVER has, so an unsaved edit would silently export a stale
    // timeline. Saving first makes what's exported match what's on screen.
    await save();

    try {
      // Only clone/trim when a real (non-full) range is set — an untouched export keeps sending
      // the original project object, unchanged from before this feature existed.
      const { start, end } = useEditorStore.getState().exportRange();
      const seqTotal = sequenceDuration(project);
      const isFullRange = start <= 1e-6 && end >= seqTotal - 1e-6;
      const exportProject = isFullRange ? project : trimProjectToRange(project, start, end);

      // A `frame` cover is picked (via the track-header control) against the FULL main timeline, but
      // the server extracts it from the ALREADY-COMPOSITED (and possibly range-trimmed) output —
      // re-based here to that output's own zero point, and clamped into its own bounds, so a cover
      // chosen outside a since-narrowed export range doesn't ask the server to seek past the end of a
      // file that no longer contains it. An `image` cover needs no such rebasing — it's muxed in as-is
      // regardless of any export range.
      const cover = project.exportSettings.cover ?? null;
      const resolvedCover = cover && cover.kind === "frame" ? { kind: "frame" as const, time: Math.max(0, Math.min(cover.time - start, end - start)) } : cover;
      const settings = { ...project.exportSettings, width, height, fps, crf, cover: resolvedCover };

      const started = await startExport(projectId, { ...exportProject, exportSettings: settings });
      resume(started.jobId, started.fileName);
    } catch (err) {
      // A 409 here means some OTHER dialog instance (or a since-lost one — see the mount effect's
      // own comment) already has one running for this project — not a dead end, just a job this
      // request lost the race to start. Recovering it is strictly better than surfacing the raw
      // "already running" message with no way to act on it.
      if (err instanceof ApiRequestError && err.code === "export-already-running") {
        const jobId = await findRunningExport(projectId).catch(() => null);
        if (jobId) {
          resume(jobId, null);
          return;
        }
      }
      setPhase("failed");
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function stop() {
    if (jobIdRef.current) await cancelExport(jobIdRef.current);
  }

  // Native has no browser download — a `download` anchor is meaningless in a WebView. The OS share
  // sheet (save to Files, send to another app, etc.) is the native equivalent of "here's your file."
  async function shareNative() {
    if (!projectId || !fileName) return;
    setSharing(true);
    try {
      const url = await nativeExportUrl(projectId, fileName);
      // `files` (a real attachment another app can read), not `url` — `url` is for sharing a WEB
      // link/text, and silently degrades to just the `title` text when handed a local file:// path
      // instead, which is exactly what looked like "sharing only copies the text, not the video."
      await Share.share({ files: [url], title: fileName, dialogTitle: t("Save or share video") });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSharing(false);
    }
  }

  const busy = phase === "running";
  // Settings stay editable whenever nothing is rendering and nothing just finished — a failed or
  // cancelled export is exactly when someone wants to try a smaller resolution or a lower quality.
  const showSettings = phase === "idle" || phase === "failed" || phase === "cancelled";
  const qualityLabel = crf <= 18 ? t("High") : crf >= 26 ? t("Small file") : t("Balanced");
  const seqWidth = project?.sequence.width ?? width;
  const seqHeight = project?.sequence.height ?? height;
  const percent = Math.round(shownProgress * 100);

  const title =
    phase === "running"
      ? t("Exporting…")
      : phase === "done"
        ? t("Export complete")
        : phase === "failed"
          ? t("Export failed")
          : phase === "cancelled"
            ? t("Export cancelled")
            : t("Export");

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
      onClick={() => {
        if (!busy) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label={t("Export video")}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto overflow-x-hidden rounded-2xl border border-white/10 bg-[#101318] shadow-2xl"
      >
        {/* Soft color wash behind the preview — tinted by state, so the whole card reads "working",
            "done" or "failed" at a glance before any text is read. */}
        <div
          aria-hidden
          className={`pointer-events-none absolute left-1/2 top-10 h-64 w-64 -translate-x-1/2 rounded-full blur-3xl transition-colors duration-700 ${
            phase === "done"
              ? "bg-emerald-500/20"
              : phase === "failed"
                ? "bg-amber-500/10"
                : phase === "running"
                  ? "bg-sky-500/20"
                  : "bg-sky-500/10"
          }`}
        />

        <div className="relative flex items-center justify-between px-5 pt-4">
          <h2 className="text-sm font-semibold text-white" aria-live="polite">
            {title}
          </h2>
          {!busy && (
            <button
              onClick={onClose}
              aria-label={t("Close")}
              className="-mr-1.5 rounded-full p-1.5 text-white/50 transition hover:bg-white/10 hover:text-white"
            >
              <Close size={16} />
            </button>
          )}
        </div>

        {available === false ? (
          <div className="relative mx-5 mb-5 mt-3 rounded-lg bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-200">
            <p>
              {t("FFmpeg isn't available on this machine, so VCut can't render a file. Reinstall dependencies")} (
              <code className="font-mono">pnpm install</code>
              {t(") to restore it.")}
            </p>
            {/* The server's own captured reason (see client.ts's exportAvailable doc comment) —
                shown as-is, not translated: this is a raw error string/path for diagnosing a real
                environment problem, not user-facing copy, and translating it would just as likely
                mangle a filesystem path as clarify anything. */}
            {unavailableReason && (
              <p className="mt-2 break-all rounded bg-black/30 p-2 font-mono text-[10px] text-amber-300/80">
                {unavailableReason}
              </p>
            )}
          </div>
        ) : (
          <div className="relative px-5 pb-5">
            <div className="flex justify-center pt-5" style={{ paddingInline: RING_GAP, paddingBottom: RING_GAP }}>
              <div
                className="relative transition-[width] duration-500 ease-out"
                style={{
                  aspectRatio: `${seqWidth} / ${seqHeight}`,
                  // Height-led for portrait, width-led for landscape — whichever limit binds first. The
                  // preview grows once settings are out of the way, since it's the only thing left to look at.
                  width: `min(100%, calc(${showSettings ? "min(30vh, 250px)" : "min(48vh, 400px)"} * ${seqWidth / seqHeight}))`,
                }}
              >
                <PreviewMirror radius={PREVIEW_RADIUS} />
                {phase !== "idle" && (
                  <ProgressFrame
                    progress={shownProgress}
                    indeterminate={phase === "running" && statusMessage !== null}
                    tone={phase === "done" ? "done" : phase === "failed" ? "failed" : phase === "cancelled" ? "muted" : "active"}
                  />
                )}
                {showSettings && (
                  <span className="absolute bottom-2 left-2 rounded-md bg-black/60 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-white/80 backdrop-blur">
                    {formatDuration(rangeEnd - rangeStart)}
                  </span>
                )}
                {phase === "done" && (
                  <span className="absolute -bottom-3 left-1/2 flex h-7 w-7 -translate-x-1/2 items-center justify-center rounded-full bg-emerald-400 text-[#0b1a14] shadow-[0_0_20px_rgba(52,211,153,0.6)]">
                    <Check size={16} strokeWidth={3} />
                  </span>
                )}
              </div>
            </div>

            {!showSettings && (
              <div className="mt-5 text-center">
                {phase === "running" && (
                  <>
                    {/* Fixed height either way, so the jump from a sub-phase message to the first real
                        percentage doesn't shift the whole card. No "0%" while nothing is measurable yet
                        — a frozen zero is exactly the "is this stuck?" read the orbiting ring avoids. */}
                    <div className="flex h-9 items-center justify-center">
                      {statusMessage ? (
                        <p className="text-sm font-medium text-white/80">{statusMessage}</p>
                      ) : (
                        <p className="text-3xl font-semibold tabular-nums tracking-tight text-white">{percent}%</p>
                      )}
                    </div>
                    <p className="mt-1 h-4 text-[11px] text-white/50">
                      {!statusMessage &&
                        (etaSeconds !== null ? t("About {time} left", { time: formatDuration(Math.max(1, etaSeconds)) }) : t("Rendering…"))}
                    </p>
                  </>
                )}
                {phase === "done" && fileName && <p className="mt-2 truncate text-[11px] text-white/50">{fileName}</p>}
                {phase === "done" && isNative && (
                  <p className="mt-1 text-[11px] text-white/40">
                    {gallerySave === "saving" && t("Saving to Gallery…")}
                    {gallerySave === "done" && t("Saved to Gallery")}
                    {gallerySave === "failed" && (
                      <span className="text-amber-300">{t("Couldn't auto-save — use Save / Share below")}</span>
                    )}
                  </p>
                )}
                <p className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[10px] tabular-nums text-white/55">
                  {width} × {height}
                  <span className="text-white/20">•</span>
                  {t("{value} fps", { value: fps })}
                  <span className="text-white/20">•</span>
                  {qualityLabel}
                </p>
              </div>
            )}

            {showSettings && (
              <>
                {(phase === "failed" || phase === "cancelled") && (
                  <p className={`mt-4 text-center text-[11px] ${phase === "failed" ? "text-amber-200/80" : "text-white/50"}`}>
                    {phase === "failed" ? error : t("Export cancelled")}
                  </p>
                )}

                {hasRange && (
                  <div className="mt-4 flex items-center justify-between rounded-lg bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
                    <span>
                      {t("Exporting range")} {formatTimecode(rangeStart, fps)} – {formatTimecode(rangeEnd, fps)}
                    </span>
                    <button
                      onClick={clearExportRange}
                      className="font-medium text-amber-100 underline decoration-amber-100/40 underline-offset-2 transition hover:text-white"
                    >
                      {t("Reset to full timeline")}
                    </button>
                  </div>
                )}

                <div className="mt-4 space-y-3">
                  <label className="block">
                    <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-white/50">
                      {t("Resolution")}
                    </span>
                    <Dropdown
                      ariaLabel={t("Resolution")}
                      value={`${width}x${height}`}
                      onChange={(next) => {
                        const [w, h] = next.split("x").map(Number);
                        setWidth(w);
                        setHeight(h);
                      }}
                      options={RESOLUTION_PRESETS.map((preset) => ({
                        value: `${preset.width}x${preset.height}`,
                        label: preset.label,
                      }))}
                    />
                  </label>

                  <div className="grid grid-cols-2 gap-3">
                    <label className="block">
                      <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-white/50">
                        {t("Frame rate")}
                      </span>
                      <Dropdown
                        ariaLabel={t("Frame rate")}
                        value={String(fps)}
                        onChange={(next) => setFps(Number(next))}
                        options={FPS_PRESETS.map((value) => ({ value: String(value), label: t("{value} fps", { value }) }))}
                      />
                    </label>

                    <label className="block">
                      <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-white/50">
                        {t("Quality")}
                      </span>
                      {/* CRF is inverted (lower = better), which is unintuitive — the labels say what the
                          user actually cares about and keep the numbers out of the way. */}
                      <Dropdown
                        ariaLabel={t("Quality")}
                        value={String(crf)}
                        onChange={(next) => setCrf(Number(next))}
                        options={[
                          { value: "18", label: t("High") },
                          { value: "20", label: t("Balanced") },
                          { value: "26", label: t("Small file") },
                        ]}
                      />
                    </label>
                  </div>
                </div>
              </>
            )}

            <div className="mt-5 space-y-2">
              {phase === "running" && (
                <button
                  onClick={() => void stop()}
                  className="w-full rounded-lg bg-white/10 px-3 py-2.5 text-xs font-medium text-white transition hover:bg-white/15"
                >
                  {t("Cancel export")}
                </button>
              )}

              {phase === "done" && fileName && projectId && (
                isNative ? (
                  <button
                    onClick={() => void shareNative()}
                    disabled={sharing}
                    className="w-full rounded-lg bg-emerald-400 px-3 py-2.5 text-xs font-semibold text-[#0b1a14] transition hover:bg-emerald-300 disabled:opacity-50"
                  >
                    {sharing ? t("Sharing…") : t("Save / Share")}
                  </button>
                ) : (
                  <a
                    href={exportUrl(projectId, fileName)}
                    download={fileName}
                    className="block w-full rounded-lg bg-emerald-400 px-3 py-2.5 text-center text-xs font-semibold text-[#0b1a14] transition hover:bg-emerald-300"
                  >
                    {t("Save video")}
                  </a>
                )
              )}
              {phase === "done" && error && <p className="text-center text-[11px] text-amber-200/80">{error}</p>}
              {phase === "done" && (
                <div className="grid grid-cols-2 gap-2">
                  {/* Back to the settings rather than straight into a second identical render — a
                      repeat export is almost always about changing something first. */}
                  <button
                    onClick={() => setPhase("idle")}
                    className="rounded-lg bg-white/[0.06] px-3 py-2 text-xs font-medium text-white/80 transition hover:bg-white/10 hover:text-white"
                  >
                    {t("Export again")}
                  </button>
                  <button
                    onClick={onClose}
                    className="rounded-lg bg-white/[0.06] px-3 py-2 text-xs font-medium text-white/80 transition hover:bg-white/10 hover:text-white"
                  >
                    {t("Close")}
                  </button>
                </div>
              )}

              {showSettings && (
                <button
                  onClick={() => void begin()}
                  disabled={available === null}
                  className="w-full rounded-lg bg-sky-500 px-3 py-2.5 text-xs font-semibold text-white shadow-[0_8px_24px_-8px_rgba(14,165,233,0.7)] transition hover:bg-sky-400 disabled:opacity-50"
                >
                  {phase === "idle" ? t("Export") : t("Try again")}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Walks the editor's own preview through the export range in step with the render — the frame on
 *  screen is always the frame FFmpeg has just reached — and returns the smoothed progress fraction the
 *  ring and percentage draw, so picture, ring and number can never disagree. Paused throughout: the
 *  preview is scrubbed, exactly as dragging the Timeline playhead does, rather than played, so there's
 *  no sound and no loop. Drives the ONE existing `PlaybackEngine` through the store instead of a second
 *  engine: a second set of decoding video elements is real extra memory/decoder load on exactly the
 *  devices (iPad/iPhone) where preview playback has been most fragile, and `PreviewMirror` below shows
 *  the existing engine's frames just as well. The playhead goes back where it was when this stops.
 *
 *  FFmpeg reports progress roughly twice a second; jumping the playhead on each report would read as a
 *  slideshow. Instead each new report starts a linear tween from wherever the display currently is to
 *  the new value, lasting as long as the gap since the previous report — so the preview moves steadily
 *  and arrives about when the next report is due, trailing the real render by at most one report. */
function useExportPreviewSync({
  active,
  target,
  rangeStart,
  rangeEnd,
  outroSeconds,
}: {
  active: boolean;
  /** The latest REAL progress fraction — 0 while nothing is measurable yet, 1 once done. */
  target: number;
  rangeStart: number;
  rangeEnd: number;
  /** Seconds of branded end card FFmpeg renders after the range, included in its progress fraction. */
  outroSeconds: number;
}): number {
  const [shown, setShown] = useState(0);
  const shownRef = useRef(0);
  const tweenRef = useRef({ from: 0, to: 0, startedAt: 0, duration: 1, lastReportAt: 0 });

  useEffect(() => {
    const now = performance.now();
    const previous = tweenRef.current;
    // Going backwards only happens when a new export starts over from 0 — snap, don't rewind visibly.
    if (target < shownRef.current) {
      shownRef.current = target;
      setShown(target);
    }
    tweenRef.current = {
      from: shownRef.current,
      to: target,
      startedAt: now,
      duration: target >= 1 ? 250 : Math.min(1500, Math.max(150, previous.lastReportAt ? now - previous.lastReportAt : 500)),
      lastReportAt: now,
    };
  }, [target]);

  useEffect(() => {
    if (!active) return;
    const initial = useEditorStore.getState();
    if (!initial.project) return;
    const savedPlayhead = initial.playhead;
    initial.setPlaying(false);
    initial.playbackEngine?.setPreciseScrub(true);

    const frameSeconds = 1 / (initial.project.sequence.fps || 30);
    const contentEnd = sequenceDuration(initial.project);
    const rangeLength = Math.max(0, rangeEnd - rangeStart);
    let lastPlayhead = Number.NaN;
    let lastSeekAt = 0;
    let frame = 0;

    const tick = () => {
      frame = requestAnimationFrame(tick);
      const { from, to, startedAt, duration } = tweenRef.current;
      const value = from + (to - from) * Math.min(1, (performance.now() - startedAt) / duration);
      if (Math.abs(value - shownRef.current) > 0.0005 || (value === to && shownRef.current !== to)) {
        shownRef.current = value;
        setShown(value);
      }

      const state = useEditorStore.getState();
      // Editor keyboard shortcuts still reach the timeline behind the dialog — Space would otherwise
      // start playback and fight this loop for the playhead.
      if (state.playing) state.setPlaying(false);

      // The rendered file is the range followed by the outro, but in the editor the outro preview lives
      // past the END OF THE WHOLE TIMELINE (`buildOutroPreviewProject`), not after the range — hence the
      // two branches. Each stops one frame short of its end, whose exact instant is past the last frame.
      const outputTime = value * (rangeLength + outroSeconds);
      const playhead =
        outputTime <= rangeLength || outroSeconds <= 0
          ? Math.min(rangeStart + outputTime, Math.max(rangeStart, rangeEnd - frameSeconds))
          : contentEnd + Math.min(outputTime - rangeLength, Math.max(0, outroSeconds - frameSeconds));
      // Paced by the decoder rather than the display: a new playhead only once the previous seek has
      // landed and drawn. Seeking every animation frame instead kept the video permanently mid-seek —
      // measured, the preview copy changed just 12 times across a 20-second render. The time cap keeps
      // a clip whose media never becomes ready from freezing the sync altogether.
      const now = performance.now();
      const settled = !state.playbackEngine || state.playbackEngine.isLastFrameComplete();
      const canSeek = (settled && now - lastSeekAt > 50) || now - lastSeekAt > 700;
      if (canSeek && !(Math.abs(playhead - lastPlayhead) < frameSeconds / 2)) {
        lastPlayhead = playhead;
        lastSeekAt = now;
        state.setPlayhead(playhead);
      }
    };
    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      const state = useEditorStore.getState();
      state.playbackEngine?.setPreciseScrub(false);
      state.setPlaying(false);
      state.setPlayhead(savedPlayhead);
    };
  }, [active, rangeStart, rangeEnd, outroSeconds]);

  return shown;
}

/** A live copy of the editor's own preview canvas (`EditorState.previewCanvas`, the same source
 *  `ScopesPanel` samples), redrawn every animation frame — so whatever the real preview shows, this
 *  shows too, with no second render pipeline. Its backing store is capped at the source canvas's own
 *  size: upscaling past that adds no detail, only work. */
function PreviewMirror({ radius }: { radius: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const target = canvasRef.current;
    const context = target?.getContext("2d");
    if (!target || !context) return;
    let frame = 0;
    const draw = () => {
      frame = requestAnimationFrame(draw);
      const { previewCanvas: source, playbackEngine } = useEditorStore.getState();
      if (!source || source.width === 0 || source.height === 0) return;
      // Scrubbing leaves a clip blank (or stale) for the few frames its video is mid-seek — keeping the
      // last complete frame on screen instead is the difference between a steady preview and a
      // flickering one (measured: about a quarter of copied frames were black before this).
      if (playbackEngine && !playbackEngine.isLastFrameComplete()) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(Math.min(target.clientWidth * dpr, source.width)));
      const h = Math.max(1, Math.round(Math.min(target.clientHeight * dpr, source.height)));
      if (target.width !== w || target.height !== h) {
        target.width = w;
        target.height = h;
      }
      context.drawImage(source, 0, 0, w, h);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 h-full w-full bg-black ring-1 ring-white/10"
      style={{ borderRadius: radius }}
    />
  );
}

/** Rounded-rectangle path starting at top-center and running clockwise — so progress grows from the
 *  top like a clock hand, rather than from the top-left corner where SVG's own `<rect>` would start. */
function roundedRectPath(w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  return [
    `M ${w / 2} 0`,
    `H ${w - rr}`,
    `A ${rr} ${rr} 0 0 1 ${w} ${rr}`,
    `V ${h - rr}`,
    `A ${rr} ${rr} 0 0 1 ${w - rr} ${h}`,
    `H ${rr}`,
    `A ${rr} ${rr} 0 0 1 0 ${h - rr}`,
    `V ${rr}`,
    `A ${rr} ${rr} 0 0 1 ${rr} 0`,
    "Z",
  ].join(" ");
}

const RING_COLORS = {
  active: ["#38bdf8", "#818cf8", "rgba(56,189,248,0.55)"],
  done: ["#34d399", "#5eead4", "rgba(52,211,153,0.55)"],
  failed: ["#fcd34d", "#fbbf24", "rgba(251,191,36,0.3)"],
  muted: ["rgba(255,255,255,0.45)", "rgba(255,255,255,0.3)", "transparent"],
} as const;

/** The progress stroke that travels around the preview's frame. Sized from the wrapper's real pixel
 *  box (`ResizeObserver`) rather than percentage SVG geometry, since a rounded path's arcs need
 *  absolute numbers. `pathLength={100}` makes the dash math plain percentages regardless of the
 *  preview's actual size or aspect ratio. `indeterminate` (nothing to measure yet — saving, uploading,
 *  rendering text) swaps the fill for a short segment orbiting the frame. */
function ProgressFrame({
  progress,
  indeterminate,
  tone,
}: {
  progress: number;
  indeterminate: boolean;
  tone: keyof typeof RING_COLORS;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);
  const gradientId = useId();

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      setBox({ width: rect.width, height: rect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const [from, to, glow] = RING_COLORS[tone];
  const inset = RING_STROKE / 2;
  const d = box
    ? roundedRectPath(box.width - RING_STROKE, box.height - RING_STROKE, PREVIEW_RADIUS + RING_GAP - inset)
    : null;
  const filled = Math.max(0, Math.min(100, progress * 100));

  return (
    <svg
      ref={svgRef}
      aria-hidden
      className="pointer-events-none absolute overflow-visible"
      style={{ inset: -RING_GAP, width: `calc(100% + ${RING_GAP * 2}px)`, height: `calc(100% + ${RING_GAP * 2}px)`, filter: `drop-shadow(0 0 6px ${glow})` }}
    >
      <style>{`@keyframes vcut-export-orbit { to { stroke-dashoffset: -100; } }`}</style>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={from} />
          <stop offset="100%" stopColor={to} />
        </linearGradient>
      </defs>
      {d && (
        <g transform={`translate(${inset} ${inset})`}>
          <path d={d} pathLength={100} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={RING_STROKE} />
          {indeterminate ? (
            <path
              d={d}
              pathLength={100}
              fill="none"
              stroke={`url(#${gradientId})`}
              strokeWidth={RING_STROKE}
              strokeLinecap="round"
              strokeDasharray="16 84"
              style={{ animation: "vcut-export-orbit 1.6s linear infinite" }}
            />
          ) : (
            filled > 0.5 && (
              <path
                d={d}
                pathLength={100}
                fill="none"
                stroke={`url(#${gradientId})`}
                strokeWidth={RING_STROKE}
                strokeLinecap="round"
                strokeDasharray="100 100"
                strokeDashoffset={100 - filled}
                // No dashoffset transition: `progress` already arrives smoothed every animation frame
                // (see `useExportPreviewSync`), and easing on top would lag the stroke behind the frame.
                style={{ transition: "stroke 300ms" }}
              />
            )
          )}
        </g>
      )}
    </svg>
  );
}
