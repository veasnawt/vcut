"use client";

import { useEffect, useState } from "react";
import {
  AI_ASPECT_RATIOS,
  AI_IMAGE_MODELS,
  aiImageAvailable,
  aiVideoAvailable,
  previewAssetFromLibraryMedia,
  thumbnailUrl,
  type AiAspectRatio,
  type AiImageModel,
  type LibraryMediaItem,
} from "../api/client.ts";
import { AI_IMAGE_CREDITS, AI_VIDEO_CREDITS_PER_GENERATION, startCheckout } from "../api/billing.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import type { Asset } from "../project/types.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { Dropdown } from "./Dropdown.tsx";
import { pickAssetForPlacement } from "./pickPlacement.ts";
import { useHostedCreditsGate } from "./useHostedCreditsGate.ts";
import { useLibraryMedia } from "./useLibraryMedia.ts";

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

/** A shape both `aiGenerations` (this project's own live history) and the account-wide library listing
 *  (every OTHER project's own past generations — see `useLibraryMedia`'s own doc comment) can be mapped
 *  into, so the results grid below has exactly one rendering path regardless of which one the "This
 *  project" / "All my generations" toggle currently shows. `libraryItem` is set ONLY for a tile sourced
 *  from the library listing — it's what `pickTile` needs to actually place a generation that isn't in
 *  THIS project yet (see its own comment). */
interface DisplayTile {
  id: string;
  kind: "image" | "video";
  status: "generating" | "done" | "failed";
  prompt: string;
  aspectRatio: AiAspectRatio;
  asset?: Asset;
  error?: string;
  progress?: number;
  libraryItem?: LibraryMediaItem;
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
  const addLibraryAssetToProject = useEditorStore((s) => s.addLibraryAssetToProject);
  const { hosted, credits, outOfCredits, isPro } = useHostedCreditsGate();

  const [kind, setKind] = useState<"image" | "video">("image");
  const [prompt, setPrompt] = useState("");
  const [aspectRatio, setAspectRatio] = useState<AiAspectRatio>("9:16");
  const [model, setModel] = useState<AiImageModel>("flare");
  const [imageAvailable, setImageAvailable] = useState<boolean | null>(null);
  const [videoAvailable, setVideoAvailable] = useState<boolean | null>(null);

  // "All my generations" — every past AI generation across every one of the user's OTHER projects too,
  // not just this one (same account-wide reuse `MediaLibrary.tsx`'s own "All my media" toggle offers,
  // just pre-filtered here to items that actually carry `aiGeneration`). Hosted-only: `hosted` gates the
  // toggle itself below, so this branch simply never activates on desktop/local dev.
  const [isLibraryView, setIsLibraryView] = useState(false);
  const library = useLibraryMedia(isLibraryView);
  const libraryError = library.error;
  useEffect(() => {
    if (!libraryError) return;
    useEditorStore.getState().setStatus(libraryError, "error");
    setIsLibraryView(false);
  }, [libraryError]);

  useEffect(() => {
    void aiImageAvailable().then(setImageAvailable);
    void aiVideoAvailable().then(setVideoAvailable);
  }, []);

  // Single-flight (the store's own `startAiVideoGeneration` doc comment explains why): derived from
  // the shared history rather than a flag of its own, so it stays correct regardless of which
  // component instance (desktop column vs. mobile sheet) actually started the job.
  const videoBusy = aiGenerations.some((g) => g.kind === "video" && g.status === "generating");

  // Same desktop-vs-mobile, empty-vs-non-empty-track branch `StockSearchPanel.tsx`'s own `handlePick`
  // makes, via the shared `pickAssetForPlacement` — see its own doc comment.
  function pickGeneration(assetId: string) {
    pickAssetForPlacement(assetId, onAssetAdded);
  }

  /** Picks a tile from EITHER list `DisplayTile`s can come from. A tile sourced from the account-wide
   *  library (`tile.libraryItem` set) isn't a real asset in THIS project yet — `addLibraryAssetToProject`
   *  mints one (idempotently: a re-pick of something already added just returns the existing asset, no
   *  duplicate), and only then does placement proceed, so a single click still does the whole job in one
   *  step, same as picking an already-live generation always has. */
  function pickTile(tile: DisplayTile) {
    if (tile.status !== "done" || !tile.asset) return;
    if (tile.libraryItem) {
      const asset = addLibraryAssetToProject(tile.libraryItem);
      if (asset) pickGeneration(asset.id);
    } else {
      pickGeneration(tile.asset.id);
    }
  }

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
           there's genuinely enough room per column to be worth it; two, then one, below that.
           The :has(> div:nth-child(N)) clauses below additionally gate each bump on actually having
           enough generations to fill it — same "few, uneven-height items in too many columns leaves
           one looking mostly empty" fix MediaLibrary.tsx's identical rule documents; a couple of tall
           9:16 generations next to a couple of short 16:9 ones can hit the exact same imbalance.
           Thresholds (5, 9) deliberately more generous than "one more than the column count" — see
           MediaLibrary.tsx's own comment on why a tighter bar still reproduced the bug live. No
           backticks in this comment block on purpose — it lives INSIDE the template literal below,
           and a literal backtick here would terminate that string early (confirmed the hard way,
           earlier this same file). */
        .vcut-ai-grid-container {
          container-type: inline-size;
        }
        .vcut-ai-grid {
          columns: 1;
        }
        @container (min-width: 220px) {
          .vcut-ai-grid:has(> div:nth-child(5)) {
            columns: 2;
          }
        }
        @container (min-width: 420px) {
          .vcut-ai-grid:has(> div:nth-child(9)) {
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
          {/* A Pro user who's simply used their own (much larger) monthly allotment gets no upgrade
              button at all — there's nothing left to upgrade TO, and offering one anyway (a real,
              reported bug: this used to show unconditionally) reads as VCut not knowing its own
              subscriber is already Pro, right when it matters most. */}
          <p className="text-[12px] leading-relaxed text-amber-300">
            {isPro
              ? t("You're out of credits for this month — they'll refresh on {date}.", {
                  date: credits?.creditsResetAt ? new Date(credits.creditsResetAt).toLocaleDateString() : "",
                })
              : t("You're out of credits for this month — upgrade to Pro for more, or wait for your credits to refill.")}
          </p>
          {!isPro && (
            <button
              onClick={handleUpgradeClick}
              className="mt-2 w-full rounded bg-sky-500 py-1.5 text-[12px] font-medium text-white transition hover:bg-sky-400"
            >
              {t("Upgrade to Pro")}
            </button>
          )}
        </>
      ) : (
        <>
          {/* `shrink-0` on this and every other control below (dropdown, aspect-ratio row, Generate
              button) — without it, a flex-column parent whose content runs taller than the sheet
              shrinks EVERY child proportionally to fit rather than overflowing into the `overflow-y-
              auto` scroll it already has, `rows={3}`'s own intrinsic height included: a textarea's
              min-content height can go well below "3 visible lines," so it was the child that
              visibly squashed first. Pinning these to their natural size means the results grid below
              is what gives way instead — pushed down and scrolled to, never these controls. */}
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={kind === "image" ? t("Describe the image you want…") : t("Describe the video you want…")}
            rows={3}
            disabled={busy}
            className="w-full shrink-0 resize-none rounded-md bg-white/5 px-2 py-1.5 text-[13px] text-white placeholder:text-white/30 focus:outline-none focus:ring-1 focus:ring-sky-400/60 disabled:opacity-60"
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
              className="mt-2 w-full shrink-0 text-[11px]"
              options={AI_IMAGE_MODELS.map((m) => ({
                value: m,
                // Credit cost appended to every option, not just the selected one shown in the closed
                // dropdown — the whole POINT is comparing models before picking. The old "Default /
                // Premium / Alternative" quality-tier labels are gone (confirmed a real, reported
                // confusion once costs became visible: Nano Banana 2 is labeled "Alternative" but
                // actually costs MORE than Sunburst's "Premium" — those words were never tied to
                // actual per-model cost ranking in the first place). The credit number alone already
                // says which is pricier, with no risk of contradicting itself the way a separate,
                // unranked label could.
                label: m === "flare" ? `${MODEL_LABELS[m]} · ${t("Default")} · ${t("{n} credits", { n: AI_IMAGE_CREDITS[m] })}` : `${MODEL_LABELS[m]} · ${t("{n} credits", { n: AI_IMAGE_CREDITS[m] })}`,
              }))}
            />
          )}

          <div className="mt-2 flex shrink-0 gap-1.5">
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
            className="mt-3 w-full shrink-0 rounded bg-sky-500 py-1.5 text-[12px] font-medium text-white transition hover:bg-sky-400 disabled:cursor-default disabled:opacity-50"
          >
            {kind === "image"
              ? busy
                ? t("Generating…")
                : t("Generate image — {n} credits", { n: AI_IMAGE_CREDITS[model] })
              : videoBusy
                ? t("Cancel")
                : t("Generate video — {n} credits", { n: AI_VIDEO_CREDITS_PER_GENERATION })}
          </button>

          {(() => {
            // Filtered to the currently-selected kind — an in-progress VIDEO generation used to sit
            // right in the middle of the IMAGE grid (and vice versa) with nothing distinguishing the
            // two, which read as one undifferentiated pile rather than two separate galleries. Switching
            // the Image/Video toggle above now genuinely switches which history you're looking at.
            const projectTiles: DisplayTile[] = aiGenerations
              .filter((g) => g.kind === kind)
              .map((g) => ({
                id: g.id,
                kind: g.kind,
                status: g.status,
                prompt: g.prompt,
                aspectRatio: g.aspectRatio,
                asset: g.asset,
                error: g.error,
                progress: g.progress,
              }));

            // Every OTHER project's own past generation of this kind, newest first — same account-wide
            // reuse `MediaLibrary.tsx`'s own "All my media" view offers, pre-filtered to items that
            // actually carry `aiGeneration` (an upload or stock download never does). `previewAssetFrom
            // LibraryMedia` gives each one just enough shape to render a thumbnail; `libraryItem` (not
            // set on `projectTiles` above) is what tells `pickTile` this one needs
            // `addLibraryAssetToProject` before it can be placed.
            const libraryTiles: DisplayTile[] = (library.items ?? [])
              .filter((item): item is LibraryMediaItem & { aiGeneration: NonNullable<LibraryMediaItem["aiGeneration"]> } =>
                item.kind === kind && Boolean(item.aiGeneration)
              )
              .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
              .map((item) => ({
                id: item.id,
                kind: item.kind as "image" | "video",
                status: "done",
                prompt: item.aiGeneration.prompt,
                aspectRatio: item.aiGeneration.aspectRatio as AiAspectRatio,
                asset: previewAssetFromLibraryMedia(item),
                libraryItem: item,
              }));

            const visible = isLibraryView ? libraryTiles : projectTiles;

            return (
              <>
                {/* Hosted-only: local/desktop dev has no per-user "account" for a cross-project
                    generation history to belong to at all — every generation stays project-local there
                    exactly as before this existed. Shown even when `visible` is empty so the toggle
                    itself stays discoverable regardless of which view currently has anything in it. */}
                {hosted && (
                  <div className="mt-3 flex shrink-0 gap-1">
                    <button
                      onClick={() => setIsLibraryView(false)}
                      className={`rounded px-2 py-1 text-[11px] font-medium transition ${!isLibraryView ? "bg-white/15 text-white" : "text-white/50 hover:text-white/80"}`}
                    >
                      {t("This project")}
                    </button>
                    <button
                      onClick={() => setIsLibraryView(true)}
                      className={`rounded px-2 py-1 text-[11px] font-medium transition ${isLibraryView ? "bg-white/15 text-white" : "text-white/50 hover:text-white/80"}`}
                    >
                      {t("All my generations")}
                    </button>
                  </div>
                )}
                {isLibraryView && library.loading && library.items === null && (
                  <p className="mt-3 text-[12px] text-white/35">{t("Loading…")}</p>
                )}
                {visible.length > 0 && (
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
                    // A single click picks the result — one step, not two, same reasoning
                    // `StockSearchPanel.tsx`'s own `handlePick` documents, via the shared `pickTile`
                    // (see its own doc comment for the extra step a library-sourced tile needs first).
                    // Used to be double-click-only on desktop (a plain click did nothing there at all)
                    // — that extra step no longer buys anything now that this is the ONLY place a
                    // generation is visible to click on in the first place (see `aiGenerations`'s own
                    // doc comment).
                    onClick={item.status === "done" && item.asset ? () => pickTile(item) : undefined}
                    onKeyDown={
                      item.status === "done" && item.asset
                        ? (e) => {
                            if (e.key === "Enter") pickTile(item);
                          }
                        : undefined
                    }
                    title={
                      item.status === "done"
                        ? `${item.prompt}\n${onAssetAdded ? t("Tap to pick, then place it at the playhead") : t("Click to add at the playhead")}`
                        : item.prompt
                    }
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
                    {/* No `max-h-*` cap here (there used to be one) — VCut is a vertical-video editor
                        first, so 9:16 is the COMMON case, not the outlier: at this grid's typical
                        column widths a 9:16 box needs 350-450px of height, comfortably past any cap
                        that once seemed generous. `aspect-ratio` alone can't win a fight against
                        `max-height` (the box just gets clipped short instead, silently re-cropping the
                        exact thing this tile is trying to show honestly), so capping height at all
                        defeats the "real aspect ratio" requirement for the majority of results. The
                        masonry grid these tiles sit in is built to carry uneven column heights. */}
                    <div
                      className="relative w-full overflow-hidden bg-black"
                      style={{
                        // The REAL dimensions once the asset exists — same "true aspect ratio, not a
                        // forced crop" treatment `StockSearchPanel.tsx`/`MediaLibrary.tsx` both already
                        // give their own tiles — falling back to the REQUESTED ratio (`item.aspectRatio`)
                        // while still generating/failed, when there's no real asset to measure yet. The
                        // two usually agree, but a provider is free to return something slightly off
                        // its own requested ratio (rounding, a model-specific default it silently
                        // preferred instead), and the real file is what actually gets exported either
                        // way — a tile that quietly disagreed with its own thumbnail would be confusing.
                        aspectRatio:
                          item.status === "done" && item.asset?.width && item.asset.height
                            ? `${item.asset.width} / ${item.asset.height}`
                            : cssAspectRatio(item.aspectRatio),
                      }}
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
                )}
              </>
            );
          })()}
        </>
      )}
    </div>
  );
}
