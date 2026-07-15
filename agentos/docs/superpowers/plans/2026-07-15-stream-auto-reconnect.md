# 流式执行自动重连 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让聊天 SSE 在异常 EOF 或网络断开后恢复订阅同一个 Run，并用指数退避避免静默结束或重复执行。

**Architecture:** 服务端用进程内 `RunStreamRegistry` 保存活动 Run 的 AbortController、事件游标和订阅者；连接断开只解绑 SSE 客户端，不中止后台 Run。前端首次流获得 `runId` 和游标，异常断开后通过恢复接口按游标继续订阅；用户停止则调用显式 cancel 接口。

**Tech Stack:** Express、TypeScript、SQLite 持久化执行记录、浏览器 Fetch ReadableStream、Node `node:test`。

## Global Constraints

- 最大自动重连次数为 5 次，退避等待为 1、2、4、8、16 秒。
- 用户主动取消、AbortError、HTTP 4xx 和明确终态不自动重连。
- 不重复创建 user message、Run 或 execution。
- 修改现有工作区架构，不改 CLI 执行器和消息持久化格式。

---

### Task 1: 建立服务端 Run 流注册表

**Files:**
- Create: `apps/server/src/services/RunStreamRegistry.ts`
- Test: `apps/server/src/services/RunStreamRegistry.test.ts`

**Interfaces:**
- Produces `RunStreamRegistry.open(runId, controller)`, `emit(runId, event, data)`, `subscribe(runId, afterCursor, handler)`, `finish(runId, event, data)`, `cancel(runId)`。
- 每个发出的事件带递增 `cursor`；`subscribe` 先补发 `cursor > afterCursor` 的历史事件，再监听新事件。

- [ ] **Step 1: Write the failing tests**

覆盖以下行为：空注册表无法订阅；事件游标递增；订阅从游标后补发且接收后续事件；完成事件可被迟到订阅者重放；取消只触发活动 Run 的 AbortController。

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test apps/server/src/services/RunStreamRegistry.test.ts`

Expected: FAIL because `RunStreamRegistry` does not exist.

- [ ] **Step 3: Write the minimal registry implementation**

使用 `Map<string, Session>`，Session 保存 `events`, `nextCursor`, `subscribers`, `controller`, `finished`。事件数据为对象时浅拷贝并加入 `cursor`；完成后保留 60 秒供恢复订阅，清理定时器使用 `unref`。

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test apps/server/src/services/RunStreamRegistry.test.ts`

Expected: all registry tests PASS。

### Task 2: 让服务端流支持断线恢复和显式取消

**Files:**
- Modify: `apps/server/src/services/ConversationService.ts`
- Modify: `apps/server/src/routes/conversations.ts`
- Test: `apps/server/src/routes/conversations.test.ts`

**Interfaces:**
- `SendDirectMessageInput` 和 `SendGroupMessageInput` 增加 `onRunCreated?: (run: AgentRun) => void`。
- 恢复接口：`GET /conversations/:conversationId/runs/:runId/stream?cursor=N`。
- 取消接口：`POST /conversations/:conversationId/runs/:runId/cancel`。

- [ ] **Step 1: Add failing route tests**

增加测试：初始流发送 `run` 事件；断开初始响应后后台 Run 仍完成；恢复流只补发游标之后的事件并最终发送 `done`；恢复不会新增消息或执行；显式 cancel 触发 AbortController。

- [ ] **Step 2: Run the targeted route tests to verify failure**

Run: `pnpm --filter @agentos/server test -- conversations.test.ts`

Expected: FAIL because the recovery and cancel routes are not implemented.

- [ ] **Step 3: Wire Run creation and registry events**

在服务创建 Run 后调用 `onRunCreated`。路由创建并持有 AbortController，注册初始订阅；执行事件、群聊 agent message、最终 message 和 `done/error` 都写入 registry。`res.close` 只解绑订阅和心跳，不再 abort。

- [ ] **Step 4: Add recovery and cancel routes**

恢复路由校验 workspace、conversation、Run，设置 SSE headers，调用 `registry.subscribe(runId, cursor, writer)`；取消路由校验归属后调用 `registry.cancel(runId)`，不存在活动 Run 时返回明确 409/404。

- [ ] **Step 5: Run targeted route and service tests**

Run: `pnpm --filter @agentos/server test -- conversations.test.ts ConversationService.test.ts`

Expected: all targeted tests PASS。

### Task 3: 建立前端指数退避重连逻辑

**Files:**
- Create: `apps/web/src/lib/streamReconnect.ts`
- Test: `apps/web/src/lib/streamReconnect.test.ts`

**Interfaces:**
- `getReconnectDelay(attempt: number): number` 返回 `min(1000 * 2 ** attempt, 16000)`。
- `shouldReconnect(input)` 区分异常 EOF、网络错误、AbortError、4xx 和用户取消。
- `consumeSseResponse(response, options)` 消费 SSE，并在未收到终态时抛出可识别的 `UnexpectedStreamEndError`。

- [ ] **Step 1: Write the failing helper tests**

覆盖退避序列、正常 `done` 不重连、提前 EOF 可重连、AbortError/主动取消不可重连、达到 5 次返回失败。

- [ ] **Step 2: Run the helper tests to verify failure**

Run: `node --test apps/web/src/lib/streamReconnect.test.ts`

Expected: FAIL because the helper module does not exist.

- [ ] **Step 3: Implement minimal stream helpers**

复用现有 `parseSseChunk` 和 `parseSseEventData`；把 `reader.cancel()` 放在单次连接的 finally，仅把 `done` 作为终态事件已确认后的清理动作；未确认终态的 EOF 抛出 `UnexpectedStreamEndError`。

- [ ] **Step 4: Run helper and existing SSE tests**

Run: `node --test apps/web/src/lib/streamReconnect.test.ts apps/web/src/lib/sse.test.ts`

Expected: all tests PASS。

### Task 4: 接入 Workspace 页面和停止/重连 UI

**Files:**
- Modify: `apps/web/src/app/workspace/[id]/page.tsx`
- Modify: `apps/web/src/components/chat/ChatPanel.tsx`

**Interfaces:**
- 页面记录 `streamRunIdRef`、`streamCursorRef`、`userCancelledRef` 和 `connectionNotice`。
- `ChatPanel` 增加可选 `connectionNotice?: string`，在执行状态下展示“正在重连（第 N/5 次）…”或最终恢复失败提示。

- [ ] **Step 1: Add the failing page-level behavior test or pure-state assertions**

扩展 `composerInteraction.test.ts` 或新增纯函数断言，确保异常 EOF 不清除发送状态/流内容，主动取消会阻止后续恢复请求。

- [ ] **Step 2: Run the regression test to verify failure**

Run: `node --test apps/web/src/lib/composerInteraction.test.ts apps/web/src/lib/streamReconnect.test.ts`

Expected: new assertions FAIL before integration.

- [ ] **Step 3: Replace inline stream loop with reconnect loop**

首次 POST 收到 `run` 事件后保存 Run ID；异常 EOF 或网络错误按退避调用恢复 GET，并带上最后游标。恢复事件继续走现有 execution/message/done 分支，重复事件由游标过滤。成功收到终态后刷新 conversations/groups/details；失败显示可见错误且不伪装完成。

- [ ] **Step 4: Update explicit cancel flow**

`handleCancel` 设置主动取消标记，调用 `/runs/:runId/cancel`，再 abort 当前 Fetch、清空排队消息；重连等待中的 timer 也必须取消。

- [ ] **Step 5: Render connection notice and run frontend tests**

Run: `node --test apps/web/src/lib/composerInteraction.test.ts apps/web/src/lib/streamReconnect.test.ts apps/web/src/lib/sse.test.ts`

Expected: all frontend stream tests PASS。

### Task 5: 全量验证与浏览器回归

**Files:**
- No new source files; review all files changed above.

- [ ] **Step 1: Run all relevant unit tests**

Run: `node --test apps/web/src/lib/*.test.ts apps/server/src/services/RunStreamRegistry.test.ts apps/server/src/routes/conversations.test.ts`

Expected: 0 failed tests。

- [ ] **Step 2: Build the web application**

Run: `pnpm --filter @agentos/web build`

Expected: Next.js compilation, type checking and static generation exit 0。

- [ ] **Step 3: Run diff and status checks**

Run: `git -c safe.directory=E:/workspace/Multi-Agent diff --check`

Expected: no whitespace errors in the feature diff。

- [ ] **Step 4: Validate the rendered flow in the existing Browser tab**

Flow: workspace page loads → send/observe an active run → verify connection notice and stop button remain usable → verify no console errors. If a real network cut cannot be safely induced, document that the reconnect state is covered by unit tests and keep the browser check to page identity, DOM, console and cancel interaction.
