"use client";

import { useEffect, useRef, useState } from "react";
import { Add, Close } from "@veasnawt/vicons";
import { filmstripUrl, mediaUrl, sfxAssetUrl, thumbnailUrl } from "../api/client.ts";
import { SetExportCoverCommand } from "../commands/index.ts";
import { clipDuration, findAsset, sequenceDuration } from "../project/createProject.ts";
import type { Asset, Clip } from "../project/types.ts";
import { PlaybackEngine } from "../playback/PlaybackEngine.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { formatTimecode } from "../timeline/time.ts";
import { addDragListeners, clientPoint, preventDefaultIfMouse } from "./pointerEvents.ts";

type Tab = "video" | "album";

/** Full-screen cover picker — replaces the small dropdown `CoverControl.tsx` used to open directly,
 *  matching a CapCut-style dedicated screen (a real, provided reference screenshot): a big live
 *  preview of the frame currently under the scrubber, a "Select from video" / "Select from album" tab
 *  switch, a swipeable whole-timeline filmstrip, and Reset/Save actions up top. `CoverControl.tsx`
 *  still owns the small trigger button (in the track header/toolbar) and the `cover` state itself
 *  (`project.exportSettings.cover`) — this dialog only reads/writes that same field via
 *  `SetExportCoverCommand`, exactly like the control it replaced.
 *
 *  The big preview is its OWN independent `PlaybackEngine` instance, bound to its own canvas — NOT the
 *  app's single shared one (`useEditorStore`'s `playbackEngine`/`previewCanvas`, owned by `Preview.tsx`).
 *  Deliberately never registered into that shared slot: `TransformHandles`/`ScopesPanel`/`LevelMeter`
 *  all read it assuming it's paired with the ONE real on-screen preview canvas, and this dialog is a
 *  full-screen overlay blocking interaction with that canvas anyway. A second instance costs a second,
 *  independent decode of whichever source video is near the current scrub position — real, but
 *  one-shot and bounded, not a concern for an occasional "pick a cover" flow. Scrub position lives in a
 *  plain ref (`scrubTimeRef`), read by the engine's `getPlayhead` — NOT the shared store's real
 *  `playhead` — so scrubbing here never moves the actual editor's own position, and there's nothing to
 *  restore on close either. */
export function CoverPickerDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslation();
  const project = useEditorStore((s) => s.project);
  const projectId = useEditorStore((s) => s.projectId);
  const run = useEditorStore((s) => s.run);
  const importFiles = useEditorStore((s) => s.importFiles);

  const total = project ? sequenceDuration(project) : 0;
  const initialCover = project?.exportSettings.cover ?? null;

  const [tab, setTab] = useState<Tab>(initialCover?.kind === "image" ? "album" : "video");
  const [scrubTime, setScrubTime] = useState(() => Math.min(initialCover?.kind === "frame" ? initialCover.time : 0, total));
  const scrubTimeRef = useRef(scrubTime);
  scrubTimeRef.current = scrubTime;
  const [imageAsset, setImageAsset] = useState<Asset | null>(() =>
    initialCover?.kind === "image" ? (project?.assets.find((a) => a.id === initialCover.assetId) ?? null) : null
  );
  const [uploading, setUploading] = useState(false);
  // Separate from "which tab" and "what frame/image is currently staged" — a frame at time 0 is a
  // real, valid pick, not the same thing as "no cover at all". Reset clears this back to `false`
  // (Save then commits `null`) rather than silently saving whatever the scrubber happens to be
  // sitting at.
  const [hasCover, setHasCover] = useState(initialCover !== null);

  // State, not a plain ref — `attach` needs to re-run whenever the canvas element itself changes,
  // which a ref's own `.current` assignment can't trigger a re-render/effect for (same reasoning
  // `Preview.tsx`'s own `canvas` state has). Unmounts/remounts each time `tab` toggles away from and
  // back to "video" (the canvas only renders for that tab) — re-attaching on reappearance is exactly
  // what this effect already does, no special-casing needed for that.
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const engineRef = useRef<PlaybackEngine | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);

  // The dialog's own, unregistered engine — see this file's own top comment for why it's never
  // published to the shared store slot. Created once; canvas (re-)attachment is a separate effect
  // below, same split `Preview.tsx` uses.
  useEffect(() => {
    const engine = new PlaybackEngine({
      getProject: () => useEditorStore.getState().project,
      getPlayhead: () => scrubTimeRef.current,
      isPlaying: () => false,
      getLiveOverrides: () => [],
      getLiveTrackGainPreview: () => null,
      getLiveTrackPanPreview: () => null,
      getLiveMasterGainPreview: () => null,
      onTimeUpdate: () => {},
      onEnded: () => {},
      mediaUrlFor: (assetId) => {
        const state = useEditorStore.getState();
        const asset = state.project?.assets.find((a) => a.id === assetId);
        if (!asset || !state.projectId) return null;
        if (asset.bundledSfx) return sfxAssetUrl(asset.relPath);
        return mediaUrl(state.projectId, asset.relPath, Boolean(asset.libraryMediaId));
      },
      lutUrlFor: (lutId) => {
        const state = useEditorStore.getState();
        const lut = state.project?.luts.find((l) => l.id === lutId);
        if (!lut || !state.projectId) return null;
        return mediaUrl(state.projectId, lut.relPath);
      },
    });
    engineRef.current = engine;
    return () => engine.detach();
  }, []);

  useEffect(() => {
    if (canvas) engineRef.current?.attach(canvas);
  }, [canvas]);

  if (!project || !projectId) return null;

  const seqW = project.sequence.width;
  const seqH = project.sequence.height;

  // Every video/image clip across every video track, timeline order — the whole-timeline filmstrip
  // this scrubber tiles, one segment per clip sized proportionally to its own on-timeline duration.
  const videoClips: { clip: Clip; asset: Asset }[] = project.sequence.tracks
    .filter((tr) => tr.kind === "video")
    .flatMap((tr) => tr.clips)
    .map((clip) => ({ clip, asset: findAsset(project, clip.assetId) }))
    .filter((e): e is { clip: Clip; asset: Asset } => Boolean(e.asset) && (e.asset!.kind === "video" || e.asset!.kind === "image"))
    .sort((a, b) => a.clip.timelineStart - b.clip.timelineStart);

  function scrubTo(clientX: number) {
    const track = trackRef.current;
    if (!track || total <= 0) return;
    const rect = track.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    setScrubTime(fraction * total);
    setHasCover(true);
  }

  function beginScrub(event: React.MouseEvent | React.TouchEvent) {
    preventDefaultIfMouse(event);
    scrubTo(clientPoint(event).x);
    const remove = addDragListeners(
      (moveEvent) => scrubTo(clientPoint(moveEvent).x),
      () => remove()
    );
  }

  async function uploadImage(file: File) {
    setUploading(true);
    const imported = await importFiles([file], { hiddenFromLibrary: true });
    setUploading(false);
    if (imported[0]) {
      setImageAsset(imported[0]);
      setHasCover(true);
    }
  }

  function handleReset() {
    setImageAsset(null);
    setScrubTime(0);
    setTab("video");
    setHasCover(false);
  }

  function handleSave() {
    if (!hasCover) {
      run(new SetExportCoverCommand(null));
    } else if (tab === "album" && imageAsset) {
      run(new SetExportCoverCommand({ kind: "image", assetId: imageAsset.id }));
    } else {
      run(new SetExportCoverCommand({ kind: "frame", time: scrubTime }));
    }
    onClose();
  }

  const imageUrl = imageAsset ? thumbnailUrl(projectId, imageAsset) : null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#0a0c10] text-white">
      <div className="flex shrink-0 items-center justify-between px-4 py-3">
        <button onClick={onClose} aria-label={t("Close")} className="rounded p-1.5 text-white/70 transition hover:bg-white/10 hover:text-white">
          <Close size={20} />
        </button>
        <div className="flex items-center gap-2">
          <button onClick={handleReset} className="rounded-md bg-white/10 px-3.5 py-1.5 text-[13px] font-medium text-white/80 transition hover:bg-white/15">
            {t("Reset")}
          </button>
          <button
            onClick={handleSave}
            disabled={tab === "album" && !imageAsset}
            className="rounded-md bg-sky-400 px-4 py-1.5 text-[13px] font-semibold text-[#04121c] transition hover:bg-sky-300 disabled:cursor-default disabled:opacity-40"
          >
            {t("Save")}
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden px-4">
        {tab === "video" ? (
          <canvas
            ref={setCanvas}
            width={seqW}
            height={seqH}
            style={{ aspectRatio: `${seqW} / ${seqH}` }}
            className="max-h-full max-w-full rounded-lg bg-black object-contain"
          />
        ) : imageUrl ? (
          <img src={imageUrl} alt="" style={{ aspectRatio: `${seqW} / ${seqH}` }} className="max-h-full max-w-full rounded-lg bg-black object-contain" />
        ) : (
          <div
            style={{ aspectRatio: `${seqW} / ${seqH}` }}
            className="flex max-h-full max-w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-white/20 bg-white/5 px-8 text-white/40"
          >
            <Add size={22} />
            <span className="text-xs">{t("No image selected")}</span>
          </div>
        )}
      </div>

      <div className="shrink-0 pb-6 pt-3">
        <div className="mb-3 flex justify-center gap-6 border-b border-white/10 pb-2">
          <button
            onClick={() => setTab("video")}
            className={`px-1 pb-1.5 text-[13px] font-medium transition ${
              tab === "video" ? "border-b-2 border-sky-400 text-white" : "text-white/45 hover:text-white/70"
            }`}
          >
            {t("Select from video")}
          </button>
          <button
            onClick={() => setTab("album")}
            className={`px-1 pb-1.5 text-[13px] font-medium transition ${
              tab === "album" ? "border-b-2 border-sky-400 text-white" : "text-white/45 hover:text-white/70"
            }`}
          >
            {t("Select from album")}
          </button>
        </div>

        {tab === "video" ? (
          <div className="px-4">
            {videoClips.length > 0 ? (
              <div
                ref={trackRef}
                onMouseDown={beginScrub}
                onTouchStart={beginScrub}
                className="relative h-16 w-full touch-none overflow-hidden rounded-lg bg-white/5"
              >
                <div className="flex h-full w-full">
                  {videoClips.map(({ clip, asset }) => {
                    const widthPct = total > 0 ? (clipDuration(clip) / total) * 100 : 0;
                    const thumb = filmstripUrl(projectId, asset) ?? thumbnailUrl(projectId, asset);
                    return (
                      <div
                        key={clip.id}
                        style={{
                          width: `${widthPct}%`,
                          backgroundImage: thumb ? `url(${thumb})` : undefined,
                          backgroundRepeat: "repeat-x",
                          backgroundSize: "auto 100%",
                        }}
                        className="h-full shrink-0 bg-white/10"
                      />
                    );
                  })}
                </div>
                <div
                  className="pointer-events-none absolute top-0 bottom-0 w-0.5 bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.4)]"
                  style={{ left: total > 0 ? `${(scrubTime / total) * 100}%` : 0 }}
                />
              </div>
            ) : (
              <div className="flex h-16 items-center justify-center rounded-lg bg-white/5 text-xs text-white/40">
                {t("No video or image clips on the timeline yet.")}
              </div>
            )}
            <p className="mt-2 text-center text-[11px] text-white/40">
              {total > 0 ? t("At {time} — swipe to select", { time: formatTimecode(scrubTime, project.sequence.fps) }) : t("Swipe to select")}
            </p>
          </div>
        ) : (
          <div className="px-4">
            <label className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-white/25 bg-white/5 py-3 text-xs font-medium text-white/70 transition hover:border-sky-400/50 hover:bg-white/10">
              <input
                type="file"
                accept="image/*"
                className="hidden"
                disabled={uploading}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void uploadImage(file);
                }}
              />
              <Add size={16} />
              {uploading ? t("Uploading…") : imageAsset ? t("Change image") : t("Upload an image")}
            </label>
          </div>
        )}
      </div>
    </div>
  );
}
