"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Ai, Close, Refresh } from "@veasnawt/vicons";
import { mediaUrl } from "../api/client.ts";
import { SwapClipAssetCommand } from "../commands/index.ts";
import { findAsset, findClip } from "../project/createProject.ts";
import type { Asset, Clip } from "../project/types.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import { useHostedCreditsGate } from "./useHostedCreditsGate.ts";

const PROMPT_INSPIRATIONS = [
  { label: "🎨 Anime Watercolor", prompt: "turn into high quality Japanese anime watercolor illustration style" },
  { label: "🌆 Cyberpunk Neon", prompt: "change background to a futuristic cyberpunk city with vibrant neon lights" },
  { label: "🌅 Golden Hour", prompt: "make lighting warm dramatic golden hour sunset with soft lens flare" },
  { label: "❄️ Winter Snow", prompt: "add falling snow and cold winter frosted atmosphere" },
  { label: "🕶️ Sunglasses & Jacket", prompt: "add stylish black sunglasses and a cool leather jacket" },
  { label: "🖼️ Classic Oil Painting", prompt: "turn into an expressive classical Renaissance oil painting with rich textures" },
  { label: "🚀 Sci-Fi Hologram", prompt: "transform into a futuristic glowing blue sci-fi holographic projection" },
  { label: "🎞️ 1970s Vintage Film", prompt: "add 1970s vintage 35mm film grain, retro faded warm tones, and light leaks" },
  { label: "🌸 Cherry Blossoms", prompt: "add falling pink cherry blossom petals and springtime pastel mood" },
  { label: "⚡ Neon Glow", prompt: "outline subject with glowing electrical neon arcs and light streaks" },
];

export function AiEditModal({
  clipId,
  onClose,
}: {
  clipId: string;
  onClose: () => void;
}) {
  const t = useTranslation();
  const projectId = useEditorStore((s) => s.projectId);
  const project = useEditorStore((s) => s.project);
  const run = useEditorStore((s) => s.run);
  const addAssetAtPlayhead = useEditorStore((s) => s.addAssetAtPlayhead);
  const runAiEdit = useEditorStore((s) => s.runAiEdit);
  const setStatus = useEditorStore((s) => s.setStatus);
  const { credits, outOfCredits } = useHostedCreditsGate();

  const [prompt, setPrompt] = useState("");
  const [strength, setStrength] = useState<"subtle" | "balanced" | "creative">("balanced");
  const [generating, setGenerating] = useState(false);
  const [generatedAsset, setGeneratedAsset] = useState<Asset | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"result" | "original">("result");

  const clip = project ? findClip(project, clipId)?.clip : undefined;
  const asset = project && clip ? findAsset(project, clip.assetId) : undefined;

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !generating) onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, generating]);

  if (!project || !projectId || !clip || !asset) return null;

  const originalUrl = mediaUrl(projectId, asset.relPath, Boolean(asset.libraryMediaId));
  const resultUrl = generatedAsset ? mediaUrl(projectId, generatedAsset.relPath, Boolean(generatedAsset.libraryMediaId)) : null;

  async function handleGenerate() {
    if (!projectId || !prompt.trim() || generating) return;
    setGenerating(true);
    setError(null);
    try {
      if (!runAiEdit) {
        throw new Error(t("AI Edit is not available"));
      }
      const newAsset = await runAiEdit(clipId, prompt.trim(), strength);
      setGeneratedAsset(newAsset);
      setViewMode("result");
      setStatus(t("AI Edit completed!"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("AI Edit failed"));
    } finally {
      setGenerating(false);
    }
  }

  function handleApplyToClip() {
    if (!generatedAsset) return;
    run(new SwapClipAssetCommand(clipId, generatedAsset));
    setStatus(t("Applied AI Edit to clip"));
    onClose();
  }

  function handleAddAsNew() {
    if (!generatedAsset) return;
    addAssetAtPlayhead(generatedAsset.id);
    setStatus(t("Added AI edited asset to timeline"));
    onClose();
  }

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("AI Edit")}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-md"
      onClick={(e) => {
        if (e.target === e.currentTarget && !generating) onClose();
      }}
    >
      <div className="flex h-full max-h-[700px] w-full max-w-2xl flex-col rounded-2xl border border-white/10 bg-[#12151c] shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-tr from-purple-500/20 to-sky-500/20 text-sky-400">
              <Ai size={18} />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-white">{t("AI Edit")}</h2>
              <p className="text-[11px] text-white/50">{t("Transform anything in your image or video with text")}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={generating}
            aria-label={t("Close")}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-white/50 hover:bg-white/10 hover:text-white transition disabled:opacity-30"
          >
            <Close size={16} />
          </button>
        </div>

        {/* Content Body */}
        <div className="scrollbar-none min-h-0 flex-1 overflow-y-auto p-5 space-y-4">
          {/* Media Preview Box */}
          <div className="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-xl border border-white/10 bg-black/40">
            {viewMode === "result" && resultUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={resultUrl} alt="AI Edited result" className="h-full w-full object-contain" />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={originalUrl} alt={asset.name} className="h-full w-full object-contain" />
            )}

            {/* Before / After toggle pill if generated */}
            {generatedAsset && (
              <div className="absolute top-3 left-3 flex rounded-lg border border-white/10 bg-black/60 p-0.5 backdrop-blur-sm">
                <button
                  onClick={() => setViewMode("original")}
                  className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition ${
                    viewMode === "original" ? "bg-white text-black font-semibold shadow" : "text-white/70 hover:text-white"
                  }`}
                >
                  {t("Original")}
                </button>
                <button
                  onClick={() => setViewMode("result")}
                  className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition ${
                    viewMode === "result" ? "bg-sky-500 text-white font-semibold shadow" : "text-white/70 hover:text-white"
                  }`}
                >
                  {t("AI Edit")}
                </button>
              </div>
            )}

            {/* Loading Overlay */}
            {generating && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/60 backdrop-blur-sm">
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-sky-400 border-t-transparent" />
                <span className="text-xs font-medium text-white">{t("Applying AI Edit...")}</span>
              </div>
            )}
          </div>

          {/* Prompt Input */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-white/80">
                {t("What do you want to change?")}
              </label>
              <span className="text-[10px] text-white/40">{t("Be specific for best results")}</span>
            </div>
            <textarea
              rows={2}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={t("e.g. 'Turn into anime style', 'Add fireworks in the sky', 'Change hair to blue'...")}
              className="w-full rounded-xl border border-white/10 bg-white/5 p-3 text-xs text-white placeholder-white/40 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 resize-none"
            />
          </div>

          {/* Inspiration Chips */}
          <div className="space-y-1.5">
            <span className="text-[11px] font-medium text-white/50">{t("Prompt Ideas:")}</span>
            <div className="scrollbar-none flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
              {PROMPT_INSPIRATIONS.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  onClick={() => setPrompt(item.prompt)}
                  className="rounded-full border border-white/5 bg-white/[0.04] px-2.5 py-1 text-[11px] text-white/70 hover:border-sky-500/40 hover:bg-sky-500/10 hover:text-white transition"
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          {/* Strength Selection */}
          <div className="flex items-center justify-between border-t border-white/5 pt-3">
            <span className="text-xs text-white/70">{t("Transformation Strength:")}</span>
            <div className="flex rounded-lg border border-white/10 bg-white/5 p-0.5 text-xs">
              {(["subtle", "balanced", "creative"] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setStrength(s)}
                  className={`px-3 py-1 rounded-md capitalize transition ${
                    strength === s
                      ? "bg-sky-500 text-white font-medium shadow-sm"
                      : "text-white/60 hover:text-white"
                  }`}
                >
                  {t(s)}
                </button>
              ))}
            </div>
          </div>

          {error && (
            <div className="rounded-lg bg-rose-500/10 border border-rose-500/20 p-2.5 text-xs text-rose-300">
              {error}
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="flex items-center justify-between border-t border-white/10 px-5 py-3 bg-[#0e1017]">
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1 rounded-full bg-sky-500/20 px-2 py-0.5 text-[10px] font-semibold text-sky-300">
              ⚡ 6 {t("credits")}
            </span>
            {credits !== null && (
              <span className="text-[11px] text-white/40">
                ({credits.creditsRemaining} {t("available")})
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            {generatedAsset ? (
              <>
                <button
                  onClick={() => handleGenerate()}
                  disabled={generating || !prompt.trim()}
                  className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-white hover:bg-white/10 transition"
                >
                  <Refresh size={14} />
                  <span>{t("Re-generate")}</span>
                </button>
                <button
                  onClick={handleAddAsNew}
                  className="rounded-lg border border-sky-500/40 bg-sky-500/20 px-3 py-1.5 text-xs font-medium text-sky-200 hover:bg-sky-500/30 transition"
                >
                  {t("Add as New Clip")}
                </button>
                <button
                  onClick={handleApplyToClip}
                  className="rounded-lg bg-sky-500 px-4 py-1.5 text-xs font-semibold text-white shadow-md hover:bg-sky-400 transition"
                >
                  {t("Apply to Clip")}
                </button>
              </>
            ) : (
              <button
                onClick={handleGenerate}
                disabled={generating || !prompt.trim() || outOfCredits}
                className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-sky-500 to-indigo-500 px-5 py-2 text-xs font-semibold text-white shadow-lg hover:from-sky-400 hover:to-indigo-400 disabled:opacity-40 transition"
              >
                <Ai size={16} />
                <span>{generating ? t("Generating...") : t("Generate AI Edit")}</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

