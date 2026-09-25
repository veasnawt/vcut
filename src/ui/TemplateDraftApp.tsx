"use client";

import { useEffect } from "react";
import { useTranslation } from "../i18n/useTranslation.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { startCheckout } from "../api/billing.ts";
import { TemplateFillScreen } from "./TemplateFillScreen.tsx";

interface TemplateDraftAppProps {
  templateId: string;
  /** Same as `VCutApp`'s own `onHome` — the fill screen's back arrow, left out where there's nowhere to go. */
  onHome?: () => void;
  /** The first pick created a real project — navigate the host to it (`VCutApp` with that id), where
   *  the pick is applied (see `EditorState.pendingTemplatePick`). */
  onProjectCreated: (projectId: string, name: string) => void;
}

/** "Use this template" before any project exists: the template's own fill screen, built in memory
 *  (`EditorState.loadTemplateDraft`) with nothing saved — asked for directly, so opening a template and
 *  backing out without picking any media leaves nothing behind. The real project is created by the
 *  first pick. Kept apart from `VCutApp`, which is built around a real, saved project from its first
 *  render (loading by id, its own guard against showing a project other than the one requested). */
export function TemplateDraftApp(props: TemplateDraftAppProps) {
  return (
    <ErrorBoundary>
      <TemplateDraftInner {...props} />
    </ErrorBoundary>
  );
}

function TemplateDraftInner({ templateId, onHome, onProjectCreated }: TemplateDraftAppProps) {
  const t = useTranslation();
  const loadTemplateDraft = useEditorStore((s) => s.loadTemplateDraft);
  const loading = useEditorStore((s) => s.loading);
  const loadError = useEditorStore((s) => s.loadError);
  const loadErrorStatus = useEditorStore((s) => s.loadErrorStatus);
  const project = useEditorStore((s) => s.project);
  const draftTemplateId = useEditorStore((s) => s.templateDraft?.templateId ?? null);
  const language = useEditorStore((s) => s.language);

  useEffect(() => {
    void loadTemplateDraft(templateId);
  }, [templateId, loadTemplateDraft]);

  // The store outlives page navigations, so until this draft's own load has started it can still hold
  // whatever was open before — never show that.
  const ready = draftTemplateId === templateId && !loading && project !== null;

  if (loadError && draftTemplateId === templateId) {
    const needsSignIn = loadErrorStatus === 401;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-[#0a0c10] p-6 text-center">
        <p className="text-sm font-medium text-amber-200/90">{t("VCut couldn't open this template")}</p>
        <p className="max-w-md text-xs leading-relaxed text-white/50">
          {needsSignIn ? t("Your session has expired — sign in again to continue.") : loadError}
        </p>
        <div className="flex items-center gap-2">
          {loadErrorStatus === 402 ? (
            <button
              onClick={() => void startCheckout().then((url) => (window.location.href = url)).catch(() => {})}
              className="rounded-md bg-sky-500 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-sky-400"
            >
              {t("Upgrade to Pro")}
            </button>
          ) : needsSignIn ? (
            <button
              onClick={() => (window.location.href = "/login")}
              className="rounded-md bg-sky-500 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-sky-400"
            >
              {t("Sign in")}
            </button>
          ) : (
            <button
              onClick={() => void loadTemplateDraft(templateId)}
              className="rounded-md bg-white/10 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-white/20"
            >
              {t("Try again")}
            </button>
          )}
          {onHome && (
            <button
              onClick={onHome}
              className="rounded-md px-3 py-1.5 text-xs font-medium text-white/60 transition hover:bg-white/10 hover:text-white"
            >
              {t("Back to projects")}
            </button>
          )}
        </div>
      </div>
    );
  }

  if (!ready) {
    return <div className="flex h-full items-center justify-center bg-[#0a0c10] text-xs text-white/40">{t("Opening VCut…")}</div>;
  }

  return (
    <div className={`h-full ${language === "km" ? "vcut-lang-km" : ""}`}>
      <TemplateFillScreen onAllFilled={() => {}} onBack={onHome} draft={{ onProjectCreated }} />
    </div>
  );
}
