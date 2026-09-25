import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SaveCoordinator, type SaveOutcome } from "../src/store/saveCoordinator.ts";

/** A hand-cranked clock + a save "server" whose attempts the test resolves explicitly, so every ordering the
 *  real app can produce (edit during a save, failure then retry, close during a save) is exercised without
 *  real time or a network. */
function harness(retryDelaysMs = [1000, 3000]) {
  let now = 0;
  let nextHandle = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const attempts: { resolve: (o: SaveOutcome) => void; savedRevision: number }[] = [];
  const state = { revision: 0, savedRevision: 0 };

  const coordinator = new SaveCoordinator({
    debounceMs: 1500,
    retryDelaysMs,
    isDirty: () => state.savedRevision !== state.revision,
    attempt: () =>
      new Promise<SaveOutcome>((resolve) => {
        const revision = state.revision;
        attempts.push({
          savedRevision: revision,
          resolve: (outcome) => {
            if (outcome === "saved") state.savedRevision = revision; // what was on the wire when it started
            resolve(outcome);
          },
        });
      }),
    setTimer: (fn, ms) => {
      const handle = nextHandle++;
      timers.set(handle, { at: now + ms, fn });
      return handle;
    },
    clearTimer: (handle) => void timers.delete(handle as number),
  });

  return {
    coordinator,
    state,
    attempts,
    edit() {
      state.revision++;
      coordinator.schedule();
    },
    advance(ms: number) {
      now += ms;
      for (const [handle, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(handle);
          timer.fn();
        }
      }
    },
    /** Lets promise continuations run. */
    settle: () => new Promise<void>((r) => setImmediate(r)),
    get pendingTimers() {
      return timers.size;
    },
  };
}

describe("SaveCoordinator", () => {
  it("autosaves once after the quiet period", async () => {
    const h = harness();
    h.edit();
    h.advance(1499);
    assert.equal(h.attempts.length, 0, "not before the debounce");
    h.advance(1);
    assert.equal(h.attempts.length, 1);
    h.attempts[0].resolve("saved");
    await h.settle();
    assert.equal(h.state.savedRevision, h.state.revision);
    assert.equal(h.coordinator.busy, false);
  });

  it("an edit made while a save is in flight is saved right after — not dropped", async () => {
    const h = harness();
    h.edit();
    h.advance(1500); // attempt #1 starts, carrying revision 1
    h.edit(); // revision 2 lands mid-flight (this is the case the old code silently lost)
    h.attempts[0].resolve("saved");
    await h.settle();
    assert.equal(h.attempts.length, 2, "a follow-up save started on its own, without waiting for another edit");
    assert.equal(h.attempts[1].savedRevision, 2);
    h.attempts[1].resolve("saved");
    await h.settle();
    assert.equal(h.state.savedRevision, 2);
    assert.equal(h.coordinator.busy, false);
  });

  it("the debounce firing during an in-flight save joins it instead of starting a second request", async () => {
    const h = harness();
    h.edit();
    h.advance(1500);
    h.edit();
    h.advance(1500); // the second edit's debounce fires while attempt #1 is still pending
    assert.equal(h.attempts.length, 1, "still only one request on the wire");
    h.attempts[0].resolve("saved");
    await h.settle();
    assert.equal(h.attempts.length, 2);
  });

  it("a failed save retries by itself with backoff, and stops once it succeeds", async () => {
    const h = harness([1000, 3000]);
    h.edit();
    h.advance(1500);
    h.attempts[0].resolve("failed");
    await h.settle();
    assert.equal(h.attempts.length, 1);
    h.advance(999);
    assert.equal(h.attempts.length, 1, "waits the first backoff");
    h.advance(1);
    assert.equal(h.attempts.length, 2, "retried with no new edit");
    h.attempts[1].resolve("failed");
    await h.settle();
    h.advance(2999);
    assert.equal(h.attempts.length, 2);
    h.advance(1);
    assert.equal(h.attempts.length, 3, "second backoff is longer");
    h.attempts[2].resolve("saved");
    await h.settle();
    assert.equal(h.state.savedRevision, h.state.revision);
    h.advance(60_000);
    assert.equal(h.attempts.length, 3, "no more retries once clean");
  });

  it("keeps retrying at the last delay while still failing", async () => {
    const h = harness([1000, 3000]);
    h.edit();
    h.advance(1500);
    for (let i = 0; i < 5; i++) {
      h.attempts[i].resolve("failed");
      await h.settle();
      h.advance(3000);
    }
    assert.ok(h.attempts.length >= 6);
  });

  it("does not retry after a fatal outcome (a dead session)", async () => {
    const h = harness();
    h.edit();
    h.advance(1500);
    h.attempts[0].resolve("fatal");
    await h.settle();
    h.advance(120_000);
    assert.equal(h.attempts.length, 1);
    // …but an explicit run() (the banner's "retry after sign-in") goes through.
    void h.coordinator.run();
    assert.equal(h.attempts.length, 2);
  });

  it("flush() skips the quiet period and waits for the save to complete", async () => {
    const h = harness();
    h.edit();
    let done = false;
    const flushed = h.coordinator.flush().then(() => {
      done = true;
    });
    assert.equal(h.attempts.length, 1, "started immediately, no debounce wait");
    await h.settle();
    assert.equal(done, false, "still waiting on the network");
    h.attempts[0].resolve("saved");
    await flushed;
    assert.equal(done, true);
    assert.equal(h.pendingTimers, 0, "the pending autosave timer was cleared");
  });

  it("flush() during an in-flight save also waits for the follow-up save of edits made meanwhile", async () => {
    const h = harness();
    h.edit();
    h.advance(1500); // in flight
    h.edit(); // newer edit while it's on the wire
    let done = false;
    const flushed = h.coordinator.flush().then(() => {
      done = true;
    });
    h.attempts[0].resolve("saved");
    await h.settle();
    assert.equal(done, false, "the newer edit isn't saved yet, so flush keeps waiting");
    assert.equal(h.attempts.length, 2);
    h.attempts[1].resolve("saved");
    await flushed;
    assert.equal(h.state.savedRevision, h.state.revision);
  });

  it("flush() resolves (rather than hanging) when the save fails", async () => {
    const h = harness();
    h.edit();
    const flushed = h.coordinator.flush();
    h.attempts[0].resolve("failed");
    await flushed;
    assert.ok(h.state.savedRevision !== h.state.revision, "still dirty — the retry timer will try again");
  });

  it("flush() when nothing is dirty does nothing", async () => {
    const h = harness();
    await h.coordinator.flush();
    assert.equal(h.attempts.length, 0);
  });

  it("a new edit during a backoff wait saves on the normal debounce instead of waiting out the backoff", async () => {
    const h = harness([30_000]);
    h.edit();
    h.advance(1500);
    h.attempts[0].resolve("failed");
    await h.settle();
    h.edit();
    h.advance(1500);
    assert.equal(h.attempts.length, 2, "did not wait 30s");
  });

  it("cancel() drops timers but leaves an in-flight request alone", async () => {
    const h = harness();
    h.edit();
    h.advance(1500);
    h.edit();
    h.coordinator.cancel();
    assert.equal(h.pendingTimers, 0);
    assert.equal(h.coordinator.busy, true);
    h.attempts[0].resolve("saved");
    await h.settle();
  });
});
