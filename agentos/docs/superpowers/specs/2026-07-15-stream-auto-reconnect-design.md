# 流式执行自动重连设计

## 背景

工作区聊天通过 `fetch()` 读取服务端 SSE。当前前端在 `reader.read()` 返回 `done: true` 时直接结束读取，并在 `finally` 中调用 `reader.cancel()`；服务端又会在响应连接关闭时中止对应的 CLI 执行。因此网络断开会表现为“没有错误、没有结果、任务静默结束”，而直接重复发送原消息会创建重复 Run。

## 目标

- 异常 EOF、网络错误或服务端连接断开时，继续订阅同一个 Run，不重复创建用户消息或执行。
- 使用指数退避自动重连：第 1、2、3、4、5 次重连等待 1、2、4、8、16 秒，最多 5 次。
- 重连期间在聊天面板显示明确状态，不把断线误显示为完成。
- 用户主动点击停止后立即终止执行，不触发自动重连。
- 收到明确的 `done`、`error` 或终态后结束订阅并刷新会话数据。
- 让重连能够补齐断线期间已持久化的执行事件和最终消息。

## 非目标

- 不改变 CLI 执行器、模型调用参数或已有消息持久化格式。
- 不实现跨服务器实例的分布式流恢复；当前服务为单进程本地服务。
- 不自动重试已经明确返回 HTTP 4xx 的请求。

## 方案

### 服务端生命周期

`messages/stream` 和 `resume/stream` 创建 Run 后，将 Run 的执行控制器和实时订阅状态注册到一个进程内的 `RunStreamRegistry`。客户端连接断开只移除该连接的 SSE writer，不再自动 abort 后台 Run；后台执行继续写入现有 SQLite 执行事件和消息记录。

新增同一 Run 的恢复订阅接口：

```text
GET /api/workspaces/:workspaceId/conversations/:conversationId/runs/:runId/stream
```

恢复接口先读取该 Run 的执行详情，按游标补发断线期间持久化的执行事件、已生成的消息和当前状态；若 Run 仍未进入终态，则订阅 `RunStreamRegistry` 的后续事件。若 Run 已进入终态，则直接发送 `done` 并结束响应。

初始 POST 流在 Run 创建后发送一个包含 `runId` 的 `run` 事件。事件流中的执行事件保留现有字段，并使用递增的事件游标；客户端携带最后消费的游标重新订阅，避免重复追加流式内容。

停止执行改为显式调用：

```text
POST /api/workspaces/:workspaceId/conversations/:conversationId/runs/:runId/cancel
```

服务端通过注册表中的 AbortController 取消对应 Run，并持久化 `cancelled` 终态。连接关闭本身不再等价于用户取消。

### 前端读取与重连

将当前内联 SSE 读取逻辑抽成可测试的 `consumeConversationStream` / `retryConversationStream` 边界：

- 首次连接使用已有 POST 请求，并记录 `runId`、最后事件游标和是否收到终态事件。
- `reader.read()` 返回 `done: true` 但尚未收到 `done` 时视为异常断开，进入重连；`reader.cancel()` 只用于释放当前 reader。
- 网络异常、连接提前结束和可重试的 5xx 进入退避；4xx、AbortError、用户取消和明确终态不重试。
- 重连等待采用 `min(1000 * 2 ** retryIndex, 16000)`，最多 5 次；每次成功建立恢复流后重置退避计数。
- 重连期间保留当前已显示的 `activeEvents` 和 `streamingContent`，恢复流只消费游标之后的数据。
- 所有重连失败后显示可见错误，并保留 `runId`，让用户可以手动再次连接或查看执行详情；不将任务伪装成完成。
- `handleCancel` 先标记用户主动取消、取消当前 fetch，再调用取消接口；清空排队消息的现有行为不变。

### UI 状态

在当前执行进度区域增加连接状态：

- `正在重连（第 N/5 次）…`
- `连接已恢复`
- `连接断开，自动重连失败；任务可能仍在后台执行`

发送按钮继续显示停止按钮；重连期间输入框保持可用，但不允许对同一 Run 重复发送新的执行请求。

## 测试设计

### 前端单元测试

在 `apps/web/src/lib/streamReconnect.test.ts` 覆盖：

1. 正常收到 `done` 时不重连。
2. 提前 EOF 会按 1、2、4、8、16 秒顺序重连。
3. 第一次恢复连接成功后停止继续退避，并继续消费后续事件。
4. 连续 5 次失败后返回可展示的连接错误。
5. 用户主动取消或 `AbortError` 不触发重连。
6. 重连游标只消费新事件，不重复追加已显示的流式内容。

### 服务端单元/路由测试

在 `apps/server/src/routes/conversations.test.ts` 覆盖：

1. 客户端连接关闭后 Run 仍可完成，且执行事件和最终消息持久化。
2. 恢复接口能够补发已有执行事件，并在 Run 完成时发送 `done`。
3. 恢复订阅不会创建新的 user message、Run 或 execution。
4. 显式取消会终止 Run 并持久化 `cancelled`，之后客户端不会重连。
5. 不存在的 Run、错误 conversationId 和终态 Run 返回明确 HTTP 状态。

### 验收标准

- 模拟 `reader.read()` 提前返回 `done` 时，页面出现重连状态，且不会静默结束。
- 服务端/浏览器短暂断开后，同一 Run 最终只产生一条用户消息和一组执行记录。
- 点击停止后不会再次发起恢复请求。
- 前端现有 SSE、取消、队列和会话刷新测试全部通过，Next.js 构建通过。
