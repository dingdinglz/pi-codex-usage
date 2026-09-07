import assert from "node:assert/strict";
import { test } from "node:test";
import { abortable, credentialsFromToken, fetchUsage, isOfficialEndpoint, parseUsage, REFRESH_MS, retryAfterMs, USAGE_URL, UsageError } from "../src/usage.ts";
import { credentials, NOW, payload, token } from "./helpers.ts";

const errorCode = (code: string) => (error: unknown) => error instanceof UsageError && error.code === code;

test("derives remaining quota and reset timestamps from server windows", () => {
  const result = parseUsage(payload(), NOW);
  assert.deepEqual(result, {
    fiveHour: { remainingPercent: 75, resetsAt: NOW + 3600_000 },
    weekly: { remainingPercent: 60, resetsAt: NOW + 86400_000 },
    fetchedAt: NOW,
  });
});

test("handles reversed windows and primary-only weekly plans", () => {
  const windows = payload().rate_limit;
  const result = parseUsage({ rate_limit: { primary_window: windows.secondary_window, secondary_window: windows.primary_window } }, NOW);
  assert.equal(result.fiveHour?.remainingPercent, 75);
  assert.equal(result.weekly?.remainingPercent, 60);
  const free = parseUsage({ rate_limit: { primary_window: windows.secondary_window } }, NOW);
  assert.equal(free.fiveHour, undefined);
  assert.equal(free.weekly?.remainingPercent, 60);
});

test("missing/malformed windows never become fabricated 100%", () => {
  for (const limits of [null, {}, { primary_window: { used_percent: null } }, { primary_window: { used_percent: "0" } }]) {
    const result = parseUsage({ rate_limit: limits }, NOW);
    assert.equal(result.fiveHour, undefined);
    assert.equal(result.weekly, undefined);
  }
  for (const value of [null, [], {}, "secret", { rate_limit: "secret" }]) {
    assert.throws(() => parseUsage(value), errorCode("invalid-response"));
  }
});

test("does not label a monthly or other duration as 5h", () => {
  assert.equal(parseUsage({ rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 2592000 } } }).fiveHour, undefined);
});

test("clamps percentages, keeps legitimate zero, and supports relative reset times", () => {
  assert.equal(parseUsage(payload(100, 0), NOW).fiveHour?.remainingPercent, 0);
  assert.equal(parseUsage(payload(130, -5), NOW).weekly?.remainingPercent, 100);
  const result = parseUsage({ rate_limit: { primary_window: { used_percent: 25.5, reset_after_seconds: 60 } } }, NOW);
  assert.deepEqual(result.fiveHour, { remainingPercent: 74.5, resetsAt: NOW + 60_000 });
  assert.equal(parseUsage({ rate_limit: { primary_window: { used_percent: NaN } } }).fiveHour, undefined);
});

test("JWT identity distinguishes accounts/users but survives access-token rotation", () => {
  const original = credentials();
  assert.equal(credentialsFromToken(token("test-account", "test-user", { iat: 42 })).ownerKey, original.ownerKey);
  assert.notEqual(credentials("another-account").ownerKey, original.ownerKey);
  assert.notEqual(credentials("test-account", "another-user").ownerKey, original.ownerKey);
  assert.equal(original.ownerKey.length, 64);
  assert.equal(original.accountId, "test-account");
});

test("rejects API keys, malformed JWTs, and header injection without echoing secrets", () => {
  for (const value of [undefined, "sk-secret-key", "a.e30.signature", "a.bad-json.signature", token("bad\r\nHeader: secret")]) {
    assert.throws(() => credentialsFromToken(value), errorCode("account"));
  }
});

test("only the official HTTPS origin is accepted", () => {
  assert.equal(isOfficialEndpoint("https://chatgpt.com/backend-api"), true);
  for (const url of ["https://chatgpt.com.evil.test", "https://chatgpt.com@evil.test", "http://chatgpt.com", "https://user:pass@chatgpt.com", "https://chatgpt.com:444", "https://proxy.test", "invalid"]) {
    assert.equal(isOfficialEndpoint(url), false, url);
  }
});

test("usage request is fixed-origin GET, with no cookies, redirects, body, or refresh request", async () => {
  let calls = 0;
  const creds = credentials();
  const signal = new AbortController().signal;
  const fetcher: typeof fetch = async (url, init) => {
    calls++;
    assert.equal(url, USAGE_URL);
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.signal, signal);
    assert.equal(init?.body, undefined);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), `Bearer ${creds.accessToken}`);
    assert.equal(headers.get("chatgpt-account-id"), creds.accountId);
    assert.equal(headers.get("cookie"), null);
    return Response.json(payload());
  };
  assert.equal((await fetchUsage(creds, signal, fetcher, () => NOW)).weekly?.remainingPercent, 60);
  assert.equal(calls, 1);
});

test("HTTP errors discard sensitive response bodies and classify authentication/rate limits", async () => {
  for (const [status, code] of [[401, "auth"], [403, "auth"], [429, "rate-limited"], [500, "http"], [302, "http"]] as const) {
    const fetcher: typeof fetch = async () => new Response("secret-token-and-email", { status, headers: { "retry-after": "900" } });
    await assert.rejects(fetchUsage(credentials(), new AbortController().signal, fetcher), (error: unknown) => {
      assert.ok(error instanceof UsageError);
      assert.equal(error.code, code);
      assert.ok(!error.message.includes("secret"));
      if (status === 429) assert.equal(error.retryAfterMs, 900_000);
      return true;
    });
  }
});

test("rejects invalid JSON and oversized bodies", async () => {
  for (const body of ["<html>sign in</html>", "x".repeat(256 * 1024 + 1)]) {
    await assert.rejects(fetchUsage(credentials(), new AbortController().signal, async () => new Response(body)), errorCode("invalid-response"));
  }
});

test("Retry-After supports seconds and HTTP dates", () => {
  assert.equal(retryAfterMs("900", NOW), 900_000);
  assert.equal(retryAfterMs(new Date(NOW + 600_000).toUTCString(), NOW), 600_000);
  assert.equal(retryAfterMs("0", NOW), 60_000);
  assert.equal(retryAfterMs("garbage", NOW), REFRESH_MS);
  assert.equal(retryAfterMs(null, NOW), REFRESH_MS);
});

test("already-aborted requests do not resolve auth or touch the network", async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  await assert.rejects(abortable(async () => { called = true; }, controller.signal));
  await assert.rejects(fetchUsage(credentials(), controller.signal, async () => { called = true; return Response.json(payload()); }));
  assert.equal(called, false);
});

test("abortable cancels waiting on an uncooperative auth facade", async () => {
  const controller = new AbortController();
  const result = abortable(() => new Promise<void>(() => {}), controller.signal);
  controller.abort(new UsageError("timeout"));
  await assert.rejects(result, errorCode("timeout"));
});
