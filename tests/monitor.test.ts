import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { UsageMonitor } from "../src/monitor.ts";
import type { MonitorDependencies } from "../src/monitor.ts";
import { parseUsage, REFRESH_MS, UsageError } from "../src/usage.ts";
import type { UsageSnapshot } from "../src/usage.ts";
import { credentials, deferred, NOW, payload } from "./helpers.ts";

function setup(t: TestContext, overrides: Partial<MonitorDependencies> = {}) {
  let now = NOW;
  let calls = 0;
  let changes = 0;
  const monitor = new UsageMonitor({
    credentials: async () => credentials(),
    fetch: async () => { calls++; return parseUsage(payload(), now); },
    changed: () => { changes++; },
    now: () => now,
    ...overrides,
  });
  t.after(() => monitor.stop());
  return { monitor, advance: (ms: number) => { now += ms; }, calls: () => calls, changes: () => changes };
}

test("no work before start; one immediate refresh when activated", async (t) => {
  const { monitor, calls } = setup(t);
  await monitor.refresh();
  assert.equal(calls(), 0);
  monitor.start();
  await monitor.refresh();
  assert.equal(calls(), 1);
  assert.equal(monitor.state.snapshot?.fiveHour?.remainingPercent, 75);
  monitor.start();
  await monitor.refresh();
  assert.equal(calls(), 1);
});

test("coalesces requests and preserves poll/manual cadence", async (t) => {
  const { monitor, calls, advance } = setup(t);
  monitor.start();
  const first = monitor.refresh();
  assert.equal(first, monitor.refresh());
  await first;
  advance(4_999);
  await monitor.refresh();
  assert.equal(calls(), 1);
  advance(1);
  await monitor.refresh();
  assert.equal(calls(), 2);
  advance(60_000);
  await monitor.refresh("poll");
  assert.equal(calls(), 2);
  advance(REFRESH_MS);
  await monitor.refresh("poll");
  assert.equal(calls(), 3);
});

test("every completed conversation refreshes even immediately after a successful query", async (t) => {
  const { monitor, calls, advance } = setup(t);
  monitor.start();
  await monitor.refresh();
  // Same clock value: neither a recent poll nor another completion may skip it.
  await monitor.refresh("activity");
  assert.equal(calls(), 2);
  await monitor.refresh("activity");
  assert.equal(calls(), 3);
  advance(5_000);
  await monitor.refresh("manual");
  assert.equal(calls(), 4);
  await monitor.refresh("activity");
  assert.equal(calls(), 5);
  await monitor.refresh("poll");
  assert.equal(calls(), 5);
  advance(REFRESH_MS);
  await monitor.refresh("poll");
  assert.equal(calls(), 6);
});

test("completion during an in-flight query queues one fresh follow-up instead of reusing old data", async (t) => {
  const response = deferred<UsageSnapshot>();
  const fetching = deferred<void>();
  let calls = 0;
  const { monitor } = setup(t, { fetch: async () => {
    calls++;
    if (calls === 1) {
      fetching.resolve();
      return response.promise;
    }
    return parseUsage(payload(90, 90), NOW);
  } });
  monitor.start();
  const first = monitor.refresh("poll");
  await fetching.promise;
  const afterCompletion = monitor.refresh("activity");
  assert.notEqual(afterCompletion, first);
  assert.equal(afterCompletion, monitor.refresh("activity"));
  assert.equal(calls, 1);
  response.resolve(parseUsage(payload(), NOW));
  await Promise.all([first, afterCompletion]);
  assert.equal(calls, 2);
  assert.equal(monitor.state.snapshot?.fiveHour?.remainingPercent, 10);
  assert.equal(monitor.state.refreshing, false);
});

test("queued completion refresh respects failures and Retry-After from the in-flight query", async (t) => {
  for (const error of [new UsageError("network"), new UsageError("rate-limited", 900_000)]) {
    const response = deferred<UsageSnapshot>();
    const fetching = deferred<void>();
    let calls = 0;
    const { monitor, advance } = setup(t, { fetch: async () => {
      calls++;
      if (calls === 1) {
        fetching.resolve();
        return response.promise;
      }
      return parseUsage(payload(), NOW);
    } });
    monitor.start();
    await fetching.promise;
    const afterCompletion = monitor.refresh("activity");
    response.reject(error);
    await afterCompletion;
    assert.equal(calls, 1);
    assert.equal(monitor.state.error?.code, error.code);
    advance(60_000);
    await monitor.refresh("activity");
    assert.equal(calls, 1);
    advance(error.retryAfterMs ?? REFRESH_MS);
    await monitor.refresh("activity");
    assert.equal(calls, 2);
    monitor.stop();
  }
});

test("network failure retains same-owner data and backs off automatic refresh", async (t) => {
  let fail = false;
  let calls = 0;
  const { monitor, advance } = setup(t, { fetch: async () => {
    calls++;
    if (fail) throw new Error("sensitive-token-in-a-network-error");
    return parseUsage(payload(), NOW);
  } });
  monitor.start();
  await monitor.refresh();
  const previous = monitor.state.snapshot;
  fail = true;
  advance(60_000);
  await monitor.refresh("activity");
  assert.equal(monitor.state.snapshot, previous);
  assert.equal(monitor.state.error?.code, "network");
  assert.ok(!monitor.state.error?.message.includes("sensitive"));
  advance(60_000);
  await monitor.refresh("activity");
  assert.equal(calls, 2);
  advance(REFRESH_MS);
  await monitor.refresh("poll");
  assert.equal(calls, 3);
});

test("new account plus network failure never inherits previous-account quota", async (t) => {
  let account = "a";
  const { monitor, advance } = setup(t, {
    credentials: async () => credentials(account),
    fetch: async () => {
      if (account === "b") throw new UsageError("network");
      return parseUsage(payload(), NOW);
    },
  });
  monitor.start();
  await monitor.refresh();
  account = "b";
  advance(60_000);
  await monitor.refresh();
  assert.equal(monitor.state.snapshot, undefined);
});

test("account switch while a response is in flight discards that response", async (t) => {
  let account = "a";
  const response = deferred<UsageSnapshot>();
  const fetching = deferred<void>();
  const { monitor } = setup(t, {
    credentials: async () => credentials(account),
    fetch: async () => { fetching.resolve(); return response.promise; },
  });
  monitor.start();
  const request = monitor.refresh();
  await fetching.promise;
  account = "b";
  response.resolve(parseUsage(payload(), NOW));
  await request;
  assert.equal(monitor.state.snapshot, undefined);
  assert.equal(monitor.state.error?.code, "account-changed");
});

test("authentication failures clear cached quota", async (t) => {
  let loggedIn = true;
  const { monitor, advance } = setup(t, { credentials: async () => {
    if (!loggedIn) throw new UsageError("auth");
    return credentials();
  } });
  monitor.start();
  await monitor.refresh();
  loggedIn = false;
  advance(60_000);
  await monitor.refresh();
  assert.equal(monitor.state.snapshot, undefined);
  assert.equal(monitor.state.error?.code, "auth");
});

test("unknown auth failures cannot relabel cached quota as the current account", async (t) => {
  let fail = false;
  const { monitor, advance } = setup(t, { credentials: async () => {
    if (fail) throw new Error("sensitive auth exception");
    return credentials();
  } });
  monitor.start();
  await monitor.refresh();
  fail = true;
  advance(60_000);
  await monitor.refresh();
  assert.equal(monitor.state.snapshot, undefined);
  assert.ok(!monitor.state.error?.message.includes("sensitive"));
});

test("Retry-After applies to manual/completion requests and survives stop/start", async (t) => {
  let calls = 0;
  const { monitor, advance } = setup(t, { fetch: async () => {
    calls++;
    throw new UsageError("rate-limited", 900_000);
  } });
  monitor.start();
  await monitor.refresh();
  advance(REFRESH_MS);
  await monitor.refresh();
  await monitor.refresh("activity");
  monitor.stop();
  monitor.start();
  await monitor.refresh();
  await monitor.refresh("activity");
  assert.equal(calls, 1);
  assert.equal(monitor.state.error?.code, "rate-limited");
  advance(600_000);
  await monitor.refresh();
  assert.equal(calls, 2);
});

test("stop cancels queued completion work; late results cannot affect a restarted monitor", async (t) => {
  const oldResponse = deferred<UsageSnapshot>();
  const fetching = deferred<void>();
  let oldSignal: AbortSignal | undefined;
  let first = true;
  let calls = 0;
  const { monitor, advance } = setup(t, { fetch: async (_creds, signal) => {
    calls++;
    if (first) {
      first = false;
      oldSignal = signal;
      fetching.resolve();
      return oldResponse.promise;
    }
    return parseUsage(payload(90, 90), NOW);
  } });
  monitor.start();
  const oldRequest = monitor.refresh();
  await fetching.promise;
  const queuedCompletion = monitor.refresh("activity");
  monitor.stop();
  assert.equal(oldSignal?.aborted, true);
  const stoppedSnapshot = monitor.state.snapshot;
  assert.equal(stoppedSnapshot, undefined);
  advance(60_000);
  monitor.start();
  await monitor.refresh();
  oldResponse.resolve(parseUsage(payload(1, 1), NOW));
  await Promise.all([oldRequest, queuedCompletion]);
  assert.equal(calls, 2);
  assert.equal(monitor.state.snapshot?.fiveHour?.remainingPercent, 10);
  assert.equal(monitor.state.refreshing, false);
});

test("returning to Codex can refresh after the minimum gap, not a full poll interval", async (t) => {
  const { monitor, advance, calls } = setup(t);
  monitor.start();
  await monitor.refresh();
  monitor.stop();
  advance(60_000);
  monitor.start();
  await monitor.refresh();
  assert.equal(calls(), 2);
});

test("late credentials after a timeout never initiate a quota request", async (t) => {
  const auth = deferred<ReturnType<typeof credentials>>();
  const { monitor, calls } = setup(t, { timeoutMs: 10, credentials: () => auth.promise });
  monitor.start();
  const request = monitor.refresh();
  await sleep(30);
  await request;
  auth.resolve(credentials());
  await sleep(0);
  assert.equal(calls(), 0);
  assert.equal(monitor.state.error?.code, "timeout");
});

test("timer refreshes on schedule and is disposed on stop", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { monitor, advance, calls } = setup(t);
  monitor.start();
  await monitor.refresh();
  advance(REFRESH_MS);
  t.mock.timers.tick(REFRESH_MS);
  await monitor.refresh("poll");
  assert.equal(calls(), 2);
  monitor.stop();
  advance(REFRESH_MS);
  t.mock.timers.tick(REFRESH_MS);
  await monitor.refresh("poll");
  assert.equal(calls(), 2);
});

test("auth and HTTP hangs have a deadline and never leave the UI loading forever", async (t) => {
  for (const stage of ["credentials", "fetch"] as const) {
    const { monitor } = setup(t, { timeoutMs: 10, [stage]: () => new Promise<never>(() => {}) });
    monitor.start();
    const request = monitor.refresh();
    // Keep the test process alive while the production timer remains unref'ed.
    await sleep(30);
    await request;
    assert.equal(monitor.state.error?.code, "timeout");
    assert.equal(monitor.state.refreshing, false);
    monitor.stop();
  }
});
