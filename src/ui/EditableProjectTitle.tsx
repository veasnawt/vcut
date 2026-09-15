"use client";

import { useRef, useState } from "react";
import { useTranslation } from "../i18n/useTranslation.ts";
import { useEditorStore } from "../store/editorStore.ts";

/** Click-to-rename project title, sitting in the header next to "VCut" in `VCutApp.tsx` — also reused,
 *  via `variant`, by the guided template flow's own screens (`TemplateFillScreen.tsx`/
 *  `TemplatePreviewScreen.tsx`), which have no such header of their own to sit inside; a project
 *  started from a template still owns a perfectly ordinary `name`, just with no normal editor chrome
 *  anywhere nearby to rename it from otherwise. Its own file (not left inside `VCutApp.tsx`, where it
 *  originated) specifically so the template screens can import it without a circular
 *  `VCutApp.tsx` <-> `TemplateFillScreen.tsx` dependency — `VCutApp.tsx` already imports
 *  `TemplateFillScreen.tsx` to render the guided flow at all.
 *
 *  `project.name` (not the `projectName` prop a host app like BP Studio passes in) is the only thing
 *  this reads or writes — that prop only ever SEEDS `project.name` at creation time (see `load`'s own
 *  comment), so once a project exists its name lives entirely in the project itself, and a rename here
 *  is exactly as durable/visible as any other edit (autosaved, and reflected back in VCut's own project
 *  list) regardless of which screen it was renamed from. */
export function EditableProjectTitle({ variant = "compact" }: { variant?: "compact" | "title" }) {
  const name = useEditorStore((s) => s.project?.name ?? "");
  const renameProject = useEditorStore((s) => s.renameProject);
  const t = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  // `variant: "title"` matches the bold, larger `<h1>` these template screens otherwise show in this
  // exact spot — the compact header chip's own small/dim styling would read as a demoted afterthought
  // sitting where a screen's own main heading normally goes.
  const inputClassName =
    variant === "title"
      ? "min-w-0 max-w-full flex-1 rounded bg-white/10 px-1.5 py-0.5 text-sm font-semibold text-white outline-none ring-1 ring-sky-400/60"
      : "min-w-0 max-w-[240px] flex-1 rounded bg-white/10 px-1.5 py-0.5 text-xs text-white outline-none ring-1 ring-sky-400/60";
  const buttonClassName =
    variant === "title"
      ? "min-w-0 max-w-full truncate rounded px-1.5 py-0.5 text-left text-sm font-semibold text-white transition hover:bg-white/10"
      : "min-w-0 max-w-[240px] flex-1 truncate rounded px-1.5 py-0.5 text-left text-xs text-white/35 transition hover:bg-white/10 hover:text-white/70";
  // Set right before an Escape-triggered exit, so the `onBlur` that follows (removing the input from
  // the DOM mid-focus fires one) knows to discard rather than commit — Escape means "cancel", not
  // "save whatever's currently typed". Same pattern TextTransformHandles.tsx uses for its own inline
  // text editor.
  const skipCommitRef = useRef(false);

  function startEditing() {
    setDraft(name);
    setEditing(true);
  }

  function commit() {
    if (skipCommitRef.current) {
      skipCommitRef.current = false;
      return;
    }
    setEditing(false);
    renameProject(draft);
  }

  if (editing) {
    return (
      <input
        ref={(el) => el?.focus()}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            skipCommitRef.current = true;
            setEditing(false);
          }
          // Enter commits, matching a single-line "done typing" expectation — a plain text input has
          // no newline to worry about swallowing the way the tap-to-edit text-clip textarea does.
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
        aria-label={t("Project name")}
        className={inputClassName}
      />
    );
  }

  return (
    <button onClick={startEditing} title={t("Rename project")} aria-label={t("Rename project")} className={buttonClassName}>
      {name}
    </button>
  );
}
