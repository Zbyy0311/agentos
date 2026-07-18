# AgentOS 计划 D Provider / Worktree Gate 记录

日期：2026-07-19  
分支：`codex/agentos-isolation-release`  
自动化基线：agent-core 123/123、server 180/180、web 86/86、Playwright 3/3、全仓 build PASS。

## Provider Gate

| Provider | configured / detected | executable / version | model | policy | usage source | files / artifact / terminal |
|---|---|---|---|---|---|---|
| Codex | codex / codex | `C:\Users\Administrator\.codex\.sandbox-bin\codex.exe` / `codex-cli 0.144.0-alpha.4` | profile default | direct read-only、controlled write；isolated worker write | structured；无 usage 时 unavailable | **PASS**：direct/group/lifecycle；file,diff,report,log；terminal completed |
| Kimi | kimi / kimi | `C:\Users\Administrator\.kimi-code\bin\kimi.exe` / `0.23.5` | `kimi-code/kimi-for-coding` | stream-json；isolated worker write | structured；无 usage 时 unavailable | **PASS**：direct/group/lifecycle；worker patch/archive/manifest；terminal completed |
| OpenCode | opencode / opencode | `E:\software\opencode\node_modules\opencode-ai\bin\opencode.exe` / `1.17.11` | `deepseek/deepseek-v4-flash` | direct read-only；configured write only in isolated worker | database_delta；无数据库时 unavailable | **PASS**：direct/group/lifecycle；runtime artifacts；terminal completed |

Provider gate 没有把字符数换算成 Token；只有结构化或数据库增量才报告具体计数，缺失时报告 `source: unavailable` 且 `estimated: false`。

## 自动化 Worktree Gate

- `parallel_isolated` mock group test 通过：write-capable worker 使用 execution-specific lease，leader 只读策略不修改主工作区。
- `WorktreeArtifactService` 2/2：tracked patch、untracked binary、manifest、tar 解包恢复后的字节与 SHA-256 一致；越界 symlink 被拒绝。
- `WorktreeManager` 3/3：dirty gate、execution 唯一 branch/path、reconcile、unsafe root/branch/target 拒绝。
- 真实 Provider 三 Agent lifecycle gate 已通过：Codex/Kimi/OpenCode direct、group、memory injection/candidate、failure、cancel、waiting-user、recovery 均有真实 HTTP/SSE 证据。
- 真实隔离 Worktree gate 已通过：两个真实写入 Agent（Kimi、Codex worker）在独立 execution worktree 修改 tracked `shared.txt` 并创建 untracked 文件；主工作区保持 clean，两个 patch/archive/manifest bundle 均可还原，显式清理后 `git worktree list` 仅剩主工作区。

## 重跑条件

如 Provider 路径、账号或模型发生变化，应重新记录 path、version、model、RuntimePolicy、usage source、files、Artifact 和 terminal status，并重跑：

```powershell
$env:AGENTOS_CODEX_CLI='C:\Users\Administrator\.codex\.sandbox-bin\codex.exe'
$env:AGENTOS_KIMI_CLI='C:\Users\Administrator\.kimi-code\bin\kimi.exe'
$env:AGENTOS_OPENCODE_CLI='E:\software\opencode\node_modules\opencode-ai\bin\opencode.exe'
powershell -ExecutionPolicy Bypass -File scripts/verify-agentos-e2e.ps1 -ServerPort 39120
node scripts/verify-real-worktree-gate.mjs
```
