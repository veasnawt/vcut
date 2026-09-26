import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AI_EDIT_CATEGORIES,
  AI_EDIT_IMAGE_CREDITS,
  AI_EDIT_QUICK_STYLES,
  AI_EDIT_TEMPLATES,
  aiEditVideoCredits,
  buildAiEditInstruction,
  clampCreativity,
  creativityFromStrength,
  enhancePrompt,
  promptHasPhrase,
  surprisePrompt,
  templatesInCategory,
  togglePhrase,
} from "../src/project/aiEdit.ts";
import { estimateAiStepCredits } from "../src/project/aiRecipe.ts";

describe("AI Edit instruction", () => {
  it("adds what to keep and how far to go", () => {
    const text = buildAiEditInstruction("turn into anime", { preserve: ["face", "background"], creativity: 10 });
    assert.match(text, /^turn into anime\./);
    assert.match(text, /face, identity/);
    assert.match(text, /background unchanged/);
    assert.doesNotMatch(text, /outfit|clothing/);
    assert.match(text, /subtle, faithful/);
  });
  it("is bold at the imaginative end, plain in the middle, and mentions motion for video", () => {
    assert.match(buildAiEditInstruction("x", { preserve: [], creativity: 90 }), /bold and imaginative/);
    assert.equal(buildAiEditInstruction("x", { preserve: [], creativity: 50 }), "x.");
    assert.match(buildAiEditInstruction("x", { preserve: [], creativity: 50 }, "video"), /original motion/);
  });
  it("maps old strengths onto the slider and clamps bad values", () => {
    assert.equal(creativityFromStrength("subtle"), 20);
    assert.equal(creativityFromStrength(undefined), 50);
    assert.equal(creativityFromStrength("creative"), 80);
    assert.equal(clampCreativity(500), 100);
    assert.equal(clampCreativity(-3), 0);
    assert.equal(clampCreativity("x"), 50);
  });
});

describe("AI Edit prices", () => {
  it("charges per second for video and the flat price for a picture", () => {
    assert.equal(aiEditVideoCredits(5), 150);
    assert.equal(aiEditVideoCredits(4.2), 150);
    assert.equal(aiEditVideoCredits(0.5), 60);
    const step = { tool: "ai-edit" as const, prompt: "x" };
    assert.equal(estimateAiStepCredits(step, 0, true), AI_EDIT_IMAGE_CREDITS);
    assert.equal(estimateAiStepCredits(step, 5, false), 150);
  });
});

describe("AI Edit templates and styles", () => {
  it("every template is well formed and every category has some", () => {
    const ids = new Set<string>();
    for (const t of AI_EDIT_TEMPLATES) {
      assert.ok(!ids.has(t.id), `duplicate id ${t.id}`);
      ids.add(t.id);
      assert.ok(t.title && t.description && t.prompt.length > 20 && t.look.filter && t.look.tint);
      assert.ok(AI_EDIT_CATEGORIES.some((c) => c.id === t.category), `unknown category ${t.category}`);
    }
    for (const c of AI_EDIT_CATEGORIES) assert.ok(templatesInCategory(c.id).length >= 2, `${c.id} is nearly empty`);
  });
  it("toggles a quick style in and out of the prompt", () => {
    const style = AI_EDIT_QUICK_STYLES[0];
    const on = togglePhrase("a portrait", style.phrase);
    assert.ok(promptHasPhrase(on, style.phrase));
    assert.equal(togglePhrase(on, style.phrase), "a portrait");
    assert.equal(togglePhrase("", "in anime style"), "In anime style");
  });
  it("enhances a prompt without touching an empty one, and surprise picks something new", () => {
    assert.equal(enhancePrompt("  ", { preserve: [], creativity: 50 }), "");
    const better = enhancePrompt("add snow", { preserve: ["face"], creativity: 50 });
    assert.match(better, /^add snow, keeping the face the same, /);
    const current = AI_EDIT_TEMPLATES[0].prompt;
    for (let i = 0; i < 20; i++) assert.notEqual(surprisePrompt(current, () => i / 20), current);
  });
});
