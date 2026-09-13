"use client";

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Image as ImageIcon, Music, Upload, Video } from "@veasnawt/vicons";
import { assetFromLibraryMedia, listLibraryMedia, previewAssetFromLibraryMedia, thumbnailUrl, type LibraryMediaItem } from "../api/client.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import { templateSlots, type TemplateSlot } from "../project/template.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { formatDuration } from "../timeline/time.ts";

/** Only video/image files (interchangeably — see `fillTemplateSlot`'s own doc comment on why either
 *  kind can satisfy a video-OR-image slot) for a visual slot; only audio files for an audio one. Audio
 *  can never fill a visual slot or vice versa — the two live on genuinely different track kinds. */
const VIDEO_IMAGE_EXTENSIONS = ".mp4,.mov,.webm,.mkv,.avi,.m4v,.png,.jpg,.jpeg,.webp,.gif";
const AUDIO_EXTENSIONS = ".wav,.mp3,.aac,.flac,.m4a,.ogg";

function isCompatible(slotKind: TemplateSlot["kind"], itemKind: "video" | "audio" | "image"): boolean {
  return slotKind === "audio" ? itemKind === "audio" : itemKind === "video" || itemKind === "image";
}

const KIND_ICON: Record<TemplateSlot["kind"], typeof Video> = { video: Video, audio: Music, image: ImageIcon };

/** The "fill in your media" step for a project just started from a Pro template — every open slot
 *  `templateSlots` (`project/template.ts`) reports, each fillable by uploading a file or picking
 *  something already in the user's own account-wide library. Deliberately does NOT block entering the
 *  editor: `slots` is re-derived from `project` on every render, so a slot simply disappears from this
 *  list the instant it's filled (`fillTemplateSlot`'s own store action removes the placeholder it was
 *  standing in for) — there's no separate "done" flag to track. Stock search and AI generation aren't
 *  offered here (a deliberate v1 scope cut, not an oversight) — upload and "my media" cover the two
 *  most common real cases (bring your own footage, or reuse something already imported), and a user
 *  can still reach either of those from the normal Media/Stock/AI tabs for any slot left unfilled once
 *  this dialog is dismissed (an unfilled slot's placeholder clip just sits there like any other clip,
 *  simply with nothing to actually show yet). */
export function TemplateSlotsDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslation();
  const project = useEditorStore((s) => s.project);
  const projectId = useEditorStore((s) => s.projectId);
  const importFiles = useEditorStore((s) => s.importFiles);
  const fillTemplateSlotAction = useEditorStore((s) => s.fillTemplateSlot);

  const [libraryOpenForSlot, setLibraryOpenForSlot] = useState<string | null>(null);
  const [libraryItems, setLibraryItems] = useState<LibraryMediaItem[] | null>(null);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [busySlotId, setBusySlotId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingSlotRef = useRef<TemplateSlot | null>(null);

  if (!project || !projectId) return null;
  const slots = templateSlots(project);

  async function openLibraryFor(slot: TemplateSlot) {
    setLibraryOpenForSlot(slot.assetId);
    if (libraryItems !== null) return;
    setLibraryLoading(true);
    try {
      setLibraryItems((await listLibraryMedia()).items);
    } catch {
      setLibraryItems([]);
    } finally {
      setLibraryLoading(false);
    }
  }

  function pickFile(slot: TemplateSlot) {
    pendingSlotRef.current = slot;
    // Set imperatively, not via a JSX `accept` prop bound to the ref — `pendingSlotRef` mutating
    // doesn't trigger a re-render, and `.click()` fires synchronously right after, before React would
    // ever get a chance to commit an updated `accept` value even if this WERE state instead of a ref.
    if (fileInputRef.current) {
      fileInputRef.current.accept = slot.kind === "audio" ? AUDIO_EXTENSIONS : VIDEO_IMAGE_EXTENSIONS;
      fileInputRef.current.click();
    }
  }

  async function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    const slot = pendingSlotRef.current;
    pendingSlotRef.current = null;
    if (!file || !slot) return;
    setBusySlotId(slot.assetId);
    const imported = await importFiles([file]);
    setBusySlotId(null);
    if (imported[0]) fillTemplateSlotAction(slot.assetId, imported[0]);
  }

  function chooseLibraryItem(slot: TemplateSlot, item: LibraryMediaItem) {
    // `assetFromLibraryMedia` (not `previewAssetFromLibraryMedia`, used only for the thumbnail below) —
    // this is a real placement, and two different slots filled from the SAME library item need two
    // independent asset ids, the same reason a normal "Add to project" pick already does.
    fillTemplateSlotAction(slot.assetId, assetFromLibraryMedia(item));
    setLibraryOpenForSlot(null);
  }

  const openSlot = slots.find((s) => s.assetId === libraryOpenForSlot) ?? null;
  const compatibleLibraryItems = openSlot ? (libraryItems ?? []).filter((i) => isCompatible(openSlot.kind, i.kind)) : [];

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-label={t("Add your own media")}>
      <div className="flex max-h-[85vh] w-full max-w-md flex-col rounded-xl border border-white/10 bg-[#12151c] shadow-2xl">
        <div className="shrink-0 border-b border-white/10 p-5 pb-3">
          <h2 className="text-sm font-semibold text-white">{t("Add your own media")}</h2>
          <p className="mt-2 text-xs leading-relaxed text-white/60">
            {slots.length > 0
              ? t("This template keeps its original timing, effects, and music — just swap in your own photos and videos below.")
              : t("All set — every slot has your own media in it now.")}
          </p>
        </div>

        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-3">
          {slots.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-emerald-300">{t("Nothing left to fill in.")}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {slots.map((slot, i) => {
                const Icon = KIND_ICON[slot.kind];
                const isBusy = busySlotId === slot.assetId;
                return (
                  <li key={slot.assetId}>
                    <div className="flex items-center gap-2.5 rounded-lg p-2 hover:bg-white/5">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-white/10 text-white/70">
                        <Icon size={16} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-medium text-white/90">{t("Slot {n}", { n: i + 1 })}</p>
                        <p className="truncate text-[11px] text-white/45">
                          {slot.kind === "video"
                            ? t("Video · {duration}", { duration: formatDuration(slot.requiredDuration) })
                            : slot.kind === "audio"
                              ? t("Audio · {duration}", { duration: formatDuration(slot.requiredDuration) })
                              : t("Photo or video · {duration}", { duration: formatDuration(slot.requiredDuration) })}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          onClick={() => pickFile(slot)}
                          disabled={isBusy}
                          title={t("Upload a file")}
                          className="flex h-7 w-7 items-center justify-center rounded bg-sky-500/20 text-sky-300 transition hover:bg-sky-500/30 disabled:opacity-50"
                        >
                          <Upload size={14} />
                        </button>
                        <button
                          onClick={() => void openLibraryFor(slot)}
                          disabled={isBusy}
                          title={t("Choose from my media")}
                          className="rounded bg-white/10 px-2 py-1.5 text-[11px] font-medium text-white/80 transition hover:bg-white/20 disabled:opacity-50"
                        >
                          {t("My media")}
                        </button>
                      </div>
                    </div>
                    {openSlot?.assetId === slot.assetId && (
                      <div className="mb-1 ml-2 mt-1 max-h-48 overflow-y-auto rounded-lg border border-white/10 bg-black/30 p-1.5">
                        {libraryLoading ? (
                          <p className="px-2 py-3 text-center text-[11px] text-white/40">{t("Loading…")}</p>
                        ) : compatibleLibraryItems.length === 0 ? (
                          <p className="px-2 py-3 text-center text-[11px] text-white/40">{t("Nothing usable in your media yet.")}</p>
                        ) : (
                          <ul className="flex flex-col gap-1">
                            {compatibleLibraryItems.map((item) => (
                              <li key={item.id}>
                                <button
                                  onClick={() => chooseLibraryItem(slot, item)}
                                  className="flex w-full items-center gap-2 rounded p-1 text-left transition hover:bg-white/10"
                                >
                                  <div className="h-8 w-12 shrink-0 overflow-hidden rounded bg-black">
                                    {(() => {
                                      const url = thumbnailUrl(projectId, previewAssetFromLibraryMedia(item));
                                      return url ? <img src={url} alt="" className="h-full w-full object-cover" /> : null;
                                    })()}
                                  </div>
                                  <span className="truncate text-[11px] text-white/80">{item.name}</span>
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* `accept` is set imperatively by `pickFile` right before each click, not bound here — see its
            own comment. */}
        <input ref={fileInputRef} type="file" className="hidden" onChange={(e) => void onFileChosen(e)} />

        <div className="flex shrink-0 justify-end border-t border-white/10 p-3">
          <button onClick={onClose} className="rounded-md bg-sky-500 px-4 py-1.5 text-xs font-semibold text-white transition hover:bg-sky-400">
            {slots.length > 0 ? t("Continue to editor") : t("Done")}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
