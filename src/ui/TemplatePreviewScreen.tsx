"use client";

import { useState } from "react";
import { Add, Close, Image as ImageIcon, Music, Text as TextIcon, Video } from "@veasnawt/vicons";
import { assetFromLibraryMedia, previewAssetFromLibraryMedia, thumbnailUrl, type LibraryMediaItem } from "../api/client.ts";
import { fontById } from "../project/fonts.ts";
import { templateAudioAssets, templateClips, templateSlotRequiredLength, type TemplateClipEntry } from "../project/template.ts";
import type { Asset, Project } from "../project/types.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { formatDuration } from "../timeline/time.ts";
import { ExportDialog } from "./ExportDialog.tsx";
import { Preview } from "./Preview.tsx";
import { TemplateTrimDialog } from "./TemplateTrimDialog.tsx";
import { useLibraryMedia } from "./useLibraryMedia.ts";

type TabKey = "video" | "audio" | "text";

/** What a "Replace" picker offers/uploads/labels itself with — audio and video/image are different
 *  enough (a plain list vs. a thumbnail grid; different accepted extensions) that `ReplaceMediaDialog`
 *  needs to know which it's showing, but the picking/uploading MECHANICS underneath are identical
 *  either way — see that component's own doc comment. */
interface ReplaceTarget {
  assetId: string;
  kinds: Array<"audio" | "video" | "image">;
  title: string;
  accept: string;
}

const REPLACE_AUDIO: Omit<ReplaceTarget, "assetId"> = {
  kinds: ["audio"],
  title: "Replace music",
  accept: ".mp3,.wav,.m4a,.aac,.ogg,.flac",
};

const REPLACE_FOOTAGE: Omit<ReplaceTarget, "assetId"> = {
  kinds: ["video", "image"],
  title: "Replace clip",
  accept: ".mp4,.mov,.webm,.mkv,.avi,.m4v,.png,.jpg,.jpeg,.webp,.gif",
};

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
export function TemplatePreviewScreen() {
  const t = useTranslation();
  const [exportOpen, setExportOpen] = useState(false);
  const [replaceTarget, setReplaceTarget] = useState<ReplaceTarget | null>(null);
  const [trimmingAsset, setTrimmingAsset] = useState<Asset | null>(null);
  const project = useEditorStore((s) => s.project);
  const projectId = useEditorStore((s) => s.projectId);
  const fillTemplateSlot = useEditorStore((s) => s.fillTemplateSlot);
  const trimTemplateSlot = useEditorStore((s) => s.trimTemplateSlot);
  const setTemplateClipText = useEditorStore((s) => s.setTemplateClipText);

  const clips = project ? templateClips(project) : [];
  const audioRows = project ? templateAudioAssets(project) : [];
  const hasVideo = clips.some((e) => e.asset.kind === "video" || e.asset.kind === "image");
  const hasText = clips.some((e) => e.asset.kind === "text");
  const hasAudio = audioRows.length > 0;

  const [selectedClipId, setSelectedClipId] = useState<string | null>(() => clips[0]?.clip.id ?? null);
  const [activeTab, setActiveTab] = useState<TabKey>(() => (hasVideo ? "video" : hasAudio ? "audio" : "text"));

  function selectClip(entry: TemplateClipEntry) {
    setSelectedClipId(entry.clip.id);
    setActiveTab(entry.asset.kind === "text" ? "text" : "video");
  }

  const selected = clips.find((e) => e.clip.id === selectedClipId) ?? null;

  return (
    <div className="flex h-full flex-col bg-[#0a0c10] text-white">
      <div className="shrink-0 border-b border-white/10 px-4 py-3">
        <h1 className="text-sm font-semibold text-white">{t("Your video is ready")}</h1>
        <p className="mt-1 text-xs text-white/50">{t("Preview it below, then export when you're happy with it.")}</p>
      </div>

      <div className="min-h-0 flex-1 p-3">
        <Preview onResizeStart={() => {}} />
      </div>

      {(hasVideo || hasAudio || hasText) && project && projectId && (
        <div className="shrink-0 border-t border-white/10">
          {clips.length > 0 && (
            <div className="scrollbar-thin flex gap-2 overflow-x-auto p-3 pb-2">
              {clips.map((entry) => (
                <FilmstripTile key={entry.clip.id} entry={entry} projectId={projectId} selected={entry.clip.id === selectedClipId} onSelect={() => selectClip(entry)} />
              ))}
            </div>
          )}

          <div className="flex border-t border-white/10">
            {hasVideo && <TabButton label={t("Video")} Icon={Video} active={activeTab === "video"} onClick={() => setActiveTab("video")} />}
            {hasAudio && <TabButton label={t("Audio")} Icon={Music} active={activeTab === "audio"} onClick={() => setActiveTab("audio")} />}
            {hasText && <TabButton label={t("Text")} Icon={TextIcon} active={activeTab === "text"} onClick={() => setActiveTab("text")} />}
          </div>

          <div className="scrollbar-thin max-h-40 overflow-y-auto p-3">
            {activeTab === "video" &&
              (selected && (selected.asset.kind === "video" || selected.asset.kind === "image") ? (
                <VideoTabContent
                  key={selected.asset.id}
                  asset={selected.asset}
                  project={project}
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
              </div>
            )}

            {activeTab === "text" &&
              (selected && selected.asset.kind === "text" ? (
                <TextTabContent key={selected.asset.id} asset={selected.asset} onSave={(text) => setTemplateClipText(selected.asset.id, text)} />
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
  const thumb = asset.kind === "video" || asset.kind === "image" ? thumbnailUrl(projectId, asset) : null;
  return (
    <button
      onClick={onSelect}
      className={`relative h-16 w-16 shrink-0 overflow-hidden rounded-lg border-2 transition ${
        selected ? "border-sky-400" : "border-white/15 hover:border-white/30"
      }`}
    >
      {thumb ? (
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
      <span className="absolute bottom-0.5 right-0.5 rounded bg-black/80 px-1 text-[9px] tabular-nums text-white">
        {formatDuration(clip.sourceOut - clip.sourceIn)}
      </span>
    </button>
  );
}

function VideoTabContent({
  asset,
  project,
  onTrim,
  onReplace,
}: {
  asset: Asset;
  project: Project;
  onTrim: () => void;
  onReplace: () => void;
}) {
  const t = useTranslation();
  const requiredLength = templateSlotRequiredLength(project, asset.id);
  const canTrim = asset.kind === "video" && asset.duration > requiredLength;
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg bg-white/5 px-3 py-2">
      <span className="truncate text-xs text-white/80">{asset.name}</span>
      <div className="flex shrink-0 items-center gap-1.5">
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
function ReplaceMediaDialog({ target, onClose, onPick }: { target: ReplaceTarget; onClose: () => void; onPick: (asset: Asset) => void }) {
  const t = useTranslation();
  const projectId = useEditorStore((s) => s.projectId);
  const importFiles = useEditorStore((s) => s.importFiles);
  const library = useLibraryMedia(true);
  const [uploading, setUploading] = useState(false);

  const items = library.items?.filter((i) => target.kinds.includes(i.kind) && i.id !== target.assetId) ?? [];
  const isGrid = target.kinds.includes("video") || target.kinds.includes("image");

  async function uploadReplacement(file: File) {
    setUploading(true);
    const imported = await importFiles([file]);
    setUploading(false);
    if (imported[0]) onPick(imported[0]);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center sm:p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t(target.title)}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[80vh] w-full max-w-md overflow-y-auto rounded-t-xl border border-white/10 bg-[#12151c] p-4 shadow-2xl sm:rounded-xl"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white">{t(target.title)}</h2>
          <button onClick={onClose} className="rounded p-1 text-white/50 transition hover:bg-white/10 hover:text-white">
            <Close size={16} />
          </button>
        </div>

        <label className="mb-2 flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-white/25 bg-white/5 py-3 text-xs font-medium text-white/70 transition hover:border-sky-400/50 hover:bg-white/10">
          <input
            type="file"
            className="hidden"
            disabled={uploading}
            accept={target.accept}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void uploadReplacement(file);
            }}
          />
          <Add size={16} />
          {uploading ? t("Uploading…") : t("Upload a file")}
        </label>

        {isGrid ? (
          <div className="grid grid-cols-3 gap-2">
            {items.map((item) => (
              <ReplaceGridTile key={item.id} item={item} projectId={projectId} onPick={() => onPick(assetFromLibraryMedia(item))} />
            ))}
          </div>
        ) : (
          <div className="space-y-1">
            {items.map((item) => (
              <button
                key={item.id}
                onClick={() => onPick(assetFromLibraryMedia(item))}
                className="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left transition hover:bg-white/10"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Music size={15} className="shrink-0 text-white/40" />
                  <span className="truncate text-xs text-white/80">{item.name}</span>
                </span>
                <span className="shrink-0 text-[11px] tabular-nums text-white/40">{formatDuration(item.duration)}</span>
              </button>
            ))}
          </div>
        )}
        {library.items !== null && items.length === 0 && (
          <p className="px-2 py-4 text-center text-xs text-white/40">{t("Nothing usable in your media yet — upload something above.")}</p>
        )}
      </div>
    </div>
  );
}

function ReplaceGridTile({ item, projectId, onPick }: { item: LibraryMediaItem; projectId: string | null; onPick: () => void }) {
  const Icon = item.kind === "image" ? ImageIcon : Video;
  const url = projectId ? thumbnailUrl(projectId, previewAssetFromLibraryMedia(item)) : null;
  return (
    <button
      onClick={onPick}
      title={item.name}
      className="group relative aspect-square overflow-hidden rounded-lg bg-black transition hover:ring-2 hover:ring-sky-400/60"
    >
      {url ? (
        <img src={url} alt="" className="absolute inset-0 h-full w-full object-cover" draggable={false} />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center bg-white/5 text-white/40">
          <Icon size={18} />
        </div>
      )}
      {item.kind !== "image" && (
        <span className="absolute bottom-1 right-1 rounded bg-black/75 px-1 text-[10px] tabular-nums text-white/90">
          {formatDuration(item.duration)}
        </span>
      )}
    </button>
  );
}
