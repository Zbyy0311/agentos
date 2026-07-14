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

3001 端口已启动并由用户当前本地前端进程占用，目标页面返回 HTTP 200。内置浏览器已检查 Workspace、执行详情入口、项目知识入口、六个记忆筛选项、标签/相关文件字段和 Markdown 只读预览。真实浏览器单聊曾停在当前 3000 服务进程的真实 CLI 调用阶段，因此未将其误记为通过。Playwright CLI 受本机浏览器目录 `EPERM` 限制，内置浏览器可继续用于手工刷新和验收。

## 结论

阶段 1 的自动化、编码和前端可用性检查通过，后续阶段已按计划完成并在最终验收记录中汇总。真实 CLI 端到端浏览器链路仍受本机 CLI 进程环境影响，需在 CLI 可返回时补做。

## 2026-07-14 收尾复验

本次收尾使用独立生产服务端口，不接管 3000/3001；生产 Web 构建使用临时的 `AGENTOS_NEXT_DIST_DIR` 和唯一临时 tsconfig（通过 `AGENTOS_NEXT_TSCONFIG_PATH`），脚本结束时删除临时配置与 dist，主 `apps/web/tsconfig.json` 不被修改，避免与开发服务共享 `.next` 生命周期：

| 检查 | 结果 | 证据 |
|---|---|---|
| Agent Core | 通过，75/75，exit 0 | `pnpm --filter @agentos/agent-core test` |
| Server | 通过，86/86，exit 0 | `pnpm --filter @agentos/server test` |
| Web build | 通过，exit 0 | `pnpm --filter @agentos/web build` |
| Monorepo build | 通过，4 个构建工作区，exit 0 | `pnpm -r run build` |
| 独立生产验收 | 连续两次通过，最新一次主 tsconfig SHA-256 不变，exit 0 | `verify-next-optimization-acceptance.ps1`；3100/3101 每次均释放，3001 保持 HTTP 200 |
| E2E 确定性生命周期 | 通过 | waiting_user 暂停/恢复、失败 Run、候选生成 409 |
| E2E 重启恢复 | 通过 | queued/running 变 failed，waiting_user 保持 |
| E2E 真实外部 Agent | 未通过 | Codex/OpenCode 单聊通过；Kimi 当前计费周期配额 403，群聊随之失败；不得冒充 release gate |

生产验收脚本会停止本次启动的进程树并检查端口；Windows 偶发持有 SQLite 文件句柄时只保留临时目录告警，不接管用户目录，也不会影响端口清理结果。
