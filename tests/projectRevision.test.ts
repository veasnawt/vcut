import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkRevision, readRevision, stampRevision } from "../../../studios/vcut/app/api/vcut/_lib/projectRevision.ts";

describe("readRevision", () => {
  it("reads the stored revision, and treats missing / invalid / unreadable as 0", () => {
    assert.equal(readRevision(JSON.stringify({ revision: 7 })), 7);
    assert.equal(readRevision(JSON.stringify({})), 0);
    assert.equal(readRevision(JSON.stringify({ revision: -1 })), 0);
    assert.equal(readRevision(JSON.stringify({ revision: "5" })), 0);
    assert.equal(readRevision(JSON.stringify({ revision: 1.5 })), 0);
    assert.equal(readRevision("not json"), 0);
  });
});

describe("checkRevision", () => {
  it("accepts a save based on the current revision and bumps it", () => {
    assert.deepEqual(checkRevision(5, 5, false), { ok: true, nextRevision: 6 });
  });

  it("refuses a save based on an older revision (another tab saved first)", () => {
    assert.deepEqual(checkRevision(6, 5, false), { ok: false, storedRevision: 6 });
  });

  it("refuses a save based on a NEWER revision than stored too (a stale server / restored backup)", () => {
    assert.equal(checkRevision(3, 9, false).ok, false);
  });

  it("accepts a save with no base revision (older client / native) — it just can't be protected", () => {
    assert.deepEqual(checkRevision(4, undefined, false), { ok: true, nextRevision: 5 });
    assert.deepEqual(checkRevision(4, "5", false), { ok: true, nextRevision: 5 });
  });

  it("force (the user's 'keep my version') overrides a conflict", () => {
    assert.deepEqual(checkRevision(6, 5, true), { ok: true, nextRevision: 7 });
  });

  it("a first save of a project written before revisions existed is accepted from a client that loaded revision 0", () => {
    assert.deepEqual(checkRevision(0, 0, false), { ok: true, nextRevision: 1 });
  });

  it("two tabs: A saves, then B (still on the old base) is refused, then B forcing wins", () => {
    let stored = 0;
    const a = checkRevision(stored, 0, false); // both tabs loaded revision 0
    assert.equal(a.ok, true);
    stored = (a as { nextRevision: number }).nextRevision; // A saved -> 1
    assert.equal(checkRevision(stored, 0, false).ok, false, "B is refused, nothing overwritten");
    const forced = checkRevision(stored, 0, true);
    assert.equal(forced.ok, true);
  });
});

describe("stampRevision", () => {
  it("writes the revision into the project JSON without disturbing anything else", () => {
    const stamped = JSON.parse(stampRevision(JSON.stringify({ id: "p", name: "x", sequence: { tracks: [] } }, null, 2), 12));
    assert.equal(stamped.revision, 12);
    assert.equal(stamped.name, "x");
    assert.deepEqual(stamped.sequence, { tracks: [] });
    assert.equal(readRevision(stampRevision("{}", 3)), 3);
  });
});
