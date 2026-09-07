"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check } from "@veasnawt/vicons";
import { useTranslation } from "../i18n/useTranslation.ts";
import { useEditorStore } from "../store/editorStore.ts";

/** Where a NEW text clip's content gets typed, entirely BEFORE anything exists on the timeline — see
 *  `editorStore.ts`'s own `composeText` doc comment for why this has to be a standalone flow rather
 *  than reusing `TextTransformHandles`' existing on-canvas edit mechanism (that one only resolves
 *  against an already-placed, already-selected, playhead-aligned clip — exactly the alignment a new
 *  clip's own overlap-avoiding placement can't guarantee).
 *
 *  One fixed bar for both platforms rather than two different designs: `visualViewport`-tracked so it
 *  sits above an on-screen keyboard on mobile (see the same technique `MobileTextEditBar` in
 *  `TextTransformHandles.tsx` uses, and its own comment for why a plain `position: fixed; bottom: 0`
 *  fails at exactly this), and on desktop — no keyboard to avoid — `visualViewport` still exists and
 *  simply reports a `bottomInset` of 0, so the same code path works unmodified there too.
 *
 *  The input is a controlled field bound straight to `composeText.content` (not local state) —
 *  `Preview.tsx`'s `getProject` reads that same value every frame to render a live phantom clip on
 *  the canvas at the playhead (see `composePreview.ts`), so what's typed here shows up there as it's
 *  typed, before the tick button ever commits anything real. */
export function NewTextComposer() {
  const composeText = useEditorStore((s) => s.composeText);
  const setComposeTextContent = useEditorStore((s) => s.setComposeTextContent);
  const commitComposedText = useEditorStore((s) => s.commitComposedText);
  const cancelComposeText = useEditorStore((s) => s.cancelComposeText);
  const t = useTranslation();
  const [bottomInset, setBottomInset] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (composeText) inputRef.current?.focus();
  }, [composeText]);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    function update() {
      setBottomInset(Math.max(0, window.innerHeight - vv!.height - vv!.offsetTop));
    }
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);

  if (!composeText) return null;

  function confirm() {
    commitComposedText();
  }

  return createPortal(
    // A transparent, full-screen click-catcher — tapping anywhere outside the bar cancels composing,
    // the same "tap away dismisses" convention every other popover/menu in this app already uses.
    // Deliberately NOT dimmed: unlike a modal dialog, this shouldn't visually block the canvas/timeline
    // behind it, since seeing where the new clip will land is exactly the context composing needs.
    <div className="fixed inset-0 z-50" onClick={cancelComposeText} role="presentation">
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ position: "fixed", left: 0, right: 0, bottom: bottomInset, zIndex: 50 }}
        className="flex items-center gap-2 border-t border-white/10 bg-[#14161c] p-2 shadow-2xl"
      >
        <input
          ref={inputRef}
          type="text"
          value={composeText.content}
          placeholder={t("Enter text")}
          onChange={(e) => setComposeTextContent(e.target.value)}
          onKeyDown={(e) => {
            // Same "Enter commits, matches a mobile keyboard's own Go/Done key" convention
            // `MobileTextEditBar` uses; Escape cancels, matching every other popover/dialog in this app.
            if (e.key === "Enter") {
              e.preventDefault();
              confirm();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancelComposeText();
            }
          }}
          // 16px floor: the same iOS-Safari-auto-zoom-on-focus guard every other text input in this
          // app already applies.
          className="min-w-0 flex-1 rounded-md border border-white/15 bg-white/5 px-3 py-2 text-[16px] text-white placeholder:text-white/35 focus:outline-none focus:ring-1 focus:ring-sky-400/60"
        />
        <button
          onClick={confirm}
          aria-label={t("Confirm text")}
          title={t("Confirm text")}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-sky-500 text-white transition hover:bg-sky-400"
        >
          <Check size={18} />
        </button>
      </div>
    </div>,
    document.body
  );
}
