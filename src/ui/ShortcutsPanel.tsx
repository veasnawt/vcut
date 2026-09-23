"use client";

import { useEffect } from "react";
import { useTranslation } from "../i18n/useTranslation.ts";
import { ToolPanelFrame } from "./ToolPanelFrame.tsx";

const SHORTCUT_GROUPS = [
  {
    title: "Playback and navigation",
    shortcuts: [
      ["Play / pause", "Space"],
      ["Previous / next frame", "← / →"],
      ["Jump 10 frames", "Shift + ← / →"],
      ["Go to start", "Home"],
    ],
  },
  {
    title: "Editing",
    shortcuts: [
      ["Split at playhead", "S"],
      ["Duplicate selected clips", "Ctrl/⌘ + D"],
      ["Delete selected clips", "Delete / Backspace"],
      ["Undo", "Ctrl/⌘ + Z"],
      ["Redo", "Ctrl/⌘ + Shift + Z"],
      ["Redo (alternate)", "Ctrl/⌘ + Y"],
    ],
  },
  {
    title: "Timeline and export",
    shortcuts: [
      ["Zoom in", "Ctrl/⌘ + +"],
      ["Zoom out", "Ctrl/⌘ + −"],
      ["Reset zoom", "Ctrl/⌘ + 0"],
      ["Zoom at cursor", "Ctrl/⌘ + wheel"],
      ["Set export in", "I"],
      ["Set export out", "O"],
      ["Clear export range", "Shift + X"],
      ["Save project", "Ctrl/⌘ + S"],
    ],
  },
] as const;

export function ShortcutsPanel({ onClose }: { onClose: () => void }) {
  const t = useTranslation();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <ToolPanelFrame ariaLabel={t("Keyboard shortcuts")} onClose={onClose} size="compact">
      <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-3">
        <h2 className="text-sm font-semibold text-white">{t("Keyboard shortcuts")}</h2>
        <button type="button" onClick={onClose} aria-label={t("Close")} className="rounded p-1 text-white/50 hover:bg-white/10 hover:text-white">×</button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {SHORTCUT_GROUPS.map((group) => (
          <section key={group.title} className="mb-6 last:mb-0">
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-white/45">{t(group.title)}</h3>
            <div className="divide-y divide-white/5 rounded-lg border border-white/10 bg-white/[0.02] px-3">
              {group.shortcuts.map(([label, keys]) => (
                <div key={label} className="flex min-h-10 items-center justify-between gap-3 py-2 text-xs">
                  <span className="text-white/75">{t(label)}</span>
                  <kbd className="shrink-0 rounded border border-white/10 bg-white/[0.06] px-2 py-1 font-mono text-[11px] text-white/70">{keys}</kbd>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </ToolPanelFrame>
  );
}
