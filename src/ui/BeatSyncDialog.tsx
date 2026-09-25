"use client";

import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Close } from "@veasnawt/vicons";
import { FitClipsToBeatsCommand, SplitClipAtBeatsCommand } from "../commands/index.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import { findAsset, findClip } from "../project/createProject.ts";
import { beatTimelineTimes } from "../timeline/beatSync.ts";
import { useEditorStore } from "../store/editorStore.ts";

const EVERY_OPTIONS = [
  { n: 1, label: "Every beat" },
  { n: 2, label: "Every 2 beats" },
  { n: 4, label: "Every bar (4)" },
  { n: 8, label: "Every 2 bars (8)" },
] as const;

/** Beat sync: listen to a music clip, then cut picture clips to its beat — the montage look where every shot changes on the
 *  music. Step 1 detects the tempo and beat positions (shown as ticks on the music clip, and edits snap to them); step 2 cuts
 *  the selected clips to run a chosen number of beats each, back to back, or splits one long clip on the beat. Both are one
 *  undoable step. */
export function BeatSyncDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslation();
  const project = useEditorStore((s) => s.project);
  const selectedClipIds = useEditorStore((s) => s.selectedClipIds);
  const run = useEditorStore((s) => s.run);
  const analyzeBeats = useEditorStore((s) => s.analyzeBeats);
  const setStatus = useEditorStore((s) => s.setStatus);

  const musicClips = useMemo(() => {
    if (!project) return [];
    return project.sequence.tracks
      .filter((track) => track.kind === "audio")
      .flatMap((track) => track.clips)
      .filter((clip) => findAsset(project, clip.assetId)?.kind === "audio")
      .sort((a, b) => a.timelineStart - b.timelineStart);
  }, [project]);

  const [musicId, setMusicId] = useState<string | null>(() => {
    const selectedMusic = selectedClipIds.find((id) => musicClips.some((c) => c.id === id));
    return selectedMusic ?? musicClips[0]?.id ?? null;
  });
  const [everyN, setEveryN] = useState(2);
  const [analysing, setAnalysing] = useState(false);

  if (!project || typeof document === "undefined") return null;
  const music = musicClips.find((c) => c.id === musicId);
  const musicAsset = music ? findAsset(project, music.assetId) : undefined;
  const beats = musicAsset?.beats;
  const beatTimes = music ? beatTimelineTimes(project, music) : [];

  const pictureIds = selectedClipIds.filter((id) => {
    const kind = (() => {
      const found = findClip(project, id);
      return found ? findAsset(project, found.clip.assetId)?.kind : undefined;
    })();
    return kind === "video" || kind === "image" || kind === "color";
  });

  async function detect() {
    if (!musicAsset || analysing) return;
    setAnalysing(true);
    try {
      await analyzeBeats(musicAsset.id);
    } finally {
      setAnalysing(false);
    }
  }

  function cut() {
    const command = new FitClipsToBeatsCommand(pictureIds, beatTimes, everyN);
    run(command);
    if (command.applied > 0) {
      setStatus(
        command.skipped > 0
          ? t("{n} clips cut to the beat ({s} left as they were)", { n: command.applied, s: command.skipped })
          : t("{n} clips cut to the beat", { n: command.applied })
      );
      onClose();
    }
  }

  function split() {
    const command = new SplitClipAtBeatsCommand(pictureIds[0], beatTimes, everyN);
    run(command);
    if (command.clipIds.length > 0) {
      useEditorStore.setState({ selectedClipIds: command.clipIds });
      setStatus(t("Split into {n} clips on the beat", { n: command.clipIds.length }));
      onClose();
    }
  }

  const lowConfidence = beats !== undefined && beats.confidence < 0.25;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-3 sm:items-center" onClick={onClose} role="dialog" aria-modal="true" aria-label={t("Beat sync")}>
      <div onClick={(e) => e.stopPropagation()} className="flex max-h-[88vh] w-full max-w-md flex-col rounded-2xl border border-white/10 bg-[#14161c] shadow-2xl">
        <div className="flex items-center justify-between px-4 pt-4">
          <h2 className="text-[15px] font-semibold text-white">{t("Beat sync")}</h2>
          <button type="button" onClick={onClose} aria-label={t("Close")} className="flex h-8 w-8 items-center justify-center rounded-md text-white/60 transition hover:bg-white/10 hover:text-white">
            <Close size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {musicClips.length === 0 ? (
            <p className="py-6 text-center text-[12px] leading-relaxed text-white/50">{t("Add a song to the timeline first — Beat sync cuts your clips to its beat.")}</p>
          ) : (
            <>
              <p className="text-[11px] font-medium uppercase tracking-wide text-white/40">{t("1 · Listen to the music")}</p>
              {musicClips.length > 1 && (
                <select
                  value={musicId ?? ""}
                  onChange={(e) => setMusicId(e.target.value)}
                  className="mt-2 w-full rounded-md border border-white/10 bg-white/5 px-2.5 py-2 text-[12px] text-white"
                >
                  {musicClips.map((clip) => (
                    <option key={clip.id} value={clip.id} className="bg-[#14161c]">
                      {findAsset(project, clip.assetId)?.name}
                    </option>
                  ))}
                </select>
              )}
              <div className="mt-2 flex items-center gap-3 rounded-lg bg-white/[0.04] px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12px] text-white/80">{musicAsset?.name}</p>
                  <p className="text-[11px] text-white/45">
                    {beats ? t("{bpm} BPM · {n} beats", { bpm: Math.round(beats.bpm), n: beats.times.length }) : t("Not analysed yet")}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void detect()}
                  disabled={analysing}
                  className="shrink-0 rounded-md bg-white/10 px-3 py-1.5 text-[12px] font-medium text-white transition hover:bg-white/15 disabled:opacity-50"
                >
                  {analysing ? t("Listening…") : beats ? t("Re-analyse") : t("Find the beat")}
                </button>
              </div>
              {lowConfidence && (
                <p className="mt-2 rounded-md bg-amber-300/[0.08] px-2.5 py-2 text-[11px] leading-relaxed text-amber-200">
                  {t("This music has no strong, steady beat, so the cuts may not line up well.")}
                </p>
              )}

              <p className="mt-4 text-[11px] font-medium uppercase tracking-wide text-white/40">{t("2 · Cut to the beat")}</p>
              <div role="group" className="mt-2 grid grid-cols-2 gap-1.5">
                {EVERY_OPTIONS.map((option) => (
                  <button
                    key={option.n}
                    type="button"
                    aria-pressed={everyN === option.n}
                    onClick={() => setEveryN(option.n)}
                    className={`rounded-md border py-2 text-[12px] transition ${everyN === option.n ? "border-sky-400/40 bg-sky-500/15 text-white" : "border-white/10 text-white/60 hover:bg-white/5"}`}
                  >
                    {t(option.label)}
                  </button>
                ))}
              </div>
              <p className="mt-3 text-[11px] leading-relaxed text-white/45">
                {pictureIds.length === 0
                  ? t("Select the video or image clips you want cut to the beat.")
                  : pictureIds.length === 1
                    ? t("One clip selected — you can split it on the beat, or cut it to fit.")
                    : t("{n} clips selected — each gets the same number of beats, one after another.", { n: pictureIds.length })}
              </p>
            </>
          )}
        </div>

        <div className="flex flex-col gap-2 border-t border-white/10 p-4">
          <button
            type="button"
            disabled={!beats || pictureIds.length === 0}
            onClick={cut}
            className="rounded-lg bg-sky-500 py-2.5 text-[13px] font-semibold text-white transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-white/30"
          >
            {t("Cut selected clips to the beat")}
          </button>
          <button
            type="button"
            disabled={!beats || pictureIds.length !== 1}
            onClick={split}
            className="rounded-lg bg-white/5 py-2.5 text-[13px] text-white/80 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:text-white/25"
          >
            {t("Split the selected clip on the beat")}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
