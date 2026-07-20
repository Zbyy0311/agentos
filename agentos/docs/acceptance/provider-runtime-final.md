# Provider Runtime 阶段验收

## 验收结论

Plan A 的 A0–A6 已执行到阶段边界。Provider 身份、实际 runtime 探测、Adapter invocation/parser、运行记录持久化、Kimi stream-json 适配和 OpenCode 阻断 Gate 已落地；OpenCode 因本机没有 CLI 明确保持 BLOCKED，不以 Codex 结果替代。

## 自动化证据

`powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-provider-runtime.ps1` 已通过：

- Agent core：20 个 test files，119 tests passed。
- Server：148 tests passed。
- Web：75 tests passed。
- shared、agent-core、server、web production build 全部通过。
- `git diff --check` 通过。
- A0 backup index、tracked patch、SQLite snapshot、workspace/task fallback 均存在且路径仍在 `.agentos/backups` 内。

## Provider 矩阵

| Provider | configured/detected | 能力与 Gate | 状态 |
|---|---|---|---|
| Codex | mismatch 时可记录并切换 detected parser | 既有真实 Codex Runtime Gate 记录为 PASS；当前 WindowsApps 入口直接执行仍受 Access denied 限制 | PASS（既有真实 Gate） |
| Kimi | `kimi` / `kimi` | 本机 Kimi `0.23.5`；`--version`、`--help`、`stream-json` probe，真实只读 smoke，脱敏 fixture、tool call 配对、usage 去重和 fake CLI 集成 | PASS |
| OpenCode | 未执行真实探测 | `Get-Command opencode` 未找到；未创建猜测性 Adapter 或 fixture | BLOCKED |

## 已验证的行为

- `WorkspaceAgent.provider` 与 collaboration role 分离；旧 JSON role 和 SQLite `agent_role` 可迁移为 provider，原 CLI command/model 不被重写。
- Adapter 通过 `probe()`、`buildInvocation()`、`createParser()` 负责 Provider-specific 逻辑；Executor 只消费 `ProviderInvocation` 并管理进程生命周期、超时、取消、stdout/stderr 与文件快照。
- 配置 Provider 与探测 Provider 不一致时，公开 `provider.mismatch`，运行时选择实际可用 parser，并将 configured/detected/mismatch 持久化到 Run CLI invocation；Agent Editor 显示 Provider、CLI 命令与最近一次 mismatch。
- Kimi `--output-format stream-json` 会在 prompt 参数前注入，assistant、tool、malformed、unknown 和 usage 事件均转换为统一事件协议；usage 按 step id/uuid 去重。
- OpenCode 缺失时保持 plain/blocked 路径，不伪造 OpenCode 能力。

## 已知边界与下一步

- 本次真实 Kimi 短 smoke 未返回 `step.end` usage 行；usage 解析已由脱敏 fixture 和 fake CLI 覆盖，但需要更复杂的真实 Kimi 任务继续确认 live usage schema。
- 安装 OpenCode 后，先运行其真实 `--version` 与 `run --help` Gate，再单独实现 OpenCode Adapter；在此之前不进入 Plan B。
- A0 恢复包仍保留在 `E:\workspace\Multi-Agent\agentos\.agentos\backups\provider-runtime-20260718-191210`，恢复前须停止 AgentOS Server/Web 并重新确认当前状态。
