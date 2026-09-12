"use client";

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Capacitor } from "@capacitor/core";
import { getSupabaseBrowserClient, useSupabaseSession } from "@veasnawt/auth";
import {
  Ai,
  ArrowLeft,
  Art,
  Backspace,
  ChevronLeft,
  ClosedCaption,
  Copy,
  Delete,
  Document,
  Filter,
  Gauge,
  Grid,
  Headphone,
  Microphone,
  Music,
  Profile,
  Save,
  Settings,
  Split,
  Star,
  Text,
  Transition,
  Video,
  Volume,
} from "@veasnawt/vicons";
import { HOSTED } from "../api/client.ts";
import { reportError } from "../api/crashLog.ts";
import { isDesktopSignInAvailable, openDesktopSignIn, subscribeToDesktopAuthCallback } from "../api/desktopAuth.ts";
import { DeleteClipsCommand, SetClipTransitionCommand, SetClipTransitionOutCommand, SplitClipCommand } from "../commands/index.ts";
import { translateText } from "../i18n/translations.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import { findAsset, findClip } from "../project/createProject.ts";
import { preloadAllFonts } from "../project/fonts.ts";
import { flushPendingSave, useEditorStore } from "../store/editorStore.ts";
import { clipAtTime } from "../timeline/queries.ts";
import { DEFAULT_TRANSITION } from "../timeline/transitions.ts";
import { AnimationPickerMenu } from "./AnimationPickerMenu.tsx";
import { AutoCaptionsDialog } from "./AutoCaptionsDialog.tsx";
import { ClipContextMenu, type ClipContextMenuAction } from "./ClipContextMenu.tsx";
import { ColorPickerMenu } from "./ColorPickerMenu.tsx";
import { EffectsPickerMenu } from "./EffectsPickerMenu.tsx";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { ExportDialog } from "./ExportDialog.tsx";
import { TextToClipsDialog } from "./TextToClipsDialog.tsx";
import { Inspector } from "./Inspector.tsx";
import { MediaPanel } from "./MediaPanel.tsx";
import { FloatablePanel, type FloatRect } from "./FloatablePanel.tsx";
import { MixerPanel } from "./MixerPanel.tsx";
import { MobileSignInDialog } from "./MobileSignInDialog.tsx";
import { NewTextComposer } from "./NewTextComposer.tsx";
import { PixelEffectPickerMenu } from "./PixelEffectPickerMenu.tsx";
import { StylePickerMenu } from "./StylePickerMenu.tsx";
import { addDragListeners, clientPoint, preventDefaultIfMouse } from "./pointerEvents.ts";
import { Preview } from "./Preview.tsx";
import { ScopesPanel } from "./ScopesPanel.tsx";
import { SfxPanel } from "./SfxPanel.tsx";
import { Timeline } from "./Timeline.tsx";
import { TextStylePickerMenu } from "./TextStylePickerMenu.tsx";
import { TransitionPickerMenu } from "./TransitionPickerMenu.tsx";
import { UserMenu } from "./UserMenu.tsx";
import { useHostedCreditsGate } from "./useHostedCreditsGate.ts";
import { VoiceRecordModal } from "./VoiceRecordModal.tsx";

/** Bounds for the draggable Preview/Timeline divider — see `beginTimelineResize`. A fixed pixel
 *  floor for Timeline (below this a track row plus its ruler stops being useful) and a
 *  viewport-relative ceiling for Preview (a fixed pixel floor there would break on a short laptop —
 *  or phone — screen; unlike Timeline, Preview's minimum useful height scales with how much screen
 *  exists at all). */
const MIN_TIMELINE_HEIGHT = 120;
const MAX_TIMELINE_HEIGHT_RATIO = 0.75;

/** Approx combined height of the fixed header + footer rows that sit outside the Preview/Timeline
 *  grid — what's left of `window.innerHeight` after this is the real budget the grid has to split.
 *  Footer grew from ~44px to ~52px when toolbar buttons gained a label under each icon (h-8→h-10). */
const CHROME_HEIGHT = 93;
/** Preview's floor: short of this, a letterboxed frame stops reading as an image at all. Used to
 *  derive how much Timeline is allowed to claim on a short viewport — see `timelineHeight`'s comment
 *  in `VCutApp` for why this replaced an earlier, looser ratio-of-viewport attempt. */
const MIN_PREVIEW_HEIGHT = 120;

/** Shrinks `height` only as far as needed to guarantee Preview keeps `MIN_PREVIEW_HEIGHT`, given how
 *  much total vertical space actually exists — never grows it. Shared by the initial seed (so a page
 *  freshly loaded in landscape never renders the broken state to begin with) and the resize listener
 *  (so rotating mid-session reaches the same safe result). */
function clampTimelineHeight(height: number, viewportHeight: number): number {
  const maxForPreview = viewportHeight - CHROME_HEIGHT - MIN_PREVIEW_HEIGHT;
  return Math.max(MIN_TIMELINE_HEIGHT, Math.min(height, Math.max(MIN_TIMELINE_HEIGHT, maxForPreview)));
}

/** Same floor/ceiling shape as `MIN_TIMELINE_HEIGHT`/`clampTimelineHeight`, along the horizontal axis
 *  for Media/Properties instead — a fixed pixel floor per side panel (below this its own content, a
 *  media grid or a Properties field's label+input+suffix row, starts wrapping badly) and Preview kept
 *  to at least `MIN_PREVIEW_WIDTH` between whichever two widths (this panel's, and the OTHER side
 *  panel's current width) are currently competing for the same viewport. */
const MIN_SIDE_PANEL_WIDTH = 180;
const MIN_PREVIEW_WIDTH = 320;

function clampSideWidth(width: number, otherSideWidth: number, viewportWidth: number): number {
  const maxForPreview = viewportWidth - otherSideWidth - MIN_PREVIEW_WIDTH;
  return Math.max(MIN_SIDE_PANEL_WIDTH, Math.min(width, Math.max(MIN_SIDE_PANEL_WIDTH, maxForPreview)));
}

/** Input types that accept typed text. Everything else — file, button, checkbox, radio, range — can
 *  hold focus without swallowing a keystroke, so shortcuts must keep working while they're focused.
 *  Getting this wrong is easy to miss: clicking "Import" leaves focus on a file input, and treating
 *  that as "the user is typing" silently kills every shortcut until they click elsewhere. */
const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "tel", "email", "password", "number", "date", "time"]);
/** Types whose own arrow-key handling would otherwise fight a global shortcut bound to the same key —
 *  `range` specifically, since Left/Right (and Up/Down) are its native way to nudge a value, exactly
 *  the same keys `stepFrames` is bound to. Distinct from `TEXT_INPUT_TYPES`: a range input doesn't
 *  accept typed text, so it can't trip the "typing" checks elsewhere, but it still needs arrow keys
 *  reserved for itself while focused. */
const ARROW_KEY_INPUT_TYPES = new Set(["range"]);

/** Whether a keystroke is being typed into something, in which case editor shortcuts must not fire —
 *  otherwise pressing "s" in the media search box would split a clip. Also true for a focused range
 *  slider (Effects/Crop) specifically for arrow keys — see `ARROW_KEY_INPUT_TYPES` — so nudging a
 *  slider with the keyboard doesn't ALSO step the playhead one frame per press. */
function isTypingTarget(target: EventTarget | null, key?: string): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.tagName === "TEXTAREA" || target.tagName === "SELECT") return true;
  if (target instanceof HTMLInputElement) {
    // An input with no explicit type defaults to "text".
    const type = target.type || "text";
    if (TEXT_INPUT_TYPES.has(type)) return true;
    if (ARROW_KEY_INPUT_TYPES.has(type) && key?.startsWith("Arrow")) return true;
  }
  return false;
}

/** Splits the selected clip, or whatever sits under the playhead when nothing is selected — shared
 *  between the global "S" shortcut and the toolbar's Split button so the two can never drift apart.
 *  A plain function (not a hook) reading `getState()` directly, so it's callable from an imperative
 *  keydown handler exactly as easily as from a button's onClick. */
function splitAtPlayhead() {
  const state = useEditorStore.getState();
  const current = state.project;
  if (!current) return;
  const selectedId = state.selectedClipIds[0];
  const target = selectedId
    ? findClip(current, selectedId)?.clip
    : current.sequence.tracks
        .filter((t) => t.kind === "video" && !t.locked)
        .map((t) => clipAtTime(t, state.playhead))
        .find(Boolean);
  if (!target) return state.setStatus(translateText(state.language, "Put the playhead over a clip to split it"), "error");
  state.run(new SplitClipCommand(target.id, state.playhead));
}

/** One toolbar icon, an optional highlighted "active" state (used by toggles like Transition, where
 *  the button itself IS the on/off indicator), and a `title` that doubles as the tooltip AND the
 *  keyboard-shortcut hint the old plain-text status bar used to show permanently. `label` is a SHORT
 *  caption rendered under the icon (not a substitute for `title` — the shortcut hint only shows up on
 *  hover/long-press, the label is what makes each icon identifiable without either) — a phone user
 *  can't hover to discover what an icon-only button does the way a mouse user can, and even for a
 *  mouse this row's icons (Split/Delete/Save/Text/Transition/Media/Properties) aren't universally
 *  self-explanatory the way Play/Pause are.
 *
 *  No `disabled` prop — every tool this toolbar renders that can't act on the current selection is
 *  wrapped in a conditional and simply not rendered at all, rather than shown greyed out. That's a
 *  deliberate, explicitly requested UX call (a tool a viewer can't currently use isn't worth a
 *  permanent slot in an already-tight row), not an oversight; see each such tool's own call site for
 *  its specific hide condition. */
const ToolbarButton = React.forwardRef<
  HTMLButtonElement,
  {
    onClick: () => void;
    active?: boolean;
    title: string;
    label: string;
    className?: string;
    /** Marks a hosted-web-only, credit-metered feature (Auto Captions, Remove Object) with a small
     *  "PRO" badge — free accounts still get a few credits/month (see `_lib/credits.ts`'s own
     *  allotments), so this isn't a hard lock, just the same "premium capability" signal most
     *  freemium apps put on a limited-free-trial feature. Never shown outside hosted mode
     *  (`VCutApp.tsx`'s own callers gate this on `HOSTED`) — desktop/local has no plans/credits
     *  concept at all, so the badge would be actively misleading there. */
    pro?: boolean;
    children: React.ReactNode;
  }
>(function ToolbarButton({ onClick, active, title, label, className = "", pro, children }, ref) {
  return (
    <button
      ref={ref}
      onClick={onClick}
      title={pro ? `${title} (Pro)` : title}
      aria-label={pro ? `${title} (Pro)` : title}
      aria-pressed={active}
      className={`relative flex h-10 min-w-11 shrink-0 flex-col items-center justify-center gap-0.5 rounded px-1 leading-none transition ${
        active ? "bg-sky-500/30 text-white hover:bg-sky-500/40" : "text-white/70 hover:bg-white/10 hover:text-white"
      } ${className}`}
    >
      {pro && (
        <span className="absolute right-0 top-0 rounded-sm bg-amber-400 px-[3px] text-[6px] font-bold leading-tight tracking-wide text-black">
          PRO
        </span>
      )}
      {children}
      <span className="max-w-full truncate text-[9px] font-medium">{label}</span>
    </button>
  );
});

function StatusBar({
  mobileSheet,
  setMobileSheet,
  bottomPanel,
  setBottomPanel,
  floatingPanel,
  onDockFloating,
}: {
  mobileSheet: "media" | "inspector" | null;
  setMobileSheet: (next: "media" | "inspector" | null) => void;
  bottomPanel: "timeline" | "mixer" | "scopes";
  setBottomPanel: (next: "timeline" | "mixer" | "scopes") => void;
  /** Which of Mixer/Scopes (if either) is currently popped out into its own floating window — see
   *  `VCutApp.tsx`'s own `floatState` comment. Drives these two buttons' `active` look (a floating
   *  panel still reads as "open", just not docked) and what tapping one while it's floating does. */
  floatingPanel: "mixer" | "scopes" | null;
  onDockFloating: () => void;
}) {
  const setStatus = useEditorStore((s) => s.setStatus);
  const selectedClipIds = useEditorStore((s) => s.selectedClipIds);
  const select = useEditorStore((s) => s.select);
  const run = useEditorStore((s) => s.run);
  const save = useEditorStore((s) => s.save);
  // Mobile-only toolbar equivalents of Timeline.tsx's own "Set In"/"Set Out"/"× Range" header
  // controls — that whole header row is hidden below `lg` now (see Timeline.tsx's own comment), so
  // these need a reachable home somewhere else on a phone; the bottom toolbar, already where every
  // other mobile-only control (Media/Properties) lives, is that home. Desktop keeps using the header
  // row's own buttons unchanged (these stay `lg:hidden`) rather than showing the same action twice.
  const exportRangeStart = useEditorStore((s) => s.exportRangeStart);
  const exportRangeEnd = useEditorStore((s) => s.exportRangeEnd);
  const setExportRangeStart = useEditorStore((s) => s.setExportRangeStart);
  const setExportRangeEnd = useEditorStore((s) => s.setExportRangeEnd);
  const clearExportRange = useEditorStore((s) => s.clearExportRange);
  const hasExportRange = exportRangeStart !== null || exportRangeEnd !== null;
  const setComposeText = useEditorStore((s) => s.setComposeText);
  const addColorAtPlayhead = useEditorStore((s) => s.addColorAtPlayhead);
  const duplicateSelectedClips = useEditorStore((s) => s.duplicateSelectedClips);
  const extractAudioFromClip = useEditorStore((s) => s.extractAudioFromClip);
  const applyTextAnimationToSelection = useEditorStore((s) => s.applyTextAnimationToSelection);
  const applyTextStylePresetToSelection = useEditorStore((s) => s.applyTextStylePresetToSelection);
  const armRemoveObject = useEditorStore((s) => s.armRemoveObject);
  const previewMuted = useEditorStore((s) => s.previewMuted);
  const togglePreviewMuted = useEditorStore((s) => s.togglePreviewMuted);
  const project = useEditorStore((s) => s.project);
  const projectId = useEditorStore((s) => s.projectId);
  const t = useTranslation();
  // `null` = closed; `{}` = open, whole-sequence; `{ clipIds }` = open, scoped to the selected clip(s)
  // (the toolbar's Captions button reaching a qualifying selection — see that button's own comment).
  const [captionsDialog, setCaptionsDialog] = useState<{ clipIds?: string[] } | null>(null);
  const [showTextImport, setShowTextImport] = useState(false);
  const [showTransitionMenu, setShowTransitionMenu] = useState(false);
  const [showColorMenu, setShowColorMenu] = useState(false);
  const [showEffectsMenu, setShowEffectsMenu] = useState(false);
  const [showPixelEffectMenu, setShowPixelEffectMenu] = useState(false);
  const [showSfx, setShowSfx] = useState(false);
  const [showVoiceRecord, setShowVoiceRecord] = useState(false);
  const [showTextStyleMenu, setShowTextStyleMenu] = useState(false);
  const [showAnimationMenu, setShowAnimationMenu] = useState(false);
  const [showStyleMenu, setShowStyleMenu] = useState(false);
  const transitionButtonRef = useRef<HTMLButtonElement>(null);
  const colorButtonRef = useRef<HTMLButtonElement>(null);
  const effectsButtonRef = useRef<HTMLButtonElement>(null);
  const pixelEffectButtonRef = useRef<HTMLButtonElement>(null);
  const textButtonRef = useRef<HTMLButtonElement>(null);
  const animationButtonRef = useRef<HTMLButtonElement>(null);
  const styleButtonRef = useRef<HTMLButtonElement>(null);
  // Whether the scrollable tool row (below) is scrolled away from its own left edge — drives the
  // Media/Properties cluster's auto-hide (see its own comment for why). `> 4`, not `> 0`: a bounce/
  // rubber-band scroll on iOS Safari can report a few stray sub-pixel values at rest, which would
  // otherwise flicker the collapse in and out right at the resting position.
  const [toolsScrolled, setToolsScrolled] = useState(false);
  // Debounces the write above (see the row's own `onScroll` handler) — confirmed a real, reproducible
  // bug, not hypothetical: applying it on every raw scroll tick let the collapse's own width/opacity
  // transition start firing WHILE a touch-drag was still in progress, and shrinking the cluster to its
  // LEFT mid-gesture shifts the row itself sideways underneath the finger that's dragging it, which is
  // enough to make the browser abandon the rest of that scroll gesture entirely (reproduced directly:
  // an edge-to-edge drag immediately after selecting a clip only ever covered the first ~20px before
  // stopping dead, well short of the row's own actual scrollable distance). Waiting for scroll events to
  // go quiet for a beat before ever touching this state means the collapse's layout shift only ever
  // lands once a gesture has already ended (a lift, or a fling settling after the finger is already up),
  // never mid-drag.
  const toolsScrollSettleRef = useRef<number | null>(null);

  // Drives the Transition button's active/disabled look, and what `TransitionPickerMenu` (opened by
  // that button) applies to and highlights as currently selected. Enabled for ANY video/text clip now,
  // not just one with a genuinely adjacent predecessor — `findTransitionPartner` resolves a clip with
  // no eligible neighbor into a solo fade (from black for video, from transparent for text) rather than
  // refusing to apply at all, so there's no longer a real reason to gate the button on adjacency.
  const selectedId = selectedClipIds[0];
  const foundForTransition = project && selectedId ? findClip(project, selectedId) : undefined;
  const transitionActive = Boolean(foundForTransition?.clip.transitionIn || foundForTransition?.clip.transitionOut);
  const transitionDisabled = !foundForTransition || (foundForTransition.track.kind !== "video" && foundForTransition.track.kind !== "text");

  // Effects/Pixel Effects — video-track clips only (video/image/color-matte), same gating `ClipEffects`/
  // `pixelEffect`'s own doc comments give; a text/audio clip has neither. Reuses `foundForTransition`'s
  // already-resolved clip/track rather than a second `findClip` lookup for the same selection.
  const foundForVideoEffects = foundForTransition && foundForTransition.track.kind === "video" ? foundForTransition : undefined;
  const effectsDisabled = !foundForVideoEffects;
  const effectsActive = Boolean(foundForVideoEffects?.clip.effects);
  const pixelEffectActive = Boolean(foundForVideoEffects?.clip.pixelEffect);
  const assetForVideoEffects = project && foundForVideoEffects ? findAsset(project, foundForVideoEffects.clip.assetId) : undefined;

  // Remove Object — same selection as Effects/Pixel FX, but narrower: `RemoveObjectSection`
  // (Inspector.tsx) only ever renders for an actual video ASSET, not every video-track clip (an
  // image or color-matte on a video track has no frames to inpaint), so this button must match that
  // gating rather than reusing `effectsDisabled` as-is.
  const removeObjectDisabled = !foundForVideoEffects || assetForVideoEffects?.kind !== "video";

  // Extract Audio — same video-track gate as Effects/Pixel FX, narrowed further to a clip whose asset
  // actually HAS audio (`ExtractAudioCommand`'s own doc comment) — a silent video clip has nothing to
  // detach, same "hide, don't grey out, a tool with nothing to act on" convention every other
  // clip-kind-gated tool in this row already follows.
  const extractAudioDisabled = !foundForVideoEffects || !assetForVideoEffects?.hasAudio;

  // Auto Captions — same underlying gate Inspector's OWN `AutoCaptionsSection` uses for a single clip
  // (`asset?.hasAudio`, not track kind, so a video clip's own dialogue qualifies too, not just a
  // dedicated audio-track clip), generalized across the WHOLE selection: reachable the moment AT LEAST
  // ONE selected clip has audio — matching `DuplicateClipsCommand`'s own "not every clip in the
  // selection has to qualify" precedent, since a non-audio clip mixed into an otherwise-audio selection
  // is just skipped server-side (see `captions/route.ts`'s own `runCaptionsJob`), not a reason to hide
  // the tool entirely. Also gates the Mixer button just below (unchanged reasoning: still the most
  // likely reason to reach for it right after selecting audio-bearing clips).
  const captionsForClipDisabled =
    selectedClipIds.length === 0 ||
    !project ||
    !selectedClipIds.some((id) => {
      const found = findClip(project, id);
      return found ? findAsset(project, found.clip.assetId)?.hasAudio : false;
    });

  // Animation tool — enabled the moment ANY selected clip is on a text track, one or many (unlike
  // Transition/Effects/Pixel FX above, which only ever act on `selectedClipIds[0]`); this is the
  // actual point of promoting animation out of Inspector, where a genuine multi-select could only ever
  // show a placeholder. `animationCurrent` only has an answer worth highlighting when exactly one text
  // clip is selected — for a real multi-select, which tile (if any) should read "active" is ambiguous
  // whenever the selected clips don't all already share one animation, so nothing highlights instead
  // of guessing.
  const selectedTextClips = project ? selectedClipIds.map((id) => findClip(project, id)).filter((f) => f?.track.kind === "text") : [];
  const animationDisabled = selectedTextClips.length === 0;
  const animationCurrent = selectedTextClips.length === 1 ? selectedTextClips[0]!.clip.textAnimation : undefined;
  // Styles tool — same gating and same bulk/quick-apply role as Animation just above, for
  // `TextStylePreset` instead of `Clip.textAnimation`: promoted here so a look can be applied without
  // opening Inspector at all, backed by the exact same `applyTextStylePresetToSelection` Inspector's
  // own Styles section already uses. No "current" highlight (unlike Animation's `animationCurrent`):
  // a preset only ever SETS fields, it never reads back as "this clip currently matches preset X".
  const stylesDisabled = animationDisabled;

  // Right-click context menu (desktop only — `TimelineClip`'s own `onContextMenu` never fires from
  // touch) — see `ClipContextMenu.tsx`'s own doc comment for why it's a plain, ungated action list
  // fed by exactly the same disabled flags computed above for the toolbar, rather than a second copy
  // of "what can act on this selection" logic.
  const contextMenu = useEditorStore((s) => s.contextMenu);
  const setContextMenu = useEditorStore((s) => s.setContextMenu);
  // A single invisible, zero-size anchor point every picker below can target when opened FROM the
  // context menu, instead of the real toolbar button it normally anchors to — repositioned to the
  // menu's own click point on open. `pickerAnchorSource` is what tells each picker's own `anchorRef`
  // prop which of the two anchors currently applies; only one picker is ever open at a time in
  // practice, so one shared flag (not one per picker) is enough.
  const contextMenuAnchorRef = useRef<HTMLDivElement>(null);
  const [pickerAnchorSource, setPickerAnchorSource] = useState<"button" | "contextMenu">("button");

  const contextMenuActions: ClipContextMenuAction[] = contextMenu
    ? [
        { key: "duplicate", label: t("Duplicate"), icon: <Copy size={15} />, onClick: duplicateSelectedClips },
        { key: "split", label: t("Split at playhead"), icon: <Split size={15} />, onClick: splitAtPlayhead },
        ...(!stylesDisabled
          ? [
              {
                key: "styles",
                label: t("Styles"),
                icon: <Grid size={15} />,
                onClick: () => {
                  setPickerAnchorSource("contextMenu");
                  setShowStyleMenu(true);
                },
              },
            ]
          : []),
        ...(!animationDisabled
          ? [
              {
                key: "animation",
                label: t("Animation"),
                icon: <Star size={15} />,
                onClick: () => {
                  setPickerAnchorSource("contextMenu");
                  setShowAnimationMenu(true);
                },
              },
            ]
          : []),
        ...(!transitionDisabled
          ? [
              {
                key: "transition",
                label: t("Transition"),
                icon: <Transition size={15} />,
                onClick: () => {
                  setPickerAnchorSource("contextMenu");
                  setShowTransitionMenu(true);
                },
              },
            ]
          : []),
        ...(!effectsDisabled
          ? [
              {
                key: "effects",
                label: t("Effects"),
                icon: <Filter size={15} />,
                onClick: () => {
                  setPickerAnchorSource("contextMenu");
                  setShowEffectsMenu(true);
                },
              },
              {
                key: "pixelEffect",
                label: t("Pixel Effects"),
                icon: <Ai size={15} />,
                onClick: () => {
                  setPickerAnchorSource("contextMenu");
                  setShowPixelEffectMenu(true);
                },
              },
            ]
          : []),
        ...(!removeObjectDisabled
          ? [
              {
                key: "removeObject",
                label: t("Remove Object"),
                icon: <Backspace size={15} />,
                // No `setMobileSheet` here — this action only ever reaches a user through the
                // right-click context menu, which is desktop-only by construction (a touch long-press
                // opens a DIFFERENT menu entirely — see TimelineClip.tsx). Desktop already shows
                // Properties in its own permanent column; setting `mobileSheet` here was the same
                // confirmed bug the toolbar button's own version of this action just got fixed for —
                // silently swapping the desktop Timeline row out for a second, redundant Inspector.
                onClick: () => {
                  if (!foundForVideoEffects) return;
                  armRemoveObject(foundForVideoEffects.clip.id);
                },
              },
            ]
          : []),
        ...(!extractAudioDisabled
          ? [
              {
                key: "extractAudio",
                label: t("Extract Audio"),
                icon: <Music size={15} />,
                onClick: () => {
                  if (!foundForVideoEffects) return;
                  extractAudioFromClip(foundForVideoEffects.clip.id);
                },
              },
            ]
          : []),
        { key: "delete", label: t("Delete"), icon: <Delete size={15} />, onClick: () => run(new DeleteClipsCommand(selectedClipIds)), danger: true },
      ]
    : [];

  return (
    <footer className="flex shrink-0 items-center gap-1 border-t border-white/10 bg-[#0d0f14] px-2 py-1.5 text-[11px]">
      {/* Icons only now — the status message and save-state text that used to share this row moved to
          a floating toast (`StatusToast`) and the header (`SaveStatus`) respectively. This row was
          already the tightest space in the whole editor (up to 11 icons, some already pushed into
          horizontal overflow scroll on a phone — see the comment below), and neither of those two
          pieces of text is something a user is trying to TAP; keeping them here only ever cost this
          row space without adding anything reachable. Below `lg`, Media/Properties have no permanent
          side column anymore (see VCutApp's own comment on `mobileSheet`) — this is where they're
          reached instead, which pushed the button count past what a phone's width can show without
          scrolling; `scrollbar-none` matches Timeline's own horizontal scrollbar treatment. */}
      {/* Media/Properties, mobile-only — sits at the row's LEFT edge, ahead of the scrollable tool row,
          and auto-collapses (width/opacity transition, not unmounted — `toolsScrolled` just tracks the
          tool row's own `scrollLeft`) the instant that row is scrolled away from its start, reappearing
          the moment it's scrolled back. Media/Properties are the two a mobile user reaches for
          constantly (they're the ONLY way in to either panel below `lg` — see `mobileSheet`'s own
          comment), so they stay right there at rest — but the tool row alone already needs horizontal
          scrolling to show every tool (see that row's own comment), and permanently reserving space for
          this cluster while actively scrolling through Split/Transition/Effects/etc. just eats into the
          same cramped width without being reachable mid-scroll anyway. Desktop keeps its permanent side
          columns (see VCutApp's grid) and never sets `mobileSheet`, so this stays irrelevant there
          regardless of `lg:hidden`. Toggling: tapping the already-open one returns to Timeline, matching
          `active`'s highlighted state always reflecting what's actually showing below.
          `mobileSheet !== null` skips the auto-collapse entirely while either panel is actually open —
          whichever one you're in stays reachable to tap closed again (or switch to the other) no
          matter how far the tool row is scrolled, rather than needing to scroll it back to the start
          first just to get back to Timeline.
          Also skipped (stays permanently open, never unmounted) while a clip is selected — Properties
          is the ONLY way below `lg` to see/edit that clip's own settings, so hiding this cluster on
          selection (an earlier version of this fix did exactly that, to solve the bug described next)
          was a real, reported regression: it made Properties completely unreachable at the one moment
          it's most wanted. The bug that first motivated touching this at all was real too, just needed
          a narrower fix: with a clip selected, scrolling the (much narrower) tool row all the way to its
          own end used to cross the `toolsScrolled` threshold and collapse this cluster mid-gesture,
          which WIDENED the row out from under the same scroll — the browser responds by clamping
          `scrollLeft` back down to the new, smaller max, snapping the row visibly backward right after
          the swipe finishes (reads exactly like "the toolbar can't be scrolled"). Keeping the cluster
          permanently open during a selection (rather than unmounting it) fixes that the same way: there's
          simply nothing left for `toolsScrolled` to collapse into while a clip is selected, so the
          mid-gesture width shift can't happen either way — without also taking Properties away. */}
      <div
        className={`flex shrink-0 items-center gap-0.5 overflow-hidden border-r border-white/10 pr-1 transition-all duration-200 ease-out lg:hidden ${
          toolsScrolled && mobileSheet === null && selectedClipIds.length === 0
            ? "max-w-0 border-r-0 pr-0 opacity-0"
            : "max-w-[120px] opacity-100"
        }`}
      >
        <ToolbarButton
          title={t("Media")}
          label={t("Media")}
          active={mobileSheet === "media"}
          onClick={() => setMobileSheet(mobileSheet === "media" ? null : "media")}
        >
          <Video size={18} />
        </ToolbarButton>
        <ToolbarButton
          title={t("Properties")}
          label={t("Properties")}
          active={mobileSheet === "inspector"}
          onClick={() => setMobileSheet(mobileSheet === "inspector" ? null : "inspector")}
        >
          <Settings size={18} />
        </ToolbarButton>
      </div>

      {/* Deselecting is what actually narrows the row back down (see the `selectedClipIds.length ===
          0` gates throughout the scrollable row below) — this button is just the explicit, discoverable
          way to trigger that instead of needing to know a tap on empty canvas/timeline space does the
          same thing. Lives OUTSIDE the scrollable row (like Media/Properties above), not as its own
          first scrollable item — the whole point of "easy to get back" is defeated if reaching it first
          requires scrolling the row back to its own start. Both mobile and desktop: unlike Media/
          Properties, there's no `lg:hidden` here — a selection narrowing the row down is not a
          mobile-only space concern. */}
      {selectedClipIds.length > 0 && (
        <button
          onClick={() => select([])}
          title={t("Back to all tools")}
          aria-label={t("Back to all tools")}
          // Filled rounded-square, no label, deliberately more prominent than a plain icon+label
          // `ToolbarButton` — the one control that gets you OUT of this narrowed view needs to read as
          // its own distinct kind of button at a glance, not just one more tool in the row.
          className="flex h-10 w-11 shrink-0 items-center justify-center rounded-lg bg-white/10 text-white transition hover:bg-white/20"
        >
          <span className="flex items-center">
            <ChevronLeft size={16} className="-mr-2.5" />
            <ChevronLeft size={16} />
          </span>
        </button>
      )}

      <div
        className="scrollbar-none flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
        onScroll={(e) => {
          // See `toolsScrollSettleRef`'s own comment: deliberately NOT `setToolsScrolled` directly here.
          const left = e.currentTarget.scrollLeft;
          if (toolsScrollSettleRef.current !== null) window.clearTimeout(toolsScrollSettleRef.current);
          toolsScrollSettleRef.current = window.setTimeout(() => setToolsScrolled(left > 4), 150);
        }}
      >
        {/* Workflow order, left to right: TEXT tools first (everything about creating/styling text —
            what you reach for to build a titled/captioned sequence), then MEDIA (everything else you
            add to the timeline), then STRUCTURAL edits (reshaping what's already there), then
            destructive/save actions last (Delete right before Save specifically — "remove, then commit
            the result" is the natural order those two get used in together, and it keeps the one
            irreversible-feeling action away from the row's own leading edge, where a stray tap/click
            during a fast workflow is most likely to land). */}

        {/* Text/Script/Captions/SFX/Color/Mixer/Scopes below — everything about adding NEW content or
            opening a whole-project panel, none of it about the currently selected clip — hide instead
            of merely leaving disabled the moment a clip IS selected: a real, explicit request (matching
            this toolbar's existing "hide, don't grey out" convention for a tool a selection can't use)
            to cut the row down to just what's usable RIGHT NOW once you're mid-edit on a specific clip,
            with the back button below as the one, explicit way out of that narrowed view rather than
            needing to deselect via the canvas/timeline first. Split/Duplicate/Transition/Effects/Pixel
            FX/Remove Object/Delete/Save (further down) stay exactly as they already were — each already
            gates on the SELECTION itself, which is precisely what should still show here. */}
        {selectedClipIds.length === 0 && (
          <>
            {/* Text: a style-picker popover rather than an instant create — lets a look be chosen up
                front (same presets Script/Captions/Inspector's own Styles section offer) instead of
                always landing `DEFAULT_TEXT_STYLE` and restyling afterward. Moved here (from the Media
                panel) long before this grouping existed, so both land straight on the timeline (and so
                in the preview) the instant they're created, rather than sitting as a library-only asset
                waiting for a separate double-click/drag to place — still true of Script/Captions below
                it. */}
            <ToolbarButton
              ref={textButtonRef}
              title={t("Add text")}
              label={t("Text")}
              active={showTextStyleMenu}
              onClick={() => setShowTextStyleMenu((v) => !v)}
            >
              {/* The label reads "Text" on its own — this is what signals "adds a new one" instead, a
                  small "+" badge on the glyph itself rather than spelling it out in the label text
                  (which would read oddly once selected/active, unlike a plain "Text" label). */}
              <span className="relative inline-flex">
                <Text size={18} />
                <span
                  aria-hidden
                  className="absolute -bottom-0.5 -right-1 flex h-3 w-3 items-center justify-center rounded-full bg-sky-500 text-[8px] font-bold leading-none text-white"
                >
                  +
                </span>
              </span>
            </ToolbarButton>
            {showTextStyleMenu && (
              <TextStylePickerMenu
                anchorRef={textButtonRef}
                onPick={(style) => setComposeText({ style })}
                onClose={() => setShowTextStyleMenu(false)}
              />
            )}
            <ToolbarButton title={t("Import Text as Clips")} label={t("Script")} onClick={() => setShowTextImport(true)}>
              <Document size={18} />
            </ToolbarButton>
          </>
        )}
        {/* Auto Captions — the ONE "add content" tool from the block above that stays reachable once a
            selection exists too, as long as at least one selected clip has audio: this is the
            whole-sequence entry point with nothing selected, the SAME button/position/icon opening the
            SAME dialog scoped to the selected clip(s) (`startCaptions`'s own `clipIds` param — one clip
            runs the same job Inspector's inline `AutoCaptionsSection` does, several run ONE combined,
            gap-skipping pass, see that function's own doc comment) the instant a qualifying selection
            exists — a modal, not Inspector, so this stays a single, direct click on both mobile and
            desktop rather than landing on a permanent column already showing (desktop) or a sheet that
            then needs finding the right tab in (mobile). */}
        {(selectedClipIds.length === 0 || !captionsForClipDisabled) && (
          <ToolbarButton
            title={
              selectedClipIds.length === 0
                ? t("Auto Captions")
                : selectedClipIds.length === 1
                  ? t("Auto Captions for this clip")
                  : t("Auto Captions for the selected clips")
            }
            label={t("Captions")}
            pro={HOSTED}
            onClick={() => setCaptionsDialog(selectedClipIds.length === 0 ? {} : { clipIds: selectedClipIds })}
          >
            <ClosedCaption size={18} />
          </ToolbarButton>
        )}
        {/* Mixer — same reasoning and same gate as Auto Captions just above (stays reachable once a
            single clip with audio is selected, not just with nothing selected), though unlike
            Captions this ISN'T clip-scoped: it always opens the whole project's own per-track fader
            panel, since there's no per-clip mixer to show instead. Still the most likely reason to
            reach for it right after selecting an audio clip (adjusting THAT clip's own track gain/
            pan), so it earns the same reachability even without a scoped view to back it. */}
        {(selectedClipIds.length === 0 || !captionsForClipDisabled) && (
          <ToolbarButton
            title={t("Audio Mixer")}
            label={t("Mixer")}
            active={bottomPanel === "mixer" || floatingPanel === "mixer"}
            onClick={() => {
              if (floatingPanel === "mixer") {
                onDockFloating();
                setBottomPanel("mixer");
              } else {
                setBottomPanel(bottomPanel === "mixer" ? "timeline" : "mixer");
              }
            }}
          >
            <Volume size={18} />
          </ToolbarButton>
        )}
        {/* The bulk/quick-apply path for `Clip.textAnimation` — works on however many text clips are
            currently selected (see `animationCurrent`/`selectedTextClips` above), one shared undo step
            either way. Inspector's own Animation section is still where speed/highlight-color get
            fine-tuned afterward, one clip at a time. Hidden rather than merely disabled when no text
            clip is selected — see the group of toolbar tools below this file's own "hide, don't just
            grey out" comment for the full reasoning shared by all of them. */}
        {!stylesDisabled && (
          <>
            <ToolbarButton
              ref={styleButtonRef}
              title={t("Styles")}
              label={t("Styles")}
              active={showStyleMenu}
              onClick={() => {
                setPickerAnchorSource("button");
                setShowStyleMenu((v) => !v);
              }}
            >
              <Grid size={18} />
            </ToolbarButton>
            {showStyleMenu && (
              <StylePickerMenu
                anchorRef={pickerAnchorSource === "contextMenu" ? contextMenuAnchorRef : styleButtonRef}
                onPick={applyTextStylePresetToSelection}
                onClose={() => setShowStyleMenu(false)}
              />
            )}
          </>
        )}
        {!animationDisabled && (
          <>
            <ToolbarButton
              ref={animationButtonRef}
              title={t("Animation")}
              label={t("Animation")}
              active={showAnimationMenu || Boolean(animationCurrent)}
              onClick={() => {
                setPickerAnchorSource("button");
                setShowAnimationMenu((v) => !v);
              }}
            >
              <Star size={18} />
            </ToolbarButton>
            {showAnimationMenu && (
              <AnimationPickerMenu
                anchorRef={pickerAnchorSource === "contextMenu" ? contextMenuAnchorRef : animationButtonRef}
                current={animationCurrent}
                onPick={applyTextAnimationToSelection}
                onClose={() => setShowAnimationMenu(false)}
              />
            )}
          </>
        )}

        {selectedClipIds.length === 0 && (
          <>
            <span className="mx-1 h-5 w-px shrink-0 bg-white/10" />

            {/* Opens the Voice Record modal instead of recording immediately on click (that used to be
                this button's own behavior, via the now-removed `VoiceoverRecorder` component) —
                confirmed a real, explicit request for a deliberate record surface (tap-to-countdown or
                press-and-hold-to-record, an optional Teleprompter, and post-processing choices) rather
                than an instant always-armed toggle. */}
            <ToolbarButton title={t("Record a voiceover from your microphone")} label={t("Voice")} onClick={() => setShowVoiceRecord(true)}>
              <Microphone size={18} />
            </ToolbarButton>
            {/* Silences the whole live-preview mix (see `previewMuted`'s own doc comment) — sits right
                next to Voice since the one real reason to reach for it is recording a voiceover while
                the sequence keeps playing for reference, without its existing audio bleeding back into
                the mic through the speakers. Never touches the actual project (no persisted mute, no
                effect on export), so it's safe to leave on/off across sessions without a "did I
                accidentally mute my export" worry. */}
            <ToolbarButton
              title={previewMuted ? t("Unmute sequence preview") : t("Mute sequence preview")}
              label={previewMuted ? t("Muted") : t("Mute")}
              active={previewMuted}
              onClick={togglePreviewMuted}
            >
              <span className="relative inline-flex">
                <Volume size={18} />
                {previewMuted && (
                  <span
                    aria-hidden
                    className="absolute left-1/2 top-1/2 h-[2px] w-[22px] -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-full bg-rose-400"
                  />
                )}
              </span>
            </ToolbarButton>
            <ToolbarButton title={t("Sound Effects")} label={t("SFX")} onClick={() => setShowSfx(true)}>
              <Headphone size={18} />
            </ToolbarButton>
            <ToolbarButton
              ref={colorButtonRef}
              title={t("Add a color background")}
              label={t("Color")}
              active={showColorMenu}
              onClick={() => setShowColorMenu((v) => !v)}
            >
              <Art size={18} />
            </ToolbarButton>
            {showColorMenu && (
              <ColorPickerMenu
                anchorRef={colorButtonRef}
                onPick={(color) => addColorAtPlayhead(color)}
                onClose={() => setShowColorMenu(false)}
              />
            )}
            <ToolbarButton
              title={t("Scopes")}
              label={t("Scopes")}
              active={bottomPanel === "scopes" || floatingPanel === "scopes"}
              onClick={() => {
                if (floatingPanel === "scopes") {
                  onDockFloating();
                  setBottomPanel("scopes");
                } else {
                  setBottomPanel(bottomPanel === "scopes" ? "timeline" : "scopes");
                }
              }}
            >
              <Gauge size={18} />
            </ToolbarButton>
          </>
        )}

        {/* Both this divider and the one right after the In/Out/Range group below are gated the SAME
            way as everything between them — with nothing visible on either side of the gap, an
            unconditional divider here would just show up as a stray, orphaned line the moment a clip
            IS selected (confirmed a real, reported visual bug, not hypothetical). */}
        {selectedClipIds.length === 0 && <span className="mx-1 h-5 w-px shrink-0 bg-white/10" />}

        {/* Mobile-only stand-ins for Timeline.tsx's own "Set In"/"Set Out"/"× Range" header buttons —
            see the hooks above for why. Same amber accent as those, so the two read as the same
            feature regardless of which one happens to be visible. Hidden (not just Set In/Out — the
            whole group, same as the "add content" tools above) the moment a clip IS selected — same
            "this narrowed view is for what the SELECTION can do" reasoning that section's own comment
            gives, extended here since marking a range isn't something the current selection can act
            on either despite not being clip-kind-gated the way Transition/Effects are. */}
        {selectedClipIds.length === 0 && (
          <>
            <ToolbarButton
              title={t("Set export range start at playhead (I)")}
              label={t("Set In")}
              onClick={() => setExportRangeStart(useEditorStore.getState().playhead)}
              className="lg:hidden"
            >
              <span className="text-[16px] font-bold leading-none text-amber-300">[</span>
            </ToolbarButton>
            <ToolbarButton
              title={t("Set export range end at playhead (O)")}
              label={t("Set Out")}
              onClick={() => setExportRangeEnd(useEditorStore.getState().playhead)}
              className="lg:hidden"
            >
              <span className="text-[16px] font-bold leading-none text-amber-300">]</span>
            </ToolbarButton>
            {hasExportRange && (
              <ToolbarButton
                title={t("Clear export in/out range (Shift+X)")}
                label={t("× Range")}
                onClick={() => clearExportRange()}
                className="lg:hidden"
              >
                <span className="text-[16px] font-bold leading-none text-amber-300">×</span>
              </ToolbarButton>
            )}
          </>
        )}

        {selectedClipIds.length === 0 && <span className="mx-1 h-5 w-px shrink-0 bg-white/10 lg:hidden" />}

        <ToolbarButton title={t("Split at playhead (S)")} label={t("Split")} onClick={splitAtPlayhead}>
          <Split size={18} />
        </ToolbarButton>
        {/* Hidden (not just greyed out) whenever it has nothing to act on — same "a tool that can't do
            anything right now isn't worth a permanent slot in the row" call every clip-kind-gated tool
            in this toolbar now makes, extended here to "no selection at all" rather than "wrong kind of
            clip selected": Duplicate/Delete work identically regardless of kind, so the only thing that
            ever disables them is an empty selection. Confirmed as the intended UX, not merely tolerated:
            a real, explicit request to stop showing tools a viewer can't currently use rather than
            showing them greyed out. */}
        {selectedClipIds.length > 0 && (
          <ToolbarButton title={t("Duplicate selected (Ctrl+D)")} label={t("Duplicate")} onClick={duplicateSelectedClips}>
            <Copy size={18} />
          </ToolbarButton>
        )}

        {/* Opens a grid of every transition style, each tile a live animated preview
            (`TransitionPickerMenu`), with an In/Out tab switch covering both `transitionIn` and
            `transitionOut` — the Inspector's own "Transition In"/"Transition Out" sections (the same
            underlying `SetClipTransitionCommand`/`SetClipTransitionOutCommand`) are still where each
            direction's duration gets fine-tuned afterward. Hidden, not disabled, for a selection this
            can't act on (see `transitionDisabled`'s own doc comment for exactly which) — same
            "a tool with nothing to do doesn't get a permanent slot in the row" call this toolbar makes
            throughout, in place of what used to be a greyed-out button a viewer had to notice was
            inert rather than just not seeing it at all. */}
        {!transitionDisabled && (
          <>
            <ToolbarButton
              ref={transitionButtonRef}
              title={transitionActive ? t("Change or remove transition") : t("Choose a transition")}
              label={t("Transition")}
              active={transitionActive}
              onClick={() => {
                setPickerAnchorSource("button");
                setShowTransitionMenu((v) => !v);
              }}
            >
              <Transition size={18} />
            </ToolbarButton>
            {showTransitionMenu && foundForTransition && (
              <TransitionPickerMenu
                anchorRef={pickerAnchorSource === "contextMenu" ? contextMenuAnchorRef : transitionButtonRef}
                isAudioTrack={foundForTransition.track.kind === "audio"}
                isTextTrack={foundForTransition.track.kind === "text"}
                activeIn={foundForTransition.clip.transitionIn?.type ?? null}
                activeOut={foundForTransition.clip.transitionOut?.type ?? null}
                onChangeIn={(type) => {
                  if (!type) {
                    run(new SetClipTransitionCommand(foundForTransition.clip.id, null));
                    return;
                  }
                  const duration = foundForTransition.clip.transitionIn?.duration ?? DEFAULT_TRANSITION.duration;
                  run(new SetClipTransitionCommand(foundForTransition.clip.id, { duration, type }));
                }}
                onChangeOut={(type) => {
                  if (!type) {
                    run(new SetClipTransitionOutCommand(foundForTransition.clip.id, null));
                    return;
                  }
                  const duration = foundForTransition.clip.transitionOut?.duration ?? DEFAULT_TRANSITION.duration;
                  run(new SetClipTransitionOutCommand(foundForTransition.clip.id, { duration, type }));
                }}
                onClose={() => setShowTransitionMenu(false)}
              />
            )}
          </>
        )}

        {/* Quick-pick popovers over the selected clip's own Effects/Pixel Effects — the Inspector's
            Effects section still has the full brightness/contrast/saturation/blur/opacity sliders for
            fine-tuning afterward; these are the fast, preset-driven path, same split
            `EffectsPickerMenu`/`PixelEffectPickerMenu`'s own doc comments describe. Hidden, not
            disabled, whenever the selection is a text/audio clip (or nothing) neither can act on —
            same reasoning as Transition above. */}
        {!effectsDisabled && (
          <>
            <ToolbarButton
              ref={effectsButtonRef}
              title={t("Effects")}
              label={t("Effects")}
              active={effectsActive}
              onClick={() => {
                setPickerAnchorSource("button");
                setShowEffectsMenu((v) => !v);
              }}
            >
              <Filter size={18} />
            </ToolbarButton>
            {showEffectsMenu && foundForVideoEffects && (
              <EffectsPickerMenu
                anchorRef={pickerAnchorSource === "contextMenu" ? contextMenuAnchorRef : effectsButtonRef}
                clip={foundForVideoEffects.clip}
                asset={assetForVideoEffects}
                projectId={projectId}
                onClose={() => setShowEffectsMenu(false)}
              />
            )}
            <ToolbarButton
              ref={pixelEffectButtonRef}
              title={t("Pixel Effects")}
              label={t("Pixel FX")}
              active={pixelEffectActive}
              onClick={() => {
                setPickerAnchorSource("button");
                setShowPixelEffectMenu((v) => !v);
              }}
            >
              <Ai size={18} />
            </ToolbarButton>
            {showPixelEffectMenu && foundForVideoEffects && (
              <PixelEffectPickerMenu
                anchorRef={pickerAnchorSource === "contextMenu" ? contextMenuAnchorRef : pixelEffectButtonRef}
                clip={foundForVideoEffects.clip}
                asset={assetForVideoEffects}
                projectId={projectId}
                onClose={() => setShowPixelEffectMenu(false)}
              />
            )}
          </>
        )}

        {/* Arms the same draw-a-rectangle flow the Inspector's `RemoveObjectSection` exposes
            (`removeObjectArmedClipId` drives `RemoveObjectOverlay`, mounted over the Preview canvas) —
            unlike Effects/Pixel FX above, there's no popover menu here; the prompt field and
            run/progress UI only exist in that Inspector section, so tapping this also opens the
            Inspector sheet on mobile. NOT unconditional, despite desktop having its own permanent
            Properties column that never needs `mobileSheet` set — confirmed a real, reported bug:
            `mobileSheet` doubles as "which panel replaces the TIMELINE row on a narrow screen" (see
            that row's own comment further down), and setting it on DESKTOP too was silently swapping
            the desktop Timeline itself out for a second, redundant Inspector instead of doing nothing
            the way the permanent column already made correct. `lg` (1024px) is this app's own
            breakpoint for "has that permanent column" everywhere else here, so it's what gates this
            too. Hidden, not disabled, for anything that isn't an actual video asset — same reasoning
            as Transition/Effects above. */}
        {!removeObjectDisabled && (
          <ToolbarButton
            title={t("Remove Object")}
            label={t("Remove")}
            pro={HOSTED}
            onClick={() => {
              if (!foundForVideoEffects) return;
              armRemoveObject(foundForVideoEffects.clip.id);
              if (!window.matchMedia("(min-width: 1024px)").matches) setMobileSheet("inspector");
            }}
          >
            <Backspace size={18} />
          </ToolbarButton>
        )}

        {/* Detaches this clip's own embedded audio onto a new clip on an audio track (see
            `ExtractAudioCommand`'s own doc comment) — hidden, not disabled, for anything that isn't a
            video-track clip with real audio to detach, same convention every other clip-kind-gated
            tool in this row already follows. */}
        {!extractAudioDisabled && (
          <ToolbarButton
            title={t("Extract Audio")}
            label={t("Extract Audio")}
            onClick={() => {
              if (!foundForVideoEffects) return;
              extractAudioFromClip(foundForVideoEffects.clip.id);
            }}
          >
            <Music size={18} />
          </ToolbarButton>
        )}

        <span className="mx-1 h-5 w-px shrink-0 bg-white/10" />

        {/* Hidden, not disabled, with an empty selection — same reasoning as Duplicate above. */}
        {selectedClipIds.length > 0 && (
          <ToolbarButton title={t("Delete selected (Del)")} label={t("Delete")} onClick={() => run(new DeleteClipsCommand(selectedClipIds))}>
            <Delete size={18} />
          </ToolbarButton>
        )}
        <ToolbarButton
          title={t("Save (Ctrl+S)")}
          label={t("Save")}
          onClick={() => {
            void save();
            setStatus(t("Project saved"));
          }}
        >
          <Save size={18} />
        </ToolbarButton>
      </div>
      {captionsDialog && <AutoCaptionsDialog clipIds={captionsDialog.clipIds} onClose={() => setCaptionsDialog(null)} />}
      {showVoiceRecord && <VoiceRecordModal onClose={() => setShowVoiceRecord(false)} />}
      {showTextImport && <TextToClipsDialog onClose={() => setShowTextImport(false)} />}
      {showSfx && <SfxPanel onClose={() => setShowSfx(false)} />}
      <NewTextComposer />
      {/* Zero-size, invisible — exists only so the picker menus above have a real DOM element to
          anchor to (`getBoundingClientRect()`) when opened FROM the context menu instead of their own
          toolbar button. Repositioning it via plain inline style (not React state driving layout) is
          fine here: it has no visible box for a layout shift to matter, so it can move outside React's
          normal render cycle without any visual cost. */}
      <div ref={contextMenuAnchorRef} style={{ position: "fixed", left: contextMenu?.x ?? 0, top: contextMenu?.y ?? 0 }} />
      {contextMenu && <ClipContextMenu x={contextMenu.x} y={contextMenu.y} actions={contextMenuActions} onClose={() => setContextMenu(null)} />}
    </footer>
  );
}

/** Persistent save-state indicator — "Saving…" / "Unsaved changes" / "All changes saved" — moved into
 *  the header (see VCutApp's own JSX) out of the toolbar footer, which had no room to spare for
 *  text that isn't a button. The header has exactly three other things in it (the "VCut" wordmark,
 *  the project title, the Export button), so this is genuinely uncrowded space by comparison. */
function SaveStatus() {
  const dirty = useEditorStore((s) => s.dirty);
  const saving = useEditorStore((s) => s.saving);
  const lastSavedAt = useEditorStore((s) => s.lastSavedAt);
  const t = useTranslation();
  const [showSaved, setShowSaved] = useState(false);

  // "All changes saved" is a confirmation, not an ongoing state the way "Saving…"/"Unsaved changes"
  // are — worth a moment's glance, not worth permanently occupying header space forever after. Same
  // "success message auto-clears, error doesn't linger forever either" spirit as `StatusToast`'s own
  // timer, just without needing a manual-dismiss escape hatch (this one's text is short and never an
  // error). Re-fires on every new `lastSavedAt`: a later save while an earlier one's timer is still
  // counting down restarts the full 3s rather than letting the message flicker off between them.
  useEffect(() => {
    if (!lastSavedAt || dirty || saving) return;
    setShowSaved(true);
    const timer = setTimeout(() => setShowSaved(false), 3000);
    return () => clearTimeout(timer);
  }, [lastSavedAt, dirty, saving]);

  const text = saving ? t("Saving…") : dirty ? t("Unsaved changes") : showSaved ? t("All changes saved") : "";
  if (!text) return null;

  return <span className="shrink-0 truncate text-[11px] text-white/40">{text}</span>;
}

/** Transient status/error messages — used to share the toolbar footer with the icon buttons, where
 *  they were squeezed to `max-w-[40vw]` and truncated on top of an already-tight row. A floating toast
 *  instead: full width to breathe, doesn't cost the toolbar a single pixel of its own layout, and (via
 *  `createPortal`) is immune to the same "an ancestor with `transform` becomes a `position: fixed`
 *  descendant's containing block" gotcha `ConfirmDialog` already documents its own portal for — nothing
 *  here currently applies a transform, but nothing guarantees a future ancestor won't either. */
function StatusToast() {
  const status = useEditorStore((s) => s.status);
  const setStatus = useEditorStore((s) => s.setStatus);

  // Every status eventually clears itself — errors just get longer on screen (6s vs. 3s) since one
  // the user blinked and missed is worse than a transient success message would be, but "longer" is
  // not "forever": an error nobody ever replaces with a new status (the common case — most edits
  // never fail again right after one does) used to sit there indefinitely with no way to close it.
  // The manual dismiss button below is the other half of the actual fix — even 6s can be too eager to
  // read a longer message, so closing it shouldn't require waiting out a timer either.
  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(null), status.tone === "error" ? 6000 : 3000);
    return () => clearTimeout(timer);
  }, [status, setStatus]);

  if (!status) return null;

  return createPortal(
    <div
      aria-live="polite"
      role={status.tone === "error" ? "alert" : "status"}
      // `bottom-16` clears the footer toolbar (icon+label buttons are 40px tall plus padding, ~52px
      // total, now that labels were added below each icon) so the toast sits just above it rather than
      // covering the very buttons a user might want to react with. `pointer-events-none` on the
      // wrapper + `-auto` on the pill itself: the empty space around the centered pill must stay
      // click-through (it spans the full width so the pill can center in it), but the pill itself
      // stays interactive for the dismiss button below.
      className="pointer-events-none fixed inset-x-0 bottom-16 z-40 flex justify-center px-4"
    >
      <div
        className={`pointer-events-auto flex max-w-[90vw] items-center gap-2 rounded-md py-1.5 pl-3 pr-1.5 text-xs shadow-lg ${
          status.tone === "error" ? "bg-rose-500/95 text-white" : "border border-white/10 bg-[#181b22] text-white/80"
        }`}
      >
        <span className="truncate">{status.message}</span>
        <button
          onClick={() => setStatus(null)}
          aria-label="Dismiss"
          className={`shrink-0 rounded p-0.5 leading-none transition ${
            status.tone === "error" ? "text-white/70 hover:bg-white/15 hover:text-white" : "text-white/40 hover:bg-white/10 hover:text-white/80"
          }`}
        >
          ✕
        </button>
      </div>
    </div>,
    document.body
  );
}

/** Click-to-rename project title, sitting in the header next to "VCut". `project.name` (not the
 *  `projectName` prop a host app like BP Studio passes in) is the only thing this reads or writes —
 *  that prop only ever SEEDS `project.name` at creation time (see `load`'s own comment), so once a
 *  project exists its name lives entirely in the project itself, and a rename here is exactly as
 *  durable/visible as any other edit (autosaved, and reflected back in VCut's own project list). */
function EditableProjectTitle() {
  const name = useEditorStore((s) => s.project?.name ?? "");
  const renameProject = useEditorStore((s) => s.renameProject);
  const t = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  // Set right before an Escape-triggered exit, so the `onBlur` that follows (removing the input from
  // the DOM mid-focus fires one) knows to discard rather than commit — Escape means "cancel", not
  // "save whatever's currently typed". Same pattern TextTransformHandles.tsx uses for its own inline
  // text editor.
  const skipCommitRef = useRef(false);

  function startEditing() {
    setDraft(name);
    setEditing(true);
  }

  function commit() {
    if (skipCommitRef.current) {
      skipCommitRef.current = false;
      return;
    }
    setEditing(false);
    renameProject(draft);
  }

  if (editing) {
    return (
      <input
        ref={(el) => el?.focus()}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            skipCommitRef.current = true;
            setEditing(false);
          }
          // Enter commits, matching a single-line "done typing" expectation — a plain text input has
          // no newline to worry about swallowing the way the tap-to-edit text-clip textarea does.
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
        aria-label={t("Project name")}
        className="min-w-0 max-w-[240px] flex-1 rounded bg-white/10 px-1.5 py-0.5 text-xs text-white outline-none ring-1 ring-sky-400/60"
      />
    );
  }

  return (
    <button
      onClick={startEditing}
      title={t("Rename project")}
      aria-label={t("Rename project")}
      className="min-w-0 max-w-[240px] flex-1 truncate rounded px-1.5 py-0.5 text-left text-xs text-white/35 transition hover:bg-white/10 hover:text-white/70"
    >
      {name}
    </button>
  );
}

interface VCutAppProps {
  projectId: string;
  projectName?: string;
  // Optional: a host-embedded editor (BP Studio's `<iframe>`, today) has no "VCut project list" of
  // its own to go back to, so VCutApp itself stays agnostic about whether one exists rather than
  // assuming "/" is always a valid place to send the user — see `edit/page.tsx`'s own comment on how
  // it decides whether to pass this.
  onHome?: () => void;
}

function VCutAppInner({ projectId, projectName, onHome }: VCutAppProps) {
  const load = useEditorStore((s) => s.load);
  const loading = useEditorStore((s) => s.loading);
  const loadError = useEditorStore((s) => s.loadError);
  const loadErrorStatus = useEditorStore((s) => s.loadErrorStatus);
  const project = useEditorStore((s) => s.project);
  const language = useEditorStore((s) => s.language);
  const setLanguage = useEditorStore((s) => s.setLanguage);
  const t = useTranslation();
  const [exportOpen, setExportOpen] = useState(false);
  // Non-null once signed in, on any platform configured with real Supabase credentials — web (as
  // before), desktop via the `vcut://` callback below, or native mobile via `MobileSignInDialog`.
  // Plain local dev (no Supabase env vars set at all) still renders nothing extra here, unchanged.
  const { user, signOut } = useSupabaseSession();
  const isNative = Capacitor.isNativePlatform();
  // `credits` stays `null` (nothing rendered below) until the check resolves, and permanently on
  // desktop/local dev (`hosted` false there — see the hook's own comment) — credits are a hosted-only
  // concept, same gate every other credits-aware UI (Captions/Remove Object) already uses.
  const { hosted, credits } = useHostedCreditsGate();
  const [showMobileSignIn, setShowMobileSignIn] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const userMenuButtonRef = useRef<HTMLButtonElement>(null);

  // The desktop half of sign-in: `main.ts` extracts `access_token`/`refresh_token` from the
  // `vcut://auth-callback` redirect and forwards them here — `setSession` is what actually turns them
  // into the same kind of session `useSupabaseSession` above already knows how to react to (its own
  // `onAuthStateChange` subscription fires from this exactly as it would from a same-window redirect).
  // A no-op subscription (and never-called unsubscribe) on every platform without `window.veasnaAuth`.
  useEffect(() => {
    return subscribeToDesktopAuthCallback(({ accessToken, refreshToken }) => {
      void getSupabaseBrowserClient()?.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
    });
  }, []);

  // Warms every registered font's real `@font-face` fetch up front — see `preloadAllFonts`'s own
  // doc comment for why this is necessary at all (Canvas-only text rendering doesn't reliably trigger
  // a font's fetch on its own the way a DOM element with real CSS would). Mount-only: the module-scope
  // `preloadedFontIds` set inside `fonts.ts` already makes repeat calls (from here on every remount,
  // or from a hovered/selected font in the Inspector's picker) cheap no-ops regardless.
  useEffect(() => {
    preloadAllFonts();
  }, []);

  // Catches errors OUTSIDE React's own render cycle — `ErrorBoundary` (wrapping this whole component,
  // see `VCutApp`'s own export below) only ever sees throws during render; an error inside an event
  // handler, a `setTimeout`/async callback, or `PlaybackEngine`'s own imperative (non-React) code
  // reaches here instead. Routed through the same `reportError` the boundary uses, so both land in the
  // same crash log regardless of which path caught them.
  useEffect(() => {
    function onError(event: ErrorEvent) {
      reportError("window-error", event.error ?? event.message);
    }
    function onRejection(event: PromiseRejectionEvent) {
      reportError("unhandled-rejection", event.reason);
    }
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  // Below the `lg` breakpoint there's no permanent Media/Inspector column at all (240px + 260px of
  // fixed side columns doesn't fit next to a preview that still needs to show a legible frame) —
  // instead, the toolbar's Media/Properties buttons (see StatusBar) swap the Timeline row's own
  // content for one of these two, full-width, until toggled back. `null` means "show Timeline",
  // which is also what this always stays at `lg`+ (those toolbar buttons are `lg:hidden`, so nothing
  // ever sets it there). Confirmed with the user: the earlier tab-bar-plus-shared-row design (Media
  // and Properties each getting a permanently docked, always-partially-visible slot below Preview)
  // read as too busy and too easy to mis-tap on a real phone — this replaces it entirely rather than
  // adding a third mobile layout mode alongside it.
  //
  // Lives in `useEditorStore` (not a plain local `useState` here) specifically so `TimelineClip`'s own
  // double-tap-a-clip-to-edit gesture can open Properties from deep inside the Timeline tree — see
  // `EditorState.mobileSheet`'s own doc comment for the full reasoning.
  const mobileSheet = useEditorStore((s) => s.mobileSheet);
  const setMobileSheet = useEditorStore((s) => s.setMobileSheet);

  // Independent of `mobileSheet` above — that one is deliberately the mobile-only "borrow the bottom
  // row because there's no side column to put this in" concept (see its own comment). This decides
  // what the SAME row shows at every breakpoint whenever `mobileSheet` isn't itself active: "timeline"
  // (the default) or "mixer" (toggled from the always-visible Mixer toolbar button in `StatusBar`,
  // replacing the track lanes with a row of channel strips — the DaVinci-Resolve-Fairlight-page
  // pattern, not a new grid column). A literal union rather than a boolean in case a future third
  // bottom-panel mode is ever added.
  const [bottomPanel, setBottomPanel] = useState<"timeline" | "mixer" | "scopes">("timeline");

  // Which of Mixer/Scopes (if either) is popped out into its own `FloatablePanel` window instead of
  // docked in the bottom row — `null` means neither is floating (the normal, default state). Only ONE
  // can float at a time in v1 (a second `beginFloat` call while one is already floating just replaces
  // it) — real screen-space-competing floating windows (drag/resize/z-order between several) is real
  // extra machinery this defers, matching `FloatablePanel.tsx`'s own "currently Mixer/Scopes" doc
  // comment. `rect` is fully owned here (passed down as `FloatablePanel`'s own controlled prop) so a
  // dock/re-float cycle doesn't need to remember where the window was last time — it just reseeds a
  // sensible default position near the top-right, clear of the Preview/Timeline the docked panel would
  // otherwise occupy.
  const [floatState, setFloatState] = useState<{ panel: "mixer" | "scopes"; rect: FloatRect } | null>(null);

  function beginFloat(panel: "mixer" | "scopes") {
    setFloatState({ panel, rect: { x: Math.max(8, window.innerWidth - 428), y: 80, width: 400, height: 320 } });
    // The panel is now shown in its OWN floating window — leaving it also selected as the docked
    // `bottomPanel` would render it twice (once floating, once still occupying the Timeline's own
    // row) and silently fall back to Timeline there instead, matching what tapping the SAME toolbar
    // button again already does.
    setBottomPanel((current) => (current === panel ? "timeline" : current));
  }

  function dockPanel() {
    setFloatState(null);
  }

  // Lets the user trade vertical space between Preview (clearer to look at, bigger) and Timeline
  // (more clips/tracks visible at once) via a draggable divider, on every breakpoint. Seeded
  // per-breakpoint, NOT one shared default: desktop's roomy 320px starting point squeezed Preview's
  // row down to a sliver on a short phone the instant it was reused as mobile's default too —
  // confirmed live, the transport bar's own real content then overflowed its row.
  //
  // The per-breakpoint preferred value alone isn't enough, though: it's keyed on `min-width`, which
  // tracks portrait-vs-landscape only by accident. A phone rotated to landscape is still under the
  // 1024px width breakpoint (so gets mobile's 224px preferred height) but only has ~390px of height
  // to begin with — 224px of that going to Timeline left Preview a sliver too short to show anything
  // (confirmed live: the canvas rendered a few px tall, effectively invisible). `clampTimelineHeight`
  // encodes the actual invariant directly — Preview keeps at least `MIN_PREVIEW_HEIGHT` — rather than
  // an indirect ratio of the viewport, which is what the first version of this fix used and got
  // wrong: it reused `MAX_TIMELINE_HEIGHT_RATIO` (a generous 75%, meant for how far a user's own
  // manual drag is allowed to go) for automatic reflow too, so re-rotating portrait's already-small
  // 224px default against a 390px-tall landscape viewport passed that loose check and never shrank.
  //
  // Starts at the plain 224px fallback UNCONDITIONALLY — not a `typeof window === "undefined"` branch
  // in the initializer, which used to read the real `window.innerHeight`/`matchMedia` on the client
  // but not on the server: since the very first CLIENT render (during hydration) ran that same
  // initializer before any effect could run, it was already computing a DIFFERENT number than the
  // server had rendered, tripping a hydration mismatch on every load where the real viewport didn't
  // happen to clamp to exactly 224. `useLayoutEffect` below corrects it to the real per-breakpoint
  // value SYNCHRONOUSLY after mount, before the browser paints — client-only by nature (effects never
  // run during SSR), so the server/first-client-render pair stays byte-for-byte identical, and the
  // correction lands before the user ever sees the placeholder 224px.
  const [timelineHeight, setTimelineHeight] = useState(224);

  useLayoutEffect(() => {
    const preferred = window.matchMedia("(min-width: 1024px)").matches ? 320 : 224;
    setTimelineHeight(clampTimelineHeight(preferred, window.innerHeight));
  }, []);

  // Re-clamps on resize/rotation — the mount effect above only runs once, so rotating a phone
  // mid-session (portrait, where 224px comfortably fits, to landscape, where it doesn't) would
  // otherwise reproduce the exact same squeeze the mount effect fixes for a fresh landscape load. Only
  // ever clamps DOWN (`clampTimelineHeight` never returns more than its input), so it never overrides
  // a height the user deliberately chose via `beginTimelineResize` unless the viewport genuinely no
  // longer fits it.
  useEffect(() => {
    function onResize() {
      setTimelineHeight((h) => clampTimelineHeight(h, window.innerHeight));
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  function beginTimelineResize(startEvent: React.MouseEvent | React.TouchEvent) {
    preventDefaultIfMouse(startEvent);
    const start = clientPoint(startEvent);
    const startTimelineHeight = timelineHeight;
    const removeListeners = addDragListeners(
      (moveEvent) => {
        const point = clientPoint(moveEvent);
        // Dragging UP (pointer above the start point) grows the timeline — the divider sits ABOVE it,
        // so moving it toward the top of the screen makes the row below it taller, matching the
        // direction every other "drag this edge to resize" control in a video editor uses. One shared
        // formula for every breakpoint now: mobile no longer has a second row (Media/Properties'
        // shared panel) competing for the same budget, so there's nothing left to jointly clamp
        // against — Preview is just `minmax(0,1fr)`, same as desktop.
        const dy = start.y - point.y;
        setTimelineHeight(Math.min(window.innerHeight * MAX_TIMELINE_HEIGHT_RATIO, Math.max(MIN_TIMELINE_HEIGHT, startTimelineHeight + dy)));
      },
      () => removeListeners()
    );
  }

  // Media/Properties column widths — `lg`+ only, same fixed-panel-vs-flexible-Preview shape
  // `timelineHeight` already established for the horizontal divider, just along the other axis. Seeded
  // to the pixel values these two columns used before either was resizable (240px/260px), UNCONDITIONALLY
  // — same reasoning as `timelineHeight`'s own initializer comment above: reading `window.innerWidth`
  // right here would make the client's own first render disagree with the server's, not just the
  // server-vs-nothing case a `typeof window` guard alone protects against. The `useLayoutEffect` below
  // corrects both to their real clamped values synchronously after mount, before paint.
  const [mediaWidth, setMediaWidth] = useState(240);
  const [propertiesWidth, setPropertiesWidth] = useState(260);
  // Read inside the resize-listener effect below, which (like `timelineHeight`'s own) stays mount-only
  // (`[]` deps) — a ref is what lets it see each width's LATEST value without re-subscribing the
  // `resize` listener on every drag pixel the way depending on the state directly would.
  const mediaWidthRef = useRef(mediaWidth);
  mediaWidthRef.current = mediaWidth;
  const propertiesWidthRef = useRef(propertiesWidth);
  propertiesWidthRef.current = propertiesWidth;

  useLayoutEffect(() => {
    setMediaWidth(clampSideWidth(240, 260, window.innerWidth));
    setPropertiesWidth(clampSideWidth(260, 240, window.innerWidth));
  }, []);

  useEffect(() => {
    function onResize() {
      setMediaWidth((w) => clampSideWidth(w, propertiesWidthRef.current, window.innerWidth));
      setPropertiesWidth((w) => clampSideWidth(w, mediaWidthRef.current, window.innerWidth));
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  function beginMediaResize(startEvent: React.MouseEvent | React.TouchEvent) {
    preventDefaultIfMouse(startEvent);
    const start = clientPoint(startEvent);
    const startWidth = mediaWidth;
    const removeListeners = addDragListeners(
      (moveEvent) => {
        const point = clientPoint(moveEvent);
        // Media is the LEFT column — dragging its right edge further right grows it.
        const dx = point.x - start.x;
        setMediaWidth(clampSideWidth(startWidth + dx, propertiesWidthRef.current, window.innerWidth));
      },
      () => removeListeners()
    );
  }

  function beginPropertiesResize(startEvent: React.MouseEvent | React.TouchEvent) {
    preventDefaultIfMouse(startEvent);
    const start = clientPoint(startEvent);
    const startWidth = propertiesWidth;
    const removeListeners = addDragListeners(
      (moveEvent) => {
        const point = clientPoint(moveEvent);
        // Properties is the RIGHT column — dragging its left edge further left grows it.
        const dx = start.x - point.x;
        setPropertiesWidth(clampSideWidth(startWidth + dx, mediaWidthRef.current, window.innerWidth));
      },
      () => removeListeners()
    );
  }

  useEffect(() => {
    void load(projectId, projectName);
    // Deliberately excludes `projectName` — it should only seed the name of a BRAND NEW project
    // (see loadProject's comment), not re-trigger a reload if a host app's own title changes while
    // this project is already open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, load]);

  // Flush on unmount and on window close, so the autosave debounce can never swallow the final edit.
  useEffect(() => {
    const onBeforeUnload = () => void flushPendingSave();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      void flushPendingSave();
    };
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (isTypingTarget(event.target, event.key)) return;
      const state = useEditorStore.getState();
      const current = state.project;
      if (!current) return;

      const modifier = event.ctrlKey || event.metaKey;

      if (modifier && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void state.save();
        state.setStatus(translateText(state.language, "Project saved"));
        return;
      }
      if (modifier && event.key.toLowerCase() === "z") {
        event.preventDefault();
        // Ctrl+Shift+Z redoes, matching the shortcut listed in the status bar.
        if (event.shiftKey) state.redo();
        else state.undo();
        return;
      }
      if (modifier && event.key.toLowerCase() === "y") {
        event.preventDefault();
        state.redo();
        return;
      }
      if (modifier && event.key.toLowerCase() === "d") {
        // Standard NLE shortcut — most editors, desktop and mobile-first alike, use Ctrl/⌘+D for this.
        event.preventDefault();
        state.duplicateSelectedClips();
        return;
      }
      // Standard zoom shortcuts, matching every editor: Ctrl/⌘ +/- steps, Ctrl/⌘ 0 resets. "=" is
      // included alongside "+" because that's the un-shifted key that actually produces "+" on a US
      // keyboard, and the numpad's own +/- report as "+"/"-" directly regardless of Shift.
      if (modifier && (event.key === "+" || event.key === "=")) {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent("vcut:zoom", { detail: { factor: 1.4 } }));
        return;
      }
      if (modifier && event.key === "-") {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent("vcut:zoom", { detail: { factor: 1 / 1.4 } }));
        return;
      }
      if (modifier && event.key === "0") {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent("vcut:zoom", { detail: { reset: true } }));
        return;
      }

      switch (event.key) {
        case " ": {
          event.preventDefault();
          state.togglePlay();
          break;
        }
        case "s":
        case "S": {
          event.preventDefault();
          splitAtPlayhead();
          break;
        }
        case "Delete":
        case "Backspace": {
          if (state.selectedClipIds.length === 0) return;
          event.preventDefault();
          state.run(new DeleteClipsCommand(state.selectedClipIds));
          break;
        }
        case "ArrowLeft": {
          event.preventDefault();
          state.stepFrames(event.shiftKey ? -10 : -1);
          break;
        }
        case "ArrowRight": {
          event.preventDefault();
          state.stepFrames(event.shiftKey ? 10 : 1);
          break;
        }
        case "Home": {
          event.preventDefault();
          state.setPlayhead(0);
          break;
        }
        // Universal NLE convention: mark the export range's in/out points at the CURRENT playhead.
        // Each is independent — pressing one doesn't touch the other, so marking just an out-point
        // (leaving in at the implicit timeline start) is a completely normal, valid thing to do. The
        // resulting markers are then draggable directly on the Timeline ruler for fine adjustment —
        // see its own `scrubExportStart`/`scrubExportEnd`.
        case "i":
        case "I": {
          event.preventDefault();
          state.setExportRangeStart(state.playhead);
          break;
        }
        case "o":
        case "O": {
          event.preventDefault();
          state.setExportRangeEnd(state.playhead);
          break;
        }
        // Clears both points — Premiere's own shortcut for the same action. Also reachable via the
        // Timeline header's own "× Range" button (only shown once a range exists) and the Export
        // dialog's "Reset to full timeline" link, for anyone who wouldn't otherwise find this.
        case "X": {
          if (!event.shiftKey) return;
          event.preventDefault();
          state.clearExportRange();
          break;
        }
        default:
          break;
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-[#0a0c10] text-xs text-white/40">
        {t("Opening VCut…")}
      </div>
    );
  }

  if (loadError || !project) {
    // A 401 here means the session itself is gone (the access token's own lifetime elapsed while the
    // tab/PWA sat idle — hours overnight is enough) — confirmed a real, reported dead end: "Try again"
    // alone just repeats the identical failure forever, and this early-return replaces the WHOLE app
    // (including the header's own sign-in entry points below), so there was previously no way back in
    // at all short of navigating away from the project entirely. Offering the same per-platform
    // sign-in action the header normally would is what actually fixes it; `MobileSignInDialog` is
    // re-rendered here too (its usual spot, further down, is inside the main return this bypasses).
    const needsSignIn = loadErrorStatus === 401;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-[#0a0c10] p-6 text-center">
        <p className="text-sm font-medium text-rose-300">{t("VCut couldn't open this project")}</p>
        <p className="max-w-md text-xs leading-relaxed text-white/50">
          {needsSignIn ? t("Your session has expired — sign in again to continue.") : loadError}
        </p>
        <div className="flex items-center gap-2">
          {needsSignIn && (
            <button
              onClick={() => {
                if (isNative) setShowMobileSignIn(true);
                else if (isDesktopSignInAvailable()) openDesktopSignIn();
                else window.location.href = "/login";
              }}
              className="rounded-md bg-sky-500 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-sky-400"
            >
              {t("Sign in")}
            </button>
          )}
          <button
            onClick={() => void load(projectId)}
            className="rounded-md bg-white/10 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-white/20"
          >
            {t("Try again")}
          </button>
        </div>
        {showMobileSignIn && <MobileSignInDialog onClose={() => setShowMobileSignIn(false)} />}
      </div>
    );
  }

  return (
    // "VCut" is a product name — never translated. `vcut-lang-km` (see studios/vcut's
    // globals.css) swaps the whole chrome's font-family to a Khmer-capable face via inheritance —
    // one place, cascades to every descendant, no per-component font changes needed.
    <div className={`flex h-full min-h-0 min-w-0 flex-col bg-[#0a0c10] text-white ${language === "km" ? "vcut-lang-km" : ""}`}>
      <header className="flex min-w-0 shrink-0 items-center gap-2 border-b border-white/10 px-3 py-2">
        {onHome ? (
          <button
            onClick={onHome}
            title={t("Back to projects")}
            aria-label={t("Back to projects")}
            className="flex shrink-0 items-center gap-1.5 text-sm font-semibold tracking-tight text-white transition hover:text-sky-400"
          >
            {/* An arrow (not a plain "X") — "X" reads as close/discard, which this isn't; this
                genuinely navigates back to the projects list, so an unambiguous back arrow is the
                more literal affordance for what actually happens on click. Prefixed onto the existing
                "VCut" wordmark rather than replacing it — keeps the brand visible while editing,
                the arrow alone already makes the button's clickability/destination obvious without
                needing to sacrifice one for the other. */}
            <ArrowLeft size={16} />
            VCut
          </button>
        ) : (
          <span className="shrink-0 text-sm font-semibold tracking-tight">VCut</span>
        )}
        <EditableProjectTitle />
        <SaveStatus />
        {/* One `ml-auto` on the whole trailing cluster, not on each button individually — two
            adjacent auto margins would each try to absorb a share of the free space, opening an
            unwanted gap BETWEEN sign-out and the language toggle instead of pushing the whole group
            together against the right edge, which is what every one of these already relied on
            `ml-auto` (previously just on the language button, the first/only item in this cluster
            before Sign out existed) to do. */}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {/* Plain `window.location` (not Next's `useRouter`) since this component is shared with the
              native mobile shell too, which has no Next.js router to call into at all — a full
              navigation to `/login` works identically on web and desktop (both serve a real `/login`
              page). Native mobile has no such page to navigate to at all (a static Vite build, no
              server-rendered routes) — signing out there just clears the session and stays on the
              current screen, same as `MobileSignInDialog` signing IN never navigates either. */}
          {/* One combined trigger, not two separate always-visible buttons — confirmed a real UX
              complaint: plain "Account"/"Sign out" text buttons sat directly against the save-status
              text with no visual separation, reading as clutter rather than a legible header (see
              `UserMenu.tsx`'s own doc comment). Web/desktop only: `/account` (plan/credits/Upgrade to
              Pro) has no server-rendered route on native mobile's own static Vite build, so that menu
              item would have nowhere to navigate to there — native mobile keeps the simple, direct
              Sign out button below instead, unchanged from before this menu existed. */}
          {/* An icon, not the truncated email text this originally showed — confirmed a real
              "looks cluttered/overflowing" complaint, not hypothetical: a `max-w-[8rem]` truncated
              email sitting in an already-tight trailing cluster read as busier than a single glyph
              needs to. The email itself still shows, in full, right at the top of the menu this
              opens (`UserMenu.tsx`'s own header row) — nothing is actually lost, just moved one
              click deeper where there's real room to show it without truncation.
              Pro accounts get an amber ring + a tiny badge dot on this exact icon — replaces an earlier
              plain credits-count readout that sat separately in the header (confirmed a real request:
              the count itself wasn't the useful part, a Pro/free distinction at a glance is). Hosted
              only (`hosted` false on desktop/local dev, where there's no plan concept to distinguish at
              all) and only once the plan has actually loaded (`credits !== null`) — defaulting to the
              free look before that resolves would flash a Pro account as free for a moment, the more
              visible direction to get wrong. */}
          {user && !isNative && (
            <button
              ref={userMenuButtonRef}
              onClick={() => setShowUserMenu((v) => !v)}
              title={hosted && credits?.plan === "pro" ? `${user.email ?? t("Account")} (${t("Pro")})` : (user.email ?? t("Account"))}
              aria-label={t("Account")}
              className={`relative flex shrink-0 items-center justify-center rounded-md p-1.5 transition hover:bg-white/10 ${
                hosted && credits?.plan === "pro" ? "text-amber-300 ring-1 ring-amber-400/60 hover:text-amber-200" : "text-white/40 hover:text-white"
              }`}
            >
              <Profile size={16} />
              {hosted && credits?.plan === "pro" && (
                <span aria-hidden className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full border border-[#0a0c10] bg-amber-400" />
              )}
            </button>
          )}
          {showUserMenu && (
            <UserMenu
              anchorRef={userMenuButtonRef}
              email={user?.email ?? null}
              onOpenAccount={() => (window.location.href = "/account")}
              onSignOut={() => void signOut().then(() => (window.location.href = "/login"))}
              onClose={() => setShowUserMenu(false)}
            />
          )}
          {user && isNative && (
            <button
              onClick={() => void signOut()}
              title={user.email ?? t("Sign out")}
              className="shrink-0 rounded-md px-2 py-1 text-[11px] font-medium text-white/40 transition hover:bg-white/10 hover:text-white"
            >
              {t("Sign out")}
            </button>
          )}
          {/* Desktop's own sign-in entry point — opens the system browser rather than navigating this
              window; see `desktopAuth.ts`'s own doc comment for why a magic-link/OAuth flow can't run
              directly against this window's locally-bundled server (its port changes every launch,
              which neither an emailed magic link nor a registered OAuth redirect URI can tolerate).
              Never shown on web (the existing `/login` page IS the sign-in flow there) or on native
              mobile (the next button below, opening `MobileSignInDialog` in-app instead). */}
          {!user && isDesktopSignInAvailable() && (
            <button
              onClick={openDesktopSignIn}
              className="shrink-0 rounded-md px-2 py-1 text-[11px] font-medium text-white/40 transition hover:bg-white/10 hover:text-white"
            >
              {t("Sign in")}
            </button>
          )}
          {/* Native mobile's own sign-in entry point — opens `MobileSignInDialog` in-app rather than
              the desktop button's system-browser hop, since Capacitor's WebView can run Supabase's JS
              client directly (see that dialog's own doc comment for the full reasoning). */}
          {!user && isNative && (
            <button
              onClick={() => setShowMobileSignIn(true)}
              className="shrink-0 rounded-md px-2 py-1 text-[11px] font-medium text-white/40 transition hover:bg-white/10 hover:text-white"
            >
              {t("Sign in")}
            </button>
          )}
          <button
            onClick={() => setLanguage(language === "en" ? "km" : "en")}
            title={t("Switch language")}
            aria-label={t("Switch language")}
            className="shrink-0 rounded-md px-2 py-1 text-[11px] font-medium text-white/60 transition hover:bg-white/10 hover:text-white"
          >
            {language === "en" ? "ខ្មែរ" : "EN"}
          </button>
          <button
            onClick={() => setExportOpen(true)}
            className="shrink-0 rounded-md bg-sky-500 px-3 py-1 text-[11px] font-semibold text-white transition hover:bg-sky-400"
          >
            {t("Export")}
          </button>
        </div>
      </header>

      {/* Three panes at `lg`+ (1024px): media on the left, preview + inspector in the middle,
          timeline across the bottom — the original desktop layout, unchanged. Below `lg`, there's no
          room for 240px + 260px of fixed side columns next to a preview that still needs to show a
          legible frame, so Media and Inspector aren't laid out at all there (both `hidden` below
          `lg`) — reached instead through the toolbar's Media/Properties buttons, which swap what
          renders in the SAME row Timeline normally occupies (see `mobileSheet`'s own comment above).
          The grid shape itself is now identical at every breakpoint — 2 rows (Preview, Timeline) —
          only the column count differs (`lg:grid-cols-*` adds the two side columns). */}
      {/* min-w-0 on the grid AND every item below: without it, a grid track defaults to
          `min-width: auto`, meaning it grows to fit its widest child's INTRINSIC content width
          instead of the space actually available. Timeline's own content is a wide, horizontally-
          scrolling area (easily 1500px+) — nested `overflow-auto`/`overflow-hidden` clip that
          visually, but the underlying LAYOUT BOX stayed that wide underneath the clipping, all the
          way up through this grid and BP's own page wrapper. It didn't show up as a visible
          scrollbar, but focusing ANY element (a plain tap/click — `role="button" tabIndex={0}` items
          are natively focusable) made the browser auto-scroll that hidden width into view, yanking
          the whole page sideways. That was the actual "still not functional" bug. */}
      <div
        className="relative grid min-h-0 min-w-0 flex-1 grid-rows-[minmax(0,1fr)_224px] lg:grid-cols-[var(--vs-media-w)_minmax(0,1fr)_var(--vs-props-w)] lg:grid-rows-[minmax(0,1fr)_320px]"
        // The Tailwind row class above is the PRE-HYDRATION fallback only, matched almost exactly by
        // the `gridTemplateRows` inline style (which takes over the instant `timelineHeight` state
        // exists, i.e. immediately on the client) — one shared 2-row shape now, not a
        // breakpoint-dependent one. Columns can't take that same "inline style always wins" shortcut,
        // though: below `lg` there are only ever 1-2 real tracks (Media/Properties don't render at
        // all there — see the comment above), so an unconditional `gridTemplateColumns` override would
        // force 3 columns onto the mobile layout too and squeeze Preview/Timeline into a sliver.
        // Routing the two widths through CSS custom properties instead keeps the `lg:` media query
        // doing the gating in real CSS, same as it already does for every other `lg:`-prefixed class
        // here — the custom properties themselves are harmless to set unconditionally since nothing
        // below `lg` ever references them.
        style={
          {
            gridTemplateRows: `minmax(0,1fr) ${timelineHeight}px`,
            "--vs-media-w": `${mediaWidth}px`,
            "--vs-props-w": `${propertiesWidth}px`,
          } as React.CSSProperties
        }
      >
        <div className="row-start-1 min-h-0 min-w-0 lg:order-2 lg:col-start-2 lg:row-start-1">
          <Preview onResizeStart={beginTimelineResize} />
        </div>

        {/* Permanent side columns, `lg`+ only — below `lg` these render nothing at all (not even
            hidden-but-mounted for state-preservation reasons; there's no state here that needs to
            survive being unmounted). Reached on mobile via the toolbar's Media/Properties buttons
            instead, which swap the Timeline row's content below. */}
        <div className="hidden min-h-0 min-w-0 lg:col-start-1 lg:row-start-1 lg:block">
          <MediaPanel />
        </div>
        <div className="hidden min-h-0 min-w-0 lg:col-start-3 lg:row-start-1 lg:block">
          <Inspector />
        </div>

        {/* The one row Timeline shares with Media/Properties below `lg`, and with Mixer at every
            breakpoint — `mobileSheet` stays `null` at `lg`+ (nothing there ever sets it), so this falls
            through to `bottomPanel` (Timeline vs. Mixer) once the permanent side columns above are
            visible. See `bottomPanel`'s own comment for why it's a separate concept from
            `mobileSheet`. */}
        <div className="row-start-2 min-h-0 min-w-0 lg:col-span-3 lg:row-start-2">
          {mobileSheet === "media" ? (
            <MediaPanel onAssetAdded={() => setMobileSheet(null)} />
          ) : mobileSheet === "inspector" ? (
            <Inspector />
          ) : bottomPanel === "mixer" ? (
            <MixerPanel onFloat={() => beginFloat("mixer")} />
          ) : bottomPanel === "scopes" ? (
            <ScopesPanel onFloat={() => beginFloat("scopes")} />
          ) : (
            <Timeline />
          )}
        </div>

        {/* Invisible full-width fallback hit strip, sitting right on the row boundary — the VISIBLE,
            discoverable handle is Preview's own (the small centered bar between its canvas and
            transport bar, wired to this exact same `beginTimelineResize` via `onResizeStart`); this
            is just the "drag from anywhere along the edge" convenience a mouse user gets for free on
            top of that, matching Media/Properties' own two dividers below. Absolutely positioned (not
            a real grid row/track) so it never needs its own `row-start`/row-count bookkeeping
            alongside every other item's explicit placement above; `bottom` lands it exactly on the row
            boundary since that row is fixed to this same height. */}
        <div
          onMouseDown={beginTimelineResize}
          onTouchStart={beginTimelineResize}
          role="separator"
          aria-orientation="horizontal"
          aria-label={t("Resize timeline")}
          className="absolute inset-x-0 z-20 h-2.5 -translate-y-1/2 cursor-row-resize touch-none"
          style={{ bottom: timelineHeight }}
        />

        {/* Media|Preview and Preview|Properties dividers — `lg`+ only, same reasoning as the columns
            they resize (see the grid's own comment above): below `lg` neither side column renders, so
            there's nothing here to drag. Positioned/centered exactly like the timeline divider above,
            just along X instead of Y — `left`/`right` (not `translate-x` alone) anchors each to the
            actual column boundary, which is a real pixel value here (unlike Preview's own width,
            which is never known ahead of time — it's `minmax(0,1fr)`), and the half-width translate
            centers the grabbable strip ON that boundary rather than starting flush against it. */}
        <div
          onMouseDown={beginMediaResize}
          onTouchStart={beginMediaResize}
          role="separator"
          aria-orientation="vertical"
          aria-label={t("Resize media panel")}
          className="absolute inset-y-0 z-20 hidden w-2.5 -translate-x-1/2 cursor-col-resize touch-none lg:block"
          style={{ left: mediaWidth }}
        />
        <div
          onMouseDown={beginPropertiesResize}
          onTouchStart={beginPropertiesResize}
          role="separator"
          aria-orientation="vertical"
          aria-label={t("Resize properties panel")}
          className="absolute inset-y-0 z-20 hidden w-2.5 translate-x-1/2 cursor-col-resize touch-none lg:block"
          style={{ right: propertiesWidth }}
        />
      </div>

      <StatusBar
        mobileSheet={mobileSheet}
        setMobileSheet={setMobileSheet}
        bottomPanel={bottomPanel}
        setBottomPanel={setBottomPanel}
        floatingPanel={floatState?.panel ?? null}
        onDockFloating={dockPanel}
      />
      <StatusToast />
      {exportOpen && <ExportDialog onClose={() => setExportOpen(false)} />}
      {showMobileSignIn && <MobileSignInDialog onClose={() => setShowMobileSignIn(false)} />}
      {floatState && (
        <FloatablePanel
          title={floatState.panel === "mixer" ? t("Audio Mixer") : t("Scopes")}
          rect={floatState.rect}
          onRectChange={(rect) => setFloatState((s) => (s ? { ...s, rect } : s))}
          onDock={dockPanel}
          minWidth={280}
          minHeight={220}
        >
          {floatState.panel === "mixer" ? <MixerPanel /> : <ScopesPanel />}
        </FloatablePanel>
      )}
    </div>
  );
}

/** The real export — wraps `VCutAppInner` in an `ErrorBoundary` from the OUTSIDE, not as the
 *  first thing inside its own return, specifically so the boundary also catches errors thrown by
 *  `VCutAppInner`'s own top-level hooks (a boundary can never catch an error thrown by itself, only
 *  by its children — putting it inside `VCutAppInner`'s own return would miss anything that throws
 *  before that return is ever reached). This protects the editor regardless of who mounts it — the
 *  standalone page, BP Studio's `<iframe>` embed, or any future embedder — without relying on every
 *  call site remembering to add a boundary of its own. */
export function VCutApp(props: VCutAppProps) {
  return (
    <ErrorBoundary>
      <VCutAppInner {...props} />
    </ErrorBoundary>
  );
}
