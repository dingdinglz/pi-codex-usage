import { abortable, REFRESH_MS, UsageError } from "./usage.ts";
import type { Credentials, UsageSnapshot } from "./usage.ts";

export interface MonitorState {
  snapshot?: UsageSnapshot;
  error?: UsageError;
  refreshing: boolean;
}

export interface MonitorDependencies {
  credentials(signal: AbortSignal): Promise<Credentials>;
  fetch(credentials: Credentials, signal: AbortSignal): Promise<UsageSnapshot>;
  changed(): void;
  now?: () => number;
  timeoutMs?: number;
}

type Pending = { controller: AbortController; promise: Promise<void> };
type RefreshReason = "poll" | "activity" | "manual";

/** One request at a time; all state is memory-only and scoped to this session. */
export class UsageMonitor {
  readonly state: MonitorState = { refreshing: false };
  private readonly deps: MonitorDependencies;
  private readonly now: () => number;
  private active = false;
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Pending;
  private queuedActivity?: { promise: Promise<void> };
  private ownerKey?: string;
  private lastAttemptAt = -Infinity;
  private nextPollAt = 0;
  private cooldownUntil = 0;
  private failures = 0;

  constructor(deps: MonitorDependencies) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.timer = setInterval(() => {
      this.deps.changed(); // Age/reset labels update even without a network call.
      void this.refresh("poll");
    }, 30_000);
    this.timer.unref();
    void this.refresh("poll");
  }

  stop(): void {
    this.active = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.pending?.controller.abort();
    this.pending = undefined;
    this.queuedActivity = undefined;
    this.ownerKey = undefined;
    this.state.snapshot = undefined;
    if (this.state.error?.code !== "rate-limited") this.state.error = undefined;
    this.state.refreshing = false;
    // Keep attempt/backoff deadlines across model toggles, preventing cycling
    // models (or off/on) from bypassing a server's Retry-After.
    this.deps.changed();
  }

  refresh(reason: RefreshReason = "manual"): Promise<void> {
    if (!this.active) return Promise.resolve();
    if (this.pending) {
      if (reason !== "activity") return this.pending.promise;
      // A query started before the conversation ended may contain old usage.
      // Queue one fresh query after it; coalesce further completions while waiting.
      if (!this.queuedActivity) {
        const queued = { promise: Promise.resolve() };
        this.queuedActivity = queued;
        queued.promise = this.pending.promise.then(() => {
          if (!this.active || this.queuedActivity !== queued) return;
          this.queuedActivity = undefined;
          return this.refresh("activity");
        });
      }
      return this.queuedActivity.promise;
    }
    const now = this.now();
    if (now < this.cooldownUntil) return Promise.resolve();
    if (reason === "poll" && this.state.snapshot && now < this.nextPollAt) return Promise.resolve();
    if (reason !== "manual" && this.failures > 0 && now < this.nextPollAt) return Promise.resolve();
    // Completion refreshes bypass the ordinary interval, but not error backoff
    // or Retry-After. Even a short conversation needs a new quota reading.
    if (reason !== "activity") {
      const minGap = reason === "manual" ? 5_000 : 60_000;
      if (now - this.lastAttemptAt < minGap) return Promise.resolve();
    }

    this.lastAttemptAt = now;
    const pending: Pending = { controller: new AbortController(), promise: Promise.resolve() };
    this.pending = pending;
    this.state.refreshing = true;
    this.deps.changed();
    pending.promise = this.update(pending);
    return pending.promise;
  }

  private async update(pending: Pending): Promise<void> {
    const { signal } = pending.controller;
    const timeout = setTimeout(() => pending.controller.abort(new UsageError("timeout")), this.deps.timeoutMs ?? 15_000);
    timeout.unref();
    const current = () => this.active && this.pending === pending;
    let phase: "auth" | "fetch" = "auth";
    try {
      const credentials = await abortable(() => this.deps.credentials(signal), signal);
      if (!current()) return;
      if (this.ownerKey !== credentials.ownerKey) this.state.snapshot = undefined;
      this.ownerKey = credentials.ownerKey;
      this.deps.changed();

      phase = "fetch";
      const snapshot = await abortable(() => this.deps.fetch(credentials, signal), signal);
      phase = "auth";
      // Login may have changed while the request was running. Do not publish
      // the previous account's quota under the newly selected account.
      const latest = await abortable(() => this.deps.credentials(signal), signal);
      if (!current()) return;
      if (latest.ownerKey !== credentials.ownerKey) throw new UsageError("account-changed");
      this.state.snapshot = snapshot;
      this.state.error = undefined;
      this.failures = 0;
      this.nextPollAt = this.now() + REFRESH_MS;
    } catch (error) {
      if (!current()) return;
      const safeError = signal.aborted && signal.reason instanceof UsageError
        ? signal.reason
        : error instanceof UsageError ? error : new UsageError("network");
      this.state.error = safeError;
      if (phase === "auth" || ["auth", "endpoint", "account", "account-changed"].includes(safeError.code)) {
        this.state.snapshot = undefined;
        this.ownerKey = undefined;
      }
      this.failures = Math.min(this.failures + 1, 4);
      this.nextPollAt = this.now() + Math.min(REFRESH_MS * 2 ** (this.failures - 1), 30 * 60_000);
      if (safeError.code === "rate-limited") {
        this.cooldownUntil = this.now() + (safeError.retryAfterMs ?? REFRESH_MS);
        this.nextPollAt = Math.max(this.nextPollAt, this.cooldownUntil);
      }
    } finally {
      clearTimeout(timeout);
      if (current()) {
        this.pending = undefined;
        this.state.refreshing = false;
        this.deps.changed();
      }
    }
  }
}
