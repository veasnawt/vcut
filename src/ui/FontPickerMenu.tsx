"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { CustomFontAsset } from "../project/types.ts";
import { DEFAULT_FONT_ID } from "../project/fonts.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import { FontGridPicker } from "./FontGridPicker.tsx";

const MENU_WIDTH = 320;

function popupPosition(anchor: DOMRect): { bottom: number; left: number } {
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - MENU_WIDTH - 8));
  return { bottom: window.innerHeight - anchor.top + 8, left };
}

/** The toolbar's promoted Font tool — provides quick, direct access to the full font grid
 *  for selected text clips without needing to open the Inspector. Supports live hover preview
 *  on the canvas and one-click font application. */
export function FontPickerMenu({
  anchorRef,
  selectedId,
  customFonts = [],
  onPick,
  onHover,
  onClose,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  selectedId?: string;
  customFonts?: CustomFontAsset[];
  onPick: (fontId: string) => void;
  onHover?: (fontId: string | null) => void;
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
      aria-label={t("Font")}
      style={{ position: "fixed", bottom, left, width: MENU_WIDTH }}
      className="z-50 rounded-lg border border-white/10 bg-[#181b22] p-2.5 shadow-2xl"
    >
      <FontGridPicker
        customFonts={customFonts}
        selectedId={selectedId ?? DEFAULT_FONT_ID}
        onPick={(fontId) => {
          onPick(fontId);
          onClose();
        }}
        onHover={onHover}
        searchPlaceholder={t("Search fonts...")}
      />
    </div>,
    document.body
  );
}

