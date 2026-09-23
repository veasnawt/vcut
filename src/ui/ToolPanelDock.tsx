"use client";

import { createContext, useContext, type CSSProperties } from "react";

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
