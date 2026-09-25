import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HOLD_ORPHAN_AFTER_MS, JobHolds, type HoldRow, type HoldStore } from "../../../studios/vcut/app/api/vcut/_lib/jobHoldsService.ts";

/** An in-memory `HoldStore` with a controllable clock, so "the process died 3 minutes ago" is one line. */
function fakeStore() {
  let now = 1_000_000;
  let seq = 0;
  const rows = new Map<string, HoldRow & { instanceId: string; heartbeatAt: number }>();
  const store: HoldStore = {
    async insert({ userId, feature, amount, instanceId }) {
      const id = `h${++seq}`;
      rows.set(id, { id, userId, feature, amount, instanceId, heartbeatAt: now });
      return id;
    },
    async remove(id) {
      rows.delete(id);
    },
    async heartbeat(instanceId) {
      for (const r of rows.values()) if (r.instanceId === instanceId) r.heartbeatAt = now;
    },
    async findStale(olderThanMs, limit) {
      return [...rows.values()].filter((r) => r.heartbeatAt < now - olderThanMs).slice(0, limit).map(({ id, userId, feature, amount }) => ({ id, userId, feature, amount }));
    },
    async claimStale(id, olderThanMs) {
      const r = rows.get(id);
      if (!r || !(r.heartbeatAt < now - olderThanMs)) return false;
      rows.delete(id);
      return true;
    },
  };
  return { store, rows, advance: (ms: number) => void (now += ms) };
}

function service(instanceId: string, fake = fakeStore(), refunds: [string, number][] = []) {
  const holds = new JobHolds({ store: fake.store, refund: async (u, a) => void refunds.push([u, a]), instanceId, log: () => {} });
  return { holds, fake, refunds };
}

describe("JobHolds", () => {
  it("a job that finishes normally leaves nothing behind and nothing is refunded", async () => {
    const { holds, fake, refunds } = service("A");
    const id = await holds.register("u1", "ai-video", 40);
    assert.equal(fake.rows.size, 1);
    await holds.release(id);
    assert.equal(fake.rows.size, 0);
    fake.advance(HOLD_ORPHAN_AFTER_MS * 3);
    assert.equal(await holds.sweep(), 0);
    assert.deepEqual(refunds, []);
  });

  it("a job whose process died (no heartbeat) is refunded exactly once", async () => {
    const fake = fakeStore();
    const refunds: [string, number][] = [];
    const dead = service("A", fake, refunds).holds;
    const live = service("B", fake, refunds).holds;
    await dead.register("u1", "remove-object", 64);
    fake.advance(HOLD_ORPHAN_AFTER_MS + 1000); // instance A never beats again
    assert.equal(await live.sweep(), 1);
    assert.deepEqual(refunds, [["u1", 64]]);
    assert.equal(await live.sweep(), 0, "and never again");
    assert.deepEqual(refunds, [["u1", 64]]);
  });

  it("does not refund a job whose instance is still alive (rolling deploy: old container still running it)", async () => {
    const fake = fakeStore();
    const refunds: [string, number][] = [];
    const oldContainer = service("old", fake, refunds).holds;
    const newContainer = service("new", fake, refunds).holds;
    await oldContainer.register("u1", "captions", 20);
    for (let i = 0; i < 10; i++) {
      fake.advance(30_000);
      await oldContainer.beat(); // the old container keeps heartbeating its running job
      await newContainer.sweep();
    }
    assert.deepEqual(refunds, [], "a healthy job is never refunded");
    assert.equal(fake.rows.size, 1);
  });

  it("two instances sweeping the same orphan refund it only once", async () => {
    const fake = fakeStore();
    const refunds: [string, number][] = [];
    await service("dead", fake, refunds).holds.register("u1", "ai-video", 40);
    fake.advance(HOLD_ORPHAN_AFTER_MS + 1);
    const a = service("A", fake, refunds).holds;
    const b = service("B", fake, refunds).holds;
    await Promise.all([a.sweep(), b.sweep()]);
    assert.equal(refunds.length, 1);
  });

  it("registers nothing for a missing user or a non-positive amount", async () => {
    const { holds, fake } = service("A");
    assert.equal(await holds.register(undefined, "x", 10), null);
    assert.equal(await holds.register("u1", "x", 0), null);
    assert.equal(fake.rows.size, 0);
  });

  it("a store failure never fails the job — it just runs unprotected", async () => {
    const failing: HoldStore = {
      insert: async () => {
        throw new Error("db down");
      },
      remove: async () => {
        throw new Error("db down");
      },
      heartbeat: async () => {
        throw new Error("db down");
      },
      findStale: async () => {
        throw new Error("db down");
      },
      claimStale: async () => false,
    };
    const holds = new JobHolds({ store: failing, refund: async () => {}, instanceId: "A", log: () => {} });
    assert.equal(await holds.register("u1", "x", 10), null);
    await holds.release("h1");
    await holds.beat();
    assert.equal(await holds.sweep(), 0);
  });

  it("a refund that fails after claiming is logged for manual repair, not retried into a double refund", async () => {
    const fake = fakeStore();
    const logged: string[] = [];
    const dead = new JobHolds({ store: fake.store, refund: async () => {}, instanceId: "dead", log: () => {} });
    await dead.register("u1", "ai-video", 40);
    fake.advance(HOLD_ORPHAN_AFTER_MS + 1);
    const sweeper = new JobHolds({
      store: fake.store,
      refund: async () => {
        throw new Error("rpc down");
      },
      instanceId: "B",
      log: (m) => void logged.push(m),
    });
    assert.equal(await sweeper.sweep(), 0);
    assert.ok(logged.some((m) => m.includes("REFUND FAILED")));
    assert.equal(fake.rows.size, 0, "claimed, so it can't be refunded twice");
  });
});
