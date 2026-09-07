# pi-codex-usage

仅在使用 **`openai-codex` provider** 的模型时，在 pi 原生底栏显示账户级剩余额度：

```text
Codex 剩余 5h [██████░░] 75% | 周 [█████░░░] 60%
```

- 实心部分表示**剩余**，不是已用；绿色 >30%，黄色 ≤30%，红色 ≤10%。
- 按 provider 判断，支持 `gpt-6-astra` 等名称不含 `codex` 的模型；普通 OpenAI API / OpenRouter 模型不触发。
- 不替换原生 footer，不影响已有路径、Token 统计、模型和其他扩展状态。
- 切换到其他 provider 时隐藏并停止查询；退出、`/reload` 或切换会话时释放定时器和请求。
- 窄终端自动缩短进度条，必要时只显示百分比。

## 安装

需要 Node.js ≥22.18、**pi ≥0.85.1**；已在 pi 0.85.1 的公开扩展 API 上验证。

在本仓库目录运行，添加为全局本地 pi package：

```sh
pi install .
```

然后在 pi 中执行 `/reload`（或者重新启动）。本地安装是路径引用，不会复制代码，请保留仓库目录。

仅临时试用，不修改 pi 设置：

```sh
pi -e ./src/index.ts
```

也可用 `pi install -l .` 仅在当前项目安装；需要信任项目后才能加载。

卸载全局安装：

```sh
pi remove /absolute/path/to/pi-codex-usage
```

如果还未登录，在 pi 中 `/login` 选择 **OpenAI / ChatGPT Plus/Pro (Codex)**，再通过 `/model` 选择 `openai-codex` 模型。不需要安装 Codex CLI，也不需要浏览器 Cookie。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/codex-usage` 或 `/codex-usage refresh` | 手动刷新，并显示额度与重置时间 |
| `/codex-usage status` | 查看当前缓存/错误，不主动刷新已有监控器 |
| `/codex-usage off` | 当前会话隐藏并暂停查询 |
| `/codex-usage on` | 当前会话恢复 |

默认每 **5 分钟**查询一次。一次 agent 运行结束后也会尝试更新，但自动请求间隔不少于 **60 秒**。手动刷新至少间隔 5 秒；同一实例的并发请求合并。失败会退避 5–30 分钟，HTTP 429 的 `Retry-After` 对手动刷新、模型切换及 off/on 同样有效。各 pi 进程独立计时；同时打开很多实例时可用 `off` 只保留一个监控器。

遇到网络故障时，同一账户的最近数据标为 **`(缓存)`**。重置时间已到但尚未得到新数据时显示 **`待刷新`**，不擅自重置为 100%。接口未提供某个窗口时显示 `--`；不会把缺失值当作满额。认证失败或检测到账户变化会清除旧数据。

开关和额度缓存都只保存在内存中，重启/重载后默认重新启用。`PI_OFFLINE=1` 时不查询。若自定义 footer 扩展完全忽略 `footerData.getExtensionStatuses()`，需要让它渲染扩展状态，本插件不会抢占其 footer。

## 认证与安全边界

1. 通过 **pi 的 `ctx.modelRegistry.getApiKeyAndHeaders()`** 获取当前模型的 OAuth access token。Token 的刷新与保存继续由 pi 自己负责；本插件没有独立的 refresh-token 流程。
2. **不读取或修改 `~/.codex/auth.json`**，也不直接读取 pi 的 auth 文件，因此不会借用 Codex CLI 中可能不同的账户。
3. 只向固定地址发送一次只读 GET：

   ```text
   https://chatgpt.com/backend-api/wham/usage
   ```

   使用 `Authorization: Bearer ...` 和 `ChatGPT-Account-Id`；禁止 HTTP 重定向。不采用 `chatgpt_base_url` 或模型自定义代理地址，遇到非官方模型端点会拒绝查询。
4. 无浏览器 Cookie、无子进程、无模型推理请求、无兑换额度操作、无遥测。不输出 access token、账号 ID、原始响应或认证异常详情；不把额度写入聊天上下文/会话文件。
5. 额度请求和等待认证的时间上限为 15 秒。pi 当前公开的认证 facade 不接受取消参数，所以插件停止等待后，pi 自己已经发起的认证操作可能继续完成；不会再用其迟到结果发出额度请求。
6. 网络使用宿主的 `fetch`。HTTP(S) 代理行为取决于 pi/Node 的网络配置；Node 24 可在启动前设置 `NODE_USE_ENV_PROXY=1` 以配合 `HTTPS_PROXY`。不会修改全局网络代理或关闭 TLS 校验。

显示的是基础 `rate_limit` 的 5h / 每周窗口，不是美元余额、剩余 Token 数或 Spark 等模型的额外独立窗口。任一适用窗口耗尽都可能阻止继续使用；5h 剩余不代表每周额度仍可用。

额度接口是内部接口，可能变更、限流或失效。开源/Star 数不构成安全保证，本插件也不承诺不会触发服务端风控。

## 开发与测试

```sh
npm install --ignore-scripts
npm run check
```

测试全部使用虚构 JWT、模拟 HTTP 和模拟 pi 上下文，不读取真实凭证，不连接 OpenAI，不消耗模型额度。包含响应解析、账户隔离、固定请求地址、重定向策略、超时、退避、模型切换、停止/重载与底栏宽度测试。

参考：
- [pi 扩展文档](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)
- [CodexBar 的 OAuth 额度实现](https://github.com/steipete/CodexBar/blob/02c073a/Sources/CodexBarCore/Providers/Codex/CodexOAuth/CodexOAuthUsageFetcher.swift)
