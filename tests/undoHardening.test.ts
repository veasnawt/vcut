import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AddClipCommand, DeleteClipsCommand } from "../src/commands/index.ts";
import type { Command } from "../src/commands/types.ts";
import { orphanedClipIds, refuseOrphanedClips } from "../src/undo/historyGuards.ts";
import { UndoRefusedError, UndoStack } from "../src/undo/UndoStack.ts";
import { clipsOf, emptyProject, videoTrackId } from "./fixture.ts";

function throwingCommand(when: "apply" | "revert"): Command {
  return {
    label: "Boom",
    apply(project) {
      if (when === "apply") throw new Error("apply failed");
      return { ...project, name: "applied" };
    },
    revert(project) {
      if (when === "revert") throw new Error("revert failed");
      return { ...project, name: "reverted" };
    },
  };
}

describe("UndoStack keeps its history when a step fails", () => {
  it("a command whose undo throws stays on the stack (it used to be silently lost)", () => {
    const stack = new UndoStack();
    const project = emptyProject();
    stack.execute(project, throwingCommand("revert"));
    assert.throws(() => stack.undo(project), /revert failed/);
    assert.equal(stack.canUndo, true, "still undoable");
    assert.equal(stack.canRedo, false, "and not misfiled as redoable");
    assert.equal(stack.undoLabel, "Boom");
  });

  it("a command whose redo throws goes back onto the redo stack", () => {
    const stack = new UndoStack();
    const project = emptyProject();
    // apply succeeds once (execute), fails when redone
    let calls = 0;
    const flaky: Command = {
      label: "Flaky",
      apply(p) {
        if (++calls > 1) throw new Error("second apply failed");
        return p;
      },
      revert: (p) => p,
    };
    stack.execute(project, flaky);
    stack.undo(project);
    assert.throws(() => stack.redo(project), /second apply failed/);
    assert.equal(stack.canRedo, true);
    assert.equal(stack.canUndo, false);
  });

  it("order is preserved after a failed undo: the next undo still hits the same command", () => {
    const stack = new UndoStack();
    const project = emptyProject();
    stack.execute(project, { label: "First", apply: (p) => p, revert: (p) => ({ ...p, name: "first-reverted" }) });
    stack.execute(project, throwingCommand("revert"));
    assert.throws(() => stack.undo(project));
    assert.equal(stack.undoLabel, "Boom");
  });
});

describe("refuseOrphanedClips (undoing a delete after the clip's media was removed)", () => {
  function deletedThenMediaRemoved() {
    const base = emptyProject();
    const track = videoTrackId(base);
    const stack = new UndoStack();
    let project = stack.execute(base, new AddClipCommand(track, "asset1", 0));
    const clipId = clipsOf(project, track)[0].id;
    project = stack.execute(project, new DeleteClipsCommand([clipId]));
    // The user removes the media from the library (not an undoable step).
    project = { ...project, assets: project.assets.filter((a) => a.id !== "asset1") };
    return { stack, project, track, clipId };
  }

  it("refuses the undo instead of resurrecting a clip that points at a missing asset", () => {
    const { stack, project } = deletedThenMediaRemoved();
    assert.throws(() => stack.undo(project, refuseOrphanedClips), UndoRefusedError);
    assert.equal(stack.undoLabel, "Delete", "the delete is still on the stack");
    assert.deepEqual(orphanedClipIds(project), [], "and the project was left untouched");
  });

  it("allows the same undo while the media is still there", () => {
    const base = emptyProject();
    const track = videoTrackId(base);
    const stack = new UndoStack();
    let project = stack.execute(base, new AddClipCommand(track, "asset1", 0));
    const clipId = clipsOf(project, track)[0].id;
    project = stack.execute(project, new DeleteClipsCommand([clipId]));
    const restored = stack.undo(project, refuseOrphanedClips);
    assert.equal(clipsOf(restored, track).length, 1);
  });

  it("does not block undo because of orphans that were ALREADY in the project", () => {
    const base = emptyProject();
    const track = videoTrackId(base);
    const stack = new UndoStack();
    let project = stack.execute(base, new AddClipCommand(track, "asset1", 0));
    project = stack.execute(project, new AddClipCommand(track, "asset1", 20));
    // Media removed while both clips are still on the timeline (older / hand-edited data): both are orphaned.
    project = { ...project, assets: project.assets.filter((a) => a.id !== "asset1") };
    assert.equal(orphanedClipIds(project).length, 2);
    const undone = stack.undo(project, refuseOrphanedClips);
    assert.equal(orphanedClipIds(undone).length, 1, "the undo itself introduced nothing new, so it goes through");
  });

  it("guards redo too", () => {
    const base = emptyProject();
    const track = videoTrackId(base);
    const stack = new UndoStack();
    let project = stack.execute(base, new AddClipCommand(track, "asset1", 0));
    project = stack.undo(project); // clip gone; "add" is now redoable
    project = { ...project, assets: project.assets.filter((a) => a.id !== "asset1") };
    // Re-adding a clip for missing media is refused by the command itself (an EditError) — either way the step
    // must stay redoable rather than vanish.
    assert.throws(() => stack.redo(project, refuseOrphanedClips), /no longer in the project|removed/);
    assert.equal(stack.canRedo, true, "still redoable if the media comes back");
  });
});
