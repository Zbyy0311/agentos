# AgentOS 缺陷修复与偏好系统加固 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复已确认的跨平台 Git 检测、Agent 非活动超时挂死、任务 JSON 丢更新、同步 Git 阻塞和 OpenCode 误回退问题，并以保守的高置信规则加固偏好学习与数据生命周期。

**Architecture:** 保留现有 TypeScript monorepo、Express、SQLite、JSON 兼容存储、SSE 和本地 CLI 架构。修复按独立提交推进：先关闭高风险运行时缺陷，再调整任务持久化写入粒度，最后处理偏好解析、冗余 evidence 清理和纯重构；不引入 Redis、队列、模型 SDK 或跨进程协调服务。

**Tech Stack:** Node.js >= 22.5、TypeScript、Express、`node:sqlite`、Vitest、Node Test Runner、PowerShell、pnpm workspace。

## Global Constraints

- 所有行为修复先写可复现测试，再写最小实现。
- 不改变 SQLite、SSE、Conversation/Run、Artifact 和 Memory 的现有对外 API，除非任务中明确列出接口变更。
- JSON task 并发修复以“单个 AgentOS 服务进程内不丢更新”为验收边界；跨进程并发写同一 `tasks.json` 不在本轮范围内。
- 偏好解析只学习高置信、无歧义的直接表达；遇到否定范围不清、讽刺或互相冲突的表达时返回“不学习”，不得猜测。
- 不对用户直接纠正、重复指令、冲突和返工 evidence 做自动删除；只压缩已经被评分上限覆盖的冗余 `successful_application`。
- `pending` memory candidate 永不自动清理；已审核 candidate 的保留策略单独实施，不与核心修复混在一个提交中。
- 每个任务只提交该任务列出的文件，不顺手格式化或重构相邻代码。

---

## 0. 当前 checkout 核对结论

当前分支：`codex/agentos-current`；核对时 HEAD：`64922a90`。

| 项目 | 当前结论 | 代码证据 | 处理方式 |
|---|---|---|---|
| #1 Git 路径分隔符 | 确认 | `workspaceChanges.ts:21` 拼接 `\\.git` | P0 修复 |
| #2 inactivity timeout 不 settle | 确认 | `executor.ts:548` kill 后无 `settle(null)` | P0 修复 |
| #3 task 丢更新 | 确认且影响默认部署 | `SqliteStore.ts:321-326` 仍委托 `JsonFileStore`；运行器跨 `await` 保存旧数组 | P0 修复 |
| #4 同步 Git 阻塞 | 确认 | `routes/git.ts:13` 使用 `execFileSync`，最长 10 秒 | P1 修复 |
| #5 偏好否定误判 | 确认 | `PreferenceObserver.ts:98-119` 先命中关键词，未处理否定范围 | P1 修复 |
| #6 success cap 无限计分 | 原结论不成立 | `scoreEvidence(selected)` 每次对整组历史重新计算，成功分总贡献最多 3 | 改为数据增长修复 |
| #7 OpenCode 默认 Codex | 确认且有测试固化 | `config.ts:7` 与 `config.test.ts:26-36` 明确把回退当默认行为 | P1 修复 |

核对时已有测试基线：

```powershell
pnpm.cmd --filter @agentos/agent-core exec vitest run src/workspaceChanges.test.ts src/executor.test.ts src/config.test.ts src/runner.test.ts
# 4 files, 50 tests passed

Set-Location apps/server
node --import tsx --test src/services/PreferenceObserver.test.ts src/services/PreferenceProjector.test.ts src/routes/tasks.test.ts src/services/RuntimeArtifactCollector.test.ts
# 17 tests passed
```

## 1. 方案选择与批次

### 可选方案

1. **只修 #1/#2：** 改动最小，但默认部署中的 task 丢更新仍会保留，不建议作为完整交付。
2. **分批手术式修复（采用）：** P0 修 #1/#2/#3，P1 修 #4/#5/#7，P2 做 evidence 生命周期，P3 做无行为变化的重构。每批都能独立回滚和验收。
3. **一次性迁移 task 到 SQLite 并用模型重写偏好识别：** 理论上边界更统一，但同时引入数据迁移、模型延迟和新失败面，不符合本轮最小变更原则。

### 推荐执行顺序

1. **批次 A / P0：** Task 2、3，先关闭跨平台缺失与永久挂起。
2. **批次 B / P0：** Task 4，消除实际默认部署中的 task 丢更新。
3. **批次 C / P1：** Task 5、6，修复服务阻塞与 Reviewer 身份误判。
4. **批次 D / P1-P2：** Task 7、8，修复偏好误学并限制冗余数据增长。
5. **批次 E / P3：** Task 9、10、11，仅做可测量优化和可读性重构。

---

### Task 2: 跨平台 Git workspace 检测

**Files:**

- Modify: `packages/agent-core/src/workspaceChanges.ts:1-23`
- Modify: `packages/agent-core/src/workspaceChanges.test.ts:12-48`

**Interfaces:**

- Consumes: `captureWorkspaceSnapshot(workspaceRoot: string)`
- Produces: 保持 `Promise<WorkspaceStatusSnapshot>` 不变。

- [ ] **Step 1: 固化跨平台失败场景**

保留现有临时 Git 仓库集成测试，并把测试名明确为跨平台契约：

```ts
it('detects changes in a Git workspace using the host platform path rules', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentos-workspace-changes-'));
  try {
    git(root, ['init']);
    writeFileSync(join(root, 'tracked.txt'), 'before', 'utf8');
    git(root, ['add', 'tracked.txt']);
    git(root, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'initial']);
    const snapshot = await captureWorkspaceSnapshot(root);
    expect(snapshot.gitAvailable).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

该测试在 Linux/macOS 上会被旧的 `"${workspaceRoot}\\.git"` 直接判为非 Git 仓库。

- [ ] **Step 2: 运行测试确认平台差异**

```powershell
pnpm.cmd --filter @agentos/agent-core exec vitest run src/workspaceChanges.test.ts
```

预期：Windows 当前可能通过；Linux/macOS 旧实现失败。必须在非 Windows CI 或 WSL 至少执行一次。

- [ ] **Step 3: 使用平台路径 API 做最小修复**

```ts
import { isAbsolute, join, normalize, relative } from 'node:path';

if (!existsSync(join(workspaceRoot, '.git'))) {
  return { gitAvailable: false, entries: new Map() };
}
```

- [ ] **Step 4: 验证**

```powershell
pnpm.cmd --filter @agentos/agent-core exec vitest run src/workspaceChanges.test.ts src/executor.test.ts
```

预期：全部通过；`CLIExecutor` 的 `onFileChanges` 集成测试仍能得到 created/modified 记录。

- [ ] **Step 5: 提交**

```powershell
git add packages/agent-core/src/workspaceChanges.ts packages/agent-core/src/workspaceChanges.test.ts
git commit -m "fix: detect Git workspaces across platforms"
```

### Task 3: inactivity timeout 必须独立完成 Promise

**Files:**

- Modify: `packages/agent-core/src/executor.ts:540-559`
- Modify: `packages/agent-core/src/executor.test.ts:345-355`

**Interfaces:**

- Consumes: `AGENTOS_AGENT_TIMEOUT`、`AGENTOS_MAX_EXECUTION_MS`。
- Produces: `CLIExecutor.execute()` 在 inactivity timer 触发后不依赖 `close` 事件即可结束，并继续抛出包含 inactive 信息的 `CLIError`。

- [ ] **Step 1: 写出“kill 不产生 close”的失败测试**

在 `executor.test.ts` 中临时让 `ChildProcess.prototype.kill()` 返回成功但不终止子进程；子进程 1000ms 后自行退出，测试要求 execute 在 500ms 内结束：

```ts
import { ChildProcess, execFileSync } from 'node:child_process';
import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest';

it('settles inactivity timeout even when kill does not produce close', async () => {
  process.env.AGENTOS_AGENT_TIMEOUT = '50';
  process.env.AGENTOS_MAX_EXECUTION_MS = '5000';
  const kill = vi.spyOn(ChildProcess.prototype, 'kill').mockReturnValue(true);
  const startedAt = Date.now();
  try {
    await expect(CLIExecutor.execute({
      ...okConfig,
      cliArgs: ['-e', 'setTimeout(() => process.exit(0), 1000);'],
    }, 'ignored', ctx('inactive-without-close'))).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(CLIError);
      expect((error as Error).message).toContain('inactive');
      return true;
    });
    expect(Date.now() - startedAt).toBeLessThan(500);
  } finally {
    kill.mockRestore();
  }
});
```

旧实现会等待子进程 1000ms 后的真实 `close`，从而违反 500ms 断言。

- [ ] **Step 2: 运行失败测试**

```powershell
pnpm.cmd --filter @agentos/agent-core exec vitest run src/executor.test.ts -t "settles inactivity timeout"
```

预期：FAIL，耗时断言超过 500ms。

- [ ] **Step 3: 最小实现**

```ts
inactivityTimedOut = true;
stderr += `\n[AgentOS] Agent inactive for ${inactiveForMs}ms (threshold ${inactivityTimeoutMs}ms), killing process.`;
diagLog(`TIMEOUT_TRIGGERED executionId=${executionId} taskId=${taskId} reason=inactivity_timeout inactivityTimeoutMs=${inactivityTimeoutMs} inactiveForMs=${inactiveForMs} lastActivityAt=${new Date(lastActivityAt).toISOString()} childPid=${child.pid}`);
killChild('inactivity_timeout');
settle(null);
```

`settle` 已具备幂等保护，之后迟到的 `close` 不会二次 resolve。

- [ ] **Step 4: 验证四种生命周期**

```powershell
pnpm.cmd --filter @agentos/agent-core exec vitest run src/executor.test.ts
```

验收必须同时覆盖：正常退出、持续输出不超时、inactivity timeout、max execution timeout、AbortSignal 取消。

- [ ] **Step 5: 提交**

```powershell
git add packages/agent-core/src/executor.ts packages/agent-core/src/executor.test.ts
git commit -m "fix: settle executor inactivity timeout"
```

### Task 4: 按单 task 原子写入，避免旧数组覆盖新任务

**Files:**

- Modify: `apps/server/src/store/Store.ts`
- Modify: `apps/server/src/store/JsonFileStore.ts`
- Modify: `apps/server/src/store/SqliteStore.ts:321-327`
- Modify: `apps/server/src/routes/tasks.ts:50-230`
- Create: `apps/server/src/store/JsonFileStore.test.ts`
- Modify: `apps/server/src/store/SqliteStore.test.ts`
- Modify: `apps/server/src/taskRecovery.test.ts`

**Interfaces:**

- Consumes: 现有 `loadTasks`、`saveTasks`。
- Produces: `saveTask(workspaceId: string, task: TaskItem): void`。
- `saveTasks` 仅保留给启动恢复等已停机/单写者批处理；在线 route 不再调用它。

- [ ] **Step 1: 写出旧快照覆盖新 task 的失败测试**

```ts
function makeTask(id: string): TaskItem {
  return {
    id,
    workspaceId: 'workspace-a',
    title: id,
    status: 'pending',
    currentAgent: null,
    outputs: [],
    reviewDecision: 'unknown',
    reviewBlocked: false,
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
  };
}

test('saveTask preserves tasks added after an older snapshot was loaded', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentos-json-store-'));
  try {
    const store = new JsonFileStore(root);
    const first = makeTask('task-a');
    store.saveTasks('workspace-a', [first]);
    const stale = store.loadTasks('workspace-a');

    store.saveTask('workspace-a', makeTask('task-b'));
    stale[0].status = 'running';
    store.saveTask('workspace-a', stale[0]);

    assert.deepEqual(
      store.loadTasks('workspace-a').map(task => `${task.id}:${task.status}`).sort(),
      ['task-a:running', 'task-b:pending'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 增加 Store 接口与 JSON 单项写入**

```ts
// Store.ts
saveTask(workspaceId: string, task: TaskItem): void;

// JsonFileStore.ts
saveTask(workspaceId: string, task: TaskItem): void {
  const tasks = this.loadTasks(workspaceId);
  const index = tasks.findIndex(current => current.id === task.id);
  if (index >= 0) tasks[index] = structuredClone(task);
  else tasks.push(structuredClone(task));
  this.writeJsonAtomically(this.tasksFile(workspaceId), { tasks });
}
```

此同步方法在单个 Node.js 进程中把“读取最新列表、替换一个 task、原子 rename”放在同一个不可交错调用内。

- [ ] **Step 3: 让 SqliteStore 明确代理单项写入**

```ts
saveTask(workspaceId: string, task: TaskItem): void {
  this.legacy.saveTask(workspaceId, task);
}
```

同时增加 `SqliteStore.test.ts` 用例，证明默认 `SqliteStore` 路径也保留后加入的 task。

`taskRecovery.test.ts` 的 `MemoryStore` 需要实现相同的单项契约，避免测试 fake 与生产接口漂移：

```ts
saveTask(workspaceId: string, task: TaskItem): void {
  const tasks = this.loadTasks(workspaceId);
  const index = tasks.findIndex(current => current.id === task.id);
  if (index >= 0) tasks[index] = structuredClone(task);
  else tasks.push(structuredClone(task));
  this.tasks.set(workspaceId, tasks);
}
```

- [ ] **Step 4: 在线 task route 只保存当前 task**

把 `apps/server/src/routes/tasks.ts` 中所有在线 `store.saveTasks(workspaceId, tasks)` 替换为：

```ts
store.saveTask(workspaceId, task);
```

创建 task、claim、stage 开始/结束、activity、review、completed、failed、cancelled 都必须使用单项写入。`taskRecovery.ts` 在服务接收请求前运行，可继续使用批量 `saveTasks`。

- [ ] **Step 5: 运行存储和路由测试**

```powershell
Set-Location apps/server
node --import tsx --test src/store/JsonFileStore.test.ts src/store/SqliteStore.test.ts src/routes/tasks.test.ts src/taskRecovery.test.ts
```

预期：并发回归用例通过；既有 task recovery 和 stage failure 行为不变。

- [ ] **Step 6: 静态验收在线写入面**

```powershell
rg -n "saveTasks\(" apps/server/src
```

预期：生产代码中仅剩 `taskRecovery.ts`、Store 实现和接口；`routes/tasks.ts` 不再出现 `saveTasks`。

- [ ] **Step 7: 提交**

```powershell
git add apps/server/src/store/Store.ts apps/server/src/store/JsonFileStore.ts apps/server/src/store/JsonFileStore.test.ts apps/server/src/store/SqliteStore.ts apps/server/src/store/SqliteStore.test.ts apps/server/src/routes/tasks.ts apps/server/src/taskRecovery.test.ts
git commit -m "fix: persist task updates without replacing peers"
```

### Task 5: Git API 改为异步执行

**Files:**

- Modify: `apps/server/src/routes/git.ts`
- Create: `apps/server/src/routes/git.test.ts`

**Interfaces:**

- Consumes: `GET /api/workspaces/:workspaceId/git/{diff,status,log}`。
- Produces: JSON 结构和失败文案不变；route handler 改为 async。

- [ ] **Step 1: 写 route 回归测试**

启动端口 0 的 Express 测试服务，注入一个延迟 50ms 的异步 Git 执行器；在请求未完成时验证事件循环中的 0ms timer 已执行，再验证 `/status` 返回原有 JSON：

```ts
import express from 'express';
import type { AddressInfo } from 'node:net';

test('git status awaits an asynchronous command without blocking timers', async () => {
  let timerRan = false;
  const executeGit = async (_cwd: string, _args: string[]) => {
    await new Promise(resolve => setTimeout(resolve, 50));
    return ' M changed.ts\n';
  };
  const manager = {
    get: (workspaceId: string) => workspaceId === 'workspace-a'
      ? { id: workspaceId, rootPath: process.cwd() }
      : undefined,
  } as WorkspaceManager;
  const app = express();
  app.use('/git', createGitRoutes(manager, executeGit));
  const server = app.listen(0);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const request = fetch(`http://127.0.0.1:${port}/git/status`);
    setTimeout(() => { timerRan = true; }, 0);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(timerRan, true);
    assert.deepEqual(await (await request).json(), { status: ' M changed.ts\n' });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
```

- [ ] **Step 2: 用 promisified execFile 替换同步调用**

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type GitCommandExecutor = (cwd: string, args: string[]) => Promise<string>;

const executeGitFile: GitCommandExecutor = async (cwd, args) => {
  const result = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  return result.stdout;
};

export function createGitRoutes(
  workspaceManager: WorkspaceManager,
  executeGit: GitCommandExecutor = executeGitFile,
): Router {
  const router = Router({ mergeParams: true });

  async function runGit(workspaceId: string, args: string[]): Promise<string> {
  const workspace = workspaceManager.get(workspaceId);
  if (!workspace) throw new Error('Workspace not found');
  if (!existsSync(workspace.rootPath)) throw new Error('Workspace path does not exist');
    return executeGit(workspace.rootPath, args);
  }

  // 原有三个 route 保持返回结构，只改为 async/await。
  return router;
}
```

三个 route handler 改为 `async` 并 `await runGit(...)`，原 catch/JSON 保持不变。

- [ ] **Step 3: 验证**

```powershell
Set-Location apps/server
node --import tsx --test src/routes/git.test.ts src/routes/sse.test.ts
```

预期：Git 返回兼容；异步等待期间 timer/SSE 测试不受阻塞。

- [ ] **Step 4: 记录同类残留但不混改**

`apps/server/src/services/RuntimeArtifactCollector.ts:205-210` 仍有 `execFileSync('git')`。该调用发生在 artifact baseline/finalize 链路，需在独立提交中把 `start()` 改为 async 后处理；本任务只修报告指向的 Git HTTP route，避免扩大调用链改动。

- [ ] **Step 5: 提交**

```powershell
git add apps/server/src/routes/git.ts apps/server/src/routes/git.test.ts
git commit -m "fix: run Git routes asynchronously"
```

### Task 6: OpenCode 默认使用真实 OpenCode 命令

**Files:**

- Modify: `packages/agent-core/src/config.ts:4-12`
- Modify: `packages/agent-core/src/config.test.ts:26-36,82-90`
- Modify: `README.md:110-119`

**Interfaces:**

- 默认：`AGENTOS_OPENCODE_CLI` 未配置时使用 `opencode`。
- 显式兼容：用户把 `AGENTOS_OPENCODE_CLI=codex` 时仍按 Codex capability、参数和模型处理。

- [ ] **Step 1: 把现有默认回退测试改成失败测试**

```ts
it('uses OpenCode for the reviewer by default', async () => {
  const { AGENT_CONFIGS } = await import('./config.js');
  expect(AGENT_CONFIGS.opencode_reviewer.cliCommand).toBe('opencode');
  expect(AGENT_CONFIGS.opencode_reviewer.cliArgs).toEqual([
    '--pure', 'run', '--model', 'deepseek/deepseek-v4-flash',
  ]);
});

it('allows an explicit Codex reviewer override', async () => {
  process.env.AGENTOS_OPENCODE_CLI = 'codex';
  const { AGENT_CONFIGS } = await import('./config.js');
  expect(AGENT_CONFIGS.opencode_reviewer.cliCommand).toBe('codex');
  expect(AGENT_CONFIGS.opencode_reviewer.cliArgs[0]).toBe('exec');
});
```

- [ ] **Step 2: 修改默认命令**

```ts
const OPENCODE_CLI = process.env.AGENTOS_OPENCODE_CLI ?? 'opencode';
```

保留“显式配置为 Codex 时使用 Codex 参数”的现有分支，不删除兼容能力。

- [ ] **Step 3: 更新 README**

环境变量表改为：

```md
| `AGENTOS_OPENCODE_CLI` | `opencode` | OpenCode Reviewer 命令路径或名称；如需使用 Codex 代替 Reviewer，必须显式设置为 `codex`。 |
```

同时说明真实模式找不到 `opencode` 时 Reviewer stage 明确失败，不静默换成 Codex。

- [ ] **Step 4: 验证**

```powershell
pnpm.cmd --filter @agentos/agent-core exec vitest run src/config.test.ts src/conversationRunner.test.ts src/executor.test.ts
```

- [ ] **Step 5: 提交**

```powershell
git add packages/agent-core/src/config.ts packages/agent-core/src/config.test.ts README.md
git commit -m "fix: use OpenCode as the default reviewer CLI"
```

### Task 7: 偏好指令改为高置信、否定感知解析

**Files:**

- Create: `apps/server/src/services/PreferenceDirectiveParser.ts`
- Create: `apps/server/src/services/PreferenceDirectiveParser.test.ts`
- Modify: `apps/server/src/services/PreferenceObserver.ts:31-68,92-119`
- Modify: `apps/server/src/services/PreferenceObserver.test.ts`

**Interfaces:**

```ts
export interface ParsedPreferenceDirective {
  dimension: PreferenceDimension;
  contextKind: PreferenceContextKind;
  candidateValue: string;
}

export function parsePreferenceDirective(
  text: string,
  contextKind: PreferenceContextKind,
): ParsedPreferenceDirective | undefined;
```

- [ ] **Step 1: 先写否定、组合和歧义测试矩阵**

```ts
const cases = [
  ['回答简洁一点', 'concise'],
  ['不要太简洁', 'balanced'],
  ['请详细展开', 'detailed'],
  ['不要详细展开', 'concise'],
  ['先别直接执行，先给计划', 'plan_first'],
  ['不要先问我，直接执行', 'direct_execution'],
  ['既要简洁又要详细', undefined],
] as const;

for (const [text, expected] of cases) {
  test(`parses ${text}`, () => {
    assert.equal(parsePreferenceDirective(text, 'coding')?.candidateValue, expected);
  });
}
```

旧实现至少会把“不要太简洁”学成 `concise`，把“先别直接执行，先给计划”因首个正向关键词学成 `direct_execution`。

- [ ] **Step 2: 实现保守的按维度解析器**

实现顺序必须是：显式否定短语 → 明确正向短语 → 同维度冲突检测。`response_detail` 使用已有 `balanced` 值承接“不要太简洁”；一个维度同时出现两个互斥目标时返回 `undefined`。

```ts
const DETAIL_RULES = [
  { value: 'balanced', phrases: ['不要太简洁', '别太简短'] },
  { value: 'concise', phrases: ['简洁一点', '简短回答', '不要太长', '不要详细展开'] },
  { value: 'detailed', phrases: ['详细展开', '多解释', '给更多细节'] },
] as const;
```

执行风格同样把“先别直接执行”“不要直接执行”放到 `plan_first` 的高优先级短语中。未覆盖的讽刺、反问和含糊表达不生成 evidence。

- [ ] **Step 3: 统一 correction 判断**

`PreferenceObserver` 对 follow-up 先调用新解析器；当解析结果与已应用 projection 维度相同且值不同时生成 conflict。仅保留无法由目标值表达的少量明确 correction 规则，禁止再维护两套相互漂移的大正则。

- [ ] **Step 4: 验证不会污染持久化**

在 `PreferenceObserver.test.ts` 增加：

```ts
test('does not learn concise from a negated concise instruction', () => {
  const evidence = new PreferenceObserver().observeRun(input({
    objective: '不要太简洁，保持信息完整',
    appliedProjections: [],
  }));
  assert.equal(evidence.some(item => item.candidateValue === 'concise'), false);
  assert.equal(evidence[0]?.candidateValue, 'balanced');
});
```

- [ ] **Step 5: 运行测试**

```powershell
Set-Location apps/server
node --import tsx --test src/services/PreferenceDirectiveParser.test.ts src/services/PreferenceObserver.test.ts src/services/PreferenceAcceptance.test.ts
```

- [ ] **Step 6: 提交**

```powershell
git add apps/server/src/services/PreferenceDirectiveParser.ts apps/server/src/services/PreferenceDirectiveParser.test.ts apps/server/src/services/PreferenceObserver.ts apps/server/src/services/PreferenceObserver.test.ts
git commit -m "fix: make preference directives negation aware"
```

### Task 8: 限制冗余 successful_application evidence 增长

**Files:**

- Modify: `apps/server/src/services/PreferenceRules.ts`
- Modify: `apps/server/src/services/PreferenceProjector.test.ts`
- Modify: `apps/server/src/store/SqliteStore.ts`
- Modify: `apps/server/src/store/SqliteStore.test.ts`
- Modify: `apps/server/src/services/PreferenceService.ts:21-61`
- Modify: `apps/server/src/services/PreferenceObserver.test.ts`

**Interfaces:**

```ts
export const MAX_SUCCESS_EVIDENCE_PER_KEY = 4;

pruneSuccessfulPreferenceEvidence(
  profileId: string,
  workspaceId: string,
): number;
```

- [ ] **Step 1: 先增加评分上限的刻画测试**

此测试应在修改前就通过，用来防止误修 #6：

```ts
test('caps all historical successful applications at three score points', () => {
  const projection = calculatePreferenceProjection(
    Array.from({ length: 100 }, (_, index) => evidence(1, `run-${index + 1}`, {
      signalType: 'successful_application',
    })),
    'workspace',
    'workspace-a',
  );
  assert.equal(projection?.score, 3);
  assert.equal(projection?.status, 'observed');
});
```

- [ ] **Step 2: 写冗余清理失败测试**

插入 20 条同一 profile/workspace/dimension/context/value 的正向 success evidence，再插入 direct correction 和 conflict。调用清理后断言：

```ts
function projectionSemantics(projection: PreferenceProjection | undefined) {
  return projection && {
    preferredValue: projection.preferredValue,
    score: projection.score,
    confidence: projection.confidence,
    status: projection.status,
  };
}

assert.equal(remainingSuccess.length, MAX_SUCCESS_EVIDENCE_PER_KEY);
assert.equal(remainingStrongEvidence.length, 2);
assert.deepEqual(
  projectionSemantics(after),
  projectionSemantics(before),
);
```

不比较预期会减少的 `evidenceCount` 和 `independentRunCount`。

- [ ] **Step 3: 实现定向 SQL 清理**

使用 SQLite window function，只删除每个 key 中排名第 5 及之后的正向 `successful_application`：

```sql
DELETE FROM preference_evidence
WHERE id IN (
  SELECT id FROM (
    SELECT id,
      ROW_NUMBER() OVER (
        PARTITION BY profile_id, workspace_id, dimension, context_kind, candidate_value
        ORDER BY observed_at DESC, id DESC
      ) AS row_number
    FROM preference_evidence
    WHERE profile_id = ?
      AND workspace_id = ?
      AND signal_type = 'successful_application'
      AND polarity = 'positive'
  )
  WHERE row_number > ?
);
```

保留 4 条是因为稳定晋升同时要求 4 个独立 run；分数贡献仍由 `successScoreCap=3` 控制。

- [ ] **Step 4: 在投影前清理并重建 links**

`PreferenceService.recordRunEvidence()` 插入本次 observed evidence 后、读取 workspace/global evidence 前调用清理。随后按现有流程重新计算 projection 和 `preference_projection_evidence` links，避免 links 指向已删除行。

- [ ] **Step 5: 验证**

```powershell
Set-Location apps/server
node --import tsx --test src/services/PreferenceProjector.test.ts src/services/PreferenceObserver.test.ts src/services/PreferenceAcceptance.test.ts src/store/SqliteStore.test.ts
```

- [ ] **Step 6: 提交**

```powershell
git add apps/server/src/services/PreferenceRules.ts apps/server/src/services/PreferenceProjector.test.ts apps/server/src/store/SqliteStore.ts apps/server/src/store/SqliteStore.test.ts apps/server/src/services/PreferenceService.ts apps/server/src/services/PreferenceObserver.test.ts
git commit -m "fix: compact redundant preference success evidence"
```

### Task 9: memory candidate 已审核记录保留策略

**Files:**

- Modify: `apps/server/src/store/SqliteStore.ts`
- Modify: `apps/server/src/store/SqliteStore.test.ts`
- Create: `apps/server/src/services/RetentionService.ts`
- Create: `apps/server/src/services/RetentionService.test.ts`
- Modify: `apps/server/src/index.ts`

**Interfaces:**

```ts
export interface RetentionPolicy {
  reviewedMemoryCandidateDays: 90;
  reviewedMemoryCandidateMinimum: 200;
}
```

- [ ] **Step 1: 写保留边界测试**

测试必须证明：`pending` 永不删除；90 天内 accepted/rejected 保留；每 workspace 最新 200 条已审核记录保留；超过 90 天且超出 200 条的 reviewed candidate 才删除。

- [ ] **Step 2: 实现显式维护服务**

`RetentionService.run(now)` 调用 store 的定向删除方法并返回删除计数。服务启动时执行一次，之后用 24 小时 timer 执行；timer 必须调用 `unref()`，失败只记录诊断日志，不阻止 server 启动。

- [ ] **Step 3: 验证**

```powershell
Set-Location apps/server
node --import tsx --test src/services/RetentionService.test.ts src/routes/memoryCandidates.test.ts src/store/SqliteStore.test.ts
```

- [ ] **Step 4: 提交**

```powershell
git add apps/server/src/store/SqliteStore.ts apps/server/src/store/SqliteStore.test.ts apps/server/src/services/RetentionService.ts apps/server/src/services/RetentionService.test.ts apps/server/src/index.ts
git commit -m "feat: retain bounded reviewed memory candidates"
```

### Task 10: 并行读取 runner memory 文件且保持顺序

**Files:**

- Modify: `packages/agent-core/src/runner.ts:88-100`
- Modify: `packages/agent-core/src/runner.test.ts`

**Interfaces:**

- `readMemory(stage)` 返回内容格式和文件顺序不变。

- [ ] **Step 1: 写并发和顺序测试**

mock `readFile` 为不同延迟，记录同时进行的读取数；断言 `maxInFlight > 1`，同时结果仍按 `memoryFilesForStage()` 顺序排列。

- [ ] **Step 2: 使用 Promise.all**

```ts
const parts = await Promise.all(memoryFiles.map(async file => {
  try {
    const content = await readFile(join(this.workspaceRoot, 'agent-memory', file), 'utf8');
    const maxChars = file === 'TASKS.md' ? 3000 : 2000;
    return `--- ${file} ---\n${this.trimSection(content, maxChars)}`;
  } catch {
    return `--- ${file} ---\n(file not found)`;
  }
}));
return parts.join('\n\n');
```

- [ ] **Step 3: 验证与提交**

```powershell
pnpm.cmd --filter @agentos/agent-core exec vitest run src/runner.test.ts
git add packages/agent-core/src/runner.ts packages/agent-core/src/runner.test.ts
git commit -m "perf: read Agent memory files concurrently"
```

### Task 11: 拆分 executor 参数改写与偏好状态判定

**Files:**

- Create: `packages/agent-core/src/runtimeArgs.ts`
- Create: `packages/agent-core/src/runtimeArgs.test.ts`
- Modify: `packages/agent-core/src/executor.ts:90-150`
- Modify: `packages/agent-core/src/executor.test.ts`
- Modify: `apps/server/src/services/PreferenceRules.ts:31-39,92-98`
- Modify: `apps/server/src/services/PreferenceProjector.test.ts`

**Interfaces:**

```ts
export function replaceOrAppendArg(args: string[], flag: string, value: string): string[];
export function removeArgPair(args: string[], flag: string): string[];
export function replaceConfigArg(args: string[], key: string, value: string): string[];

export function determineProjectionStatus(input: {
  score: number;
  runCount: number;
  negativeRecent: number;
  hasRecentStrongConflict: boolean;
}): PreferenceProjectionStatus;
```

- [ ] **Step 1: 先迁移纯函数测试，不改行为**

覆盖：参数存在时替换、不存在时追加、源数组不变、孤立 flag 删除、其他 config key 保留；偏好状态覆盖 dormant/stable/provisional/observed 四条分支和阈值边界。

- [ ] **Step 2: 移动参数函数并替换嵌套三元表达式**

`executor.ts` 只 import 三个纯函数；`PreferenceRules.ts` 调用 `determineProjectionStatus`。阈值常量保留集中定义，不在调用处重复数字。

- [ ] **Step 3: 验证**

```powershell
pnpm.cmd --filter @agentos/agent-core exec vitest run src/runtimeArgs.test.ts src/executor.test.ts
Set-Location apps/server
node --import tsx --test src/services/PreferenceProjector.test.ts src/services/PreferenceAcceptance.test.ts
```

- [ ] **Step 4: 提交**

```powershell
git add packages/agent-core/src/runtimeArgs.ts packages/agent-core/src/runtimeArgs.test.ts packages/agent-core/src/executor.ts packages/agent-core/src/executor.test.ts apps/server/src/services/PreferenceRules.ts apps/server/src/services/PreferenceProjector.test.ts
git commit -m "refactor: isolate runtime args and preference status rules"
```

---

## 最终回归与验收

- [ ] **Step 1: 全量自动化测试**

```powershell
pnpm.cmd --filter @agentos/agent-core test
pnpm.cmd --filter @agentos/server test
pnpm.cmd --filter @agentos/web build
pnpm.cmd -r run build
```

预期：四条命令退出码均为 0。

- [ ] **Step 2: 跨平台和挂死专项验收**

- 在 Windows 执行 inactivity no-close 回归测试，确认小于 500ms 返回。
- 在 Linux/macOS 或 WSL 执行 `workspaceChanges.test.ts`，确认 Git snapshot 可用。
- 运行一个持续输出超过 inactivity 阈值的 fake CLI，确认不会误杀。

- [ ] **Step 3: task 并发真实流验收**

启动服务后运行一个会持续至少 3 秒的 task；运行期间创建第二个 task；第一个 task stage 更新和结束后，GET task 列表仍同时包含两条，状态分别正确。

- [ ] **Step 4: Git/SSE 真实流验收**

在大仓库请求 `/git/diff` 的同时保持一个 SSE 连接；确认 SSE heartbeat 不因 Git route 同步阻塞而出现 10 秒空窗。

- [ ] **Step 5: 偏好真实流验收**

依次提交“回答简洁一点”“不要太简洁”“先别直接执行，先给计划”；检查偏好 evidence 分别为 `concise`、`balanced`、`plan_first`，且没有错误的 `direct_execution`。重复成功应用 20 次后，同一 key 的 success evidence 不超过 4，projection 的 score/status 与清理前一致。

## 完成标准

- #1、#2、#3 的回归测试可在修复前明确失败、修复后通过。
- 默认 Reviewer 的真实命令为 `opencode`；只有显式配置时才使用 Codex。
- 生产代码中的 Git HTTP route 不再使用 `execFileSync`。
- 在线 task route 不再以旧数组整体覆盖 `tasks.json`。
- “不要太简洁”不会生成 `concise` 正向 evidence；歧义指令不学习。
- 成功应用的分数总贡献保持 3 分上限，同时冗余成功 evidence 有界。
- 全量测试、web build、monorepo build 和四项真实流验收全部通过。
