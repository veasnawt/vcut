"use client";

import { createContext, useContext, type CSSProperties } from "react";
import { Close } from "@veasnawt/vicons";
import { useTranslation } from "../i18n/useTranslation.ts";

/** The existing Media column doubles as the home for toolbar-opened tools in desktop Left mode. */
export const ToolPanelDockContext = createContext<HTMLElement | null>(null);

export function useToolPanelDock(anchor?: HTMLElement | null): HTMLElement | null {
  const target = useContext(ToolPanelDockContext);
  if (!target || !anchor) return null;
  if (anchor.hasAttribute("data-vcut-context-anchor") || !anchor.closest(".vcut-toolbar")) return null;
  return target;
}

export function useToolPanelFrameDock(): HTMLElement | null {
  return useContext(ToolPanelDockContext);
}

export function PickerPanelHeader({ title, onClose }: { title: string; onClose: () => void }) {
  const t = useTranslation();
  return (
    <div className="sticky top-0 z-20 mb-2 flex shrink-0 items-center justify-between gap-2 border-b border-white/10 bg-inherit pb-2">
      <span className="truncate text-xs font-semibold text-white/90">{title}</span>
      <button type="button" onClick={onClose} aria-label={t("Close")} title={t("Close")} className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-white/55 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300">
        <Close size={14} />
      </button>
    </div>
  );
}

/** Overrides the bottom-toolbar popover coordinates without changing its contents or actions. */
export const DOCKED_PICKER_STYLE: CSSProperties = {
  position: "static",
  top: "auto",
  right: "auto",
  bottom: "auto",
  left: "auto",
  width: "100%",
  maxWidth: "none",
  maxHeight: "100%",
  height: "100%",
  overflowY: "auto",
  border: 0,
  borderRadius: 0,
  boxShadow: "none",
};
