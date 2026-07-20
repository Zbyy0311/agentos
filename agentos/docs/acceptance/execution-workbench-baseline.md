# 计划 B 基线记录

## 基线来源

- 计划 A 验收 HEAD：`23196421284c5175f4e344fbe8b65eb1e6cbbf8f`（`docs/acceptance/provider-runtime-final.md`）。
- 计划 B 分支：`codex/agentos-execution-workbench`。
- Node.js：`v24.18.0`。
- pnpm：`11.11.0`。
- 未执行 `reset`、`clean` 或覆盖式 `checkout`。

## 启动时保留的工作区改动

启动计划 B 前工作区并非干净状态。以下改动属于用户已有工作，已保留且不会被计划 B 的提交覆盖：

- `apps/server/src/services/ConversationService.test.ts`
- `apps/server/src/services/ConversationService.ts`
- `apps/web/src/app/globals.css`
- `apps/web/src/app/workspace/[id]/page.tsx`
- `apps/web/src/components/chat/ChatPanel.tsx`
- `docs/PROJECT_OVERVIEW.md`
- `docs/superpowers/plans/*.md`

计划 B 的提交只纳入本计划明确的文件；混合了用户改动的文件将保持未暂存，除非后续能够以最小、可审计的方式分离。

## A HEAD 基线验证

在计划 B 代码改动前执行：

```powershell
pnpm.cmd --filter @agentos/agent-core test
pnpm.cmd --filter @agentos/server test
pnpm.cmd --filter @agentos/web test
pnpm.cmd -r run build
```

结果：

- agent-core：20 个测试文件，119 tests passed。
- server：148 tests passed。
- web：75 tests passed。
- shared、agent-core、server、web production build：通过。

## 回滚边界

若计划 B 需要回滚，目标是回到上述 A HEAD，并保留本文件记录的用户工作区改动；不得使用破坏性 reset/clean 命令代替逐文件恢复。
