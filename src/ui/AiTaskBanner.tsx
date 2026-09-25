"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "../i18n/useTranslation.ts";
import { useEditorStore } from "../store/editorStore.ts";

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Always-visible progress for the long AI jobs (Auto Cutout, Text Behind Subject). They run for a minute or two, and a
 *  status line that disappears after a few seconds left people unsure anything was happening — so they started the
 *  tool again and got duplicates. While a job runs this shows what it's doing with a live timer; when it ends the result
 *  stays until dismissed (failures) or for a few seconds (success). Leaving the page mid-job asks first. */
export function AiTaskBanner() {
  const t = useTranslation();
  const tasks = useEditorStore((s) => s.aiTasks);
  const notice = useEditorStore((s) => s.aiTaskNotice);
  const dismiss = useEditorStore((s) => s.dismissAiTaskNotice);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (tasks.length === 0) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      clearInterval(timer);
      window.removeEventListener("beforeunload", warn);
    };
  }, [tasks.length]);

  if (typeof document === "undefined" || (tasks.length === 0 && !notice)) return null;
  const task = tasks[0];

  return createPortal(
    <div
      className="pointer-events-none fixed inset-x-0 z-[70] flex justify-center px-3"
      style={{ top: "calc(0.75rem + env(safe-area-inset-top))" }}
      role="status"
      aria-live="polite"
    >
      <div className="pointer-events-auto w-full max-w-md overflow-hidden rounded-xl border border-white/10 bg-[#14161c]/95 shadow-2xl backdrop-blur">
        {task ? (
          <div className="p-3">
            <div className="flex items-center gap-3">
              <div className="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-sky-400 border-t-transparent" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium text-white">{task.label}</p>
                <p className="text-[11px] text-white/50">
                  {t("Usually 1–2 minutes. Keep this page open.")}
                  {tasks.length > 1 ? ` · ${t("{n} running", { n: tasks.length })}` : ""}
                </p>
              </div>
              <span className="shrink-0 font-mono text-[12px] tabular-nums text-white/70">{formatElapsed(now - task.startedAt)}</span>
            </div>
            <div className="mt-2.5 h-1 w-full overflow-hidden rounded-full bg-white/10">
              <div className="h-full w-1/3 animate-[vcutSlide_1.4s_ease-in-out_infinite] rounded-full bg-sky-400" />
            </div>
          </div>
        ) : notice ? (
          <div className="flex items-start gap-3 p-3">
            <span
              className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
                notice.tone === "success" ? "bg-emerald-400/20 text-emerald-300" : "bg-rose-400/20 text-rose-300"
              }`}
            >
              {notice.tone === "success" ? "✓" : "!"}
            </span>
            <p className={`min-w-0 flex-1 text-[13px] leading-snug ${notice.tone === "success" ? "text-white" : "text-rose-100"}`}>{notice.text}</p>
            <button type="button" onClick={dismiss} className="shrink-0 rounded-md px-2 py-1 text-[12px] text-white/60 transition hover:bg-white/10 hover:text-white">
              {t("Dismiss")}
            </button>
          </div>
        ) : null}
      </div>
      <style>{`@keyframes vcutSlide{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}`}</style>
    </div>,
    document.body
  );
}
