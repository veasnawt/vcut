import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { framePolicy } from "../../../studios/vcut/frame-policy.ts";

describe("framePolicy", () => {
  it("hosted vcut.io can never be framed", () => {
    assert.deepEqual(framePolicy(true), { frameAncestors: "'none'", xFrameOptions: "DENY" });
  });

  it("local / desktop / dev can be framed by loopback origins (BP Studio), and nothing else", () => {
    const { frameAncestors, xFrameOptions } = framePolicy(false);
    assert.equal(xFrameOptions, null, "X-Frame-Options can't allowlist, so it must be absent or it would still block the embed");
    assert.ok(frameAncestors.includes("http://localhost:*") && frameAncestors.includes("http://127.0.0.1:*"));
    assert.ok(frameAncestors.includes("'self'"));
    assert.ok(!frameAncestors.includes("*.") && !/https?:\/\/\*\s|\s\*(\s|$)/.test(frameAncestors), "no wildcard host");
    assert.ok(!frameAncestors.includes("'none'"));
  });
});
