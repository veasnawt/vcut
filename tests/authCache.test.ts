import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { jwtExpiryMs, OWNERSHIP_TTL_MS, SESSION_TTL_MS, sessionCacheTtlMs, tokenKey, TtlCache } from "../../../studios/vcut/app/api/vcut/_lib/authCache.ts";

function jwt(payload: object): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256" })}.${b64(payload)}.signature`;
}

describe("TtlCache", () => {
  it("returns a value until its TTL passes, then forgets it", () => {
    let now = 1000;
    const cache = new TtlCache<string>({ now: () => now });
    cache.set("k", "v", 500);
    assert.equal(cache.get("k"), "v");
    now = 1499;
    assert.equal(cache.get("k"), "v");
    now = 1500;
    assert.equal(cache.get("k"), undefined, "expires exactly at the TTL");
    assert.equal(cache.size, 0, "and is removed, not just hidden");
  });

  it("does not store anything with a zero or negative TTL (an already-expired token)", () => {
    const cache = new TtlCache<string>();
    cache.set("k", "v", 0);
    cache.set("j", "v", -5);
    assert.equal(cache.size, 0);
  });

  it("is bounded: at capacity it drops expired entries first, then the oldest", () => {
    let now = 0;
    const cache = new TtlCache<number>({ now: () => now, maxEntries: 3 });
    cache.set("a", 1, 100);
    cache.set("b", 2, 10_000);
    cache.set("c", 3, 10_000);
    now = 200; // "a" has expired
    cache.set("d", 4, 10_000);
    assert.equal(cache.get("a"), undefined);
    assert.equal(cache.get("b"), 2, "the live entries survived");
    cache.set("e", 5, 10_000); // full of live entries now: the oldest goes
    assert.equal(cache.size, 3);
    assert.equal(cache.get("b"), undefined);
    assert.equal(cache.get("e"), 5);
  });

  it("deleteWhere removes matching keys only", () => {
    const cache = new TtlCache<true>();
    cache.set("u1:p1", true, 1000);
    cache.set("u2:p1", true, 1000);
    cache.set("u1:p2", true, 1000);
    cache.deleteWhere((key) => key.endsWith(":p1"));
    assert.equal(cache.get("u1:p1"), undefined);
    assert.equal(cache.get("u2:p1"), undefined);
    assert.equal(cache.get("u1:p2"), true);
  });
});

describe("session cache lifetime", () => {
  it("caches for the standard TTL when the token is comfortably valid", () => {
    const now = Date.UTC(2026, 8, 25);
    assert.equal(sessionCacheTtlMs(jwt({ exp: Math.floor(now / 1000) + 3600 }), now), SESSION_TTL_MS);
  });

  it("never outlives the token: a token expiring in 5s is cached for at most 5s", () => {
    const now = Date.UTC(2026, 8, 25);
    assert.equal(sessionCacheTtlMs(jwt({ exp: Math.floor(now / 1000) + 5 }), now), 5000);
  });

  it("does not cache an already-expired token at all", () => {
    const now = Date.UTC(2026, 8, 25);
    assert.equal(sessionCacheTtlMs(jwt({ exp: Math.floor(now / 1000) - 10 }), now), 0);
  });

  it("falls back to the standard TTL when the token has no readable expiry", () => {
    assert.equal(jwtExpiryMs("not-a-jwt"), null);
    assert.equal(jwtExpiryMs(jwt({ sub: "x" })), null);
    assert.equal(sessionCacheTtlMs("not-a-jwt", Date.now()), SESSION_TTL_MS);
  });

  it("keeps the session window short (revocation lag) and the ownership window modest", () => {
    assert.ok(SESSION_TTL_MS <= 60_000);
    assert.ok(OWNERSHIP_TTL_MS <= 300_000);
  });
});

describe("tokenKey", () => {
  it("is deterministic, differs per token, and never contains the token", async () => {
    const token = "eyJsecret.payload.sig";
    const a = await tokenKey(token);
    assert.equal(a, await tokenKey(token));
    assert.notEqual(a, await tokenKey(token + "x"));
    assert.ok(!a.includes("secret") && !a.includes(token));
  });
});
