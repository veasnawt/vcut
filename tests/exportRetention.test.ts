import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { selectExpiredExports } from "../../../studios/vcut/app/api/vcut/_lib/exportRetentionRules.ts";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 8, 25, 12);
const file = (name: string, ageHours: number) => ({ path: `/vcut/p1/exports/${name}`, modifiedMs: NOW - ageHours * HOUR });

describe("selectExpiredExports", () => {
  it("selects only files older than the cutoff", () => {
    const expired = selectExpiredExports([file("fresh.mp4", 1), file("edge.mp4", 24), file("old.mp4", 25), file("ancient.mp4", 500)], NOW, 24 * HOUR);
    assert.deepEqual(expired.map((f) => f.path.split("/").pop()), ["old.mp4", "ancient.mp4"]);
  });

  it("never selects an active file, however old", () => {
    const old = file("running.mp4", 100);
    assert.deepEqual(selectExpiredExports([old], NOW, 24 * HOUR, new Set([old.path])), []);
  });

  it("keeps files with bad or future timestamps instead of deleting on bad data", () => {
    assert.deepEqual(selectExpiredExports([{ path: "a", modifiedMs: Number.NaN }, { path: "b", modifiedMs: NOW + HOUR }], NOW, 24 * HOUR), []);
  });

  it("handles an empty list", () => {
    assert.deepEqual(selectExpiredExports([], NOW, 24 * HOUR), []);
  });
});
