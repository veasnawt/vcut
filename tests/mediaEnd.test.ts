import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { holdMediaAtEnd } from "../src/playback/mediaEnd.ts";

function media(overrides: Partial<HTMLMediaElement> = {}) {
  const state = { duration: 1, currentTime: 1, paused: true, ended: true, seeking: false, readyState: 4, pauses: 0, pause() { this.paused = true; this.pauses++; }, ...overrides };
  return state as typeof state & HTMLMediaElement;
}

describe("exhausted transition media", () => {
  it("holds ended media without seeking away from its final frame", () => {
    const element = media();
    assert.equal(holdMediaAtEnd(element, 1.2), true);
    assert.equal(element.currentTime, 1);
    assert.equal(element.pauses, 0);
  });

  it("pauses and seeks to the final decodable frame when entering an exhausted handle", () => {
    const element = media({ currentTime: 0.1, paused: false, ended: false });
    assert.equal(holdMediaAtEnd(element, 2), true);
    assert.equal(element.pauses, 1);
    assert.ok(element.currentTime > 0.999 && element.currentTime < 1);
    const heldTime = element.currentTime;
    assert.equal(holdMediaAtEnd(element, 2.1), true);
    assert.equal(element.currentTime, heldTime);
    assert.equal(element.pauses, 1);
  });

  it("leaves seeks in flight and playable handles alone; allows rewinding after EOF", () => {
    const seeking = media({ currentTime: 0.2, ended: false, seeking: true });
    assert.equal(holdMediaAtEnd(seeking, 1), true);
    assert.equal(seeking.currentTime, 0.2);
    assert.equal(holdMediaAtEnd(media(), 0.3), false);
    assert.equal(holdMediaAtEnd(media({ duration: NaN }), 1), false);
    assert.equal(holdMediaAtEnd(media({ duration: Infinity }), 1), false);
  });
});
