import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pickNewerProject } from "../src/api/nativeStorage.ts";
import { emptyProject } from "./fixture.ts";

describe("pickNewerProject (native crash recovery)", () => {
  const main = { ...emptyProject(), updatedAt: 100 };
  const newer = { ...emptyProject(), updatedAt: 200, name: "from temp" };
  const older = { ...emptyProject(), updatedAt: 50, name: "stale temp" };

  it("keeps the main file when there is no temp copy", () => {
    assert.equal(pickNewerProject(main, null), main);
  });
  it("uses a temp copy from an interrupted save when it is newer", () => {
    assert.equal(pickNewerProject(main, newer), newer);
  });
  it("ignores a stale temp copy", () => {
    assert.equal(pickNewerProject(main, older), main);
  });
  it("does not prefer an equally-old temp copy", () => {
    assert.equal(pickNewerProject(main, { ...newer, updatedAt: 100 }), main);
  });
});
