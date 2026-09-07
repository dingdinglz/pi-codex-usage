# pi-codex-usage

[English](README.md) | **简体中文**

复用现有的 pi OAuth 登录态，在 [pi](https://github.com/earendil-works/pi-mono) 原生底栏直接查看 Codex 订阅的 **5 小时和每周剩余额度**。

```text
Codex 剩余 5h [██████░░] 75% | 周 [█████░░░] 60%
```

插件界面目前使用简体中文。进度条的实心部分表示**剩余**，不是已用额度。

## 功能

- **按 provider 判断：** 仅在使用 `openai-codex` 模型时显示，支持名称不含 `codex` 的模型。普通 OpenAI API / OpenRouter 模型不触发额度请求。
- **原生底栏集成：** 新增扩展状态，不替换已有路径、Token 统计、模型信息或其他扩展状态。
- **彩色进度条：** 剩余 >30% 为绿色，>10% 且 ≤30% 为黄色，≤10% 为红色。
- **自适应布局：** 窄终端自动缩短进度条，必要时只显示百分比。
- **后台刷新：** 保留每 5 分钟轮询，每次对话完整结束后额外刷新，也支持手动刷新。
- **生命周期清理：** 切换到其他 provider 时隐藏并停止查询；退出、重载或切换会话时释放定时器并取消额度请求。

## 安装

需要 **Node.js ≥22.18**、**pi ≥0.85.1**；已在 pi 0.85.1 的公开扩展 API 上验证。

```sh
pi install git:github.com/dingdinglz/pi-codex-usage
```

然后在 pi 中执行 `/reload`，或者重新启动。如果还未登录，在 `/login` 中选择 **OpenAI / ChatGPT Plus/Pro (Codex)**，再通过 `/model` 选择 `openai-codex` 模型。

不需要安装 Codex CLI，也不需要浏览器 Cookie。

### 其他安装方式

仅在当前运行中试用，不添加到 pi 设置：

```sh
pi -e git:github.com/dingdinglz/pi-codex-usage
```

仅在当前项目安装：

```sh
pi install -l git:github.com/dingdinglz/pi-codex-usage
```

项目级安装需要信任项目后才能加载。

也可以在本地仓库目录运行 `pi install .`，或者用 `pi -e ./src/index.ts` 临时试用。本地安装保存路径引用而不是复制代码，请保留仓库目录。

### 更新或卸载

对于上述 GitHub 安装方式：

```sh
pi update git:github.com/dingdinglz/pi-codex-usage
pi remove git:github.com/dingdinglz/pi-codex-usage
```

如果是本地路径安装，改用 `pi remove /absolute/path/to/pi-codex-usage`。卸载项目级安装时加上 `-l`。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/codex-usage` 或 `/codex-usage refresh` | 手动刷新，并显示额度与重置时间 |
| `/codex-usage status` | 查看当前缓存或错误，不主动刷新已有监控器 |
| `/codex-usage off` | 当前会话隐藏并暂停查询 |
| `/codex-usage on` | 当前会话恢复监控 |

### 刷新策略

- 保留每 **5 分钟**轮询。每次对话完整结束（`agent_settled`，工具调用、自动重试和排队续问均已结束）后，都会额外刷新一次，不再受原来的 **60 秒**间隔限制。
- 同时最多一个额度请求。若对话结束时已有查询在进行，完成后再补查一次；等待期间的多个对话结束事件合并为这一次补查。
- 手动刷新仍至少间隔 **5 秒**，已有请求进行时复用该请求。
- 自动刷新（包括对话结束刷新）仍遵守失败后的 **5–30 分钟**退避。HTTP 429 的 `Retry-After` 对同一扩展实例中的手动刷新、provider 切换及 off/on 同样有效。
- 各 pi 进程独立计时；同时打开很多实例时，可用 `off` 只保留一个监控器。

### 状态含义

| 标记 | 含义 |
| --- | --- |
| `(缓存)` | 最近一次查询失败，或数据已经过时 |
| `待刷新` | 重置时间已到，等待服务端确认新额度 |
| `--` | 接口未提供这个窗口 |

不会把缺失值当作 100%，也不会在本地擅自重置为 100%。认证失败或检测到账户变化会清除旧账户的数据。

开关和额度缓存都只保存在内存中，重启或重载后默认重新启用。`PI_OFFLINE=1` 时不查询。非交互的 print、JSON、RPC 模式也不查询额度。

如果自定义 footer 忽略 `footerData.getExtensionStatuses()`，需要让它渲染扩展状态。本插件不会抢占其他扩展的 footer。

## 认证与安全边界

1. **使用 pi 当前的 OAuth 登录态。** 通过 `ctx.modelRegistry.getApiKeyAndHeaders()` 获取当前模型的认证信息。Token 的刷新与保存继续由 pi 自己负责；本插件没有独立的 refresh-token 流程。
2. **不直接访问认证文件。** 不读取或修改 `~/.codex/auth.json`，也不直接读取 pi 的 auth 文件，因此不会悄悄借用 Codex CLI 中可能不同的账户。
3. **请求目标固定。** 每次额度查询只向以下地址发送只读 GET：

   ```text
   https://chatgpt.com/backend-api/wham/usage
   ```

   使用 `Authorization: Bearer ...` 和 `ChatGPT-Account-Id`；禁止 HTTP 重定向。不采用 `chatgpt_base_url` 或模型自定义代理地址，遇到非官方模型端点会拒绝查询。
4. **无浏览器 Cookie、子进程、模型推理请求、兑换额度操作或遥测。** 不输出 access token、账号 ID、原始响应或原始认证异常；不把额度写入聊天上下文或会话文件。
5. **15 秒超时。** 限制额度请求及等待认证的时间。pi 当前公开的认证 facade 不接受取消参数，所以插件停止等待后，pi 自己已经发起的认证操作可能继续完成；不会再用其迟到结果发出额度请求。
6. **使用宿主网络。** 通过宿主的 `fetch` 查询，HTTP(S) 代理行为取决于 pi/Node 的配置；Node 24 可在启动前设置 `NODE_USE_ENV_PROXY=1` 以配合 `HTTPS_PROXY`。不会修改全局网络代理或关闭 TLS 校验。

显示的是基础 `rate_limit` 的两个窗口，**不是美元余额、剩余 Token 数或 Spark 等模型的额外独立限额**。任一适用窗口耗尽都可能阻止继续使用；5 小时额度剩余不代表每周额度仍可用。

> 额度接口是内部接口，可能变更、限流或失效。开源和 Star 数不构成安全保证，本插件也不承诺不会触发服务端风控。pi 扩展具有当前用户的系统访问权限，请在安装前审查源码。

## 开发与测试

```sh
git clone https://github.com/dingdinglz/pi-codex-usage.git
cd pi-codex-usage
npm install --ignore-scripts
npm run check
```

测试全部使用虚构 JWT、模拟 HTTP 和模拟 pi 上下文，不读取真实凭证、不连接 OpenAI、不消耗模型额度。包含响应解析、账户隔离、固定目标地址、重定向策略、超时、退避、provider 切换、生命周期清理、终端宽度和真实 pi 扩展加载器测试。

## 参考

- [pi 扩展文档](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)
- [CodexBar 的 OAuth 额度实现](https://github.com/steipete/CodexBar/blob/02c073a22ab8a12cc8ed1539d8a7a1ca3800e5b6/Sources/CodexBarCore/Providers/Codex/CodexOAuth/CodexOAuthUsageFetcher.swift)

## 许可证

[MIT](LICENSE)
