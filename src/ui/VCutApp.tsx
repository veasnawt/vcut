"use client";

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Capacitor } from "@capacitor/core";
import { getSupabaseBrowserClient, useSupabaseSession } from "@veasnawt/auth";
import {
  Ai,
  ArrowLeft,
  Art,
  ChevronLeft,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Close,
  ClosedCaption,
  Copy,
  Create,
  Delete,
  Document,
  Emoji,
  Filter,
  Gauge,
  Grid,
  Headphone,
  Key,
  Globe,
  Logout,
  Microphone,
  More,
  Music,
  Profile,
  Save,
  Settings,
  Split,
  Star,
  Text,
  Video,
  Upload,
  Volume,
} from "@veasnawt/vicons";
import { startCheckout } from "../api/billing.ts";
import { CREDITS_ENABLED, thumbnailUrl } from "../api/client.ts";
import { reportError } from "../api/crashLog.ts";
import { isDesktopSignInAvailable, openDesktopSignIn, subscribeToDesktopAuthCallback } from "../api/desktopAuth.ts";
import { subscribeToNativeAuthCallback } from "../api/nativeAuth.ts";
import { BatchCommand, DeleteClipsCommand, SetClipTransitionCommand, SetClipTransitionOutCommand, SplitClipCommand } from "../commands/index.ts";
import { translateText } from "../i18n/translations.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import { findAsset, findClip } from "../project/createProject.ts";
import { preloadAllFonts, preloadFont, resolveFont } from "../project/fonts.ts";
import { templateSlots } from "../project/template.ts";
import { applyTextStylePreset } from "../project/textStylePresets.ts";
import { DEFAULT_TEXT_STYLE, type Clip, type Track } from "../project/types.ts";
import { flushPendingSave, useEditorStore } from "../store/editorStore.ts";
import { clipAtTime } from "../timeline/queries.ts";
import { formatTimecode } from "../timeline/time.ts";
import { DEFAULT_TRANSITION, findTransitionCandidate, findTransitionSuccessorCandidate } from "../timeline/transitions.ts";
import { AiToolsPickerMenu } from "./AiToolsPickerMenu.tsx";
import { AnimationPickerMenu } from "./AnimationPickerMenu.tsx";
import { AiTaskBanner } from "./AiTaskBanner.tsx";
import { AutoCaptionsDialog } from "./AutoCaptionsDialog.tsx";
import { ClipContextMenu, type ClipContextMenuAction } from "./ClipContextMenu.tsx";
import { ColorPickerMenu } from "./ColorPickerMenu.tsx";
import { EditableProjectTitle } from "./EditableProjectTitle.tsx";
import { EffectsPickerMenu } from "./EffectsPickerMenu.tsx";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { ExportDialog } from "./ExportDialog.tsx";
import { FontPickerMenu } from "./FontPickerMenu.tsx";
import { TextToClipsDialog } from "./TextToClipsDialog.tsx";
import { Inspector } from "./Inspector.tsx";
import { MediaPanel } from "./MediaPanel.tsx";
import { FloatablePanel, type FloatRect } from "./FloatablePanel.tsx";
import type { ToolGroupItem } from "./toolGroup.ts";
import { ACCEPTED_EXTENSIONS_BY_KIND } from "./TrackHeader.tsx";
import { MixerPanel } from "./MixerPanel.tsx";
import { MobileSignInDialog } from "./MobileSignInDialog.tsx";
import { NewTextComposer } from "./NewTextComposer.tsx";
import { SaveConflictDialog } from "./SaveConflictDialog.tsx";
import { PixelEffectPickerMenu } from "./PixelEffectPickerMenu.tsx";
import { SaveAsTemplateDialog } from "./SaveAsTemplateDialog.tsx";
import { StylePickerMenu } from "./StylePickerMenu.tsx";
import { addDragListeners, clientPoint, preventDefaultIfMouse } from "./pointerEvents.ts";
import { Preview } from "./Preview.tsx";
import { AiEditModal } from "./AiEditModal.tsx";
import { MusicPanel } from "./MusicPanel.tsx";
import { ScopesPanel } from "./ScopesPanel.tsx";
import { SfxPanel } from "./SfxPanel.tsx";
import { ShortcutsPanel } from "./ShortcutsPanel.tsx";
import { StickersPanel } from "./StickersPanel.tsx";
import { Timeline } from "./Timeline.tsx";
import { TemplateFillScreen } from "./TemplateFillScreen.tsx";
import { TemplatePreviewScreen } from "./TemplatePreviewScreen.tsx";
import { TransitionPickerMenu } from "./TransitionPickerMenu.tsx";
import { TransitionGlyph } from "./TransitionGlyph.tsx";
import { ToolPanelDockContext } from "./ToolPanelDock.tsx";
import { effectiveToolbarPosition, readToolbarPosition, TOOLBAR_POSITION_STORAGE_KEY, type ToolbarPosition } from "./toolbarPosition.ts";
import "./editorToolbar.css";
import { useHostedCreditsGate } from "./useHostedCreditsGate.ts";
import { useIsMobile } from "./useIsMobile.ts";
import { VoiceRecordModal } from "./VoiceRecordModal.tsx";

/** Same "single fire-and-navigate action, no special busy/error state" reasoning `Inspector.tsx`'s
 *  own `handleUpgradeClick` documents — duplicated rather than imported since it isn't exported from
 *  there (it's a private module-level helper, and this is 4 lines). Used by the header's own "Save as
 *  template" button when a free user clicks it. */
function handleUpgradeClick() {
  void startCheckout()
    .then((url) => (window.location.href = url))
    .catch(() => {});
}

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
const TOOLBAR_RAIL_WIDTH = 56;
const TOOL_DOCK_WIDTH = 340;

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
function EditorLayoutIcon({ size = 16 }: { size?: number }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.5" y="3.5" width="19" height="17" rx="2" />
      <path d="M8 3.5v17M8 15h13" />
    </svg>
  );
}

function CollapsedTimelineStrip({ onExpand }: { onExpand: () => void }) {
  const t = useTranslation();
  const playhead = useEditorStore((s) => s.playhead);
  const fps = useEditorStore((s) => s.project?.sequence.fps ?? 30);
  return (
    <div className="flex h-full items-center justify-between border-t border-white/10 bg-[#0b0d12] px-3 text-[11px] text-white/55">
      <span className="font-semibold uppercase tracking-wider">{t("Timeline")}</span>
      <button type="button" onClick={onExpand} aria-label={t("Expand timeline")} title={t("Expand timeline")} className="flex items-center gap-2 rounded px-2 py-1 text-white/65 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300">
        <span className="font-mono tabular-nums">{formatTimecode(playhead, fps)}</span>
        <ChevronUp size={15} />
      </button>
    </div>
  );
}

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
      className={`vcut-tool-button relative flex h-10 min-w-11 shrink-0 flex-col items-center justify-center gap-0.5 rounded px-1 leading-none transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300 ${
        active ? "bg-sky-500/30 text-white hover:bg-sky-500/40" : "text-white/70 hover:bg-white/10 hover:text-white"
      } ${className}`}
    >
      {pro && (
        <span className="absolute right-0 top-0 rounded-sm bg-amber-400 px-[3px] text-[6px] font-bold leading-tight tracking-wide text-black">
          PRO
        </span>
      )}
      {children}
      <span className="vcut-tool-button-label max-w-full truncate text-[9px] font-medium">{label}</span>
    </button>
  );
});

function StatusBar({
  mobileSheet,
  setMobileSheet,
  toolbarPosition,
  desktopMediaOpen,
  onToggleDesktopMedia,
  bottomPanel,
  setBottomPanel,
  floatingPanel,
  onDockFloating,
}: {
  mobileSheet: "media" | "inspector" | null;
  setMobileSheet: (next: "media" | "inspector" | null) => void;
  toolbarPosition: ToolbarPosition;
  desktopMediaOpen: boolean;
  onToggleDesktopMedia: () => void;
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
  const applyTextInOutToSelection = useEditorStore((s) => s.applyTextInOutToSelection);
  const applyTextStylePresetToSelection = useEditorStore((s) => s.applyTextStylePresetToSelection);
  const patchTextStyleForSelection = useEditorStore((s) => s.patchTextStyleForSelection);
  const setLivePreviewOverrides = useEditorStore((s) => s.setLivePreviewOverrides);
  const aiEditModalClipId = useEditorStore((s) => s.aiEditModalClipId);
  const openAiEdit = useEditorStore((s) => s.openAiEdit);
  const previewMuted = useEditorStore((s) => s.previewMuted);
  const togglePreviewMuted = useEditorStore((s) => s.togglePreviewMuted);
  const importFiles = useEditorStore((s) => s.importFiles);
  const addAssetAtPlayhead = useEditorStore((s) => s.addAssetAtPlayhead);
  const project = useEditorStore((s) => s.project);
  const projectId = useEditorStore((s) => s.projectId);
  const t = useTranslation();
  const isMobile = useIsMobile();
  const desktopLeft = effectiveToolbarPosition(toolbarPosition, !isMobile) === "left";
  // `null` = closed; `{}` = open, whole-sequence; `{ clipIds }` = open, scoped to the selected clip(s)
  // (the toolbar's Captions button reaching a qualifying selection — see that button's own comment).
  const [captionsDialog, setCaptionsDialog] = useState<{ clipIds?: string[] } | null>(null);
  const [showTextImport, setShowTextImport] = useState(false);
  const [showTransitionMenu, setShowTransitionMenu] = useState(false);
  const [showColorMenu, setShowColorMenu] = useState(false);
  const [showEffectsMenu, setShowEffectsMenu] = useState(false);
  const [showPixelEffectMenu, setShowPixelEffectMenu] = useState(false);
  const [showAiToolsMenu, setShowAiToolsMenu] = useState(false);
  const [showMusic, setShowMusic] = useState(false);
  const [showSfx, setShowSfx] = useState(false);
  const [showStickers, setShowStickers] = useState(false);
  const [showVoiceRecord, setShowVoiceRecord] = useState(false);
  const [aiEditClipId, setAiEditClipId] = useState<string | null>(null);
  const composeTextActive = useEditorStore((s) => s.composeText !== null);
  const [showAnimationMenu, setShowAnimationMenu] = useState(false);
  /** Which tool group (Text / Audio) is expanded IN the toolbar, if any: the row then shows just that group's tools
   *  next to a back button, the same way a selection narrows it. */
  const [expandedGroup, setExpandedGroup] = useState<"text" | "audio" | null>(null);
  const audioButtonRef = useRef<HTMLButtonElement>(null);
  const audioImportInputRef = useRef<HTMLInputElement>(null);
  const [showStyleMenu, setShowStyleMenu] = useState(false);
  const [showFontMenu, setShowFontMenu] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const closeAllToolbarTools = React.useCallback(() => {
    setCaptionsDialog(null);
    setShowTextImport(false);
    setShowTransitionMenu(false);
    setShowColorMenu(false);
    setShowEffectsMenu(false);
    setShowPixelEffectMenu(false);
    setShowAiToolsMenu(false);
    setShowMusic(false);
    setShowSfx(false);
    setShowStickers(false);
    setShowVoiceRecord(false);
    setShowAnimationMenu(false);
    setShowStyleMenu(false);
    setShowFontMenu(false);
    setShowShortcuts(false);
    setAiEditClipId(null);
  }, []);
  useEffect(() => {
    window.addEventListener("vcut:close-tool-dock", closeAllToolbarTools);
    return () => window.removeEventListener("vcut:close-tool-dock", closeAllToolbarTools);
  }, [closeAllToolbarTools]);
  function canSwitchToolbarTool() {
    return !document.querySelector('.vcut-docked-frame[data-can-close="false"]');
  }
  function toggleToolbarTool(open: boolean, setOpen: (next: boolean) => void) {
    if (!desktopLeft || canSwitchToolbarTool()) {
      closeAllToolbarTools();
      if (!open) setOpen(true);
    }
  }
  const transitionButtonRef = useRef<HTMLButtonElement>(null);
  const colorButtonRef = useRef<HTMLButtonElement>(null);
  const effectsButtonRef = useRef<HTMLButtonElement>(null);
  const pixelEffectButtonRef = useRef<HTMLButtonElement>(null);
  const aiToolsButtonRef = useRef<HTMLButtonElement>(null);
  const textButtonRef = useRef<HTMLButtonElement>(null);
  const styleButtonRef = useRef<HTMLButtonElement>(null);
  const fontButtonRef = useRef<HTMLButtonElement>(null);
  const animationButtonRef = useRef<HTMLButtonElement>(null);
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
  const transitionDisabled = !foundForTransition || (foundForTransition.track.kind !== "video" && foundForTransition.track.kind !== "text");

  // Real thumbnails for `TransitionPickerMenu`'s preview tiles — `null` for any side with nothing
  // real to show (no eligible neighbor, or an asset with no generated thumbnail), which
  // `TransitionPreviewTile.tsx` renders as plain black rather than a placeholder color. Resolved
  // here (not inside the menu) since `project`/`findAsset`/`thumbnailUrl` already live in this scope.
  const transitionPredecessor =
    project && foundForTransition ? findTransitionCandidate(foundForTransition.track, foundForTransition.clip) : undefined;
  const transitionSuccessor =
    project && foundForTransition ? findTransitionSuccessorCandidate(foundForTransition.track, foundForTransition.clip) : undefined;
  const transitionActive = Boolean(
    foundForTransition?.clip.transitionIn ||
    (transitionSuccessor ? transitionSuccessor.transitionIn : foundForTransition?.clip.transitionOut),
  );
  const transitionSelectedAsset = project && foundForTransition ? findAsset(project, foundForTransition.clip.assetId) : undefined;
  const transitionPredecessorAsset = project && transitionPredecessor ? findAsset(project, transitionPredecessor.assetId) : undefined;
  const transitionSuccessorAsset = project && transitionSuccessor ? findAsset(project, transitionSuccessor.assetId) : undefined;
  const transitionSelectedThumbnailUrl = projectId && transitionSelectedAsset ? thumbnailUrl(projectId, transitionSelectedAsset) : null;
  const transitionPredecessorThumbnailUrl = projectId && transitionPredecessorAsset ? thumbnailUrl(projectId, transitionPredecessorAsset) : null;
  const transitionSuccessorThumbnailUrl = projectId && transitionSuccessorAsset ? thumbnailUrl(projectId, transitionSuccessorAsset) : null;

  // Effects/Pixel Effects — video-track clips only (video/image/color-matte), same gating `ClipEffects`/
  // `pixelEffect`'s own doc comments give; a text/audio clip has neither. Reuses `foundForTransition`'s
  // already-resolved clip/track rather than a second `findClip` lookup for the same selection.
  const foundForVideoEffects = foundForTransition && foundForTransition.track.kind === "video" ? foundForTransition : undefined;
  const effectsDisabled = !foundForVideoEffects;
  const effectsActive = Boolean(foundForVideoEffects?.clip.effects);
  const pixelEffectActive = Boolean(foundForVideoEffects?.clip.pixelEffect);
  const assetForVideoEffects = project && foundForVideoEffects ? findAsset(project, foundForVideoEffects.clip.assetId) : undefined;

  // Remove Object & Smart AI tools — available for both video and image clips on video tracks:
  const isVisualClip = assetForVideoEffects?.kind === "video" || assetForVideoEffects?.kind === "image";
  const aiToolsDisabled = !foundForVideoEffects || !isVisualClip;

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
  const selectedTextClips: { clip: Clip; track: Track }[] = project
    ? selectedClipIds
        .map((id) => findClip(project, id))
        .filter((f): f is { clip: Clip; track: Track } => Boolean(f && f.track.kind === "text"))
    : [];
  const animationDisabled = selectedTextClips.length === 0;
  const animationCurrent = selectedTextClips.length === 1 ? selectedTextClips[0]!.clip.textAnimation : undefined;
  const animationInCurrent = selectedTextClips.length === 1 ? selectedTextClips[0]!.clip.textAnimationIn : undefined;
  const animationOutCurrent = selectedTextClips.length === 1 ? selectedTextClips[0]!.clip.textAnimationOut : undefined;
  // Styles tool — same gating and same bulk/quick-apply role as Animation just above, for
  // `TextStylePreset` instead of `Clip.textAnimation`: promoted here so a look can be applied without
  // opening Inspector at all, backed by the exact same `applyTextStylePresetToSelection` Inspector's
  // own Styles section already uses. No "current" highlight (unlike Animation's `animationCurrent`):
  // a preset only ever SETS fields, it never reads back as "this clip currently matches preset X".
  const stylesDisabled = animationDisabled;
  const fontDisabled = stylesDisabled;

  const firstSelectedTextClip = selectedTextClips[0];
  const firstSelectedAsset = firstSelectedTextClip && project ? findAsset(project, firstSelectedTextClip.clip.assetId) : null;
  const firstSelectedTextStyle = firstSelectedAsset?.kind === "text" && firstSelectedAsset.textStyle ? firstSelectedAsset.textStyle : DEFAULT_TEXT_STYLE;

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
  // The timeline's between-clips transition button (`Timeline.tsx`'s `TransitionJunctionButton`) asks
  // for the transition picker through the store; it opens anchored at that button, reusing the same
  // invisible anchor point the context menu uses.
  const transitionPickerRequest = useEditorStore((s) => s.transitionPickerRequest);
  const setTransitionPickerRequest = useEditorStore((s) => s.setTransitionPickerRequest);
  useEffect(() => {
    if (!transitionPickerRequest) return;
    setPickerAnchorSource("contextMenu");
    setShowTransitionMenu(true);
  }, [transitionPickerRequest]);

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
        ...(!fontDisabled
          ? [
              {
                key: "font",
                label: t("Font"),
                icon: <Text size={15} />,
                onClick: () => {
                  setPickerAnchorSource("contextMenu");
                  setShowFontMenu(true);
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
                icon: <TransitionGlyph size={15} />,
                onClick: () => {
                  setTransitionPickerRequest(null);
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
                label: t("Filters"),
                icon: <Filter size={15} />,
                onClick: () => {
                  setPickerAnchorSource("contextMenu");
                  setShowEffectsMenu(true);
                },
              },
              {
                key: "pixelEffect",
                label: t("Effects"),
                icon: <Create size={15} />,
                onClick: () => {
                  setPickerAnchorSource("contextMenu");
                  setShowPixelEffectMenu(true);
                },
              },
            ]
          : []),
        ...(!aiToolsDisabled
          ? [
              {
                key: "aiTools",
                label: t("AI Tools"),
                icon: <Ai size={15} />,
                onClick: () => {
                  setPickerAnchorSource("contextMenu");
                  setShowAiToolsMenu(true);
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

  const textGroupItems: ToolGroupItem[] = [
                {
                  id: "add",
 shortLabel: t("Add"),
                  label: t("Add text"),
                  description: t("Type text and style it live on the canvas"),
                  // A "+" badge on the glyph: this item adds a new text (the group button itself is a plain T).
                  icon: (
                    <span className="relative inline-flex">
                      <Text size={16} />
                      <span
                        aria-hidden
                        className="absolute -bottom-0.5 -right-1 flex h-3 w-3 items-center justify-center rounded-full bg-sky-500 text-[8px] font-bold leading-none text-white"
                      >
                        +
                      </span>
                    </span>
                  ),
                  onSelect: () => {
                    closeAllToolbarTools();
                    setComposeText({ style: DEFAULT_TEXT_STYLE });
                  },
                },
                {
                  id: "script",
 shortLabel: t("Script"),
                  label: t("Script"),
                  description: t("Import text as clips"),
                  icon: <Document size={16} />,
                  onSelect: () => {
                    closeAllToolbarTools();
                    setShowTextImport(true);
                  },
                },
                {
                  id: "captions",
 shortLabel: t("Captions"),
                  label: selectedClipIds.length === 0 || captionsForClipDisabled ? t("Auto Captions") : t("Auto Captions for the selected clips"),
                  description: t("Turn speech into timed captions"),
                  icon: <ClosedCaption size={16} />,
                  onSelect: () => {
                    if (!canSwitchToolbarTool()) return;
                    closeAllToolbarTools();
                    setCaptionsDialog(captionsForClipDisabled ? {} : { clipIds: selectedClipIds });
                  },
                },
              ];

  const audioGroupItems: ToolGroupItem[] = [
                    {
                      id: "import",
 shortLabel: t("Import"),
                      label: t("Import audio"),
                      description: t("Add a sound file from your device"),
                      icon: <Upload size={16} />,
                      onSelect: () => {
                        audioImportInputRef.current?.click();
                      },
                    },
                    {
                      id: "music",
 shortLabel: t("Music"),
                      label: t("Music"),
                      description: t("Browse trending & viral music"),
                      icon: <Music size={16} />,
                      onSelect: () => {
                        closeAllToolbarTools();
                        setShowMusic(true);
                      },
                    },
                    {
                      id: "sfx",
 shortLabel: t("SFX"),
                      label: t("Sound effects"),
                      description: t("Whooshes, hits, ambience and more"),
                      icon: <Headphone size={16} />,
                      onSelect: () => {
                        closeAllToolbarTools();
                        setShowSfx(true);
                      },
                    },
                    {
                      id: "voice",
 shortLabel: t("Voice"),
                      label: t("Record voiceover"),
                      description: t("Record from your microphone"),
                      icon: <Microphone size={16} />,
                      onSelect: () => {
                        closeAllToolbarTools();
                        setShowVoiceRecord(true);
                      },
                    },
                    {
                      id: "mixer",
 shortLabel: t("Mixer"),
                      label: t("Audio mixer"),
                      description: t("Track volume, pan and levels"),
                      icon: <Volume size={16} />,
                      active: bottomPanel === "mixer" || floatingPanel === "mixer",
                      onSelect: () => {
                        if (floatingPanel === "mixer") {
                          onDockFloating();
                          setBottomPanel("mixer");
                        } else {
                          setBottomPanel(bottomPanel === "mixer" ? "timeline" : "mixer");
                        }
                      },
                    },
                    {
                      id: "mute",
 shortLabel: t("Mute"),
                      label: previewMuted ? t("Unmute preview") : t("Mute preview"),
                      description: t("Silences playback only — never your export"),
                      icon: <Volume size={16} />,
                      active: previewMuted,
                      onSelect: togglePreviewMuted,
                    },
                  ];

  return (
    <footer className="vcut-toolbar flex shrink-0 items-center gap-1 border-t border-white/10 bg-[#0d0f14] px-2 py-1.5 text-[11px]">
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
        className={`vcut-toolbar-panel-buttons flex shrink-0 items-center gap-0.5 overflow-hidden border-r border-white/10 pr-1 transition-all duration-200 ease-out ${
          toolsScrolled && mobileSheet === null && selectedClipIds.length === 0
            ? "max-w-0 border-r-0 pr-0 opacity-0"
            : "max-w-[120px] opacity-100"
        }`}
      >
        <ToolbarButton
          title={t("Media")}
          label={t("Media")}
          active={desktopLeft ? desktopMediaOpen : mobileSheet === "media"}
          onClick={() => {
            if (desktopLeft) {
              if (!canSwitchToolbarTool()) return;
              closeAllToolbarTools();
              onToggleDesktopMedia();
            } else setMobileSheet(mobileSheet === "media" ? null : "media");
          }}
        >
          <Video size={18} />
        </ToolbarButton>
        <ToolbarButton
          title={t("Properties")}
          label={t("Properties")}
          active={mobileSheet === "inspector"}
          onClick={() => setMobileSheet(mobileSheet === "inspector" ? null : "inspector")}
          className="vcut-toolbar-properties-button"
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
      {expandedGroup && (
        <button
          ref={expandedGroup === "text" ? textButtonRef : audioButtonRef}
          onClick={() => setExpandedGroup(null)}
          title={t("Back to all tools")}
          aria-label={t("Back to all tools")}
          className="vcut-toolbar-back flex h-10 w-11 shrink-0 items-center justify-center rounded-lg bg-white/10 text-white transition hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
        >
          <span className="flex items-center">
            <ChevronLeft size={16} className="-mr-2.5" />
            <ChevronLeft size={16} />
          </span>
        </button>
      )}
      {selectedClipIds.length > 0 && !expandedGroup && (
        <button
          onClick={() => select([])}
          title={t("Back to all tools")}
          aria-label={t("Back to all tools")}
          // Filled rounded-square, no label, deliberately more prominent than a plain icon+label
          // `ToolbarButton` — the one control that gets you OUT of this narrowed view needs to read as
          // its own distinct kind of button at a glance, not just one more tool in the row.
          className="vcut-toolbar-back flex h-10 w-11 shrink-0 items-center justify-center rounded-lg bg-white/10 text-white transition hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
        >
          <span className="flex items-center">
            <ChevronLeft size={16} className="-mr-2.5" />
            <ChevronLeft size={16} />
          </span>
        </button>
      )}

      <div
        className="vcut-toolbar-tools scrollbar-none flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
        onScroll={(e) => {
          // See `toolsScrollSettleRef`'s own comment: deliberately NOT `setToolsScrolled` directly here.
          const left = e.currentTarget.scrollLeft;
          if (toolsScrollSettleRef.current !== null) window.clearTimeout(toolsScrollSettleRef.current);
          toolsScrollSettleRef.current = window.setTimeout(() => setToolsScrolled(left > 4), 150);
        }}
      >
        {/* An expanded group (Text / Audio): just that group's tools, in the toolbar itself. The normal tools stay
            mounted but hidden (`display: none`) so their pickers and refs keep working; `contents` makes the
            wrapper invisible to the row's flex layout when nothing is expanded. */}
        {expandedGroup && (
          <>
            {(expandedGroup === "text" ? textGroupItems : audioGroupItems).map((item) => (
              <ToolbarButton
                key={item.id}
                title={item.description}
                label={item.shortLabel ?? item.label}
                active={item.active}
                pro={item.id === "captions" ? CREDITS_ENABLED : undefined}
                onClick={item.onSelect}
              >
                {item.icon}
              </ToolbarButton>
            ))}
          </>
        )}
        <div className={expandedGroup ? "hidden" : "contents"}>
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
        {/* Text — every text tool behind one button, like Audio: Add text (opens the composer), Script (import text as
            clips), Auto Captions, and — when a text clip is selected — Styles, Font and Animation. These used to be
            six separate toolbar buttons. The three selection-scoped ones open the same pickers as before, anchored
            to this button; they only appear in the menu when they have something to act on. */}
        {/* With a text clip selected the toolbar narrows to what edits THAT text — Styles, Font and Animation (beside
            Split / Duplicate / Transition below) — instead of the Text group (which holds Add text, Script and Captions), since those add new content. */}
        {animationDisabled ? (
          <>
        <ToolbarButton
          ref={expandedGroup === "text" ? undefined : textButtonRef}
          title={t("Text")}
          label={t("Text")}
          active={composeTextActive || showTextImport || captionsDialog !== null || showStyleMenu || showFontMenu || showAnimationMenu}
          onClick={() => setExpandedGroup("text")}
        >
          <Text size={18} />
        </ToolbarButton>
          </>
        ) : (
          <>
            <ToolbarButton
              ref={styleButtonRef}
              title={t("Apply a look to the selected text")}
              label={t("Styles")}
              active={showStyleMenu}
              onClick={() => {
                setPickerAnchorSource("button");
                closeAllToolbarTools();
                setShowStyleMenu(true);
              }}
            >
              <Grid size={18} />
            </ToolbarButton>
            <ToolbarButton
              ref={fontButtonRef}
              title={t("Change the typeface")}
              label={t("Font")}
              active={showFontMenu}
              onClick={() => {
                setPickerAnchorSource("button");
                closeAllToolbarTools();
                setShowFontMenu(true);
              }}
            >
              <Text size={18} />
            </ToolbarButton>
            <ToolbarButton
              ref={animationButtonRef}
              title={t("In, out and loop animations")}
              label={t("Animation")}
              active={showAnimationMenu || Boolean(animationCurrent || animationInCurrent || animationOutCurrent)}
              onClick={() => {
                setPickerAnchorSource("button");
                closeAllToolbarTools();
                setShowAnimationMenu(true);
              }}
            >
              <Star size={18} />
            </ToolbarButton>
          </>
        )}
        {/* Audio — every audio tool behind one button: Import audio, Music, Sound effects, Record voiceover, the
            Mixer and the preview Mute. These used to be five separate toolbar buttons (Voice, Mute, Music, SFX,
            Mixer). Same gate the standalone Mixer button had: reachable with nothing selected AND once a clip
            with audio is selected, since adjusting that clip's track in the Mixer is the likeliest reason to
            reach for it right after selecting one. */}
        {(selectedClipIds.length === 0 || !captionsForClipDisabled) && (
          <>
            <ToolbarButton
              ref={expandedGroup === "audio" ? undefined : audioButtonRef}
              title={t("Audio")}
              label={t("Audio")}
              active={bottomPanel === "mixer" || floatingPanel === "mixer" || previewMuted || showMusic || showSfx || showVoiceRecord}
              onClick={() => setExpandedGroup("audio")}
            >
              <Music size={18} />
            </ToolbarButton>
            {/* Backs the menu's "Import audio" item: one hidden input, clicked imperatively. */}
            <input
              ref={audioImportInputRef}
              type="file"
              multiple
              accept={ACCEPTED_EXTENSIONS_BY_KIND.audio}
              className="hidden"
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = "";
                if (files.length === 0) return;
                // Imported into the project's media AND placed on an audio track at the playhead, so a chosen
                // file lands on the timeline in one step instead of needing a second drag from the Media panel.
                void importFiles(files).then((assets) => {
                  for (const asset of assets) if (asset.kind === "audio") addAssetAtPlayhead(asset.id, undefined, { avoidOverlap: true });
                });
              }}
            />
          </>
        )}
        {/* The bulk/quick-apply path for `Clip.textAnimation` — works on however many text clips are
            currently selected (see `animationCurrent`/`selectedTextClips` above), one shared undo step
            either way. Inspector's own Animation section is still where speed/highlight-color get
            fine-tuned afterward, one clip at a time. Hidden rather than merely disabled when no text
            clip is selected — see the group of toolbar tools below this file's own "hide, don't just
            grey out" comment for the full reasoning shared by all of them. */}
        {/* picker */}
        {showStyleMenu && (
              <StylePickerMenu
                anchorRef={pickerAnchorSource === "contextMenu" ? contextMenuAnchorRef : styleButtonRef}
                onPick={applyTextStylePresetToSelection}
                onPreview={(preset) => {
                  if (selectedTextClips.length > 0) {
                    setLivePreviewOverrides(
                      selectedTextClips.map((f) => {
                        const asset = project ? findAsset(project, f.clip.assetId) : null;
                        const baseStyle = asset?.kind === "text" && asset.textStyle ? asset.textStyle : DEFAULT_TEXT_STYLE;
                        return {
                          clipId: f.clip.id,
                          textStyle: applyTextStylePreset(baseStyle, preset),
                        };
                      })
                    );
                  }
                }}
                onPreviewEnd={() => setLivePreviewOverrides([])}
                onClose={() => {
                  setLivePreviewOverrides([]);
                  setShowStyleMenu(false);
                }}
              />
            )}
        {/* picker */}
        {showFontMenu && (
              <FontPickerMenu
                anchorRef={pickerAnchorSource === "contextMenu" ? contextMenuAnchorRef : fontButtonRef}
                selectedId={firstSelectedTextStyle.fontFamily}
                customFonts={project?.customFonts ?? []}
                onPick={(fontId) => {
                  patchTextStyleForSelection({ fontFamily: fontId });
                  setShowFontMenu(false);
                }}
                onHover={(fontId) => {
                  if (fontId && selectedTextClips.length > 0) {
                    preloadFont(resolveFont(fontId, project?.customFonts ?? []));
                    setLivePreviewOverrides(
                      selectedTextClips.map((f) => {
                        const asset = project ? findAsset(project, f.clip.assetId) : null;
                        const baseStyle = asset?.kind === "text" && asset.textStyle ? asset.textStyle : DEFAULT_TEXT_STYLE;
                        return {
                          clipId: f.clip.id,
                          textStyle: { ...baseStyle, fontFamily: fontId },
                        };
                      })
                    );
                  } else {
                    setLivePreviewOverrides([]);
                  }
                }}
                onClose={() => {
                  setLivePreviewOverrides([]);
                  setShowFontMenu(false);
                }}
              />
            )}
        {/* picker */}
        {showAnimationMenu && (
              <AnimationPickerMenu
                anchorRef={pickerAnchorSource === "contextMenu" ? contextMenuAnchorRef : animationButtonRef}
                current={animationCurrent}
                onPick={applyTextAnimationToSelection}
                currentIn={animationInCurrent}
                onPickIn={(next) => applyTextInOutToSelection("in", next)}
                currentOut={animationOutCurrent}
                onPickOut={(next) => applyTextInOutToSelection("out", next)}
                onClose={() => setShowAnimationMenu(false)}
              />
            )}

        {selectedClipIds.length === 0 && (
          <>
            <span className="vcut-toolbar-divider mx-1 h-5 w-px shrink-0 bg-white/10" />

            <ToolbarButton title={t("Stickers and GIFs")} label={t("Stickers")} active={showStickers} onClick={() => toggleToolbarTool(showStickers, setShowStickers)}>
              <Emoji size={18} />
            </ToolbarButton>
            <ToolbarButton
              ref={colorButtonRef}
              title={t("Add a color background")}
              label={t("Background")}
              active={showColorMenu}
              onClick={() => toggleToolbarTool(showColorMenu, setShowColorMenu)}
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
        {selectedClipIds.length === 0 && <span className="vcut-toolbar-divider mx-1 h-5 w-px shrink-0 bg-white/10" />}

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

        {selectedClipIds.length === 0 && <span className="vcut-toolbar-divider mx-1 h-5 w-px shrink-0 bg-white/10 lg:hidden" />}

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
                setTransitionPickerRequest(null);
                setPickerAnchorSource("button");
                toggleToolbarTool(showTransitionMenu, setShowTransitionMenu);
              }}
            >
              <TransitionGlyph size={18} />
            </ToolbarButton>
            {showTransitionMenu && foundForTransition && (
              <TransitionPickerMenu
                key={`${foundForTransition.clip.id}:${transitionPickerRequest?.mode ?? "auto"}`}
                anchorRef={pickerAnchorSource === "contextMenu" ? contextMenuAnchorRef : transitionButtonRef}
                isAudioTrack={foundForTransition.track.kind === "audio"}
                isTextTrack={foundForTransition.track.kind === "text"}
                hasPredecessor={Boolean(transitionPredecessor)}
                hasSuccessor={Boolean(transitionSuccessor)}
                initialMode={transitionPickerRequest?.mode}
                activeIn={foundForTransition.clip.transitionIn?.type ?? null}
                // With a clip right after this one, "Out" IS that junction — the successor's own
                // `transitionIn`, the one field export and preview actually render there. A clip's own
                // `transitionOut` only ever applies with nothing after it (see `findTransitionOut`), so
                // editing it here used to silently do nothing between two touching clips.
                activeOut={(transitionSuccessor ? transitionSuccessor.transitionIn?.type : foundForTransition.clip.transitionOut?.type) ?? null}
                durationIn={foundForTransition.clip.transitionIn?.duration ?? null}
                durationOut={(transitionSuccessor ? transitionSuccessor.transitionIn?.duration : foundForTransition.clip.transitionOut?.duration) ?? null}
                onChangeIn={(type) => {
                  if (!type) {
                    run(new SetClipTransitionCommand(foundForTransition.clip.id, null));
                    return;
                  }
                  const duration = foundForTransition.clip.transitionIn?.duration ?? DEFAULT_TRANSITION.duration;
                  run(new SetClipTransitionCommand(foundForTransition.clip.id, { duration, type }));
                }}
                onChangeOut={(type) => {
                  if (transitionSuccessor) {
                    const duration = transitionSuccessor.transitionIn?.duration ?? DEFAULT_TRANSITION.duration;
                    run(new SetClipTransitionCommand(transitionSuccessor.id, type ? { duration, type } : null));
                    return;
                  }
                  if (!type) {
                    run(new SetClipTransitionOutCommand(foundForTransition.clip.id, null));
                    return;
                  }
                  const duration = foundForTransition.clip.transitionOut?.duration ?? DEFAULT_TRANSITION.duration;
                  run(new SetClipTransitionOutCommand(foundForTransition.clip.id, { duration, type }));
                }}
                onChangeDurationIn={(duration) => {
                  const current = foundForTransition.clip.transitionIn;
                  if (current) run(new SetClipTransitionCommand(foundForTransition.clip.id, { ...current, duration }));
                }}
                onChangeDurationOut={(duration) => {
                  if (transitionSuccessor) {
                    const current = transitionSuccessor.transitionIn;
                    if (current) run(new SetClipTransitionCommand(transitionSuccessor.id, { ...current, duration }));
                    return;
                  }
                  const current = foundForTransition.clip.transitionOut;
                  if (current) run(new SetClipTransitionOutCommand(foundForTransition.clip.id, { ...current, duration }));
                }}
                onApplyToAllCuts={(type, duration) => {
                  // Every clip on this track with a touching predecessor is one cut — one undo step.
                  const track = foundForTransition.track;
                  const commands = track.clips
                    .filter((clip) => findTransitionCandidate(track, clip))
                    .map((clip) => new SetClipTransitionCommand(clip.id, { duration, type }));
                  if (commands.length > 0) run(new BatchCommand("Apply Transition to All Cuts", commands));
                }}
                onClose={() => {
                  setShowTransitionMenu(false);
                  setTransitionPickerRequest(null);
                }}
                selectedThumbnailUrl={transitionSelectedThumbnailUrl}
                predecessorThumbnailUrl={transitionPredecessorThumbnailUrl}
                successorThumbnailUrl={transitionSuccessorThumbnailUrl}
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
              title={t("Filters")}
              label={t("Filters")}
              active={effectsActive}
              onClick={() => {
                setPickerAnchorSource("button");
                toggleToolbarTool(showEffectsMenu, setShowEffectsMenu);
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
              title={t("Effects")}
              label={t("Effects")}
              active={pixelEffectActive}
              onClick={() => {
                setPickerAnchorSource("button");
                toggleToolbarTool(showPixelEffectMenu, setShowPixelEffectMenu);
              }}
            >
              <Create size={18} />
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

        {/* AI & Smart Tools — unified popover grouping Remove Object, Auto Cutout, Text Behind Subject, and AI Edit */}
        {!aiToolsDisabled && (
          <>
            <ToolbarButton
              ref={aiToolsButtonRef}
              title={t("AI & Smart Tools (Remove Object, Cutout, Text Behind Subject, Generative Edit)")}
              label={t("AI Tools")}
              pro={CREDITS_ENABLED}
              active={showAiToolsMenu}
              onClick={() => {
                setPickerAnchorSource("button");
                toggleToolbarTool(showAiToolsMenu, setShowAiToolsMenu);
              }}
            >
              <Ai size={18} />
            </ToolbarButton>
            {showAiToolsMenu && foundForVideoEffects && (
              <AiToolsPickerMenu
                anchorRef={pickerAnchorSource === "contextMenu" ? contextMenuAnchorRef : aiToolsButtonRef}
                clip={foundForVideoEffects.clip}
                asset={assetForVideoEffects}
                onClose={() => setShowAiToolsMenu(false)}
                onOpenAiEdit={(clipId) => setAiEditClipId(clipId)}
              />
            )}
          </>
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

        <span className="vcut-toolbar-divider mx-1 h-5 w-px shrink-0 bg-white/10" />

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
      </div>
      <div className="vcut-toolbar-shortcuts hidden shrink-0 lg:block">
        <ToolbarButton
          title={t("Keyboard shortcuts")}
          label={t("Shortcuts")}
          active={showShortcuts}
          onClick={() => toggleToolbarTool(showShortcuts, setShowShortcuts)}
        >
          <Key size={18} />
        </ToolbarButton>
      </div>
      {showShortcuts && !isMobile && <ShortcutsPanel onClose={() => setShowShortcuts(false)} />}
      <AiTaskBanner />
      {captionsDialog && <AutoCaptionsDialog clipIds={captionsDialog.clipIds} onClose={() => setCaptionsDialog(null)} />}
      {showVoiceRecord && <VoiceRecordModal onClose={() => setShowVoiceRecord(false)} />}
      {showTextImport && <TextToClipsDialog onClose={() => setShowTextImport(false)} />}
      {showMusic && <MusicPanel onClose={() => setShowMusic(false)} />}
      {showSfx && <SfxPanel onClose={() => setShowSfx(false)} />}
      {showStickers && <StickersPanel onClose={() => setShowStickers(false)} />}
      {(aiEditClipId || aiEditModalClipId) && (
        <AiEditModal
          clipId={(aiEditClipId || aiEditModalClipId)!}
          onClose={() => {
            setAiEditClipId(null);
            openAiEdit(null);
          }}
        />
      )}
      <NewTextComposer />
      <SaveConflictDialog />
      {/* Zero-size, invisible — exists only so the picker menus above have a real DOM element to
          anchor to (`getBoundingClientRect()`) when opened FROM the context menu instead of their own
          toolbar button. Repositioning it via plain inline style (not React state driving layout) is
          fine here: it has no visible box for a layout shift to matter, so it can move outside React's
          normal render cycle without any visual cost. */}
      <div
        ref={contextMenuAnchorRef}
        data-vcut-context-anchor
        style={{
          position: "fixed",
          left: transitionPickerRequest?.x ?? contextMenu?.x ?? 0,
          top: transitionPickerRequest?.y ?? contextMenu?.y ?? 0,
        }}
      />
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
  const sessionExpired = useEditorStore((s) => s.sessionExpired);
  const save = useEditorStore((s) => s.save);
  const t = useTranslation();
  const [showSaved, setShowSaved] = useState(false);
  const [showSignIn, setShowSignIn] = useState(false);

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

  // Checked before `saving`/`dirty`/`showSaved` below and never auto-clears on its own (unlike
  // "All changes saved"'s 3s timer) — a session that died needs the user to actually notice and act,
  // not a message that politely disappears while every subsequent autosave keeps failing the same way.
  // Only `save()` succeeding again (right after sign-in, or any edit afterward) turns this off, by
  // setting `sessionExpired: false` itself.
  if (sessionExpired) {
    return (
      <>
        <button
          onClick={() => setShowSignIn(true)}
          className="shrink-0 truncate rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-300 transition hover:bg-amber-500/25"
        >
          {t("Session expired — Sign in")}
        </button>
        {showSignIn && (
          <MobileSignInDialog
            onClose={() => {
              setShowSignIn(false);
              void save();
            }}
          />
        )}
      </>
    );
  }

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
          status.tone === "error" ? "border border-amber-200/15 bg-[#1f1c16] text-amber-100/90" : "border border-white/10 bg-[#181b22] text-white/80"
        }`}
      >
        <span className="truncate">{status.message}</span>
        <button
          onClick={() => setStatus(null)}
          aria-label="Dismiss"
          className={`shrink-0 rounded p-0.5 leading-none transition ${
            status.tone === "error" ? "text-amber-100/50 hover:bg-white/10 hover:text-amber-100" : "text-white/40 hover:bg-white/10 hover:text-white/80"
          }`}
        >
          ✕
        </button>
      </div>
    </div>,
    document.body
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
  const selectedClipIds = useEditorStore((s) => s.selectedClipIds);
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
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [showLayoutOptions, setShowLayoutOptions] = useState(false);
  const [showSaveAsTemplate, setShowSaveAsTemplate] = useState(false);
  // Set by `TemplateFillScreen`'s own "Preview" button — every slot being filled makes that button
  // ENABLED, not an automatic jump to `TemplatePreviewScreen` the instant the last pick lands; the user
  // still has to explicitly confirm they're done THIS session (see the `project.templateOrigin` branch
  // below for how this combines with `templateSlots(project)`'s own live count). Also set, once, by the
  // load effect right below, for a project that's already fully filled the moment it's OPENED — a real,
  // reported bug otherwise: reopening a finished template project (nothing left to fill) landed back on
  // `TemplateFillScreen` every time regardless, since this state starts `false` on every fresh mount
  // with no way to know slots had already all been filled in some EARLIER session.
  const [confirmedTemplatePreview, setConfirmedTemplatePreview] = useState(false);
  // Guards the one-time "already finished, skip straight to preview" check below from re-running on
  // every subsequent project mutation (`project` is a fresh object on every edit) — only the very FIRST
  // sighting of a loaded project this mount should ever decide this.
  const checkedTemplatePreviewOnLoad = useRef(false);
  useEffect(() => {
    if (checkedTemplatePreviewOnLoad.current || !project?.templateOrigin) return;
    checkedTemplatePreviewOnLoad.current = true;
    if (templateSlots(project).length === 0) setConfirmedTemplatePreview(true);
  }, [project]);
  const moreMenuRef = useRef<HTMLDivElement>(null);

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

  // The Android app's half — the same browser round trip (Google, or an emailed link opened in the
  // browser), handed back through a `vcut://auth-callback` link. See `nativeAuth.ts`.
  useEffect(() => {
    return subscribeToNativeAuthCallback(({ accessToken, refreshToken }) => {
      void getSupabaseBrowserClient()?.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
    });
  }, []);

  // Signing in finishes outside the dialog when it goes through the browser, so close it here.
  useEffect(() => {
    if (user) setShowMobileSignIn(false);
  }, [user]);

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
  const isMobile = useIsMobile();
  const [toolbarPosition, setToolbarPosition] = useState<ToolbarPosition>(readToolbarPosition);
  const [desktopMediaOpen, setDesktopMediaOpen] = useState(false);
  const [toolDockElement, setToolDockElement] = useState<HTMLElement | null>(null);
  const [toolDockOpen, setToolDockOpen] = useState(false);
  const [leftPanelCollapsed, setLeftPanelCollapsed] = useState(false);
  const [leftPanelFullHeight, setLeftPanelFullHeight] = useState(true);
  const [propertiesCollapsed, setPropertiesCollapsed] = useState(true);
  const [propertiesFullHeight, setPropertiesFullHeight] = useState(true);
  const desktopLeft = effectiveToolbarPosition(toolbarPosition, !isMobile) === "left";
  const leftPanelOpen = desktopLeft && (desktopMediaOpen || toolDockOpen);
  const leftPanelExpanded = leftPanelOpen && !leftPanelCollapsed;
  useEffect(() => {
    if (!toolDockElement) return;
    const update = () => {
      const open = toolDockElement.childElementCount > 0;
      setToolDockOpen(open);
      if (open) {
        setDesktopMediaOpen(false);
        setLeftPanelCollapsed(false);
      }
    };
    const observer = new MutationObserver(update);
    observer.observe(toolDockElement, { childList: true });
    update();
    return () => observer.disconnect();
  }, [toolDockElement]);
  useEffect(() => {
    setPropertiesCollapsed(selectedClipIds.length === 0);
  }, [selectedClipIds]);
  useLayoutEffect(() => {
    document.documentElement.dataset.vcutToolbarPosition = toolbarPosition;
    window.dispatchEvent(new Event("vcut:toolbar-position-change"));
  }, [toolbarPosition]);
  useEffect(() => {
    if (!showMoreMenu) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!moreMenuRef.current?.contains(event.target as Node)) setShowMoreMenu(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowMoreMenu(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [showMoreMenu]);
  function chooseToolbarPosition(next: ToolbarPosition) {
    if (toolbarPosition === "bottom" && next === "left") setDesktopMediaOpen(true);
    setToolbarPosition(next);
    try {
      window.localStorage.setItem(TOOLBAR_POSITION_STORAGE_KEY, next);
    } catch {
      // The current session still switches when storage is unavailable.
    }
    setShowMoreMenu(false);
  }

  // Media/Stock/AI is a pure pick-then-place flow (see `armedAssetId`'s own doc comment in
  // editorStore.ts) — nothing in it needs a live view of the current frame the way adjusting a filter
  // or text style in Properties does, so unlike the Properties sheet, collapsing Preview entirely
  // while THIS one is open trades nothing a user actually needs there for meaningfully more room to
  // browse/search/generate in — real room, confirmed a real problem: the sheet was previously capped
  // at whatever `timelineHeight` happened to be (as little as ~224px by default), the same fixed row
  // Timeline itself uses, on top of the space Preview and its own transport bar took above it.
  const hidePreviewForMediaSheet = isMobile && mobileSheet === "media";

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
  const [timelineCollapsed, setTimelineCollapsed] = useState(false);
  const compactTimeline = timelineCollapsed && bottomPanel === "timeline" && mobileSheet === null;
  const visibleTimelineHeight = compactTimeline ? 36 : timelineHeight;

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
  const leftPanelWidth = toolDockOpen ? TOOL_DOCK_WIDTH : mediaWidth;
  // Read inside the resize-listener effect below, which (like `timelineHeight`'s own) stays mount-only
  // (`[]` deps) — a ref is what lets it see each width's LATEST value without re-subscribing the
  // `resize` listener on every drag pixel the way depending on the state directly would.
  const mediaWidthRef = useRef(mediaWidth);
  mediaWidthRef.current = mediaWidth;
  const propertiesWidthRef = useRef(propertiesWidth);
  propertiesWidthRef.current = propertiesWidth;
  const desktopLeftRef = useRef(desktopLeft);
  desktopLeftRef.current = desktopLeft;
  const desktopMediaOpenRef = useRef(desktopMediaOpen);
  desktopMediaOpenRef.current = desktopMediaOpen;
  const toolDockOpenRef = useRef(toolDockOpen);
  toolDockOpenRef.current = toolDockOpen;

  useLayoutEffect(() => {
    const width = window.innerWidth - (desktopLeft ? TOOLBAR_RAIL_WIDTH : 0);
    setMediaWidth((w) => clampSideWidth(w, propertiesWidthRef.current, width));
    setPropertiesWidth((w) => clampSideWidth(w, desktopLeft && toolDockOpen ? TOOL_DOCK_WIDTH : desktopLeft && !desktopMediaOpen ? 0 : mediaWidthRef.current, width));
  }, [desktopLeft, desktopMediaOpen, toolDockOpen]);

  useEffect(() => {
    function onResize() {
      const width = window.innerWidth - (desktopLeftRef.current ? TOOLBAR_RAIL_WIDTH : 0);
      setMediaWidth((w) => clampSideWidth(w, propertiesWidthRef.current, width));
      setPropertiesWidth((w) => clampSideWidth(w, desktopLeftRef.current && toolDockOpenRef.current ? TOOL_DOCK_WIDTH : desktopLeftRef.current && !desktopMediaOpenRef.current ? 0 : mediaWidthRef.current, width));
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
        setMediaWidth(clampSideWidth(startWidth + dx, propertiesWidthRef.current, window.innerWidth - (desktopLeft ? TOOLBAR_RAIL_WIDTH : 0)));
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
        setPropertiesWidth(clampSideWidth(startWidth + dx, desktopLeft && toolDockOpen ? TOOL_DOCK_WIDTH : desktopLeft && !desktopMediaOpen ? 0 : mediaWidthRef.current, window.innerWidth - (desktopLeft ? TOOLBAR_RAIL_WIDTH : 0)));
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

  // The editor must never show a project other than the one in the URL. Reported on vcut.io: creating
  // a blank project opened the editor showing the PREVIOUS project's name and video, while the new
  // project on the server was empty and never reproduced locally. Whatever leaves the store holding
  // the wrong project, this shows the loading state instead, reloads the right one, and reports it.
  const heldProjectId = project?.bpProjectId ?? null;
  const projectMismatch = !loading && heldProjectId !== null && heldProjectId !== projectId;
  useEffect(() => {
    if (!projectMismatch) return;
    // Re-read the store rather than trusting `projectMismatch` from render: on the first render after
    // navigating here it's true only because the load effect above hadn't switched the store yet, and
    // by the time this effect runs that effect already has (store now loading, holding no project).
    // Only a store that has switched to this id, finished loading, and still holds another project is
    // the real anomaly.
    const state = useEditorStore.getState();
    const heldNow = state.project?.bpProjectId ?? null;
    if (state.loading || state.projectId !== projectId || heldNow === null || heldNow === projectId) return;
    reportError("editor-project-mismatch", new Error("Editor held a different project than the URL"), {
      url: projectId,
      held: heldNow,
      heldName: state.project?.name ?? null,
    });
    void load(projectId, projectName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectMismatch]);

  // Flush on unmount and on window close, so the autosave debounce can never swallow the final edit.
  useEffect(() => {
    // `beforeunload` alone isn't enough: an async fetch started there is routinely cancelled, and on
    // iOS/Android a backgrounded app is often killed without it ever firing. `visibilitychange` (hidden)
    // and `pagehide` are the events that DO fire in those cases, so each flushes with `keepalive`, which lets
    // the browser complete the save on its own even if the page is torn down.
    const onLeaving = () => void flushPendingSave({ keepalive: true });
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") onLeaving();
    };
    window.addEventListener("beforeunload", onLeaving);
    window.addEventListener("pagehide", onLeaving);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("beforeunload", onLeaving);
      window.removeEventListener("pagehide", onLeaving);
      document.removeEventListener("visibilitychange", onVisibilityChange);
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
      // Standard clipboard shortcuts. Only reached when focus is NOT in a text field (`isTypingTarget`
      // above), so Ctrl+C/V/X/A keep their ordinary text meaning inside inputs.
      if (modifier && event.key.toLowerCase() === "c") {
        if (state.selectedClipIds.length === 0) return;
        event.preventDefault();
        state.copySelectedClips();
        return;
      }
      if (modifier && event.key.toLowerCase() === "x") {
        if (state.selectedClipIds.length === 0) return;
        event.preventDefault();
        state.cutSelectedClips();
        return;
      }
      if (modifier && event.key.toLowerCase() === "v") {
        if (state.clipboardCount === 0) return;
        event.preventDefault();
        state.pasteClips();
        return;
      }
      if (modifier && event.key.toLowerCase() === "a") {
        event.preventDefault();
        state.selectAllClips();
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
          if (!state.playing) state.playbackEngine?.primeFromGesture();
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
        case "End": {
          event.preventDefault();
          state.setPlayhead(state.duration());
          break;
        }
        // Previous / next edit point (the nearest clip start or end). The timeline ruler already handles
        // ↑/↓ as single-frame steps when IT has focus, so leave that alone rather than doing both.
        case "ArrowUp":
        case "ArrowDown": {
          if (event.target instanceof HTMLElement && event.target.closest('[role="slider"]')) return;
          event.preventDefault();
          state.jumpToEditPoint(event.key === "ArrowUp" ? -1 : 1);
          break;
        }
        // Deselect — but not while a menu or dialog is open: Escape belongs to closing that.
        case "Escape": {
          if (state.selectedClipIds.length === 0) return;
          if (document.querySelector('[role="menu"], [role="dialog"], [aria-modal="true"]')) return;
          state.select([]);
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

  if (loading || projectMismatch) {
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
        <p className="text-sm font-medium text-amber-200/90">{t("VCut couldn't open this project")}</p>
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

  // A project started from a template never shows the normal timeline/clip editor at all — asked for
  // directly, so the packaged template EXPERIENCE stays consistent rather than opening it up to the
  // same free-form editing any other project gets. Stays on `TemplateFillScreen` until BOTH every slot
  // is filled (`templateSlots(project)` re-checked live on every render — cheap, a plain filter over
  // `project.assets`) AND the user has explicitly hit its own "Preview" button
  // (`confirmedTemplatePreview`) — filling the last slot alone only ENABLES that button, it doesn't
  // jump the screen out from under someone mid-pick.
  if (project.templateOrigin) {
    const hasOpenSlots = templateSlots(project).length > 0;
    if (hasOpenSlots || !confirmedTemplatePreview) {
      return <TemplateFillScreen onAllFilled={() => setConfirmedTemplatePreview(true)} onBack={onHome} />;
    }
    return <TemplatePreviewScreen onBack={onHome} />;
  }

  return (
    <ToolPanelDockContext.Provider value={desktopLeft ? toolDockElement : null}>
    {/* "VCut" is a product name — never translated. `vcut-lang-km` (see studios/vcut's
        globals.css) swaps the whole chrome's font-family to a Khmer-capable face via inheritance. */}
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
        {/* Keep Export prominent; the less frequent editor, language, template, and account actions
            share one menu at the far right. */}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <button
            onClick={() => setExportOpen(true)}
            className="shrink-0 rounded-md bg-sky-500 px-3 py-1 text-[11px] font-semibold text-white transition hover:bg-sky-400"
          >
            {t("Export")}
          </button>
          <div ref={moreMenuRef} className="relative">
            <button
              type="button"
              title={t("More options")}
              aria-label={t("More options")}
              aria-expanded={showMoreMenu}
              onClick={() => {
                setShowMoreMenu((open) => !open);
                setShowLayoutOptions(false);
              }}
              className="relative flex h-8 w-8 items-center justify-center rounded-md text-white/65 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
            >
              <More size={19} />
              {hosted && credits?.plan === "pro" && (
                <span aria-hidden className="absolute right-0 top-0 h-2 w-2 rounded-full border border-[#0a0c10] bg-amber-400" />
              )}
            </button>
            {showMoreMenu && (
              <div
                role="menu"
                aria-label={t("Editor menu")}
                className="absolute right-0 top-full z-50 mt-2 max-h-[calc(100dvh-4rem)] w-56 overflow-y-auto rounded-xl border border-white/15 bg-[#181b22] p-1.5 shadow-2xl"
              >
                {user && (
                  <div className="border-b border-white/10 px-2.5 py-2">
                    <p className="truncate text-[11px] text-white/55">{user.email}</p>
                    {hosted && credits && (
                      <p className="mt-0.5 text-[11px] text-white/40">
                        {t("{plan} · {n} credits left", { plan: credits.plan === "pro" ? t("Pro") : t("Free"), n: credits.creditsRemaining })}
                      </p>
                    )}
                  </div>
                )}
                {user && !isNative && (
                  <button role="menuitem" onClick={() => (window.location.href = "/account")} className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-xs text-white/80 transition hover:bg-white/10 hover:text-white">
                    <Profile size={16} className="shrink-0 text-white/50" />{t("Account")}
                  </button>
                )}
                {!user && isDesktopSignInAvailable() && (
                  <button role="menuitem" onClick={() => { setShowMoreMenu(false); openDesktopSignIn(); }} className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-xs text-white/80 transition hover:bg-white/10 hover:text-white">
                    <Profile size={16} className="shrink-0 text-white/50" />{t("Sign in")}
                  </button>
                )}
                {!user && isNative && (
                  <button role="menuitem" onClick={() => { setShowMoreMenu(false); setShowMobileSignIn(true); }} className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-xs text-white/80 transition hover:bg-white/10 hover:text-white">
                    <Profile size={16} className="shrink-0 text-white/50" />{t("Sign in")}
                  </button>
                )}
                {user && (
                  <button role="menuitem" onClick={() => { setShowMoreMenu(false); if (isNative) void signOut(); else void signOut().then(() => (window.location.href = "/login")); }} className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-xs text-white/80 transition hover:bg-white/10 hover:text-white">
                    <Logout size={16} className="shrink-0 text-white/50" />{t("Sign out")}
                  </button>
                )}
                {user && <div className="my-1 border-t border-white/10" />}
                <div className="hidden lg:block">
                  <button
                    type="button"
                    aria-label={t("Toolbar Position")}
                    aria-expanded={showLayoutOptions}
                    onClick={() => setShowLayoutOptions((open) => !open)}
                    className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-xs text-white/80 transition hover:bg-white/10 hover:text-white"
                  >
                    <EditorLayoutIcon size={16} />
                    <span className="flex-1">{t("Layout")}</span>
                    <ChevronRight size={13} className={`text-white/40 transition-transform ${showLayoutOptions ? "rotate-90" : ""}`} />
                  </button>
                  {showLayoutOptions && (
                    <div role="group" aria-label={t("Toolbar Position")} className="mb-1 ml-6 border-l border-white/10 pl-2">
                      {(["left", "bottom"] as const).map((position) => (
                        <button
                          key={position}
                          type="button"
                          aria-pressed={toolbarPosition === position}
                          onClick={() => chooseToolbarPosition(position)}
                          className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition hover:bg-white/10 ${toolbarPosition === position ? "text-sky-300" : "text-white/65 hover:text-white"}`}
                        >
                          <span aria-hidden className={`h-2 w-2 rounded-full ${toolbarPosition === position ? "bg-sky-400" : "bg-white/25"}`} />
                          {t(position === "left" ? "Left" : "Bottom")}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <button role="menuitem" onClick={() => { setLanguage(language === "en" ? "km" : "en"); setShowMoreMenu(false); }} className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-xs text-white/80 transition hover:bg-white/10 hover:text-white">
                  <Globe size={16} className="shrink-0 text-white/50" />
                  <span className="flex-1">{t("Language")}</span>
                  <span className="text-[11px] text-white/45">{language === "en" ? "ខ្មែរ" : "EN"}</span>
                </button>
                {hosted && (
                  <button role="menuitem" onClick={() => { setShowMoreMenu(false); if (credits?.plan === "pro") setShowSaveAsTemplate(true); else handleUpgradeClick(); }} title={t("Save the current project's structure as a reusable template")} className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-xs text-white/80 transition hover:bg-white/10 hover:text-white">
                    <Document size={16} className="shrink-0 text-white/50" />{t("Save as template")}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </header>
      {showSaveAsTemplate && <SaveAsTemplateDialog onClose={() => setShowSaveAsTemplate(false)} />}
      <div className="vcut-editor-body min-h-0 min-w-0 flex-1" data-vcut-media-open={desktopMediaOpen} data-vcut-tool-dock-open={toolDockOpen} data-vcut-left-panel-expanded={leftPanelExpanded} data-vcut-left-panel-full-height={leftPanelFullHeight} data-vcut-properties-collapsed={propertiesCollapsed} data-vcut-properties-full-height={propertiesFullHeight}>

      {/* Three panes at `lg`+ (1024px): an optional media panel, preview, and inspector,
          with the timeline across the bottom. The toolbar sits beside this workspace in Left mode.
          Below `lg`, there's no
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
        className="vcut-workspace relative grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_224px] lg:grid-cols-[var(--vs-media-w)_minmax(0,1fr)_var(--vs-props-w)] lg:grid-rows-[minmax(0,1fr)_320px]"
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
            // Row 1 (Preview) collapses to 0 and row 2 takes 100% of what's left, ignoring
            // `timelineHeight` entirely — see `hidePreviewForMediaSheet`'s own doc comment above for
            // why the Media sheet specifically gets the whole area instead of the same fixed row
            // Timeline/every other sheet shares.
            gridTemplateRows: hidePreviewForMediaSheet ? "0px minmax(0,1fr)" : `minmax(0,1fr) ${visibleTimelineHeight}px`,
            "--vs-media-w": `${mediaWidth}px`,
            "--vs-left-w": `${leftPanelExpanded ? leftPanelWidth : 0}px`,
            "--vs-timeline-h": `${visibleTimelineHeight}px`,
            "--vs-props-w": `${propertiesCollapsed ? 0 : propertiesWidth}px`,
          } as React.CSSProperties
        }
      >
        <div className="row-start-1 min-h-0 min-w-0 lg:order-2 lg:col-start-2 lg:row-start-1" hidden={hidePreviewForMediaSheet}>
          <Preview onResizeStart={(event) => { if (compactTimeline) setTimelineCollapsed(false); beginTimelineResize(event); }} />
        </div>

        {/* Permanent side columns, `lg`+ only — below `lg` these render nothing at all. Genuinely
            UNMOUNTED there (`!isMobile &&`), not just `hidden`-but-still-mounted via CSS alone: a bare
            `hidden lg:block` wrapper still leaves the child MOUNTED underneath at narrow widths, and
            the mobile-sheet copies of these same two panels below mount their OWN separate instance
            whenever `mobileSheet` opens one — confirmed as a real, live bug, not a theoretical one:
            `MediaPanel`'s own tabs, search query, and AI-generation availability checks all ran
            TWICE simultaneously (one hidden instance here, one visible in the sheet) the whole time a
            phone-width session had the sheet open. Reached on mobile via the toolbar's Media/Properties
            buttons instead, which swap the Timeline row's content below. */}
        <div className="vcut-media-panel hidden min-h-0 min-w-0 lg:col-start-1 lg:row-start-1 lg:block">
          <div className="vcut-media-panel-content h-full min-h-0">{!isMobile && <MediaPanel />}</div>
          <div ref={setToolDockElement} className="vcut-tool-panel-root h-full min-h-0" />
          <button type="button" className="vcut-tool-dock-close" aria-label={t("Close")} onClick={() => window.dispatchEvent(new Event("vcut:close-tool-dock"))}>×</button>
        </div>
        {leftPanelExpanded && (
          <button
            type="button"
            className="vcut-left-height-toggle"
            style={{ left: leftPanelWidth }}
            title={t(leftPanelFullHeight ? "Keep panel above timeline" : "Extend panel to bottom")}
            aria-label={t(leftPanelFullHeight ? "Keep panel above timeline" : "Extend panel to bottom")}
            aria-pressed={leftPanelFullHeight}
            onClick={() => setLeftPanelFullHeight((fullHeight) => !fullHeight)}
          >
            {leftPanelFullHeight ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        )}
        <div className="vcut-properties-panel relative hidden min-h-0 min-w-0 lg:col-start-3 lg:row-start-1 lg:block">
          {!isMobile && <Inspector />}
          {!isMobile && (
            <button
              type="button"
              title={t(propertiesFullHeight ? "Keep Properties above timeline" : "Extend Properties to bottom")}
              aria-label={t(propertiesFullHeight ? "Keep Properties above timeline" : "Extend Properties to bottom")}
              aria-pressed={propertiesFullHeight}
              onClick={() => setPropertiesFullHeight((fullHeight) => !fullHeight)}
              className="absolute right-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded text-white/40 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
            >
              {propertiesFullHeight ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
            </button>
          )}
        </div>

        {/* The one row Timeline shares with Media/Properties below `lg`, and with Mixer at every
            breakpoint — `mobileSheet` stays `null` at `lg`+ (nothing there ever sets it), so this falls
            through to `bottomPanel` (Timeline vs. Mixer) once the permanent side columns above are
            visible. See `bottomPanel`'s own comment for why it's a separate concept from
            `mobileSheet`. */}
        <div className="vcut-bottom-panel relative row-start-2 min-h-0 min-w-0 lg:col-span-3 lg:row-start-2">
          {mobileSheet === "media" ? (
            <MediaPanel onAssetAdded={() => setMobileSheet(null)} />
          ) : mobileSheet === "inspector" ? (
            <>
              <Inspector />
              <button
                type="button"
                title={t("Close")}
                aria-label={t("Close Properties")}
                onClick={() => setMobileSheet(null)}
                className="absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-md bg-white/10 text-white/70 transition hover:bg-white/20 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
              >
                <Close size={16} />
              </button>
            </>
          ) : bottomPanel === "mixer" ? (
            <MixerPanel onFloat={() => beginFloat("mixer")} />
          ) : bottomPanel === "scopes" ? (
            <ScopesPanel onFloat={() => beginFloat("scopes")} />
          ) : (
            <>
              <div className={`h-full ${compactTimeline ? "invisible" : ""}`}><Timeline onCollapse={() => setTimelineCollapsed(true)} /></div>
              {compactTimeline && <div className="absolute inset-0"><CollapsedTimelineStrip onExpand={() => setTimelineCollapsed(false)} /></div>}
            </>
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
        {/* Hidden along with Preview itself while the Media sheet has collapsed row 1 to 0 — there's
            no boundary left to drag (row 2 already fills everything), and `bottom: timelineHeight`
            would otherwise sit stranded mid-content instead of on a real row edge. */}
        <div
          onMouseDown={beginTimelineResize}
          onTouchStart={beginTimelineResize}
          role="separator"
          aria-orientation="horizontal"
          aria-label={t("Resize timeline")}
          hidden={hidePreviewForMediaSheet || compactTimeline}
          className="vcut-timeline-resizer absolute inset-x-0 z-20 h-2.5 -translate-y-1/2 cursor-row-resize touch-none"
          style={{ bottom: visibleTimelineHeight }}
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
          className="vcut-media-resizer absolute inset-y-0 z-20 hidden w-2.5 -translate-x-1/2 cursor-col-resize touch-none lg:block"
          style={{ left: desktopLeft ? leftPanelWidth : mediaWidth }}
        />
        <div
          onMouseDown={beginPropertiesResize}
          onTouchStart={beginPropertiesResize}
          role="separator"
          aria-orientation="vertical"
          aria-label={t("Resize properties panel")}
          className="vcut-properties-resizer absolute inset-y-0 z-20 hidden w-2.5 translate-x-1/2 cursor-col-resize touch-none lg:block"
          style={{ right: propertiesWidth }}
        />
        {!isMobile && (
          <button
            type="button"
            className="vcut-properties-toggle"
            style={{ right: propertiesCollapsed ? 10 : propertiesWidth }}
            aria-label={t(propertiesCollapsed ? "Expand Properties" : "Collapse Properties")}
            title={t(propertiesCollapsed ? "Expand Properties" : "Collapse Properties")}
            aria-expanded={!propertiesCollapsed}
            onClick={() => setPropertiesCollapsed((collapsed) => !collapsed)}
          >
            {propertiesCollapsed ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
          </button>
        )}
        {leftPanelOpen && (
          <button
            type="button"
            className={`vcut-tool-dock-toggle ${leftPanelCollapsed ? "vcut-tool-dock-toggle-collapsed" : ""}`}
            style={{ left: leftPanelCollapsed ? 10 : leftPanelWidth }}
            aria-label={t(leftPanelCollapsed ? "Expand tool panel" : "Collapse tool panel")}
            title={t(leftPanelCollapsed ? "Expand tool panel" : "Collapse tool panel")}
            aria-expanded={!leftPanelCollapsed}
            onClick={() => setLeftPanelCollapsed((collapsed) => !collapsed)}
          >
            {leftPanelCollapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
          </button>
        )}
      </div>

      <StatusBar
        mobileSheet={mobileSheet}
        setMobileSheet={setMobileSheet}
        toolbarPosition={toolbarPosition}
        desktopMediaOpen={desktopMediaOpen}
        onToggleDesktopMedia={() => { setDesktopMediaOpen((open) => toolDockOpen ? true : !open); setLeftPanelCollapsed(false); }}
        bottomPanel={bottomPanel}
        setBottomPanel={setBottomPanel}
        floatingPanel={floatState?.panel ?? null}
        onDockFloating={dockPanel}
      />
      </div>
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
    </ToolPanelDockContext.Provider>
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
