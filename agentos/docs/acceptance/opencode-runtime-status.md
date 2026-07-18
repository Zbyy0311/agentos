# OpenCode Runtime Status

## 结论：BLOCKED

本机当前 `Get-Command opencode` 未找到命令，因此无法执行真实的 OpenCode `--version`、`run --help`、stream fixture 和 AgentOS 读写 Gate。

已确认：

- 不创建伪造的 OpenCode Adapter。
- 不创建来自文档猜测的 OpenCode fixture。
- 不把 Codex 的输出冒充为 OpenCode 能力证明。
- A3 已覆盖“配置为 OpenCode、实际探测为 Codex”时公开 mismatch 并选择 Codex parser 的回归测试。

重新开放 Gate 的最小条件：

1. 安装或配置一个可执行的 OpenCode CLI，并确保 `opencode` 或 Agent 配置中的绝对路径可运行。
2. 保存真实 `--version` 与 `run --help` 输出。
3. 依据实际 schema 采集脱敏 JSONL，再实现并测试 OpenCode Adapter。
