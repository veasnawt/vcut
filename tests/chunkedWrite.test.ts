import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chunkRanges, IMPORT_CHUNK_BYTES, writeBlobInChunks, type ChunkedWriteIo } from "../src/api/chunkedWrite.ts";

/** A fake destination that records what was written and how large each piece the encoder saw was. */
function fakeIo(options: { failOnAppend?: number } = {}) {
  const calls: string[] = [];
  const sliceSizes: number[] = [];
  let content = Buffer.alloc(0);
  let appends = 0;
  let discarded = false;
  const io: ChunkedWriteIo = {
    encode: async (slice) => {
      sliceSizes.push(slice.size);
      return Buffer.from(await slice.arrayBuffer()).toString("base64");
    },
    write: async (b64) => {
      calls.push("write");
      content = Buffer.from(b64, "base64");
    },
    append: async (b64) => {
      appends++;
      if (options.failOnAppend === appends) throw new Error("disk full");
      calls.push("append");
      content = Buffer.concat([content, Buffer.from(b64, "base64")]);
    },
    discard: async () => {
      discarded = true;
    },
  };
  return { io, calls, sliceSizes, get content() { return content; }, get discarded() { return discarded; } };
}

describe("chunkRanges", () => {
  it("covers the whole file in order with no gaps or overlaps", () => {
    const ranges = chunkRanges(10, 4);
    assert.deepEqual(ranges, [[0, 4], [4, 8], [8, 10]]);
  });
  it("gives one range for a small file, and one empty range for an empty file (so it still gets created)", () => {
    assert.deepEqual(chunkRanges(3, 4), [[0, 3]]);
    assert.deepEqual(chunkRanges(0, 4), [[0, 0]]);
  });
  it("an exact multiple has no trailing empty range", () => {
    assert.deepEqual(chunkRanges(8, 4), [[0, 4], [4, 8]]);
  });
  it("a 1GB file becomes 256 four-megabyte slices", () => {
    assert.equal(chunkRanges(1024 * 1024 * 1024, IMPORT_CHUNK_BYTES).length, 256);
  });
  it("rejects a non-positive chunk size", () => {
    assert.throws(() => chunkRanges(10, 0));
  });
});

describe("writeBlobInChunks", () => {
  it("reassembles to exactly the original bytes, first slice written and the rest appended", async () => {
    const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
    const fake = fakeIo();
    await writeBlobInChunks(new Blob([bytes]), fake.io, { chunkBytes: 300 });
    assert.deepEqual(fake.calls, ["write", "append", "append", "append"]);
    assert.ok(fake.content.equals(bytes), "byte-for-byte identical");
  });

  it("never encodes more than one chunk's worth at a time (the memory bound the old base64-everything code lacked)", async () => {
    const fake = fakeIo();
    await writeBlobInChunks(new Blob([Buffer.alloc(10_000, 7)]), fake.io, { chunkBytes: 1024 });
    assert.ok(Math.max(...fake.sliceSizes) <= 1024);
    assert.equal(fake.sliceSizes.reduce((a, b) => a + b, 0), 10_000);
  });

  it("reports monotonically increasing progress ending at 1", async () => {
    const seen: number[] = [];
    await writeBlobInChunks(new Blob([Buffer.alloc(1000)]), fakeIo().io, { chunkBytes: 300, onProgress: (f) => seen.push(f) });
    assert.deepEqual(seen.map((f) => Math.round(f * 100) / 100), [0.3, 0.6, 0.9, 1]);
  });

  it("creates the file for an empty blob", async () => {
    const fake = fakeIo();
    await writeBlobInChunks(new Blob([]), fake.io);
    assert.deepEqual(fake.calls, ["write"]);
    assert.equal(fake.content.length, 0);
  });

  it("discards the partial file and rethrows when a later chunk fails", async () => {
    const fake = fakeIo({ failOnAppend: 2 });
    await assert.rejects(writeBlobInChunks(new Blob([Buffer.alloc(1000)]), fake.io, { chunkBytes: 300 }), /disk full/);
    assert.equal(fake.discarded, true, "no truncated media file left behind");
  });

  it("discards when the very first write fails too", async () => {
    let discarded = false;
    const io: ChunkedWriteIo = { encode: async () => "", write: async () => { throw new Error("no space"); }, append: async () => {}, discard: async () => { discarded = true; } };
    await assert.rejects(writeBlobInChunks(new Blob([Buffer.alloc(10)]), io), /no space/);
    assert.equal(discarded, true);
  });
});
