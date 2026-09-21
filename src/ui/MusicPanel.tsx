"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Close,
  Cosmos,
  Favorite,
  Globe,
  Headphone,
  Music,
  Pause,
  Play,
  Search,
  Star,
  TrendUp,
  Video,
} from "@veasnawt/vicons";
import { filterMusicCatalog, MUSIC_CATEGORIES, type MusicCategory, type MusicTrack } from "../project/music.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { formatDuration } from "../timeline/time.ts";

function CategoryIcon({ category }: { category: MusicCategory }) {
  switch (category) {
    case "trending":
      return <TrendUp size={13} />;
    case "upbeat":
      return <Star size={13} />;
    case "phonk":
      return <Headphone size={13} />;
    case "lofi":
      return <Cosmos size={13} />;
    case "cinematic":
      return <Video size={13} />;
    case "pop":
      return <Favorite size={13} />;
    case "travel":
      return <Globe size={13} />;
    default:
      return <Music size={13} />;
  }
}

/** Music tool panel — modal dialog for browsing, previewing, and adding trending & viral music tracks
 *  directly to the timeline. Features categorized pills, instant audio preview with shared HTMLAudioElement,
 *  and one-click timeline placement at the playhead. */
export function MusicPanel({ onClose }: { onClose: () => void }) {
  const t = useTranslation();
  const projectId = useEditorStore((s) => s.projectId);
  const importMusicTrack = useEditorStore((s) => s.importMusicTrack);
  const setStatus = useEditorStore((s) => s.setStatus);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<MusicCategory>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [addingId, setAddingId] = useState<string | null>(null);

  const tracks = filterMusicCatalog(selectedCategory, searchQuery);

  // Close on Escape key
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Clean up audio on unmount or track ended
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    function onEnded() {
      setPlayingId(null);
    }
    audio.addEventListener("ended", onEnded);
    return () => {
      audio.removeEventListener("ended", onEnded);
      audio.pause();
    };
  }, []);

  function togglePreview(track: MusicTrack) {
    const audio = audioRef.current;
    if (!audio) return;

    if (playingId === track.id) {
      audio.pause();
      setPlayingId(null);
      return;
    }

    audio.src = `/api/vcut/music/stream?url=${encodeURIComponent(track.audioUrl)}`;
    audio.currentTime = 0;
    void audio.play().catch(() => {
      // Audio playback might be blocked if user hasn't interacted
    });
    setPlayingId(track.id);
  }

  async function handleAddTrack(track: MusicTrack) {
    if (!projectId || addingId) return;
    setAddingId(track.id);
    try {
      if (importMusicTrack) {
        await importMusicTrack(track);
      }
      setStatus(t('Added "{title}" to timeline', { title: track.title }));
      onClose();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : t("Failed to add music track"));
    } finally {
      setAddingId(null);
    }
  }

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("Music Library")}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <audio ref={audioRef} preload="none" />

      <div className="flex h-full max-h-[640px] w-full max-w-2xl flex-col rounded-2xl border border-white/10 bg-[#12151c] shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-500/20 text-sky-400">
              <Music size={18} />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-white">{t("Music Library")}</h2>
              <p className="text-[11px] text-white/50">{t("Browse trending & viral music for your video")}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label={t("Close")}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-white/50 hover:bg-white/10 hover:text-white transition"
          >
            <Close size={16} />
          </button>
        </div>

        {/* Search Bar */}
        <div className="p-4 pb-2">
          <div className="relative flex items-center">
            <Search size={15} className="absolute left-3 text-white/40" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t("Search music, genres, vibes, artists...")}
              className="w-full rounded-xl border border-white/10 bg-white/5 pl-9 pr-3 py-2 text-xs text-white placeholder-white/40 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
            />
          </div>
        </div>

        {/* Category Pills */}
        <div className="scrollbar-none flex gap-1.5 overflow-x-auto px-4 py-2 border-b border-white/5">
          {MUSIC_CATEGORIES.map((cat) => (
            <button
              key={cat.id}
              onClick={() => setSelectedCategory(cat.id)}
              className={`shrink-0 flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition ${
                selectedCategory === cat.id
                  ? "bg-sky-500 text-white shadow-sm"
                  : "bg-white/5 text-white/60 hover:bg-white/10 hover:text-white"
              }`}
            >
              <CategoryIcon category={cat.id} />
              <span>{t(cat.label)}</span>
            </button>
          ))}
        </div>

        {/* Tracks List */}
        <div className="scrollbar-none min-h-0 flex-1 overflow-y-auto p-4 space-y-2">
          {tracks.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <Music size={32} className="text-white/20 mb-2" />
              <p className="text-xs text-white/50">{t("No music tracks found")}</p>
            </div>
          ) : (
            tracks.map((track) => {
              const isPlaying = playingId === track.id;
              const isAdding = addingId === track.id;
              return (
                <div
                  key={track.id}
                  className={`group flex items-center justify-between gap-3 rounded-xl border p-2.5 transition ${
                    isPlaying
                      ? "border-sky-500/40 bg-sky-500/10"
                      : "border-white/5 bg-white/[0.02] hover:border-white/15 hover:bg-white/[0.05]"
                  }`}
                >
                  {/* Left: Play/Pause Button */}
                  <div className="flex items-center gap-3 min-w-0">
                    <button
                      onClick={() => togglePreview(track)}
                      aria-label={isPlaying ? t("Pause preview") : t("Play preview")}
                      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition ${
                        isPlaying
                          ? "bg-sky-500 text-white shadow-md shadow-sky-500/20"
                          : "bg-white/10 text-white hover:bg-sky-500 hover:text-white"
                      }`}
                    >
                      {isPlaying ? <Pause size={16} /> : <Play size={16} className="ml-0.5" />}
                    </button>

                    {/* Middle: Title, Artist, Tags */}
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-xs font-semibold text-white">{track.title}</span>
                        {track.featured && (
                          <span className="flex items-center gap-1 shrink-0 rounded bg-amber-500/20 px-1.5 py-0.5 text-[9px] font-bold text-amber-300">
                            <Star size={10} />
                            TRENDING
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-[11px] text-white/40">
                        <span className="truncate">{track.artist}</span>
                        {track.bpm && (
                          <>
                            <span>•</span>
                            <span>{track.bpm} BPM</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Right: Duration and Add Button */}
                  <div className="flex shrink-0 items-center gap-3">
                    <span className="text-[11px] font-mono text-white/40">{formatDuration(track.duration)}</span>
                    <button
                      onClick={() => handleAddTrack(track)}
                      disabled={isAdding}
                      className="flex items-center gap-1.5 rounded-lg bg-white/10 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-sky-500 disabled:opacity-50"
                    >
                      {isAdding ? (
                        <span>{t("Adding...")}</span>
                      ) : (
                        <>
                          <span className="font-bold">+</span>
                          <span>{t("Add to Timeline")}</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
