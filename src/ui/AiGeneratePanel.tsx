"use client";

import { useEffect, useState } from "react";
import {
  AI_ASPECT_RATIOS,
  AI_IMAGE_MODELS,
  aiImageAvailable,
  aiVideoAvailable,
  thumbnailUrl,
  type AiAspectRatio,
  type AiImageModel,
} from "../api/client.ts";
import { startCheckout } from "../api/billing.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { Dropdown } from "./Dropdown.tsx";
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

/** Display name for each of `AI_IMAGE_MODELS` — the model ids themselves (`ai-image/route.ts`'s own
 *  `ModelId`) are already reasonable display strings for two of the three, but "flare"/"sunburst" alone
 *  read as generic adjectives with no product identity; capitalized here rather than in the route,
 *  which has no reason to care how its own ids are displayed. */
const MODEL_LABELS: Record<AiImageModel, string> = {
  flare: "Flare",
  sunburst: "Sunburst",
  "nano-banana-2": "Nano Banana 2",
};

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
  const [model, setModel] = useState<AiImageModel>("flare");
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
    if (kind === "image") void generateAiImage(trimmed, aspectRatio, model);
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
        /* container-type: inline-size makes the column count below respond to THIS PANEL's own
           rendered width, not the viewport's — the same panel renders as a narrow persistent desktop
           sidebar (as little as ~110px) and as a near-full-width mobile sheet (~380px+), and a plain
           viewport-width media query can't tell those apart (a wide desktop VIEWPORT with a narrow
           panel would otherwise still get the wide-panel column count). Three columns only once
           there's genuinely enough room per column to be worth it; two, then one, below that. */
        .vcut-ai-grid-container {
          container-type: inline-size;
        }
        .vcut-ai-grid {
          columns: 1;
        }
        @container (min-width: 220px) {
          .vcut-ai-grid {
            columns: 2;
          }
        }
        @container (min-width: 420px) {
          .vcut-ai-grid {
            columns: 3;
          }
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

          {/* Image only — video generation (`ai-video/route.ts`) has exactly one model, so there's
              nothing to pick there. A single compact dropdown, not the three full-width buttons this
              used to be: picking a model is a secondary, occasional decision (most generations should
              just use the default), and giving it the same visual weight as the PROMPT and aspect
              ratio — the two things every single generation actually needs — overstated how often
              anyone would reach for it. Same `Dropdown` component `MediaLibrary.tsx`'s own sort control
              uses, so it reads as "one more small setting," not a third prominent choice. */}
          {kind === "image" && (
            <Dropdown
              value={model}
              onChange={setModel}
              disabled={busy}
              ariaLabel={t("Model")}
              className="mt-2 w-full text-[11px]"
              options={AI_IMAGE_MODELS.map((m) => ({
                value: m,
                label: `${MODEL_LABELS[m]} · ${m === "flare" ? t("Default") : m === "sunburst" ? t("Premium") : t("Alternative")}`,
              }))}
            />
          )}

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

          {(() => {
            // Filtered to the currently-selected kind — an in-progress VIDEO generation used to sit
            // right in the middle of the IMAGE grid (and vice versa) with nothing distinguishing the
            // two, which read as one undifferentiated pile rather than two separate galleries. Switching
            // the Image/Video toggle above now genuinely switches which history you're looking at.
            const visible = aiGenerations.filter((g) => g.kind === kind);
            if (visible.length === 0) return null;
            return (
              // A CSS multi-column flow, not `grid grid-cols-*` — a fixed-row grid forces every tile to
              // the SAME height regardless of its own aspect ratio, which is exactly what stopped a 9:16
              // placeholder/thumbnail from ever looking tall: the grid cell itself capped it back down to
              // match its 16:9 neighbor. Columns let each tile keep its own natural height instead, so
              // ratios genuinely differ from one tile to the next and the whole grid packs tightly around
              // them rather than padding every row out to its tallest member. Wrapped in
              // `vcut-ai-grid-container` (a container-query root, not a viewport media query) so the
              // column count responds to how much room THIS PANEL actually has, not the browser window
              // — see that class's own comment above for why the two can disagree.
              <div className="vcut-ai-grid-container mt-3">
                <div className="vcut-ai-grid gap-2">
                  {visible.map((item) => (
                    <div key={item.id} className="mb-2 break-inside-avoid">
                  <div
                    role={item.status === "done" ? "button" : undefined}
                    tabIndex={item.status === "done" ? 0 : undefined}
                    // A single click lands the result straight on the timeline (at the playhead), not
                    // just into the (hidden, per `generateAiImage`'s own comment) library for a second
                    // step to actually use it — a generation the user is looking at right after it
                    // finished is something they've already decided they want IN the project, so this
                    // is the same "one click, not two" change `StockSearchPanel.tsx`'s own `handlePick`
                    // makes for the identical reason. Used to be double-click-only on desktop (a plain
                    // click did nothing there at all) — that extra step no longer buys anything now
                    // that this is the ONLY place a generation is visible to click on in the first
                    // place (see `aiGenerations`'s own doc comment).
                    onClick={
                      item.status === "done" && item.asset
                        ? () => {
                            addAssetAtPlayhead(item.asset!.id);
                            onAssetAdded?.();
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
                    title={item.status === "done" ? `${item.prompt}\n${t("Click to add at the playhead")}` : item.prompt}
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
                        thumbnailUrl(projectId, item.asset) ? (
                          <img
                            src={thumbnailUrl(projectId, item.asset)!}
                            alt=""
                            className="absolute inset-0 h-full w-full object-cover"
                            draggable={false}
                          />
                        ) : (
                          // A video whose thumbnail failed to generate server-side (or hasn't yet) has
                          // no URL to show at all — `thumbnailUrl` returns `null`, not a broken one.
                          // Same fallback `MediaLibrary.tsx`'s own `AssetThumbnail` already uses for the
                          // identical case, instead of an `<img src="">` that just renders as a broken-
                          // image glyph.
                          <div className="absolute inset-0 flex items-center justify-center bg-white/5 text-[10px] uppercase tracking-wide text-white/40">
                            {t(item.asset.kind)}
                          </div>
                        )
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
                  </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}
        </>
      )}
    </div>
  );
}
