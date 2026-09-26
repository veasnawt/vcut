"use client";

import { useState } from "react";
import { startCheckout } from "../api/billing.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import { templateAiSummary } from "../project/aiRecipe.ts";
import { pendingTemplateAiTasks, type TemplateAiTask } from "../project/template.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { useHostedCreditsGate } from "./useHostedCreditsGate.ts";

type Phase = "review" | "running" | "failed";

/** The step between "every slot is filled" and the preview, for a template whose author used AI tools (a cutout, an AI
 *  edit, an object removal): it shows what will be run on the user's own media and roughly what it costs, runs each
 *  step, and — if one fails — lets the user choose instead of silently continuing:
 *   - Try again (a failed step is refunded, so this only costs a new attempt),
 *   - Use the original clip (skip that clip's AI effect and carry on; an extra layer that only makes sense on top of the
 *     raw footage is dropped rather than covering it),
 *   - Stop (nothing is lost — the user can change their pick or go back).
 *  Also the Pro gate: AI templates need Pro, and the credits balance is checked up front. */
export function TemplateAiRunDialog({ onDone, onStop }: { onDone: () => void; onStop: () => void }) {
  const t = useTranslation();
  const project = useEditorStore((s) => s.project);
  const runStep = useEditorStore((s) => s.runTemplateAiStep);
  const skipSteps = useEditorStore((s) => s.skipTemplateAiSteps);
  const { hosted, credits, isPro } = useHostedCreditsGate();

  const [phase, setPhase] = useState<Phase>("review");
  const [current, setCurrent] = useState<TemplateAiTask | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [doneCount, setDoneCount] = useState(0);

  if (!project) return null;
  const tasks = pendingTemplateAiTasks(project);
  const summary = templateAiSummary(project.sequence.tracks, project.assets);
  const needsPro = hosted && credits !== null && !isPro;
  const notEnough = hosted && credits !== null && credits.creditsRemaining < summary.credits;

  /** Runs every pending step in order, stopping at the first failure so the user can choose what happens next. */
  async function runAll() {
    setPhase("running");
    setError(null);
    for (let guard = 0; guard < 50; guard++) {
      const next = pendingTemplateAiTasks(useEditorStore.getState().project!)[0];
      if (!next) {
        onDone();
        return;
      }
      setCurrent(next);
      const result = await runStep(next.clipId);
      if (!result.ok) {
        setError(result.error);
        setPhase("failed");
        return;
      }
      setDoneCount((n) => n + 1);
    }
    onDone();
  }

  function keepOriginal() {
    if (current) skipSteps(current.clipId);
    if (pendingTemplateAiTasks(useEditorStore.getState().project!).length === 0) onDone();
    else void runAll();
  }

  function skipAll() {
    for (const task of pendingTemplateAiTasks(useEditorStore.getState().project!)) skipSteps(task.clipId);
    onDone();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-3 sm:items-center"
      role="dialog"
      aria-modal="true"
      // This used to be the only fixed-backdrop dialog in the app without this: it only ever rendered
      // from `TemplateFillScreen.tsx`, a plain full-screen view with no ancestor of its own that closes
      // on a stray click, so a bare click bubbling past it was harmless there. `ImportTemplateDialog.tsx`
      // now also renders this (the in-editor "Templates" tool's own AI-effects gate), nested inside ITS
      // OWN backdrop, which DOES close on any click (`onClick={onClose}`) — without this, clicking "Run
      // AI effects" (or anything else in here) bubbled straight up and closed the whole Templates dialog
      // the instant it was clicked. The AI run itself kept going regardless (`runTemplateAiStep` is a
      // store action, not tied to this component staying mounted), so nothing actually broke — but its
      // own "Applying AI effects…" progress UI vanished immediately, making a real, multi-minute
      // in-progress run look like nothing had happened at all: a real, reported "it's not working"
      // complaint that was actually just "it's running invisibly."
      onClick={(e) => e.stopPropagation()}
    >
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#14161c] p-4 shadow-2xl">
        {phase === "review" && (
          <>
            <div className="flex items-center gap-2">
              <h2 className="text-[15px] font-semibold text-white">{t("This template uses AI effects")}</h2>
              <span className="rounded-sm bg-amber-400 px-1.5 text-[10px] font-bold leading-[1.5] text-black">PRO</span>
            </div>
            <p className="mt-1 text-[12px] leading-relaxed text-white/55">
              {t("The same AI steps the creator used will now run on your own media.")}
            </p>
            <ul className="mt-3 space-y-1.5">
              {tasks.map((task) => (
                <li key={task.clipId} className="flex items-center justify-between gap-3 rounded-lg bg-white/[0.04] px-3 py-2 text-[12px]">
                  <span className="min-w-0">
                    <span className="block truncate text-white/85">{t(task.label)}</span>
                    <span className="block truncate text-[11px] text-white/40">{task.assetName}</span>
                  </span>
                  <span className="shrink-0 text-[11px] text-white/50">{t("~{n} credits", { n: task.credits })}</span>
                </li>
              ))}
            </ul>
            <div className="mt-3 flex items-center justify-between rounded-lg border border-white/10 px-3 py-2 text-[12px]">
              <span className="text-white/60">{t("Estimated total")}</span>
              <span className="font-semibold text-white">{t("~{n} credits", { n: summary.credits })}</span>
            </div>
            {hosted && credits !== null && (
              <p className="mt-1.5 px-1 text-[11px] text-white/40">{t("You have {n} credits", { n: credits.creditsRemaining })}</p>
            )}
            {needsPro && (
              <p className="mt-2 rounded-md bg-amber-300/[0.08] px-2.5 py-2 text-[12px] text-amber-200">
                {t("Templates with AI effects need a Pro plan.")}
              </p>
            )}
            {!needsPro && notEnough && (
              <p className="mt-2 rounded-md bg-amber-300/[0.08] px-2.5 py-2 text-[12px] text-amber-200">
                {t("You don't have enough credits for every step. You can still use your own clips without the AI effects.")}
              </p>
            )}
            <div className="mt-4 flex flex-col gap-2">
              {needsPro ? (
                <button
                  type="button"
                  onClick={() => void startCheckout().then((url) => (window.location.href = url)).catch(() => {})}
                  className="rounded-lg bg-sky-500 py-2.5 text-[13px] font-semibold text-white transition hover:bg-sky-400"
                >
                  {t("Upgrade to Pro")}
                </button>
              ) : (
                <button
                  type="button"
                  disabled={notEnough}
                  onClick={() => void runAll()}
                  className="rounded-lg bg-sky-500 py-2.5 text-[13px] font-semibold text-white transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-white/30"
                >
                  {t("Run AI effects")}
                </button>
              )}
              <button type="button" onClick={skipAll} className="rounded-lg bg-white/5 py-2.5 text-[13px] text-white/75 transition hover:bg-white/10">
                {t("Use my clips without AI effects")}
              </button>
              <button type="button" onClick={onStop} className="py-1.5 text-[12px] text-white/45 transition hover:text-white/75">
                {t("Not now")}
              </button>
            </div>
          </>
        )}

        {phase === "running" && current && (
          <>
            <h2 className="text-[15px] font-semibold text-white">{t("Applying AI effects…")}</h2>
            <p className="mt-2 text-[13px] text-white/80">{t(current.label)}</p>
            <p className="text-[11px] text-white/40">{current.assetName}</p>
            <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
              <div className="h-full animate-pulse rounded-full bg-sky-400" style={{ width: `${Math.round(((doneCount + 0.4) / Math.max(1, doneCount + tasks.length)) * 100)}%` }} />
            </div>
            <p className="mt-2 text-[11px] text-white/40">{t("This can take a minute or two. Keep this open.")}</p>
          </>
        )}

        {phase === "failed" && current && (
          <>
            <h2 className="text-[15px] font-semibold text-white">{t("That AI effect didn't work")}</h2>
            <p className="mt-1 text-[12px] text-white/60">
              {t(current.label)} — {current.assetName}
            </p>
            <p className="mt-2 rounded-md bg-rose-400/10 px-2.5 py-2 text-[12px] leading-relaxed text-rose-200">{error}</p>
            <p className="mt-2 text-[11px] text-white/40">{t("You weren't charged for the failed step.")}</p>
            <div className="mt-4 flex flex-col gap-2">
              <button type="button" onClick={() => void runAll()} className="rounded-lg bg-sky-500 py-2.5 text-[13px] font-semibold text-white transition hover:bg-sky-400">
                {t("Try again")}
              </button>
              <button type="button" onClick={keepOriginal} className="rounded-lg bg-white/5 py-2.5 text-[13px] text-white/80 transition hover:bg-white/10">
                {t("Use the original clip")}
              </button>
              <button type="button" onClick={onStop} className="py-1.5 text-[12px] text-white/45 transition hover:text-white/75">
                {t("Stop for now")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
