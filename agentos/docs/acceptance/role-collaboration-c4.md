# 计划 C4 验收：部分写入失败决策

## 已实现

- `run_decisions` 持久化表按 `run + execution + kind` 去重。
- 写入执行失败且检测到文件变化时，Run 进入 `waiting_user`，问题中列出文件和三个动作：继续、重试当前步骤、终止。
- 决策解析、幂等 resolve、重启后读取均由 `RunDecisionService` 和 SQLite 覆盖。
- Web 端提供 `RunDecisionCard`，不宣称共享工作区可以自动回滚。

## 验收命令

```powershell
pnpm.cmd --filter @agentos/server exec node --import tsx --test src/services/RunDecisionService.test.ts src/services/ConversationService.test.ts
pnpm.cmd --filter @agentos/web test
pnpm.cmd --filter @agentos/server exec tsc --noEmit
```

## 结果

上述测试已通过；决策执行的 retry step 重新调度仍保留在后续隔离阶段，当前版本先保证暂停、审计和幂等恢复。
