"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { verticalToolbarPopupStyle } from "./verticalToolbarPopup.ts";
import { DOCKED_PICKER_STYLE, PickerPanelHeader, useToolPanelDock } from "./ToolPanelDock.tsx";
import { useTranslation } from "../i18n/useTranslation.ts";

/** One row in the Audio menu. `active` marks a toggle that is currently on (Mute) or a panel that is open
 *  (Mixer), shown as a highlighted row. */
export interface AudioToolItem {
  id: string;
  label: string;
  description: string;
  icon: ReactNode;
  active?: boolean;
  onSelect: () => void;
}

const MENU_WIDTH = 280;

/** Same "opens above its anchor" placement as the other toolbar popovers. */
function popupPosition(anchor: DOMRect): { bottom: number; left: number } {
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - MENU_WIDTH - 8));
  return { bottom: window.innerHeight - anchor.top + 8, left };
}

/** Every audio tool behind one toolbar button: import a file, browse music, add sound effects, record a
 *  voiceover, open the mixer, mute the preview. Previously each was its own toolbar button (Voice, Mute, Music,
 *  SFX, Mixer), spreading one job across five slots; this lists them together, and adds "Import audio" — a
 *  direct way to bring a sound file onto the timeline without going through the Media panel.
 *
 *  Choosing an item closes the menu and runs it (the caller opens the panel/dialog or starts the import), except
 *  the Mute toggle, which flips in place so its new state is visible without reopening the menu. */
export function AudioToolsMenu({
  anchorRef,
  items,
  onClose,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  items: AudioToolItem[];
  onClose: () => void;
}) {
  const t = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const dock = useToolPanelDock(anchorRef.current);
  const anchor = anchorRef.current?.getBoundingClientRect();

  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [anchorRef, onClose]);

  if (!anchor) return null;
  const { bottom, left } = popupPosition(anchor);

  return createPortal(
    <div
      ref={menuRef}
      data-has-panel-header
      role="menu"
      aria-label={t("Audio")}
      style={{ position: "fixed", bottom, left, width: MENU_WIDTH, ...verticalToolbarPopupStyle(anchorRef.current, MENU_WIDTH, 360), ...(dock ? DOCKED_PICKER_STYLE : {}) }}
      className="z-50 rounded-lg border border-white/10 bg-[#181b22] p-2 shadow-2xl"
    >
      <PickerPanelHeader title={t("Audio")} onClose={onClose} />
      <div className="flex flex-col gap-0.5">
        {items.map((item) => (
          <button
            key={item.id}
            role="menuitem"
            onClick={item.onSelect}
            className={`flex items-center gap-3 rounded-md px-2.5 py-2 text-left transition ${
              item.active ? "bg-sky-500/20 text-white" : "text-white/80 hover:bg-white/10 hover:text-white"
            }`}
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-white/5">{item.icon}</span>
            <span className="min-w-0">
              <span className="block text-[13px] font-medium leading-tight">{item.label}</span>
              <span className="block truncate text-[11px] leading-tight text-white/45">{item.description}</span>
            </span>
          </button>
        ))}
      </div>
    </div>,
    dock ?? document.body
  );
}
