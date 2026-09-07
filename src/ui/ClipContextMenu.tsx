"use client";

import React, { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface ClipContextMenuAction {
  key: string;
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  /** Rose/danger styling — used for Delete, the one destructive action this menu ever shows. */
  danger?: boolean;
}

/** A right-click (desktop only — `contextmenu` never fires from touch) menu at an arbitrary screen
 *  point, listing whichever clip actions actually apply to the current selection. Deliberately generic
 *  (a plain action list, no gating logic of its own) — `StatusBar` (`VCutApp.tsx`) builds `actions`
 *  from the exact same `transitionDisabled`/`effectsDisabled`/etc. flags its own bottom toolbar
 *  already computes, so a clip's context menu and its toolbar always agree on what's currently
 *  possible without a second, separately-maintained copy of that logic.
 *
 *  Same portal-into-`document.body` + outside-click/Escape-to-close pattern as `ConfirmDialog.tsx`/
 *  `Dropdown.tsx` — see the former's own doc comment for why a portal specifically. */
export function ClipContextMenu({ x, y, actions, onClose }: { x: number; y: number; actions: ClipContextMenuAction[]; onClose: () => void }) {
  const menuRef = useRef<HTMLDivElement>(null);
  // Rendered at the raw click point first, then nudged back on-screen once the menu's own real size
  // is known — a right-click near the viewport's right/bottom edge would otherwise render partly off
  // it, with no way to know the menu's width/height ahead of the first paint that measures it.
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    const left = Math.min(x, Math.max(margin, window.innerWidth - rect.width - margin));
    const top = Math.min(y, Math.max(margin, window.innerHeight - rect.height - margin));
    setPos({ left, top });
  }, [x, y]);

  React.useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    // A SECOND right-click anywhere else should close this one rather than stacking a new native
    // menu attempt on top of an already-open custom one — `contextmenu` closes it the same way a
    // plain click/tap outside does.
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("contextmenu", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("contextmenu", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      style={{ position: "fixed", left: pos.left, top: pos.top }}
      className="z-50 min-w-[180px] overflow-hidden rounded-lg border border-white/10 bg-[#14161c] py-1 shadow-2xl"
    >
      {actions.map((action) => (
        <button
          key={action.key}
          role="menuitem"
          onClick={() => {
            action.onClick();
            onClose();
          }}
          className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] transition ${
            action.danger ? "text-rose-300 hover:bg-rose-500/15" : "text-white/85 hover:bg-white/10"
          }`}
        >
          <span className="flex shrink-0 items-center">{action.icon}</span>
          {action.label}
        </button>
      ))}
    </div>,
    document.body
  );
}
