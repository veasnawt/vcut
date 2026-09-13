"use client";

import React, { useMemo, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { Add, Art, Close, Image as ImageIcon, Music, Play, Text as TextIcon, Video } from "@veasnawt/vicons";
import { deleteLibraryMedia, HOSTED, previewAssetFromLibraryMedia, thumbnailUrl, type LibraryMediaItem } from "../api/client.ts";
import { AddClipCommand } from "../commands/index.ts";
import { translateText } from "../i18n/translations.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import { fontById } from "../project/fonts.ts";
import type { Asset } from "../project/types.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { formatDuration } from "../timeline/time.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { Dropdown } from "./Dropdown.tsx";
import { ImportSourceMenu } from "./ImportSourceMenu.tsx";
import { MediaPreviewModal } from "./MediaPreviewModal.tsx";
import { pickAssetForPlacement } from "./pickPlacement.ts";
import { addDragListeners, clientPoint, preventDefaultIfMouse } from "./pointerEvents.ts";
import { useLibraryMedia } from "./useLibraryMedia.ts";

/** Which asset kinds `MediaPreviewModal` actually has real media to show — text/color have no backing
 *  file at all (see `Asset.color`/`textContent`'s own doc comments), so a preview trigger for them
 *  would open a modal with nothing real to play. */
function isPreviewable(kind: Asset["kind"]): boolean {
  return kind === "video" || kind === "audio" || kind === "image";
}

/** True once, at module load — which platform this bundle is running on never changes mid-session, so
 *  there's no need to re-check it on every render the way `Capacitor.isNativePlatform()` calls
 *  elsewhere (`client.ts`, `ExportDialog.tsx`) already don't bother to either. */
const IS_NATIVE = Capacitor.isNativePlatform();

/** Converts one photo/video the OS picker handed back (a `webPath` blob-like URL, per
 *  `@capacitor/camera`'s own docs) into a plain `File` — the same shape `importFiles`/
 *  `nativeImportMedia` already accept from the "Files" path, so the whole rest of the import pipeline
 *  (format sniffing, probing, thumbnailing) needs no native-picker-specific branch at all. */
async function photoResultToFile(webPath: string, format: string | undefined, fallbackName: string): Promise<File> {
  const response = await fetch(webPath);
  const blob = await response.blob();
  const ext = format ? `.${format}` : "";
  const name = fallbackName.includes(".") ? fallbackName : `${fallbackName}${ext}`;
  return new File([blob], name, { type: blob.type });
}

/** Small kind badge shown on every tile in the mobile grid (see the grid's own comment) — the desktop
 *  list already has room for a text label (`describe()` below) to say "Audio"/"Image"/etc., but a
 *  compact grid tile doesn't, so a color-coded icon carries that same "what kind of thing is this" cue
 *  at a glance. Same color convention `TrackHeader.tsx` already uses for track kinds, extended with
 *  violet for images (which have no TRACK kind of their own — they live on video tracks — but very much
 *  need their own distinct color here, where video/image are two different asset kinds side by side). */
const KIND_BADGE: Record<Asset["kind"], { Icon: typeof Video; className: string }> = {
  video: { Icon: Video, className: "text-sky-300" },
  audio: { Icon: Music, className: "text-emerald-300" },
  image: { Icon: ImageIcon, className: "text-violet-300" },
  text: { Icon: TextIcon, className: "text-amber-300" },
  color: { Icon: Art, className: "text-rose-300" },
};

type SortKey = "name" | "duration" | "imported";

/** Matches `studios/vcut/app/api/vcut/_lib/mediaFormats.ts`'s own list exactly — that file is
 *  the real authority (it's what actually decides whether an uploaded file gets accepted), this is
 *  just what the OS file picker is told to show. Extensions, not MIME-wildcard patterns
 *  (`accept="audio/*"` etc.) — a wildcard's OS-level filter is built from the browser's own
 *  extension-to-MIME-type table, which is inconsistent across OS/browser combos for AUDIO
 *  specifically (`.m4a`/`.aac` in particular can end up silently excluded from "Custom Files" in the
 *  picker, even though the server would happily accept them if selected via "All Files"). Literal
 *  extensions are matched against the filename directly, with no MIME-database guessing involved. */
const ACCEPTED_EXTENSIONS =
  ".mp4,.mov,.webm,.mkv,.avi,.m4v,.wav,.mp3,.aac,.flac,.m4a,.ogg,.png,.jpg,.jpeg,.webp,.gif";

/** Pixels (mouse) the pointer must travel before a press becomes a drag — matches `TimelineClip`'s
 *  own threshold, so a shaky press doesn't register as an accidental drag. */
const DRAG_THRESHOLD = 4;
/** How long a touch has to stay still before it "picks up" an asset for dragging. Below this, a
 *  touch-drag is just scrolling the list — there's no Ctrl/Cmd-drag distinction touch can make the
 *  way a mouse can, so a deliberate hold is what signals "I mean to drag this," the same convention
 *  iOS's own Files/Photos apps use. Mouse skips this entirely (armed immediately, matching the native
 *  drag-and-drop this replaces) since a mouse-drag was never ambiguous with scrolling to begin with. */
const LONG_PRESS_MS = 450;

function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** The one-line technical summary under each asset — resolution and frame rate for video, a plain
 *  label otherwise. Frame rates are rounded for display because sources routinely report 29.97 as
 *  30000/1001, and "29.97 fps" in a library row is noise rather than information. */
function describe(asset: Asset): string {
  const language = useEditorStore.getState().language;
  if (asset.kind === "audio") return translateText(language, "Audio");
  if (asset.kind === "text") return translateText(language, "Text");
  const dimensions = asset.width && asset.height ? `${asset.width}×${asset.height}` : "";
  if (asset.kind === "image") return dimensions || translateText(language, "Image");
  const fps = asset.fps ? translateText(language, "{fps} fps", { fps: Math.round(asset.fps) }) : "";
  return [dimensions, fps].filter(Boolean).join(" · ") || translateText(language, "Video");
}

function AssetThumbnail({ asset, projectId }: { asset: Asset; projectId: string }) {
  const t = useTranslation();
  // A text asset has no file to generate a thumbnail from — its own content, in its own color, is a
  // more useful preview than a generic placeholder icon would be.
  if (asset.kind === "text") {
    return (
      <div
        className="flex h-full w-full items-center justify-center overflow-hidden bg-[#1a1a2e] p-1 text-center text-[10px] font-semibold leading-tight"
        style={{ color: asset.textStyle?.color ?? "#ffffff", fontFamily: `"${fontById(asset.textStyle?.fontFamily ?? "").cssFamily}"` }}
      >
        <span className="line-clamp-2 break-words">{asset.textContent || t("Text")}</span>
      </div>
    );
  }

  const url = thumbnailUrl(projectId, asset);
  if (!url) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-white/5 text-[10px] uppercase tracking-wide text-white/40">
        {t(asset.kind)}
      </div>
    );
  }
  return <img src={url} alt="" className="h-full w-full object-cover" draggable={false} />;
}

export function MediaLibrary({ onAssetAdded }: { onAssetAdded?: () => void } = {}) {
  const t = useTranslation();
  const projectId = useEditorStore((s) => s.projectId);
  const project = useEditorStore((s) => s.project);
  const importing = useEditorStore((s) => s.importing);
  const importFiles = useEditorStore((s) => s.importFiles);
  const removeAsset = useEditorStore((s) => s.removeAsset);
  const addAssetAtPlayhead = useEditorStore((s) => s.addAssetAtPlayhead);
  const addLibraryAssetToProject = useEditorStore((s) => s.addLibraryAssetToProject);
  const run = useEditorStore((s) => s.run);
  const setAssetDrag = useEditorStore((s) => s.setAssetDrag);

  const inputRef = useRef<HTMLInputElement>(null);
  const importButtonRef = useRef<HTMLButtonElement>(null);
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("imported");
  const [dragOver, setDragOver] = useState(false);
  const [showImportMenu, setShowImportMenu] = useState(false);
  const [previewAsset, setPreviewAsset] = useState<Asset | null>(null);

  // "All my media" — every import/generation/stock download across every one of the user's OTHER
  // projects too, not just this one (see `Asset.libraryMediaId`'s own doc comment). Hosted-only:
  // `HOSTED` gates the toggle itself below, so this branch simply never activates on desktop/local dev.
  const [isLibraryView, setIsLibraryView] = useState(false);
  const library = useLibraryMedia(isLibraryView);
  const [deleteConfirm, setDeleteConfirm] = useState<{ item: LibraryMediaItem; usedByProjects: { id: string; name: string }[] } | null>(
    null
  );

  // A failed fetch bounces the toggle back to "This project" rather than leaving the view stuck showing
  // a permanent error where the library grid would be.
  const libraryError = library.error;
  React.useEffect(() => {
    if (!libraryError) return;
    useEditorStore.getState().setStatus(libraryError, "error");
    setIsLibraryView(false);
  }, [libraryError]);

  const libraryAssets = useMemo(() => {
    const list = (library.items ?? []).filter((item) => item.name.toLowerCase().includes(query.trim().toLowerCase()));
    return list.sort((a, b) => {
      if (sortKey === "name") return a.name.localeCompare(b.name);
      if (sortKey === "duration") return b.duration - a.duration;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }, [library.items, query, sortKey]);

  /** `force`: the caller already showed `deleteConfirm`'s own warning and the user chose to proceed
   *  anyway — see `deleteLibraryMedia`'s own doc comment on why a non-forced "in use" outcome is a
   *  normal return value here, not a thrown error. */
  async function handleDeleteLibraryItem(item: LibraryMediaItem, force = false) {
    try {
      const result = await deleteLibraryMedia(item.id, force);
      if (!result.deleted) {
        setDeleteConfirm({ item, usedByProjects: result.usedByProjects });
        return;
      }
      setDeleteConfirm(null);
      library.removeLocally(item.id, item.sizeBytes);
      // If this item was ALSO already placed in the current project, `removeAsset` cleans up that local
      // reference too (and shows its own "Removed" status) — same guard against an in-use-on-the-
      // timeline clip it already applies for a plain "remove from project" action, reused here rather
      // than duplicated.
      const placedAsset = project?.assets.find((a) => a.libraryMediaId === item.id);
      if (placedAsset) {
        void removeAsset(placedAsset);
      } else {
        useEditorStore.getState().setStatus(translateText(useEditorStore.getState().language, "Deleted {name}", { name: item.name }));
      }
    } catch (err) {
      useEditorStore.getState().setStatus(err instanceof Error ? err.message : "Could not delete that media", "error");
    }
  }

  /** "Photos" side of the native Import menu — the OS's own photo/video library, via
   *  `@capacitor/camera`'s multi-picker. Historically an IMAGE-first API (its `pickImages` name is
   *  literal); videos come back best-effort where the OS picker itself allows mixed selection, so
   *  "Files" remains the fully-reliable path for video on any device where this falls short. Loaded
   *  dynamically so web/desktop bundles never pull in a Capacitor plugin they'll never call. */
  async function pickFromPhotos() {
    try {
      const { Camera } = await import("@capacitor/camera");
      const result = await Camera.pickImages({ quality: 90 });
      if (result.photos.length === 0) return;
      const files = await Promise.all(
        result.photos.map((photo, i) => photoResultToFile(photo.webPath!, photo.format, `photo-${Date.now()}-${i}`))
      );
      void importFiles(files);
    } catch (err) {
      // A cancelled picker rejects too (no distinct "user cancelled" result) — only surface it as an
      // error if it doesn't look like a plain dismissal.
      const message = err instanceof Error ? err.message : String(err);
      if (/cancel/i.test(message)) return;
      useEditorStore.getState().setStatus(message, "error");
    }
  }
  /** Local mirror of the in-progress drag, purely for this component's own floating label — the
   *  store's `assetDrag` (same values) is what `Timeline` reads to hit-test/highlight; this one just
   *  saves every OTHER subscriber of `assetDrag` from re-rendering on each pointer move. */
  const [dragGhost, setDragGhost] = useState<{ name: string; x: number; y: number } | null>(null);

  const assets = useMemo(() => {
    const list = (project?.assets ?? [])
      .filter((a) => !a.hiddenFromLibrary)
      // Text assets never belong here, unconditionally — unlike every other kind, one was never
      // IMPORTED media to begin with (`relPath` is always `""`, there's no file to preview/re-add),
      // it's authored directly on the timeline (the Text tool, Auto Captions, a duplicated text
      // clip) and stays a purely timeline-scoped thing from then on. A structural exclusion by `kind`,
      // not another `hiddenFromLibrary: true` at each creation site (`createTextAsset` et al.) —
      // that flag is for content that's INCIDENTALLY not library-worthy (a quick voiceover take);
      // "this is text" is a permanent fact about the asset itself, so it can't quietly regress if some
      // future text-creating path forgets to set the flag.
      .filter((a) => a.kind !== "text")
      .filter((a) => a.name.toLowerCase().includes(query.trim().toLowerCase()));
    return list.sort((a, b) => {
      if (sortKey === "name") return a.name.localeCompare(b.name);
      if (sortKey === "duration") return b.duration - a.duration;
      return b.importedAt - a.importedAt;
    });
  }, [project?.assets, query, sortKey]);

  /** Replaces native HTML5 drag-and-drop for BOTH mouse and touch — not touch-only — because the two
   *  can't coexist on the same element: `draggable`+`dragstart` and a parallel `onMouseDown`-driven
   *  drag would both react to the same mouse gesture, racing each other. Mouse arms immediately
   *  (matching how native drag-and-drop felt); touch requires a `LONG_PRESS_MS` hold first, so a
   *  normal touch-scroll of the list (the far more common gesture) is never mistaken for "pick this
   *  up" — see `LONG_PRESS_MS`'s own comment. Mirrors `TimelineClip.beginDrag`'s own
   *  press-then-`addDragListeners` shape, just tracking an asset id instead of a clip transform. */
  function beginAssetDrag(event: React.MouseEvent | React.TouchEvent, asset: Asset) {
    const isTouch = "touches" in event;
    const start = clientPoint(event);
    let moved = false;
    let armed = !isTouch;
    let longPressTimer: ReturnType<typeof setTimeout> | null = null;

    function arm(point: { x: number; y: number }) {
      armed = true;
      setDragGhost({ name: asset.name, x: point.x, y: point.y });
      setAssetDrag({ assetId: asset.id, clientX: point.x, clientY: point.y });
    }

    if (isTouch) {
      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        arm(start);
      }, LONG_PRESS_MS);
    } else {
      preventDefaultIfMouse(event);
    }

    function onMove(moveEvent: MouseEvent | TouchEvent) {
      const point = clientPoint(moveEvent);
      if (!armed) {
        // Real movement before the long-press fires means this is a normal list scroll, not a pickup
        // attempt — bail out entirely and let the browser's own native touch-scroll handle it (this
        // row is deliberately NOT `touch-none`, unlike an armed drag's target elsewhere).
        if (longPressTimer && Math.hypot(point.x - start.x, point.y - start.y) > DRAG_THRESHOLD) {
          clearTimeout(longPressTimer);
          longPressTimer = null;
          removeListeners();
        }
        return;
      }
      // Once armed, this IS the drag — stop the page from also scrolling underneath it (touch only;
      // `addDragListeners`' touchmove listener is `{ passive: false }`, so this is allowed here even
      // though it wouldn't be from a plain JSX onTouchMove prop).
      if ("touches" in moveEvent) moveEvent.preventDefault();
      moved = true;
      setDragGhost({ name: asset.name, x: point.x, y: point.y });
      setAssetDrag({ assetId: asset.id, clientX: point.x, clientY: point.y });
    }

    function onUp(upEvent: MouseEvent | TouchEvent) {
      removeListeners();
      if (longPressTimer) clearTimeout(longPressTimer);
      setDragGhost(null);
      setAssetDrag(null);
      if (!armed || !moved) return;
      const point = clientPoint(upEvent);
      const target = useEditorStore.getState().resolveTimelineDropTarget?.(point.x, point.y, asset.id);
      if (target) run(new AddClipCommand(target.trackId, asset.id, target.time));
    }

    const removeListeners = addDragListeners(onMove, onUp);
  }

  if (!projectId) return null;

  return (
    <section
      className="flex h-full min-h-0 flex-col border-r border-white/10 bg-[#0d0f14]"
      onDragOver={(e) => {
        // Only claim the drag if it actually carries files — otherwise dragging a clip around the
        // timeline would light up the library as a drop target.
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragOver(false);
        void importFiles([...e.dataTransfer.files]);
      }}
    >
      {/* Container-query grid: same "respond to THIS PANEL's own width, not the viewport's" reasoning
          `AiGeneratePanel.tsx`/`StockSearchPanel.tsx`'s own identical rule documents.
          `:has(li:nth-child(N))` gates each column-count bump on actually having enough items to fill
          it — confirmed a real, reported bug otherwise: a small library (the Import tile plus a
          handful of assets) split into 3 columns with CSS multi-column's native `balance` algorithm
          can land two short items (a color-matte "clip" has no thumbnail, just a compact text row)
          together in one column while tall photo/video tiles fill the other two, leaving that whole
          column looking mostly empty below its own short content — `balance` only tries to equalize
          TOTAL HEIGHT per column, not account for a column ending up visually shorter because its few
          items just happen to be short ones. The thresholds below (5 for 2 columns, 9 for 3) are
          deliberately generous, not just "one more than the column count" — 6 items into 3 columns
          (2 each) turned out to still reproduce the exact same imbalance, confirmed live, since two
          same-kind short items can easily land together even at that ratio. More items per column
          gives the balance algorithm more room to actually average out a height difference instead of
          concentrating it. */}
      <style>{`
        .vcut-media-grid-container {
          container-type: inline-size;
        }
        .vcut-media-grid {
          columns: 1;
        }
        @container (min-width: 220px) {
          .vcut-media-grid:has(li:nth-child(5)) {
            columns: 2;
          }
        }
        @container (min-width: 420px) {
          .vcut-media-grid:has(li:nth-child(9)) {
            columns: 3;
          }
        }
      `}</style>

      {/* Hosted-only: local/desktop dev has no per-user "account" for a cross-project library to
          belong to at all — every asset stays project-local there exactly as before this existed, so
          this row (and the toggle it exists to offer) would have nothing real to switch to. */}
      {HOSTED && (
        <div className="flex items-center gap-1 border-b border-white/10 px-3 py-1.5">
          <button
            onClick={() => setIsLibraryView(false)}
            className={`rounded px-2 py-1 text-[11px] font-medium transition ${!isLibraryView ? "bg-white/15 text-white" : "text-white/50 hover:text-white/80"}`}
          >
            {t("This project")}
          </button>
          <button
            onClick={() => setIsLibraryView(true)}
            className={`rounded px-2 py-1 text-[11px] font-medium transition ${isLibraryView ? "bg-white/15 text-white" : "text-white/50 hover:text-white/80"}`}
          >
            {t("All my media")}
          </button>
          {isLibraryView && library.items !== null && (
            <span className="ml-auto shrink-0 text-[10px] tabular-nums text-white/40">
              {t("{used} / {cap}", { used: formatSize(library.usedBytes), cap: formatSize(library.capBytes) })}
            </span>
          )}
        </div>
      )}

      {/* No title header of its own — same "the tab strip already names it" reasoning
          `StockSearchPanel.tsx`/`AiGeneratePanel.tsx` both document, and previously the one thing that
          made this panel different from its two siblings: back when the tab strip said "My Media", a
          second "Media" heading directly under it read as a distinct, useful label; once the tab itself
          was shortened to "Media" (`MediaPanel.tsx`), this became the exact same word repeated twice in
          a row with nothing to justify keeping it. Import used to share this row as its own labeled
          button — now the FIRST tile in the list below instead (see its own comment), so this row is
          just search + sort. */}
      <div className="flex gap-2 border-b border-white/10 px-3 py-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("Search")}
          // 16px below `lg`, not the desktop 12px (`text-xs`) — iOS Safari auto-zooms the whole page
          // on focusing any text input under 16px, which on a phone means tapping Search yanks the
          // viewport in every time. text-xs only kicks in at `lg`, where that browser behavior doesn't
          // apply anyway.
          className="min-w-0 flex-1 rounded-md bg-white/5 px-2 py-1 text-[16px] text-white placeholder:text-white/30 focus:outline-none focus:ring-1 focus:ring-sky-400/60 lg:text-xs"
        />
        <Dropdown
          value={sortKey}
          onChange={(v) => setSortKey(v)}
          ariaLabel={t("Sort media")}
          className="w-20 shrink-0 text-xs"
          options={[
            { value: "imported", label: t("Recent") },
            { value: "name", label: t("Name") },
            { value: "duration", label: t("Length") },
          ]}
        />
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPTED_EXTENSIONS}
          className="hidden"
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            // Cleared so re-picking the same file still fires a change event.
            e.target.value = "";
            void importFiles(files);
          }}
        />
      </div>

      <div className={`scrollbar-thin min-h-0 flex-1 overflow-y-auto p-2 ${dragOver ? "bg-sky-500/10 outline outline-2 -outline-offset-2 outline-dashed outline-sky-400/60" : ""}`}>
        {/* Masonry columns on mobile (title/description overlaid ON the thumbnail, natural aspect
            ratio per asset), the existing single-column list back at `lg`+ (small fixed 44×64
            thumbnail, name/description beside it) — a compact row was hard to tell apart at a glance
            on a phone and left a lot of the touch target as bare text; letting each tile take its own
            natural aspect ratio (instead of a fixed 16:9 crop) and packing them into columns is what
            actually uses the room a phone screen has, matching how every mobile photo/video picker
            presents a library. Desktop's list stays exactly as it was — that column is narrow enough
            that a multi-column grid there would make the thumbnails smaller, not bigger.
            //
            `vcut-media-grid-container`/`vcut-media-grid` (defined once, at the end of this file, for
            the same reason `AiGeneratePanel.tsx`'s identical rule documents): a container query, not a
            viewport media query, so the column count responds to how much room THIS PANEL actually
            has rather than the browser window — `lg:flex lg:flex-col lg:gap-1` below still wins at the
            real desktop breakpoint regardless (switching to `display: flex` makes the `columns`
            property moot, so the two rules never fight over the same element).
            //
            The list ALWAYS renders now, even with zero real assets — the Import tile below is its own
            first item, not a separate button that used to live in the header row above, so there has
            to be a list for it to be the first item OF. */}
        {!isLibraryView && (
        <div className="vcut-media-grid-container lg:contents">
          <ul className="vcut-media-grid gap-2 lg:flex lg:flex-col lg:gap-1">
            {/* Import, as a tile matching every OTHER item's own shape instead of a separate labeled
                button in the header row above — asked for directly: it reads as "one more thing in
                this list" the same way a photo library's own "+" tile does, rather than a competing
                control fighting Search/Sort for room in an already-tight header, especially on mobile.
                A plain `<button>` (not `role="button"` on a `<div>` like the asset tiles below) since
                this one has no separate drag/preview/remove sub-controls to coexist with — the whole
                tile is one single action, so a real button covers it with no extra ARIA needed. */}
            <li className="mb-2 break-inside-avoid lg:mb-0">
              <div className="relative">
                <button
                  ref={importButtonRef}
                  // Native platforms get a choice (Photos vs Files) since there's a real device photo/
                  // video library to offer alongside the file browser; web/desktop only ever had
                  // "Files" to begin with, so the button there keeps going straight to the file input,
                  // unchanged.
                  onClick={() => (IS_NATIVE ? setShowImportMenu((v) => !v) : inputRef.current?.click())}
                  disabled={importing}
                  title={t("Import video, audio, or images")}
                  className="group flex w-full flex-col rounded-lg text-left transition hover:bg-white/10 focus:bg-white/10 focus:outline-none disabled:cursor-default disabled:opacity-50 lg:flex-row lg:items-center lg:gap-2.5 lg:p-1.5"
                >
                  {/* Square (1:1), not matched to any real asset's own ratio the way the tiles below
                      are — there's no real media behind this one to derive a shape from, and a plain
                      square reads clearly as "a slot to fill" among the varied shapes surrounding it.
                      Icon and label stacked together as ONE centered group (not the icon centered with
                      the label pinned to the bottom edge separately, tried first) — asked for directly:
                      the two read as a single "add" glyph this way, the way an icon-plus-caption button
                      normally does, rather than looking like two unrelated pieces of content sharing a
                      box. */}
                  <div
                    className="flex w-full shrink-0 flex-col items-center justify-center gap-1 overflow-hidden rounded-lg border border-dashed border-white/25 bg-white/5 p-1 transition group-hover:border-sky-400/50 group-hover:bg-white/10 lg:h-11 lg:w-16 lg:rounded"
                    style={{ aspectRatio: "1 / 1" }}
                  >
                    <Add size={22} className="text-white/50 transition group-hover:text-white/80" />
                    <p className="truncate text-center text-[11px] font-medium text-white/70 transition group-hover:text-white/90 lg:hidden">
                      {importing ? t("Importing…") : t("Import")}
                    </p>
                  </div>
                  <div className="hidden min-w-0 lg:block lg:flex-1">
                    <p className="truncate text-xs font-medium text-white/90">{importing ? t("Importing…") : t("Import")}</p>
                    <p className="truncate text-[11px] text-white/45">{t("Video, audio, or image")}</p>
                  </div>
                </button>
                {showImportMenu && (
                  <ImportSourceMenu
                    anchorRef={importButtonRef}
                    onClose={() => setShowImportMenu(false)}
                    onPickPhotos={() => void pickFromPhotos()}
                    onPickFiles={() => inputRef.current?.click()}
                  />
                )}
              </div>
            </li>

            {assets.map((asset) => (
                <li key={asset.id} className="mb-2 break-inside-avoid lg:mb-0">
                  <div
                    role="button"
                    tabIndex={0}
                    onMouseDown={(e) => beginAssetDrag(e, asset)}
                    onTouchStart={(e) => beginAssetDrag(e, asset)}
                    onDoubleClick={() => addAssetAtPlayhead(asset.id)}
                    // Only wired when `onAssetAdded` is passed — i.e. only in the mobile bottom-sheet
                    // usage (see VCutApp.tsx), where a plain tap is the ONLY practical way to place a
                    // clip (the sheet replaces the Timeline entirely while open, so there's nothing to
                    // drag onto, and touch has no double-tap equivalent to `onDoubleClick` above). Left
                    // unwired for the desktop persistent column, where a bare click choosing to do
                    // nothing (only double-click/drag add) is the established, unchanged behavior.
                    // `pickAssetForPlacement` (see its own doc comment) decides immediate-at-playhead
                    // vs. arm-for-later depending on whether the target track already has clips.
                    onClick={onAssetAdded ? () => pickAssetForPlacement(asset.id, onAssetAdded) : undefined}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") addAssetAtPlayhead(asset.id);
                    }}
                    title={`${asset.name}\n${formatSize(asset.sizeBytes)}\n${t("Double-click to add at the playhead, or drag onto the timeline (press and hold, then drag, on touch)")}`}
                    className="group flex w-full cursor-grab flex-col rounded-lg text-left transition hover:bg-white/10 focus:bg-white/10 focus:outline-none active:cursor-grabbing lg:flex-row lg:items-center lg:gap-2.5 lg:p-1.5"
                  >
                    {/* Natural aspect ratio below `lg` (falls back to 16:9 for audio/anything with no
                        known dimensions) instead of a fixed crop — matches the varied-height masonry
                        look `AiGeneratePanel.tsx`/`StockSearchPanel.tsx` both already use, and is what
                        makes packing into columns worthwhile at all (every tile the same shape would
                        just be a grid with extra steps). `lg:h-11 lg:w-16` still wins at the real
                        desktop breakpoint — an explicit height AND width leaves `aspect-ratio` nothing
                        left to compute, so the two never fight over the same box. No `max-h-*` cap below
                        `lg` (there used to be one) — same "9:16 is VCut's common case, not an outlier
                        worth clipping" reasoning `AiGeneratePanel.tsx`/`StockSearchPanel.tsx`'s own
                        identical fix documents; `max-height` overriding `aspect-ratio` was silently
                        re-cropping most portrait assets in this exact grid. */}
                    <div
                      className="relative w-full shrink-0 overflow-hidden bg-black lg:h-11 lg:w-16 lg:rounded"
                      style={{ aspectRatio: asset.width && asset.height ? `${asset.width} / ${asset.height}` : "16 / 9" }}
                    >
                      <AssetThumbnail asset={asset} projectId={projectId} />
                      {/* A thumbnail (one static frame, or a short filmstrip strip) is enough to
                          RECOGNIZE a clip already known, but not enough to hear an audio file or tell
                          two similarly-thumbnailed takes apart — this opens the real thing
                          (`MediaPreviewModal`) without placing it on the timeline first. A small centered
                          button, NOT `inset-0` over the whole thumbnail — the thumbnail is also the
                          drag-to-timeline surface (`onMouseDown`/`onTouchStart` on the card above), and
                          covering all of it would swallow that gesture the instant it starts from
                          anywhere over the picture. Small and off to one side of that surface instead,
                          the same "a nested interactive element coexists fine inside a draggable card"
                          precedent the corner remove button already relies on. Always visible (not
                          hover-only): a genuinely new capability nothing on screen hinted at before now
                          needs to be discoverable, on touch as much as with a mouse. */}
                      {isPreviewable(asset.kind) && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setPreviewAsset(asset);
                          }}
                          title={t("Preview {name}", { name: asset.name })}
                          aria-label={t("Preview {name}", { name: asset.name })}
                          className="absolute left-1/2 top-1/2 flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/60 text-white/80 transition hover:bg-black/80 hover:text-white"
                        >
                          <Play size={12} />
                        </button>
                      )}
                      {/* Kind badge — mobile-grid only. Desktop's thumbnail is too small (44×64) for this
                          to read cleanly there, and its row already spells the kind out via `describe()`
                          next to the name; the grid has no equivalent text label at a glance, so the icon
                          carries that job instead. */}
                      <span className="absolute left-1 top-1 flex h-5 w-5 items-center justify-center rounded bg-black/70 lg:hidden">
                        {(() => {
                          const { Icon, className } = KIND_BADGE[asset.kind];
                          return <Icon size={12} className={className} />;
                        })()}
                      </span>
                      {asset.kind !== "image" && asset.kind !== "text" && (
                        <span className="absolute right-1 top-1 rounded bg-black/75 px-1 text-[10px] tabular-nums text-white/90 lg:bottom-0 lg:right-0 lg:top-auto lg:rounded-none">
                          {formatDuration(asset.duration)}
                        </span>
                      )}
                      {/* Mobile-grid remove button — overlaid on the thumbnail (top-right) since a grid
                          tile has no separate inline slot for it the way the desktop row does. Always
                          visible (not hover-revealed) for the same reason the desktop button already
                          makes an exception below `lg`: touch has no `:hover` to reveal it from. Moved
                          in from the corner slightly (`top-8`, under the duration/kind badges) rather
                          than sharing their exact corner now that this tile can be much taller than the
                          old fixed 80px cap — pinning it to the very top edge regardless of tile height
                          kept it readable, but a genuinely tall tile made it feel disconnected from the
                          title it's actually removing, which now lives at the BOTTOM. */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          void removeAsset(asset);
                        }}
                        title={t("Remove from project")}
                        aria-label={t("Remove {name} from project", { name: asset.name })}
                        className="absolute right-1 top-8 flex items-center rounded bg-black/70 p-1 text-white/70 transition hover:bg-black/90 hover:text-white lg:hidden"
                      >
                        <Close size={12} />
                      </button>
                      {/* Title + description overlaid directly on the thumbnail (a bottom gradient
                          scrim), matching `StockSearchPanel.tsx`'s identical treatment — mobile-grid
                          only; the desktop row still shows these as plain text BESIDE its own small
                          fixed thumbnail, where overlaying them would leave no legible room at all. */}
                      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/40 to-transparent px-1.5 pb-1 pt-4 lg:hidden">
                        <p className="truncate text-[11px] font-medium text-white/95">{asset.name}</p>
                        <p className="truncate text-[10px] text-white/70">{describe(asset)}</p>
                        {asset.offline && <p className="text-[10px] font-medium text-amber-400">{t("Media Offline")}</p>}
                      </div>
                    </div>
                    <div className="hidden min-w-0 lg:block lg:flex-1">
                      <p className="truncate text-xs font-medium text-white/90">{asset.name}</p>
                      <p className="truncate text-[11px] text-white/45">{describe(asset)}</p>
                      {asset.offline && <p className="text-[11px] font-medium text-amber-400">{t("Media Offline")}</p>}
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        void removeAsset(asset);
                      }}
                      title={t("Remove from project")}
                      aria-label={t("Remove {name} from project", { name: asset.name })}
                      // Desktop-row-only (see the mobile-grid overlay button above) — hover-reveal only
                      // makes sense where a mouse actually exists.
                      className="hidden shrink-0 items-center rounded px-1.5 py-1 text-white/30 transition hover:bg-white/10 hover:text-white/80 lg:flex lg:opacity-0 lg:focus:opacity-100 lg:group-hover:opacity-100"
                    >
                      <Close size={12} />
                    </button>
                  </div>
                </li>
              ))}
          </ul>

          {/* Checked against VISIBLE assets (query aside), not `project.assets.length` directly —
              otherwise a project holding only hidden voiceover takes or text clips (see the `assets`
              memo's own filter above) would misreport "Nothing matches that search" with no search
              query even active. Sits BELOW the list (the Import tile is still there, always) rather
              than replacing it the way this used to — there's now always at least one real item (the
              Import tile itself) to show regardless of how many real assets exist. */}
          {assets.length === 0 && (
            <p className="px-2 py-4 text-center text-xs leading-relaxed text-white/40">
              {project?.assets.some((a) => !a.hiddenFromLibrary && a.kind !== "text")
                ? t("Nothing matches that search.")
                : t("Drop video, audio, or images here, or tap + to import.")}
            </p>
          )}
        </div>
        )}

        {isLibraryView && (
          <ul className="flex flex-col gap-1">
            {library.loading && library.items === null && (
              <li className="px-2 py-4 text-center text-xs text-white/40">{t("Loading your media…")}</li>
            )}
            {library.items !== null && libraryAssets.length === 0 && (
              <li className="px-2 py-4 text-center text-xs leading-relaxed text-white/40">
                {library.items.length === 0
                  ? t("Nothing in your library yet — import, generate, or download stock media to build it up.")
                  : t("Nothing matches that search.")}
              </li>
            )}
            {libraryAssets.map((item) => {
              const pseudoAsset = previewAssetFromLibraryMedia(item);
              const inProject = project?.assets.some((a) => a.libraryMediaId === item.id) ?? false;
              return (
                <li key={item.id} className="flex items-center gap-2.5 rounded-lg p-1.5 hover:bg-white/5">
                  <div
                    className="relative h-11 w-16 shrink-0 overflow-hidden rounded bg-black"
                    style={{ aspectRatio: item.width && item.height ? `${item.width} / ${item.height}` : "16 / 9" }}
                  >
                    <AssetThumbnail asset={pseudoAsset} projectId={projectId} />
                    {isPreviewable(item.kind) && (
                      <button
                        onClick={() => setPreviewAsset(pseudoAsset)}
                        title={t("Preview {name}", { name: item.name })}
                        aria-label={t("Preview {name}", { name: item.name })}
                        className="absolute left-1/2 top-1/2 flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/60 text-white/80 transition hover:bg-black/80 hover:text-white"
                      >
                        <Play size={12} />
                      </button>
                    )}
                    {item.kind !== "image" && (
                      <span className="absolute bottom-0 right-0 rounded-tl bg-black/75 px-1 text-[10px] tabular-nums text-white/90">
                        {formatDuration(item.duration)}
                      </span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-white/90">{item.name}</p>
                    <p className="truncate text-[11px] text-white/45">{formatSize(item.sizeBytes)}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {inProject ? (
                      <span className="px-2 py-1 text-[11px] font-medium text-emerald-300">{t("In this project")}</span>
                    ) : (
                      <button
                        onClick={() => addLibraryAssetToProject(item)}
                        className="rounded bg-sky-500/20 px-2 py-1 text-[11px] font-medium text-sky-300 transition hover:bg-sky-500/30"
                      >
                        {t("Add")}
                      </button>
                    )}
                    <button
                      onClick={() => void handleDeleteLibraryItem(item)}
                      title={t("Delete from library")}
                      aria-label={t("Delete {name} from your library", { name: item.name })}
                      className="rounded p-1 text-white/30 transition hover:bg-white/10 hover:text-rose-300"
                    >
                      <Close size={12} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Follows the pointer during an in-progress asset drag — the visual feedback native drag-and-
          drop gave mouse users for free (its own OS-drawn drag image), which a pointer-based drag has
          to draw itself. `position: fixed` so it's never clipped by this panel's own `overflow-y-auto`
          and can visually cross into the Timeline while dragging. */}
      {dragGhost && (
        <div
          aria-hidden
          className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-1/2 rounded-md border border-sky-300/50 bg-sky-500/90 px-2.5 py-1 text-xs font-medium text-white shadow-lg"
          style={{ left: dragGhost.x, top: dragGhost.y }}
        >
          {dragGhost.name}
        </div>
      )}
      {previewAsset && projectId && (
        <MediaPreviewModal asset={previewAsset} projectId={projectId} onClose={() => setPreviewAsset(null)} />
      )}
      {deleteConfirm && (
        <ConfirmDialog
          title={t("Delete from your library?")}
          message={t("\"{name}\" is still used in {n} other project(s): {projects}. Deleting it removes it from those projects too.", {
            name: deleteConfirm.item.name,
            n: deleteConfirm.usedByProjects.length,
            projects: deleteConfirm.usedByProjects.map((p) => p.name).join(", "),
          })}
          confirmLabel={t("Delete anyway")}
          onConfirm={() => void handleDeleteLibraryItem(deleteConfirm.item, true)}
          onCancel={() => setDeleteConfirm(null)}
        />
      )}
    </section>
  );
}
