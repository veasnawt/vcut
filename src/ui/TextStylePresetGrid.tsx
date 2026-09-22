"use client";

import { useEffect, useMemo, useState } from "react";
import { fontById, preloadFont } from "../project/fonts.ts";
import {
  isPresetDark,
  PRESET_CATEGORIES,
  TEXT_STYLE_PRESETS,
  type PresetCategory,
  type TextStylePreset,
} from "../project/textStylePresets.ts";
import { useTranslation } from "../i18n/useTranslation.ts";

const FAVORITES_STORAGE_KEY = "vcut_text_style_favorites";
const RECENTS_STORAGE_KEY = "vcut_text_style_recents";

function loadFavoritesFromStorage(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(FAVORITES_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed) : new Set();
  } catch {
    return new Set();
  }
}

function saveFavoritesToStorage(favorites: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(Array.from(favorites)));
  } catch {
    // quota exceeded or private browsing
  }
}

function loadRecentsFromStorage(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(RECENTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveRecentToStorage(presetId: string): void {
  if (typeof window === "undefined") return;
  try {
    const current = loadRecentsFromStorage().filter((id) => id !== presetId);
    current.unshift(presetId);
    localStorage.setItem(RECENTS_STORAGE_KEY, JSON.stringify(current.slice(0, 12)));
  } catch {
    // ignore
  }
}

function buildPresetThumbnailStyle(preset: TextStylePreset): React.CSSProperties {
  const font = preset.fontFamily ? fontById(preset.fontFamily) : null;
  const style: React.CSSProperties = {
    fontFamily: font ? `"${font.cssFamily}", sans-serif` : "inherit",
    fontWeight: preset.bold ? 700 : 400,
    fontStyle: preset.italic ? "italic" : "normal",
    textTransform: preset.textTransform ?? "none",
  };

  if (preset.letterSpacing) {
    style.letterSpacing = `${Math.min(3, Math.round(preset.letterSpacing * 0.35))}px`;
  }

  // Gradient or solid fill
  if (preset.gradient && preset.gradient.stops && preset.gradient.stops.length >= 2) {
    const angle = preset.gradient.angleDeg ?? 180;
    const stopsStr = preset.gradient.stops
      .map((s) => `${s.color} ${Math.round(s.offset * 100)}%`)
      .join(", ");
    style.backgroundImage = `linear-gradient(${angle}deg, ${stopsStr})`;
    style.WebkitBackgroundClip = "text";
    style.WebkitTextFillColor = "transparent";
  } else {
    style.color = preset.color;
  }

  // Stroke
  if (preset.strokeColor) {
    const width = Math.min(1.5, Math.max(0.75, (preset.strokeWidth ?? 2) * 0.35));
    style.WebkitTextStroke = `${width}px ${preset.strokeColor}`;
  }

  // Shadows & Glow
  const shadows: string[] = [];
  if (preset.glowColor) {
    const blur = Math.min(12, Math.max(4, Math.round((preset.glowBlur ?? 16) * 0.4)));
    shadows.push(`0 0 ${blur}px ${preset.glowColor}`);
  }
  if (preset.shadowColor) {
    const ox = Math.min(3, Math.max(-3, Math.round((preset.shadowOffsetX ?? 2) * 0.6)));
    const oy = Math.min(3, Math.max(-3, Math.round((preset.shadowOffsetY ?? 2) * 0.6)));
    const blur = preset.shadowBlur ? Math.min(6, Math.round(preset.shadowBlur * 0.4)) : 0;
    shadows.push(`${ox}px ${oy}px ${blur}px ${preset.shadowColor}`);
  }
  if (preset.shadows && preset.shadows.length > 0) {
    for (const sh of preset.shadows) {
      const ox = Math.min(3, Math.max(-3, Math.round(sh.offsetX * 0.6)));
      const oy = Math.min(3, Math.max(-3, Math.round(sh.offsetY * 0.6)));
      const blur = Math.min(6, Math.round(sh.blur * 0.4));
      shadows.push(`${ox}px ${oy}px ${blur}px ${sh.color}`);
    }
  }
  if (shadows.length > 0) {
    style.textShadow = shadows.join(", ");
  }

  // Text decoration
  if (preset.textDecoration === "underline") {
    style.textDecoration = "underline";
  } else if (preset.textDecoration === "line-through") {
    style.textDecoration = "line-through";
  }

  return style;
}

export function TextStylePresetGrid({
  selectedId,
  onPick,
  onPreview,
  onPreviewEnd,
  className = "",
}: {
  selectedId?: string;
  onPick: (preset: TextStylePreset) => void;
  onPreview?: (preset: TextStylePreset) => void;
  onPreviewEnd?: () => void;
  className?: string;
}) {
  const t = useTranslation();
  const [activeCategory, setActiveCategory] = useState<"all" | "favorites" | "recents" | PresetCategory>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [favorites, setFavorites] = useState<Set<string>>(() => loadFavoritesFromStorage());
  const [recentIds, setRecentIds] = useState<string[]>(() => loadRecentsFromStorage());

  useEffect(() => {
    setFavorites(loadFavoritesFromStorage());
    setRecentIds(loadRecentsFromStorage());
  }, []);

  const toggleFavorite = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveFavoritesToStorage(next);
      return next;
    });
  };

  const handlePick = (preset: TextStylePreset) => {
    if (preset.fontFamily) {
      preloadFont(fontById(preset.fontFamily));
    }
    saveRecentToStorage(preset.id);
    setRecentIds(loadRecentsFromStorage());
    onPick(preset);
  };

  const filteredPresets = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();

    return TEXT_STYLE_PRESETS.filter((preset) => {
      // Category filter
      if (activeCategory === "favorites") {
        if (!favorites.has(preset.id)) return false;
      } else if (activeCategory === "recents") {
        if (!recentIds.includes(preset.id)) return false;
      } else if (activeCategory !== "all") {
        if (preset.category !== activeCategory) return false;
      }

      // Search filter
      if (q.length > 0) {
        const matchesLabel = preset.label.toLowerCase().includes(q);
        const matchesCategory = preset.category.toLowerCase().includes(q);
        const matchesTags = preset.tags?.some((tag) => tag.toLowerCase().includes(q));
        if (!matchesLabel && !matchesCategory && !matchesTags) return false;
      }

      return true;
    });
  }, [activeCategory, searchQuery, favorites, recentIds]);

  return (
    <div className={`flex flex-col gap-2.5 ${className}`}>
      {/* Search Bar */}
      <div className="relative flex items-center">
        <svg
          className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-white/40"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={t("Search styles...")}
          className="w-full rounded-md border border-white/10 bg-white/5 py-1.5 pl-8 pr-7 text-[12px] text-white placeholder-white/40 outline-none transition focus:border-sky-400/60 focus:bg-white/[0.08]"
        />
        {searchQuery && (
          <button
            onClick={() => setSearchQuery("")}
            className="absolute right-2 text-white/40 hover:text-white/80"
            title="Clear"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      {/* Category Pills */}
      <div className="no-scrollbar -mx-0.5 flex gap-1 overflow-x-auto px-0.5 py-0.5">
        <button
          onClick={() => setActiveCategory("all")}
          className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium transition ${
            activeCategory === "all"
              ? "bg-sky-500 text-white shadow-sm"
              : "bg-white/5 text-white/70 hover:bg-white/10 hover:text-white"
          }`}
        >
          {t("All")}
        </button>

        {favorites.size > 0 && (
          <button
            onClick={() => setActiveCategory("favorites")}
            className={`flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium transition ${
              activeCategory === "favorites"
                ? "bg-amber-500 text-white shadow-sm"
                : "bg-white/5 text-white/70 hover:bg-white/10 hover:text-white"
            }`}
          >
            <svg className="h-3 w-3 fill-current" viewBox="0 0 20 20">
              <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
            </svg>
            {t("Favorites")} ({favorites.size})
          </button>
        )}

        {recentIds.length > 0 && (
          <button
            onClick={() => setActiveCategory("recents")}
            className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium transition ${
              activeCategory === "recents"
                ? "bg-sky-500 text-white shadow-sm"
                : "bg-white/5 text-white/70 hover:bg-white/10 hover:text-white"
            }`}
          >
            {t("Recents")}
          </button>
        )}

        {PRESET_CATEGORIES.map((cat) => (
          <button
            key={cat.id}
            onClick={() => setActiveCategory(cat.id)}
            className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium transition ${
              activeCategory === cat.id
                ? "bg-sky-500 text-white shadow-sm"
                : "bg-white/5 text-white/70 hover:bg-white/10 hover:text-white"
            }`}
          >
            {t(cat.label)}
          </button>
        ))}
      </div>

      {/* Preset Cards Grid */}
      {filteredPresets.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-8 text-center text-white/50">
          <p className="text-[12px]">{t("No text styles match your selection")}</p>
          {(searchQuery || activeCategory !== "all") && (
            <button
              onClick={() => {
                setSearchQuery("");
                setActiveCategory("all");
              }}
              className="mt-2 text-[11px] text-sky-400 underline hover:text-sky-300"
            >
              {t("Reset filters")}
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-2 max-h-[360px] overflow-y-auto pr-0.5">
          {filteredPresets.map((preset) => {
            const isFav = favorites.has(preset.id);
            const isSelected = selectedId === preset.id;
            const needsContrastBg = isPresetDark(preset);

            return (
              <button
                type="button"
                key={preset.id}
                onClick={() => handlePick(preset)}
                onMouseEnter={() => {
                  if (preset.fontFamily) {
                    preloadFont(fontById(preset.fontFamily));
                  }
                  onPreview?.(preset);
                }}
                onMouseLeave={onPreviewEnd}
                className={`group relative flex w-full flex-col items-center gap-1 rounded-lg border p-1 text-center transition cursor-pointer ${
                  isSelected
                    ? "border-sky-400 bg-sky-500/15 ring-1 ring-sky-400/50 shadow-sm"
                    : "border-white/5 bg-zinc-900/60 hover:border-white/20 hover:bg-zinc-800/80"
                }`}
                title={preset.description ?? preset.label}
              >
                {/* Favorite Star Button */}
                <button
                  type="button"
                  onClick={(e) => toggleFavorite(preset.id, e)}
                  onPointerDown={(e) => e.stopPropagation()}
                  className={`absolute right-1.5 top-1.5 z-20 rounded p-0.5 transition ${
                    isFav
                      ? "text-amber-400 opacity-100"
                      : needsContrastBg
                        ? "text-black/40 opacity-0 group-hover:opacity-100 hover:text-amber-500"
                        : "text-white/40 opacity-0 group-hover:opacity-100 hover:text-amber-300"
                  }`}
                  title={isFav ? t("Remove from favorites") : t("Add to favorites")}
                >
                  <svg className="h-3.5 w-3.5 fill-current" viewBox="0 0 20 20">
                    <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                  </svg>
                </button>

                {/* Preview Box */}
                <div
                  className={`relative flex h-[46px] w-full items-center justify-center overflow-hidden rounded-md border transition ${
                    needsContrastBg
                      ? "border-neutral-300/40 bg-gradient-to-b from-neutral-100 to-neutral-200 shadow-inner"
                      : "border-white/10 bg-black/40"
                  }`}
                >
                  {preset.backgroundColor && (
                    <div
                      className="absolute inset-x-2 inset-y-2 pointer-events-none"
                      style={{
                        backgroundColor: preset.backgroundColor,
                        opacity: preset.backgroundOpacity ?? 1,
                        borderRadius: `${Math.min(6, preset.backgroundCornerRadius ?? 4)}px`,
                      }}
                    />
                  )}
                  <span
                    className="relative z-10 select-none text-[15px] leading-none"
                    style={buildPresetThumbnailStyle(preset)}
                  >
                    {preset.textTransform === "uppercase" ? "AA" : "Aa"}
                  </span>
                </div>

                {/* Preset Title */}
                <span className="w-full truncate text-center text-[10px] text-white/70 group-hover:text-white">
                  {t(preset.label)}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
