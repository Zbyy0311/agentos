# Kimi Runtime Gate

## 结论

Kimi Provider Adapter 已完成并通过自动化 Gate。机器上的 Kimi CLI 为 `0.23.5`，命令由 `%USERPROFILE%\.kimi-code\bin\kimi.exe` 提供；`--help` 明确包含 `--output-format` 的 `stream-json` 选项。

## 实际探测

- `kimi --version` → `0.23.5`
- `kimi --help` → `--output-format <format>`，choices 包含 `text` 与 `stream-json`
- 真实只读 smoke prompt 返回了 assistant/tool_calls/tool/assistant/meta JSONL；未修改项目文件。

## Adapter 验收

- `probe()` 顺序执行 `--version` 与 `--help`，单次命令探测超时为 5 秒。
- `buildInvocation()` 会把 `--output-format` 放在 `-p/--prompt` 之前，替换已有文本格式且不重复添加。
- parser 支持 assistant 文本、function tool call、tool result、malformed JSON、未知事件和未匹配 tool result。
- `step.end`/usage 事件按 `id`、`uuid` 或 `step_id` 去重，并在 `finish()` 输出累计 usage。
- fixture 已脱敏，不包含凭据、API key、session id 或原始 prompt。
- fake CLI 集成验证了真实 Provider 选择、assistant/tool/usage/completed 事件和 executor 生命周期。

## 说明

本次真实 smoke 输出没有包含 `step.end` usage 行；因此 live CLI 的 usage 是否随任务复杂度输出仍需后续 Gate 持续观察。usage 解析与去重由脱敏 fixture 和 fake CLI Gate 覆盖，缺失 usage 不会把执行误判为失败。
