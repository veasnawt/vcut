"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { Close } from "@veasnawt/vicons";
import { ApplyGridLayoutCommand, StackCopiesCommand } from "../commands/index.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import { findAsset, findClip } from "../project/createProject.ts";
import { GRID_LAYOUTS, type GridLayout } from "../timeline/collage.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { NumberField } from "./NumberField.tsx";

type Tab = "grid" | "stack";

function LayoutThumb({ layout, active }: { layout: GridLayout; active: boolean }) {
  return (
    <span className="relative block h-12 w-9 overflow-hidden rounded-sm bg-black/40">
      {layout.cells.map((cell, i) => (
        <span
          key={i}
          className={`absolute rounded-[2px] ${active ? "bg-sky-400/80" : "bg-white/35"}`}
          style={{ left: `${cell.x * 100 + 2}%`, top: `${cell.y * 100 + 1.5}%`, width: `${cell.w * 100 - 4}%`, height: `${cell.h * 100 - 3}%` }}
        />
      ))}
    </span>
  );
}

/** Collage tools for the selected clips: arrange them into a grid layout (2×2, side by side, big + 2 …), or stack offset
 *  copies of one clip behind it (the echo / stacked-subject look). Both are one undoable step. A grid needs its clips to
 *  play at the same time on separate tracks; with "Fill empty cells with copies" a single clip becomes a whole grid. */
export function CollageDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslation();
  const project = useEditorStore((s) => s.project);
  const selectedClipIds = useEditorStore((s) => s.selectedClipIds);
  const run = useEditorStore((s) => s.run);
  const setStatus = useEditorStore((s) => s.setStatus);

  const pictureIds = project
    ? selectedClipIds.filter((id) => {
        const found = findClip(project, id);
        const asset = found ? findAsset(project, found.clip.assetId) : undefined;
        return asset?.kind === "video" || asset?.kind === "image" || asset?.kind === "color";
      })
    : [];

  const [tab, setTab] = useState<Tab>(pictureIds.length > 1 ? "grid" : "grid");
  const [layoutId, setLayoutId] = useState("grid-2x2");
  const [gap, setGap] = useState(8);
  const [fill, setFill] = useState(pictureIds.length === 1);
  const [count, setCount] = useState(3);
  const [offsetX, setOffsetX] = useState(60);
  const [offsetY, setOffsetY] = useState(-40);
  const [scaleStep, setScaleStep] = useState(10);
  const [fade, setFade] = useState(40);
  const [delay, setDelay] = useState(0);

  if (!project || typeof document === "undefined") return null;
  const layout = GRID_LAYOUTS.find((l) => l.id === layoutId) ?? GRID_LAYOUTS[0];

  function applyGrid() {
    const command = new ApplyGridLayoutCommand(pictureIds, layoutId, { gap, fillWithCopies: fill });
    run(command);
    if (command.placedClipIds.length > 0) {
      useEditorStore.setState({ selectedClipIds: command.placedClipIds });
      setStatus(t("Collage ready — {n} clips arranged", { n: command.placedClipIds.length }));
      onClose();
    }
  }

  function applyStack() {
    const command = new StackCopiesCommand(pictureIds[0], { count, offsetX, offsetY, scaleStep: scaleStep / 100, fade: fade / 100, delay });
    run(command);
    if (command.createdClipIds.length > 0) {
      useEditorStore.setState({ selectedClipIds: [pictureIds[0]] });
      setStatus(t("Added {n} stacked copies", { n: command.createdClipIds.length }));
      onClose();
    }
  }

  const tabButton = (id: Tab, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === id}
      onClick={() => setTab(id)}
      className={`flex-1 rounded-md py-2 text-[12px] font-medium transition ${tab === id ? "bg-sky-500/20 text-white" : "text-white/55 hover:bg-white/5 hover:text-white"}`}
    >
      {label}
    </button>
  );

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-3 sm:items-center" onClick={onClose} role="dialog" aria-modal="true" aria-label={t("Collage")}>
      <div onClick={(e) => e.stopPropagation()} className="flex max-h-[88vh] w-full max-w-md flex-col rounded-2xl border border-white/10 bg-[#14161c] shadow-2xl">
        <div className="flex items-center justify-between px-4 pt-4">
          <h2 className="text-[15px] font-semibold text-white">{t("Collage")}</h2>
          <button type="button" onClick={onClose} aria-label={t("Close")} className="flex h-8 w-8 items-center justify-center rounded-md text-white/60 transition hover:bg-white/10 hover:text-white">
            <Close size={16} />
          </button>
        </div>
        <div role="tablist" className="mx-4 mt-3 flex gap-1 rounded-lg bg-white/[0.04] p-1">
          {tabButton("grid", t("Grid"))}
          {tabButton("stack", t("Stacked copies"))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {pictureIds.length === 0 ? (
            <p className="py-6 text-center text-[12px] text-white/50">{t("Select a video or image clip first")}</p>
          ) : tab === "grid" ? (
            <>
              <p className="text-[11px] leading-relaxed text-white/45">
                {t("Fits your selected clips into the cells, in the order you selected them. Clips should be on different tracks and play at the same time.")}
              </p>
              <div className="mt-3 grid grid-cols-4 gap-2">
                {GRID_LAYOUTS.map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    onClick={() => setLayoutId(l.id)}
                    aria-pressed={layoutId === l.id}
                    className={`flex flex-col items-center gap-1 rounded-lg border p-2 transition ${layoutId === l.id ? "border-sky-400/40 bg-sky-500/10" : "border-white/10 hover:bg-white/5"}`}
                  >
                    <LayoutThumb layout={l} active={layoutId === l.id} />
                    <span className="text-[10px] text-white/60">{t(l.label)}</span>
                  </button>
                ))}
              </div>
              <div className="mt-3">
                <NumberField label={t("Gap")} value={gap} suffix="px" step={2} min={0} max={80} onCommit={setGap} />
              </div>
              <label className="mt-1 flex items-center justify-between gap-2 py-1.5 text-[12px] text-white/70">
                <span>{t("Fill empty cells with copies")}</span>
                <input type="checkbox" className="h-4 w-4 accent-sky-400" checked={fill} onChange={(e) => setFill(e.target.checked)} />
              </label>
              <p className="text-[11px] text-white/35">
                {t("{a} clips selected · {b} cells", { a: pictureIds.length, b: layout.cells.length })}
              </p>
            </>
          ) : (
            <>
              <p className="text-[11px] leading-relaxed text-white/45">
                {t("Puts copies of the first selected clip behind it, each one stepped, smaller and fainter — an outlined cutout gives outlined copies.")}
              </p>
              <div className="mt-2">
                <NumberField label={t("Copies")} value={count} step={1} min={1} max={8} onCommit={(v) => setCount(Math.round(v))} />
                <NumberField label={t("Move across")} value={offsetX} suffix="px" step={10} min={-600} max={600} onCommit={setOffsetX} />
                <NumberField label={t("Move down")} value={offsetY} suffix="px" step={10} min={-600} max={600} onCommit={setOffsetY} />
                <NumberField label={t("Shrink each")} value={scaleStep} suffix="%" step={2} min={0} max={50} onCommit={setScaleStep} />
                <NumberField label={t("Fade")} value={fade} suffix="%" step={5} min={0} max={100} onCommit={setFade} />
                <NumberField label={t("Start later by")} value={delay} suffix="s" step={0.1} min={0} max={5} onCommit={setDelay} />
              </div>
            </>
          )}
        </div>

        <div className="flex gap-2 border-t border-white/10 p-4">
          <button type="button" onClick={onClose} className="rounded-lg bg-white/5 px-4 py-2.5 text-[13px] text-white/70 transition hover:bg-white/10">
            {t("Cancel")}
          </button>
          <button
            type="button"
            disabled={pictureIds.length === 0}
            onClick={tab === "grid" ? applyGrid : applyStack}
            className="flex-1 rounded-lg bg-sky-500 py-2.5 text-[13px] font-semibold text-white transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-white/30"
          >
            {tab === "grid" ? t("Apply layout") : t("Add copies")}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
