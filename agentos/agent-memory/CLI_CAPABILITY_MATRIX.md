# CLI 能力与模型发现矩阵

> 验证日期：2026-07-13
>
> 本文件记录 AgentOS 当前可以验证的 CLI 参数和模型发现来源。模型发现只读本地缓存/配置或 CLI 的 JSON 输出，不读取凭据，不修改 CLI 配置。

| CLI | 当前状态 | 模型运行参数 | 思考强度运行参数 | 模型发现来源 | 不可用时行为 |
|---|---|---|---|---|---|
| Kimi | `0.23.5`，`kimi --help` 可执行 | OAuth 使用 `-m/--model <model>`；API Key 使用 `KIMI_MODEL_NAME` | 当前 CLI 未提供通用思考强度参数 | `KIMI_CODE_HOME/config.toml` 的 `[models.*]` 区块 | 返回配置中的 fallback 模型，只允许 `auto` |
| OpenCode | `1.17.11`，工作区配置了 `E:\software\opencode\node_modules\opencode-ai\bin\opencode.exe` | 使用现有 `--model <model>` 映射 | `models` 命令可列出模型；未验证可调思考参数 | `AGENTOS_OPENCODE_MODELS_FILE`、已知配置路径，或 `opencode models` 纯文本输出 | CLI 不可执行时 HTTP 200 返回 fallback，并显示 warning |
| Codex | WindowsApps 路径可发现，但当前终端启动返回 Access denied | `-m <model>` | `-c model_reasoning_effort=<effort>` | `CODEX_HOME/models_cache.json`，读取 `slug/display_name/supported_reasoning_levels` | 返回静态模型；CLI 最终执行仍由 Codex 校验 |

## 已验证命令

```powershell
kimi --version
# 0.23.5

kimi --help
# 明确包含 -m, --model <model>

kimi provider list
# 可读取已配置 Provider 和模型数量；具体模型别名由 config.toml 读取

E:\software\opencode\node_modules\opencode-ai\bin\opencode.exe --version
# 1.17.11

E:\software\opencode\node_modules\opencode-ai\bin\opencode.exe models
# 逐行输出模型 ID，例如 opencode/big-pickle、kimi-for-coding/k2p6

codex exec --help
# 当前终端启动 WindowsApps codex.exe 返回 Access denied
```

## 动态发现规则

1. Codex 优先读取 `CODEX_MODELS_FILE`，否则读取 `CODEX_HOME/models_cache.json`，未设置 `CODEX_HOME` 时使用 `%USERPROFILE%\.codex\models_cache.json`。
2. Kimi 优先读取 `KIMI_CONFIG_FILE`，否则读取 `KIMI_CODE_HOME/config.toml`，未设置时使用 `%USERPROFILE%\.kimi-code\config.toml`。
3. OpenCode 优先读取 `AGENTOS_OPENCODE_MODELS_FILE` 或 `AGENTOS_OPENCODE_CONFIG`；没有配置文件时先尝试 `opencode models --json`，再兼容 1.17 的纯文本 `opencode models`，单次超时 3 秒。
4. 模型使用稳定的 ID 传给 CLI，显示名称只用于 UI；重复、隐藏或无 ID 模型会被过滤。
5. 思考强度只保留 AgentOS 已验证的 `auto`、`low`、`medium`、`high`。CLI 返回 `xhigh`、`max`、`ultra` 等未知值时不透传。
6. 发现结果缓存 30 秒；点击刷新接口时强制重新读取。读取失败保留上一次成功结果并标记 `stale`，没有历史结果时使用静态 fallback。
7. 动态发现失败不能阻断聊天执行；模型发现日志不得包含 API Key、OAuth token、credentials 内容或完整 prompt。

## 对应测试

```powershell
pnpm --filter @agentos/server exec node --import tsx --test src/services/CliModelDiscovery.test.ts
pnpm --filter @agentos/server exec node --import tsx --test src/routes/modelDiscovery.test.ts
```

测试覆盖 Codex cache、Kimi TOML、OpenCode JSON/纯文本、缓存刷新、fallback、安全过滤和 Agent API 返回值。
