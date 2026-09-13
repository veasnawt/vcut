import { useEffect, useState } from "react";
import { HOSTED, listLibraryMedia, type LibraryMediaItem } from "../api/client.ts";

export interface LibraryMediaState {
  /** `null` until the first fetch resolves (or while disabled) — distinct from `[]`, an empty library,
   *  so a caller can tell "haven't checked yet" apart from "checked, there's genuinely nothing there". */
  items: LibraryMediaItem[] | null;
  loading: boolean;
  usedBytes: number;
  capBytes: number;
  error: string | null;
  /** Optimistically drops one item after a successful delete, and adjusts `usedBytes` by its size —
   *  cheaper than refetching the whole listing, and the two callers (`MediaLibrary.tsx`,
   *  `AiGeneratePanel.tsx`) both already know the exact item and its size at the point they'd call
   *  this. */
  removeLocally: (id: string, sizeBytes: number) => void;
}

/** Fetches the current user's account-wide media library (`GET /api/vcut/media/library`) — every
 *  import, AI generation, and stock download across every one of their projects. Shared by
 *  `MediaLibrary.tsx`'s own "All my media" view and `AiGeneratePanel.tsx`'s own "All my generations"
 *  view: both want the SAME underlying listing, just filtered to a different subset (everything vs.
 *  only items carrying `aiGeneration`) — a shared hook means there's one fetch/loading/error
 *  implementation to keep correct, not two independently-maintained copies.
 *
 *  `enabled`: pass the panel's own "is this view actually showing?" flag (e.g. the toggle state) —
 *  skips the fetch entirely until true, the same "don't fetch what nobody's looking at yet" gate
 *  `useHostedCreditsGate`'s own `HOSTED` check follows for the credits endpoint. Hosted-only: desktop/
 *  local dev has no account for a cross-project library to belong to, so this never fetches there
 *  regardless of `enabled`. */
export function useLibraryMedia(enabled: boolean): LibraryMediaState {
  const [items, setItems] = useState<LibraryMediaItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [usage, setUsage] = useState({ usedBytes: 0, capBytes: 0 });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !HOSTED) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    listLibraryMedia()
      .then((res) => {
        if (cancelled) return;
        setItems(res.items);
        setUsage({ usedBytes: res.usedBytes, capBytes: res.capBytes });
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Could not load your media library");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  function removeLocally(id: string, sizeBytes: number) {
    setItems((prev) => prev?.filter((i) => i.id !== id) ?? null);
    setUsage((u) => ({ ...u, usedBytes: Math.max(0, u.usedBytes - sizeBytes) }));
  }

  return { items, loading, usedBytes: usage.usedBytes, capBytes: usage.capBytes, error, removeLocally };
}
