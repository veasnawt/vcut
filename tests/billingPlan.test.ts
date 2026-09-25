import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPlanUpdate, derivePlan } from "../../../studios/vcut/app/api/vcut/_lib/billingPlan.ts";

const LIMITS = { free: 90, pro: 1200 };
const NOW = Date.UTC(2026, 8, 25);
const day = 86400;
const unix = (ms: number) => Math.floor(ms / 1000);

describe("derivePlan (order-independent plan from the customer's subscriptions)", () => {
  it("a customer with no subscriptions is free", () => {
    assert.deepEqual(derivePlan([]), { plan: "free", currentPeriodEnd: null });
  });

  it("active and trialing grant Pro, with the period end as an ISO date", () => {
    const end = unix(NOW) + 30 * day;
    assert.deepEqual(derivePlan([{ status: "active", currentPeriodEnd: end }]), { plan: "pro", currentPeriodEnd: new Date(end * 1000).toISOString() });
    assert.equal(derivePlan([{ status: "trialing", currentPeriodEnd: end }]).plan, "pro");
  });

  it("every other status is free", () => {
    for (const status of ["canceled", "unpaid", "incomplete", "incomplete_expired", "past_due", "paused"]) {
      assert.equal(derivePlan([{ status, currentPeriodEnd: unix(NOW) + day }]).plan, "free", status);
    }
  });

  it("the late-`updated`-after-`deleted` case: judging by the current set, a cancelled sub can't resurrect Pro", () => {
    // Stripe's current state after cancellation: the only subscription is canceled. Whatever stale event just
    // arrived, the derived plan is free.
    assert.equal(derivePlan([{ status: "canceled", currentPeriodEnd: unix(NOW) + day }]).plan, "free");
  });

  it("a resubscribe alongside an old cancelled one is Pro, with the live one's period end", () => {
    const live = unix(NOW) + 20 * day;
    const result = derivePlan([
      { status: "canceled", currentPeriodEnd: unix(NOW) - 5 * day },
      { status: "active", currentPeriodEnd: live },
    ]);
    assert.equal(result.plan, "pro");
    assert.equal(result.currentPeriodEnd, new Date(live * 1000).toISOString());
  });

  it("takes the latest period end when several are active", () => {
    const later = unix(NOW) + 40 * day;
    assert.equal(derivePlan([{ status: "active", currentPeriodEnd: unix(NOW) + day }, { status: "active", currentPeriodEnd: later }]).currentPeriodEnd, new Date(later * 1000).toISOString());
  });

  it("is the same whatever order the same subscriptions arrive in", () => {
    const a = { status: "canceled", currentPeriodEnd: 1000 };
    const b = { status: "active", currentPeriodEnd: 2000 };
    assert.deepEqual(derivePlan([a, b]), derivePlan([b, a]));
  });
});

describe("buildPlanUpdate (when credits may change)", () => {
  const end = new Date(NOW + 30 * day * 1000).toISOString();

  it("a new Pro period tops credits up to the Pro allotment and resets on the period end", () => {
    const update = buildPlanUpdate({ plan: "free", currentPeriodEnd: null }, "pro", end, NOW, LIMITS);
    assert.equal(update.plan, "pro");
    assert.equal(update.credits_remaining, 1200);
    assert.equal(update.credits_reset_at, end);
  });

  it("a redelivered or unrelated event for the SAME period does not top up again", () => {
    const update = buildPlanUpdate({ plan: "pro", currentPeriodEnd: end }, "pro", end, NOW, LIMITS);
    assert.equal("credits_remaining" in update, false);
  });

  it("a renewal (new period end) tops up again", () => {
    const next = new Date(NOW + 60 * day * 1000).toISOString();
    assert.equal(buildPlanUpdate({ plan: "pro", currentPeriodEnd: end }, "pro", next, NOW, LIMITS).credits_remaining, 1200);
  });

  it("a Pro -> free downgrade resets to the free allotment once", () => {
    const update = buildPlanUpdate({ plan: "pro", currentPeriodEnd: end }, "free", null, NOW, LIMITS);
    assert.equal(update.credits_remaining, 90);
    assert.equal(update.plan, "free");
    assert.equal(update.current_period_end, null);
  });

  it("an already-free user is NOT refilled by further non-active events (the old free-credit farm)", () => {
    const update = buildPlanUpdate({ plan: "free", currentPeriodEnd: null }, "free", null, NOW, LIMITS);
    assert.equal("credits_remaining" in update, false);
    assert.equal("credits_reset_at" in update, false);
  });

  it("without an existing row nothing is granted for free", () => {
    assert.equal("credits_remaining" in buildPlanUpdate(null, "free", null, NOW, LIMITS), false);
  });
});
