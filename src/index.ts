import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { UsageMonitor } from "./monitor.ts";
import { describeStatus, renderStatus } from "./status.ts";
import { abortable, credentialsFromToken, fetchUsage, isOfficialEndpoint, UsageError } from "./usage.ts";

const STATUS_KEY = "codex-usage";
const COMMAND_ARGS = ["refresh", "status", "on", "off"];

export function isCodexModel(model: ExtensionContext["model"]): boolean {
  // gpt-6-astra, for example, has no "codex" in its model ID. Conversely a
  // Codex-named model from OpenRouter/OpenAI API is not a ChatGPT subscription.
  return model?.provider === "openai-codex" && model.api === "openai-codex-responses";
}

export default function codexUsage(pi: ExtensionAPI): void {
  let context: ExtensionContext | undefined;
  let enabled = true;
  let listeningForResize = false;
  const offline = () => /^(1|true|yes)$/i.test(process.env.PI_OFFLINE ?? "");

  const publish = (): void => {
    if (!context || context.mode !== "tui") return;
    const visible = enabled && isCodexModel(context.model);
    context.ui.setStatus(STATUS_KEY, visible
      ? offline()
        ? context.ui.theme.fg("dim", "Codex 额度：离线")
        : renderStatus(monitor.state, context.ui.theme, process.stdout.columns || 80)
      : undefined);
  };

  const monitor = new UsageMonitor({
    async credentials(signal) {
      const ctx = context;
      const model = ctx?.model;
      if (!ctx || !model || !isCodexModel(model)) throw new UsageError("auth");
      if (!isOfficialEndpoint(model.baseUrl)) throw new UsageError("endpoint");
      if (!ctx.modelRegistry.isUsingOAuth(model)) throw new UsageError("auth");
      // Use the SAME auth resolution as this pi model. Pi owns any refresh and
      // persistence; the extension never reads/writes auth.json or calls /oauth/token.
      // Do not fall back to ~/.codex: it may belong to a different account.
      const auth = await abortable(() => ctx.modelRegistry.getApiKeyAndHeaders(model), signal);
      if (!auth.ok) throw new UsageError("auth");
      if (!isOfficialEndpoint(auth.baseUrl ?? model.baseUrl)) throw new UsageError("endpoint");
      return credentialsFromToken(auth.apiKey);
    },
    fetch: (credentials, signal) => fetchUsage(credentials, signal),
    changed: publish,
  });

  const synchronize = (ctx: ExtensionContext): void => {
    context = ctx;
    if (ctx.mode === "tui" && enabled && isCodexModel(ctx.model) && !offline()) {
      monitor.start();
    } else {
      monitor.stop();
    }
    publish();
  };

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode === "tui" && !listeningForResize) {
      process.stdout.on("resize", publish);
      listeningForResize = true;
    }
    synchronize(ctx);
  });

  pi.on("model_select", (_event, ctx) => synchronize(ctx));
  pi.on("agent_start", (_event, ctx) => synchronize(ctx));
  pi.on("agent_end", (_event, ctx) => {
    synchronize(ctx);
    // Faster feedback after actual work, but never one quota request per turn.
    void monitor.refresh("activity");
  });

  pi.on("session_shutdown", (_event, ctx) => {
    monitor.stop();
    if (listeningForResize) process.stdout.off("resize", publish);
    listeningForResize = false;
    if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, undefined);
    context = undefined;
  });

  pi.registerCommand("codex-usage", {
    description: "Codex 5h/周剩余额度：refresh/status/on/off（开关仅当前会话）",
    getArgumentCompletions(prefix) {
      const items = COMMAND_ARGS.filter((arg) => arg.startsWith(prefix)).map((arg) => ({ value: arg, label: arg }));
      return items.length ? items : null;
    },
    async handler(args, ctx) {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) ctx.ui.notify("Codex 额度底栏仅在交互终端模式启用。", "info");
        return;
      }
      const command = args.trim().toLowerCase() || "refresh";
      if (!COMMAND_ARGS.includes(command)) {
        ctx.ui.notify("用法：/codex-usage [refresh|status|on|off]", "warning");
        return;
      }
      if (command === "off" || command === "on") {
        enabled = command === "on";
        synchronize(ctx);
        ctx.ui.notify(`Codex 额度底栏已${enabled ? "开启" : "关闭"}（当前会话）。`, "info");
        return;
      }
      synchronize(ctx);
      if (!enabled || !isCodexModel(ctx.model) || offline()) {
        ctx.ui.notify(!enabled ? "请先 /codex-usage on" : offline() ? "离线模式不查询额度。" : "仅在使用 openai-codex 模型时查询额度。", "info");
        return;
      }
      if (command === "refresh") await monitor.refresh("manual");
      // A reload/session replacement may have disposed this command's context.
      if (context === ctx) ctx.ui.notify(describeStatus(monitor.state), monitor.state.error ? "warning" : "info");
    },
  });
}
