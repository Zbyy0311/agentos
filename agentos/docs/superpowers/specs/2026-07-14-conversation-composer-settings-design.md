# 会话级模型与思考强度记忆设计

## 目标

让发送区选择的模型和思考强度按“会话”保存，而不是按智能体全局保存。相同智能体的不同会话可以使用不同的模型与思考强度组合；重新进入会话、切换智能体后再返回、刷新页面或重启 AgentOS 后，都恢复该会话最近保存的组合。

## 当前问题

`apps/web/src/app/workspace/[id]/page.tsx` 只在 React 状态中保存 `composerModel` 和 `composerThinkingEffort`，并通过 `getInitialComposerSettings(selectedAgent)` 从智能体默认值初始化。`Conversation` 和 SQLite `conversations` 表没有这两个字段，因此切换会话后只能回到智能体默认配置。

## 方案

在现有 `conversations` 表中增加两个可为空字段：

- `model TEXT`：为空表示使用当前智能体默认模型。
- `thinking_effort TEXT`：为空表示使用当前智能体默认思考强度。

扩展共享 `Conversation` 类型，使 API 返回会话设置。服务端提供专用接口：

```text
PATCH /api/workspaces/:workspaceId/conversations/:conversationId/settings
Body: { model: string | null, thinkingEffort: ThinkingEffort }
```

接口按该会话的直接智能体能力校验模型和思考强度，保存成功后返回完整 `conversation`。清空模型时传 `model: null`，恢复智能体默认模型。

前端行为：

1. 加载会话列表时拿到会话设置。
2. 当前会话改变时，用“会话设置覆盖智能体默认值”初始化发送区。
3. 已存在会话中修改模型或思考强度后立即调用 settings 接口。
4. 新会话尚未有会话 ID 时只更新页面状态；首次发送创建会话后，立即保存当前组合，再发送消息。
5. 群聊继续显示“按成员配置”，不显示或保存单一模型选择。

## 兼容与错误处理

- SQLite 启动时使用 `ensureColumn` 为旧数据库补充新字段，旧会话字段为空，继续使用智能体默认值。
- 不修改智能体全局 `model` 和 `thinkingEffort`，因此不会影响其他会话。
- 服务端拒绝不存在的模型、模型不支持的思考强度和非法思考强度，并返回 400。
- 保存失败时保留当前输入状态并在现有错误区域显示错误，下一次修改仍可重试。

## 验收标准

- 会话 A 设置为模型 A + high，切换到会话 B 设置为模型 B + low；两者来回切换后分别恢复原组合。
- 相同智能体切换到其他智能体，再返回原智能体，会话 A 的设置仍保持。
- 刷新页面或重启服务后，会话设置仍保持。
- 新建会话首次打开时使用智能体默认模型和思考强度。
- 将模型恢复为“默认模型”后，会话保存值为空模型，并恢复智能体默认模型。
- 非法模型或不支持的思考强度不会写入数据库，也不会创建执行记录。
- 现有 AgentOS 测试、Web 测试、TypeScript 检查和生产构建全部通过。
