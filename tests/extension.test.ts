import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { TestContext } from "node:test";
import { setImmediate as flush } from "node:timers/promises";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import codexUsage, { isCodexModel } from "../src/index.ts";
import { model, NOW, payload, plainTheme, token } from "./helpers.ts";

let previousOffline: string | undefined;
beforeEach(() => {
  previousOffline = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = "0";
});
afterEach(() => {
  if (previousOffline === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = previousOffline;
});

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Command = { handler(args: string, ctx: ExtensionCommandContext): Promise<void> };

function harness(t: TestContext, options: { provider?: string; mode?: ExtensionContext["mode"]; endpoint?: string; oauth?: boolean; resolvedEndpoint?: string } = {}) {
  const handlers = new Map<string, Handler>();
  const statuses = new Map<string, string>();
  const notifications: string[] = [];
  let command!: Command;
  let authCalls = 0;
  let fetchCalls = 0;
  let credential = token();
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerCommand: (_name: string, definition: Command) => { command = definition; },
  } as unknown as ExtensionAPI;
  const ctx = {
    mode: options.mode ?? "tui",
    hasUI: options.mode !== "print" && options.mode !== "json",
    model: model(options.provider, undefined, options.endpoint),
    ui: {
      theme: plainTheme,
      setStatus: (key: string, value?: string) => { if (value === undefined) statuses.delete(key); else statuses.set(key, value); },
      notify: (message: string) => notifications.push(message),
    },
    modelRegistry: {
      isUsingOAuth: () => options.oauth !== false,
      getApiKeyAndHeaders: async () => { authCalls++; return { ok: true, apiKey: credential, baseUrl: options.resolvedEndpoint }; },
    },
  } as unknown as ExtensionContext;
  const fetcher: typeof fetch = async () => { fetchCalls++; return Response.json(payload()); };
  t.mock.method(globalThis, "fetch", fetcher);
  codexUsage(pi);
  t.after(() => handlers.get("session_shutdown")?.({}, ctx));
  return {
    ctx, statuses, notifications,
    event: (name: string) => handlers.get(name)?.({}, ctx),
    command: (args = "") => command.handler(args, ctx as ExtensionCommandContext),
    authCalls: () => authCalls,
    fetchCalls: () => fetchCalls,
    setCredential: (value: string) => { credential = value; },
  };
}

test("eligibility depends on provider/API, not a model name containing codex", () => {
  assert.equal(isCodexModel(model()), true);
  assert.equal(isCodexModel(model("openai", "gpt-5.3-codex")), false);
  assert.equal(isCodexModel(model("openrouter", "openai/gpt-5.3-codex")), false);
  assert.equal(isCodexModel(undefined), false);
});

test("factory is inert; TUI startup shows both bars using pi's credentials", async (t) => {
  const h = harness(t);
  assert.equal(h.authCalls(), 0);
  assert.equal(h.fetchCalls(), 0);
  h.event("session_start");
  await h.command();
  assert.equal(h.fetchCalls(), 1);
  assert.equal(h.authCalls(), 2); // Initial resolution plus owner re-check.
  const text = h.statuses.get("codex-usage")!;
  assert.match(text, /5h.*75%.*周.*60%/);
  assert.ok(!text.includes("test-account"));
  assert.ok(!text.includes(token()));
  assert.equal(h.notifications.length, 1);
});

test("each settled conversation refreshes without waiting, but tools and low-level run endings do not", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const h = harness(t);
  h.event("session_start");
  await h.command();
  assert.equal(h.fetchCalls(), 1);
  for (let completed = 0; completed < 3; completed++) {
    h.event("agent_start");
    // Tool turns and retry/continuation boundaries are not a finished reply.
    h.event("turn_end");
    h.event("agent_end");
    await flush();
    assert.equal(h.fetchCalls(), completed + 1);
    // Do not block pi's event handling on the background HTTP request.
    assert.equal(h.event("agent_settled"), undefined);
    await flush();
    assert.equal(h.fetchCalls(), completed + 2);
  }
  assert.equal(h.notifications.length, 1); // No notifications for background refresh.
});

test("model switch hides quota and does not query non-Codex providers", async (t) => {
  const h = harness(t);
  h.event("session_start");
  await h.command();
  h.ctx.model = model("openai");
  h.event("model_select");
  h.event("agent_settled");
  await h.command();
  assert.equal(h.statuses.has("codex-usage"), false);
  assert.equal(h.fetchCalls(), 1);
});

for (const mode of ["print", "json", "rpc"] as const) {
  test(`${mode} mode does not resolve credentials or query quota`, async (t) => {
    const h = harness(t, { mode });
    h.event("session_start");
    h.event("agent_settled");
    await h.command();
    assert.equal(h.authCalls(), 0);
    assert.equal(h.fetchCalls(), 0);
    assert.equal(h.statuses.size, 0);
  });
}

test("does not query API-key credentials or custom proxy endpoints", async (t) => {
  for (const options of [{ oauth: false }, { endpoint: "https://proxy.test" }, { resolvedEndpoint: "https://proxy.test" }]) {
    const h = harness(t, options);
    h.event("session_start");
    await h.command();
    assert.equal(h.fetchCalls(), 0);
    assert.ok(h.statuses.get("codex-usage"));
    h.event("session_shutdown");
  }
});

test("offline mode avoids all auth/network work", async (t) => {
  const h = harness(t);
  process.env.PI_OFFLINE = "1";
  h.event("session_start");
  h.event("agent_settled");
  await h.command();
  assert.equal(h.fetchCalls(), 0);
  assert.equal(h.authCalls(), 0);
  assert.match(h.statuses.get("codex-usage")!, /离线/);
});

test("off and repeated shutdown are safe and clean up the resize listener", async (t) => {
  const before = process.stdout.listenerCount("resize");
  const h = harness(t);
  h.event("session_start");
  await h.command();
  await h.command("off");
  assert.equal(h.statuses.size, 0);
  h.event("agent_settled");
  await h.command("status");
  assert.equal(h.fetchCalls(), 1);
  h.event("session_shutdown");
  h.event("session_shutdown");
  assert.equal(process.stdout.listenerCount("resize"), before);
});
