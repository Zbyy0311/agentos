# Plan C2 验收记录：显式协作角色与群聊策略

## 实现范围

- 共享类型新增 `CollaborationRole`、`GroupDispatchMode` 和 `GroupMemberInput`。
- SQLite 为 `conversations` 增加 `dispatch_mode`，为 `conversation_members` 增加 `role_kind`、`sequence`，并建立 `(conversation_id, sequence)` 唯一索引。
- 旧数据按 `is_leader DESC, created_at ASC, rowid ASC` 回填序号；旧群聊默认 `leader_route`，直接会话保持 `null`。
- 群聊创建接口同时支持显式 `members`/`dispatchMode` 与旧版 `memberAgentIds`/`leaderAgentId` 请求。
- 群聊成员接口支持读取和 PATCH 编辑角色、角色标题、顺序与调度策略。
- 前端 `GroupCreator` 提供角色和调度策略配置，`GroupEditor` 可从群聊右键菜单打开。

## 验收证据

| 场景 | 结果 |
| --- | --- |
| 显式 `leader`/`reviewer` 组合创建、持久化、重载 | 通过 `SqliteStore.test.ts` |
| `mentioned_only` 与 `leader_route` 策略创建/更新 | 通过 `conversations.test.ts` |
| 旧版字段创建请求兼容 | 通过既有 `conversations.test.ts` |
| 成员按 `sequence` 稳定返回 | 通过路由与存储测试 |
| Provider 不参与角色推断 | API 必须提交 `roleKind`；兼容旧请求仅把非 leader 标准化为 `worker` |

## 验证命令

```powershell
pnpm.cmd --filter @agentos/server exec node --import tsx --test src/routes/conversations.test.ts
pnpm.cmd --filter @agentos/server exec node --import tsx --test src/store/SqliteStore.test.ts
pnpm.cmd --filter @agentos/server test
pnpm.cmd --filter @agentos/web test
pnpm.cmd --filter @agentos/web build
```

## 当前结果

- Server 全量：157 passed。
- Web：85 passed。
- Web production build：通过。
- Agent core：119 passed。
