"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Music, Text as TextIcon, Video } from "@veasnawt/vicons";
import type { TrackKind } from "../project/types.ts";
import { useTranslation } from "../i18n/useTranslation.ts";

const MENU_WIDTH = 160;

const KIND_OPTIONS: { kind: TrackKind; icon: typeof Video }[] = [
  { kind: "video", icon: Video },
  { kind: "audio", icon: Music },
  { kind: "text", icon: TextIcon },
];

/** Same "opens above its anchor" reasoning as the toolbar's other popovers (`TextStylePickerMenu`
 *  etc.) — this one anchors off the "+" row at the bottom of the track list instead of the toolbar,
 *  so it opens upward from wherever that row happens to sit. */
function popupPosition(anchor: DOMRect): { bottom: number; left: number } {
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - MENU_WIDTH - 8));
  return { bottom: window.innerHeight - anchor.top + 8, left };
}

/** The "+" row's own popover — lets the new track's kind be chosen once, right after tapping it,
 *  rather than the old three separate "+ Video"/"+ Audio"/"+ Text" toolbar buttons this replaces
 *  (see `Timeline.tsx`'s own comment on that row). */
export function TrackKindPickerMenu({
  anchorRef,
  onPick,
  onClose,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  onPick: (kind: TrackKind) => void;
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
  const label: Record<TrackKind, string> = {
    video: t("Video track"),
    audio: t("Audio track"),
    text: t("Text track"),
  };

  function pick(kind: TrackKind) {
    onPick(kind);
    onClose();
  }

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={t("Add track")}
      style={{ position: "fixed", bottom, left, width: MENU_WIDTH }}
      className="z-50 flex flex-col gap-0.5 rounded-lg border border-white/10 bg-[#181b22] p-1.5 shadow-2xl"
    >
      {KIND_OPTIONS.map(({ kind, icon: Icon }) => (
        <button
          key={kind}
          role="menuitem"
          onClick={() => pick(kind)}
          className="flex items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-white/75 transition hover:bg-white/10 hover:text-white"
        >
          <Icon size={14} />
          {label[kind]}
        </button>
      ))}
    </div>,
    document.body
  );
}
