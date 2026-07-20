# AgentOS 计划 D 验收记录

日期：2026-07-19  
分支：`codex/agentos-isolation-release`  
基线 HEAD：`d6deeb24940c79f54aa99cfe1864cb16bf432cad`

## 已完成的核心实现

- D1：clean workspace gate、execution 级 Worktree branch/path、lease 状态和启动 reconcile。
- D2：tracked patch、untracked manifest、tar recovery bundle、路径与 symlink 逃逸检查、显式确认后清理。
- D3：usage provenance（structured/database_delta/unavailable）、持久化侧输出合并、详细事件配额、容量统计和带真实删除能力的 retention preview/apply token。
- D4：沿用计划 A1 的 loopback/CORS/Origin 全局安全防线，新 Worktree/Storage 路由挂载在防线之后。
- D5：隔离端口 Playwright Chrome smoke gate、fake runtime fixture、console/pageerror 检查。

## 自动化证据

```text
WorktreeManager.test.ts: 3/3
WorktreeArtifactService.test.ts: 2/2
RuntimeEventBuffer.test.ts: 2/2
RuntimeStorageService.test.ts: 1/1
agent-core: 123/123
server: 180/180
web: 86/86
Playwright collaboration-workbench: 3/3（1280×720、440×900、920×1080）
monorepo build: PASS
git diff --check: PASS
```

Playwright 使用已安装的 Chrome，Web/Server 使用 3201/3200 隔离端口；测试检查了页面可见性、5xx、console error 和 pageerror，并保存三种视口截图到 `apps/web/.agentos/acceptance/collaboration-workbench/`。

## D6 真实执行证据

```text
verify-real-codex-runtime-e2e.ps1: PASS（codex-cli 0.144.0-alpha.4；file,diff,report,log）
verify-agentos-e2e.ps1: PASS（Codex/Kimi/OpenCode direct、group、memory、failure、cancel、waiting_user、recovery）
verify-real-worktree-gate.mjs: PASS（leases=2, restored=2, cleaned=2）
```

真实 Worktree Gate 使用临时 clean Git 仓库；确定性 leader 只负责稳定路由，Kimi 与 Codex worker 负责真实写入。两个 worker 各自修改 `shared.txt` 并创建 untracked 文件，tracked patch 与 untracked archive/manifest 均通过内容还原，主工作区保持 clean，显式确认清理后 `git worktree list` 仅剩主工作区。

## 安全边界

- Worktree 绝对路径只保存在服务端 lease record，不进入公开 lease DTO、事件或 UI。
- 删除 Worktree 必须同时满足 recovery bundle 已验证、请求显式确认；不会自动删除 branch、merge 或 cherry-pick。
- untracked bundle 只接受仓库内的普通文件；绝对路径、越界路径和 symlink 逃逸会被拒绝。
- retention 默认不自动删除 Run/Artifact；apply 必须携带短期 preview token，且现在会按 preview 的 terminal Run selection 执行真实删除。
- usage 没有数据时不使用字符数冒充 Token；structured/database delta/unavailable 均标记来源，`estimated` 为 false。

## D6 真实门禁结果

Provider 与 Worktree 的逐项记录见 [`agentos-provider-gates.md`](./agentos-provider-gates.md)。

- Codex：`C:\Users\Administrator\.codex\.sandbox-bin\codex.exe`，`codex-cli 0.144.0-alpha.4`；真实 direct/group/lifecycle 和 Artifact gate 通过。
- Kimi：`C:\Users\Administrator\.kimi-code\bin\kimi.exe`，`0.23.5`；真实 direct/group/lifecycle gate 通过。
- OpenCode：`E:\software\opencode\node_modules\opencode-ai\bin\opencode.exe`，`1.17.11`；真实 direct/group/lifecycle gate 通过。
- 真实隔离 Worktree gate 通过：两个真实写入 Agent 的 lease、patch/archive/manifest、还原和显式清理均通过，清理后无执行 worktree 残留。

## 已知后续工作

1. 将 lease 持久化从 JSON 辅助文件迁移到 SQLite，并补充路由矩阵测试。
2. 将 storage preview 的 selection 从当前 Run ID 列表扩展为前端可筛选的归档视图。
3. Provider 路径、版本或账号变化后，按 `agentos-provider-gates.md` 的命令重跑 D6.2/D6.3。

计划 D 的 D1–D6 验收门禁已通过；后续仅保留 lease SQLite 化和 storage 选择 UI 等非阻塞改进项。
