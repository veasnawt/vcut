"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { applyTextStylePreset } from "../project/textStylePresets.ts";
import { DEFAULT_TEXT_STYLE, type TextStyle } from "../project/types.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import { TextStylePresetGrid } from "./TextStylePresetGrid.tsx";

const MENU_WIDTH = 220;

/** Same "opens above its anchor" reasoning as `PixelEffectPickerMenu`/`ColorPickerMenu` — this button
 *  lives in the same bottom toolbar. */
function popupPosition(anchor: DOMRect): { bottom: number; left: number } {
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - MENU_WIDTH - 8));
  return { bottom: window.innerHeight - anchor.top + 8, left };
}

/** The toolbar Text button's popover — lets a look be chosen BEFORE the clip exists, rather than the
 *  old instant-create-then-restyle-in-Inspector flow. "Default" (`DEFAULT_TEXT_STYLE`, unchanged) sits
 *  above the same preset grid Inspector's own Styles section uses, so picking a preset here previews
 *  the identical tile a user would later see there. `onPick` receives a fully-resolved `TextStyle`
 *  (not a raw preset) — the caller (`VCutApp.tsx`) just forwards it straight into `composeText`
 *  (`editorStore.ts`), which `NewTextComposer` then uses once real text is actually typed and
 *  confirmed; no preset-resolution logic of its own to duplicate either way. */
export function TextStylePickerMenu({ anchorRef, onPick, onClose }: { anchorRef: React.RefObject<HTMLElement | null>; onPick: (style: TextStyle) => void; onClose: () => void }) {
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

  function pick(style: TextStyle) {
    onPick(style);
    onClose();
  }

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={t("Add text")}
      style={{ position: "fixed", bottom, left, width: MENU_WIDTH }}
      className="z-50 rounded-lg border border-white/10 bg-[#181b22] p-2.5 shadow-2xl"
    >
      <button
        onClick={() => pick(DEFAULT_TEXT_STYLE)}
        className="mb-2 w-full rounded bg-white/5 py-1.5 text-[12px] text-white/70 transition hover:bg-white/10 hover:text-white"
      >
        {t("Default")}
      </button>
      <TextStylePresetGrid onPick={(preset) => pick(applyTextStylePreset(DEFAULT_TEXT_STYLE, preset))} />
    </div>,
    document.body
  );
}
