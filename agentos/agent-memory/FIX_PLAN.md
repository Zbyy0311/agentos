# AgentOS 代码修复计划（终版）

> 生成日期：2026-07-12
> 来源：ClaudeCode × OpenCode × MimoCode 三轮审查 + Codex 逐项裁决
> 优先级：P0 → P1 → P2
> 每条目包含：Codex 最终结论 → 修复方案 → 验证方法

---

## P0 — 必须立即修复

### 1. 非 Codex CLI 只读 Agent 崩溃

**文件：** `packages/agent-core/src/conversationRunner.ts:89-95`
**Codex 裁决：** ✅ 部分成立。聊天路径会返回失败结果（不一定是 HTTP 500），但跳过 sandbox 正常执行会绕过只读权限。

**问题：** 非 Codex CLI（opencode/mimo）且权限不含 `write` 时直接抛错。不应静默降级执行。

**修复方案 A（推荐）：** 为各 CLI 实现明确的只读能力适配。对 Codex 修正 `--sandbox` 的位置：
```typescript
if (process.env.AGENTOS_FORCE_MOCK !== 'true' && !agent.permissions.includes('write')) {
  if (isCodexCli(agent.cliCommand)) {
    // Codex: 移除 --dangerously-bypass，插入 --sandbox read-only
    cliArgs = agent.cliArgs.filter(arg => arg !== '--dangerously-bypass-approvals-and-sandbox');
    // --sandbox 是全局选项，必须放在子命令（exec）之前
    cliArgs.unshift('--sandbox', 'read-only');
  } else {
    // 非 Codex CLI: 无法强制执行只读，返回明确的拒绝原因
    throw new Error(
      `${agent.name} 的 CLI 不支持只读沙箱模式，无法限制执行权限。` +
      `如需使用 ${agent.name}，请为其赋予 'write' 权限，或设置 AGENTOS_FORCE_MOCK=true。`
    );
  }
}
```

**验证：** 创建 opencode agent 且权限不含 write → 获得明确错误消息而非 500/崩溃。

---

### 2. 缺少 Express 错误处理中间件

**文件：** `apps/server/src/index.ts:51-55` 之后
**Codex 裁决：** ✅ 成立

**修复：** 注册 JSON 错误处理中间件：
```typescript
import type { NextFunction, Request, Response } from 'express';

// 在所有路由之后、app.listen 之前
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(`[AgentOS Server] Unhandled error: ${err.message}`);
  res.status(500).json({ error: err.message || 'Internal server error' });
});
```

**验证：** 触发任意路由异常 → 返回 `{ error: "..." }` JSON 而非 HTML。

---

### 3. 删除 Workspace 不清理 SQLite

**文件：** `apps/server/src/managers/WorkspaceManager.ts:58-61` + `SqliteStore.ts`
**Codex 裁决：** ✅ 成立

**修复：** SqliteStore 新增方法，按 workspace_id 级联删除。**注意：使用参数化查询而非字符串拼接：**
```typescript
// SqliteStore.ts
deleteWorkspace(workspaceId: string): void {
  this.database.exec('BEGIN');
  try {
    for (const table of ['execution_events', 'executions', 'messages',
                         'conversation_members', 'conversations', 'agent_profiles']) {
      const del = this.database.prepare(`DELETE FROM ${table} WHERE workspace_id = ?`);
      del.run(workspaceId);
    }
    this.database.exec('COMMIT');
  } catch {
    this.database.exec('ROLLBACK');
    throw new Error('Failed to clean up workspace data');
  }
}

// WorkspaceManager.ts
remove(id: string): void {
  const workspaces = this.store.loadWorkspaces().filter(w => w.id !== id);
  this.store.saveWorkspaces(workspaces);
  if (typeof (this.store as SqliteStore).deleteWorkspace === 'function') {
    (this.store as SqliteStore).deleteWorkspace(id);
  }
}
```
> 注意：`Store` 接口不含 `deleteWorkspace`，为了避免大接口改动可用 `instanceof` 或类型守卫判断。

**验证：** 创建 workspace → 发消息 → 删除 → 检查 SQLite 各表无该 workspace_id 记录。

---

### 4. 任务并发 Run

**文件：** `apps/server/src/routes/tasks.ts:69`
**裁决：** ✅ 成立，但仅覆盖单进程。多进程仍需锁或原子 claim。

**修复（单进程）：**
```typescript
router.post('/:taskId/run', (req: Request, res: Response) => {
  // ...
  if (task.status === 'running') {
    return res.status(409).json({ error: 'Task is already running' });
  }
  // ... 然后设置 status = 'running'
});
```

**多进程补充考量：** 当前项目运行于单 Express 进程，status 检查足够。未来如需多进程扩展，应考虑基于 SQLite/Redis 的分布式锁或原子 CLAIM 机制。

**验证：** `curl -X POST ... & curl -X POST ...` 第二个返回 409。

---

### 5. SSE JSON.parse 无防御

**文件：** `apps/web/src/app/workspace/[id]/page.tsx:162`
**裁决：** ✅ 部分成立。外层 catch 会截住异常，不会白屏，但 reader 泄漏。

**修复：** JSON.parse 加 try-catch 跳过畸形事件，reader 用 finally 确保取消：
```typescript
let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
try {
  reader = response.body.getReader();
  // ... while 循环
  for (const event of parsed.events) {
    let data: StreamEvent & { message?: ...; execution?: ...; error?: string };
    try {
      data = JSON.parse(event.data);
    } catch {
      console.warn('[SSE] parse error, skipping:', event.data.slice(0, 80));
      continue;
    }
    // ... 正常分支
  }
} finally {
  reader?.cancel().catch(() => {});
}
```

**验证：** 中间代理截断 data 行 → 事件被跳过，流继续接收而非断开。

---

### 6. cleanup() 异常覆盖成功结果

**文件：** `packages/agent-core/src/executor.ts:355`
**裁决：** ✅ 成立

**修复：**
```typescript
try {
  await invocation.cleanup();
} catch {
  // 清理失败不应使成功的执行变为失败
}
```
可以抽象为 helper：`function safeCleanup(cleanup: () => Promise<void>): Promise<void>`

**验证：** 手动锁定临时文件后触发 cleanup → CLI 结果报告成功而非异常。

---

## P1 — 尽快修复

### 7. 群聊总结渲染 `"undefined"`

**文件：** `apps/server/src/services/ConversationService.ts:147`
**裁决：** ✅ 成立

**修复：** 失败 agent 通过 `turn.execution.agentId` 获取名称：
```typescript
const workerSummary = turns.slice(1).map(turn =>
  `${turn.responseMessage.senderAgentId ?? turn.execution.agentId}: ${turn.responseMessage.content}`)
```

**验证：** 让某个 worker 执行失败 → 总结显示 agent 名称而非 "undefined"。

---

### 8. 缺少硬超时上限

**文件：** `packages/agent-core/src/executor.ts`
**裁决：** ✅ 成立

**修复：** 新增最大执行时长兜底（与 inactivity 超时共存）：
```typescript
const AGENTOS_MAX_EXECUTION_MS = parseInt(
  process.env.AGENTOS_MAX_EXECUTION_MS ?? '1800000', 10
); // 默认 30 分钟

// 在 Promise 内部
const maxExecTimer = setTimeout(() => {
  if (!settled) {
    stderr += `\n[AgentOS] Max execution time exceeded (${AGENTOS_MAX_EXECUTION_MS}ms)`;
    killChild('max_execution_time');
    settle(null);
  }
}, AGENTOS_MAX_EXECUTION_MS);

const clearExecutionTimers = () => {
  clearTimeout(maxExecTimer);
  if (inactivityTimer) clearInterval(inactivityTimer);
};
```

**验证：** `AGENTOS_MAX_EXECUTION_MS=100` + 1s 命令 → 被超时终结。

---

### 9. PowerShell 临时文件泄漏

**文件：** `packages/agent-core/src/executor.ts:226-242`
**裁决：** ✅ 成立。计划中示例代码没有真正添加 cleanup。

**修复：** 用 try/finally 包裹整个创建+准备工作：
```typescript
invocation = await createCommandInvocation(resolved, cliArgs, prompt);
try {
  if (kimiCodeHome) {
    const sourceKimiHome = process.env.KIMI_CODE_HOME ?? join(homedir(), '.kimi-code');
    await prepareKimiCodeHome(sourceKimiHome, kimiCodeHome);
  }
} catch (err) {
  await invocation.cleanup();
  throw err;
}
```
或者更安全：将 `prepareKimiCodeHome` 提到 `createCommandInvocation` 之前，确保 temp 目录只在准备工作成功后才创建。

**验证：** `prepareKimiCodeHome` 抛出异常 → temp 目录被删除。

---

### 10. Worker 证据检查绕过 Reviewer

**文件：** `apps/server/src/routes/tasks.ts:145`
**裁决：** ✅ 成立，修复方案需调整。不应强制改 `reviewDecision='modify'`，应让 Reviewer 判断。

**修复：** 将证据检查移到 reviewer 之后，证据不足时设 `reviewBlocked=true` 而非直接抛错：
```typescript
await runStage('codex_manager', ...);
await runStage('kimi_worker', ...);

await runStage('opencode_reviewer', ...);
if (signal.aborted) throw new Error('Pipeline cancelled');

// 证据检查放在 reviewer 之后，让 reviewer 先有机会判断
const lastWorkerOutput = task.outputs.find(log => log.stage === 'kimi_worker');
if (lastWorkerOutput && getWorkerEvidenceFailure(lastWorkerOutput)) {
  task.reviewBlocked = true;
  task.reviewDecision = 'modify';
  sendEvent('status', { taskId, status: 'reviewing', reviewDecision: 'modify', reviewBlocked: true });
  // 不抛错，继续到 final review 做最终决定
}

await runStage('codex_final_review', ...);
```

**验证：** Kimi 输出不含证据 → pipeline 不提前终止，reviewer 和 final review 都运行完成。

---

### 11. SIGHUP 退出码

**文件：** `apps/server/src/index.ts:73`
**裁决：** ✅ 成立

**修复：** `process.on('SIGHUP', () => handleSignal('SIGHUP', 129));`

---

## P2 — 排期修复

### 12. Kimi CLI 迁移

**文件：** `apps/server/src/store/SqliteStore.ts:501` + `apps/server/src/store/JsonFileStore.ts`
**裁决：** ✅ 成立，但范围不完整。SQLite 用 INSERT OR IGNORE 不会更新旧配置；流水线使用 workspaces.json，两套来源都要处理。

**修复：**
```typescript
// 迁移函数，处理 workspaces.json 中的旧 Kimi 配置
function migrateLegacyKimiConfig(workspaces: Workspace[]): boolean {
  let changed = false;
  for (const ws of workspaces) {
    for (const agent of ws.agents) {
      if (agent.id === 'kimi' && agent.cliCommand === 'opencode') {
        agent.cliCommand = 'kimi';
        agent.cliArgs = ['-m', 'kimi-code/kimi-for-coding', '-p'];
        changed = true;
      }
    }
  }
  return changed;
}
// 在 WorkspaceManager.list() / get() 或服务器启动时调用一次
```

### 13. 群聊 Worker 并行执行（修复不安全版本）

**文件：** `apps/server/src/services/ConversationService.ts:128`
**裁决：** ✅ 问题成立，简单 `Promise.all` 不安全。一个 worker 失败时其他 worker 继续执行。

**修复：** 使用 `Promise.allSettled` + 统一取消策略：
```typescript
const memberTurns = await Promise.allSettled(
  members.filter(m => !m.isLeader).map(async (member) => {
    const agent = profiles.get(member.agentId);
    if (!agent) throw new Error(`Member ${member.agentId} not found`);
    return this.runAgentTurn({ ... });
  })
);

for (const result of memberTurns) {
  if (result.status === 'fulfilled' && result.value) {
    turns.push(result.value);
  }
  // rejected 的成员在 turns 中被跳过，但不影响其他成员
}
```

### 14. COALESCE 保留不动（补充测试）

**文件：** `apps/server/src/store/SqliteStore.ts:348`
**裁决：** ❌ 暂不成立。当前 `updateExecution` 是部分更新语义，`COALESCE` 正用于避免未提供字段被清空。

**处理：** 保持现状。如有清空 error/startedAt 的需求，先补充失败测试用例，再决定是否加 `clearError` / `resetStartedAt` 等显式清空方法。

### 15. 提取共享 `isCodexCli`

**文件：** `packages/agent-core/src/conversationRunner.ts:109` + `executor.ts:32`
**裁决：** ✅ 成立，质量改进。

**修复：** 提取到 `config.ts` 导出，两边 import。

### 16. Agent 名称映射复用 workspace agent 配置

**文件：** `apps/server/src/routes/tasks.ts:107-113`
**裁决：** ✅ 部分成立。`AGENT_CONFIGS` 是默认名称，不能覆盖用户自定义。应使用 workspace agent 名称，默认配置只作 fallback。

**修复：**
```typescript
// L107-113 改为：全程从 workspace agents 查找，AGENT_CONFIGS 只做最后 fallback
const agentName = workspace.agents.find(a => a.role === STAGE_ROLE_MAP[stage] && a.enabled)?.name
  ?? AGENT_CONFIGS[stage]?.name
  ?? stage;

// L126-131 agentMap 同理
const agentName = workspace.agents.find(a => a.role === STAGE_ROLE_MAP[task.currentAgent] && a.enabled)?.name
  ?? AGENT_CONFIGS[task.currentAgent]?.name
  ?? task.currentAgent;
```
同时移除两份重复字面量。

---

## 修复执行顺序

```
Phase 1 — P0 (6 项)
  ├── 1. 非 Codex CLI 崩溃 → 附带明确的拒绝消息
  ├── 2. 缺少错误中间件 → JSON 错误响应
  ├── 3. Workspace 删除 → 级联清理 SQLite
  ├── 4. 并发 Run → 409 + 补充多进程考量
  ├── 5. SSE JSON.parse → try-catch + finally reader.cancel()
  └── 6. cleanup 异常保护 → try/catch 包裹

Phase 2 — P1 (5 项)
  ├── 7. 群聊 "undefined" → agentId fallback
  ├── 8. 硬超时上限 → maxExecTimer (30min 兜底)
  ├── 9. PowerShell 泄漏 → try/finally 保护
  ├── 10. Worker 检查后移 → 让 Reviewer 决定
  └── 11. SIGHUP → 129

Phase 3 — P2 (5 项)
  ├── 12. Kimi CLI 迁移 → 处理两套存储
  ├── 13. 群聊并行 → Promise.allSettled
  ├── 14. COALESCE → ❌ 保留，补充测试
  ├── 15. isCodexCli 去重
  └── 16. Agent 名称映射 → 优先 workspace agents
```

## 测试验证

```bash
# agent-core 单元 + 集成
pnpm --filter @agentos/agent-core build
pnpm --filter @agentos/agent-core run test

# 服务器端测试（包含 conversation routes）
node --import tsx --test apps/server/src/**/*.test.ts

# 全量构建
pnpm run build
```
