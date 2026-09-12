"use client";

import { useEffect, useRef, useState } from "react";
import { searchStock, type StockSearchResult } from "../api/client.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import { useEditorStore } from "../store/editorStore.ts";

/** How long to wait after the user stops typing before actually searching — Pixabay is a shared,
 *  rate-limited (100 req/60s) server-owned key across every hosted user (see `stock/route.ts`'s own
 *  doc comment), so firing a request per keystroke would burn through that budget on a single user's
 *  one search. */
const SEARCH_DEBOUNCE_MS = 500;

/** Stock photo/video search (Pixabay) — a self-contained panel, not woven into `MediaLibrary.tsx`'s
 *  own already-intricate drag/touch/native-picker logic, so this stays simple to reason about and
 *  can't destabilize the existing library behavior. Rendered as a sibling MODE of the library (a tab)
 *  by `MediaPanel.tsx`, which owns the tab strip itself — this component starts straight at its own
 *  search row, with no title header of its own, since the tab strip already names it. */
export function StockSearchPanel({ onAssetAdded }: { onAssetAdded?: () => void } = {}) {
  const t = useTranslation();
  const projectId = useEditorStore((s) => s.projectId);
  const importing = useEditorStore((s) => s.importing);
  const importStockResult = useEditorStore((s) => s.importStockResult);

  const [kind, setKind] = useState<"image" | "video">("image");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<StockSearchResult[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Which result is mid-download — disables just that one tile rather than the whole grid, so picking
  // a second result while the first is still importing isn't blocked for no real reason (the server
  // handles concurrent imports into the same project fine; each gets its own randomized filename).
  const [importingId, setImportingId] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guards against a slow EARLIER search response overwriting a faster LATER one's results — a real
  // risk here specifically because requests are debounced+async and a user can change `kind` or retype
  // before the previous request has even returned.
  const requestIdRef = useRef(0);

  async function runSearch(searchKind: "image" | "video", searchQuery: string, searchPage: number, append: boolean) {
    const trimmed = searchQuery.trim();
    if (!trimmed) {
      setResults([]);
      setHasMore(false);
      setError(null);
      return;
    }
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const { results: newResults, hasMore: more } = await searchStock(searchKind, trimmed, searchPage);
      if (requestId !== requestIdRef.current) return;
      setResults((prev) => (append ? [...prev, ...newResults] : newResults));
      setHasMore(more);
      setPage(searchPage);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err.message : t("Search failed"));
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }

  // Re-searches on every query/kind change, debounced — but NOT on `page` (that's driven by "Load
  // more" calling `runSearch` directly with `append: true`, which would otherwise double-fire here).
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void runSearch(kind, query, 1, false), SEARCH_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, query]);

  async function handlePick(result: StockSearchResult) {
    if (!projectId || importingId) return;
    setImportingId(result.id);
    const asset = await importStockResult(result);
    setImportingId(null);
    if (asset) onAssetAdded?.();
  }

  if (!projectId) return null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex gap-2 border-b border-white/10 px-3 py-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("Search Pixabay…")}
          // 16px below `lg` — same iOS-Safari-auto-zoom reasoning as MediaLibrary's own search input.
          className="min-w-0 flex-1 rounded-md bg-white/5 px-2 py-1 text-[16px] text-white placeholder:text-white/30 focus:outline-none focus:ring-1 focus:ring-sky-400/60 lg:text-xs"
        />
        <div className="flex shrink-0 overflow-hidden rounded-md border border-white/10">
          {(["image", "video"] as const).map((k) => (
            <button
              key={k}
              onClick={() => setKind(k)}
              className={`px-2.5 py-1 text-xs font-medium transition ${
                kind === k ? "bg-sky-500 text-white" : "bg-white/5 text-white/60 hover:bg-white/10"
              }`}
            >
              {k === "image" ? t("Photos") : t("Videos")}
            </button>
          ))}
        </div>
      </div>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-2">
        {!query.trim() ? (
          <p className="px-2 py-8 text-center text-xs leading-relaxed text-white/40">
            {t("Search royalty-free photos and videos from Pixabay.")}
          </p>
        ) : error ? (
          <p className="px-2 py-8 text-center text-xs leading-relaxed text-rose-300">{error}</p>
        ) : results.length === 0 && !loading ? (
          <p className="px-2 py-8 text-center text-xs leading-relaxed text-white/40">{t("Nothing matches that search.")}</p>
        ) : (
          <>
            <ul className="grid grid-cols-2 gap-2">
              {results.map((result) => (
                <li key={result.id}>
                  <button
                    onClick={() => void handlePick(result)}
                    disabled={Boolean(importingId) || importing}
                    title={t("Add to media library")}
                    className="group relative flex w-full flex-col overflow-hidden rounded-lg bg-black/40 text-left transition hover:ring-1 hover:ring-sky-400/60 disabled:cursor-default disabled:opacity-60"
                  >
                    <div className="relative aspect-video w-full overflow-hidden bg-black">
                      {result.kind === "video" ? (
                        <video src={result.previewUrl} muted preload="metadata" className="h-full w-full object-cover" />
                      ) : (
                        <img src={result.previewUrl} alt="" className="h-full w-full object-cover" draggable={false} />
                      )}
                      {importingId === result.id && (
                        <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-[11px] font-medium text-white">
                          {t("Importing…")}
                        </div>
                      )}
                    </div>
                    {/* Pixabay's own API terms require crediting the source wherever results are shown
                        — not just on import — hence this line on every tile, not only after picking
                        one. */}
                    <p className="truncate px-1.5 py-1 text-[10px] text-white/40">
                      {t("by {user} on Pixabay", { user: result.user })}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
            {loading && <p className="py-3 text-center text-[11px] text-white/40">{t("Searching…")}</p>}
            {hasMore && !loading && (
              <button
                onClick={() => void runSearch(kind, query, page + 1, true)}
                className="mt-2 w-full rounded-md bg-white/5 py-1.5 text-xs font-medium text-white/70 transition hover:bg-white/10 hover:text-white"
              >
                {t("Load more")}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
