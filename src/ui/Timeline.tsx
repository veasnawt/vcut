"use client";

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Add, ChevronDown } from "@veasnawt/vicons";
import { thumbnailUrl } from "../api/client.ts";
import { AddTrackCommand, ReorderTrackCommand, SetClipTransitionCommand } from "../commands/index.ts";
import { OUTRO_DURATION_SECONDS } from "../export/outro.ts";
import { clipDuration, clipEnd, sequenceDuration } from "../project/createProject.ts";
import { DEFAULT_TEXT_STYLE, type Track, type TrackKind } from "../project/types.ts";
import { trackKindForAsset } from "../timeline/operations.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import {
  clampTimelineZoom,
  DEFAULT_TIMELINE_PIXELS_PER_SECOND,
  timelineScrollLeftForAnchor,
  timelineTimeAtClientX,
  visibleRulerTicks,
} from "../timeline/interaction.ts";
import { formatTimecode, snapToFrame } from "../timeline/time.ts";
import { findTransitionCandidate } from "../timeline/transitions.ts";
import { addDragListeners, clientPoint, preventDefaultIfMouse } from "./pointerEvents.ts";
import { TimelineClip } from "./TimelineClip.tsx";
import { TransitionJunction } from "./TransitionJunction.tsx";
import { ACCEPTED_EXTENSIONS_BY_KIND, TrackHeader } from "./TrackHeader.tsx";
import { TrackKindPickerMenu } from "./TrackKindPickerMenu.tsx";
import { TemplateGroupLaneBar, TemplateGroupRowHeader } from "./TemplateGroupRow.tsx";
import { TemplateGroupPanel } from "./TemplateGroupPanel.tsx";
import { useHostedCreditsGate } from "./useHostedCreditsGate.ts";
import { useIsMobile } from "./useIsMobile.ts";

const TRACK_HEIGHT = 44;
/** Mobile-only row height for a track with nothing on it — a full-height empty row (same height as
 *  a busy one, showing nothing) reads as broken/wasteful on a small screen where every row of height
 *  is precious. Tall enough to still comfortably fit TrackHeader.tsx's own single-row header (drag
 *  handle, identity tile, name, menu) at the same 26px touch-target floor used everywhere else in that
 *  file. Reverts to `TRACK_HEIGHT` the instant a clip actually lands on the track (or a voiceover
 *  recording is in progress on it — see `isTrackCompact`'s own comment). */
const EMPTY_TRACK_HEIGHT = 32;
// TrackHeader.tsx's own row is deliberately compact now — a drag handle, one fixed-size identity
// tile (the real Cover thumbnail on whichever track hosts it, a plain kind icon otherwise), the
// track's name, and a single "⋮" menu for everything else — so this stays close to the original 156
// rather than the wider value the row's old, busier layout briefly needed.
const HEADER_WIDTH = 150;
const RULER_HEIGHT = 26;
/** Height of the "add a track" row below the last real one — deliberately shorter than either track
 *  height above: it's a single affordance, not a row of content, and shouldn't compete visually with
 *  actual tracks for space. */
const NEW_TRACK_ROW_HEIGHT = 30;
/** Empty space kept past the end of the edit, so there's always somewhere to drop a clip and extend
 *  the timeline rather than being fenced in at exactly the last frame. */
const TRAILING_SECONDS = 10;
/** Screen pixels the pointer must travel before a press on empty lane space counts as a marquee drag
 *  rather than a plain click — same reasoning and same value as `TimelineClip`'s own `DRAG_THRESHOLD`:
 *  without it, a slightly-shaky click meant only to deselect (the lane background's existing `onClick`)
 *  could register as a real (if tiny) drag instead. */
const MARQUEE_DRAG_THRESHOLD = 3;

/** Chooses a ruler interval that keeps labels readable at any zoom — roughly one every 80px, snapped
 *  to a human-friendly step so labels land on whole seconds and minutes rather than arbitrary values. */
/** Same kind→accent-color convention `TrackHeader.tsx`'s own `KIND_ICON` uses, so a track's row and
 *  its "add something" affordance read as the same track at a glance. */
const ADD_BUTTON_CLASS: Record<Track["kind"], string> = {
  video: "bg-sky-500/10 text-sky-300 hover:bg-sky-500/20",
  audio: "bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20",
  text: "bg-amber-500/10 text-amber-300 hover:bg-amber-500/20",
};

/** The prominent "this track is empty, tap to fill it" affordance — rendered directly in a track's own
 *  (otherwise blank) clip lane rather than left to the small, hover-only import "+" already tucked
 *  into `TrackHeader.tsx`'s own row (that one stays, for a track that already HAS clips — this one
 *  only ever appears for an empty one, where a blank strip of nothing was the entire previous state). */
function AddClipButton({ kind, label, onClick }: { kind: Track["kind"]; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`absolute left-2 top-1/2 flex min-h-[26px] -translate-y-1/2 items-center gap-1 rounded-md px-2 text-[11px] font-medium transition ${ADD_BUTTON_CLASS[kind]}`}
    >
      <Add size={13} />
      {label}
    </button>
  );
}

/** The "+" affordance itself — one flexible button replacing the old always-visible "+ Video"/
 *  "+ Audio"/"+ Text" toolbar buttons, with the kind chosen at the point of use: tapping opens
 *  `TrackKindPickerMenu`, or it's inferred implicitly by dragging media onto the matching drop-zone
 *  row rendered alongside it in the lanes (`isOverNewTrackRow`/`resolveTimelineDropTarget` in
 *  `Timeline` decide the kind from the dropped asset in that case — this button never sees that path).
 *  Deliberately just the button+popover, no surrounding row markup: the desktop header column and
 *  the mobile inline gutter each wrap it in their own container, matching how `TrackHeader` itself
 *  is reused unchanged across both layouts. */
function AddTrackButton({ compact, onPick }: { compact?: boolean; onPick: (kind: TrackKind) => void }) {
  const t = useTranslation();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button
        ref={buttonRef}
        onClick={() => setOpen(true)}
        aria-label={t("Add track")}
        title={t("Add track")}
        className={`flex items-center gap-1 rounded text-white/45 transition hover:bg-white/10 hover:text-white ${
          compact ? "min-h-[26px] min-w-[26px] justify-center px-1" : "px-1.5 py-1 text-[11px]"
        }`}
      >
        <Add size={12} />
        {!compact && t("Add track")}
      </button>
      {open && <TrackKindPickerMenu anchorRef={buttonRef} onPick={onPick} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Isolated so ONLY this readout re-renders as the playhead advances during playback — not the whole
 *  Timeline (every track, every clip). Moved here from Preview.tsx, alongside the total-duration
 *  readout it's now paired with — same "isolate the 30-60×/sec subscription" reasoning as before, see
 *  that file's own git history for the original comment this one's adapted from. */
function CurrentTime({ fps }: { fps: number }) {
  const playhead = useEditorStore((s) => s.playhead);
  const t = useTranslation();
  return (
    <span role="timer" aria-live="off" aria-label={t("Current time")} className="text-white/90">
      {formatTimecode(playhead, fps)}
    </span>
  );
}

export function Timeline({ onCollapse }: { onCollapse?: () => void } = {}) {
  const t = useTranslation();
  const project = useEditorStore((s) => s.project);
  const projectId = useEditorStore((s) => s.projectId);
  const pixelsPerSecond = useEditorStore((s) => s.pixelsPerSecond);
  const selectedClipIds = useEditorStore((s) => s.selectedClipIds);
  const setPlayhead = useEditorStore((s) => s.setPlayhead);
  const setStatus = useEditorStore((s) => s.setStatus);
  // Raw (possibly-null, possibly-unsorted) values — selected directly rather than via the store's own
  // `exportRange()` getter, which returns a freshly-allocated object every call and would defeat
  // Zustand's reference-equality re-render check. Sorted/clamped locally instead, right below.
  const exportRangeStart = useEditorStore((s) => s.exportRangeStart);
  const exportRangeEnd = useEditorStore((s) => s.exportRangeEnd);
  const setExportRangeStart = useEditorStore((s) => s.setExportRangeStart);
  const setExportRangeEnd = useEditorStore((s) => s.setExportRangeEnd);
  const clearExportRange = useEditorStore((s) => s.clearExportRange);
  // Whether this project's export will actually get the outro end card appended — same condition
  // `export/route.ts`'s own server-side `shouldIncludeOutro` checks (hosted mode, not on the Pro
  // plan), duplicated here only because there's no single shared place both a Next.js API route and
  // this client bundle can import server-only session/profile logic from; `credits` already carries
  // `plan` for the OTHER hosted-only UI (Captions/Remove Object) that needed it first. `null` while
  // still loading reads as "don't show yet" below, rather than flashing on then off once the real
  // plan resolves — a marker for something that turns out not to apply is worse than a brief absence.
  const { hosted, credits } = useHostedCreditsGate();
  const showOutroMarker = hosted && credits !== null && credits.plan !== "pro";
  const select = useEditorStore((s) => s.select);
  const setPixelsPerSecond = useEditorStore((s) => s.setPixelsPerSecond);
  const run = useEditorStore((s) => s.run);
  const assetDrag = useEditorStore((s) => s.assetDrag);
  const setResolveTimelineDropTarget = useEditorStore((s) => s.setResolveTimelineDropTarget);
  const recording = useEditorStore((s) => s.recording);
  const importFiles = useEditorStore((s) => s.importFiles);
  const addAssetAtPlayhead = useEditorStore((s) => s.addAssetAtPlayhead);
  const setComposeText = useEditorStore((s) => s.setComposeText);
  const armedAssetId = useEditorStore((s) => s.armedAssetId);
  const cancelArmedAsset = useEditorStore((s) => s.cancelArmedAsset);
  /** Which empty track a click on its own `AddClipButton` (below) is importing a file onto — a file
   *  picker has no notion of "which track," so this is set right before `emptyTrackImportInputRef` is
   *  clicked and read back in that input's own `onChange`. One shared hidden `<input>` for every empty
   *  track rather than one per row: only ever one file dialog open at a time, so there's nothing a
   *  per-row instance would buy over reusing a single one with its `accept` attribute swapped per click. */
  const [emptyTrackImportTarget, setEmptyTrackImportTarget] = useState<Track | null>(null);
  const emptyTrackImportInputRef = useRef<HTMLInputElement>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  /** The `scrollableWidth`-wide content div (ruler + lanes + clips + export-range markers) — what the
   *  pinch-zoom handler below applies its live `transform: scaleX()` preview to, so a live gesture is
   *  a cheap GPU composite instead of a full-timeline browser layout on every frame. Deliberately does
   *  NOT wrap the playhead marker (a sibling, not a child, of this div — see its own render below):
   *  on mobile the marker's on-screen position never depends on `pixelsPerSecond` at all (the
   *  fixed-center-playhead design already keeps it pinned at screen-center regardless of zoom), so it
   *  correctly stays put and unscaled through a pinch exactly as it should. */
  const contentRef = useRef<HTMLDivElement>(null);
  const lanesRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const markerRef = useRef<HTMLDivElement>(null);
  const headerListRef = useRef<HTMLDivElement>(null);
  /** The lanes-side "add track" drop-zone row (see `AddTrackRow`) — hit-tested by its own bounding
   *  rect rather than by summing track heights like `resolveTrackAt` does, since it's laid out right
   *  after the real tracks in normal flow and already sits at the correct Y with zero extra bookkeeping. */
  const newTrackRowRef = useRef<HTMLDivElement>(null);
  /** True while the user has the ruler pressed and is actively dragging it — see the playhead-follow
   *  effect's own comment on why auto-follow is suppressed during this. */
  const isScrubbingRef = useRef(false);
  /** Set just before a zoom change, read back by the layout effect below once the new
   *  `pixelsPerSecond` has actually rendered. This is what lets zooming keep a fixed point stationary
   *  under the cursor (or under the viewport's own center for a keyboard/button-triggered zoom that
   *  has no cursor position) instead of always zooming from the left edge of the scroll area, which
   *  is what plain `zoomBy` on its own does and what makes naive timeline zoom feel like it "jumps". */
  const zoomAnchorRef = useRef<{ time: number; clientX: number } | null>(null);
  /** Set while a clip is being dragged onto a DIFFERENT track, so the destination can be highlighted.
   *  Updated only when the target actually changes, not on every mouse move. */
  const [dropTrackId, setDropTrackId] = useState<string | null>(null);
  /** Set while a TRACK is being dragged to reorder it — distinct from `dropTrackId` above, which is
   *  about a CLIP landing on a different track. Only one row can be a drop target at a time, so this
   *  lives here rather than each `TrackHeader` guessing independently. */
  const [trackDropIndicator, setTrackDropIndicator] = useState<{ trackId: string; position: "before" | "after" } | null>(
    null
  );
  /** Which `Track.templateGroup.id`, if any, `TemplateGroupPanel.tsx` is currently open for — opened by
   *  the badge `TrackHeader.tsx` shows on every track belonging to that group. Lives here (rather than
   *  in `TrackHeader` itself) since either of that component's two call sites below — desktop sidebar or
   *  mobile inline gutter — can open it, and only one panel should ever be open at a time. */
  const [openGroupId, setOpenGroupId] = useState<string | null>(null);
  /** Client X of the pointer while it's over the ruler (hovering OR actively scrubbing) — null means
   *  "don't show the tooltip". Only the X coordinate is stored; the TIME it corresponds to is derived
   *  fresh on every render from `timeFromEvent`, which already accounts for the container's current
   *  scroll position, so this never needs to be kept in sync with scrolling by hand. */
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [snapGuideTime, setSnapGuideTime] = useState<number | null>(null);
  /** Mirrors `scrollRef.current.scrollLeft`/`.clientWidth` into React state — the persistent
   *  horizontal scrollbar below the tracks (see `HScrollbar`) needs both to size and position its
   *  thumb, and native scrolling doesn't trigger a re-render on its own. `scrollLeft` updates via the
   *  scroll container's own `onScroll` below; `viewportWidth` via a `ResizeObserver`, same pattern
   *  `TransformHandles` already uses to track its canvas's live on-screen size. */
  const [scrollLeft, setScrollLeft] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(0);
  /** Passed to every `TimelineClip` as `onPanScroll` — a touch-drag that starts on a clip but turns out
   *  to be a plain swipe (see that component's own `gateBehindLongPress` handling) scrolls the SAME
   *  container this way, by the same convention native panning would: dragging right (positive
   *  `deltaX`) reveals content to the left, so `scrollLeft` moves the opposite direction. `useCallback`
   *  with an empty dependency array keeps this reference-stable across renders — required for
   *  `TimelineClip`'s own `React.memo` (see its doc comment) to keep skipping re-renders on every
   *  scroll frame the way it already relies on every other prop here being stable. */
  const panTimelineBy = useCallback((deltaX: number) => {
    const el = scrollRef.current;
    if (el) el.scrollLeft -= deltaX;
  }, []);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setViewportWidth(el.clientWidth);
    const observer = new ResizeObserver(() => setViewportWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Same `lg` breakpoint every other mobile/desktop layout branch in this app already uses
  // (VCutApp.tsx's own `timelineHeight` seed) — reactive here (not a one-time check) since
  // rotating a tablet or resizing a desktop window across it mid-session needs to actually flip
  // between "fixed-center playhead, scroll scrubs" (mobile) and "moving playhead, independent scroll"
  // (desktop) behavior live, not just at first mount.
  const isMobile = useIsMobile();
  /** True for one frame after THIS component writes `scrollLeft` itself (mobile centering below) —
   *  lets the scroll handler tell "the user actually scrolled" apart from "scrollLeft changed because
   *  WE just centered it on a playhead update", so the two mobile-only sync directions (scroll→playhead,
   *  playhead→scrollLeft) don't feed into each other every frame during playback. Cleared via rAF
   *  (not the scroll handler's own throttle) so it clears even if the browser skips firing a `scroll`
   *  event because the value didn't visibly change (e.g. already clamped to the same edge). */
  const programmaticScrollRef = useRef(false);
  /** True from the moment the user's finger/wheel starts panning the mobile timeline until its scroll
   *  (momentum fling included) has settled. While set, the playhead-follow effect must not write
   *  `scrollLeft` — the user's own gesture is the source of truth, and fighting it every frame is what
   *  made the timeline impossible to move during playback. */
  const panningRef = useRef(false);
  /** Whether playback was running when the current pan/scrub began, so it can pick up again at the
   *  new position afterwards instead of leaving the user paused. */
  const resumeAfterInteractionRef = useRef(false);
  const settleTimerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
    },
    []
  );
  /** Pauses playback for the duration of a drag: a moving playhead under a finger/cursor that's also
   *  moving it is a tug-of-war (the marker jitters, and on mobile the view can't be moved at all). The
   *  gesture owns the playhead until it ends, then `endInteraction` resumes from wherever it landed. */
  const beginInteraction = useCallback(() => {
    if (settleTimerRef.current !== null) {
      window.clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
    const state = useEditorStore.getState();
    if (state.playing && !resumeAfterInteractionRef.current) {
      resumeAfterInteractionRef.current = true;
      state.setPlaying(false);
    }
  }, []);
  const endInteraction = useCallback(() => {
    panningRef.current = false;
    settleTimerRef.current = null;
    if (!resumeAfterInteractionRef.current) return;
    resumeAfterInteractionRef.current = false;
    const state = useEditorStore.getState();
    // Dragged to (or flung past) the very end: nothing left to play, and `togglePlay`-style rewind
    // isn't wanted here — the user just parked the playhead there.
    const end = state.project ? sequenceDuration(state.project) : 0;
    if (state.playhead < end - 1e-6) state.setPlaying(true);
  }, []);
  /** (Re)arms the "scroll has settled" timer: mobile panning ends once no scroll event has arrived for a
   *  moment after the finger lifts, which covers momentum flings — `touchend` alone fires while the view
   *  is still gliding. */
  const armSettle = useCallback(() => {
    if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = window.setTimeout(endInteraction, 160);
  }, [endInteraction]);
  const fingerDownRef = useRef(false);
  const lastScrollLeftRef = useRef(0);
  /** Pending rAF id for the scroll container's own handler below — coalesces `setScrollLeft` to at
   *  most once per animation frame. See that handler's own comment for why this matters. */
  const scrollRafRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current);
    },
    []
  );

  // A recording still in progress can push past the committed timeline length before it's a real
  // clip `sequenceDuration` would count — folded in here (mirroring `setPlayhead`'s own same fix) so
  // the lane area/ruler don't stay narrower than the indicator actually growing inside them.
  const total = Math.max(project ? sequenceDuration(project) : 0, recording ? recording.start + recording.elapsedSeconds : 0);
  const contentSeconds = Math.max(total + TRAILING_SECONDS, 30);
  // Never narrower than the viewport: zoomed far out, `contentSeconds * pixelsPerSecond` can be a sliver
  // of the visible lanes area, and the ruler (a block child of this width) is what receives the scrub
  // press — so the empty stretch beside it was dead space where clicking/dragging couldn't move the
  // playhead. Desktop only: mobile scrolls instead, and gets `trailingPad` (below).
  const contentWidth = Math.max(contentSeconds * pixelsPerSecond, isMobile ? 0 : viewportWidth);
  // The lanes viewport's own center IS the screen's center on mobile — unlike desktop, there's no
  // fixed track-headers sidebar stealing width from it (track headers scroll WITH the clips on mobile
  // instead, as inline chips — see the per-row header render below), so `scrollRef`'s measured
  // `viewportWidth` already reflects the true full screen width with nothing to correct for. (This
  // used to subtract `HEADER_WIDTH / 2` to compensate for that sidebar — removed along with the
  // sidebar itself; keeping the old correction here would now be actively wrong, not just redundant.)
  // Only ever read from `isMobile`-gated branches below, so it's harmless that desktop never uses it.
  const centerOffset = viewportWidth / 2;
  // Mobile-only empty space kept BEFORE time 0 — the mirror image of TRAILING_SECONDS' own reasoning,
  // for a problem that only exists in fixed-center-playhead mode: native `scrollLeft` can never go
  // negative, so without this, the marker (drawn at `scrollLeft + centerOffset`) can't actually reach
  // screen-center for any playhead time under `centerOffset / pixelsPerSecond` seconds — it visually
  // sits wherever `scrollLeft` clamps to 0 lands instead, over a LATER time than the readout actually
  // shows. Sized to exactly `centerOffset` — precisely enough room for `scrollLeft = 0` to correspond
  // to `playhead = 0` sitting dead center (see `timeFromEvent`'s own comment on how this cancels out of
  // the playhead↔scrollLeft formulas elsewhere in this file). Implemented as a `marginLeft` on an inner
  // wrapper (see the JSX below) rather than CSS padding on the scrollable div itself — padding doesn't
  // shift absolutely-positioned descendants (they're positioned from the padding edge, not the content
  // edge), so it wouldn't actually move the ruler/clips/markers at all.
  const leadingPad = isMobile ? centerOffset : 0;
  // Mobile-only empty space kept AFTER the content, the mirror image of `leadingPad`. In fixed-center
  // mode the playhead only moves by SCROLLING, and reaching time `t` needs `scrollLeft = t * pps`, i.e. a
  // scroll range of at least `contentWidth`, which means `scrollWidth >= leadingPad + contentWidth +
  // centerOffset`. Without it, zoomed far out (content narrower than the screen) there was NO scroll
  // range at all, so scrubbing/playing couldn't move the playhead — it sat frozen at its start.
  const trailingPad = isMobile ? centerOffset : 0;
  const scrollableWidth = contentWidth + leadingPad + trailingPad;

  // Sorted/clamped the same way the store's own `exportRange()` getter does (see that method's own
  // comment) — kept in sync by hand rather than calling it, since this needs to be a REACTIVE value
  // derived from the two primitive selectors above, not a fresh object allocated on every call.
  const hasExportRange = exportRangeStart !== null || exportRangeEnd !== null;
  const rawRangeStart = Math.min(Math.max(0, exportRangeStart ?? 0), total);
  const rawRangeEnd = Math.min(Math.max(0, exportRangeEnd ?? total), total);
  const exportStart = Math.min(rawRangeStart, rawRangeEnd);
  const exportEnd = Math.max(rawRangeStart, rawRangeEnd);

  const assetNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const asset of project?.assets ?? []) map.set(asset.id, asset.name);
    return map;
  }, [project?.assets]);

  /** Converts a pointer position anywhere in the scrollable lane area to a timeline time. `-
   *  leadingPad`: the ruler/clips/everything-but-the-playhead now sit `leadingPad` px further right
   *  than their own `X * pixelsPerSecond` position would suggest (see that constant's own comment on
   *  why), so a raw scroll-container-relative offset overshoots by exactly that much — zero on
   *  desktop, where `leadingPad` is always 0. */
  const timeFromEvent = useCallback(
    (clientX: number): number => {
      const container = scrollRef.current;
      if (!container) return 0;
      const rect = container.getBoundingClientRect();
      return timelineTimeAtClientX({
        clientX,
        viewportLeft: rect.left,
        scrollLeft: container.scrollLeft,
        leadingPad,
        pixelsPerSecond,
      });
    },
    [pixelsPerSecond, leadingPad]
  );

  const zoomTo = useCallback(
    (requested: number, clientX?: number) => {
      const next = clampTimelineZoom(requested);
      if (Math.abs(next - pixelsPerSecond) < 1e-9) return;
      const container = scrollRef.current;
      if (container) {
        const rect = container.getBoundingClientRect();
        const anchorClientX = isMobile ? rect.left + centerOffset : (clientX ?? rect.left + rect.width / 2);
        zoomAnchorRef.current = { time: timeFromEvent(anchorClientX), clientX: anchorClientX };
      }
      setPixelsPerSecond(next);
    },
    [pixelsPerSecond, isMobile, centerOffset, timeFromEvent, setPixelsPerSecond]
  );

  /** Zooms by `factor`, keeping the time at `clientX` (defaulting to the center of the visible
   *  scroll area, for a keyboard shortcut or button click with no cursor position to anchor to)
   *  stationary on screen. Recording the anchor and correcting `scrollLeft` in a layout effect AFTER
   *  the new `pixelsPerSecond` has rendered — rather than trying to compute the corrected scroll
   *  position up front — is what avoids a visible flash of the wrong scroll position, since
   *  `contentWidth` (which `scrollLeft` is clamped against) only exists once the new width is committed.
   *
   *  Below `lg`, `clientX` is IGNORED in favor of the SCREEN's center (`centerOffset`, not the lanes
   *  viewport's own center — see that constant's own comment) regardless of what a caller passes (e.g.
   *  a real pinch midpoint) — the playhead is pinned there in mobile mode (see the playhead-follow
   *  effect below), so zooming around anything else would zoom around a point that isn't actually
   *  "now," fighting the fixed-playhead model instead of matching it. This also means the layout effect
   *  below ends up computing the exact same `scrollLeft` the mobile centering effect would anyway, so
   *  the two never fight each other after a zoom. */
  const zoomAround = useCallback(
    (factor: number, clientX?: number) => {
      zoomTo(pixelsPerSecond * factor, clientX);
    },
    [zoomTo, pixelsPerSecond]
  );

  useLayoutEffect(() => {
    const anchor = zoomAnchorRef.current;
    const container = scrollRef.current;
    zoomAnchorRef.current = null;
    if (!anchor || !container) return;
    const rect = container.getBoundingClientRect();
    // `+ leadingPad`: the inverse of `timeFromEvent`'s own `- leadingPad` — without it this would
    // land `leadingPad` px short of where `anchor.time` is actually drawn now that the ruler/clips
    // sit that far right of their raw `X * pixelsPerSecond` position (zero on desktop).
    container.scrollLeft = timelineScrollLeftForAnchor({
      time: anchor.time,
      clientX: anchor.clientX,
      viewportLeft: rect.left,
      leadingPad,
      pixelsPerSecond,
    });
  }, [pixelsPerSecond, leadingPad]);

  // Ctrl/⌘+wheel zooms, matching the convention in every timeline tool; a plain wheel keeps its
  // normal scroll behavior. Anchored on the cursor, not the left edge of the view, so the point under
  // the mouse stays put — the difference between zoom feeling responsive and feeling like the
  // timeline randomly jumps around underneath you.
  //
  // A NATIVE listener with `{ passive: false }`, not React's `onWheel` prop, because React 17+
  // attaches wheel/touch listeners passively at the root by default for scroll performance — calling
  // `preventDefault()` from a JSX `onWheel` handler throws "Unable to preventDefault inside passive
  // event listener invocation" and, worse, silently does NOTHING, so the browser's native scroll
  // would still fire alongside the zoom.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    function onWheel(e: WheelEvent) {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomAround(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX);
    }
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, [zoomAround]);

  // Two-finger pinch zooms the timeline, anchored at the midpoint between the fingers — the gesture
  // every mobile video editor uses for this, and the only zoom
  // affordance on a phone before this: the header's +/− buttons work but are a poor substitute for
  // the gesture people actually reach for first on a touchscreen. Reuses `zoomAround`'s existing
  // anchor mechanism (built for desktop's cursor-anchored Ctrl+wheel) unchanged — a pinch just
  // supplies its midpoint as the anchor `clientX` instead of the cursor's.
  //
  // A NATIVE listener with `{ passive: false }`, same reasoning as the wheel listener above — React's
  // synthetic touch handlers are passive by default, so `preventDefault()` from a JSX `onTouchMove`
  // would silently do nothing and let the browser's own page-zoom fire alongside this.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    // Distance between the two touches as of the last processed move — each subsequent move scales by
    // the RATIO since then (not since gesture start), composing into `cumulativeScale` below.
    let lastDistance = 0;
    // The gesture's own TOTAL scale since `touchstart`, applied live as a cheap CSS `transform` (see
    // `flush` below) rather than committed to the real `pixelsPerSecond` on every frame — a real,
    // reported performance bug, not just a theoretical one: `pixelsPerSecond` drives every clip's own
    // `left`/`width`, so writing it on every animation frame during a pinch forces a full-timeline
    // browser LAYOUT (not just a React re-render) that many frames a second, measured as genuinely
    // janky on real, slower Android hardware. `transform: scaleX()` is GPU-composited — no layout at
    // all — so the live gesture stays smooth regardless of clip count or device speed; the real,
    // expensive `zoomAround` commit (see `onTouchEnd`) happens exactly ONCE, when fingers lift.
    let cumulativeScale = 1;
    let pendingFactor = 1;
    let pendingMidX = 0;
    let hasPending = false;
    let rafId: number | null = null;

    function flush() {
      rafId = null;
      if (!hasPending) return;
      hasPending = false;
      cumulativeScale *= pendingFactor;
      pendingFactor = 1;
      const content = contentRef.current;
      if (!content) return;
      // `transform-origin` re-anchored to the CURRENT midpoint every frame, same "follow the fingers"
      // feel `zoomAround`'s own per-frame anchor used to give when it ran every frame — a later
      // `transform-origin` change only affects scaling from that point forward, so this doesn't
      // retroactively move anything already drawn, just keeps matching where the gesture is NOW.
      // Local to `contentRef`'s OWN box (not the viewport, and not the outer scrollable div either —
      // `contentRef` is the `marginLeft: leadingPad` div, see its own comment): `transform-origin` is
      // relative to the element being transformed, so the midpoint's client-space X has to be re-based
      // through the scroll container's own rect, its current `scrollLeft`, AND `leadingPad` itself —
      // `contentRef`'s own local zero sits `leadingPad` px into the scroll container, not at its edge.
      // Non-null assertion, not a real possible-null case — same reasoning `onTouchStart`'s own
      // identical assertion below documents (a sibling function declaration's own body doesn't
      // inherit this outer scope's already-checked non-null narrowing).
      const rect = container!.getBoundingClientRect();
      content.style.transformOrigin = `${pendingMidX - rect.left + container!.scrollLeft - leadingPad}px 0`;
      content.style.transform = `scaleX(${cumulativeScale})`;
    }

    function distanceAndMidpoint(touches: TouchList): { distance: number; midX: number } {
      const [a, b] = [touches[0], touches[1]];
      return { distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), midX: (a.clientX + b.clientX) / 2 };
    }

    function onTouchStart(e: TouchEvent) {
      if (e.touches.length !== 2) return;
      lastDistance = distanceAndMidpoint(e.touches).distance;
      cumulativeScale = 1;
      // `pan-x pan-y` (this container's own JSX-set default — see its own comment) is what makes
      // ordinary single-finger scrolling native and smooth, but confirmed LIVE to also be permissive
      // enough that a real two-finger touch on it still sometimes gets claimed by the browser's own
      // native scroll handling instead of ever reaching `onTouchMove` below as a preventable event —
      // `pinch-zoom` being absent from the allowed list stops the browser's dedicated PINCH gesture,
      // but doesn't stop it from treating two simultaneous contacts as "two independent pans" under
      // `pan-x`/`pan-y` themselves on at least some WebKit versions. Switching to `none` the INSTANT a
      // second finger is confirmed down (before any movement has happened — this has to land before
      // the browser commits to handling the gesture, which on iOS means at `touchstart`, not
      // `touchmove`) hands the whole gesture to JS for as long as two fingers stay down, restored the
      // moment they don't (see `onTouchEnd`) so ordinary one-finger scrolling is completely unaffected
      // outside an actual pinch. A direct DOM mutation, not a React state change driving the JSX
      // `style` prop — same imperative-style-write precedent `headerListRef`'s own scroll-sync
      // transform already uses elsewhere in this file, for the same reason: this needs to happen
      // synchronously inside the touch handler itself, not wait on a render.
      // Non-null assertion, not a real possible-null case: `container` is `const` (never reassigned)
      // and already guarded non-null at the top of this effect — TypeScript just doesn't carry that
      // narrowing into a sibling function DECLARATION's own body the way it would for a plain read.
      container!.style.touchAction = "none";
    }
    function onTouchMove(e: TouchEvent) {
      if (e.touches.length !== 2 || lastDistance === 0) return;
      e.preventDefault();
      const { distance, midX } = distanceAndMidpoint(e.touches);
      pendingFactor *= distance / lastDistance;
      pendingMidX = midX;
      hasPending = true;
      lastDistance = distance;
      if (rafId === null) rafId = requestAnimationFrame(flush);
    }
    function onTouchEnd(e: TouchEvent) {
      if (e.touches.length < 2) {
        lastDistance = 0;
        container!.style.touchAction = "pan-x pan-y";
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
        if (cumulativeScale !== 1) {
          const finalScale = cumulativeScale;
          const finalMidX = pendingMidX;
          cumulativeScale = 1;
          hasPending = false;
          // The ONE real commit for the whole gesture — a full-timeline layout, but only once, not
          // once per frame. Reuses `zoomAround`'s own existing anchor mechanism (the same one desktop's
          // Ctrl+wheel zoom already relies on) so the just-lifted anchor point stays visually
          // stationary once the REAL layout replaces the transform-scaled preview.
          zoomAround(finalScale, finalMidX);
          // The transform stays applied, frozen at its final gesture value, until the new committed
          // layout has actually painted — clearing it immediately would flash back to the OLD,
          // not-yet-updated `left`/`width` values for a frame first. Two RAFs (not one): the first
          // fires once React's own commit for the just-dispatched store update has happened, but
          // isn't guaranteed to be PAINTED yet on every engine; the second guarantees a real paint
          // has occurred. Not gated on whether `pixelsPerSecond` actually changed — right at the
          // store's own [4,400] clamp boundary a pinch can commit to the SAME value, and this still
          // needs to clear the transform either way, or it would stay stuck applied forever.
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              const content = contentRef.current;
              if (content) {
                content.style.transform = "";
                content.style.transformOrigin = "";
              }
            });
          });
        }
      }
    }

    container.addEventListener("touchstart", onTouchStart, { passive: true });
    container.addEventListener("touchmove", onTouchMove, { passive: false });
    container.addEventListener("touchend", onTouchEnd, { passive: true });
    container.addEventListener("touchcancel", onTouchEnd, { passive: true });
    return () => {
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("touchmove", onTouchMove);
      container.removeEventListener("touchend", onTouchEnd);
      container.removeEventListener("touchcancel", onTouchEnd);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [zoomAround, leadingPad]);

  // Keyboard shortcuts (Ctrl/⌘ +/-/0) live in VCutApp's global keydown handler, which has no
  // access to this component's scroll container — it dispatches this event instead of calling the
  // store directly, so a keyboard-triggered zoom gets the same cursor-anchoring treatment (anchored
  // on the viewport center, since a keypress has no cursor position) as the mouse-driven paths below.
  useEffect(() => {
    function onZoomEvent(event: Event) {
      const detail = (event as CustomEvent<{ factor?: number; reset?: boolean }>).detail;
      if (detail.reset) zoomTo(DEFAULT_TIMELINE_PIXELS_PER_SECOND);
      else if (detail.factor) zoomAround(detail.factor);
    }
    window.addEventListener("vcut:zoom", onZoomEvent);
    return () => window.removeEventListener("vcut:zoom", onZoomEvent);
  }, [zoomAround, zoomTo]);

  /** Whether `track` should render at `EMPTY_TRACK_HEIGHT` instead of `TRACK_HEIGHT` — mobile only.
   *  Two independent reasons a track qualifies: it's truly empty (a track with an in-progress
   *  voiceover recording has no COMMITTED clip yet — `clips.length === 0` — but very much has
   *  something visible that needs the full row to show, so that specific case is excluded here rather
   *  than shrinking the row out from under it mid-take), or it's a TEXT track — captions/titles are
   *  typically numerous and, unlike a video/audio clip, `TimelineClip`'s own text-clip rendering has
   *  nothing that needs real vertical room to stay usable (no waveform, no thumbnail strip), so a text
   *  track stays compact regardless of how many clips are on it, freeing real editing space for the
   *  video/audio tracks actually being worked against. Confirmed a deliberate, requested trade — not
   *  extended to audio tracks (which keep their normal height once populated), since those often carry
   *  controls/information worth the extra room. */
  const isTrackCompact = useCallback(
    (track: Track): boolean =>
      isMobile && !(recording && recording.trackId === track.id) && (track.clips.length === 0 || track.kind === "text"),
    [isMobile, recording]
  );

  /** Every real track (unchanged), OR — for every track sharing one `Track.templateGroup.id` — a SINGLE
   *  synthetic row standing in for all of them (see `TemplateGroupRow.tsx`'s own doc comment for why).
   *  Built once per render off `project.sequence.tracks` and consumed everywhere a "how many rows, how
   *  tall" question comes up (both render passes below, plus `resolveTrackAt`), so those two things can
   *  never disagree with each other about how many rows there actually are. */
  interface TrackDisplayRow {
    type: "track";
    track: Track;
  }
  interface GroupDisplayRow {
    type: "group";
    groupId: string;
    name: string;
    tracks: Track[];
  }
  const displayRows = useMemo((): (TrackDisplayRow | GroupDisplayRow)[] => {
    const tracks = project?.sequence.tracks;
    if (!tracks) return [];
    const rows: (TrackDisplayRow | GroupDisplayRow)[] = [];
    const seenGroups = new Set<string>();
    for (const track of tracks) {
      const group = track.templateGroup;
      if (!group) {
        rows.push({ type: "track", track });
        continue;
      }
      if (seenGroups.has(group.id)) continue;
      seenGroups.add(group.id);
      rows.push({ type: "group", groupId: group.id, name: group.name, tracks: tracks.filter((t) => t.templateGroup?.id === group.id) });
    }
    return rows;
  }, [project?.sequence.tracks]);

  const rowHeight = useCallback(
    (row: TrackDisplayRow | GroupDisplayRow): number => (row.type === "group" ? TRACK_HEIGHT : isTrackCompact(row.track) ? EMPTY_TRACK_HEIGHT : TRACK_HEIGHT),
    [isTrackCompact]
  );

  /** Which track row a vertical pointer position falls on — a running sum of each ROW's own height
   *  (see `displayRows` above) rather than a single division, since rows are no longer all `TRACK_HEIGHT`
   *  tall below `lg` (an empty track is shorter — see `isTrackCompact`) NOR one row per real track (a
   *  collapsed template group is one row for several). A collapsed group's own row resolves to `null` —
   *  dropping media directly onto its summary bar isn't supported; the "Edit template" panel is the only
   *  way into its contents. */
  const resolveTrackAt = useCallback(
    (clientY: number): string | null => {
      const lanes = lanesRef.current;
      if (!lanes) return null;
      let y = clientY - lanes.getBoundingClientRect().top;
      if (y < 0) return null;
      for (const row of displayRows) {
        const h = rowHeight(row);
        if (y < h) return row.type === "group" ? null : row.track.id;
        y -= h;
      }
      return null;
    },
    [displayRows, rowHeight]
  );

  /** Whether a screen point falls on the "add track" row rendered right after the last real track
   *  (see `AddTrackRow`) — checked by the row's own bounding rect rather than summed track heights,
   *  since it's a real element laid out in normal flow immediately below them either way. */
  const isOverNewTrackRow = useCallback((clientY: number): boolean => {
    const rect = newTrackRowRef.current?.getBoundingClientRect();
    if (!rect) return false;
    return clientY >= rect.top && clientY < rect.bottom;
  }, []);

  // Registered into the store so MediaLibrary's own touch drag (native HTML5 drag-and-drop never
  // fires from touch input) can hit-test its drop point against these tracks on release, without
  // MediaLibrary needing to know anything about this component's scroll offset or row layout — see
  // `assetDrag`/`resolveTimelineDropTarget`'s own doc comments in editorStore.ts.
  useEffect(() => {
    setResolveTimelineDropTarget((clientX, clientY, assetId) => {
      const trackId = resolveTrackAt(clientY);
      if (trackId) return { trackId, time: Math.max(0, timeFromEvent(clientX)) };
      // Dropped below every real track, on the "add track" row itself: create a track of whichever
      // kind the dropped asset actually belongs on (same mapping `addClip` itself enforces — see
      // `trackKindForAsset`'s own comment) and land the clip there, so a drag can create a track AND
      // place the clip in one gesture rather than needing the picker tapped first.
      if (!assetId || !project || !isOverNewTrackRow(clientY)) return null;
      const asset = project.assets.find((a) => a.id === assetId);
      if (!asset) return null;
      const command = new AddTrackCommand(trackKindForAsset(asset));
      run(command);
      return { trackId: command.trackId, time: Math.max(0, timeFromEvent(clientX)) };
    });
    return () => setResolveTimelineDropTarget(null);
  }, [resolveTrackAt, isOverNewTrackRow, timeFromEvent, setResolveTimelineDropTarget, project, run]);

  // Moves the playhead marker and updates the ruler's aria-valuenow by writing directly to the DOM,
  // rather than through a `useEditorStore((s) => s.playhead)` selector. `PlaybackEngine` updates
  // `playhead` on every animation frame during playback — subscribing to it reactively here would
  // re-render this ENTIRE component, including every track and every `TimelineClip`, 30-60 times a
  // second, which is real, measurable jank competing with the preview's own canvas draw. Zustand's
  // core `subscribe` (no middleware here) has no selector overload, so the diff against the previous
  // value is done by hand.
  useEffect(() => {
    function apply(playhead: number) {
      const container = scrollRef.current;
      if (rulerRef.current) rulerRef.current.setAttribute("aria-valuenow", String(playhead));

      if (isMobile) {
        // Fixed-center playhead: the marker's on-screen position never depends on `playhead` at all —
        // it's always the SCREEN's own center (`centerOffset`, not the lanes viewport's own center —
        // see that constant's own comment) — so the ONLY thing that needs to move is the timeline
        // underneath it. Unconditional — NOT gated behind `isScrubbingRef` the way desktop's own
        // auto-follow below is. That gate exists there to avoid fighting a JARRING discrete jump
        // (snap-to-left-edge) mid-drag; mobile's own re-centering is a smooth continuous follow, not a
        // jump, so skipping it during a ruler-scrub bought nothing — worse, it left the view stuck
        // un-scrolled once the scrub released (nothing re-triggers `apply()` when `playhead` stops
        // changing), which is its own "why hasn't this caught up" bug. Always keeping marker and scroll
        // in lockstep, scrub included, is both simpler and the more literal reading of "the playhead
        // never moves" — there's no gap where it's frozen mid-interaction waiting to catch up later.
        //
        // Drawn from `target` (the scroll position THIS frame is correcting TOWARD), not the
        // not-yet-updated `container.scrollLeft` — reading the old value here was a confirmed real bug:
        // during playback, `apply()` runs on every animation frame, and drawing from the stale
        // pre-correction `scrollLeft` made the marker's own drawn position lag the scroll correction
        // below by exactly one frame, every frame — a continuous 1-2px micro-jitter rather than a truly
        // motionless marker. `target` is what `scrollLeft` already equals or is about to become, so
        // using it for BOTH the marker draw and the scroll correction keeps them perfectly in sync,
        // with zero lag, every frame — the marker genuinely never moves once centered.
        if (container) {
          // `+ leadingPad`: same inverse-of-`timeFromEvent` adjustment as the zoom-correction effect
          // above — `playhead * pixelsPerSecond` alone is where `playhead` would sit with NO leading
          // pad; the ruler/clips actually start `leadingPad` px later than that now, so the scroll
          // target needs to shift by the same amount to land the marker on the right spot.
          const target = Math.max(
            0,
            Math.min(playhead * pixelsPerSecond - centerOffset + leadingPad, container.scrollWidth - container.clientWidth)
          );
          if (markerRef.current) markerRef.current.style.left = `${target + centerOffset}px`;
          if (!panningRef.current && Math.abs(container.scrollLeft - target) > 0.5) {
            programmaticScrollRef.current = true;
            container.scrollLeft = target;
            requestAnimationFrame(() => {
              programmaticScrollRef.current = false;
            });
          }
        }
        return;
      }

      markerRef.current && (markerRef.current.style.left = `${playhead * pixelsPerSecond}px`);

      // Auto-follow (desktop only): once the playhead scrolls past the right edge of the visible
      // timeline (during playback, or a big jump like "Go to end"), snap the view forward so it
      // reappears at the LEFT edge — matching Premiere/Resolve rather than a smooth continuous scroll,
      // which would fight the viewport's own width by constantly re-centering. The mirror image
      // handles a jump the OTHER way — "Go to start", or clicking far back on the ruler/a keyframe nav
      // button while scrolled forward — which used to leave the view sitting wherever it already was,
      // with the playhead now off-screen to the left and nothing visibly following it: confirmed real
      // bug, not just a hypothetical gap in the (already asymmetric-looking) right-edge-only comment
      // above. Snaps the view BACK so the playhead reappears at the RIGHT edge, the same "opposite
      // edge" convention the forward case already uses — for `playhead = 0` specifically this clamps
      // straight to `scrollLeft = 0`, so "Go to start" always lands on the true beginning of the
      // timeline, not just "somewhere the playhead happens to be visible". Skipped entirely while the
      // user is dragging the ruler themselves (`isScrubbingRef`): their own cursor position IS the
      // reference point during a manual scrub, so jumping the view out from under it mid-drag would be
      // actively disorienting rather than helpful.
      if (container && !isScrubbingRef.current) {
        const playheadPx = playhead * pixelsPerSecond;
        const leftEdge = container.scrollLeft;
        const rightEdge = container.scrollLeft + container.clientWidth;
        if (playheadPx > rightEdge) {
          container.scrollLeft = Math.max(0, Math.min(playheadPx, container.scrollWidth - container.clientWidth));
        } else if (playheadPx < leftEdge) {
          container.scrollLeft = Math.max(0, Math.min(playheadPx - container.clientWidth, container.scrollWidth - container.clientWidth));
        }
      }
    }
    apply(useEditorStore.getState().playhead);
    return useEditorStore.subscribe((state, prev) => {
      if (state.playhead !== prev.playhead) apply(state.playhead);
    });
  }, [pixelsPerSecond, isMobile, viewportWidth]);

  /** Press-then-drag anywhere on the ruler scrubs continuously — the interaction people reach for
   *  without being taught it, mouse OR touch (see `pointerEvents.ts`). */
  const scrub = useCallback(
    (event: React.MouseEvent | React.TouchEvent) => {
      isScrubbingRef.current = true;
      beginInteraction();
      const start = clientPoint(event);
      setPlayhead(timeFromEvent(start.x));
      setHoverX(start.x);
      const remove = addDragListeners(
        (moveEvent) => {
          const point = clientPoint(moveEvent);
          setPlayhead(timeFromEvent(point.x));
          setHoverX(point.x);
        },
        () => {
          isScrubbingRef.current = false;
          remove();
          endInteraction();
          // Touch has no hover state to fall back to afterward — a finger lifted off the ruler leaves
          // no cursor sitting there the way a mouse would, so the tooltip has nothing left to track.
          if ("touches" in event) setHoverX(null);
        }
      );
    },
    [setPlayhead, timeFromEvent, beginInteraction, endInteraction]
  );

  /** Drag either export-range flag to nudge it — the fine-adjustment half of the "I/O sets it at the
   *  playhead, drag refines it" pair (see `VCutApp.tsx`'s own `I`/`O` shortcut handlers for the
   *  other half). `stopPropagation` keeps this from ALSO registering as a `scrub` press on the ruler
   *  underneath it, which would yank the playhead to the same spot the instant you grab the flag. */
  const scrubExportStart = useCallback(
    (event: React.MouseEvent | React.TouchEvent) => {
      event.stopPropagation();
      const point = clientPoint(event);
      setExportRangeStart(timeFromEvent(point.x));
      const remove = addDragListeners(
        (moveEvent) => setExportRangeStart(timeFromEvent(clientPoint(moveEvent).x)),
        () => remove()
      );
    },
    [setExportRangeStart, timeFromEvent]
  );
  const scrubExportEnd = useCallback(
    (event: React.MouseEvent | React.TouchEvent) => {
      event.stopPropagation();
      const point = clientPoint(event);
      setExportRangeEnd(timeFromEvent(point.x));
      const remove = addDragListeners(
        (moveEvent) => setExportRangeEnd(timeFromEvent(clientPoint(moveEvent).x)),
        () => remove()
      );
    },
    [setExportRangeEnd, timeFromEvent]
  );

  // Persistent horizontal scrollbar geometry — the track spans the scroll viewport's own width, and
  // the thumb's size/position are the standard scrollbar ratios against `contentWidth`. Floored at
  // 24px so the thumb never shrinks to an ungrabbable sliver on a long edit at low zoom. When there's
  // nothing to scroll (`contentWidth <= viewportWidth`), the thumb simply fills the track and dragging
  // is a no-op (`scrollableTrack` floors at 1 to keep the ratio math from dividing by zero).
  const maxScrollLeft = Math.max(0, scrollableWidth - viewportWidth);
  const thumbWidth =
    scrollableWidth > 0 ? Math.max(24, Math.min(viewportWidth, (viewportWidth / scrollableWidth) * viewportWidth)) : viewportWidth;
  const scrollableTrack = Math.max(1, viewportWidth - thumbWidth);
  const thumbLeft = maxScrollLeft > 0 ? (scrollLeft / maxScrollLeft) * scrollableTrack : 0;

  function scrollTo(next: number) {
    const clamped = Math.min(maxScrollLeft, Math.max(0, next));
    if (scrollRef.current) scrollRef.current.scrollLeft = clamped;
    setScrollLeft(clamped);
  }

  /** Dragging the thumb itself — pointer-pixel delta converted to scroll-pixel delta via the same
   *  ratio the thumb's own size already encodes (a `scrollableTrack`-pixel drag covers the FULL
   *  `maxScrollLeft` range, same as any native scrollbar). */
  function beginScrollbarThumbDrag(event: React.MouseEvent | React.TouchEvent) {
    event.stopPropagation();
    const start = clientPoint(event);
    const startScrollLeft = scrollLeft;
    const remove = addDragListeners(
      (moveEvent) => {
        const point = clientPoint(moveEvent);
        scrollTo(startScrollLeft + (point.x - start.x) * (maxScrollLeft / scrollableTrack));
      },
      () => remove()
    );
  }

  /** Clicking the TRACK itself (not the thumb, which stops propagation before this ever fires) jumps
   *  straight there — the thumb re-centers on the click position, the same "click to jump" affordance
   *  a native scrollbar's track gives you. */
  function jumpScrollbarTrack(event: React.MouseEvent) {
    const rect = event.currentTarget.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    scrollTo(maxScrollLeft * ((clickX - thumbWidth / 2) / scrollableTrack));
  }

  /** On-screen (client-pixel) rectangle of an in-progress marquee drag, or `null` when none is active —
   *  drawn as a `position: fixed` overlay below, and also what `beginMarquee`'s own hit test compares
   *  each clip's live `getBoundingClientRect()` against. Screen space, not timeline/time space,
   *  deliberately: clip positions already account for scroll offset, zoom, and (on mobile) the
   *  fixed-center-playhead leading pad automatically the instant you ask the DOM where an element
   *  really is — reimplementing that same math by hand here would be a second place for it to drift
   *  out of sync with the real layout. */
  const [marquee, setMarquee] = useState<{ startX: number; startY: number; x: number; y: number } | null>(null);
  /** Set for exactly one click right after a REAL marquee drag (one that crossed the move threshold)
   *  finishes — see `beginMarquee`'s own `onUp` for why. The browser still fires a plain "click" event
   *  after this drag's mouseup regardless of how far the pointer traveled or where it ends up, and that
   *  click bubbles to this same lane background's own `onClick={() => select([])}` below — without this
   *  guard, every completed marquee selection was being wiped out the instant the mouse was released,
   *  which is the whole reason marquee-select could look "broken" despite the drag itself, and its live
   *  selection-growing, working correctly the entire time (confirmed directly: `select(...)` during the
   *  drag was already hitting the right clips). */
  const justMarqueedRef = useRef(false);

  /** Press-and-drag on empty lane space (mouse only — see below) to select every clip whose on-screen
   *  box the resulting rectangle touches, live as the rectangle grows — the Timeline counterpart to
   *  drag-selecting several files in a folder view. Normally only reaches this handler for a press that
   *  ISN'T on a clip: `TimelineClip`'s own `onMouseDown` (see its own `beginDrag`) `stopPropagation()`s
   *  before a plain press there could bubble up here, the same way it already keeps a clip-drag from
   *  also registering as the lane background's plain "click to deselect". The one deliberate exception
   *  is Alt+drag STARTING on a clip's body — `beginDrag` skips its own interception entirely for that
   *  gesture and lets it bubble up here untouched, since a track packed edge-to-edge with clips would
   *  otherwise leave nowhere empty to start a marquee from at all.
   *
   *  Mouse-only, no touch equivalent: a touch-drag on empty lane space is how someone pans/scrolls the
   *  timeline (see the scroll container's own `touchAction` comment) — hijacking that same gesture for
   *  marquee-select on touch would make ordinary scrolling ambiguous with selecting, which is worse
   *  than not offering the feature there at all. Touch already has its own multi-select gesture
   *  (`TimelineClip`'s long-press-to-toggle). */
  function beginMarquee(event: React.MouseEvent) {
    if (event.button !== 0) return;
    preventDefaultIfMouse(event);
    const start = clientPoint(event);
    // Shift OR Ctrl/Cmd held at the START of the drag extends the CURRENT selection rather than
    // replacing it — matching the modifier convention `TimelineClip`'s own additive click already
    // uses (Ctrl/Cmd there), plus Shift (the more common "extend a range/area selection" modifier in
    // file browsers and design tools, which a marquee is closer to than a single click is).
    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    const baseSelection = additive ? selectedClipIds : [];
    // Snapshotted once at drag start, not re-queried on every move — cheap enough given a timeline's
    // realistic clip count, and avoids paying `querySelectorAll` several dozen times a second while
    // dragging. Each clip's own RECT, in contrast, genuinely does need re-reading every move (that's
    // the whole point — the rectangle comparison below needs where it is RIGHT NOW).
    const clipEls = lanesRef.current ? Array.from(lanesRef.current.querySelectorAll<HTMLElement>("[data-clip-id]")) : [];
    let moved = false;

    const remove = addDragListeners(
      (moveEvent) => {
        const point = clientPoint(moveEvent);
        if (!moved) {
          if (Math.hypot(point.x - start.x, point.y - start.y) < MARQUEE_DRAG_THRESHOLD) return;
          moved = true;
        }
        setMarquee({ startX: start.x, startY: start.y, x: point.x, y: point.y });

        const left = Math.min(start.x, point.x);
        const right = Math.max(start.x, point.x);
        const top = Math.min(start.y, point.y);
        const bottom = Math.max(start.y, point.y);

        const hitIds: string[] = [];
        for (const el of clipEls) {
          const rect = el.getBoundingClientRect();
          if (rect.left < right && rect.right > left && rect.top < bottom && rect.bottom > top) {
            const id = el.dataset.clipId;
            if (id) hitIds.push(id);
          }
        }
        select([...new Set([...baseSelection, ...hitIds])]);
      },
      () => {
        remove();
        setMarquee(null);
        // A press that never crossed the threshold falls through to the lane background's own
        // `onClick={() => select([])}` (a real `click` event still fires after this `mouseup`,
        // untouched by anything here) — so a plain click still deselects exactly as it always has.
        // A press that DID cross the threshold (a real marquee) sets this one-shot guard instead, so
        // that SAME native click — which still fires here too, regardless of how far the drag
        // traveled — doesn't immediately wipe out the selection this drag just made.
        if (moved) justMarqueedRef.current = true;
      }
    );
  }

  /** Turns "dropped `sourceId` before/after `targetId`" into the `beforeTrackId` `ReorderTrackCommand`
   *  actually wants — "after `targetId`" means "before whatever CURRENTLY comes right after it", which
   *  only Timeline can resolve since it's the one holding the ordered track list. */
  function dropTrackOnRow(sourceId: string, targetId: string, position: "before" | "after") {
    setTrackDropIndicator(null);
    if (!project) return;
    const tracks = project.sequence.tracks;
    const beforeTrackId =
      position === "before" ? targetId : (tracks[tracks.findIndex((t) => t.id === targetId) + 1]?.id ?? null);
    run(new ReorderTrackCommand(sourceId, beforeTrackId));
  }

  if (!project) return null;

  const rulerTicks = visibleRulerTicks({
    visibleStart: (scrollLeft - leadingPad) / pixelsPerSecond,
    visibleEnd: (scrollLeft - leadingPad + viewportWidth) / pixelsPerSecond,
    pixelsPerSecond,
    fps: project.sequence.fps,
    totalDuration: contentSeconds,
  });

  return (
    <section className="relative flex h-full min-h-0 flex-col border-t border-white/10 bg-[#0b0d12]">
      {onCollapse && (
        <button type="button" onClick={onCollapse} aria-label={t("Collapse timeline")} title={t("Collapse timeline")} className="absolute right-2 top-0 z-40 flex h-[26px] w-7 items-center justify-center rounded text-white/55 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300 lg:hidden">
          <ChevronDown size={15} />
        </button>
      )}
      {/* Hidden entirely below `lg` now (was `flex flex-wrap` unconditionally) — the label, live
          position/duration readout, Set In/Out/Range, AND the zoom buttons all move elsewhere or
          disappear on a phone: the readout merges into the ruler itself (see the absolutely-positioned
          "current time" overlay pinned over `scrollRef` below — same live value, just anchored to the
          ruler's own left edge instead of a separate row above it), Set In/Out/Range become toolbar
          buttons (`VCutApp.tsx`'s `StatusBar`) since there's nowhere left to reach them here, and the
          zoom buttons are simply dropped — pinch-to-zoom (see the touch handler above) is the mobile
          gesture for this, and a phone's cramped vertical space is better spent on the tracks
          themselves than a redundant precise-zoom fallback. Desktop is completely unaffected. */}
      <header className="hidden flex-wrap items-center gap-x-2 gap-y-1 border-b border-white/10 px-3 py-1.5 lg:flex">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-white/60">{t("Timeline")}</h2>
          {/* Current position + total duration — both moved here from Preview's transport bar, which now
              carries only the playback buttons themselves. This panel is what visualizes the whole
              project's timespan, so both halves of "where am I / how long is this" read naturally here
              together, rather than split across two different bars. */}
          <div className="flex items-baseline gap-1 font-mono text-[11px] tabular-nums">
            <CurrentTime fps={project.sequence.fps} />
            <span className="text-white/30">/</span>
            <span aria-label={t("Total duration")} className="text-white/45">
              {formatTimecode(total, project.sequence.fps)}
            </span>
          </div>
          {/* Touch-reachable equivalents of the `I`/`O` keyboard shortcuts (see VCutApp.tsx) — a
              touchscreen with no external keyboard had NO way to create an export range marker at all
              before this: once a marker exists it can be dragged (see `scrubExportStart`/`scrubExportEnd`
              below), but nothing except `I`/`O` could create the marker in the first place. Always
              visible (not gated on `hasExportRange`) since these are what CREATES the range to begin
              with — a button that only appears once a range already exists would be useless for exactly
              the case this fixes. */}
          <button
            // A plain snapshot read (not a subscribed selector) — same "CurrentTime is isolated so the
            // whole Timeline doesn't re-render 30-60×/sec during playback" reasoning above; this only
            // needs the playhead's value at the moment of the click, never a live re-render.
            onClick={() => setExportRangeStart(useEditorStore.getState().playhead)}
            aria-label={t("Set export range start at playhead")}
            title={t("Set export range start at playhead (I)")}
            className="rounded px-1.5 py-0.5 text-[11px] text-amber-300/80 transition hover:bg-amber-500/15 hover:text-amber-200"
          >
            {t("Set In")}
          </button>
          <button
            onClick={() => setExportRangeEnd(useEditorStore.getState().playhead)}
            aria-label={t("Set export range end at playhead")}
            title={t("Set export range end at playhead (O)")}
            className="rounded px-1.5 py-0.5 text-[11px] text-amber-300/80 transition hover:bg-amber-500/15 hover:text-amber-200"
          >
            {t("Set Out")}
          </button>
          {hasExportRange && (
            // Same amber as the in/out markers themselves — the visual link makes it obvious this
            // button is what removes THOSE, not some unrelated action. Also reachable via Shift+X (see
            // VCutApp.tsx) — this is the discoverable version for anyone who wouldn't otherwise know
            // the shortcut, or the "Reset to full timeline" link buried inside the Export dialog.
            <button
              onClick={() => clearExportRange()}
              aria-label={t("Clear export range")}
              title={t("Clear export in/out range (Shift+X)")}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-amber-300/80 transition hover:bg-amber-500/15 hover:text-amber-200"
            >
              {t("× Range")}
            </button>
          )}
        </div>
        <div className="ml-auto flex items-center gap-1">
          {onCollapse && (
            <button type="button" onClick={onCollapse} aria-label={t("Collapse timeline")} title={t("Collapse timeline")} className="flex min-h-[26px] min-w-[26px] items-center justify-center rounded text-white/60 transition hover:bg-white/10 hover:text-white">
              <ChevronDown size={15} />
            </button>
          )}
          {/* min-h/min-w 26px — same touch-target floor as TrackHeader's FlagButton (see its own
              comment: padding-only sizing measured as small as ~17×19px on a real mobile viewport). */}
          <button
            onClick={() => zoomAround(1 / 1.4)}
            aria-label={t("Zoom out")}
            title={t("Zoom out (Ctrl/⌘ −)")}
            className="flex min-h-[26px] min-w-[26px] items-center justify-center rounded text-white/60 transition hover:bg-white/10 hover:text-white"
          >
            −
          </button>
          <button
            onClick={() => zoomTo(DEFAULT_TIMELINE_PIXELS_PER_SECOND)}
            aria-label={t("Reset zoom")}
            title={t("Reset zoom (Ctrl/⌘ 0)")}
            className="min-h-[26px] min-w-[3.5ch] rounded px-1 text-center font-mono text-[11px] tabular-nums text-white/45 transition hover:bg-white/10 hover:text-white"
          >
            {Math.round((pixelsPerSecond / DEFAULT_TIMELINE_PIXELS_PER_SECOND) * 100)}%
          </button>
          <button
            onClick={() => zoomAround(1.4)}
            aria-label={t("Zoom in")}
            title={t("Zoom in (Ctrl/⌘ +)")}
            className="flex min-h-[26px] min-w-[26px] items-center justify-center rounded text-white/60 transition hover:bg-white/10 hover:text-white"
          >
            +
          </button>
        </div>
      </header>

      {/* The "arm an asset, then place it" affordance — see `armedAssetId`'s own doc comment in
          editorStore.ts for why this exists at all. A real row (`shrink-0`), not a floating overlay
          on top of the ruler/lanes below — a floating banner was the FIRST approach here, and it had
          to intercept and re-route every tap on the timeline underneath it (including guarding
          against covering the playhead scrub area and the horizontal scrollbar), which was real,
          confirmed fragility: a tap landing on an EXISTING clip needed a capture-phase intercept to
          stop that clip's own selection from also firing, and the banner pill itself had to carefully
          split which of its own pixels were clickable so it didn't silently eat a tap meant for the
          timeline underneath. Placing the asset at the PLAYHEAD instead — the same precise, already
          practiced scrub/frame-step gesture used for everything else here — needs none of that: this
          row sits in normal flow, pushing the ruler/lanes down rather than overlapping either, so it
          can never cover the playhead marker or the scroll area no matter how it's laid out. */}
      {armedAssetId && (
        <div className="flex shrink-0 items-center gap-2 border-b border-white/10 bg-sky-500/10 px-3 py-2 lg:hidden">
          {/* Confirms WHICH asset is armed, not just that one is — a real gap otherwise: arming
              closes the sheet immediately, so by the time this bar is showing, the tile that was
              just tapped is already gone from view, with nothing else on screen naming it. The text
              stays alongside it (not replaced by it) — the thumbnail answers "what," the text still
              answers "what to do," and neither makes the other redundant. */}
          {(() => {
            const armedAsset = project.assets.find((a) => a.id === armedAssetId);
            const url = armedAsset && projectId ? thumbnailUrl(projectId, armedAsset) : null;
            return url ? (
              <img src={url} alt="" className="h-8 w-8 shrink-0 rounded object-cover" draggable={false} />
            ) : (
              <div className="h-8 w-8 shrink-0 rounded bg-white/10" />
            );
          })()}
          <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-sky-200">
            {t("Move the playhead, then place it")}
          </span>
          <button
            onClick={() => cancelArmedAsset()}
            className="shrink-0 rounded-md px-2.5 py-1.5 text-[11px] font-medium text-white/60 transition hover:bg-white/10 hover:text-white"
          >
            {t("Cancel")}
          </button>
          <button
            onClick={() => {
              addAssetAtPlayhead(armedAssetId);
              cancelArmedAsset();
            }}
            className="shrink-0 rounded-md bg-sky-500 px-3 py-1.5 text-[11px] font-semibold text-white transition hover:bg-sky-400"
          >
            {t("Place at playhead")}
          </button>
        </div>
      )}

      <div className="relative flex min-h-0 flex-1">
        {/* Mobile's merged stand-in for the header's own (now `lg`-only, see above) live
            position/duration readout — same live value (the exact same isolated `CurrentTime`, so
            this doesn't cost a second 30-60×/sec-during-playback subscription), just anchored over the
            ruler's own left edge instead of a separate row above it, to give that row's height back to
            the tracks below on a phone. A plain `absolute` overlay on THIS wrapper (not `sticky` inside
            the scrolling ruler itself, which was tried first and confirmed NOT to stay put — it
            scrolled away with the ruler's own horizontally-scrolling content instead of sticking to
            the viewport edge) — this wrapper never scrolls at all (only `scrollRef`, its child, does),
            so a plain top-left-pinned absolute child is unaffected by scroll on EITHER axis by
            construction, no sticky-positioning edge cases to fight. `z-30`/matching background: sits
            above and fully covers whichever tick mark would otherwise be directly behind it. */}
        <div
          style={{ height: RULER_HEIGHT }}
          className="pointer-events-none absolute left-0 top-0 z-30 flex items-center gap-1 border-b border-r border-white/10 bg-[#0d0f14] px-1.5 font-mono text-[10px] tabular-nums lg:hidden"
        >
          <CurrentTime fps={project.sequence.fps} />
          <span className="text-white/30">/</span>
          <span className="text-white/45">{formatTimecode(total, project.sequence.fps)}</span>
        </div>

        {/* Track headers sit outside the horizontal scroll so they stay visible while scrubbing far
            along a long edit — desktop only. On mobile they scroll WITH the clips instead, as inline
            per-row chips inside the lanes themselves (see that render below); there's no separate
            fixed column there at all. */}
        {!isMobile && (
          <div className="flex shrink-0 flex-col" style={{ width: HEADER_WIDTH }}>
            <div style={{ height: RULER_HEIGHT }} className="border-b border-r border-white/10 bg-[#0d0f14]" />
            {/* `overflow-hidden` here (no scrollbar of its own) — this column's vertical position is
                driven by the lanes' own scroll via the transform below, so it always tracks exactly,
                rather than being a second independently-scrollable area that could drift out of sync. */}
            <div className="flex-1 overflow-hidden">
              <div ref={headerListRef}>
                {displayRows.map((row) =>
                  row.type === "group" ? (
                    <TemplateGroupRowHeader key={row.groupId} name={row.name} trackCount={row.tracks.length} height={TRACK_HEIGHT} />
                  ) : (
                    <TrackHeader
                      key={row.track.id}
                      track={row.track}
                      height={rowHeight(row)}
                      dropIndicator={trackDropIndicator?.trackId === row.track.id ? trackDropIndicator.position : null}
                      onDragOverRow={(trackId, position) => setTrackDropIndicator({ trackId, position })}
                      onDropRow={dropTrackOnRow}
                      onDragEndRow={() => setTrackDropIndicator(null)}
                    />
                  )
                )}
                <div
                  style={{ height: NEW_TRACK_ROW_HEIGHT }}
                  className={`flex items-center border-b border-white/10 px-2 transition ${
                    assetDrag && isOverNewTrackRow(assetDrag.clientY) ? "bg-sky-500/15" : ""
                  }`}
                >
                  <AddTrackButton onPick={(kind) => run(new AddTrackCommand(kind))} />
                </div>
              </div>
            </div>
          </div>
        )}

        <div
          ref={scrollRef}
          id="vcut-timeline-lanes"
          // Both axes scroll together in this one container now — with more than a handful of tracks,
          // `overflow-y-hidden` here used to CLIP the extra rows entirely rather than making them
          // reachable, silently hiding tracks with no way to scroll down to them. `scrollbar-none`
          // (see globals.css) keeps the scrolling itself while hiding the browser's own thin OS-style
          // scrollbar chrome on BOTH axes — vertical stays gesture-only (wheel/trackpad; track count
          // is usually small, and the header column already shows where you are), but horizontal gets
          // its own deliberate, persistent, always-visible replacement below (`HScrollbar`) instead of
          // nothing: with more than a few seconds of footage, "scroll right" has no other discoverable
          // affordance at all (a plain wheel scrolls vertically here, and Shift+wheel — the native
          // escape hatch — isn't something most people know to reach for).
          className="scrollbar-none relative min-w-0 flex-1 overflow-auto"
          // `touch-action: pan-x pan-y` (inline, not a Tailwind utility class — combining `touch-pan-x`/
          // `touch-pan-y` utilities is a real cascade risk: each sets the WHOLE property, so depending
          // on generated source order one could silently overwrite the other instead of merging).
          // Explicitly permits native single-finger panning on BOTH axes (unchanged from the default)
          // while removing `pinch-zoom` from what the default `auto` would otherwise also allow — a
          // real, confirmed cause of "pinch to zoom doesn't work" on an actual touchscreen: `auto`
          // leaves the browser's OWN native two-finger zoom gesture live on this element, which can
          // claim a two-finger touch before the pinch-zoom listener's `touchmove` handler ever gets a
          // chance to `preventDefault()` it (a race a CDP-simulated pinch never hits, since synthetic
          // touch events skip the OS/browser gesture recognizer entirely — confirmed by testing this
          // exact gap: the simulated pinch already worked before this change). `touch-action` is the
          // standards-track fix for exactly this race, more reliable than `preventDefault()` alone.
          style={{ touchAction: "pan-x pan-y" }}
          onTouchStart={(event) => {
            // Single finger only — a two-finger pinch zooms and shouldn't pause playback.
            if (!isMobile || event.touches.length !== 1) return;
            fingerDownRef.current = true;
            // Only marks the gesture; playback pauses on the first real SCROLL (below), so a plain tap on
            // a clip during playback doesn't cause an audible stop/start blip.
            panningRef.current = true;
          }}
          onTouchEnd={() => {
            fingerDownRef.current = false;
            if (panningRef.current) armSettle();
          }}
          onTouchCancel={() => {
            fingerDownRef.current = false;
            if (panningRef.current) armSettle();
          }}
          onWheel={(event) => {
            // Trackpad/mouse-wheel panning of the fixed-center timeline. Ctrl+wheel is zoom, not a pan.
            if (!isMobile || event.ctrlKey || event.deltaX === 0) return;
            panningRef.current = true;
            beginInteraction();
            armSettle();
          }}
          onScroll={() => {
            // Horizontal movement only — scrolling the track list up/down mid-playback isn't a scrub.
            const horizontal = (scrollRef.current?.scrollLeft ?? 0) !== lastScrollLeftRef.current;
            lastScrollLeftRef.current = scrollRef.current?.scrollLeft ?? 0;
            if (panningRef.current && horizontal) {
              beginInteraction();
              if (!fingerDownRef.current) armSettle();
            }
            if (headerListRef.current) {
              headerListRef.current.style.transform = `translateY(${-(scrollRef.current?.scrollTop ?? 0)}px)`;
            }
            // rAF-throttled: a touch-driven fling can fire many `scroll` events per animation frame,
            // and `setScrollLeft` is React state — every call re-renders this WHOLE component (every
            // track, every `TimelineClip`), so calling it unthrottled meant a scroll on a slower
            // device (a real Android WebView, confirmed slower than desktop Chrome here) did several
            // times the re-render work an on-screen frame could actually use, reading as stuttery/
            // unresponsive scrolling rather than a genuine input problem. Coalescing to once per frame
            // costs nothing visually (nothing can paint faster than a frame anyway) and cuts that
            // re-render volume to the minimum the display can even show.
            if (scrollRafRef.current === null) {
              scrollRafRef.current = requestAnimationFrame(() => {
                scrollRafRef.current = null;
                const sl = scrollRef.current?.scrollLeft ?? 0;
                setScrollLeft(sl);
                // Fixed-center playhead (mobile only): scrolling/panning/flinging IS scrubbing —
                // derive playhead from wherever the view landed, unless THIS scroll was caused by the
                // playhead-follow effect centering the view on its own (see `programmaticScrollRef`'s
                // own comment) — reacting to that would feed the two mobile sync directions into each
                // other every frame during playback for no purpose, since the value wouldn't change.
                if (isMobile && !programmaticScrollRef.current) {
                  // Same `- leadingPad` adjustment as `timeFromEvent` — the marker sits at
                  // `sl + centerOffset` in scroll-container coordinates, which converts to a TIME the
                  // same way any other position in this container does.
                  setPlayhead((sl + centerOffset - leadingPad) / pixelsPerSecond);
                }
              });
            }
          }}
        >
          <div style={{ width: scrollableWidth }} className="relative">
            {/* Shifts the ruler/clips/export-range markers right by `leadingPad` — everything in this
                app's timeline coordinate system EXCEPT the playhead marker itself (which stays a
                direct child of the outer div above, positioned in scroll-container coordinates, not
                shifted by this). A `marginLeft`, not padding, on a `position: relative` element — see
                `leadingPad`'s own comment on why padding wouldn't actually move its absolutely
                positioned children. Also the pinch-zoom handler's OWN transform target (`contentRef`)
                for exactly the same reason: everything in here should visually scale live during a
                pinch, and the playhead marker — a SIBLING of this div, not a descendant — correctly
                stays excluded and unscaled, matching its own "never moves on mobile" design. */}
            <div ref={contentRef} style={{ marginLeft: leadingPad }} className="relative">
            <div
              ref={rulerRef}
              role="slider"
              aria-label={t("Playhead")}
              aria-valuemin={0}
              aria-valuemax={total}
              aria-valuenow={useEditorStore.getState().playhead}
              tabIndex={0}
              onKeyDown={(event) => {
                const current = useEditorStore.getState().playhead;
                const frames = event.shiftKey ? 10 : 1;
                if (event.key === "ArrowRight" || event.key === "ArrowUp") setPlayhead(current + frames / project.sequence.fps);
                else if (event.key === "ArrowLeft" || event.key === "ArrowDown") setPlayhead(current - frames / project.sequence.fps);
                else if (event.key === "Home") setPlayhead(0);
                else if (event.key === "End") setPlayhead(total);
                else return;
                event.preventDefault();
              }}
              onMouseDown={scrub}
              onTouchStart={scrub}
              onMouseMove={(e) => setHoverX(e.clientX)}
              onMouseLeave={() => setHoverX(null)}
              style={{ height: RULER_HEIGHT }}
              // touch-none: without it, a touch-drag on the ruler also tries to pan/scroll the
              // Timeline's own scroll container underneath it, fighting the scrub.
              className="sticky top-0 z-20 touch-none cursor-ew-resize select-none border-b border-white/10 bg-[#0d0f14]"
            >
              {rulerTicks.map((tick) => (
                <div
                  key={tick.frame}
                  style={{ left: tick.seconds * pixelsPerSecond }}
                  className={`absolute top-0 border-l pl-1 tabular-nums ${
                    tick.major
                      ? "h-full border-white/15 text-[10px] leading-[26px] text-white/45"
                      : "h-2 border-white/10"
                  }`}
                >
                  {tick.major ? formatTimecode(tick.seconds, project.sequence.fps) : null}
                </div>
              ))}
            </div>

            {snapGuideTime !== null && (
              <div
                aria-hidden
                data-timeline-snap-guide
                className="pointer-events-none absolute bottom-0 top-0 z-[25] w-px bg-amber-300 shadow-[0_0_6px_rgba(252,211,77,0.75)]"
                style={{ left: snapGuideTime * pixelsPerSecond }}
              >
                <span className="absolute left-1 top-[28px] rounded bg-amber-300 px-1 py-0.5 font-mono text-[9px] font-semibold tabular-nums text-black shadow">
                  {formatTimecode(snapGuideTime, project.sequence.fps)}
                </span>
              </div>
            )}

            <div
              ref={lanesRef}
              onClick={() => {
                // See `justMarqueedRef`'s own comment — swallow exactly the one native click the
                // browser fires right after a real marquee drag's mouseup, then let every click after
                // that deselect normally again.
                if (justMarqueedRef.current) {
                  justMarqueedRef.current = false;
                  return;
                }
                select([]);
              }}
              onMouseDown={beginMarquee}
            >
              {displayRows.map((row) => {
                if (row.type === "group") {
                  const groupClips = row.tracks.flatMap((tr) => tr.clips);
                  const start = groupClips.length ? Math.min(...groupClips.map((c) => c.timelineStart)) : 0;
                  const end = groupClips.length ? Math.max(...groupClips.map((c) => clipEnd(c))) : 0;
                  return (
                    <div key={row.groupId} style={{ height: TRACK_HEIGHT }} className="relative border-b border-white/10 bg-white/[0.015]">
                      {isMobile && (
                        <div style={{ position: "absolute", left: -HEADER_WIDTH - 4, top: 0, bottom: 0, width: HEADER_WIDTH }} className="z-10">
                          <TemplateGroupRowHeader name={row.name} trackCount={row.tracks.length} height={TRACK_HEIGHT} />
                        </div>
                      )}
                      <TemplateGroupLaneBar
                        groupId={row.groupId}
                        name={row.name}
                        startSeconds={start}
                        endSeconds={end}
                        pixelsPerSecond={pixelsPerSecond}
                        fps={project.sequence.fps}
                        onEdit={() => setOpenGroupId(row.groupId)}
                      />
                    </div>
                  );
                }
                const track = row.track;
                return (
                <div
                  key={track.id}
                  style={{ height: isTrackCompact(track) ? EMPTY_TRACK_HEIGHT : TRACK_HEIGHT }}
                  className={`relative border-b border-white/10 ${
                    // Two independent reasons a track can be a drop target: a clip already on the
                    // timeline being dragged onto a DIFFERENT track (`dropTrackId`, reported by
                    // `TimelineClip`), or an asset being dragged in from the Media Library — mouse via
                    // native drag-and-drop's own hover state (no highlight needed here, the browser
                    // draws its own), touch via `assetDrag`'s live position (see its own doc comment)
                    // hit-tested the same way `resolveTimelineDropTarget` does for the actual drop.
                    dropTrackId === track.id || (assetDrag && resolveTrackAt(assetDrag.clientY) === track.id)
                      ? "bg-sky-500/15 outline outline-1 -outline-offset-1 outline-sky-400/50"
                      : track.locked
                        ? "bg-white/[0.02]"
                        : "bg-white/[0.015] hover:bg-white/[0.03]"
                  }`}
                >
                  {/* Inline header chip — mobile only (see the fixed-sidebar block above's own
                      comment for the desktop equivalent). Positioned in the reserved
                      leading gutter (`leadingPad`, sized for the fixed-center-playhead work — always
                      comfortably wider than `HEADER_WIDTH` on any real phone), immediately left of
                      where this row's clips start, so it scrolls away and reappears with its own row
                      exactly like a clip would — it's a normal descendant of the same scrolling
                      content, not a separately-synced overlay. `TrackHeader` itself is reused
                      completely unchanged; only its position in the DOM differs from the desktop
                      sidebar's normal-flow usage above. */}
                  {isMobile && (
                    <div
                      style={{ position: "absolute", left: -HEADER_WIDTH - 4, top: 0, bottom: 0, width: HEADER_WIDTH }}
                      className="z-10"
                    >
                      <TrackHeader
                        track={track}
                        height={isTrackCompact(track) ? EMPTY_TRACK_HEIGHT : TRACK_HEIGHT}
                        dropIndicator={trackDropIndicator?.trackId === track.id ? trackDropIndicator.position : null}
                        onDragOverRow={(trackId, position) => setTrackDropIndicator({ trackId, position })}
                        onDropRow={dropTrackOnRow}
                        onDragEndRow={() => setTrackDropIndicator(null)}
                      />
                    </div>
                  )}
                  {track.clips.length === 0 && !track.locked && !(recording && recording.trackId === track.id) && (
                    <AddClipButton
                      kind={track.kind}
                      label={track.kind === "video" ? t("Add video") : track.kind === "audio" ? t("Add audio") : t("Add text")}
                      onClick={() => {
                        if (track.kind === "text") {
                          // Same compose-before-create flow the toolbar's own Text button uses (see
                          // `editorStore.ts`'s `composeText` doc comment) — `trackId` pins the result
                          // to THIS specific empty track rather than `commitComposedText`'s own generic
                          // "first unlocked text track" fallback.
                          setComposeText({ style: DEFAULT_TEXT_STYLE, trackId: track.id });
                          return;
                        }
                        setEmptyTrackImportTarget(track);
                        // Deferred a tick: the ref's `accept` attribute (set from `emptyTrackImportTarget`
                        // in the render below) needs to reflect THIS track's kind before the native picker
                        // opens, and a state update isn't guaranteed to have re-rendered yet at this exact
                        // point in the same event handler.
                        requestAnimationFrame(() => emptyTrackImportInputRef.current?.click());
                      }}
                    />
                  )}
                  {track.clips.map((clip) => (
                    <TimelineClip
                      key={clip.id}
                      clip={clip}
                      track={track}
                      project={project}
                      projectId={projectId}
                      pixelsPerSecond={pixelsPerSecond}
                      selected={selectedClipIds.includes(clip.id)}
                      assetName={assetNames.get(clip.assetId) ?? t("Missing media")}
                      resolveTrackAt={resolveTrackAt}
                      onTargetTrackChange={setDropTrackId}
                      isMobile={isMobile}
                      onPanScroll={panTimelineBy}
                      timeAtClientX={timeFromEvent}
                      onSnapGuideChange={setSnapGuideTime}
                    />
                  ))}
                  {track.kind === "video" && track.clips.map((clip) => {
                    const previous = findTransitionCandidate(track, clip);
                    if (!previous) return null;
                    const maximum = Math.min(clipDuration(previous), clipDuration(clip));
                    return <TransitionJunction
                      key={`junction-${clip.id}`}
                      cutSeconds={clip.timelineStart}
                      duration={clip.transitionIn ? Math.min(clip.transitionIn.duration, maximum) : null}
                      maxDuration={maximum} pixelsPerSecond={pixelsPerSecond} fps={project.sequence.fps}
                      mobile={isMobile} locked={track.locked}
                      label={clip.transitionIn ? t("Change transition") : t("Add transition")}
                      durationLabel={t("Adjust transition duration")}
                      timeAtClientX={timeFromEvent}
                      onOpen={(rect) => {
                        select([clip.id]);
                        useEditorStore.getState().setTransitionPickerRequest({ x: rect.left, y: rect.top, clipId: clip.id, mode: "in" });
                      }}
                      onDurationChange={(duration) => {
                        if (clip.transitionIn) run(new SetClipTransitionCommand(clip.id, { ...clip.transitionIn, duration }));
                      }}
                    />;
                  })}
                  {recording && recording.trackId === track.id && (
                    // A growing placeholder for a voiceover still being captured — no real `Clip`
                    // exists yet (see `VoiceoverRecorder`), so this is a plain overlay, not a
                    // `TimelineClip`. `pointer-events-none`: nothing to select/drag before it's a real
                    // clip. The pulse keeps going into "finalizing" (import in flight after Stop) so
                    // the indicator never just vanishes and pops back in a moment later.
                    <div
                      aria-hidden
                      className={`pointer-events-none absolute top-1 bottom-1 z-10 flex items-center gap-1.5 overflow-hidden rounded-md border border-rose-400/50 bg-rose-500/25 px-2 text-[11px] font-medium text-rose-100 ${
                        recording.phase === "finalizing" ? "opacity-60" : ""
                      }`}
                      style={{
                        left: recording.start * pixelsPerSecond,
                        width: Math.max(2, recording.elapsedSeconds * pixelsPerSecond),
                      }}
                    >
                      <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-rose-300" />
                      <span className="truncate">
                        {recording.phase === "recording" ? t("Recording…") : t("Finishing…")}
                      </span>
                    </div>
                  )}
                </div>
                );
              })}
              {/* Drop-zone twin of the header column's `AddTrackButton` row above — same Y position
                  (both sit right after the same track list, and the header column tracks this one's
                  scroll via the transform above), hit-tested by `isOverNewTrackRow` via its own ref
                  rather than summed heights. Highlighted the same way an existing track row is when
                  a drag is hovering it (see `dropTrackId`/`resolveTrackAt` above). Mobile also needs
                  its OWN tap target here, since there's no separate header column to hold one. */}
              <div
                ref={newTrackRowRef}
                style={{ height: NEW_TRACK_ROW_HEIGHT }}
                className={`relative border-b border-white/10 ${
                  assetDrag && isOverNewTrackRow(assetDrag.clientY)
                    ? "bg-sky-500/15 outline outline-1 -outline-offset-1 outline-sky-400/50"
                    : ""
                }`}
              >
                {isMobile && (
                  <div
                    style={{ position: "absolute", left: -HEADER_WIDTH - 4, top: 0, bottom: 0, width: HEADER_WIDTH }}
                    className="z-10 flex items-center px-2"
                  >
                    <AddTrackButton onPick={(kind) => run(new AddTrackCommand(kind))} />
                  </div>
                )}
              </div>
            </div>

            {/* Backs every empty-track `AddClipButton` above — see `emptyTrackImportTarget`'s own
                comment for why one shared, imperatively-clicked input beats one per row. */}
            <input
              ref={emptyTrackImportInputRef}
              type="file"
              multiple
              accept={emptyTrackImportTarget && emptyTrackImportTarget.kind !== "text" ? ACCEPTED_EXTENSIONS_BY_KIND[emptyTrackImportTarget.kind] : undefined}
              className="hidden"
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = "";
                const target = emptyTrackImportTarget;
                setEmptyTrackImportTarget(null);
                if (files.length === 0 || !target) return;
                void importFiles(files).then((assets) => {
                  for (const asset of assets) addAssetAtPlayhead(asset.id, target.id, { avoidOverlap: true });
                });
              }}
            />

            {/* Export range dimming: darkens whatever falls OUTSIDE the selected in/out range, so
                it's obvious at a glance which portion of the timeline will actually render.
                `pointer-events-none` — clips underneath (even dimmed ones) stay fully draggable/
                selectable, since dimming is purely a visual cue, never a lock. Only rendered once a
                range has actually been set (`hasExportRange`) — otherwise this would be permanent
                visual noise over the default "export everything" state every project starts in.
                `top: RULER_HEIGHT` keeps the ruler's own timecodes legible; only the lane area (where
                the clips actually live) gets dimmed. */}
            {hasExportRange && exportStart > 0 && (
              <div
                aria-hidden
                style={{ left: 0, width: exportStart * pixelsPerSecond, top: RULER_HEIGHT }}
                className="pointer-events-none absolute bottom-0 z-20 bg-black/55"
              />
            )}
            {hasExportRange && exportEnd < total && (
              <div
                aria-hidden
                style={{ left: exportEnd * pixelsPerSecond, width: Math.max(0, contentWidth - exportEnd * pixelsPerSecond), top: RULER_HEIGHT }}
                className="pointer-events-none absolute bottom-0 z-20 bg-black/55"
              />
            )}

            {/* The outro end card VCut appends at export time for a non-Pro hosted account (see
                `export/route.ts`'s own `shouldIncludeOutro`) — never a real clip on a real track (see
                the design discussion this came out of: making it one risked reintroducing a real OOM
                bug from mixing it into the main timeline's own tracks, and a free user could simply
                delete or drag their own paywall). This is a plain, non-interactive visual marker
                instead: purely informational, so what you see here is honest about what you'll
                actually get on export without the export itself needing to change at all.
                `pointer-events-none` (nothing to select/drag/trim — there's no real clip behind it)
                and `hatched` diagonal stripes rather than a solid fill specifically so it never gets
                mistaken for an actual clip at a glance. Positioned right after the real content ends
                (`total * pixelsPerSecond`), same `top: RULER_HEIGHT` convention as the dimming above.
                `total > 0`: on a genuinely EMPTY project this would otherwise render AT time 0 —
                confirmed a real, reported bug, sitting directly on top of every empty track's own
                "+ Add video"/"+ Add audio" affordance and reading as if the outro WERE the timeline's
                only content instead of something appended after it. Nothing to append after until
                there's at least one real clip, so the marker simply doesn't apply yet either.
                Interactive (not `pointer-events-none` anymore) — same "tell them why" upsell
                `Preview.tsx`'s own click handler shows for the identical zone on the CANVAS, so
                tapping the marker here answers the same "what is this / can I remove it" question
                without needing to first scrub the playhead into it and click the preview instead. */}
            {showOutroMarker && total > 0 && (
              <button
                type="button"
                onClick={() =>
                  setStatus(isMobile ? t("Upgrade to Pro to remove the outro") : t("Subscribe to VCut Pro to remove this outro from your exports."))
                }
                style={{
                  left: total * pixelsPerSecond,
                  width: OUTRO_DURATION_SECONDS * pixelsPerSecond,
                  top: RULER_HEIGHT,
                  backgroundImage: "repeating-linear-gradient(135deg, rgba(255,255,255,0.06) 0 6px, transparent 6px 12px)",
                }}
                className="absolute bottom-0 z-20 cursor-pointer overflow-hidden border-l border-white/15 bg-white/[0.03] text-left transition hover:bg-white/[0.06]"
              >
                <span className="absolute left-1 top-1 whitespace-nowrap text-[9px] font-medium uppercase tracking-wide text-white/40">
                  {t("Outro (added on export)")}
                </span>
              </button>
            )}

            {/* Export range markers — same shape/positioning convention as the playhead marker below,
                amber instead of rose so the two are never confused. Unlike the playhead, each has a
                real drag handle (the small flag): `I`/`O` (see VCutApp.tsx) set them at the current
                playhead from nothing, and the flag refines an already-set point from there. Each is
                independent — setting only an out-point (leaving in at the implicit start) is valid. */}
            {exportRangeStart !== null && (
              <div style={{ left: exportStart * pixelsPerSecond }} className="absolute top-0 bottom-0 z-30 w-px bg-amber-400">
                {/* The actual drag/tap target is bigger (24px) than the visible flag (10px) it's
                    centered on — a 10×10px hit box is well under the ~44px minimum a finger can
                    reliably land on. Keeping the VISIBLE flag small avoids cluttering a zoomed-in
                    timeline with an oversized marker; only the invisible surrounding area grows. */}
                <div
                  role="slider"
                  aria-label={t("Export range start")}
                  aria-valuemin={0}
                  aria-valuemax={Math.round(total)}
                  aria-valuenow={Math.round(exportStart)}
                  tabIndex={0}
                  onMouseDown={scrubExportStart}
                  onTouchStart={scrubExportStart}
                  className="absolute -left-3 top-0 flex h-6 w-6 cursor-ew-resize touch-none items-start justify-center"
                >
                  <div className="h-2.5 w-2.5 rounded-b-sm bg-amber-400" />
                </div>
              </div>
            )}
            {exportRangeEnd !== null && (
              <div style={{ left: exportEnd * pixelsPerSecond }} className="absolute top-0 bottom-0 z-30 w-px bg-amber-400">
                <div
                  role="slider"
                  aria-label={t("Export range end")}
                  aria-valuemin={0}
                  aria-valuemax={Math.round(total)}
                  aria-valuenow={Math.round(exportEnd)}
                  tabIndex={0}
                  onMouseDown={scrubExportEnd}
                  onTouchStart={scrubExportEnd}
                  className="absolute -left-3 top-0 flex h-6 w-6 cursor-ew-resize touch-none items-start justify-center"
                >
                  <div className="h-2.5 w-2.5 rounded-b-sm bg-amber-400" />
                </div>
              </div>
            )}

            </div>

            {/* Drawn last and made non-interactive so it's always visible above the clips without
                intercepting the drags that happen underneath it — a direct child of the OUTER div
                (sibling of the `marginLeft: leadingPad` wrapper above, not inside it), since its own
                position is expressed in scroll-container coordinates already, not shifted by the
                same amount as everything else. */}
            <div
              ref={markerRef}
              style={{
                left: isMobile
                  ? (scrollRef.current?.scrollLeft ?? 0) + centerOffset
                  : useEditorStore.getState().playhead * pixelsPerSecond,
              }}
              className="pointer-events-none absolute top-0 bottom-0 z-30 w-px bg-rose-400"
            >
              <div className="absolute -left-[5px] top-0 h-2.5 w-2.5 rounded-b-sm bg-rose-400" />
            </div>
          </div>
        </div>
      </div>

      {/* Persistent horizontal scrollbar — see the scroll container's own comment on why this exists
          instead of relying on the browser's native (hidden, gesture-only) one. Offset by
          `HEADER_WIDTH` so it lines up under the scrollable content, not the fixed track-headers
          column beside it — desktop only; mobile has no such column to offset for (headers scroll
          with the clips there instead), so the scrollbar spans the full width. */}
      <div className="flex shrink-0 border-t border-white/5 bg-[#0b0d12] py-1 pr-2">
        <div style={{ width: isMobile ? 0 : HEADER_WIDTH }} className="shrink-0" />
        <div
          role="scrollbar"
          aria-controls="vcut-timeline-lanes"
          aria-orientation="horizontal"
          aria-valuemin={0}
          aria-valuemax={Math.round(maxScrollLeft)}
          aria-valuenow={Math.round(scrollLeft)}
          onMouseDown={jumpScrollbarTrack}
          className="relative min-w-0 flex-1 cursor-pointer"
          style={{ height: 10 }}
        >
          <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-white/5" />
          <div
            onMouseDown={beginScrollbarThumbDrag}
            onTouchStart={beginScrollbarThumbDrag}
            title={t("Scroll timeline")}
            style={{ left: thumbLeft, width: thumbWidth }}
            className="absolute top-1/2 h-2 -translate-y-1/2 touch-none rounded-full bg-white/25 transition-colors hover:bg-white/40 active:bg-sky-400/70"
          />
        </div>
      </div>

      {/* Follows the cursor while hovering OR actively scrubbing the ruler — `position: fixed` (not
          relative to the scrolling content) so it never gets clipped by `overflow-auto` and never needs
          its own scroll-offset math the way the playhead marker above does. Only reads `hoverX`
          (screen space); the TIME shown is recomputed from it on every render via `timeFromEvent`, so
          it can never drift out of sync with the container's current scroll position the way a
          separately-stored time value could if scrolling happened without a matching update. */}
      {hoverX !== null && (
        <div
          aria-hidden
          className="pointer-events-none fixed z-40 -translate-x-1/2 rounded bg-black/90 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-white shadow-lg"
          style={{
            left: hoverX,
            top: (rulerRef.current?.getBoundingClientRect().bottom ?? 0) + 4,
          }}
        >
          {formatTimecode(Math.max(0, snapToFrame(timeFromEvent(hoverX), project.sequence.fps)), project.sequence.fps)}
        </div>
      )}

      {/* The marquee rectangle itself — see `beginMarquee`'s own comment for why this lives in plain
          screen (client-pixel) coordinates rather than the scrolling content's own coordinate space,
          same `position: fixed` reasoning as the hover tooltip just above. */}
      {marquee && (
        <div
          aria-hidden
          className="pointer-events-none fixed z-40 border border-sky-400 bg-sky-400/10"
          style={{
            left: Math.min(marquee.startX, marquee.x),
            top: Math.min(marquee.startY, marquee.y),
            width: Math.abs(marquee.x - marquee.startX),
            height: Math.abs(marquee.y - marquee.startY),
          }}
        />
      )}

      {openGroupId && <TemplateGroupPanel groupId={openGroupId} onClose={() => setOpenGroupId(null)} />}
    </section>
  );
}
