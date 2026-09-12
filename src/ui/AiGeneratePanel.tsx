"use client";

import { useEffect, useState } from "react";
import { AI_ASPECT_RATIOS, aiImageAvailable, aiVideoAvailable, thumbnailUrl, type AiAspectRatio } from "../api/client.ts";
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

/** CSS's `aspect-ratio` property takes the same "W/H" shape `AiAspectRatio`'s own colon-separated
 *  string already is, just with a different separator — this is the only translation needed. Used so
 *  a tile's box actually matches the ratio it was GENERATED at (a 9:16 request shows as a tall tile,
 *  not a cropped 16:9 one), including before there's a real image to measure: the placeholder itself
 *  is already the right shape while still generating. */
function cssAspectRatio(ratio: AiAspectRatio): string {
  return ratio.replace(":", " / ");
}

/** AI image/video generation from a text prompt (`ai-image/route.ts` and `ai-video/route.ts`, both
 *  Replicate-backed) — a third `MediaPanel.tsx` tab alongside "My Media" and "Stock", same "self-
 *  contained panel, not woven into `MediaLibrary.tsx`'s own intricate logic" reasoning
 *  `StockSearchPanel.tsx` already follows. Hosted-only, credit-gated (see `useHostedCreditsGate`'s own
 *  doc comment) — there is no local/desktop self-serve provider-key UI for this, unlike Remove Object's
 *  `RemoveObjectSection`, matching Captions'/Kiri's own minimal hosted-only pattern instead.
 *
 *  The actual generation history (`aiGenerations`) lives in `editorStore`, not here — see that field's
 *  own doc comment for why local component state couldn't survive what this panel's mobile home
 *  (the bottom sheet) does to it. This component is a pure view over that store state: every action
 *  below is a one-line dispatch, and the tiles below just render whatever the store currently holds. */
export function AiGeneratePanel({ onAssetAdded }: { onAssetAdded?: () => void } = {}) {
  const t = useTranslation();
  const projectId = useEditorStore((s) => s.projectId);
  const importing = useEditorStore((s) => s.importing);
  const aiGenerations = useEditorStore((s) => s.aiGenerations);
  const generateAiImage = useEditorStore((s) => s.generateAiImage);
  const startAiVideoGeneration = useEditorStore((s) => s.startAiVideoGeneration);
  const cancelAiVideoGeneration = useEditorStore((s) => s.cancelAiVideoGeneration);
  const addAssetAtPlayhead = useEditorStore((s) => s.addAssetAtPlayhead);
  const { hosted, credits } = useHostedCreditsGate();
  const outOfCredits = hosted && credits !== null && credits.creditsRemaining <= 0;

  const [kind, setKind] = useState<"image" | "video">("image");
  const [prompt, setPrompt] = useState("");
  const [aspectRatio, setAspectRatio] = useState<AiAspectRatio>("9:16");
  const [imageAvailable, setImageAvailable] = useState<boolean | null>(null);
  const [videoAvailable, setVideoAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    void aiImageAvailable().then(setImageAvailable);
    void aiVideoAvailable().then(setVideoAvailable);
  }, []);

  // Single-flight (the store's own `startAiVideoGeneration` doc comment explains why): derived from
  // the shared history rather than a flag of its own, so it stays correct regardless of which
  // component instance (desktop column vs. mobile sheet) actually started the job.
  const videoBusy = aiGenerations.some((g) => g.kind === "video" && g.status === "generating");

  function handleGenerate() {
    const trimmed = prompt.trim();
    if (!trimmed || !projectId) return;
    // Cleared immediately on submit, not on completion — same "send, then the input is yours again"
    // feel a chat input has, and it means a slow generation never leaves stale text sitting there.
    setPrompt("");
    if (kind === "image") void generateAiImage(trimmed, aspectRatio);
    else void startAiVideoGeneration(trimmed, aspectRatio);
  }

  if (!projectId) return null;

  const available = kind === "image" ? imageAvailable : videoAvailable;
  const busy = kind === "image" ? importing : videoBusy;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto p-3">
      {/* Custom keyframes: Tailwind's own animation utilities cover spin/pulse/bounce/ping, not an
          arbitrary moving mask — declared once here rather than in a host app's global CSS because
          this package ships as source into THREE separate apps (web, mobile, desktop), each with its
          own stylesheet; a self-contained rule is the only way every one of them gets it.
          `.vcut-ai-generating-dots`: a dim dot grid is always visible (the plain `background-image`
          below), and a SECOND, brighter copy of the exact same pattern sweeps a soft circular
          "spotlight" of visibility across it — `mask-position` (not `background-position`, and not a
          separately-positioned element) is what moves, so the bright dots always land exactly on top
          of the dim ones with no alignment drift to manage. */}
      <style>{`
        @keyframes vcut-ai-generating-sweep {
          0%, 100% { mask-position: -60% -60%; -webkit-mask-position: -60% -60%; }
          50% { mask-position: 160% 160%; -webkit-mask-position: 160% 160%; }
        }
        .vcut-ai-generating-dots {
          background-image: radial-gradient(circle, rgba(96, 165, 250, 0.9) 1px, transparent 1.5px);
          background-size: 14px 14px;
          mask-image: radial-gradient(circle, black 0%, black 25%, transparent 60%);
          -webkit-mask-image: radial-gradient(circle, black 0%, black 25%, transparent 60%);
          mask-size: 220% 220%;
          -webkit-mask-size: 220% 220%;
          mask-repeat: no-repeat;
          -webkit-mask-repeat: no-repeat;
          animation: vcut-ai-generating-sweep 4s ease-in-out infinite;
        }
      `}</style>

      <div className="mb-3 flex shrink-0 overflow-hidden rounded-md border border-white/10">
        {(["image", "video"] as const).map((k) => (
          <button
            key={k}
            onClick={() => setKind(k)}
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

          <button
            onClick={() => (kind === "video" && videoBusy ? cancelAiVideoGeneration() : handleGenerate())}
            disabled={!prompt.trim() && !(kind === "video" && videoBusy)}
            className="mt-3 w-full rounded bg-sky-500 py-1.5 text-[12px] font-medium text-white transition hover:bg-sky-400 disabled:cursor-default disabled:opacity-50"
          >
            {kind === "image" ? (busy ? t("Generating…") : t("Generate image")) : videoBusy ? t("Cancel") : t("Generate video")}
          </button>

          {aiGenerations.length > 0 && (
            // A CSS multi-column flow, not `grid grid-cols-2` — a fixed-row grid forces every tile to
            // the SAME height regardless of its own aspect ratio, which is exactly what stopped a 9:16
            // placeholder/thumbnail from ever looking tall: the grid cell itself capped it back down to
            // match its 16:9 neighbor. Columns let each tile keep its own natural height instead, so
            // ratios genuinely differ from one tile to the next and the whole grid packs tightly around
            // them rather than padding every row out to its tallest member.
            <div className="mt-3 columns-2 gap-2">
              {aiGenerations.map((item) => (
                <div key={item.id} className="mb-2 break-inside-avoid">
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
                    {/* `absolute inset-0` on every branch below, not `h-full w-full` — a percentage
                        height only resolves against a PARENT with an explicit height, and this parent's
                        height comes from `aspect-ratio` alone (no explicit `height`), which doesn't
                        reliably count for that: a long error message (`item.error`, sometimes a raw
                        provider response) could inflate its own box past the ratio-implied height
                        instead of being clipped by this parent's own `overflow-hidden`. Anchoring
                        directly to the parent's edges has no such ambiguity. */}
                    {/* `max-h-52`: `aspect-ratio` alone lets a tall ratio (9:16) grow height-unbounded
                        off whatever width its column happens to get, which could tower well past what's
                        needed just to recognize the result — same "cap it regardless of the ratio-
                        implied height" reasoning `MediaLibrary.tsx`'s own mobile-grid thumbnail cap
                        gives. A short ratio (1:1, 16:9) never reaches this cap on its own, so it only
                        ever affects the tall case. */}
                    <div
                      className="relative w-full max-h-52 overflow-hidden bg-black"
                      style={{ aspectRatio: cssAspectRatio(item.aspectRatio) }}
                    >
                      {item.status === "done" && item.asset ? (
                        <img
                          src={thumbnailUrl(projectId, item.asset) ?? ""}
                          alt=""
                          className="absolute inset-0 h-full w-full object-cover"
                          draggable={false}
                        />
                      ) : item.status === "failed" ? (
                        <div className="absolute inset-0 flex items-center justify-center bg-rose-950/30 p-2 text-center">
                          <span className="line-clamp-5 text-[10px] leading-snug text-rose-300">{item.error}</span>
                        </div>
                      ) : (
                        <div className="absolute inset-0 bg-black">
                          {/* Dim base layer: the same dot pattern the sweep below animates over, always
                              fully visible so the grid reads immediately, not just wherever the sweep
                              currently is. */}
                          <div
                            className="absolute inset-0"
                            style={{
                              backgroundImage: "radial-gradient(circle, rgba(96, 165, 250, 0.25) 1px, transparent 1.5px)",
                              backgroundSize: "14px 14px",
                            }}
                          />
                          <div className="vcut-ai-generating-dots absolute inset-0" />
                          <span className="absolute left-2 top-2 text-[13px] font-semibold text-white">
                            {item.kind === "video" ? t("Creating video") : t("Creating image")}
                          </span>
                          {item.kind === "video" && (
                            <span className="absolute bottom-2 right-2 rounded-full border border-white/10 bg-black/70 px-2 py-0.5 text-[11px] font-semibold text-sky-300">
                              {Math.round((item.progress ?? 0) * 100)}%
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                    <p className="truncate px-1.5 py-1 text-[10px] text-white/40" title={item.prompt}>
                      {item.prompt}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
