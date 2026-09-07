import { createHash } from "node:crypto";

export const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export const REFRESH_MS = 5 * 60_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

export interface Credentials {
  accessToken: string;
  accountId: string;
  /** In-memory identity only; distinguishes users sharing the same workspace. */
  ownerKey: string;
}

export interface RateWindow {
  remainingPercent: number;
  resetsAt?: number;
}

export interface UsageSnapshot {
  fiveHour?: RateWindow;
  weekly?: RateWindow;
  fetchedAt: number;
}

const ERROR_MESSAGES = {
  auth: "登录不可用，请在 pi 中 /login 选择 OpenAI Codex",
  endpoint: "仅支持 OpenAI 官方 Codex 端点",
  account: "无法识别 Codex OAuth 账户",
  "account-changed": "账户已切换，等待重新查询",
  network: "额度查询网络错误",
  timeout: "额度查询超时",
  "invalid-response": "额度接口返回了无法识别的数据",
  "rate-limited": "额度查询被限流，稍后自动重试",
  http: "额度接口暂时不可用",
} as const;

export class UsageError extends Error {
  readonly code: keyof typeof ERROR_MESSAGES;
  readonly retryAfterMs?: number;

  constructor(code: keyof typeof ERROR_MESSAGES, retryAfterMs?: number) {
    super(ERROR_MESSAGES[code]);
    this.name = "UsageError";
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function isOfficialEndpoint(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.origin === "https://chatgpt.com" && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function credentialsFromToken(token: string | undefined): Credentials {
  // Decode only to obtain routing/identity claims. OpenAI authenticates the JWT.
  // Do not retain refresh tokens, log payloads, or accept arbitrary API keys.
  if (!token || token.length > 32_768 || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) {
    throw new UsageError("account");
  }
  let payload: Record<string, unknown> | undefined;
  try {
    payload = record(JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")));
  } catch {
    throw new UsageError("account");
  }
  const auth = record(payload?.["https://api.openai.com/auth"]);
  const accountId = auth?.chatgpt_account_id;
  if (typeof accountId !== "string" || !/^[\x21-\x7e]{1,512}$/.test(accountId)) {
    throw new UsageError("account");
  }
  const subject = payload?.sub ?? auth?.chatgpt_user_id;
  const ownerKey = createHash("sha256")
    .update(accountId).update("\0")
    .update(typeof subject === "string" && subject ? subject : token)
    .digest("hex");
  return { accessToken: token, accountId, ownerKey };
}

function timestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 8.64e12
    ? value * 1000
    : undefined;
}

export function parseUsage(value: unknown, now = Date.now()): UsageSnapshot {
  const payload = record(value);
  if (!payload || !("rate_limit" in payload)) throw new UsageError("invalid-response");
  const limits = record(payload.rate_limit);
  if (payload.rate_limit != null && !limits) throw new UsageError("invalid-response");
  const result: UsageSnapshot = { fetchedAt: now };

  for (const [field, fallbackSeconds] of [["primary_window", 18_000], ["secondary_window", 604_800]] as const) {
    const window = record(limits?.[field]);
    const used = window?.used_percent;
    if (!window || typeof used !== "number" || !Number.isFinite(used)) continue;
    const duration = window.limit_window_seconds ?? fallbackSeconds;
    // Free/other plans can put a weekly window in the primary slot. Do not
    // mislabel weekly/monthly windows as 5h based on slot position alone.
    const key = duration === 18_000 ? "fiveHour" : duration === 604_800 ? "weekly" : undefined;
    if (!key || result[key]) continue;
    let resetsAt = timestamp(window.reset_at);
    if (resetsAt === undefined) {
      const after = timestamp(window.reset_after_seconds);
      if (after !== undefined && now + after <= 8.64e15) resetsAt = now + after;
    }
    result[key] = { remainingPercent: Math.max(0, Math.min(100, 100 - used)), resetsAt };
  }
  return result;
}

export function retryAfterMs(value: string | null, now: number): number {
  if (!value?.trim()) return REFRESH_MS;
  const trimmed = value.trim();
  const delay = /^\d+(\.\d+)?$/.test(trimmed)
    ? Number(trimmed) * 1000
    : Date.parse(trimmed) - now;
  return Number.isFinite(delay) && delay >= 0
    ? Math.max(60_000, Math.min(delay, 2_147_000_000))
    : REFRESH_MS;
}

async function readJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new UsageError("invalid-response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new UsageError("invalid-response");
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError("invalid-response");
  } finally {
    reader.releaseLock();
  }
}

export async function fetchUsage(
  credentials: Credentials,
  signal: AbortSignal,
  fetcher: typeof fetch = globalThis.fetch,
  now: () => number = Date.now,
): Promise<UsageSnapshot> {
  signal.throwIfAborted();
  const response = await fetcher(USAGE_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      "ChatGPT-Account-Id": credentials.accountId,
      Accept: "application/json",
      "User-Agent": "pi-codex-usage/0.1.0",
    },
    redirect: "error",
    cache: "no-store",
    signal,
  });
  if (!response.ok) {
    // Never surface server bodies: they can contain account data or credentials.
    await response.body?.cancel();
    if (response.status === 401 || response.status === 403) throw new UsageError("auth");
    if (response.status === 429) throw new UsageError("rate-limited", retryAfterMs(response.headers.get("retry-after"), now()));
    throw new UsageError("http");
  }
  return parseUsage(await readJson(response), now());
}

/** Bound even the pi auth facade, whose public method currently has no signal argument. */
export function abortable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    if (signal.aborted) { aborted(); return; }
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return operation();
    }).then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}
