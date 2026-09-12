import { useEditorStore } from "../store/editorStore.ts";

/** Shared by `MediaLibrary.tsx`/`StockSearchPanel.tsx`/`AiGeneratePanel.tsx`'s own "pick a result"
 *  handlers — decides whether picking `assetId` should land it immediately at the playhead (closing
 *  the mobile sheet right away, same as it always has) or ARM it instead (closing the sheet but
 *  deferring placement until the user positions the playhead and presses Timeline's own "Place at
 *  playhead" button — see `armedAssetId`'s own doc comment in editorStore.ts for the full reasoning on
 *  why arming exists at all).
 *
 *  Only arms when `hasClipsOnTargetTrack` says the target track already has something on it: an EMPTY
 *  track has nothing to aim relative to or risk overlapping, so the extra "move the playhead, then
 *  confirm" step would only slow down the single most common case — the first clip on a fresh project,
 *  or the first clip of a kind landing on a track that only just got created — for no benefit.
 *
 *  `onAssetAdded` being present at all is what distinguishes the mobile sheet's own instance of these
 *  three panels from the permanent desktop column (see `MediaPanel.tsx`) — desktop always places
 *  immediately, Timeline already being visible there, so it's never even asked to arm. */
export function pickAssetForPlacement(assetId: string, onAssetAdded: (() => void) | undefined): void {
  const store = useEditorStore.getState();
  if (onAssetAdded && store.hasClipsOnTargetTrack(assetId)) {
    store.armAsset(assetId);
    onAssetAdded();
    return;
  }
  store.addAssetAtPlayhead(assetId);
  onAssetAdded?.();
}
