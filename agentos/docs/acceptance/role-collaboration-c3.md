# Plan C3 验收记录：@Agent、Leader Router 与 waiting 恢复

## 实现范围

- `GroupDispatchService` 统一处理 mention 优先级、`leader_route`/`full_pipeline`/`mentioned_only` 决策、成员校验和按 sequence 排序。
- `DispatchEnvelope` 使用随机 128-bit nonce；只解析末行完整 envelope，nonce 不匹配、重复 envelope、未知 action 或非成员 id 均 fail-closed 到 `need_user`。
- `GroupOrchestrator` 提供 bounded handoff（最多 12,000 字符）和稳定 turn 描述，不暴露原始 stderr、工具输出或 reasoning。
- 群聊消息流支持 `mentionedAgentIds`，服务端拒绝不属于当前群的 id；显式群聊按 sequence 串行执行，旧版未设置策略的群聊保留并行兼容。
- 群聊 Run 创建可恢复的 `group.agent.*` 与 `group.summary` RunStep；Leader waiting 保持同一 Run，新增 resume stream 入口。
- 前端增加 `MentionPicker`，只提交稳定 agentId，不依赖 display name 解析。

## 验收证据

| 场景 | 结果 |
| --- | --- |
| mention 优先于 full pipeline | `GroupDispatchService.test.ts` 通过 |
| nonce 截断、错误 nonce、非成员、多 envelope fail-closed | `GroupDispatchService.test.ts` 通过 |
| sequence 稳定 turn 顺序、handoff 限长 | `GroupOrchestrator.test.ts` 通过 |
| 非成员 mention 返回 400 | `conversations.test.ts` 通过 |
| 历史群聊并行/等待失败行为保持兼容 | `ConversationService.test.ts` 通过 |

## 验证命令

```powershell
pnpm.cmd --filter @agentos/server exec node --import tsx --test src/services/GroupDispatchService.test.ts src/services/GroupOrchestrator.test.ts
pnpm.cmd --filter @agentos/server exec node --import tsx --test src/routes/conversations.test.ts src/services/ConversationService.test.ts
pnpm.cmd --filter @agentos/server exec tsc --noEmit
pnpm.cmd --filter @agentos/web build
```

## 当前结果

- C3 定向服务/路由/ConversationService 测试：通过。
- Server TypeScript 检查：通过。
- Web production build：通过。
