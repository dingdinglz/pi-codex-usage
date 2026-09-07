import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { credentialsFromToken } from "../src/usage.ts";

export const NOW = 1_800_000_000_000;
export const plainTheme = { fg: (_color: string, text: string) => text };

export function token(accountId = "test-account", sub = "test-user", extra = {}): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({
    sub,
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    ...extra,
  })}.fixture-signature`;
}

export function credentials(accountId = "test-account", sub = "test-user") {
  return credentialsFromToken(token(accountId, sub));
}

export function payload(fiveHourUsed = 25, weeklyUsed = 40) {
  return {
    rate_limit: {
      primary_window: { used_percent: fiveHourUsed, limit_window_seconds: 18_000, reset_at: NOW / 1000 + 3600 },
      secondary_window: { used_percent: weeklyUsed, limit_window_seconds: 604_800, reset_at: NOW / 1000 + 86400 },
    },
  };
}

export function model(provider = "openai-codex", id = "gpt-6-astra", baseUrl = "https://chatgpt.com/backend-api"): NonNullable<ExtensionContext["model"]> {
  return {
    provider, id, baseUrl, name: id,
    api: provider === "openai-codex" ? "openai-codex-responses" : "openai-responses",
    reasoning: true, input: ["text"], contextWindow: 200_000, maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
