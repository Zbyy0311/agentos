# 会话右键菜单与返回工作区设计

## 背景

工作区聊天页目前可以选择智能体、群聊和历史会话，但会话条目缺少快捷管理入口，页面也没有明确的工作区目录返回按钮。本次改动只覆盖会话管理和导航，不改变智能体配置流程或聊天执行流程。

## 目标

1. 群聊条目和历史会话条目支持自定义右键菜单。
2. 支持重命名、复制会话 ID、删除会话。
3. 删除会话时清理该会话的成员、消息、执行记录和执行事件。
4. 删除当前会话后，界面自动选择同列表中的下一个会话；列表为空时清空聊天和执行状态。
5. 页面顶部提供“返回工作区”按钮，点击后返回 `/` 工作区目录。
6. 通过后端测试、前端构建和浏览器交互验证行为。

## 非目标

- 智能体条目不增加右键菜单，智能体配置仍使用现有编辑入口。
- 不改变会话消息、SSE 执行或执行状态的业务逻辑。
- 不引入新的 UI 组件库或全局状态管理库。

## 方案

### 前端交互

在 `AgentList` 和 `ConversationHistory` 中为会话条目增加 `onContextMenu` 回调。工作区页面统一维护右键菜单状态：目标会话、菜单坐标和会话类型。菜单使用固定定位，打开时将坐标限制在视口内；点击页面其他位置或按 Escape 关闭。

菜单项行为如下：

- **重命名**：打开统一的会话重命名弹窗，复用现有 `PATCH /conversations/:conversationId` 接口；群聊和直聊只使用不同的标题文案。
- **复制会话 ID**：调用浏览器剪贴板 API，成功后显示短暂的成功提示；失败时进入页面错误提示，不阻断其他会话操作。
- **删除会话**：使用确认弹窗；确认后调用新增的 DELETE 接口，成功后从对应列表移除，并按稳定规则选择下一个会话。

页面顶部的“返回工作区”按钮调用 Next.js router 的 `push('/')`。按钮放在聊天页固定可见的顶部区域，不依赖当前是否选中会话。

### 后端接口

保留现有：

- `PATCH /api/workspaces/:workspaceId/conversations/:conversationId`：更新标题。

新增：

- `DELETE /api/workspaces/:workspaceId/conversations/:conversationId`：校验工作区和会话归属后删除会话，成功返回 `{ conversationId }`。

删除操作放在 `SqliteStore.deleteConversation` 中，并使用事务按依赖顺序删除：

1. 找出该会话的执行 ID。
2. 删除 `execution_events`。
3. 删除 `executions`、`messages`、`conversation_members`。
4. 删除 `conversations`。

这样可以避免外键约束或 SQLite 外键开关差异导致的残留数据。不存在的会话返回 404；删除过程中错误由现有错误处理中间件转换为 400/500 响应。

### 状态更新

删除成功后：

- 群聊从 `groups` 中移除；直聊从 `conversations` 中移除。
- 如果删除的是当前会话，按删除前列表中的下一个索引选择目标；没有目标则清空 `selectedGroupId` 或 `selectedDirectConversationId`，并清空 `messages`、`executions`、`activeEvents` 和 `activeStatus`。
- 如果删除的是非当前会话，只更新列表。
- 删除期间禁用重复删除操作，并在失败时保留原列表和当前选择。

## 组件与文件边界

- `apps/web/src/components/chat/AgentList.tsx`：群聊条目右键事件。
- `apps/web/src/components/chat/ConversationHistory.tsx`：历史会话条目右键事件。
- `apps/web/src/components/chat/ConversationContextMenu.tsx`：自定义菜单 UI。
- `apps/web/src/components/chat/ConversationRenameModal.tsx`：直聊和群聊共用的重命名弹窗。
- `apps/web/src/app/workspace/[id]/page.tsx`：菜单状态、重命名/删除/复制流程、返回按钮和选择回退。
- `apps/server/src/routes/conversations.ts`：DELETE 路由。
- `apps/server/src/store/SqliteStore.ts`：事务删除方法。
- `apps/server/src/routes/conversations.test.ts` 与 `apps/server/src/store/SqliteStore.test.ts`：接口和级联删除测试。

## 测试策略

先写失败测试，再实现：

1. Store 测试验证删除会话后会话、成员、消息、执行和执行事件均不存在，其他会话不受影响。
2. 路由测试验证同工作区删除成功、未知工作区 404、未知会话 404。
3. 运行现有 server 测试和 web 类型检查/构建。
4. 浏览器验证：打开菜单、点击外部关闭、Escape 关闭、重命名、复制 ID、取消删除、确认删除，以及返回工作区。

## 风险与缓解

- **删除误操作**：确认弹窗；删除接口按 workspaceId 严格校验归属。
- **菜单被窗口裁切**：根据菜单尺寸和视口宽高调整固定坐标。
- **剪贴板权限不足**：捕获异常并给出错误提示，不影响其他操作。
- **现有工作区存在历史脏数据**：删除使用显式依赖顺序，测试验证不会影响同工作区其他会话。
- **当前工作区有未提交改动**：仅修改本设计涉及的文件，实施前后通过 diff 检查变更边界。

## 自审结论

- 需求覆盖：右键菜单、会话管理操作和返回工作区均有明确实现路径。
- 数据安全：删除只接受路由中的 workspaceId，并在存储层再次校验会话归属。
- 复杂度：不引入全局状态或第三方菜单库，菜单状态集中在现有工作区页面。
- 可验证性：后端数据级测试覆盖级联清理，浏览器测试覆盖用户可见交互。
- 需要在实施阶段特别确认：SQLite 当前版本对事务回调/执行方式的支持，以及现有测试 harness 的路由调用方式。

