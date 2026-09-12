"use client";

import { useEffect, useRef, useState } from "react";
import { AI_IMAGE_ASPECT_RATIOS, aiImageAvailable, aiVideoAvailable, cancelAiVideo, startAiVideo, watchAiVideo, type AiImageAspectRatio, type AiVideoProgress } from "../api/client.ts";
import { startCheckout } from "../api/billing.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
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

/** AI image/video generation from a text prompt (`ai-image/route.ts` and `ai-video/route.ts`, both
 *  Replicate-backed) — a third `MediaPanel.tsx` tab alongside "My Media" and "Stock", same "self-
 *  contained panel, not woven into `MediaLibrary.tsx`'s own intricate logic" reasoning
 *  `StockSearchPanel.tsx` already follows. Hosted-only, credit-gated (see `useHostedCreditsGate`'s own
 *  doc comment) — there is no local/desktop self-serve provider-key UI for this, unlike Remove Object's
 *  `RemoveObjectSection`, matching Captions'/Kiri's own minimal hosted-only pattern instead. */
export function AiGeneratePanel({ onAssetAdded }: { onAssetAdded?: () => void } = {}) {
  const t = useTranslation();
  const projectId = useEditorStore((s) => s.projectId);
  const importing = useEditorStore((s) => s.importing);
  const generateAiImage = useEditorStore((s) => s.generateAiImage);
  const addGeneratedAsset = useEditorStore((s) => s.addGeneratedAsset);
  const { hosted, credits } = useHostedCreditsGate();
  const outOfCredits = hosted && credits !== null && credits.creditsRemaining <= 0;

  const [kind, setKind] = useState<"image" | "video">("image");
  const [prompt, setPrompt] = useState("");
  const [aspectRatio, setAspectRatio] = useState<AiImageAspectRatio>("9:16");
  const [imageAvailable, setImageAvailable] = useState<boolean | null>(null);
  const [videoAvailable, setVideoAvailable] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Video-only job state — image generation is a plain request/response handled entirely by the
  // store's own `importing` flag, same as `StockSearchPanel`'s single `importing` state; video needs
  // its own richer state because a job takes minutes and reports real progress (see `ai-video/route.ts`'s
  // own comment on why it's job+SSE while image gen is synchronous).
  const [videoPhase, setVideoPhase] = useState<VideoPhase>("idle");
  const [videoStage, setVideoStage] = useState<string>("");
  const [videoProgress, setVideoProgress] = useState(0);
  const jobIdRef = useRef<string | null>(null);
  const unwatchRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    void aiImageAvailable().then(setImageAvailable);
    void aiVideoAvailable().then(setVideoAvailable);
  }, []);

  useEffect(() => () => unwatchRef.current?.(), []);

  async function handleGenerateImage() {
    const trimmed = prompt.trim();
    if (!trimmed || !projectId) return;
    setError(null);
    const asset = await generateAiImage(trimmed, aspectRatio);
    if (asset) {
      setPrompt("");
      onAssetAdded?.();
    }
  }

  async function handleGenerateVideo() {
    const trimmed = prompt.trim();
    if (!trimmed || !projectId) return;
    setError(null);
    setVideoProgress(0);
    setVideoStage("");
    setVideoPhase("running");
    try {
      const started = await startAiVideo(projectId, trimmed);
      jobIdRef.current = started.jobId;
      unwatchRef.current = watchAiVideo(
        started.jobId,
        (update: AiVideoProgress) => {
          setVideoStage(update.stage);
          setVideoProgress(update.progress);
          setVideoPhase(update.status);
          if (update.status === "done" && update.asset) {
            addGeneratedAsset(update.asset);
            setPrompt("");
            onAssetAdded?.();
          }
          if (update.status === "failed" && update.error) setError(update.error);
        },
        (message) => setError(message)
      );
    } catch (err) {
      setVideoPhase("failed");
      setError(err instanceof Error ? err.message : t("Could not start the job"));
    }
  }

  function stopVideo() {
    if (jobIdRef.current) void cancelAiVideo(jobIdRef.current);
    setVideoPhase("cancelled");
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

          {kind === "image" && (
            <div className="mt-2 flex gap-1.5">
              {AI_IMAGE_ASPECT_RATIOS.map((ratio) => (
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
          )}

          {kind === "video" && videoBusy && (
            <div className="mt-2 space-y-1.5">
              <p className="text-[11px] text-white/50 capitalize">{videoStage || t("Starting…")}</p>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                <div className="h-full rounded-full bg-sky-400 transition-all" style={{ width: `${Math.round(videoProgress * 100)}%` }} />
              </div>
              <p className="text-[11px] text-white/35">{t("This can take a few minutes.")}</p>
            </div>
          )}

          {error && <p className="mt-2 text-[11px] leading-relaxed text-rose-300">{error}</p>}

          <button
            onClick={() => void (kind === "image" ? handleGenerateImage() : videoBusy ? stopVideo() : handleGenerateVideo())}
            disabled={!prompt.trim() || (kind === "image" && busy)}
            className="mt-3 w-full rounded bg-sky-500 py-1.5 text-[12px] font-medium text-white transition hover:bg-sky-400 disabled:cursor-default disabled:opacity-50"
          >
            {kind === "image" ? (busy ? t("Generating…") : t("Generate image")) : videoBusy ? t("Cancel") : t("Generate video")}
          </button>
        </>
      )}
    </div>
  );
}
