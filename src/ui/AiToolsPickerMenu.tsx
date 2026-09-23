"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { verticalToolbarPopupStyle } from "./verticalToolbarPopup.ts";
import { Ai, Backspace, Text, User } from "@veasnawt/vicons";
import type { Asset, Clip } from "../project/types.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { useTranslation } from "../i18n/useTranslation.ts";

const MENU_WIDTH = 260;

function popupPosition(anchor: DOMRect): { bottom: number; left: number } {
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - MENU_WIDTH - 8));
  return { bottom: window.innerHeight - anchor.top + 8, left };
}

/** The toolbar AI Tools button's popover menu — groups all smart video/image manipulation tools
 *  (Remove Object, Auto Cutout, Text Behind Subject, and AI Generative Edit) into a unified,
 *  accessible menu, keeping the timeline toolbar clean and organized. */
export function AiToolsPickerMenu({
  anchorRef,
  clip,
  onClose,
  onOpenAiEdit,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  clip: Clip;
  asset: Asset | undefined;
  onClose: () => void;
  onOpenAiEdit: (clipId: string) => void;
}) {
  const t = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const anchor = anchorRef.current?.getBoundingClientRect();

  const armRemoveObject = useEditorStore((s) => s.armRemoveObject);
  const removeClipBackground = useEditorStore((s) => s.removeClipBackground);
  const createTextBehindSubject = useEditorStore((s) => s.createTextBehindSubject);
  const setMobileSheet = useEditorStore((s) => s.setMobileSheet);

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
  const pos = popupPosition(anchor);

  const tools = [
    {
      id: "remove-object",
      title: t("Remove Object"),
      description: t("Select area to erase objects or watermarks"),
      icon: <Backspace size={15} className="text-teal-400" />,
      action: () => {
        armRemoveObject(clip.id);
        if (!window.matchMedia("(min-width: 1024px)").matches) setMobileSheet("inspector");
        onClose();
      },
    },
    {
      id: "auto-cutout",
      title: t("Auto Cutout"),
      description: t("1-click background removal"),
      icon: <User size={15} className="text-sky-400" />,
      action: () => {
        void removeClipBackground(clip.id);
        onClose();
      },
    },
    {
      id: "text-behind",
      title: t("Text Behind Subject"),
      description: t("Place 3D text behind person"),
      icon: <Text size={15} className="text-purple-400" />,
      action: () => {
        void createTextBehindSubject(clip.id);
        onClose();
      },
    },
    {
      id: "ai-edit",
      title: t("AI Generative Edit"),
      description: t("Transform style or replace with prompt"),
      icon: <Ai size={15} className="text-emerald-400" />,
      action: () => {
        onOpenAiEdit(clip.id);
        onClose();
      },
    },
  ];

  return createPortal(
    <div
      ref={menuRef}
      style={{ bottom: `${pos.bottom}px`, left: `${pos.left}px`, width: `${MENU_WIDTH}px`, ...verticalToolbarPopupStyle(anchorRef.current, MENU_WIDTH, 360) }}
      className="fixed z-50 rounded-xl border border-white/10 bg-[#12151c] p-1.5 shadow-2xl backdrop-blur-xl"
    >
      <div className="px-2.5 py-1.5 border-b border-white/5 mb-1">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-white/40">{t("Smart & AI Tools")}</p>
      </div>
      <div className="space-y-0.5">
        {tools.map((tool) => (
          <button
            key={tool.id}
            onClick={tool.action}
            className="flex items-center gap-2.5 w-full rounded-lg p-2 text-left hover:bg-white/10 transition group"
          >
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-white/5 group-hover:bg-white/10 transition">
              {tool.icon}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-semibold text-white group-hover:text-sky-200 transition">{tool.title}</p>
              <p className="truncate text-[10px] text-white/40">{tool.description}</p>
            </div>
          </button>
        ))}
      </div>
    </div>,
    document.body
  );
}
