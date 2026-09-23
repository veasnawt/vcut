"use client";

import { useEffect, useRef, useState } from "react";
import { Search } from "@veasnawt/vicons";
import { getStickerAvailability, searchStickers, type StickerAvailability, type StickerSearchResult } from "../api/client.ts";
import type { StickerProvider, StickerType } from "../project/stickers.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import { useEditorStore } from "../store/editorStore.ts";
import { ToolPanelFrame } from "./ToolPanelFrame.tsx";

const SEARCH_DEBOUNCE_MS = 400;

const PROVIDER_NAMES: Record<StickerProvider, string> = { klipy: "KLIPY", giphy: "GIPHY" };

/** The Stickers tool — search animated stickers and GIFs (KLIPY free, GIPHY for credits) and drop one on
 *  the timeline. A toolbar-opened modal like `SfxPanel`. Shows trending items until something is typed.
 *  Picking one runs `addSticker` (import + place above the footage, selected) and closes the panel so
 *  the sticker can be positioned straight away. */
export function StickersPanel({ onClose }: { onClose: () => void }) {
  const t = useTranslation();
  const projectId = useEditorStore((s) => s.projectId);
  const addSticker = useEditorStore((s) => s.addSticker);

  const [availability, setAvailability] = useState<StickerAvailability | null>(null);
  const [availabilityError, setAvailabilityError] = useState<string | null>(null);
  const [provider, setProvider] = useState<StickerProvider>("klipy");
  const [type, setType] = useState<StickerType>("stickers");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<StickerSearchResult[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addingKey, setAddingKey] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    getStickerAvailability()
      .then((a) => {
        if (cancelled) return;
        setAvailability(a);
        // Free first; GIPHY only when it's the one that's set up.
        if (!a.klipy && a.giphy) setProvider("giphy");
      })
      .catch((err) => !cancelled && setAvailabilityError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, []);

  const providerReady = availability ? availability[provider] : false;

  async function runSearch(searchPage: number, append: boolean) {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const data = await searchStickers(provider, type, query.trim(), searchPage);
      if (requestId !== requestIdRef.current) return;
      setResults((prev) => (append ? [...prev, ...data.results] : data.results));
      setHasMore(data.hasMore);
      setPage(searchPage);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err.message : t("Search failed"));
      if (!append) setResults([]);
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }

  // Typing waits for a pause; switching tabs or providers searches at once and clears the grid first —
  // otherwise the previous tab's tiles stay tappable until the new results land, and a tap there adds
  // a GIF from the Stickers tab (caught by the UI test).
  const searchedRef = useRef<{ provider: StickerProvider; type: StickerType } | null>(null);
  useEffect(() => {
    if (!providerReady) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const switched = !searchedRef.current || searchedRef.current.provider !== provider || searchedRef.current.type !== type;
    searchedRef.current = { provider, type };
    if (switched) {
      requestIdRef.current++;
      setResults([]);
      setHasMore(false);
      void runSearch(1, false);
      return;
    }
    debounceRef.current = setTimeout(() => void runSearch(1, false), SEARCH_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, type, query, providerReady]);

  async function pick(result: StickerSearchResult) {
    if (addingKey) return;
    const key = `${result.provider}:${result.id}`;
    setAddingKey(key);
    const added = await addSticker(result);
    setAddingKey(null);
    if (added) onClose();
  }

  const giphyCredits = availability?.giphyCredits ?? 0;
  const bothProviders = Boolean(availability?.klipy && availability?.giphy);

  return (
    <ToolPanelFrame ariaLabel={t("Stickers")} onClose={onClose}>
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-white/10 px-4 py-3">
          <h2 className="text-sm font-semibold text-white">{t("Stickers")}</h2>
          <button onClick={onClose} aria-label={t("Close")} className="rounded p-1 text-white/40 transition hover:bg-white/10 hover:text-white">
            ✕
          </button>
        </div>

        <div className="shrink-0 space-y-2.5 border-b border-white/10 px-4 py-3">
          <div className="flex gap-2">
            <div className="flex shrink-0 overflow-hidden rounded-md border border-white/10" role="tablist">
              {(["stickers", "gifs"] as const).map((k) => (
                <button
                  key={k}
                  role="tab"
                  aria-selected={type === k}
                  onClick={() => setType(k)}
                  className={`px-3 py-1.5 text-xs font-medium transition ${type === k ? "bg-sky-500 text-white" : "bg-white/5 text-white/60 hover:bg-white/10"}`}
                >
                  {k === "stickers" ? t("Stickers") : t("GIFs")}
                </button>
              ))}
            </div>
            <div className="relative min-w-0 flex-1">
              <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-white/30" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={type === "stickers" ? t("Search stickers…") : t("Search GIFs…")}
                aria-label={type === "stickers" ? t("Search stickers") : t("Search GIFs")}
                // 16px below `sm` so iOS Safari doesn't zoom the page on focus.
                className="w-full rounded-md border border-white/10 bg-white/5 py-1.5 pl-8 pr-2.5 text-[16px] text-white placeholder:text-white/30 focus:border-sky-400/50 focus:outline-none sm:text-xs"
              />
            </div>
          </div>

          {bothProviders && (
            <div className="flex gap-1.5" role="radiogroup" aria-label={t("Source")}>
              {(["klipy", "giphy"] as const).map((p) => (
                <button
                  key={p}
                  role="radio"
                  aria-checked={provider === p}
                  onClick={() => setProvider(p)}
                  className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-medium transition ${
                    provider === p ? "border-sky-400/70 bg-sky-500/15 text-white" : "border-white/10 text-white/55 hover:border-white/25 hover:text-white/80"
                  }`}
                >
                  {PROVIDER_NAMES[p]}
                  <span className={provider === p ? "text-sky-200/80" : "text-white/35"}>
                    {p === "klipy" || giphyCredits === 0 ? t("Free") : t("{n} credits each", { n: giphyCredits })}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-3">
          {availabilityError ? (
            <p className="px-2 py-10 text-center text-xs text-amber-200/80">{availabilityError}</p>
          ) : !availability ? (
            <p className="px-2 py-10 text-center text-xs text-white/40">{t("Loading…")}</p>
          ) : !availability.klipy && !availability.giphy ? (
            <p className="px-2 py-10 text-center text-xs leading-relaxed text-white/45">{t("Stickers aren't available here yet.")}</p>
          ) : error ? (
            <p className="px-2 py-10 text-center text-xs text-amber-200/80">{error}</p>
          ) : results.length === 0 && !loading ? (
            <p className="px-2 py-10 text-center text-xs text-white/40">{query.trim() ? t("Nothing matches that search.") : t("Nothing to show right now.")}</p>
          ) : (
            <>
              {!query.trim() && <h3 className="mb-2 px-0.5 text-[10px] font-semibold uppercase tracking-wider text-white/35">{t("Trending")}</h3>}
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {results.map((result) => {
                  const key = `${result.provider}:${result.id}`;
                  const adding = addingKey === key;
                  return (
                    <button
                      key={key}
                      onClick={() => void pick(result)}
                      disabled={Boolean(addingKey) || !projectId}
                      title={result.title}
                      className="group relative aspect-square overflow-hidden rounded-lg bg-white/[0.04] transition hover:bg-white/[0.08] hover:ring-1 hover:ring-sky-400/60 disabled:cursor-default"
                    >
                      <img
                        src={result.previewUrl}
                        alt={result.title}
                        loading="lazy"
                        draggable={false}
                        className={`absolute inset-0 h-full w-full ${type === "stickers" ? "object-contain p-1.5" : "object-cover"} ${addingKey && !adding ? "opacity-50" : ""}`}
                      />
                      {adding && (
                        <span className="absolute inset-0 flex items-center justify-center bg-black/60 text-[11px] font-medium text-white">{t("Adding…")}</span>
                      )}
                    </button>
                  );
                })}
              </div>
              {loading && <p className="py-3 text-center text-[11px] text-white/40">{t("Searching…")}</p>}
              {hasMore && !loading && (
                <button
                  onClick={() => void runSearch(page + 1, true)}
                  className="mt-3 w-full rounded-md bg-white/5 py-1.5 text-xs font-medium text-white/70 transition hover:bg-white/10 hover:text-white"
                >
                  {t("Load more")}
                </button>
              )}
            </>
          )}
        </div>

        {providerReady && (
          <div className="flex shrink-0 items-center justify-between gap-2 border-t border-white/10 px-4 py-2 text-[10px] text-white/35">
            <span>{t("Powered by {provider}", { provider: PROVIDER_NAMES[provider] })}</span>
            {provider === "giphy" && giphyCredits > 0 && !bothProviders && <span>{t("{n} credits each", { n: giphyCredits })}</span>}
          </div>
        )}
    </ToolPanelFrame>
  );
}
