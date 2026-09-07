import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { MonitorState } from "./monitor.ts";
import { REFRESH_MS } from "./usage.ts";
import type { RateWindow } from "./usage.ts";

type Colors = Pick<Theme, "fg">;

export function percent(value: number): string {
  if (value > 0 && value < 0.1) return "<0.1%";
  if (value < 100 && value > 99.9) return ">99.9%";
  return `${Number(value.toFixed(1))}%`;
}

function windowText(label: string, window: RateWindow | undefined, length: number, theme: Colors, now: number): string {
  const expired = window?.resetsAt !== undefined && now >= window.resetsAt;
  if (!window || expired) return theme.fg("dim", `${label} ${expired ? "待刷新" : "--"}`);
  const remaining = window.remainingPercent;
  const color = remaining <= 10 ? "error" : remaining <= 30 ? "warning" : "success";
  const filled = Math.round(remaining / 100 * length);
  const bar = length > 0
    ? theme.fg("dim", "[") + theme.fg(color, "█".repeat(filled)) + theme.fg("dim", "░".repeat(length - filled) + "] ")
    : "";
  return theme.fg("muted", `${label} `) + bar + theme.fg(color, percent(remaining));
}

export function renderStatus(state: MonitorState, theme: Colors, width = 80, now = Date.now()): string {
  if (!state.snapshot) {
    const message = state.error?.message ?? (state.refreshing ? "查询中…" : "等待查询…");
    return truncateToWidth(theme.fg(state.error ? "warning" : "dim", `Codex ${message}`), Math.max(0, width));
  }
  const snapshot = state.snapshot;
  const stale = !!state.error || now - snapshot.fetchedAt > REFRESH_MS * 2;
  const suffix = stale ? theme.fg("warning", " (缓存)") : state.refreshing ? theme.fg("dim", " ↻") : "";
  let line = "";
  for (const length of [8, 4, 0]) {
    line = theme.fg("accent", "Codex 剩余 ")
      + windowText("5h", snapshot.fiveHour, length, theme, now)
      + theme.fg("dim", " | ")
      + windowText("周", snapshot.weekly, length, theme, now)
      + suffix;
    if (visibleWidth(line) <= width) return line;
  }
  return truncateToWidth(line, Math.max(0, width));
}

export function describeStatus(state: MonitorState, now = Date.now()): string {
  const lines: string[] = [];
  if (state.error) lines.push(state.error.message);
  if (!state.snapshot) return lines.join("\n") || "正在查询 Codex 额度…";
  lines.push(`Codex 账户级剩余额度（更新于 ${new Date(state.snapshot.fetchedAt).toLocaleString()}）`);
  for (const [label, window] of [["5 小时", state.snapshot.fiveHour], ["每周", state.snapshot.weekly]] as const) {
    const reset = window?.resetsAt;
    const value = reset !== undefined && now >= reset ? "等待服务端确认重置" : window ? percent(window.remainingPercent) : "接口未提供";
    lines.push(`${label}：${value}${reset === undefined ? "" : `；重置：${new Date(reset).toLocaleString()}`}`);
  }
  return lines.join("\n");
}
