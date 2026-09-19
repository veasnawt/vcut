"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Close } from "@veasnawt/vicons";
import { useTranslation } from "../i18n/useTranslation.ts";
import type { TransitionType } from "../project/types.ts";
import { TRANSITION_TYPE_LABEL, TRANSITION_TYPE_OPTIONS } from "../timeline/transitions.ts";
import { TransitionPreviewTile } from "./TransitionPreviewTile.tsx";

const MENU_WIDTH = 320;

/** Opens ABOVE its anchor, not below like `ImportSourceMenu` — the Transition button lives in the
 *  bottom toolbar, so a below-anchored popup would run straight off the bottom of the viewport. */
function popupPosition(anchor: DOMRect): { bottom: number; left: number } {
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - MENU_WIDTH - 8));
  return { bottom: window.innerHeight - anchor.top + 8, left };
}

/** The Transition toolbar button's grid of every `TransitionType`, each tile a live animated preview
 *  (`TransitionPreviewTile`) rather than a plain text label — picking a transition style is a visual
 *  choice (which edge does the wipe sweep from, which way does the slide push), and a dropdown of
 *  option names can't show that the way a small looping demo can. The Inspector's own "Style" dropdowns
 *  (`Inspector.tsx`'s Transition In/Out sections) still exist for fine-tuning duration afterward — this
 *  is the fast, visual path to PICK a style in the first place, for EITHER direction: an In/Out tab
 *  switch at the top edits `clip.transitionIn`/`transitionOut` independently, so both can be set from
 *  this one popup without reopening it. `type: null` (the "None" tile) clears whichever direction is
 *  currently selected. */
export function TransitionPickerMenu({
  anchorRef,
  isAudioTrack,
  isTextTrack,
  activeIn,
  activeOut,
  onChangeIn,
  onChangeOut,
  onClose,
  selectedThumbnailUrl,
  predecessorThumbnailUrl,
  successorThumbnailUrl,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  /** An audio clip's transition is always a crossfade — see `buildAudioTrackStream`'s own comment on
   *  why every `TransitionType` renders identically for audio. Narrows the grid to just the Crossfade
   *  tile (plus None) instead of showing 11 video-only styles that would all silently apply as a plain
   *  crossfade anyway — the same "duration only, no style choice" treatment the Inspector's own
   *  Transitions tab already gives an audio clip. */
  isAudioTrack: boolean;
  /** Every `TransitionType` renders identically for a text clip — a plain fade — same reasoning
   *  `isAudioTrack` above already documents for audio, just for a different underlying cause:
   *  `drawtext` has no per-type geometry primitive the way video's `xfade` filter does (a wipe/slide/
   *  circle needs masking two SEPARATELY rendered buffers, not a single call's own parameters), so
   *  `buildTextFadeParams` (export) always produces a plain alpha ramp regardless of which type the
   *  clip's `transitionIn`/`transitionOut` actually names. Offering the full grid here used to let the
   *  canvas preview (and the tile thumbnails themselves) show real wipe/slide/circle motion export
   *  could never reproduce — confirmed as a real, reported mismatch (picked "Wipe Left," export showed
   *  a plain fade with no directional reveal at any point), not a theoretical gap. Narrows the grid to
   *  one tile total, exactly like `isAudioTrack`. */
  isTextTrack: boolean;
  activeIn: TransitionType | null;
  activeOut: TransitionType | null;
  onChangeIn: (type: TransitionType | null) => void;
  onChangeOut: (type: TransitionType | null) => void;
  onClose: () => void;
  /** Real thumbnails for `TransitionPreviewTile`'s two panels (`null` when there's nothing to show —
   *  see that component's own `buildPanel` comment for why that renders as plain black rather than a
   *  placeholder color). `selected` is the clip being edited itself — always the INCOMING side for the
   *  "In" tab and the OUTGOING side for the "Out" tab; `predecessor`/`successor` are its neighbors on
   *  the same track, resolved by the caller (`VCutApp.tsx`, via `findTransitionCandidate`/
   *  `findTransitionSuccessorCandidate`) since that's where `project`/`track` already live. */
  selectedThumbnailUrl: string | null;
  predecessorThumbnailUrl: string | null;
  successorThumbnailUrl: string | null;
}) {
  const t = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const anchor = anchorRef.current?.getBoundingClientRect();
  const [mode, setMode] = useState<"in" | "out">("in");

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
  const activeType = mode === "in" ? activeIn : activeOut;
  const onChange = mode === "in" ? onChangeIn : onChangeOut;
  // "In" blends FROM the predecessor INTO the clip being edited; "Out" blends FROM the clip being
  // edited INTO the successor — see `TransitionPreviewTile.tsx`'s own prop doc comments.
  const outgoingThumbnailUrl = mode === "in" ? predecessorThumbnailUrl : selectedThumbnailUrl;
  const incomingThumbnailUrl = mode === "in" ? selectedThumbnailUrl : successorThumbnailUrl;
  const gridOptions = isAudioTrack || isTextTrack ? (["crossfade"] as TransitionType[]) : TRANSITION_TYPE_OPTIONS;

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={t("Transition style")}
      style={{ position: "fixed", bottom, left, width: MENU_WIDTH }}
      className="z-50 max-h-[70vh] overflow-y-auto rounded-lg border border-white/10 bg-[#181b22] p-2 shadow-2xl"
    >
      <div className="mb-2 flex gap-1 rounded-md bg-white/5 p-0.5">
        {(["in", "out"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`flex-1 rounded px-2 py-1 text-[11px] font-medium transition ${
              mode === m ? "bg-sky-500/25 text-white" : "text-white/50 hover:text-white/80"
            }`}
          >
            {m === "in" ? t("In") : t("Out")}
            {(m === "in" ? activeIn : activeOut) && <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-sky-400" />}
          </button>
        ))}
      </div>
      {isAudioTrack && (
        <p className="mb-2 px-1 text-[10px] leading-snug text-white/40">
          {t("Audio transitions are always a crossfade — there's no separate visual style to pick.")}
        </p>
      )}
      {isTextTrack && (
        <p className="mb-2 px-1 text-[10px] leading-snug text-white/40">
          {t("Text transitions are always a fade — there's no separate visual style to pick.")}
        </p>
      )}
      <div className="grid grid-cols-3 gap-1.5">
        <button
          role="menuitem"
          onClick={() => {
            onClose();
            onChange(null);
          }}
          className={`flex flex-col items-center gap-1 rounded p-1 transition hover:bg-white/10 ${
            !activeType ? "bg-sky-500/20" : ""
          }`}
        >
          <div className="flex items-center justify-center rounded border border-white/10 bg-black/40 text-white/30" style={{ width: 96, height: 54 }}>
            <Close size={16} />
          </div>
          <span className="text-[10px] text-white/70">{t("None")}</span>
        </button>
        {gridOptions.map((type) => (
          <button
            key={type}
            role="menuitem"
            onClick={() => {
              onClose();
              onChange(type);
            }}
            className={`flex flex-col items-center gap-1 rounded p-1 transition hover:bg-white/10 ${
              activeType === type ? "bg-sky-500/20" : ""
            }`}
          >
            <TransitionPreviewTile type={type} outgoingThumbnailUrl={outgoingThumbnailUrl} incomingThumbnailUrl={incomingThumbnailUrl} />
            <span className="text-[10px] text-white/70">{t(TRANSITION_TYPE_LABEL[type])}</span>
          </button>
        ))}
      </div>
    </div>,
    document.body
  );
}
