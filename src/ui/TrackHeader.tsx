"use client";

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowDown, ArrowUp, Delete, Lock, Menu, Music, Text as TextIcon, Unlock, Video, Visibility, VisibilityOff } from "@veasnawt/vicons";
import { MoveTrackLayerCommand, RemoveTrackCommand, SetTrackFlagCommand } from "../commands/index.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import type { Track } from "../project/types.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { CoverControl } from "./CoverControl.tsx";

/** Icon + accent color standing in for a track's own kind — the row's own "identity tile" for every
 *  track EXCEPT the one showing the real Cover thumbnail instead (see `isCoverTrack` below). Same
 *  color convention `TimelineClip.tsx` already uses to tell video/audio clips apart at a glance
 *  (sky/emerald), extended to text tracks with amber so all three kinds read distinctly even reduced
 *  to a single glyph. */
const KIND_ICON: Record<Track["kind"], { Icon: typeof Video; className: string }> = {
  video: { Icon: Video, className: "text-sky-300" },
  audio: { Icon: Music, className: "text-emerald-300" },
  text: { Icon: TextIcon, className: "text-amber-300" },
};

/** Per-kind subset of MediaLibrary.tsx's own `ACCEPTED_EXTENSIONS` — a video track takes video OR
 *  image files (images live on a video track alongside real video, see `trackKindForAsset`'s own
 *  comment in timeline/operations.ts), an audio track takes only audio. Not imported from
 *  MediaLibrary.tsx since that file keeps one flat unsplit list; duplicated here rather than
 *  restructuring that file just for this. Text tracks get no import button at all — a text track's
 *  content is typed, not a file. */
export const ACCEPTED_EXTENSIONS_BY_KIND: Record<"video" | "audio", string> = {
  video: ".mp4,.mov,.webm,.mkv,.avi,.m4v,.png,.jpg,.jpeg,.webp,.gif",
  audio: ".wav,.mp3,.aac,.flac,.m4a,.ogg",
};

/** Carries the dragged track's id, readable only at drop time (browsers restrict `getData` during
 *  `dragover` for security). A SECOND, per-kind type — `${TRACK_DRAG_MIME}-kind-${kind}` — carries no
 *  data at all and exists purely so `dragover`/`drop` can check `types.includes(...)`, which IS
 *  readable mid-drag, to confirm the dragged track is the same kind as the row being hovered. That's
 *  what keeps a video track from being reordered into the audio group (or vice versa) — the same
 *  video-above-audio invariant `addTrack`/`reorderTrack` both maintain. */
const TRACK_DRAG_MIME = "application/x-vcut-track";

/** Every less-frequently-needed per-track action, tucked behind one "⋮" button instead of sitting in
 *  the row permanently — a real, direct request: the row used to show Lock/Visibility/Mute/Solo/
 *  Import/Delete all inline at once, which is exactly the "long, busy horizontal header" this
 *  component was asked to stop being. What's actually needed constantly (seeing/picking the Cover,
 *  knowing a track's kind, its name) stays in the row itself; what's occasional (locking, hiding,
 *  muting, importing, deleting) moves in here. Positioned like `TransitionPickerMenu`'s own popup —
 *  fixed, anchored to the button's own rect, closed on an outside click or Escape. */
function TrackActionsMenu({ track, anchorRef, onClose }: { track: Track; anchorRef: React.RefObject<HTMLElement | null>; onClose: () => void }) {
  const t = useTranslation();
  const run = useEditorStore((s) => s.run);
  const importFiles = useEditorStore((s) => s.importFiles);
  const addAssetAtPlayhead = useEditorStore((s) => s.addAssetAtPlayhead);
  const importing = useEditorStore((s) => s.importing);
  const menuRef = useRef<HTMLDivElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      // ConfirmDialog is portaled beside this menu, not inside `menuRef`. While it is open, treating
      // its button press as an outside click unmounts the dialog on pointerdown before its onClick can
      // run, which made both Remove and Cancel appear broken.
      if (confirmOpen) return;
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
  }, [anchorRef, confirmOpen, onClose]);

  // The menu is taller than the space under a track near the bottom of the screen (or above the on-screen keyboard), so
  // it used to open half off-screen. Once it has a real height, flip it above the header if it doesn't fit below, and
  // clamp it inside the viewport with its own scroll as the last resort.
  const [menuTop, setMenuTop] = useState<number | null>(null);
  const anchor = anchorRef.current?.getBoundingClientRect();
  useLayoutEffect(() => {
    const menu = menuRef.current;
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!menu || !rect) return;
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const height = menu.offsetHeight;
    const margin = 8;
    const below = rect.bottom + 4;
    let top = below;
    if (below + height > viewportHeight - margin) top = rect.top - height - 4;
    top = Math.max(margin, Math.min(top, viewportHeight - height - margin));
    setMenuTop(top);
  }, [anchorRef, confirmOpen, track.kind, track.visible, track.locked]);
  if (!anchor) return null;

  // Portaled straight to `document.body` — a real, reported bug without this: `TrackHeader` renders
  // deep inside `Timeline.tsx`'s own scrolling/zooming hierarchy on mobile (an `absolute`-positioned
  // per-row chip inside a horizontally-scrolling lane), and `position: fixed` only actually fixes to
  // the VIEWPORT when no ancestor establishes its own containing block for fixed descendants (a
  // `transform`, in particular — which that scrolling/zooming machinery relies on). Rendered inline,
  // this menu was getting trapped inside that ancestor's own stacking context instead of truly
  // overlaying the page, so a track's own clip label (from a LATER sibling in that same context) could
  // still paint on top of it. Every other popup in this app that needs true page-level stacking
  // (`TransitionPickerMenu`, `EffectsPickerMenu`, `ColorPickerMenu`) already does this — this was the
  // one that didn't, being new.
  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      onClick={(e) => e.stopPropagation()}
      style={{
        position: "fixed",
        top: menuTop ?? anchor.bottom + 4,
        left: Math.max(8, Math.min(anchor.left, window.innerWidth - 176)),
        maxHeight: (window.visualViewport?.height ?? window.innerHeight) - 16,
      }}
      className="z-50 w-44 overflow-y-auto rounded-lg border border-white/10 bg-[#181b22] py-1 text-left shadow-2xl"
    >
      <button
        role="menuitem"
        onClick={() => {
          run(new SetTrackFlagCommand(track.id, "locked", !track.locked));
          onClose();
        }}
        className="flex w-full items-center gap-2 px-3 py-2 text-xs text-white/80 transition hover:bg-white/10"
      >
        {track.locked ? <Unlock size={13} /> : <Lock size={13} />}
        {track.locked ? t("Unlock track") : t("Lock track")}
      </button>

      {track.kind !== "audio" && (
        <button
          role="menuitem"
          onClick={() => {
            run(new SetTrackFlagCommand(track.id, "visible", !track.visible));
            onClose();
          }}
          className="flex w-full items-center gap-2 px-3 py-2 text-xs text-white/80 transition hover:bg-white/10"
        >
          {track.visible ? <VisibilityOff size={13} /> : <Visibility size={13} />}
          {track.visible ? t("Hide track") : t("Show track")}
        </button>
      )}

      <button
        role="menuitem"
        onClick={() => {
          run(new SetTrackFlagCommand(track.id, "muted", !track.muted));
          onClose();
        }}
        className="flex w-full items-center gap-2 px-3 py-2 text-xs text-white/80 transition hover:bg-white/10"
      >
        <span className="flex h-[13px] w-[13px] items-center justify-center text-[10px] font-bold">M</span>
        {track.muted ? t("Unmute track") : t("Mute track")}
      </button>

      {track.kind === "audio" && (
        <button
          role="menuitem"
          onClick={() => {
            run(new SetTrackFlagCommand(track.id, "solo", !track.solo));
            onClose();
          }}
          className="flex w-full items-center gap-2 px-3 py-2 text-xs text-white/80 transition hover:bg-white/10"
        >
          <span className="flex h-[13px] w-[13px] items-center justify-center text-[10px] font-bold">S</span>
          {track.solo ? t("Unsolo track") : t("Solo track")}
        </button>
      )}

      {track.kind !== "text" && (
        <>
          <button
            role="menuitem"
            disabled={importing}
            onClick={() => importInputRef.current?.click()}
            className="flex w-full items-center gap-2 px-3 py-2 text-xs text-white/80 transition hover:bg-white/10 disabled:opacity-40"
          >
            <span className="flex h-[13px] w-[13px] items-center justify-center text-sm leading-none">+</span>
            {t("Import {kind} onto {name}", { kind: t(track.kind), name: track.name })}
          </button>
          <input
            ref={importInputRef}
            type="file"
            multiple
            accept={ACCEPTED_EXTENSIONS_BY_KIND[track.kind]}
            className="hidden"
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = "";
              onClose();
              if (files.length === 0) return;
              void importFiles(files).then((assets) => {
                for (const asset of assets) addAssetAtPlayhead(asset.id, track.id, { avoidOverlap: true });
              });
            }}
          />
        </>
      )}

      <div className="my-1 border-t border-white/10" />
      <button
        role="menuitem"
        onClick={() => {
          onClose();
          run(new MoveTrackLayerCommand(track.id, "up"));
        }}
        className="flex w-full items-center gap-2 px-3 py-2 text-xs text-white/80 transition hover:bg-white/10"
      >
        <ArrowUp size={13} />
        {t("Bring Layer Forward")}
      </button>
      <button
        role="menuitem"
        onClick={() => {
          onClose();
          run(new MoveTrackLayerCommand(track.id, "down"));
        }}
        className="flex w-full items-center gap-2 px-3 py-2 text-xs text-white/80 transition hover:bg-white/10"
      >
        <ArrowDown size={13} />
        {t("Send Layer Backward")}
      </button>

      <div className="my-1 border-t border-white/10" />
      <button
        role="menuitem"
        onClick={() => setConfirmOpen(true)}
        className="flex w-full items-center gap-2 px-3 py-2 text-xs text-rose-300/90 transition hover:bg-rose-500/10"
      >
        <Delete size={13} />
        {t("Remove track")}
      </button>

      {confirmOpen && (
        <ConfirmDialog
          title={t("Remove {name}?", { name: track.name })}
          message={
            track.clips.length > 0
              ? t("This deletes {n} clip(s) on this track. You can undo it with Ctrl/⌘+Z.", { n: track.clips.length })
              : t("This track is empty. You can undo it with Ctrl/⌘+Z.")
          }
          confirmLabel={t("Remove track")}
          onConfirm={() => {
            setConfirmOpen(false);
            onClose();
            run(new RemoveTrackCommand(track.id));
          }}
          onCancel={() => setConfirmOpen(false)}
        />
      )}
    </div>,
    document.body
  );
}

/** One track's own header row — deliberately compact and IDENTICAL on mobile and desktop now (a real,
 *  direct request to stop being "a long, busy horizontal header" and a separate, harder-to-maintain
 *  collapsed/expanded mode for phones): a drag handle, one square "identity tile" (the real Cover
 *  thumbnail for whichever video track hosts it — see `isCoverTrack` below and `CoverControl.tsx`'s
 *  own doc comment — or a plain color-coded kind icon for every other track), the track's own name,
 *  and a single "⋮" button for everything else (`TrackActionsMenu` above). Reused completely unchanged
 *  in both of `Timeline.tsx`'s own call sites — the fixed desktop sidebar column, and the mobile
 *  inline per-row leading-gutter chip — only ITS POSITION in the DOM differs between the two. */
export function TrackHeader({
  track,
  height,
  dropIndicator,
  onDragOverRow,
  onDropRow,
  onDragEndRow,
}: {
  track: Track;
  /** Timeline.tsx's own `isTrackCompact` result, already resolved to a pixel height there — this
   *  component doesn't need to know WHY a row is shorter, just how tall to draw it. */
  height: number;
  /** "before"/"after" if THIS row is the current drag target, else null — Timeline owns the single
   *  shared piece of state this derives from, since only one row can be a drop target at a time. */
  dropIndicator: "before" | "after" | null;
  onDragOverRow: (trackId: string, position: "before" | "after") => void;
  onDropRow: (sourceTrackId: string, targetTrackId: string, position: "before" | "after") => void;
  onDragEndRow: () => void;
}) {
  const t = useTranslation();
  const activeTrackId = useEditorStore((s) => s.activeTrackId);
  const setActiveTrack = useEditorStore((s) => s.setActiveTrack);
  // `project.exportSettings.cover` is a whole-PROJECT setting, not really "this track's own" — but it
  // needs exactly one row to live in, and the first populated video track is the natural, always-
  // present home for it (see `CoverControl.tsx`'s own doc comment). No longer gated to desktop — a
  // direct request to make the Cover reachable on mobile too, which this same identity-tile slot
  // already does for free once the icon-only collapsed mode is gone.
  const isCoverTrack = useEditorStore(
    (s) => s.project?.sequence.tracks.find((tr) => tr.kind === "video" && tr.clips.length > 0)?.id === track.id
  );

  const isActive = activeTrackId === track.id;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  /** Top half of the row means "drop before me", bottom half means "drop after me" — the standard
   *  reorder-list convention, and simple arithmetic since rows are a uniform height. */
  function positionInRow(e: React.DragEvent): "before" | "after" {
    const rect = e.currentTarget.getBoundingClientRect();
    return e.clientY - rect.top < rect.height / 2 ? "before" : "after";
  }

  const { Icon: KindIcon, className: kindClassName } = KIND_ICON[track.kind];

    const isVisual = track.kind === "video" || track.kind === "text";
    const dragGroup = isVisual ? "visual" : "audio";

    return (
    <div
      style={{ height }}
      onClick={() => setActiveTrack(track.id)}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(`${TRACK_DRAG_MIME}-group-${dragGroup}`)) return;
        e.preventDefault();
        onDragOverRow(track.id, positionInRow(e));
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes(`${TRACK_DRAG_MIME}-group-${dragGroup}`)) return;
        e.preventDefault();
        const sourceId = e.dataTransfer.getData(TRACK_DRAG_MIME);
        if (sourceId && sourceId !== track.id) onDropRow(sourceId, track.id, positionInRow(e));
      }}
      className={`group relative flex shrink-0 cursor-pointer items-center gap-1.5 border-b border-r border-white/10 px-1.5 ${
        isActive ? "bg-white/[0.07]" : "bg-[#0d0f14] hover:bg-white/[0.04]"
      }`}
    >
      {/* A thin line on the edge the dragged track would land on — the same "before/after this row"
          model the drop position was computed from, made visible. */}
      {dropIndicator && (
        <div
          className={`pointer-events-none absolute inset-x-0 z-10 h-0.5 bg-sky-400 ${
            dropIndicator === "before" ? "top-0" : "bottom-0"
          }`}
        />
      )}

      <span
        draggable
        onDragStart={(e) => {
          e.stopPropagation();
          e.dataTransfer.setData(TRACK_DRAG_MIME, track.id);
          e.dataTransfer.setData(`${TRACK_DRAG_MIME}-group-${dragGroup}`, "");
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragEnd={onDragEndRow}
        onClick={(e) => e.stopPropagation()}
        title={t("Drag to reorder")}
        aria-label={t("Reorder {name}", { name: track.name })}
        className="shrink-0 cursor-grab select-none text-[10px] leading-none text-white/25 transition hover:text-white/60 active:cursor-grabbing"
      >
        ⋮⋮
      </span>

      {/* The row's one "identity tile" — either the real Cover thumbnail (see `CoverControl.tsx`) or
          a plain color-coded kind icon, both the SAME fixed size so neither ever looks like an
          afterthought next to the other. */}
      {track.kind === "video" && isCoverTrack ? (
        <div className="h-7 w-7 shrink-0" onClick={(e) => e.stopPropagation()}>
          <CoverControl />
        </div>
      ) : (
        <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-white/5 ${kindClassName}`}>
          <KindIcon size={14} />
        </div>
      )}

      {/* The active track is where a double-clicked library asset lands, so it needs to be
          visible at a glance rather than something the user has to remember. */}
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${isActive ? "bg-sky-400" : "bg-transparent"}`} />
      <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-white/80">{track.name}</span>

      {/* Everything else — Lock/Visibility/Mute/Solo/Import/Delete — lives in here now instead of
          permanently in the row; see `TrackActionsMenu`'s own doc comment for why. */}
      <button
        ref={menuButtonRef}
        onClick={(e) => {
          e.stopPropagation();
          setMenuOpen((o) => !o);
        }}
        title={t("Track options")}
        aria-label={t("Track options")}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        className="flex h-[26px] w-[22px] shrink-0 items-center justify-center rounded text-white/45 transition hover:bg-white/10 hover:text-white/80"
      >
        <Menu size={14} />
      </button>
      {menuOpen && <TrackActionsMenu track={track} anchorRef={menuButtonRef} onClose={() => setMenuOpen(false)} />}
    </div>
  );
}
