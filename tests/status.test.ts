import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describeStatus, percent, renderStatus } from "../src/status.ts";
import { parseUsage, REFRESH_MS, UsageError } from "../src/usage.ts";
import { NOW, payload, plainTheme } from "./helpers.ts";

test("renders two remaining-quota bars rather than used percentages", () => {
  const text = renderStatus({ refreshing: false, snapshot: parseUsage(payload(), NOW) }, plainTheme, 80, NOW);
  assert.equal(text, "Codex 剩余 5h [██████░░] 75% | 周 [█████░░░] 60%");
});

test("low remaining quota uses warning/error theme colors", () => {
  const colors: string[] = [];
  const theme = { fg: (color: string, text: string) => { colors.push(color); return text; } };
  renderStatus({ refreshing: false, snapshot: parseUsage(payload(95, 80), NOW) }, theme, 80, NOW);
  assert.ok(colors.includes("error"));
  assert.ok(colors.includes("warning"));
});

test("reflows to short bars/percentages and never exceeds terminal width", () => {
  const state = { refreshing: true, snapshot: parseUsage(payload(), NOW) };
  for (let width = 0; width <= 100; width++) {
    const text = renderStatus(state, plainTheme, width, NOW);
    assert.ok(visibleWidth(text) <= width, `width=${width}: ${text}`);
  }
  const narrow = renderStatus(state, plainTheme, 35, NOW);
  assert.match(narrow, /5h.*75%.*周.*60%/);
});

test("ANSI theme colors do not break width constraints", () => {
  const theme = { fg: (_color: string, text: string) => `\x1b[32m${text}\x1b[39m` };
  const state = { refreshing: false, snapshot: parseUsage(payload(), NOW) };
  for (const width of [0, 20, 35, 50, 80]) {
    assert.ok(visibleWidth(renderStatus(state, theme, width, NOW)) <= width);
  }
});

test("marks cached readings and expired windows without inventing a reset", () => {
  const snapshot = parseUsage(payload(), NOW);
  assert.match(renderStatus({ refreshing: false, snapshot, error: new UsageError("network") }, plainTheme, 80, NOW), /缓存/);
  assert.match(renderStatus({ refreshing: false, snapshot }, plainTheme, 80, NOW + 2 * REFRESH_MS + 1), /缓存/);
  assert.match(renderStatus({ refreshing: false, snapshot }, plainTheme, 80, NOW + 3600_000), /5h 待刷新/);
});

test("missing quota, loading, and auth errors are explicit", () => {
  assert.match(renderStatus({ refreshing: false, snapshot: parseUsage({ rate_limit: null }, NOW) }, plainTheme, 80, NOW), /5h --.*周 --/);
  assert.match(renderStatus({ refreshing: true }, plainTheme), /查询中/);
  assert.match(renderStatus({ refreshing: false, error: new UsageError("auth") }, plainTheme), /login/);
});

test("percent display distinguishes tiny remaining values from true zero", () => {
  assert.equal(percent(0), "0%");
  assert.equal(percent(0.01), "<0.1%");
  assert.equal(percent(99.99), ">99.9%");
  assert.equal(percent(100), "100%");
});

test("command details expose only quota/timestamps and safe errors", () => {
  const result = describeStatus({ refreshing: false, snapshot: parseUsage(payload(), NOW), error: new UsageError("network") }, NOW);
  assert.match(result, /5 小时：75%/);
  assert.match(result, /每周：60%/);
  assert.match(result, /重置/);
  assert.ok(!result.includes("test-account"));
});
