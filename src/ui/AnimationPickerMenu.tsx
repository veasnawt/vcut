"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { Clip } from "../project/types.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import { TextAnimationPickerGrid } from "./TextAnimationPickerGrid.tsx";

const MENU_WIDTH = 220;

/** Same "opens above its anchor" reasoning as `PixelEffectPickerMenu`/`ColorPickerMenu` — this button
 *  lives in the same bottom toolbar. */
function popupPosition(anchor: DOMRect): { bottom: number; left: number } {
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - MENU_WIDTH - 8));
  return { bottom: window.innerHeight - anchor.top + 8, left };
}

/** The toolbar's promoted Animation tool — applies an animation TYPE to every selected text clip at
 *  once (`VCutApp.tsx` wires `onPick` to `applyTextAnimationToSelection`, which itself collapses to a
 *  single-clip command when only one clip qualifies, so this same popover works whether one or many
 *  text clips are selected). Inspector's own single-clip Animation section stays the place to fine-
 *  tune `speed`/`highlightColor` afterward — this is the fast, bulk-capable entry point, same split
 *  as Transition/Effects/Pixel FX's own toolbar-popover-vs-Inspector-section division. */
export function AnimationPickerMenu({
  anchorRef,
  current,
  onPick,
  onClose,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  current: Clip["textAnimation"] | null | undefined;
  onPick: (next: Clip["textAnimation"] | null) => void;
  onClose: () => void;
}) {
  const t = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
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
      role="menu"
      aria-label={t("Animation")}
      style={{ position: "fixed", bottom, left, width: MENU_WIDTH }}
      className="z-50 rounded-lg border border-white/10 bg-[#181b22] p-2.5 shadow-2xl"
    >
      <TextAnimationPickerGrid
        current={current}
        onPick={(next) => {
          onPick(next);
          onClose();
        }}
      />
    </div>,
    document.body
  );
}
