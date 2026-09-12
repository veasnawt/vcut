"use client";

import { useEffect, useRef, useState } from "react";
import { Play } from "@veasnawt/vicons";
import { searchStock, type StockSearchResult } from "../api/client.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import { useEditorStore } from "../store/editorStore.ts";

/** How long to wait after the user stops typing before actually searching — Wikimedia asks (its own API
 *  etiquette, not a hard-enforced key/quota the way Pixabay's own key was) for reasonable request rates,
 *  so firing one per keystroke would still be needlessly chatty even with no quota to burn through. */
const SEARCH_DEBOUNCE_MS = 500;

/** Stock photo/video search (Wikimedia Commons — see `stock/route.ts`'s own doc comment for why it
 *  replaced Pixabay) — a self-contained panel, not woven into `MediaLibrary.tsx`'s own already-intricate
 *  drag/touch/native-picker logic, so this stays simple to reason about and can't destabilize the
 *  existing library behavior. Rendered as a sibling MODE of the library (a tab) by `MediaPanel.tsx`,
 *  which owns the tab strip itself — this component starts straight at its own search row, with no
 *  title header of its own, since the tab strip already names it. */
export function StockSearchPanel({ onAssetAdded }: { onAssetAdded?: () => void } = {}) {
  const t = useTranslation();
  const projectId = useEditorStore((s) => s.projectId);
  const importing = useEditorStore((s) => s.importing);
  const importStockResult = useEditorStore((s) => s.importStockResult);
  const addAssetAtPlayhead = useEditorStore((s) => s.addAssetAtPlayhead);

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

  // Picking a result now lands it straight on the timeline (at the playhead), not just into "My
  // Media" for a SECOND step to actually use it — a search result is something the user just decided
  // they want IN the project, so making that take one click instead of two matches how `AiGeneratePanel`
  // tiles behave too (see its own doc comment on the identical change there).
  async function handlePick(result: StockSearchResult) {
    if (!projectId || importingId) return;
    setImportingId(result.id);
    const asset = await importStockResult(result);
    setImportingId(null);
    if (asset) {
      addAssetAtPlayhead(asset.id);
      onAssetAdded?.();
    }
  }

  if (!projectId) return null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Container-query grid: same "respond to THIS PANEL's own width, not the viewport's" reasoning
          `AiGeneratePanel.tsx`'s own identical rule documents — a persistent desktop sidebar and a
          near-full-width mobile sheet render the SAME markup at very different real widths, which a
          plain viewport media query can't tell apart. */}
      <style>{`
        .vcut-stock-grid-container {
          container-type: inline-size;
        }
        .vcut-stock-grid {
          columns: 1;
        }
        @container (min-width: 220px) {
          .vcut-stock-grid {
            columns: 2;
          }
        }
        @container (min-width: 420px) {
          .vcut-stock-grid {
            columns: 3;
          }
        }
      `}</style>

      <div className="flex gap-2 border-b border-white/10 px-3 py-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("Search stock photos and videos…")}
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
            {t("Search openly-licensed photos and videos from Wikimedia Commons.")}
          </p>
        ) : error ? (
          <p className="px-2 py-8 text-center text-xs leading-relaxed text-rose-300">{error}</p>
        ) : results.length === 0 && !loading ? (
          <p className="px-2 py-8 text-center text-xs leading-relaxed text-white/40">{t("Nothing matches that search.")}</p>
        ) : (
          <>
            <div className="vcut-stock-grid-container">
              <div className="vcut-stock-grid gap-2">
                {results.map((result) => (
                  <div key={result.id} className="mb-2 break-inside-avoid">
                    <button
                      onClick={() => void handlePick(result)}
                      disabled={Boolean(importingId) || importing}
                      title={`${result.title}${result.license ? ` · ${result.license}` : ""}`}
                      className="group relative flex w-full flex-col overflow-hidden rounded-lg bg-black/40 text-left transition hover:ring-1 hover:ring-sky-400/60 disabled:cursor-default disabled:opacity-60"
                    >
                      {/* Natural aspect ratio, not a fixed 16:9 crop — Commons results span everything
                          from tall portrait photos to wide landscape video, and forcing all of them into
                          one shape either crops the interesting part out or leaves large letterboxed
                          bars. `max-h-64` caps a very tall/narrow result the same way `AiGeneratePanel`'s
                          own tiles cap a 9:16 generation — see its identical comment for why. */}
                      <div
                        className="relative max-h-64 w-full overflow-hidden bg-black"
                        style={{ aspectRatio: `${result.width} / ${result.height}` }}
                      >
                        {/* Always an `<img>`, never `<video>` — unlike Pixabay's own tiny preview
                            clips, Commons' `previewUrl` for a VIDEO result is a static poster-frame
                            JPEG Commons itself generates (`thumburl` via `iiurlwidth`, same field a
                            photo result's own preview comes from), not a playable file; the real video
                            only exists at `downloadUrl`, fetched once a result is actually picked. */}
                        <img src={result.previewUrl} alt="" className="absolute inset-0 h-full w-full object-cover" draggable={false} />
                        {/* Since the tile above is always a static image now (even for a video
                            result), this is the only visual cue telling the two kinds apart at a
                            glance — the same role `MediaLibrary.tsx`'s own kind badge plays. */}
                        {result.kind === "video" && (
                          <span className="absolute left-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/70 text-white">
                            <Play size={11} />
                          </span>
                        )}
                        {importingId === result.id && (
                          <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-[11px] font-medium text-white">
                            {t("Importing…")}
                          </div>
                        )}
                        {/* Title + attribution overlaid directly on the tile (a bottom gradient scrim,
                            not a separate caption row below it) — Commons' own license terms require
                            crediting the source wherever a result is SHOWN, not just on import, so this
                            can't be hover-only or it wouldn't be visible on touch at all. */}
                        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/40 to-transparent px-1.5 pb-1 pt-4">
                          <p className="truncate text-[10px] font-medium text-white/90">{result.title}</p>
                          <p className="truncate text-[9px] text-white/60">
                            {result.license ? t("{user} · {license}", { user: result.user, license: result.license }) : result.user}
                          </p>
                        </div>
                      </div>
                    </button>
                  </div>
                ))}
              </div>
            </div>
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
