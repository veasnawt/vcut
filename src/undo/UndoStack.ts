import type { Command } from "../commands/types.ts";
import type { Project } from "../project/types.ts";

/** How many edits back a creator can go. Deep enough that undo effectively always works during a
 *  session; bounded so a long session can't grow the stack without limit. Each entry holds only the
 *  clip arrays of the tracks its command touched (see TrackScopedCommand), not whole projects. */
const MAX_DEPTH = 200;

/** Decides whether the project an undo/redo just produced is acceptable — returns a user-facing reason to
 *  refuse it, or `null` to accept. Receives the project before and after so a check can look only at what the
 *  step itself changed. */
export type HistoryGuard = (before: Project, after: Project) => string | null;

/** Thrown when a `HistoryGuard` refuses an undo/redo. The step has already been put back on the stack. */
export class UndoRefusedError extends Error {}

function guard(before: Project, after: Project, accept?: HistoryGuard): void {
  const reason = accept?.(before, after);
  if (reason) throw new UndoRefusedError(reason);
}

/** Command-based undo: the stack stores the COMMANDS that were executed, and undo replays their
 *  inverses. It never stores snapshots of application state, so undoing an edit reverses exactly
 *  that edit and leaves selection, playhead, and zoom alone. */
export class UndoStack {
  private done: Command[] = [];
  private undone: Command[] = [];

  get canUndo(): boolean {
    return this.done.length > 0;
  }

  get canRedo(): boolean {
    return this.undone.length > 0;
  }

  get undoLabel(): string | null {
    return this.done.at(-1)?.label ?? null;
  }

  get redoLabel(): string | null {
    return this.undone.at(-1)?.label ?? null;
  }

  /** Runs a command and records it. If the command throws (an invalid edit — split outside a clip,
   *  locked track), NOTHING is recorded and the project is returned untouched, so a rejected edit
   *  never leaves a no-op sitting in the undo history. */
  execute(project: Project, command: Command): Project {
    const next = command.apply(project);
    this.done.push(command);
    if (this.done.length > MAX_DEPTH) this.done.shift();
    // Any new edit invalidates the redo branch — standard linear-history behavior.
    this.undone = [];
    return next;
  }

  /** Undoes the most recent edit. Never loses history on failure: the command is only moved from "done" to
   *  "undone" once it has run cleanly AND `accept` (if given) has approved the result. If the command throws, or
   *  `accept` returns a reason to refuse, it goes straight back onto the stack where it was and the error is
   *  rethrown (`UndoRefusedError` for a refusal) with `project` untouched — the old code popped the command
   *  first, so one that threw was silently gone from history with the exception left uncaught. */
  undo(project: Project, accept?: HistoryGuard): Project {
    const command = this.done.pop();
    if (!command) return project;
    try {
      const next = command.revert(project);
      guard(project, next, accept);
      this.undone.push(command);
      return next;
    } catch (err) {
      this.done.push(command);
      throw err;
    }
  }

  redo(project: Project, accept?: HistoryGuard): Project {
    const command = this.undone.pop();
    if (!command) return project;
    try {
      const next = command.apply(project);
      guard(project, next, accept);
      this.done.push(command);
      return next;
    } catch (err) {
      this.undone.push(command);
      throw err;
    }
  }

  /** Called after opening a different project — history from the previous one would reference clip
   *  ids that don't exist in the new one. */
  clear(): void {
    this.done = [];
    this.undone = [];
  }
}
