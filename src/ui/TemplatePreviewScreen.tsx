"use client";

import { useState } from "react";
import { Add, Close, Music } from "@veasnawt/vicons";
import { assetFromLibraryMedia } from "../api/client.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import { templateAudioAssets } from "../project/template.ts";
import type { Asset } from "../project/types.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { formatDuration } from "../timeline/time.ts";
import { ExportDialog } from "./ExportDialog.tsx";
import { Preview } from "./Preview.tsx";
import { useLibraryMedia } from "./useLibraryMedia.ts";

/** What a template-origin project (`Project.templateOrigin`) shows once every slot is filled — the
 *  finished-looking video, ready to export, with no way to reach the normal timeline/clip editor at
 *  all (asked for directly: a template's whole point is a consistent, guaranteed-to-look-right result,
 *  which free-form editing could otherwise drift away from). Reuses `Preview.tsx` exactly as the
 *  normal editor does — same canvas, same playback engine, same play/pause transport bar — just
 *  without any of the surrounding timeline/panels chrome; `onResizeStart` is a no-op since there's no
 *  resizable layout here for its drag handle to actually resize. `ExportDialog` is mounted directly
 *  (not via the normal editor's own `exportOpen` state, which doesn't exist on this screen) — it reads
 *  everything it needs straight from the store, same as it always has.
 *
 *  A template's bundled music/voiceover carries over automatically (never a fillable slot — see
 *  `Asset.templateBundledAudio`'s own doc comment) but is still yours to swap out, asked for directly:
 *  each `templateAudioAssets(project)` row gets its own "Replace" action, reusing `fillTemplateSlot`
 *  exactly as a video/image slot does (see that function's own doc comment for why it needs no
 *  dedicated audio path). */
export function TemplatePreviewScreen() {
  const t = useTranslation();
  const [exportOpen, setExportOpen] = useState(false);
  const [replacingAssetId, setReplacingAssetId] = useState<string | null>(null);
  const project = useEditorStore((s) => s.project);
  const fillTemplateSlot = useEditorStore((s) => s.fillTemplateSlot);

  const audioRows = project ? templateAudioAssets(project) : [];

  return (
    <div className="flex h-full flex-col bg-[#0a0c10] text-white">
      <div className="shrink-0 border-b border-white/10 px-4 py-3">
        <h1 className="text-sm font-semibold text-white">{t("Your video is ready")}</h1>
        <p className="mt-1 text-xs text-white/50">{t("Preview it below, then export when you're happy with it.")}</p>
      </div>

      <div className="min-h-0 flex-1 p-3">
        <Preview onResizeStart={() => {}} />
      </div>

      {audioRows.length > 0 && (
        <div className="shrink-0 space-y-1.5 border-t border-white/10 p-3">
          {audioRows.map((asset) => (
            <div key={asset.id} className="flex items-center justify-between gap-2 rounded-lg bg-white/5 px-3 py-2">
              <div className="flex min-w-0 items-center gap-2">
                <Music size={15} className="shrink-0 text-white/40" />
                <span className="truncate text-xs text-white/80">{asset.name}</span>
                <span className="shrink-0 text-[11px] tabular-nums text-white/40">{formatDuration(asset.duration)}</span>
              </div>
              <button
                onClick={() => setReplacingAssetId(asset.id)}
                className="shrink-0 rounded-md bg-white/10 px-2.5 py-1 text-[11px] font-medium text-white/80 transition hover:bg-white/20"
              >
                {t("Replace")}
              </button>
            </div>
          ))}
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
      {replacingAssetId && (
        <ReplaceAudioDialog
          currentAssetId={replacingAssetId}
          onClose={() => setReplacingAssetId(null)}
          onPick={(asset) => {
            fillTemplateSlot(replacingAssetId, asset);
            setReplacingAssetId(null);
          }}
        />
      )}
    </div>
  );
}

/** The "Replace" picker for one `templateAudioAssets` row — deliberately smaller than
 *  `TemplateFillScreen.tsx`'s own full-screen grid (this is a single, optional swap on an otherwise-
 *  finished video, not a required multi-slot flow) so it's a modal overlay here instead, matching
 *  `ExportDialog.tsx`'s own dialog chrome. A plain list, not a thumbnail grid — unlike video/image,
 *  audio has no meaningful still image to show per item. `library.items` filtered to `kind === "audio"`
 *  and away from `currentAssetId` itself (already the current pick — nothing to switch to). */
function ReplaceAudioDialog({
  currentAssetId,
  onClose,
  onPick,
}: {
  currentAssetId: string;
  onClose: () => void;
  onPick: (asset: Asset) => void;
}) {
  const t = useTranslation();
  const importFiles = useEditorStore((s) => s.importFiles);
  const library = useLibraryMedia(true);
  const [uploading, setUploading] = useState(false);

  const audioItems = library.items?.filter((i) => i.kind === "audio" && i.id !== currentAssetId) ?? [];

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
      aria-label={t("Replace music")}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[80vh] w-full max-w-md overflow-y-auto rounded-t-xl border border-white/10 bg-[#12151c] p-4 shadow-2xl sm:rounded-xl"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white">{t("Replace music")}</h2>
          <button onClick={onClose} className="rounded p-1 text-white/50 transition hover:bg-white/10 hover:text-white">
            <Close size={16} />
          </button>
        </div>

        <label className="mb-2 flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-white/25 bg-white/5 py-3 text-xs font-medium text-white/70 transition hover:border-sky-400/50 hover:bg-white/10">
          <input
            type="file"
            className="hidden"
            disabled={uploading}
            accept=".mp3,.wav,.m4a,.aac,.ogg,.flac"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void uploadReplacement(file);
            }}
          />
          <Add size={16} />
          {uploading ? t("Uploading…") : t("Upload a track")}
        </label>

        <div className="space-y-1">
          {audioItems.map((item) => (
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
          {library.items !== null && audioItems.length === 0 && (
            <p className="px-2 py-4 text-center text-xs text-white/40">{t("Nothing usable in your media yet — upload something above.")}</p>
          )}
        </div>
      </div>
    </div>
  );
}
