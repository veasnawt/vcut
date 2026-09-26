"use client";

import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Store } from "@veasnawt/vicons";
import { MoveTemplateGroupCommand } from "../commands/index.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { snapToFrame } from "../timeline/time.ts";

/** What a track that's part of one "Insert into Timeline" (`Track.templateGroup`) renders as instead of
 *  its own row — a real, direct request: even with every one of those tracks visually tagged (a colored
 *  stripe, a badge), a template that spans several video/text/audio tracks still read as "a pile of
 *  separate tracks" once actually inserted, since it was still N full rows to scroll past either way. A
 *  template is meant to be used as ONE thing; `Timeline.tsx` now renders every track sharing one
 *  `templateGroup.id` as exactly ONE header row (this) plus one lane bar (`TemplateGroupLaneBar` below)
 *  spanning the group's own overall time range, regardless of how many real tracks/clips sit underneath.
 *  The underlying data is untouched (still real, separate tracks and clips — see `InsertTemplateCommand`'s
 *  own doc comment); only how they're PRESENTED collapses to one row. There is deliberately no "expand
 *  to see the individual tracks" mode: once inserted, a template's own contents are only ever reached
 *  through `TemplateGroupPanel.tsx` (via the lane bar's own "Edit template" button below), the same
 *  "content editable, structure locked" boundary a template-origin project's own guided screens already
 *  draw — direct per-track manipulation was never the point of treating this as one thing. */
export function TemplateGroupRowHeader({ name, trackCount, height }: { name: string; trackCount: number; height: number }) {
  const t = useTranslation();
  return (
    <div
      style={{ height }}
      title={t("{n} tracks from this template", { n: trackCount })}
      className="flex shrink-0 items-center gap-1.5 border-b border-r border-white/10 bg-[#0d0f14] px-1.5"
    >
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-sky-400/10 text-sky-300">
        <Store size={14} />
      </div>
      <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-white/80">{name}</span>
    </div>
  );
}

/** The single lane bar standing in for every clip across the group's own tracks — spans from the
 *  earliest clip's start to the latest clip's end (`startSeconds`/`endSeconds`, computed by
 *  `Timeline.tsx` from the group's real clips), so its own length still reads as roughly how much
 *  timeline the template actually occupies even though no individual clip boundary is drawn. The "Edit
 *  template" pill is the ONLY way into the group's own contents (opens `TemplateGroupPanel.tsx`) — there
 *  is no drag-to-RESIZE here (see `MoveTemplateGroupCommand`'s own doc comment on why trimming a
 *  multi-track group has no clean meaning the way trimming one clip does), but the whole bar drags
 *  earlier/later as one unit, same as any other clip on the timeline — a real, direct request: a
 *  template that can't even be repositioned reads as a second-class citizen next to every other clip
 *  that can. */
export function TemplateGroupLaneBar({
  groupId,
  name,
  startSeconds,
  endSeconds,
  pixelsPerSecond,
  fps,
  onEdit,
}: {
  groupId: string;
  name: string;
  startSeconds: number;
  endSeconds: number;
  pixelsPerSecond: number;
  fps: number;
  onEdit: () => void;
}) {
  const t = useTranslation();
  const run = useEditorStore((s) => s.run);
  // Live, LOCAL-only offset while a drag is in flight — nothing is committed to the (undo-tracked)
  // project until release, the same "preview locally, commit once on pointerup" shape every other
  // timeline drag in this app already follows (see `TransitionJunction.tsx`'s own duration drag).
  const [dragOffsetSeconds, setDragOffsetSeconds] = useState(0);
  const drag = useRef<{ pointerId: number; startClientX: number } | null>(null);

  const left = (startSeconds + dragOffsetSeconds) * pixelsPerSecond;
  const width = Math.max(4, (endSeconds - startSeconds) * pixelsPerSecond);

  function finishDrag(e: ReactPointerEvent<HTMLDivElement>, commit: boolean) {
    const current = drag.current;
    if (!current || current.pointerId !== e.pointerId) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (commit && dragOffsetSeconds !== 0) run(new MoveTemplateGroupCommand(groupId, snapToFrame(dragOffsetSeconds, fps)));
    setDragOffsetSeconds(0);
  }

  return (
    <div
      style={{ left, width }}
      className="absolute inset-y-1 flex touch-none select-none items-center gap-2 overflow-hidden rounded-md border border-sky-400/40 bg-sky-500/[0.12] px-2 active:cursor-grabbing"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        drag.current = { pointerId: e.pointerId, startClientX: e.clientX };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const current = drag.current;
        if (!current || current.pointerId !== e.pointerId) return;
        setDragOffsetSeconds((e.clientX - current.startClientX) / pixelsPerSecond);
      }}
      onPointerUp={(e) => finishDrag(e, true)}
      onPointerCancel={(e) => finishDrag(e, false)}
      onLostPointerCapture={(e) => finishDrag(e, false)}
    >
      <span className="pointer-events-none flex shrink-0 cursor-grab items-center gap-1 rounded-full bg-sky-400/20 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-sky-200">
        <Store size={9} />
        {t("Template")}
      </span>
      <span className="pointer-events-none min-w-0 flex-1 cursor-grab truncate text-[11px] font-medium text-sky-100/90">{name}</span>
      <button
        type="button"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onEdit();
        }}
        className="shrink-0 rounded-md bg-white/10 px-2 py-1 text-[10px] font-semibold text-white/85 transition hover:bg-white/20"
      >
        {t("Edit template")}
      </button>
    </div>
  );
}
