/** Pure, DOM-free helpers for `AudioMixEngine` — split out specifically so they get real coverage
 *  under this repo's `node --test` runner, which has no `AudioContext`/DOM available (same reason
 *  `timeline/transitions.ts` keeps its own math pure and standalone). Nothing here touches a real
 *  Web Audio node; `AudioMixEngine` is the one place that does, and is verified by running the app.
 *
 *  Deliberately does NOT include a "precompute the whole transition gain curve up front" helper —
 *  that was the original plan, but `findTransitionOut` returns `null` whenever a genuine successor
 *  clip exists (that boundary belongs to the SUCCESSOR's own `transitionIn`, resolved via its
 *  `partner` field — see `resolveAudioTransitionGain`'s own doc comment), so an outgoing clip's own
 *  fields can never describe a real crossfade's fade-out on their own. `PlaybackEngine.activeAudioClips`
 *  already resolves this correctly, per frame, for BOTH sides of a blend (it's what hands back a
 *  `partner` entry at all) — `AudioMixEngine` reuses that per-frame value directly (a plain
 *  `GainNode.gain` smoothing call, see its own comment) instead of trying to re-derive a static curve
 *  from a single clip's own transition fields, which would silently drop the crossfade's outgoing half. */

/** Whether the difference between where an already-scheduled `AudioBufferSourceNode` SHOULD be (per
 *  the timeline's own clock) and where it actually is (derived from its own `AudioContext.currentTime`
 *  start anchor) is large enough to mean a genuine discontinuity — a scrub, a clip-boundary jump, or
 *  (rare, slow) accumulated drift between the `performance.now()`-based master clock `tick()` still
 *  uses and `AudioContext.currentTime` itself, two independently-precise but not necessarily
 *  perfectly-locked clock sources over a very long session. Unlike the old element-based `syncMedia`,
 *  an `AudioBufferSourceNode` has no per-frame polling loop to misfire — this is only ever consulted
 *  once per tick, and only ever produces a hard restart for a genuinely large gap, never a recurring
 *  self-inflicted correction. */
export function detectRealSeek(expectedSourceTime: number, actualSourceTime: number, tolerance: number): boolean {
  return Math.abs(expectedSourceTime - actualSourceTime) > tolerance;
}

/** Generic LRU eviction — which `key`s to drop, oldest-`lastUsed`-first, once `entries.length` exceeds
 *  `limit`. Extracted from `PlaybackEngine.evictStale()`'s own inline version (that one stays as-is,
 *  operating on its own pool shape) so the new asset-buffer cache can share the identical policy
 *  without a second, near-duplicate implementation. Returns keys to evict, not indices — the caller
 *  owns whatever cleanup (disconnecting nodes, releasing elements) each entry actually needs. */
export function lruEvict(entries: { key: string; lastUsed: number }[], limit: number): string[] {
  if (entries.length <= limit) return [];
  return [...entries]
    .sort((a, b) => a.lastUsed - b.lastUsed)
    .slice(0, entries.length - limit)
    .map((e) => e.key);
}

/** Bytes a decoded `AudioBuffer` occupies: 32-bit floats, one plane per channel. A stereo 48kHz track is about
 *  384KB per second — so a one-hour track is ~1.4GB, enough to crash a phone's tab on its own. */
export function estimateDecodedBytes(durationSeconds: number, sampleRate: number, channels = 2): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  return Math.round(durationSeconds * sampleRate * channels * 4);
}

/** Whether an asset is too large to hold decoded in memory and should be played by an `<audio>` element
 *  (which streams from the file) instead. `null`/unknown duration returns false: with nothing to judge by, the
 *  ordinary decode path (which has its own failure fallback) is used. */
export function shouldStreamInsteadOfDecode(durationSeconds: number | null | undefined, sampleRate: number, thresholdBytes: number): boolean {
  if (durationSeconds === null || durationSeconds === undefined) return false;
  return estimateDecodedBytes(durationSeconds, sampleRate) > thresholdBytes;
}

/** Which cached buffers to drop so the cache fits BOTH a count limit and a byte budget, oldest-used first,
 *  never touching `protectedKeys` or the most recently used entry (buffers a clip is playing from right now — dropping the cache entry would
 *  just force a second decode of the same file mid-playback). The old policy counted buffers only, so twelve
 *  long tracks could pin gigabytes; a byte budget bounds memory whatever the mix of long and short files. If
 *  everything left is protected the cache may exceed its budget rather than evict something in use. */
export function lruEvictByBytes(
  entries: { key: string; lastUsed: number; bytes: number }[],
  maxCount: number,
  maxBytes: number,
  protectedKeys: ReadonlySet<string> = new Set()
): string[] {
  const oldestFirst = [...entries].sort((a, b) => a.lastUsed - b.lastUsed);
  let count = oldestFirst.length;
  let bytes = oldestFirst.reduce((sum, e) => sum + e.bytes, 0);
  const evict: string[] = [];
  // The most recently used entry is never evicted: it is the buffer just requested, and dropping it would only
  // force the same file to be decoded again immediately (a budget smaller than one buffer must not thrash).
  for (const entry of oldestFirst.slice(0, -1)) {
    if (count <= maxCount && bytes <= maxBytes) break;
    if (protectedKeys.has(entry.key)) continue;
    evict.push(entry.key);
    count--;
    bytes -= entry.bytes;
  }
  return evict;
}
