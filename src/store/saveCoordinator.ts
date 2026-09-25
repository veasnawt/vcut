/** The autosave state machine, kept free of the store, the network and real timers so it can be unit-tested.
 *
 *  What it guarantees (each was a real way for an edit to be silently lost before):
 *  - **One save in flight at a time, and never dropped.** A save requested while another is running used to
 *    return immediately, leaving that edit unsaved until some later edit happened to trigger another. Now the
 *    running cycle loops: as soon as an attempt finishes, if anything changed meanwhile it saves again.
 *  - **Failures retry on their own.** A failed save used to wait for the user's next edit. Now it retries with
 *    backoff (and keeps retrying at the last delay) for as long as the project is dirty.
 *  - **`flush()` really waits.** It used to do nothing while a save was in flight, so closing the tab or
 *    switching project raced the network. It now waits for the running cycle — including its follow-up save —
 *    and resolves once the project is clean or a save has failed.
 *
 *  "Fatal" outcomes (a dead session) stop retrying: nothing will succeed until the user signs back in, and the
 *  UI's own banner drives that retry via an explicit `run()`. */

export type SaveOutcome = "saved" | "failed" | "fatal";

export interface SaveCoordinatorOptions {
  /** One attempt to persist the CURRENT project. Must resolve `"saved"` only if what it wrote is still the
   *  latest state or `isDirty()` reports otherwise — the coordinator loops while dirty. */
  attempt: () => Promise<SaveOutcome>;
  isDirty: () => boolean;
  /** Quiet time after the last edit before an autosave fires. */
  debounceMs: number;
  /** Backoff after consecutive failures; the last entry repeats. */
  retryDelaysMs: number[];
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class SaveCoordinator {
  private readonly options: SaveCoordinatorOptions;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private inFlight: Promise<void> | null = null;
  private debounceHandle: unknown = null;
  private retryHandle: unknown = null;
  private consecutiveFailures = 0;

  constructor(options: SaveCoordinatorOptions) {
    this.options = options;
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** Whether a save cycle is running right now. */
  get busy(): boolean {
    return this.inFlight !== null;
  }

  /** Called after every edit: (re)starts the quiet-period timer that triggers an autosave. */
  schedule(): void {
    if (this.debounceHandle !== null) this.clearTimer(this.debounceHandle);
    this.debounceHandle = this.setTimer(() => {
      this.debounceHandle = null;
      void this.run();
    }, this.options.debounceMs);
  }

  /** Starts a save cycle, or — if one is already running — joins it (the running cycle will save again
   *  before it finishes if anything changed). Resolves when the cycle ends. */
  run(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.clearRetry();
    this.inFlight = (async () => {
      try {
        for (;;) {
          const outcome = await this.options.attempt();
          if (outcome === "saved") {
            this.consecutiveFailures = 0;
            // An edit landed while that attempt was on the wire: it isn't saved yet — go again.
            if (this.options.isDirty()) continue;
            return;
          }
          if (outcome === "failed") this.scheduleRetry();
          return;
        }
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  /** Saves right now (skipping the quiet period) and waits until the project is clean or a save fails. Used when
   *  the tab is closing/hiding and when switching projects. */
  async flush(): Promise<void> {
    this.clearDebounce();
    this.clearRetry();
    if (this.inFlight) await this.inFlight;
    if (this.options.isDirty()) await this.run();
  }

  /** Drops any pending timers without saving — for when the project being edited is going away and its
   *  unsaved state is handed off elsewhere. Does not interrupt a request already on the wire. */
  cancel(): void {
    this.clearDebounce();
    this.clearRetry();
  }

  private scheduleRetry(): void {
    const delays = this.options.retryDelaysMs;
    const delay = delays[Math.min(this.consecutiveFailures, delays.length - 1)] ?? 5000;
    this.consecutiveFailures++;
    this.clearRetry();
    this.retryHandle = this.setTimer(() => {
      this.retryHandle = null;
      if (this.options.isDirty()) void this.run();
    }, delay);
  }

  private clearDebounce(): void {
    if (this.debounceHandle !== null) this.clearTimer(this.debounceHandle);
    this.debounceHandle = null;
  }

  private clearRetry(): void {
    if (this.retryHandle !== null) this.clearTimer(this.retryHandle);
    this.retryHandle = null;
  }
}
