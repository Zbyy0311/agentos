# 会话右键菜单与返回工作区实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 AgentOS 聊天页增加群聊/历史会话右键管理菜单，以及返回工作区目录的导航入口。

**Architecture:** 复用现有标题 PATCH 接口，在 `SqliteStore` 增加 workspace-scoped 的事务删除方法和 DELETE 路由。前端在现有工作区页面集中维护菜单、重命名和删除状态，两个列表组件只负责把右键事件传给页面；菜单位置和删除后的选择回退使用可单测的纯函数。

**Tech Stack:** Next.js 14、React 18、TypeScript、Express、Node.js `node:test`、Node SQLite。

## Global Constraints

- 只修改本次需求涉及的文件；保留工作区当前既有未提交改动。
- 不增加 UI 组件库、状态管理库或新的运行时依赖。
- 删除接口必须验证 workspaceId 与 conversationId 的归属，并清理会话子记录。
- 先写测试并确认失败，再写生产代码。
- 所有修改记录到 `agent-memory/LOG.md`，架构决定记录到 `agent-memory/DECISIONS.md`。

---

### Task 1: 为会话删除建立 Store 失败测试

**Files:**
- Modify: `apps/server/src/store/SqliteStore.test.ts`
- Modify: `agent-memory/LOG.md`

**Interfaces:**
- Consumes: 现有 `createConversation`、`createGroupConversation`、`createMessage`、`createExecution`、`appendExecutionEvent`、各类 list 方法。
- Produces: `SqliteStore.deleteConversation(workspaceId, conversationId)` 的期望行为。

- [ ] **Step 1: Write the failing test**

在 `SqliteStore.test.ts` 增加测试 `deletes one conversation and all dependent records without affecting another conversation`：创建同一工作区的两个直聊，为待删除会话写入消息、执行和执行事件；调用 `store.deleteConversation('workspace-a', 'conversation-a')`，断言被删会话的 `listConversations`、`listMessages`、`listExecutions`、`listExecutionEvents`、`listConversationMembers` 全部为空，并断言另一个会话仍存在。

使用与现有测试相同的 `createProjectRoot`、`try/finally` 和 `store.close()` 清理方式，不直接读取测试专用数据库路径。

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentos/server exec node --import tsx --test src/store/SqliteStore.test.ts`

Expected: FAIL，错误应指向 `deleteConversation` 尚未定义，而不是测试 fixture 或 SQLite 初始化错误。

### Task 2: 实现 Store 事务删除并通过测试

**Files:**
- Modify: `apps/server/src/store/SqliteStore.ts`
- Test: `apps/server/src/store/SqliteStore.test.ts`
- Modify: `agent-memory/LOG.md`

**Interfaces:**
- Consumes: `workspaceId: string`、`conversationId: string`。
- Produces: `deleteConversation(workspaceId: string, conversationId: string): void`；找不到同 workspace 会话时抛出 `Conversation not found`。

- [ ] **Step 1: Write the minimal implementation**

在 `updateConversationTitle` 后增加：

```ts
deleteConversation(workspaceId: string, conversationId: string): void {
  this.assertConversationWorkspace(conversationId, workspaceId);
  this.database.exec('BEGIN');
  try {
    this.database.prepare(`
      DELETE FROM execution_events
      WHERE execution_id IN (
        SELECT id FROM executions WHERE conversation_id = ? AND workspace_id = ?
      )
    `).run(conversationId, workspaceId);
    this.database.prepare('DELETE FROM executions WHERE conversation_id = ? AND workspace_id = ?')
      .run(conversationId, workspaceId);
    this.database.prepare('DELETE FROM messages WHERE conversation_id = ? AND workspace_id = ?')
      .run(conversationId, workspaceId);
    this.database.prepare('DELETE FROM conversation_members WHERE conversation_id = ?')
      .run(conversationId);
    this.database.prepare('DELETE FROM conversations WHERE id = ? AND workspace_id = ?')
      .run(conversationId, workspaceId);
    this.database.exec('COMMIT');
  } catch (error) {
    try { this.database.exec('ROLLBACK'); } catch {}
    throw error;
  }
}
```

明确保留 `assertConversationWorkspace`，因此跨 workspace ID 不会被删除。按 execution_events → executions → messages → members → conversation 的顺序执行，兼容现有 `source_message_id` 的 RESTRICT 外键。

- [ ] **Step 2: Run test to verify it passes**

Run: `pnpm --filter @agentos/server exec node --import tsx --test src/store/SqliteStore.test.ts`

Expected: 新增删除测试 PASS，现有 Store 测试全部 PASS。

### Task 3: 为 DELETE 路由建立失败测试并实现接口

**Files:**
- Modify: `apps/server/src/routes/conversations.test.ts`
- Modify: `apps/server/src/routes/conversations.ts`
- Test: `apps/server/src/store/SqliteStore.test.ts`
- Modify: `agent-memory/LOG.md`

**Interfaces:**
- Consumes: `DELETE /api/workspaces/:workspaceId/conversations/:conversationId`。
- Produces: 成功返回 `200 { conversationId }`；未知 workspace 返回 404；未知会话返回 404。

- [ ] **Step 1: Write the failing route test**

在现有路由测试中创建一个直聊，先通过现有 stream 接口写入真实 mock 数据，再调用 DELETE，断言响应状态为 200、返回的 conversationId 正确，随后 GET conversations 不再包含该 ID。追加两个请求断言：`/api/workspaces/missing/conversations/<id>` 返回 404，`/api/workspaces/workspace-a/conversations/missing` 返回 404。

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentos/server exec node --import tsx --test src/routes/conversations.test.ts`

Expected: DELETE 请求返回 404，因为路由尚未注册。

- [ ] **Step 3: Write the minimal route implementation**

在现有 PATCH 路由之后加入：

```ts
router.delete('/conversations/:conversationId', (req: Request, res: Response) => {
  const workspace = workspaceManager.get(req.params.workspaceId);
  if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
  try {
    store.deleteConversation(workspace.id, req.params.conversationId);
    res.json({ conversationId: req.params.conversationId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(message === 'Conversation not found' ? 404 : 400).json({ error: message });
  }
});
```

- [ ] **Step 4: Run route and full server tests**

Run: `pnpm --filter @agentos/server exec node --import tsx --test src/routes/conversations.test.ts`

Expected: 新增 DELETE 测试 PASS。

Run: `pnpm --filter @agentos/server test`

Expected: server 全部测试 PASS。

### Task 4: 为前端删除回退和菜单位置建立纯函数失败测试

**Files:**
- Create: `apps/web/src/lib/conversationActions.ts`
- Create: `apps/web/src/lib/conversationActions.test.ts`
- Modify: `agent-memory/LOG.md`

**Interfaces:**
- Produces `getNextConversationId(conversations: Conversation[], deletedId: string): string | null`：按删除前列表选择同索引下一项，没有下一项时选择前一项，再没有则返回 null。
- Produces `getContextMenuPosition(input): { left: number; top: number }`：以给定 margin 限制菜单不超出视口。

- [ ] **Step 1: Write the failing tests**

覆盖四个行为：删除中间项选择下一项、删除末尾项选择前一项、删除唯一项返回 null、菜单右下角坐标被限制在 viewport 内。测试只使用普通对象和纯函数，不引入 React 测试依赖。

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentos/web exec node --import tsx --test src/lib/conversationActions.test.ts`

Expected: FAIL，模块或导出函数尚不存在。

- [ ] **Step 3: Implement minimal helpers and rerun**

实现上述两个纯函数，菜单默认宽高使用调用方传入值，默认 margin 为 8；运行同一命令，Expected: PASS。

### Task 5: 接入自定义右键菜单、通用重命名和返回按钮

**Files:**
- Create: `apps/web/src/components/chat/ConversationContextMenu.tsx`
- Modify: `apps/web/src/components/chat/AgentList.tsx`
- Modify: `apps/web/src/components/chat/ConversationHistory.tsx`
- Modify: `apps/web/src/components/chat/GroupRenameModal.tsx`
- Modify: `apps/web/src/app/workspace/[id]/page.tsx`
- Test: `apps/web/src/lib/conversationActions.test.ts`
- Modify: `agent-memory/LOG.md`

**Interfaces:**
- `AgentList` 新增 `onContextMenu(conversationId: string, event: React.MouseEvent<HTMLButtonElement>): void` 与 `onBackToWorkspace(): void`。
- `ConversationHistory` 新增同名 `onContextMenu`。
- `ConversationContextMenu` 接收 `conversation`、`left`、`top`、`onRename`、`onCopyId`、`onDelete`、`onClose`。
- `GroupRenameModal` 新增可选 `entityLabel?: string`，默认 `群聊`，供直聊重命名时显示 `会话` 文案。

- [ ] **Step 1: Add the menu component**

使用固定定位深色面板，菜单项为“重命名”“复制会话 ID”“删除会话”；点击任一项先执行操作回调并关闭菜单。使用 `getContextMenuPosition` 对传入坐标进行边界限制；按钮使用 `type="button"`，避免意外提交表单。

- [ ] **Step 2: Wire context menu events into list components**

保持现有点击选择逻辑，在群聊和历史会话按钮上增加 `onContextMenu={event => onContextMenu(id, event)}`。只给会话按钮增加右键事件，不给智能体按钮增加。

- [ ] **Step 3: Add page-level action state and navigation**

在工作区页面使用 `useRouter`：

- `contextMenu` 保存会话快照与 client 坐标；打开时 `preventDefault`。
- 通过 `useEffect` 在菜单打开期间监听 `mousedown` 和 `keydown`，处理外部点击/Escape。
- 复用现有 PATCH 请求，`saveConversationTitle` 同时更新 groups 或 direct conversations；`GroupRenameModal` 使用 `entityLabel` 显示对应标题。
- `copyConversationId` 调用 `navigator.clipboard.writeText`，失败写入现有 `error` 状态，成功显示短暂文本提示或清空错误。
- `deleteConversation` 先 `window.confirm`，再调用 DELETE；成功后用 `getNextConversationId` 更新对应列表和选择，并清空消息/执行状态；失败保留原状态并显示错误。
- 将 `onBackToWorkspace={() => router.push('/')}` 传给 `AgentList`。

- [ ] **Step 4: Run frontend helper tests and type/build checks**

Run: `pnpm --filter @agentos/web exec node --import tsx --test src/lib/conversationActions.test.ts`

Expected: PASS。

Run: `pnpm --filter @agentos/web run build`

Expected: Next.js build PASS，无 TypeScript 错误。

### Task 6: 浏览器验收与收尾记录

**Files:**
- Modify: `agent-memory/LOG.md`
- Modify: `agent-memory/DECISIONS.md`（仅在实际实现与设计有偏差时更新）

**Interfaces:**
- Consumes: 已运行的 AgentOS server 和 web dev server。
- Produces: 可复现的浏览器交互验证结果和截图证据，不把截图/临时脚本写入仓库。

- [ ] **Step 1: Read the Browser skill and start/locate the app**

Browser 插件可用时先读取 `C:/Users/Administrator/.codex/plugins/cache/openai-bundled/browser/26.707.31428/skills/control-in-app-browser/SKILL.md`，使用其 Node REPL；目标流程为：工作区聊天页加载 → 右键会话 → 操作菜单 → 返回工作区。

- [ ] **Step 2: Verify page identity and baseline health**

确认 URL、标题、DOM 有 AgentOS/聊天内容、没有框架错误覆盖层，并检查 console error/warn。

- [ ] **Step 3: Exercise the target flow**

验证群聊右键菜单、历史会话右键菜单、点击外部关闭、Escape 关闭、取消删除、重命名、复制 ID、确认删除和“返回工作区”；每步用 DOM snapshot、可见文本、URL 或截图确认状态变化。

- [ ] **Step 4: Run final checks and record outcome**

运行 `pnpm --filter @agentos/server test` 和 `pnpm --filter @agentos/web run build`，检查本次文件 diff 边界，追加 `agent-memory/LOG.md`，然后按前端 QA 格式汇报环境、检查项、交互路径、证据和剩余风险。

