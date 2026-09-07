"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { TextStylePreset } from "../project/textStylePresets.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import { TextStylePresetGrid } from "./TextStylePresetGrid.tsx";

const MENU_WIDTH = 220;

/** Same "opens above its anchor" reasoning as `AnimationPickerMenu`/`PixelEffectPickerMenu` — this
 *  button lives in the same bottom toolbar. */
function popupPosition(anchor: DOMRect): { bottom: number; left: number } {
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - MENU_WIDTH - 8));
  return { bottom: window.innerHeight - anchor.top + 8, left };
}

/** The toolbar's promoted Styles tool — same "bulk, fast entry point" role for `TextStylePreset` that
 *  `AnimationPickerMenu` already fills for `Clip.textAnimation`: applies a look to every selected text
 *  clip at once (`VCutApp.tsx` wires `onPick` to `applyTextStylePresetToSelection`, which itself
 *  collapses to a single-clip command when only one clip qualifies). Inspector's own Styles section
 *  (single-clip and multi-select alike) stays where a look is picked with live hover-preview on the
 *  actual canvas — this popover skips that (same as `AnimationPickerMenu`, which has no preview either)
 *  in favor of being reachable without opening Inspector at all. */
export function StylePickerMenu({
  anchorRef,
  onPick,
  onClose,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  onPick: (preset: TextStylePreset) => void;
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
      aria-label={t("Styles")}
      style={{ position: "fixed", bottom, left, width: MENU_WIDTH }}
      className="z-50 rounded-lg border border-white/10 bg-[#181b22] p-2.5 shadow-2xl"
    >
      <TextStylePresetGrid
        onPick={(preset) => {
          onPick(preset);
          onClose();
        }}
      />
    </div>,
    document.body
  );
}
