/** Writes a large `Blob` to storage a slice at a time, so importing a big video on a phone never holds the whole
 *  file in JS memory at once.
 *
 *  The old import read the ENTIRE file into one base64 string (about 1.33x the file size, on top of the file
 *  itself) and handed it to `Filesystem.writeFile` in a single call — a multi-hundred-megabyte video therefore
 *  needed several times its own size in memory and could take the app down. Here only one slice (and its base64
 *  form) exists at a time, appended to the destination as it goes. Pure and storage-agnostic (the caller supplies
 *  the write/append/encode functions) so the chunking itself is unit-testable. */

/** 4MB per slice: large enough that the per-call overhead of the native bridge is negligible, small enough that a
 *  slice plus its base64 copy (~5.3MB) is trivial memory even on a low-end phone. */
export const IMPORT_CHUNK_BYTES = 4 * 1024 * 1024;

export interface ChunkedWriteIo {
  /** Creates (or truncates) the destination with its first chunk. */
  write(base64: string): Promise<void>;
  /** Appends a further chunk. */
  append(base64: string): Promise<void>;
  /** Base64 of one slice of the source (no `data:` prefix). */
  encode(slice: Blob): Promise<string>;
  /** Called after a failure so a half-written file isn't left behind. */
  discard?(): Promise<void>;
}

/** The `[start, end)` byte ranges covering `size` bytes in `chunkBytes` pieces (at least one range, so an empty
 *  file still gets created). */
export function chunkRanges(size: number, chunkBytes = IMPORT_CHUNK_BYTES): [number, number][] {
  if (!(chunkBytes > 0)) throw new Error("chunkBytes must be positive");
  if (size <= 0) return [[0, 0]];
  const ranges: [number, number][] = [];
  for (let start = 0; start < size; start += chunkBytes) ranges.push([start, Math.min(size, start + chunkBytes)]);
  return ranges;
}

/** Copies `blob` through `io` slice by slice. On any failure the partial destination is discarded and the error
 *  rethrown, so a failed import never leaves a truncated media file behind. `onProgress` gets 0..1 after each
 *  slice. */
export async function writeBlobInChunks(blob: Blob, io: ChunkedWriteIo, options: { chunkBytes?: number; onProgress?: (fraction: number) => void } = {}): Promise<void> {
  const ranges = chunkRanges(blob.size, options.chunkBytes);
  try {
    for (let i = 0; i < ranges.length; i++) {
      const [start, end] = ranges[i];
      const encoded = await io.encode(blob.slice(start, end));
      if (i === 0) await io.write(encoded);
      else await io.append(encoded);
      options.onProgress?.(blob.size > 0 ? end / blob.size : 1);
    }
  } catch (err) {
    await io.discard?.().catch(() => {});
    throw err;
  }
}
