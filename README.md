# pi-codex-usage

**English** | [简体中文](README.zh-CN.md)

See your Codex subscription's **5-hour and weekly remaining quotas** directly in the [pi](https://github.com/earendil-works/pi-mono) footer, using your existing pi OAuth login.

```text
Codex 剩余 5h [██████░░] 75% | 周 [█████░░░] 60%
```

The extension's UI currently uses Simplified Chinese: `剩余` means **remaining**, and `周` means **weekly**. The filled portion of each bar represents remaining quota, not usage.

## Features

- **Provider-aware:** appears only for `openai-codex` models, including models whose IDs do not contain `codex`. Regular OpenAI API and OpenRouter models do not trigger quota requests.
- **Native footer integration:** adds an extension status without replacing the existing path, token statistics, model information, or other extension statuses.
- **Color-coded bars:** green above 30%, yellow above 10% up to 30%, and red at 10% or below.
- **Responsive layout:** shortens bars in narrow terminals, falling back to percentages when needed.
- **Background refresh:** polls every 5 minutes, with rate-limited updates after agent runs and a manual refresh command.
- **Lifecycle cleanup:** hides and stops querying when you switch to another provider; releases timers and cancels quota requests on shutdown, reload, or session replacement.

## Installation

Requires **Node.js ≥22.18** and **pi ≥0.85.1**. Tested against pi 0.85.1's public extension API.

```sh
pi install git:github.com/dingdinglz/pi-codex-usage
```

Run `/reload` in pi, or restart it. If you have not signed in, use `/login` to select **OpenAI / ChatGPT Plus/Pro (Codex)**, then choose an `openai-codex` model with `/model`.

No Codex CLI installation or browser cookies are required.

### Other installation options

Try it for one session without adding it to your settings:

```sh
pi -e git:github.com/dingdinglz/pi-codex-usage
```

Install only for the current project:

```sh
pi install -l git:github.com/dingdinglz/pi-codex-usage
```

Project-local packages load only after the project is trusted.

From a local checkout, use `pi install .` or try `pi -e ./src/index.ts`. Local installation stores a path reference rather than copying the source, so keep the checkout in place.

### Update or uninstall

For the GitHub installation above:

```sh
pi update git:github.com/dingdinglz/pi-codex-usage
pi remove git:github.com/dingdinglz/pi-codex-usage
```

For a local-path installation, use `pi remove /absolute/path/to/pi-codex-usage` instead. Add `-l` when removing a project-local installation.

## Commands

| Command | Action |
| --- | --- |
| `/codex-usage` or `/codex-usage refresh` | Refresh and show quota details and reset times |
| `/codex-usage status` | Show cached quota or errors without requesting a refresh from an active monitor |
| `/codex-usage off` | Hide the status and pause queries for this session |
| `/codex-usage on` | Resume monitoring for this session |

### Refresh behavior

- Normal polling runs every **5 minutes**. After an agent run, the extension also attempts an update, with at least **60 seconds** between automatic requests.
- Manual refreshes have a **5-second** minimum interval. Concurrent requests within one instance are coalesced.
- Failures back off for **5–30 minutes**. HTTP 429 `Retry-After` also applies to manual refreshes, provider switching, and off/on toggles within the same extension instance.
- Each pi process has its own monitor. If you keep many instances open, use `off` to leave only one polling.

### Reading the status

| Label | Meaning |
| --- | --- |
| `(缓存)` | Cached data: the latest query failed or the reading is stale |
| `待刷新` | The reset time has passed; waiting for the server to confirm the new quota |
| `--` | The API did not provide this window |

Missing data is never treated as 100%, and quota is never locally reset to 100%. Authentication failures or a detected account change clear the previous account's data.

The toggle and cache are memory-only; restarting or reloading enables the monitor again. `PI_OFFLINE=1` disables quota queries. Non-interactive print, JSON, and RPC modes do not query quota.

If a custom footer ignores `footerData.getExtensionStatuses()`, update that footer to render extension statuses. This extension deliberately does not take over another extension's footer.

## Authentication and security

1. **Uses pi's current OAuth login.** Calls `ctx.modelRegistry.getApiKeyAndHeaders()` for the selected model. Pi owns token refresh and persistence; this extension has no separate refresh-token implementation.
2. **No direct auth-file access.** Does not read or modify `~/.codex/auth.json`, or directly read pi's auth files. It will not silently use a different account from the Codex CLI.
3. **Fixed request destination.** Each quota fetch makes a read-only GET to:

   ```text
   https://chatgpt.com/backend-api/wham/usage
   ```

   Requests use `Authorization: Bearer ...` and `ChatGPT-Account-Id`. HTTP redirects are forbidden. The extension does not honor `chatgpt_base_url` or custom model proxy endpoints, and refuses to query for non-official model endpoints.
4. **No cookies, subprocesses, model inference calls, credit redemption, or telemetry.** Does not log access tokens, account IDs, raw responses, or raw authentication errors, and does not write quota data into the conversation or session file.
5. **15-second deadline.** Bounds quota requests and time spent waiting for authentication. Pi's public auth facade currently has no cancellation argument, so an auth operation already started by pi may still finish after the extension stops waiting. Its late result will not trigger a quota request.
6. **Host networking.** Uses the host's `fetch`; HTTP(S) proxy behavior depends on pi/Node configuration. On Node 24, set `NODE_USE_ENV_PROXY=1` before startup to use `HTTPS_PROXY`. The extension does not change global proxy settings or disable TLS verification.

The bars show the base `rate_limit` windows, **not dollar balances, remaining token counts, or extra model-specific limits** such as Spark's separate windows. Exhausting either applicable window may prevent further use; available 5-hour quota does not imply available weekly quota.

> The usage endpoint is an internal API and may change, fail, or rate-limit requests. Open source and star counts are not security guarantees. This extension does not guarantee that requests will never trigger service-side account protections. Review the source before installing: pi extensions run with your user's system access.

## Development and testing

```sh
git clone https://github.com/dingdinglz/pi-codex-usage.git
cd pi-codex-usage
npm install --ignore-scripts
npm run check
```

Tests use fictional JWTs, mocked HTTP, and simulated pi contexts. They do not read real credentials, connect to OpenAI, or consume model quota. Coverage includes parsing, account isolation, fixed-origin requests, redirect policy, deadlines, backoff, provider switching, lifecycle cleanup, terminal widths, and loading through pi's actual extension loader.

## References

- [pi extension documentation](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)
- [CodexBar's OAuth quota implementation](https://github.com/steipete/CodexBar/blob/02c073a22ab8a12cc8ed1539d8a7a1ca3800e5b6/Sources/CodexBarCore/Providers/Codex/CodexOAuth/CodexOAuthUsageFetcher.swift)

## License

[MIT](LICENSE)
