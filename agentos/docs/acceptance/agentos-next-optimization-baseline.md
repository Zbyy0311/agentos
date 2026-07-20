# AgentOS 下一阶段优化基线

## 记录信息

- 记录日期：2026-07-14
- 工作区：`E:\workspace\Multi-Agent\agentos`
- 分支：`codex/agentos-current`
- Node.js：`v24.18.0`
- pnpm：`11.7.0`

## 阶段 1结果

- Agent Core 测试：通过，74/74，退出码 0。
- Server 测试：通过，73/73，退出码 0。
- Web 构建：通过，退出码 0，Workspace 路由产物 21.4 kB。
- Monorepo 构建：通过，4/5 workspace 项目构建，退出码 0。
- UTF-8 核对：计划指定文档和核心源码可按 UTF-8 读取，未做无依据的批量替换。

## 基线命令明细

统一入口：`powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-next-optimization-baseline.ps1`

| 检查 | 开始时间（Asia/Shanghai） | 完成时间（Asia/Shanghai） | 退出码 | 失败测试 |
|---|---|---|---:|---|
| Agent Core tests | 2026-07-14T17:38:19.6021931+08:00 | 2026-07-14T17:38:24.5346920+08:00 | 0 | 无 |
| Server tests | 2026-07-14T17:38:24.5413723+08:00 | 2026-07-14T17:38:34.1467857+08:00 | 0 | 无 |
| Web build | 2026-07-14T17:38:34.1495605+08:00 | 2026-07-14T17:38:46.7709718+08:00 | 0 | 无 |
| Monorepo build | 2026-07-14T17:38:46.7719982+08:00 | 2026-07-14T17:39:01.9825837+08:00 | 0 | 无 |

补充：`pnpm install --frozen-lockfile` 于本轮通过，退出码 0，未变更依赖锁定文件。

统一入口：

```powershell
./scripts/verify-next-optimization-baseline.ps1
```

## 浏览器状态

3001 端口已启动并由用户当前本地前端进程占用，目标页面返回 HTTP 200。2026-07-14 内置浏览器在 `/workspace/d7994c0c` 创建 Codex 单聊，发送公开短语 `AGENTOS_UI_SMOKE_OK`，确认回复、执行完成时间线和会话标题均可见；刷新后消息、会话和执行完成状态仍在，浏览器 error/warn 日志为空。此前已检查 Workspace、执行详情入口、项目知识入口、六个记忆筛选项、标签/相关文件字段和 Markdown 只读预览。Playwright CLI 受本机浏览器目录 `EPERM` 限制，内置浏览器可继续用于手工刷新和验收。

## 结论

阶段 1 的自动化、编码和前端可用性检查通过，后续阶段已按计划完成并在最终验收记录中汇总。真实 CLI 端到端链路已在 2026-07-15 配额恢复后的 run 5 中通过，浏览器 1.4 证据和真实 E2E 证据分别见后续记录。

## 2026-07-14 收尾复验

本次收尾使用独立生产服务端口，不接管 3000/3001；生产 Web 构建使用临时的 `AGENTOS_NEXT_DIST_DIR` 和唯一临时 tsconfig（通过 `AGENTOS_NEXT_TSCONFIG_PATH`），脚本结束时删除临时配置与 dist，主 `apps/web/tsconfig.json` 不被修改，避免与开发服务共享 `.next` 生命周期：

| 检查 | 结果 | 证据 |
|---|---|---|
| Agent Core | 通过，77/77，exit 0 | `pnpm --filter @agentos/agent-core test` |
| Server | 通过，87/87，exit 0 | `pnpm --filter @agentos/server test` |
| Web build | 通过，exit 0 | `pnpm --filter @agentos/web build` |
| Monorepo build | 通过，4 个构建工作区，exit 0 | `pnpm -r run build` |
| 独立生产验收 | 连续两次通过，最新一次主 tsconfig SHA-256 不变，exit 0 | `verify-next-optimization-acceptance.ps1`；3100/3101 每次均释放，3001 保持 HTTP 200 |
| E2E 确定性生命周期 | 通过 | waiting_user 暂停/恢复、失败 Run、候选生成 409 |
| E2E 重启恢复 | 通过 | queued/running 变 failed，waiting_user 保持 |
| E2E 真实外部 Agent | 通过 | run 5 中 Codex/Kimi/OpenCode 单聊和三 Agent 群聊均通过；脚本总退出码 0 |

生产验收脚本会停止本次启动的进程树并检查端口；Windows 偶发持有 SQLite 文件句柄时只保留临时目录告警，不接管用户目录，也不会影响端口清理结果。

## 最新隔离真实 E2E 复验（2026-07-15，run 5）

命令通过 Windows PowerShell 5.1 执行 `scripts/verify-agentos-e2e.ps1 -AcceptanceRoot C:\tmp\agentos-e2e-real-isolated-20260715b`。验收使用临时 SQLite、临时 Git Workspace 和独立端口 3200，正式 Workspace、3000/3001 和正式数据库未被修改。

- Codex、Kimi、OpenCode 单聊：通过，均存在 CLI invocation，Run 为 `completed`。
- 三 Agent 群聊：通过，一个 Run 包含至少三个 Execution，所有 Execution 共享同一 `runId`。
- 真实记忆注入：通过，RunDetails 产生 MemoryUsage。
- 真实候选闭环：通过，无隐藏标记的公开决定/方案/验证证据生成候选，接受/拒绝和后续检索通过。
- 真实失败、取消、`waiting_user` 恢复：通过。
- 确定性生命周期和重启恢复：通过。
- `REAL_EXTERNAL_AGENT`、`DETERMINISTIC_LIFECYCLE`、`RECOVERY`、`MEMORY_CANDIDATE` 最终均为 `passed`，脚本 exit 0。
