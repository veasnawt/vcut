"use client";

import { useEffect, useRef, useState } from "react";
import { Ai, Close, Refresh } from "@veasnawt/vicons";
import { mediaUrl, thumbnailUrl } from "../api/client.ts";
import { ReplaceClipAssetCommand, SwapClipAssetCommand } from "../commands/index.ts";
import {
  AI_EDIT_CATEGORIES,
  AI_EDIT_DEFAULT_CREATIVITY,
  AI_EDIT_IMAGE_CREDITS,
  AI_EDIT_QUICK_STYLES,
  AI_EDIT_VIDEO_MAX_SECONDS,
  AI_EDIT_VIDEO_MIN_SECONDS,
  aiEditVideoCredits,
  enhancePrompt,
  promptHasPhrase,
  surprisePrompt,
  togglePhrase,
  type AiEditPreserve,
  type AiEditTemplate,
} from "../project/aiEdit.ts";
import { findAsset, findClip } from "../project/createProject.ts";
import type { Asset } from "../project/types.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import { AiEditTemplateGallery } from "./AiEditTemplateGallery.tsx";
import { useHostedCreditsGate } from "./useHostedCreditsGate.ts";
import { ToolPanelFrame } from "./ToolPanelFrame.tsx";

const PRESERVE_OPTIONS: { key: AiEditPreserve; label: string; hint: string }[] = [
  { key: "face", label: "Face", hint: "Same person" },
  { key: "pose", label: "Pose", hint: "Same framing" },
  { key: "outfit", label: "Outfit", hint: "Same clothes" },
  { key: "background", label: "Background", hint: "Same scene" },
];

function creativityLabel(value: number): string {
  return value <= 25 ? "Faithful" : value >= 76 ? "Imaginative" : "Balanced";
}

const chipBase = "min-h-9 rounded-full border px-3 text-xs font-medium transition active:scale-[0.97]";

export function AiEditModal({ clipId, onClose }: { clipId: string; onClose: () => void }) {
  const t = useTranslation();
  const projectId = useEditorStore((s) => s.projectId);
  const project = useEditorStore((s) => s.project);
  const run = useEditorStore((s) => s.run);
  const addAssetAtPlayhead = useEditorStore((s) => s.addAssetAtPlayhead);
  const runAiEdit = useEditorStore((s) => s.runAiEdit);
  const startAiVideoEdit = useEditorStore((s) => s.startAiVideoEdit);
  const setStatus = useEditorStore((s) => s.setStatus);
  const { credits, outOfCredits } = useHostedCreditsGate();

  const [prompt, setPrompt] = useState("");
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [preserve, setPreserve] = useState<AiEditPreserve[]>([]);
  const [creativity, setCreativity] = useState(AI_EDIT_DEFAULT_CREATIVITY);
  const [editMode, setEditMode] = useState<"clip" | "frame">("clip");
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [generatedAsset, setGeneratedAsset] = useState<Asset | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"result" | "original">("result");
  const jobRef = useRef<{ cancel: () => void } | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);

  const clip = project ? findClip(project, clipId)?.clip : undefined;
  const asset = project && clip ? findAsset(project, clip.assetId) : undefined;
  const isVideo = asset?.kind === "video";
  const clipSeconds = clip ? clip.sourceOut - clip.sourceIn : 0;
  const clipEditable = isVideo && clipSeconds >= AI_EDIT_VIDEO_MIN_SECONDS - 0.05 && clipSeconds <= AI_EDIT_VIDEO_MAX_SECONDS + 0.05;
  // A clip too long or too short for a video edit still gets a frame edit.
  const mode: "clip" | "frame" = isVideo && clipEditable && editMode === "clip" ? "clip" : "frame";
  const cost = mode === "clip" ? aiEditVideoCredits(clipSeconds) : AI_EDIT_IMAGE_CREDITS;
  const remaining = credits?.creditsRemaining ?? null;
  const notEnough = remaining !== null && remaining < cost;

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !generating) onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, generating]);

  if (!project || !projectId || !clip || !asset) return null;

  const library = Boolean(asset.libraryMediaId);
  const originalUrl = mediaUrl(projectId, asset.relPath, library);
  const stillUrl = isVideo ? thumbnailUrl(projectId, asset) : originalUrl;
  const resultUrl = generatedAsset ? mediaUrl(projectId, generatedAsset.relPath, Boolean(generatedAsset.libraryMediaId)) : null;
  const options = { preserve, creativity };

  function setPromptText(next: string) {
    setPrompt(next);
    setTemplateId(null);
  }

  function pickTemplate(template: AiEditTemplate) {
    setPrompt(template.prompt);
    setTemplateId(template.id);
    // A finger on a phone has just tapped a card: bring the prompt (now filled) back into view, without opening the keyboard.
    promptRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function togglePreserve(key: AiEditPreserve) {
    setPreserve((current) => (current.includes(key) ? current.filter((k) => k !== key) : [...current, key]));
  }

  async function handleGenerate() {
    if (!projectId || !prompt.trim() || generating) return;
    setGenerating(true);
    setProgress(0);
    setError(null);
    try {
      let result: Asset;
      if (mode === "clip") {
        const job = startAiVideoEdit(clipId, prompt.trim(), options, setProgress);
        jobRef.current = job;
        result = await job.done;
      } else {
        result = await runAiEdit(clipId, prompt.trim(), options);
      }
      setGeneratedAsset(result);
      setViewMode("result");
      setStatus(t("AI Edit completed!"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("AI Edit failed"));
    } finally {
      jobRef.current = null;
      setGenerating(false);
    }
  }

  function handleApplyToClip() {
    if (!generatedAsset) return;
    run(generatedAsset.kind === "video" ? new ReplaceClipAssetCommand(clipId, generatedAsset) : new SwapClipAssetCommand(clipId, generatedAsset));
    setStatus(t("Applied AI Edit to clip"));
    onClose();
  }

  function handleAddAsNew() {
    if (!generatedAsset) return;
    addAssetAtPlayhead(generatedAsset.id);
    setStatus(t("Added AI edited asset to timeline"));
    onClose();
  }

  const showResult = viewMode === "result" && resultUrl && generatedAsset;
  const creditLine = `${cost} ${t("credits")}${remaining !== null ? ` · ${remaining} ${t("remaining")}` : ""}`;

  return (
    <ToolPanelFrame ariaLabel={t("AI Edit")} onClose={onClose} canClose={!generating} size="wide">
      <>
        <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-tr from-purple-500/20 to-sky-500/20 text-sky-400">
              <Ai size={18} />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-white">{t("AI Edit")}</h2>
              <p className="truncate text-[11px] text-white/50">{t("Transform anything in your image or video with text")}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={generating}
            aria-label={t("Close")}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-white/50 transition hover:bg-white/10 hover:text-white disabled:opacity-30"
          >
            <Close size={16} />
          </button>
        </div>

        <div className="scrollbar-none min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-4 py-4">
          {/* 1. Preview */}
          <div className="space-y-2">
            <div className="relative flex h-[24dvh] max-h-60 min-h-36 w-full items-center justify-center overflow-hidden rounded-xl border border-white/10 bg-black/40 sm:h-[26dvh] sm:max-h-64">
              {showResult && generatedAsset.kind === "video" ? (
                <video key={resultUrl} src={resultUrl} controls loop muted autoPlay playsInline className="h-full w-full object-contain" />
              ) : showResult ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={resultUrl} alt={t("AI Edit")} className="h-full w-full object-contain" />
              ) : isVideo && !generating ? (
                <video key={originalUrl} src={`${originalUrl}#t=${clip.sourceIn},${clip.sourceOut}`} poster={stillUrl ?? undefined} controls muted playsInline preload="metadata" className="h-full w-full object-contain" />
              ) : stillUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={stillUrl} alt={asset.name} className="h-full w-full object-contain" />
              ) : null}

              {generatedAsset && !generating && (
                <div className="absolute left-2.5 top-2.5 flex rounded-lg border border-white/10 bg-black/60 p-0.5 backdrop-blur-sm">
                  {(["original", "result"] as const).map((mode) => (
                    <button
                      key={mode}
                      onClick={() => setViewMode(mode)}
                      className={`min-h-8 rounded-md px-3 text-[11px] font-medium transition ${
                        viewMode === mode ? (mode === "result" ? "bg-sky-500 font-semibold text-white" : "bg-white font-semibold text-black") : "text-white/70 hover:text-white"
                      }`}
                    >
                      {mode === "original" ? t("Original") : t("AI Edit")}
                    </button>
                  ))}
                </div>
              )}

              {generating && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70 px-6 text-center backdrop-blur-sm">
                  <div className="h-8 w-8 animate-spin rounded-full border-2 border-sky-400 border-t-transparent" />
                  <span className="text-xs font-medium text-white">{mode === "clip" ? t("Editing your clip...") : t("Applying AI Edit...")}</span>
                  {mode === "clip" && (
                    <>
                      <div className="h-1.5 w-full max-w-56 overflow-hidden rounded-full bg-white/15">
                        <div className="h-full rounded-full bg-sky-400 transition-[width] duration-500" style={{ width: `${Math.max(4, Math.round(progress * 100))}%` }} />
                      </div>
                      <span className="text-[11px] text-white/60">{t("Usually 1–3 minutes. Keep this open.")}</span>
                      <button
                        type="button"
                        onClick={() => jobRef.current?.cancel()}
                        className="min-h-9 rounded-lg border border-white/15 px-4 text-xs text-white/80 hover:bg-white/10"
                      >
                        {t("Cancel")}
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>

            {isVideo && (
              <div className="flex items-center justify-between gap-3">
                <div className="flex rounded-lg border border-white/10 bg-white/5 p-0.5 text-xs" role="tablist" aria-label={t("What to edit")}>
                  {(["clip", "frame"] as const).map((m) => (
                    <button
                      key={m}
                      role="tab"
                      aria-selected={mode === m}
                      disabled={m === "clip" && !clipEditable}
                      onClick={() => setEditMode(m)}
                      className={`min-h-9 rounded-md px-3 font-medium transition disabled:opacity-35 ${mode === m ? "bg-sky-500 text-white" : "text-white/65 hover:text-white"}`}
                    >
                      {m === "clip" ? t("Whole clip") : t("Current frame")}
                    </button>
                  ))}
                </div>
                {!clipEditable && (
                  <span className="text-[11px] leading-tight text-amber-300/90">
                    {clipSeconds > AI_EDIT_VIDEO_MAX_SECONDS ? t("Clips up to {seconds} s can be edited as video", { seconds: AI_EDIT_VIDEO_MAX_SECONDS }) : t("Clip is too short to edit as video")}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* 2. Prompt + helper actions */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label htmlFor="ai-edit-prompt" className="text-xs font-semibold text-white/80">
                {t("What do you want to change?")}
              </label>
              <span className="text-[10px] text-white/40">{t("Be specific for best results")}</span>
            </div>
            <textarea
              id="ai-edit-prompt"
              ref={promptRef}
              rows={2}
              value={prompt}
              onChange={(e) => setPromptText(e.target.value)}
              placeholder={t("e.g. 'Turn into anime style', 'Add fireworks in the sky', 'Change hair to blue'...")}
              className="min-h-[4.5rem] w-full resize-none rounded-xl border border-white/10 bg-white/5 p-3 text-[16px] leading-snug text-white placeholder-white/40 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 sm:text-sm"
            />
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                disabled={!prompt.trim()}
                onClick={() => setPromptText(enhancePrompt(prompt, options))}
                className={`${chipBase} border-sky-400/40 bg-sky-500/10 text-sky-200 disabled:opacity-35`}
              >
                ✦ {t("Enhance Prompt")}
              </button>
              <button type="button" onClick={() => pickPrompt(surprisePrompt(prompt))} className={`${chipBase} border-white/10 bg-white/[0.04] text-white/75 hover:text-white`}>
                🎲 {t("Surprise Me")}
              </button>
              <button
                type="button"
                disabled={!prompt}
                onClick={() => {
                  setPromptText("");
                  promptRef.current?.focus();
                }}
                className={`${chipBase} border-white/10 bg-white/[0.04] text-white/60 hover:text-white disabled:opacity-35`}
              >
                {t("Clear")}
              </button>
            </div>
          </div>

          {/* 3. Templates */}
          <AiEditTemplateGallery imageUrl={stillUrl} selectedId={templateId} onPick={pickTemplate} />

          {/* 4. Quick styles */}
          <section className="space-y-2" aria-label={t("Quick Styles")}>
            <h3 className="text-xs font-semibold text-white/80">{t("Quick Styles")}</h3>
            <div className="scrollbar-none -mx-4 flex gap-1.5 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:px-0">
              {AI_EDIT_QUICK_STYLES.map((style) => {
                const on = promptHasPhrase(prompt, style.phrase);
                return (
                  <button
                    key={style.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setPromptText(togglePhrase(prompt, style.phrase))}
                    className={`${chipBase} shrink-0 ${on ? "border-sky-400 bg-sky-500/20 text-white" : "border-white/10 bg-white/[0.04] text-white/70 hover:text-white"}`}
                  >
                    {t(style.label)}
                  </button>
                );
              })}
            </div>
          </section>

          {/* 5. Preserve */}
          <section className="space-y-2" aria-label={t("Preserve")}>
            <div className="flex items-baseline justify-between">
              <h3 className="text-xs font-semibold text-white/80">{t("Preserve")}</h3>
              <span className="text-[10px] text-white/40">{t("Keep these as they are")}</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {PRESERVE_OPTIONS.map((option) => {
                const on = preserve.includes(option.key);
                return (
                  <button
                    key={option.key}
                    type="button"
                    role="switch"
                    aria-checked={on}
                    onClick={() => togglePreserve(option.key)}
                    className={`flex min-h-12 items-center justify-between gap-2 rounded-xl border px-3 text-left transition active:scale-[0.98] ${
                      on ? "border-sky-400 bg-sky-500/15" : "border-white/10 bg-white/[0.04] hover:border-white/25"
                    }`}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-semibold text-white">{t(option.label)}</span>
                      <span className="block truncate text-[10px] text-white/45">{t(option.hint)}</span>
                    </span>
                    <span className={`relative h-5 w-9 shrink-0 rounded-full transition ${on ? "bg-sky-500" : "bg-white/20"}`} aria-hidden>
                      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${on ? "left-[1.125rem]" : "left-0.5"}`} />
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          {/* 6. Creativity */}
          <section className="space-y-1" aria-label={t("Creativity")}>
            <div className="flex items-baseline justify-between">
              <h3 className="text-xs font-semibold text-white/80">{t("Creativity")}</h3>
              <span className="text-[11px] font-medium text-sky-300">{t(creativityLabel(creativity))}</span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={creativity}
              onChange={(e) => setCreativity(Number(e.target.value))}
              aria-label={t("Creativity")}
              aria-valuetext={t(creativityLabel(creativity))}
              className="h-11 w-full cursor-pointer accent-sky-400"
            />
            <div className="flex justify-between text-[10px] text-white/45">
              <span>{t("Faithful")}</span>
              <span>{t("Imaginative")}</span>
            </div>
          </section>

          {/* Kept clear of the sticky footer when the last section is scrolled into view. */}
          <div aria-hidden className="h-1" />
        </div>

        {/* 7. Sticky generate area */}
        <div className="shrink-0 space-y-2 border-t border-white/10 bg-[#0e1017] px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {error && <div className="rounded-lg border border-rose-500/20 bg-rose-500/10 p-2.5 text-xs text-rose-300">{error}</div>}
          {!error && (notEnough || outOfCredits) && (
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-200">
              {t("Not enough credits for this edit.")}
            </div>
          )}
          {generatedAsset ? (
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={handleApplyToClip}
                disabled={generating}
                className="col-span-2 min-h-11 rounded-xl bg-sky-500 px-4 text-sm font-semibold text-white shadow-md transition hover:bg-sky-400 disabled:opacity-40"
              >
                {t("Apply to Clip")}
              </button>
              <button
                onClick={handleAddAsNew}
                disabled={generating}
                className="min-h-11 rounded-xl border border-sky-500/40 bg-sky-500/15 px-3 text-xs font-medium text-sky-200 transition hover:bg-sky-500/25 disabled:opacity-40"
              >
                {t("Add as New Clip")}
              </button>
              <button
                onClick={handleGenerate}
                disabled={generating || !prompt.trim() || outOfCredits || notEnough}
                className="flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-3 text-xs text-white transition hover:bg-white/10 disabled:opacity-40"
              >
                <Refresh size={14} />
                <span className="truncate">
                  {t("Re-generate")} · {cost}
                </span>
              </button>
            </div>
          ) : (
            <button
              onClick={handleGenerate}
              disabled={generating || !prompt.trim() || outOfCredits || notEnough}
              className="flex min-h-12 w-full items-center justify-center gap-2.5 rounded-xl bg-gradient-to-r from-sky-500 to-indigo-500 px-4 py-1.5 text-white shadow-lg transition hover:from-sky-400 hover:to-indigo-400 disabled:opacity-40"
            >
              <Ai size={18} />
              <span className="flex min-w-0 flex-col items-start leading-tight">
                <span className="truncate text-sm font-semibold">{generating ? t("Generating...") : t("Generate AI Edit")}</span>
                {!generating && <span className="truncate text-[11px] font-normal text-white/80">{creditLine}</span>}
              </span>
            </button>
          )}
        </div>
      </>
    </ToolPanelFrame>
  );

  function pickPrompt(next: string) {
    setPromptText(next);
  }
}
