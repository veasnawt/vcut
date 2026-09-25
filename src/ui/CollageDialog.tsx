"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { Close } from "@veasnawt/vicons";
import { ApplyGridLayoutCommand, StackCopiesCommand } from "../commands/index.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import { findAsset, findClip } from "../project/createProject.ts";
import { thumbnailUrl } from "../api/client.ts";
import { GRID_LAYOUTS, type CellSource, type GridLayout } from "../timeline/collage.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { NumberField } from "./NumberField.tsx";

type Tab = "grid" | "stack";

/** A layout drawn in the shape of the project's own frame (portrait, square or landscape), so what you pick is what you get. */
function LayoutThumb({ layout, active, aspect }: { layout: GridLayout; active: boolean; aspect: number }) {
  const height = aspect > 1.2 ? 34 : 48;
  const width = Math.round(Math.min(72, Math.max(30, height * aspect)));
  return (
    <span className="relative block overflow-hidden rounded-sm bg-black/40" style={{ width, height }}>
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
  const projectId = useEditorStore((s) => s.projectId);

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
  // Which clip (or media to add) goes in each cell, in cell order. "" is an empty cell.
  const [plan, setPlan] = useState<CellSource[]>(pictureIds);
  // Clips that don't already overlap in time need to be moved to start together to show in one grid.
  const [playTogether, setPlayTogether] = useState(() => {
    if (!project || pictureIds.length < 2) return false;
    const spans = pictureIds.flatMap((id) => {
      const found = findClip(project, id);
      return found ? [{ start: found.clip.timelineStart, end: found.clip.timelineStart + (found.clip.sourceOut - found.clip.sourceIn) }] : [];
    });
    const latestStart = Math.max(...spans.map((x) => x.start));
    const earliestEnd = Math.min(...spans.map((x) => x.end));
    return latestStart >= earliestEnd - 1e-6;
  });
  const [pickingCell, setPickingCell] = useState<number | null>(null);
  const [count, setCount] = useState(3);
  const [offsetX, setOffsetX] = useState(60);
  const [offsetY, setOffsetY] = useState(-40);
  const [scaleStep, setScaleStep] = useState(10);
  const [fade, setFade] = useState(40);
  const [delay, setDelay] = useState(0);

  // One-tap starting points for Stacked copies (frame-relative, so they suit any aspect ratio).
  const STACK_PRESETS = [
    { name: "Echo", count: 4, x: 0.04, y: -0.02, shrink: 8, fade: 50, delay: 0 },
    { name: "Trail", count: 6, x: 0.07, y: 0, shrink: 4, fade: 70, delay: 0.1 },
    { name: "Fan", count: 5, x: 0.05, y: -0.05, shrink: 10, fade: 30, delay: 0 },
  ];

  if (!project || typeof document === "undefined") return null;
  const layout = GRID_LAYOUTS.find((l) => l.id === layoutId) ?? GRID_LAYOUTS[0];
  const aspect = project.sequence.width / Math.max(1, project.sequence.height);

  function applyGrid() {
    const command = new ApplyGridLayoutCommand(plan.slice(0, layout.cells.length), layoutId, { gap, fillWithCopies: fill, playTogether });
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
          {pictureIds.length === 0 && tab === "stack" ? (
            <p className="py-6 text-center text-[12px] text-white/50">{t("Select a video or image clip first")}</p>
          ) : tab === "grid" ? (
            <>
              <p className="text-[11px] leading-relaxed text-white/45">
                {t("Pick a layout, then choose which clip goes in each cell. Empty cells can take media from your project.")}
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
                    <LayoutThumb layout={l} active={layoutId === l.id} aspect={aspect} />
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
              <label className="flex items-center justify-between gap-2 py-1.5 text-[12px] text-white/70">
                <span className="min-w-0">
                  {t("Play all at the same time")}
                  <span className="block text-[11px] text-white/35">{t("Moves the clips to start together, each on its own track.")}</span>
                </span>
                <input type="checkbox" className="h-4 w-4 shrink-0 accent-sky-400" checked={playTogether} onChange={(e) => setPlayTogether(e.target.checked)} />
              </label>

              <p className="mt-3 text-[11px] font-medium uppercase tracking-wide text-white/40">{t("Cells")}</p>
              <ul className="mt-1.5 space-y-1.5">
                {layout.cells.map((_, index) => {
                  const entry = plan[index];
                  const clip = typeof entry === "string" && entry ? findClip(project, entry)?.clip : undefined;
                  const asset = clip
                    ? findAsset(project, clip.assetId)
                    : entry && typeof entry !== "string"
                      ? findAsset(project, entry.assetId)
                      : undefined;
                  const thumb = asset && projectId ? thumbnailUrl(projectId, asset) : null;
                  const move = (delta: number) => {
                    const next = [...plan];
                    while (next.length < layout.cells.length) next.push("");
                    const target = index + delta;
                    if (target < 0 || target >= layout.cells.length) return;
                    [next[index], next[target]] = [next[target], next[index]];
                    setPlan(next);
                  };
                  return (
                    <li key={index}>
                      <div className="flex items-center gap-2 rounded-lg bg-white/[0.04] px-2 py-1.5">
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/10 text-[10px] font-semibold text-white/70">{index + 1}</span>
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded bg-black/40">
                          {thumb ? <img src={thumb} alt="" className="h-full w-full object-cover" /> : asset?.kind === "color" ? <span className="h-full w-full" style={{ backgroundColor: asset.color }} /> : null}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[12px] text-white/75">
                          {asset ? asset.name : <span className="text-white/35">{fill && pictureIds.length > 0 ? t("A copy of another clip") : t("Empty")}</span>}
                        </span>
                        {asset ? (
                          <>
                            <button type="button" aria-label={t("Move up")} onClick={() => move(-1)} disabled={index === 0} className="rounded px-1.5 py-1 text-[12px] text-white/50 hover:bg-white/10 hover:text-white disabled:opacity-25">↑</button>
                            <button type="button" aria-label={t("Move down")} onClick={() => move(1)} disabled={index === layout.cells.length - 1} className="rounded px-1.5 py-1 text-[12px] text-white/50 hover:bg-white/10 hover:text-white disabled:opacity-25">↓</button>
                            <button
                              type="button"
                              aria-label={t("Remove from this cell")}
                              onClick={() => {
                                const next = [...plan];
                                next[index] = "";
                                setPlan(next);
                              }}
                              className="rounded px-1.5 py-1 text-[12px] text-white/50 hover:bg-white/10 hover:text-white"
                            >
                              ✕
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setPickingCell(pickingCell === index ? null : index)}
                            className="rounded-md bg-white/10 px-2.5 py-1 text-[11px] font-medium text-white transition hover:bg-white/15"
                          >
                            {t("Add media")}
                          </button>
                        )}
                      </div>
                      {pickingCell === index && (
                        <div className="mt-1.5 grid max-h-40 grid-cols-4 gap-1.5 overflow-y-auto rounded-lg bg-black/30 p-1.5">
                          {project.assets
                            .filter((a) => a.kind === "video" || a.kind === "image")
                            .map((a) => {
                              const t2 = projectId ? thumbnailUrl(projectId, a) : null;
                              return (
                                <button
                                  key={a.id}
                                  type="button"
                                  title={a.name}
                                  onClick={() => {
                                    const next = [...plan];
                                    while (next.length < index) next.push("");
                                    next[index] = { assetId: a.id };
                                    setPlan(next);
                                    setPickingCell(null);
                                  }}
                                  className="aspect-square overflow-hidden rounded bg-black/50 ring-sky-400/60 transition hover:ring-2"
                                >
                                  {t2 ? <img src={t2} alt="" className="h-full w-full object-cover" /> : <span className="text-[10px] text-white/50">{a.name}</span>}
                                </button>
                              );
                            })}
                          {project.assets.every((a) => a.kind !== "video" && a.kind !== "image") && (
                            <p className="col-span-4 py-3 text-center text-[11px] text-white/40">{t("Import a video or photo first (Media).")}</p>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
              {plan.length > layout.cells.length && (
                <p className="mt-2 text-[11px] text-amber-200/80">{t("This layout has fewer cells than clips — the extra clips are left as they are.", {})}</p>
              )}
            </>
          ) : (
            <>
              <ol className="space-y-1 text-[11px] leading-relaxed text-white/50">
                <li>{t("1. Select one clip — a cutout of a person works best (add Outline & Glow first for the classic look).")}</li>
                <li>{t("2. Pick a starting point below, or set the steps yourself.")}</li>
                <li>{t("3. Add copies. They go behind your clip, each one further across, smaller and fainter, on their own tracks.")}</li>
              </ol>
              <div className="mt-2.5 grid grid-cols-3 gap-1.5">
                {STACK_PRESETS.map((preset) => (
                  <button
                    key={preset.name}
                    type="button"
                    onClick={() => {
                      const frameW = project.sequence.width;
                      const frameH = project.sequence.height;
                      setCount(preset.count);
                      setOffsetX(Math.round(preset.x * frameW));
                      setOffsetY(Math.round(preset.y * frameH));
                      setScaleStep(preset.shrink);
                      setFade(preset.fade);
                      setDelay(preset.delay);
                    }}
                    className="rounded-md border border-white/10 py-2 text-[12px] text-white/70 transition hover:bg-white/5 hover:text-white"
                  >
                    {t(preset.name)}
                  </button>
                ))}
              </div>
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
            disabled={tab === "grid" ? !plan.some((entry) => entry !== "") : pictureIds.length === 0}
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
