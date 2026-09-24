"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Close } from "@veasnawt/vicons";
import { useTranslation } from "../i18n/useTranslation.ts";
import type { TransitionType } from "../project/types.ts";
import { TRANSITION_TYPE_LABEL, TRANSITION_TYPE_OPTIONS } from "../timeline/transitions.ts";
import { TransitionPreviewTile } from "./TransitionPreviewTile.tsx";
import { verticalToolbarPopupStyle } from "./verticalToolbarPopup.ts";
import { DOCKED_PICKER_STYLE, PickerPanelHeader, useToolPanelDock } from "./ToolPanelDock.tsx";

const MENU_WIDTH = 320;

/** The duration slider's range — the same span the Inspector's own Duration field allows in practice
 *  (a transition longer than a couple of seconds stops reading as a transition). */
const MIN_DURATION = 0.1;
const MAX_DURATION = 2;

/** The Transition toolbar button's grid of every `TransitionType`, each tile a live animated preview
 *  (`TransitionPreviewTile`) rather than a plain text label — picking a transition style is a visual
 *  choice (which edge does the wipe sweep from, which way does the slide push), and a dropdown of
 *  option names can't show that the way a small looping demo can. The Inspector's own "Style" dropdowns
 *  (`Inspector.tsx`'s Transition In/Out sections) still exist for fine-tuning duration afterward — this
 *  is the fast, visual path to PICK a style in the first place, for EITHER direction: an In/Out tab
 *  switch at the top edits `clip.transitionIn`/`transitionOut` independently, so both can be set from
 *  this one popup without reopening it. `type: null` (the "None" tile) clears whichever direction is
 *  currently selected.
 *
 *  Each tab names what it actually edits: "From previous clip"/"Into next clip" when there's a
 *  touching neighbor on that side (a real two-clip blend at that junction), "Fade in"/"Fade out" when
 *  there isn't. Picking a style keeps the popup open, so its duration can be set right here with the
 *  slider, and "Apply to every cut" copies the current junction's style and duration onto every cut on
 *  the track in one undoable step. */
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
  hasPredecessor,
  hasSuccessor,
  initialMode,
  durationIn,
  durationOut,
  onChangeDurationIn,
  onChangeDurationOut,
  onApplyToAllCuts,
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
  /** Whether a clip touches the edited clip on that side — drives the tab labels (see above). */
  hasPredecessor: boolean;
  hasSuccessor: boolean;
  /** Which tab opens first; defaults to the side that has a junction, preferring "in". */
  initialMode?: "in" | "out";
  /** Current duration of each side's transition (seconds), `null` when that side has none. */
  durationIn: number | null;
  durationOut: number | null;
  onChangeDurationIn: (seconds: number) => void;
  onChangeDurationOut: (seconds: number) => void;
  /** Copies a style + duration onto every cut on the track; omitted where that doesn't apply. */
  onApplyToAllCuts?: (type: TransitionType, duration: number) => void;
}) {
  const t = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const dock = useToolPanelDock(anchorRef.current);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const [mode, setMode] = useState<"in" | "out">(initialMode ?? (!hasPredecessor && hasSuccessor ? "out" : "in"));
  // The slider's value while it's being dragged — committed (one undo step) on release, not per tick.
  const [draftDuration, setDraftDuration] = useState<number | null>(null);
  const [appliedToAll, setAppliedToAll] = useState(false);

  // A junction can be anywhere in the timeline, unlike the bottom toolbar. Measure after the
  // anchor's DOM position is committed, and keep the entire scrollable picker within the viewport.
  useLayoutEffect(() => {
    if (dock) return;
    const menu = menuRef.current;
    if (!menu) return;
    const place = () => {
      const anchorElement = anchorRef.current;
      const anchor = anchorElement?.getBoundingClientRect();
      if (!anchor) return;
      const rect = menu.getBoundingClientRect();
      const railPosition = verticalToolbarPopupStyle(anchorElement, MENU_WIDTH, rect.height);
      const left = typeof railPosition.left === "number" ? railPosition.left : Math.max(8, Math.min(anchor.left, window.innerWidth - rect.width - 8));
      const top = typeof railPosition.top === "number" ? railPosition.top : Math.max(8, Math.min(anchor.top - rect.height - 8, window.innerHeight - rect.height - 8));
      setPosition(previous => previous.left === left && previous.top === top ? previous : { left, top });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(menu);
    window.addEventListener("resize", place);
    window.addEventListener("vcut:toolbar-position-change", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("vcut:toolbar-position-change", place);
    };
  }, [anchorRef, initialMode, dock]);

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

  const activeType = mode === "in" ? activeIn : activeOut;
  const onChange = mode === "in" ? onChangeIn : onChangeOut;
  const committedDuration = mode === "in" ? durationIn : durationOut;
  const onChangeDuration = mode === "in" ? onChangeDurationIn : onChangeDurationOut;
  const shownDuration = draftDuration ?? committedDuration;
  const isJunction = mode === "in" ? hasPredecessor : hasSuccessor;
  const commitDuration = () => {
    if (draftDuration !== null && draftDuration !== committedDuration) onChangeDuration(draftDuration);
    setDraftDuration(null);
  };
  const tabLabel = (m: "in" | "out") =>
    m === "in" ? (hasPredecessor ? t("From previous clip") : t("Fade in")) : hasSuccessor ? t("Into next clip") : t("Fade out");
  // "In" blends FROM the predecessor INTO the clip being edited; "Out" blends FROM the clip being
  // edited INTO the successor — see `TransitionPreviewTile.tsx`'s own prop doc comments.
  const outgoingThumbnailUrl = mode === "in" ? predecessorThumbnailUrl : selectedThumbnailUrl;
  const incomingThumbnailUrl = mode === "in" ? selectedThumbnailUrl : successorThumbnailUrl;
  const gridOptions = isAudioTrack || isTextTrack ? (["crossfade"] as TransitionType[]) : TRANSITION_TYPE_OPTIONS;

  return createPortal(
    <div
      ref={menuRef}
      data-has-panel-header
      role="menu"
      aria-label={t("Transition style")}
      style={{ position: "fixed", ...position, width: MENU_WIDTH, maxWidth: "calc(100vw - 16px)", ...(dock ? DOCKED_PICKER_STYLE : {}) }}
      className="z-50 max-h-[70vh] overflow-y-auto rounded-lg border border-white/10 bg-[#181b22] p-2 shadow-2xl"
    >
      <PickerPanelHeader title={t("Transitions")} onClose={onClose} />
      <div className="mb-2 flex gap-1 rounded-md bg-white/5 p-0.5">
        {(["in", "out"] as const).map((m) => (
          <button
            key={m}
            onClick={() => {
              setMode(m);
              setDraftDuration(null);
              setAppliedToAll(false);
            }}
            className={`flex-1 rounded px-2 py-1 text-[11px] font-medium transition ${
              mode === m ? "bg-sky-500/25 text-white" : "text-white/50 hover:text-white/80"
            }`}
          >
            {tabLabel(m)}
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
            onChange(null);
            setAppliedToAll(false);
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
              onChange(type);
              setAppliedToAll(false);
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
      {activeType && shownDuration !== null && (
        <div className="mt-2 border-t border-white/10 px-1 pt-2">
          <label className="flex items-center gap-2 text-[11px] text-white/70">
            <span className="shrink-0">{t("Duration")}</span>
            <input
              type="range"
              min={MIN_DURATION}
              max={MAX_DURATION}
              step={0.1}
              value={shownDuration}
              onChange={(e) => setDraftDuration(Number(e.target.value))}
              onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
              onPointerUp={commitDuration}
              onPointerCancel={() => setDraftDuration(null)}
              onKeyUp={commitDuration}
              onBlur={commitDuration}
              className="min-w-0 flex-1 accent-sky-400"
            />
            <span className="w-9 shrink-0 text-right tabular-nums text-white">{shownDuration.toFixed(1)}s</span>
          </label>
          {isJunction && onApplyToAllCuts && (
            <button
              onClick={() => {
                onApplyToAllCuts(activeType, shownDuration);
                setAppliedToAll(true);
              }}
              className="mt-2 w-full rounded bg-white/5 px-2 py-1.5 text-[11px] font-medium text-white/80 transition hover:bg-white/10 hover:text-white"
            >
              {appliedToAll ? t("Applied to every cut on this track") : t("Apply to every cut on this track")}
            </button>
          )}
        </div>
      )}
    </div>,
    dock ?? document.body
  );
}
