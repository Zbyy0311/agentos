# 对话执行流式输出改造计划

## 背景

AgentOS 当前有两套执行流：

1. Task Pipeline 已经会把 CLI stdout chunk 通过 SSE 推送到前端。
2. Conversation 模式虽然已经建立 SSE、RunStreamRegistry 和前端累加链路，但 `ConversationAgentRunner` 只累积 `onChunk` 内容，等 CLI 完成后才发送一次完整的 `streaming_response` 事件。

因此，对话回复目前不是实时逐段显示。

## 目标

让 Conversation 模式下的 CLI 输出在收到每个非空 chunk 后立即通过现有 SSE 链路发送到前端，同时保持最终消息、取消、重连和等待用户流程正确。

## 变更范围

### 实际修改文件

- `packages/agent-core/src/conversationRunner.ts`
- `packages/agent-core/src/conversationRunner.test.ts`

### 保持不变的文件

以下链路已经支持 `execution` 事件转发和前端 chunk 累加，不需要修改：

- `packages/agent-core/src/executor.ts`
- `apps/server/src/routes/conversations.ts`
- `apps/server/src/services/RunStreamRegistry.ts`
- `apps/server/src/services/ConversationService.ts`
- `apps/web/src/app/workspace/[id]/page.tsx`
- `apps/web/src/components/chat/ChatPanel.tsx`
- `apps/web/src/lib/sse.ts`
- `apps/web/src/lib/streamReconnect.ts`

## 现有数据流

```text
CLI stdout chunk
  -> CLIExecutor.onChunk(text, done)
  -> ConversationAgentRunner
  -> ConversationService.recordExecutionEvent
  -> RunStreamRegistry.emit
  -> Conversation SSE endpoint
  -> 前端 handleStreamEvent
  -> setStreamingContent(current => current + chunk)
  -> ChatPanel 实时渲染
```

## 实现要求

### 1. 每个非空 chunk 立即发送

`ConversationAgentRunner.run()` 中的 `onChunk` 改为接收 `(text, done)`：

```typescript
onChunk: (text, done) => {
  if (!text) return;
  streamedContent += text;
  this.emit('streaming_response', '正在生成回复', text);
},
```

`done: true` 只表示 CLI 输出结束，不应产生空的 `streaming_response` 事件。

删除 `run()` 完成阶段对完整 `content` 的一次性 `streaming_response` 发送，避免前端收到重复内容。

### 2. 保持最终结果一致

所有 chunk 仍必须累加到 `streamedContent`。CLI 执行成功后继续使用：

```typescript
const content = streamedContent || log.stdout || log.stderr;
```

普通回复的 `result.content` 必须等于所有已发送 chunk 的拼接结果。

### 3. 防止等待用户标记泄漏

当前 Runner 只有拿到完整输出后才能识别完整的 `agentos-waiting-user` 标记。如果直接原样发送每个 chunk，特殊标记可能先显示在用户界面。

实现一个待确认缓冲，满足以下规则：

- 所有输出仍累积到 `streamedContent`。
- 当待发送内容仍可能是 `agentos-waiting-user` 标记的前缀时，暂不发送 `streaming_response`。
- 一旦确认不是该标记，再尽早把缓冲内容发送为普通回复 chunk。
- CLI 完成后，如果完整输出解析为等待用户标记，只发送 `waiting_user` 事件。
- 等待用户流程中不能发送包含 `agentos-waiting-user` 的 `streaming_response`。
- 普通回复不能因此被全部延迟到 CLI 完成后。

## TDD 测试任务

### 测试 1：普通回复逐 chunk 转发

在 `packages/agent-core/src/conversationRunner.test.ts` 增加测试，模拟 `CLIExecutor.execute`：

```typescript
context.onChunk?.('第一段', false);
context.onChunk?.('第二段', false);
context.onChunk?.('', true);
```

断言：

- `result.content` 等于 `第一段第二段`。
- `streaming_response` 事件有两条。
- 两条事件的内容分别是 `第一段` 和 `第二段`。
- 不存在内容为 `第一段第二段` 的单条聚合事件。

先在旧实现上运行测试，必须失败，因为旧实现只在 CLI 完成后发送一条完整事件；再实现代码使其通过。

### 测试 2：空 chunk 和 done 事件不转发

在同一测试或独立测试中调用：

```typescript
context.onChunk?.('', false);
context.onChunk?.('', true);
```

断言不会产生空内容的 `streaming_response` 事件。

### 测试 3：等待用户标记跨 chunk 不泄漏

将完整等待标记拆成至少三次 `onChunk` 调用，例如：

```typescript
context.onChunk?.('<!-- agentos-waiting-', false);
context.onChunk?.('user: {"question":"请提供部署环境"}', false);
context.onChunk?.(' -->', false);
context.onChunk?.('', true);
```

断言：

- 最终状态为 `waiting_user`。
- `waitingQuestion` 为 `请提供部署环境`。
- 没有 `streaming_response` 事件。
- 任意事件的 `content` 都不包含 `agentos-waiting-user`。

## 验证命令

`apps/web/package.json` 当前没有 `test` 脚本，也没有 Web 侧 Vitest 配置，因此不得使用 `cd apps/web && pnpm test` 作为验收命令。实现后运行：

```powershell
pnpm --filter @agentos/agent-core test
pnpm --filter @agentos/server test
pnpm --filter @agentos/web build
```

## 手动功能验收

使用已运行的 `http://localhost:3001/`：

1. 进入一个直接会话。
2. 发送一条需要 Agent 回复的消息。
3. 确认回复内容随着 CLI 输出分段出现，而不是等待执行完成后一次性出现。
4. 确认最终消息完整且没有重复内容。
5. 在执行中点击取消，确认取消状态仍正常显示。
6. 使用等待用户场景，确认界面只显示等待问题，不显示内部标记文本。

## 完成标准

- 每个非空 CLI chunk 都产生一个对应的 `streaming_response` 事件。
- `done: true` 不产生空事件。
- 普通回复的最终 `result.content` 与所有 chunk 拼接结果一致。
- 不再发送完成阶段的重复聚合事件。
- 等待用户标记跨 chunk 时不会泄漏到事件流或界面。
- `pnpm --filter @agentos/agent-core test` 通过。
- `pnpm --filter @agentos/server test` 通过。
- `pnpm --filter @agentos/web build` 通过。
- 手动功能验收通过。
