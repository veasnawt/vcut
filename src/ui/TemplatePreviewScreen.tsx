"use client";

import { useEffect, useRef, useState } from "react";
import { Image as ImageIcon, Music, Pause, Play, Text as TextIcon, Video, Volume } from "@veasnawt/vicons";
import { mediaUrl, thumbnailUrl } from "../api/client.ts";
import { SetClipMutedCommand } from "../commands/index.ts";
import { fontById } from "../project/fonts.ts";
import { isSoundEffectAsset } from "../project/sfx.ts";
import { sequenceDuration } from "../project/createProject.ts";
import { templateAudioAssets, templateClips, templateSlotRequiredLength, type TemplateClipEntry } from "../project/template.ts";
import type { Asset, Project } from "../project/types.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { formatDuration, formatTimecode } from "../timeline/time.ts";
import { ExportDialog } from "./ExportDialog.tsx";
import { REPLACE_AUDIO, REPLACE_FOOTAGE, ReplaceMediaDialog, type ReplaceTarget } from "./ReplaceMediaDialog.tsx";
import { addDragListeners, clientPoint, preventDefaultIfMouse } from "./pointerEvents.ts";
import { Preview } from "./Preview.tsx";
import { TemplateScreenHeader } from "./TemplateScreenHeader.tsx";
import { TemplateTrimDialog } from "./TemplateTrimDialog.tsx";
import { VideoFrameThumbnail } from "./VideoFrameThumbnail.tsx";

import { useHorizontalScroll } from "./useHorizontalScroll.ts";
type TabKey = "video" | "audio" | "text";

/** What a template-origin project (`Project.templateOrigin`) shows once every slot is filled — the
 *  finished-looking video, ready to export, with NO free-form access to a normal Timeline/Inspector
 *  (asked for directly: a template's whole point is a consistent, guaranteed-to-look-right result,
 *  which unrestricted editing could otherwise drift away from). Reuses `Preview.tsx` exactly as the
 *  normal editor does — same canvas, same playback engine, same play/pause transport bar.
 *
 *  What IS editable here is deliberately narrower than a real timeline: STRUCTURE (how many clips,
 *  their order, how long each plays) stays completely locked; only each clip's own CONTENT can
 *  change — which footage a video/image clip shows (Replace) and which portion of it (Trim, video
 *  only — a still image has no "which portion" of itself to choose), a text clip's own words, and the
 *  template's one global music track (`templateAudioAssets`'s own "Replace" row, not a per-clip
 *  concept). A filmstrip (`templateClips`, one tile per clip INSTANCE, mirroring the actual sequence)
 *  drives a Video/Audio/Text tab strip below it, each tab shown ONLY when the project actually has
 *  that kind of content — a text-free template never shows a Text tab with nothing to do in it. */
export function TemplatePreviewScreen({ onBack }: { onBack?: () => void }) {
  const t = useTranslation();
  const filmstripRef = useHorizontalScroll();
  const [exportOpen, setExportOpen] = useState(false);
  const [replaceTarget, setReplaceTarget] = useState<ReplaceTarget | null>(null);
  const [trimmingAsset, setTrimmingAsset] = useState<Asset | null>(null);
  const project = useEditorStore((s) => s.project);
  const projectId = useEditorStore((s) => s.projectId);
  const fillTemplateSlot = useEditorStore((s) => s.fillTemplateSlot);
  const trimTemplateSlot = useEditorStore((s) => s.trimTemplateSlot);
  const setTemplateClipText = useEditorStore((s) => s.setTemplateClipText);
  const setPlaying = useEditorStore((s) => s.setPlaying);
  const setPlayhead = useEditorStore((s) => s.setPlayhead);
  const run = useEditorStore((s) => s.run);

  const clips = project ? templateClips(project) : [];
  // Music and other audio only — a template's sound effects stay in the video but aren't offered for
  // replacing: a whoosh or a click is part of the edit's own timing, not a track someone swaps out.
  const audioRows = project ? templateAudioAssets(project).filter((asset) => !isSoundEffectAsset(asset)) : [];
  const hasVideo = clips.some((e) => e.asset.kind === "video" || e.asset.kind === "image");
  const hasText = clips.some((e) => e.asset.kind === "text");
  const hasAudio = audioRows.length > 0;

  const [selectedClipId, setSelectedClipId] = useState<string | null>(() => clips[0]?.clip.id ?? null);
  const [activeTab, setActiveTab] = useState<TabKey>(() => (hasVideo ? "video" : hasAudio ? "audio" : "text"));

  // Auditions ONE bundled audio track in isolation — asked for directly: the only way to hear the
  // template's own music/voiceover used to be playing the WHOLE composited timeline from the main
  // transport above, with no way to single out just the audio. A single shared `<audio>` element
  // (not one per row) since only one row can ever be playing at a time anyway. Pauses the main
  // preview transport on play — otherwise its own Web Audio graph would keep the template's audio
  // playing underneath this one too, doubling up rather than actually isolating it.
  const [playingAudioId, setPlayingAudioId] = useState<string | null>(null);
  const auditionRef = useRef<HTMLAudioElement>(null);

  function toggleAudioPreview(asset: Asset) {
    const el = auditionRef.current;
    if (!el || !projectId) return;
    if (playingAudioId === asset.id) {
      el.pause();
      setPlayingAudioId(null);
      return;
    }
    setPlaying(false);
    el.src = mediaUrl(projectId, asset.relPath, Boolean(asset.libraryMediaId));
    el.currentTime = 0;
    void el.play();
    setPlayingAudioId(asset.id);
  }

  function selectClip(entry: TemplateClipEntry) {
    setSelectedClipId(entry.clip.id);
    setActiveTab(entry.asset.kind === "text" ? "text" : "video");
    // Show the clip in the preview: pause and move the playhead to it. A little way in rather than exactly at its start, so
    // a clip that fades or pops in is already fully on screen instead of caught mid-transition.
    const length = entry.clip.sourceOut - entry.clip.sourceIn;
    setPlaying(false);
    setPlayhead(entry.clip.timelineStart + Math.min(0.35, Math.max(0, length) / 2));
  }

  const selected = clips.find((e) => e.clip.id === selectedClipId) ?? null;
  const isFootage = (entry: TemplateClipEntry) => entry.asset.kind === "video" || entry.asset.kind === "image";

  // Each tab shows only its own clips — video/image tiles on Video, text tiles on Text, and none on
  // Audio (its rows live in the tab itself). Asked for directly: other kinds were just clutter between
  // the preview and the tab's own controls.
  const filmstripClips =
    activeTab === "video" ? clips.filter(isFootage) : activeTab === "text" ? clips.filter((entry) => entry.asset.kind === "text") : [];

  // Switching to Text or Video lands on that tab's first clip when the current selection belongs to
  // the other one — otherwise the tab would open on "select a clip above" with the right tile possibly
  // not even shown any more.
  function switchTab(tab: TabKey) {
    setActiveTab(tab);
    const belongs = tab === "text" ? (entry: TemplateClipEntry) => entry.asset.kind === "text" : tab === "video" ? isFootage : null;
    if (!belongs || (selected && belongs(selected))) return;
    const first = clips.find(belongs);
    if (first) setSelectedClipId(first.clip.id);
  }

  // Editing a text on the preview itself (its Edit button) — follow it here, so the filmstrip and tabs
  // show which clip is being edited, while the Text tab stands its own editor down (see below and
  // `inlineTextEditAssetId`'s own doc comment). Read from the store rather than `clips` so this only
  // re-runs when an edit starts, not on every project change.
  const inlineTextEditAssetId = useEditorStore((s) => s.inlineTextEditAssetId);
  useEffect(() => {
    const current = useEditorStore.getState().project;
    if (!inlineTextEditAssetId || !current) return;
    const entry = templateClips(current).find((e) => e.asset.id === inlineTextEditAssetId);
    if (!entry) return;
    setSelectedClipId(entry.clip.id);
    setActiveTab("text");
  }, [inlineTextEditAssetId]);

  return (
    <div className="flex h-full flex-col bg-[#0a0c10] text-white">
      <TemplateScreenHeader onBack={onBack} subtitle={t("Preview it below, then export when you're happy with it.")} />

      <div className="min-h-0 flex-1 p-3">
        <Preview onResizeStart={() => {}} />
      </div>

      {project && <PlaybackProgressBar total={sequenceDuration(project)} fps={project.sequence.fps} />}

      {(hasVideo || hasAudio || hasText) && project && projectId && (
        <div className="shrink-0 border-t border-white/10">
          {filmstripClips.length > 0 && (
            <div ref={filmstripRef} className="scrollbar-thin flex gap-2 overflow-x-auto p-3 pb-2">
              {filmstripClips.map((entry) => (
                <FilmstripTile key={entry.clip.id} entry={entry} projectId={projectId} selected={entry.clip.id === selectedClipId} onSelect={() => selectClip(entry)} />
              ))}
            </div>
          )}

          <div className="flex border-t border-white/10">
            {hasVideo && <TabButton label={t("Video")} Icon={Video} active={activeTab === "video"} onClick={() => switchTab("video")} />}
            {hasAudio && <TabButton label={t("Audio")} Icon={Music} active={activeTab === "audio"} onClick={() => switchTab("audio")} />}
            {hasText && <TabButton label={t("Text")} Icon={TextIcon} active={activeTab === "text"} onClick={() => switchTab("text")} />}
          </div>

          <div className="scrollbar-thin max-h-40 overflow-y-auto p-3">
            {activeTab === "video" &&
              (selected && (selected.asset.kind === "video" || selected.asset.kind === "image") ? (
                <VideoTabContent
                  key={selected.asset.id}
                  asset={selected.asset}
                  project={project}
                  muted={selected.clip.mutedAudio ?? false}
                  onToggleMute={() => run(new SetClipMutedCommand(selected.clip.id, !(selected.clip.mutedAudio ?? false)))}
                  onTrim={() => setTrimmingAsset(selected.asset)}
                  onReplace={() => setReplaceTarget({ ...REPLACE_FOOTAGE, assetId: selected.asset.id })}
                />
              ) : (
                <p className="px-1 py-4 text-center text-xs text-white/40">{t("Select a video or photo clip above to edit it.")}</p>
              ))}

            {activeTab === "audio" && (
              <div className="space-y-1.5">
                {audioRows.map((asset) => (
                  <div key={asset.id} className="flex items-center justify-between gap-2 rounded-lg bg-white/5 px-3 py-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <button
                        onClick={() => toggleAudioPreview(asset)}
                        title={playingAudioId === asset.id ? t("Pause") : t("Play")}
                        aria-label={playingAudioId === asset.id ? t("Pause") : t("Play")}
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/10 text-white/80 transition hover:bg-white/20"
                      >
                        {playingAudioId === asset.id ? <Pause size={12} /> : <Play size={12} />}
                      </button>
                      <Music size={15} className="shrink-0 text-white/40" />
                      <span className="truncate text-xs text-white/80">{asset.name}</span>
                      <span className="shrink-0 text-[11px] tabular-nums text-white/40">{formatDuration(asset.duration)}</span>
                    </div>
                    <button
                      onClick={() => setReplaceTarget({ ...REPLACE_AUDIO, assetId: asset.id })}
                      className="shrink-0 rounded-md bg-white/10 px-2.5 py-1 text-[11px] font-medium text-white/80 transition hover:bg-white/20"
                    >
                      {t("Replace")}
                    </button>
                  </div>
                ))}
                {/* Hidden — a plain playback element, not a visible transport, since the button above
                    (and the row's own icon showing which asset is playing) already communicates state.
                    One shared instance for whichever row is currently playing, see this screen's own
                    `toggleAudioPreview` comment. */}
                <audio ref={auditionRef} className="hidden" onEnded={() => setPlayingAudioId(null)} />
              </div>
            )}

            {activeTab === "text" &&
              (selected && selected.asset.kind === "text" ? (
                inlineTextEditAssetId === selected.asset.id ? (
                  <p className="px-1 py-4 text-center text-xs text-white/50">{t("Editing this text on the preview — confirm it there when you're done.")}</p>
                ) : (
                  // Keyed by content too, so an edit made on the preview reloads this editor with the
                  // new words — otherwise it kept the old ones as an unsaved "change", and Save put
                  // them back.
                  <TextTabContent
                    key={`${selected.asset.id}:${selected.asset.textContent ?? ""}`}
                    asset={selected.asset}
                    onSave={(text) => setTemplateClipText(selected.asset.id, text)}
                  />
                )
              ) : (
                <p className="px-1 py-4 text-center text-xs text-white/40">{t("Select a text clip above to edit it.")}</p>
              ))}
          </div>
        </div>
      )}

      <div className="shrink-0 border-t border-white/10 p-3">
        <button
          onClick={() => setExportOpen(true)}
          className="w-full rounded-md bg-sky-500 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-400"
        >
          {t("Export")}
        </button>
      </div>

      {exportOpen && <ExportDialog onClose={() => setExportOpen(false)} />}
      {replaceTarget && (
        <ReplaceMediaDialog
          target={replaceTarget}
          onClose={() => setReplaceTarget(null)}
          onPick={(asset) => {
            fillTemplateSlot(replaceTarget.assetId, asset);
            setReplaceTarget(null);
          }}
        />
      )}
      {trimmingAsset && project && projectId && (
        <TemplateTrimDialog
          asset={trimmingAsset}
          projectId={projectId}
          requiredLength={templateSlotRequiredLength(project, trimmingAsset.id)}
          currentSourceIn={project.sequence.tracks.flatMap((tr) => tr.clips).find((c) => c.assetId === trimmingAsset.id)?.sourceIn ?? 0}
          onClose={() => setTrimmingAsset(null)}
          onConfirm={(sourceIn) => {
            trimTemplateSlot(trimmingAsset.id, sourceIn);
            setTrimmingAsset(null);
          }}
        />
      )}
    </div>
  );
}

/** A scrubbable start-to-finish playback position bar — the guided template flow has no `Timeline.tsx`
 *  at all (see `TemplatePreviewScreen`'s own doc comment: structure stays completely locked here), so
 *  without this there was literally nowhere to see or change WHERE playback currently is beyond
 *  watching the Preview canvas itself and guessing. Isolated into its own component (not inlined in
 *  `TemplatePreviewScreen` directly) for the same reason `Timeline.tsx`'s own `CurrentTime` is: only
 *  THIS subscribes to the live `playhead`, so the whole screen doesn't re-render 30-60×/sec during
 *  playback — just this one thin bar. Click or drag anywhere on the bar to seek, the same direct
 *  "tap where you want to be" gesture a video player's own scrubber uses. */
function PlaybackProgressBar({ total, fps }: { total: number; fps: number }) {
  const playhead = useEditorStore((s) => s.playhead);
  const setPlayhead = useEditorStore((s) => s.setPlayhead);
  const trackRef = useRef<HTMLDivElement | null>(null);

  if (total <= 0) return null;
  const fraction = Math.max(0, Math.min(1, playhead / total));

  function seekTo(clientX: number) {
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    setPlayhead(f * total);
  }

  function beginScrub(event: React.MouseEvent | React.TouchEvent) {
    preventDefaultIfMouse(event);
    seekTo(clientPoint(event).x);
    const remove = addDragListeners(
      (moveEvent) => seekTo(clientPoint(moveEvent).x),
      () => remove()
    );
  }

  return (
    <div className="shrink-0 px-3 pb-2">
      <div
        ref={trackRef}
        onMouseDown={beginScrub}
        onTouchStart={beginScrub}
        role="slider"
        aria-label="Playback position"
        aria-valuemin={0}
        aria-valuemax={Math.round(total)}
        aria-valuenow={Math.round(playhead)}
        className="relative h-2 w-full touch-none rounded-full bg-white/10"
      >
        <div className="h-full rounded-full bg-sky-400" style={{ width: `${fraction * 100}%` }} />
        <div
          className="absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full bg-white shadow"
          style={{ left: `calc(${fraction * 100}% - 7px)` }}
        />
      </div>
      <div className="mt-1 flex justify-between font-mono text-[10px] tabular-nums text-white/40">
        <span>{formatTimecode(playhead, fps)}</span>
        <span>{formatTimecode(total, fps)}</span>
      </div>
    </div>
  );
}

function TabButton({ label, Icon, active, onClick }: { label: string; Icon: typeof Video; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`flex flex-1 flex-col items-center gap-1 py-2.5 text-[11px] font-medium transition ${
        active ? "border-b-2 border-sky-400 text-white" : "border-b-2 border-transparent text-white/45 hover:text-white/70"
      }`}
    >
      <Icon size={16} />
      {label}
    </button>
  );
}

/** One filmstrip tile — a video/image clip shows its real thumbnail; a text clip shows its own
 *  content, in its own color, the same "the content itself is the most useful preview" treatment
 *  `MediaLibrary.tsx`'s own `AssetThumbnail` gives a text asset there. */
function FilmstripTile({
  entry,
  projectId,
  selected,
  onSelect,
}: {
  entry: TemplateClipEntry;
  projectId: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const { clip, asset } = entry;
  // A video's own static `thumbnailRelPath` is generated ONCE at import time and never regenerated —
  // stale the moment a retrim moves `sourceIn` away from that fixed offset (a real, reported bug: the
  // tile kept showing the ORIGINAL pick's own first frame regardless of how the trim window was later
  // adjusted). `VideoFrameThumbnail` seeks the real video to the clip's CURRENT `sourceIn` live instead.
  // An image has no "portion" to trim (never offered a Trim button at all — see `VideoTabContent`'s own
  // `canTrim` gating), so it keeps the plain static thumbnail unchanged.
  const videoSrc = asset.kind === "video" ? mediaUrl(projectId, asset.relPath, Boolean(asset.libraryMediaId)) : null;
  const thumb = asset.kind === "image" ? thumbnailUrl(projectId, asset) : null;
  return (
    <button
      onClick={onSelect}
      className={`relative h-16 w-16 shrink-0 overflow-hidden rounded-lg border-2 transition ${
        selected ? "border-sky-400" : "border-white/15 hover:border-white/30"
      }`}
    >
      {videoSrc ? (
        <VideoFrameThumbnail src={videoSrc} time={clip.sourceIn} className="absolute inset-0 h-full w-full object-cover" />
      ) : thumb ? (
        <img src={thumb} alt="" className="absolute inset-0 h-full w-full object-cover" draggable={false} />
      ) : asset.kind === "text" ? (
        <div
          className="flex h-full w-full items-center justify-center overflow-hidden bg-[#1a1a2e] p-1 text-center text-[9px] font-semibold leading-tight"
          style={{ color: asset.textStyle?.color ?? "#ffffff", fontFamily: `"${fontById(asset.textStyle?.fontFamily ?? "").cssFamily}"` }}
        >
          <span className="line-clamp-3 break-words">{asset.textContent || "Text"}</span>
        </div>
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-white/5 text-white/40">
          {asset.kind === "video" ? <Video size={16} /> : <ImageIcon size={16} />}
        </div>
      )}
      {clip.mutedAudio && asset.kind === "video" && (
        <span aria-hidden className="absolute left-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded bg-black/80 text-white">
          <MutedIcon size={10} />
        </span>
      )}
      <span className="absolute bottom-0.5 right-0.5 rounded bg-black/80 px-1 text-[9px] tabular-nums text-white">
        {formatDuration(clip.sourceOut - clip.sourceIn)}
      </span>
    </button>
  );
}

/** The speaker glyph struck through — same look as the editor toolbar's own sequence-mute button. */
function MutedIcon({ size }: { size: number }) {
  return (
    <span className="relative inline-flex">
      <Volume size={size} />
      <span
        aria-hidden
        style={{ width: size * 1.25 }}
        className="absolute left-1/2 top-1/2 h-[1.5px] -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-full bg-current"
      />
    </span>
  );
}

function VideoTabContent({
  asset,
  project,
  muted,
  onToggleMute,
  onTrim,
  onReplace,
}: {
  asset: Asset;
  project: Project;
  /** The SELECTED clip's own audio mute (`Clip.mutedAudio`) — per clip, not per footage group like Trim
   *  and Replace, so one copy of a duplicated clip can stay audible while another is silenced. */
  muted: boolean;
  onToggleMute: () => void;
  onTrim: () => void;
  onReplace: () => void;
}) {
  const t = useTranslation();
  const requiredLength = templateSlotRequiredLength(project, asset.id);
  const canTrim = asset.kind === "video" && asset.duration > requiredLength;
  // Only footage that actually has sound — a still or a silent video has nothing to mute.
  const canMute = asset.kind === "video" && asset.hasAudio;
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg bg-white/5 px-3 py-2">
      <span className="truncate text-xs text-white/80">{asset.name}</span>
      <div className="flex shrink-0 items-center gap-1.5">
        {canMute && (
          <button
            onClick={onToggleMute}
            aria-pressed={muted}
            title={muted ? t("Unmute clip") : t("Mute clip")}
            className={`flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-medium transition ${
              muted ? "bg-sky-500/25 text-sky-100 hover:bg-sky-500/35" : "bg-white/10 text-white/80 hover:bg-white/20"
            }`}
          >
            {muted ? <MutedIcon size={12} /> : <Volume size={12} />}
            {muted ? t("Muted") : t("Mute")}
          </button>
        )}
        {canTrim && (
          <button onClick={onTrim} className="rounded-md bg-white/10 px-2.5 py-1 text-[11px] font-medium text-white/80 transition hover:bg-white/20">
            {t("Trim")}
          </button>
        )}
        <button onClick={onReplace} className="rounded-md bg-white/10 px-2.5 py-1 text-[11px] font-medium text-white/80 transition hover:bg-white/20">
          {t("Replace")}
        </button>
      </div>
    </div>
  );
}

function TextTabContent({ asset, onSave }: { asset: Asset; onSave: (text: string) => void }) {
  const t = useTranslation();
  const [value, setValue] = useState(asset.textContent ?? "");
  const dirty = value !== (asset.textContent ?? "");
  return (
    <div>
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={3}
        className="w-full resize-none rounded-lg border border-white/10 bg-white/5 p-2.5 text-sm text-white outline-none focus:border-sky-400/50"
      />
      <button
        onClick={() => onSave(value)}
        disabled={!dirty}
        className="mt-2 w-full rounded-md bg-sky-500 py-1.5 text-xs font-semibold text-white transition hover:bg-sky-400 disabled:cursor-default disabled:opacity-40"
      >
        {t("Save")}
      </button>
    </div>
  );
}

/** The "Replace" picker for one video/image/audio row — deliberately smaller than
 *  `TemplateFillScreen.tsx`'s own full-screen grid (this is a single, optional swap on an
 *  otherwise-finished video, not a required multi-slot flow) so it's a modal overlay here instead,
 *  matching `ExportDialog.tsx`'s own dialog chrome. Audio renders as a plain list (no meaningful still
 *  image to show per item); video/image renders as a thumbnail grid, same tile shape
 *  `TemplateFillScreen.tsx`'s own `LibraryGridTile` uses — one component covers both since the
 *  picking/uploading mechanics underneath (`target.kinds`-filtered library + an upload input) are
 *  otherwise identical. `library.items` filtered away from `target.assetId` itself (already the
 *  current pick — nothing to switch to). */
