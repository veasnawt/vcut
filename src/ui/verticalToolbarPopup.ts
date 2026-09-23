import type { CSSProperties } from "react";

/** Bottom-toolbar pickers retain their existing placement; rail pickers open beside the clicked tool. */
export function verticalToolbarPopupStyle(anchor: HTMLElement | null, width: number, expectedHeight = 420): CSSProperties {
  if (!anchor || anchor.hasAttribute("data-vcut-context-anchor") || !anchor.closest(".vcut-toolbar")) return {};
  if (!window.matchMedia("(min-width: 1024px)").matches || document.documentElement.dataset.vcutToolbarPosition === "bottom") return {};
  const rect = anchor.getBoundingClientRect();
  const top = Math.max(8, Math.min(rect.top, window.innerHeight - Math.min(expectedHeight, window.innerHeight - 16) - 8));
  return {
    bottom: "auto",
    top,
    left: Math.max(8, Math.min(rect.right + 8, window.innerWidth - width - 8)),
    maxHeight: Math.max(80, window.innerHeight - top - 8),
    overflowY: "auto",
  };
}
