"use client";

import type { CSSProperties, ReactNode } from "react";
import { createPortal } from "react-dom";
import { useToolPanelFrameDock } from "./ToolPanelDock.tsx";

type ToolPanelSize = "compact" | "default" | "wide";

const WIDTH_CLASS: Record<ToolPanelSize, string> = {
  compact: "max-w-sm",
  default: "max-w-lg",
  wide: "max-w-2xl",
};

/**
 * Shared shell for toolbar-opened tools. It preserves the interaction users already get from the
 * Sticker tool: a full-width bottom sheet on phones, a centered card on larger screens, and a fixed
 * height so headers/actions stay put while the tool's own content scrolls.
 */
export function ToolPanelFrame({
  ariaLabel,
  onClose,
  canClose = true,
  size = "default",
  maxHeight,
  compact = false,
  children,
}: {
  ariaLabel: string;
  onClose: () => void;
  canClose?: boolean;
  size?: ToolPanelSize;
  maxHeight?: CSSProperties["maxHeight"];
  /** Size to the content instead of filling the usual tall panel height (still capped at that height, and
   *  scrolling if the content outgrows it). For tools whose default view is short and only some mode needs the
   *  room — e.g. Voice Record, which is tall only while the Teleprompter is open. */
  compact?: boolean;
  children: ReactNode;
}) {
  const dock = useToolPanelFrameDock();
  if (dock) {
    return createPortal(
      <div
        role="dialog"
        aria-label={ariaLabel}
        data-can-close={canClose}
        className={`vcut-docked-frame flex min-h-0 w-full flex-col overflow-hidden bg-[#12151c] ${compact ? "h-auto max-h-full self-start" : "h-full"}`}
      >
        {children}
      </div>,
      dock
    );
  }
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center sm:p-4"
      onClick={() => canClose && onClose()}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        style={maxHeight === undefined ? undefined : { maxHeight }}
        className={`flex w-full ${WIDTH_CLASS[size]} flex-col overflow-hidden rounded-t-2xl border border-white/10 bg-[#12151c] shadow-2xl sm:rounded-xl ${
          compact ? "h-auto max-h-[85dvh] sm:max-h-[80vh]" : "h-[85dvh] sm:h-[80vh]"
        }`}
      >
        {children}
      </div>
    </div>,
    document.body
  );
}
