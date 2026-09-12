"use client";

import { useEffect, useRef, useState } from "react";
import {
  AI_ASPECT_RATIOS,
  aiImageAvailable,
  aiVideoAvailable,
  cancelAiVideo,
  startAiVideo,
  thumbnailUrl,
  watchAiVideo,
  type AiAspectRatio,
  type AiVideoProgress,
} from "../api/client.ts";
import { startCheckout } from "../api/billing.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import type { Asset } from "../project/types.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { useHostedCreditsGate } from "./useHostedCreditsGate.ts";

/** Same "single fire-and-navigate action, no special busy/error state" reasoning `Inspector.tsx`'s own
 *  `handleUpgradeClick` documents — duplicated rather than imported since it isn't exported from there
 *  (it's a private module-level helper, and this is 4 lines). */
function handleUpgradeClick() {
  void startCheckout()
    .then((url) => (window.location.href = url))
    .catch(() => {});
}

type VideoPhase = "idle" | "running" | "done" | "failed" | "cancelled";

/** One generation this session, oldest last — deliberately NOT a persisted server-side history (there's
 *  no route for it). This is now the ONLY place a generation is visible: the store marks every
 *  generated asset `hiddenFromLibrary` (see `generateAiImage`'s own comment in `editorStore.ts`), so it
 *  never shows in "My Media" — the entry here appears the instant a generation STARTS
 *  (`status: "generating"`, so there's always a visible preview of the in-flight request, not just a
 *  spinner floating over an empty panel), flips to its real thumbnail or an inline error once the
 *  request settles, and — since nothing else surfaces it once done — is also the only way to actually
 *  use the result: double-click (or tap, in the mobile bottom sheet) adds it to the timeline, same as a
 *  `MediaLibrary` tile. */
interface HistoryItem {
  id: string;
  kind: "image" | "video";
  prompt: string;
  status: "generating" | "done" | "failed";
  asset?: Asset;
  error?: string;
  /** Video only — image generation is a single request/response with no partial progress to show. */
  progress?: number;
  stage?: string;
}

/** AI image/video generation from a text prompt (`ai-image/route.ts` and `ai-video/route.ts`, both
 *  Replicate-backed) — a third `MediaPanel.tsx` tab alongside "My Media" and "Stock", same "self-
 *  contained panel, not woven into `MediaLibrary.tsx`'s own intricate logic" reasoning
 *  `StockSearchPanel.tsx` already follows. Hosted-only, credit-gated (see `useHostedCreditsGate`'s own
 *  doc comment) — there is no local/desktop self-serve provider-key UI for this, unlike Remove Object's
 *  `RemoveObjectSection`, matching Captions'/Kiri's own minimal hosted-only pattern instead.
 *
 *  `MediaPanel.tsx` keeps this mounted (hidden, not unmounted) while another tab is active — a video
 *  job's `watchAiVideo` subscription would otherwise be torn down by this component's own unmount the
 *  moment a user glanced at "My Media" mid-generation, silently orphaning a job that was still running
 *  server-side with no way left to learn how it finished. */
export function AiGeneratePanel({ onAssetAdded }: { onAssetAdded?: () => void } = {}) {
  const t = useTranslation();
  const projectId = useEditorStore((s) => s.projectId);
  const importing = useEditorStore((s) => s.importing);
  const generateAiImage = useEditorStore((s) => s.generateAiImage);
  const addGeneratedAsset = useEditorStore((s) => s.addGeneratedAsset);
  const addAssetAtPlayhead = useEditorStore((s) => s.addAssetAtPlayhead);
  const { hosted, credits } = useHostedCreditsGate();
  const outOfCredits = hosted && credits !== null && credits.creditsRemaining <= 0;

  const [kind, setKind] = useState<"image" | "video">("image");
  const [prompt, setPrompt] = useState("");
  const [aspectRatio, setAspectRatio] = useState<AiAspectRatio>("9:16");
  const [imageAvailable, setImageAvailable] = useState<boolean | null>(null);
  const [videoAvailable, setVideoAvailable] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);

  const [videoPhase, setVideoPhase] = useState<VideoPhase>("idle");
  const jobIdRef = useRef<string | null>(null);
  const videoItemIdRef = useRef<string | null>(null);
  const unwatchRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    void aiImageAvailable().then(setImageAvailable);
    void aiVideoAvailable().then(setVideoAvailable);
  }, []);

  useEffect(() => () => unwatchRef.current?.(), []);

  function patchHistory(id: string, patch: Partial<HistoryItem>) {
    setHistory((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }

  async function handleGenerateImage() {
    const trimmed = prompt.trim();
    if (!trimmed || !projectId) return;
    setError(null);
    const id = crypto.randomUUID();
    setHistory((prev) => [{ id, kind: "image", prompt: trimmed, status: "generating" }, ...prev]);
    const asset = await generateAiImage(trimmed, aspectRatio);
    if (asset) {
      patchHistory(id, { status: "done", asset });
      setPrompt("");
    } else {
      patchHistory(id, { status: "failed", error: t("Generation failed") });
    }
  }

  async function handleGenerateVideo() {
    const trimmed = prompt.trim();
    if (!trimmed || !projectId) return;
    setError(null);
    const id = crypto.randomUUID();
    videoItemIdRef.current = id;
    setHistory((prev) => [{ id, kind: "video", prompt: trimmed, status: "generating", progress: 0, stage: "" }, ...prev]);
    setVideoPhase("running");
    try {
      const started = await startAiVideo(projectId, trimmed, aspectRatio);
      jobIdRef.current = started.jobId;
      unwatchRef.current = watchAiVideo(
        started.jobId,
        (update: AiVideoProgress) => {
          setVideoPhase(update.status);
          patchHistory(id, {
            progress: update.progress,
            stage: update.stage,
            ...(update.status === "done" && update.asset ? { status: "done", asset: update.asset } : null),
            ...(update.status === "failed" ? { status: "failed", error: update.error ?? t("Generation failed") } : null),
            ...(update.status === "cancelled" ? { status: "failed", error: t("Cancelled") } : null),
          });
          if (update.status === "done" && update.asset) {
            addGeneratedAsset(update.asset);
            setPrompt("");
          }
          if (update.status === "failed" && update.error) setError(update.error);
        },
        (message) => setError(message)
      );
    } catch (err) {
      setVideoPhase("failed");
      const message = err instanceof Error ? err.message : t("Could not start the job");
      setError(message);
      patchHistory(id, { status: "failed", error: message });
    }
  }

  function stopVideo() {
    if (jobIdRef.current) void cancelAiVideo(jobIdRef.current);
    setVideoPhase("cancelled");
    if (videoItemIdRef.current) patchHistory(videoItemIdRef.current, { status: "failed", error: t("Cancelled") });
  }

  if (!projectId) return null;

  const available = kind === "image" ? imageAvailable : videoAvailable;
  const videoBusy = videoPhase === "running";
  const busy = kind === "image" ? importing : videoBusy;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto p-3">
      <div className="mb-3 flex shrink-0 overflow-hidden rounded-md border border-white/10">
        {(["image", "video"] as const).map((k) => (
          <button
            key={k}
            onClick={() => {
              setKind(k);
              setError(null);
            }}
            disabled={videoBusy}
            className={`flex-1 px-2.5 py-1 text-xs font-medium transition disabled:cursor-default disabled:opacity-60 ${
              kind === k ? "bg-sky-500 text-white" : "bg-white/5 text-white/60 hover:bg-white/10"
            }`}
          >
            {k === "image" ? t("Image") : t("Video")}
          </button>
        ))}
      </div>

      {available === null ? (
        <p className="text-[12px] text-white/35">{t("Checking…")}</p>
      ) : !available ? (
        <p className="text-[12px] leading-relaxed text-white/40">
          {t("AI {kind} generation isn't available right now.", { kind: kind === "image" ? t("image") : t("video") })}
        </p>
      ) : outOfCredits ? (
        <>
          <p className="text-[12px] leading-relaxed text-amber-300">
            {t("You're out of credits for this month — upgrade to Pro for more, or wait for your credits to refill.")}
          </p>
          <button
            onClick={handleUpgradeClick}
            className="mt-2 w-full rounded bg-sky-500 py-1.5 text-[12px] font-medium text-white transition hover:bg-sky-400"
          >
            {t("Upgrade to Pro")}
          </button>
        </>
      ) : (
        <>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={kind === "image" ? t("Describe the image you want…") : t("Describe the video you want…")}
            rows={3}
            disabled={busy}
            className="w-full resize-none rounded-md bg-white/5 px-2 py-1.5 text-[13px] text-white placeholder:text-white/30 focus:outline-none focus:ring-1 focus:ring-sky-400/60 disabled:opacity-60"
          />

          <div className="mt-2 flex gap-1.5">
            {AI_ASPECT_RATIOS.map((ratio) => (
              <button
                key={ratio}
                onClick={() => setAspectRatio(ratio)}
                disabled={busy}
                className={`flex-1 rounded py-1 text-[11px] font-medium transition disabled:cursor-default disabled:opacity-60 ${
                  aspectRatio === ratio ? "bg-sky-500 text-white" : "bg-white/5 text-white/60 hover:bg-white/10"
                }`}
              >
                {ratio}
              </button>
            ))}
          </div>

          {error && <p className="mt-2 text-[11px] leading-relaxed text-rose-300">{error}</p>}

          <button
            onClick={() => void (kind === "image" ? handleGenerateImage() : videoBusy ? stopVideo() : handleGenerateVideo())}
            disabled={!prompt.trim() || (kind === "image" && busy)}
            className="mt-3 w-full rounded bg-sky-500 py-1.5 text-[12px] font-medium text-white transition hover:bg-sky-400 disabled:cursor-default disabled:opacity-50"
          >
            {kind === "image" ? (busy ? t("Generating…") : t("Generate image")) : videoBusy ? t("Cancel") : t("Generate video")}
          </button>

          {history.length > 0 && (
            <ul className="mt-3 grid grid-cols-2 gap-2">
              {history.map((item) => (
                <li key={item.id}>
                  <div
                    role={item.status === "done" ? "button" : undefined}
                    tabIndex={item.status === "done" ? 0 : undefined}
                    onDoubleClick={item.status === "done" && item.asset ? () => addAssetAtPlayhead(item.asset!.id) : undefined}
                    // Same "plain tap is the only practical way to place a clip" reasoning
                    // `MediaLibrary.tsx`'s own identical `onClick` documents — only wired when
                    // `onAssetAdded` is passed (the mobile bottom-sheet usage).
                    onClick={
                      item.status === "done" && item.asset && onAssetAdded
                        ? () => {
                            addAssetAtPlayhead(item.asset!.id);
                            onAssetAdded();
                          }
                        : undefined
                    }
                    onKeyDown={
                      item.status === "done" && item.asset
                        ? (e) => {
                            if (e.key === "Enter") addAssetAtPlayhead(item.asset!.id);
                          }
                        : undefined
                    }
                    title={item.status === "done" ? t("Double-click to add at the playhead") : undefined}
                    className={`flex w-full flex-col overflow-hidden rounded-lg bg-black/40 text-left ${
                      item.status === "done" ? "cursor-pointer transition hover:ring-1 hover:ring-sky-400/60" : ""
                    }`}
                  >
                    <div className="relative aspect-video w-full overflow-hidden bg-black">
                      {item.status === "done" && item.asset ? (
                        <img
                          src={thumbnailUrl(projectId, item.asset) ?? ""}
                          alt=""
                          className="h-full w-full object-cover"
                          draggable={false}
                        />
                      ) : item.status === "failed" ? (
                        <div className="flex h-full w-full items-center justify-center bg-rose-950/30 p-2 text-center text-[10px] leading-snug text-rose-300">
                          {item.error}
                        </div>
                      ) : (
                        <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 bg-white/5 p-2">
                          <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/20 border-t-white/60" />
                          <span className="text-center text-[10px] leading-snug text-white/50">
                            {item.kind === "video" ? item.stage || t("Starting…") : t("Generating…")}
                          </span>
                          {item.kind === "video" && (
                            <div className="h-1 w-3/4 overflow-hidden rounded-full bg-white/10">
                              <div
                                className="h-full rounded-full bg-sky-400 transition-all"
                                style={{ width: `${Math.round((item.progress ?? 0) * 100)}%` }}
                              />
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                    <p className="truncate px-1.5 py-1 text-[10px] text-white/40" title={item.prompt}>
                      {item.prompt}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
