# AgentOS CI Production + Test Determinism Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close PR #42 failures R31, R32, R33, ConversationService 489, and ConversationService 497 without changing the frozen CI/toolchain surface.

**Architecture:** Apply the Node warning flag at every sanctioned server entry while preserving tsx watch semantics, replace the R33 live-server fixture with direct ownership, and make critical event work a fully drained observable ledger. Replace the group concurrency wall-clock assertion with a two-process marker barrier and causal event-order assertion.

**Tech Stack:** Node.js 22, TypeScript ESM, node:test, tsx 4.23.11, pnpm 9, SQLite, Windows GitHub Actions.

## Global Constraints

- Before production edits, record the clean docs-only plan commit as `IMPLEMENTATION_BASE`; its parent must be `600bed8a3059e0c94d127e65c496be3cfdeed2e5`.
- Frozen remote refs: `origin/main=77add6a0dc1a860d9d054b0bc146b231c9cccb88` and `origin/infra/github-actions-ci=56829742c6ec29a4a56e957deb530e34daa9b762`.
- PR #42 remains OPEN/DRAFT with remote head `56829742c6ec29a4a56e957deb530e34daa9b762` until the one authorized fast-forward push.
- Implementation files are limited to `apps/server/package.json`, `apps/server/src/serverStartup.test.ts`, `apps/server/src/services/ConversationService.ts`, and `apps/server/src/services/ConversationService.test.ts`.
- Do not create a launcher. The public `tsx/cli` export already provides a launcher-free watch path; if that path stops working, report `SCOPE EXPANSION REQUIRED` and stop.
- Do not modify `.github/workflows/ci.yml`, `pnpm-lock.yaml`, root `package.json`, `SqliteStore.ts`, migrations, PR body, or real `.agentos/agentos.sqlite`.
- Keep Node CI at 22, `tsx` declared at `^4.23.1`, resolved at `4.23.11`, and the server `test` script unchanged.
- Never add `NODE_OPTIONS`, `--no-warnings`, stderr filtering, warning listeners, SQLite journal exclusions, or Node-version test bypasses.
- Use ordinary forward commits only: no amend, rebase, squash, reset, or force push.
- Ready, Merge, and M4 remain unauthorized.

---

### Task 1: Freeze the implementation base and capture negative controls

**Files:**
- Read: `docs/superpowers/specs/2026-08-11-agentos-ci-production-determinism-remediation-design.md`
- Read: `apps/server/src/serverStartup.test.ts`
- Read: `apps/server/src/services/ConversationService.test.ts`

**Interfaces:**
- Consumes: approved docs-only commit chain ending at this plan commit.
- Produces: the exact `IMPLEMENTATION_BASE` SHA and pre-change failure evidence used by every later diff gate.

- [ ] **Step 1: Verify the clean implementation base**

Run from `E:\workspace\Multi-Agent`:

```powershell
git fetch origin
git status --short --untracked-files=all
git diff --check
git rev-parse HEAD
git rev-parse HEAD^
git rev-parse origin/main
git rev-parse origin/infra/github-actions-ci
git diff --name-status 56829742c6ec29a4a56e957deb530e34daa9b762..HEAD
gh pr view 42 --json state,isDraft,mergedAt,headRefOid
```

Expected: clean status; `HEAD^=600bed8a3059e0c94d127e65c496be3cfdeed2e5`; frozen refs unchanged; cumulative diff contains only the design spec and this plan; PR is OPEN/DRAFT and unmerged.

- [ ] **Step 2: Build workspace dependencies once**

Run from `agentos/`:

```powershell
pnpm --filter @agentos/server run build:workspace-deps
```

Expected: PASS without tracked-file changes.

- [ ] **Step 3: Capture the startup failure negative control**

```powershell
pnpm --filter @agentos/server exec node --import tsx --test --test-concurrency=1 --test-name-pattern="R31|R32" src/serverStartup.test.ts
```

Expected before Task 2: R31/R32 fail because captured child stderr includes the Node 22 SQLite `ExperimentalWarning` and therefore the forbidden `SQLITE` fragment.

- [ ] **Step 4: Capture the strict-rejection negative control**

```powershell
pnpm --filter @agentos/server exec node --unhandled-rejections=strict --import tsx --test --test-concurrency=1 --test-name-pattern="critical group-run event persistence fails" src/services/ConversationService.test.ts
```

Expected before Task 3: FAIL with `event persistence unavailable` escaping through detached `flushRuntimeBuffer()` work, or equivalent strict unhandled-rejection evidence.

---

### Task 2: Normalize the real server warning policy and replace the R33 fixture

**Files:**
- Modify: `apps/server/package.json`
- Modify: `apps/server/src/serverStartup.test.ts`
- Test: `apps/server/src/serverStartup.test.ts`

**Interfaces:**
- Consumes: public `tsx/cli` export from the frozen tsx 4.23.11 package and `acquireServerOwnership(projectRoot): Promise<ServerOwnership>`.
- Produces: a shared real-startup policy using only `--disable-warning=ExperimentalWarning`, plus an R33 ownership holder with `release(): Promise<void>`.

- [ ] **Step 1: Add policy and R33 regression assertions before changing the startup commands**

In `serverStartup.test.ts`, extend the child-process import and ownership imports:

```ts
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { acquireServerOwnership, type ServerOwnership } from './serverOwnership.js';
```

Add a helper used inside the existing R31 test, not a new top-level test, so the full-suite total remains 1704:

```ts
function assertSelectiveWarningPolicy(): void {
  const packageJson = JSON.parse(readFileSync(join(SERVER_CWD, 'package.json'), 'utf-8')) as {
    scripts: Record<string, string>;
  };
  for (const name of ['dev', 'dev:stable', 'start']) {
    assert.match(packageJson.scripts[name] ?? '', /--disable-warning=ExperimentalWarning/);
  }
  const scripts = Object.values(packageJson.scripts).join('\n');
  assert.doesNotMatch(scripts, /NODE_OPTIONS|--no-warnings/);

  const probe = spawnSync(process.execPath, [
    '--disable-warning=ExperimentalWarning',
    '-e',
    "process.stderr.write('ordinary-stderr-visible\\n'); process.emitWarning('deprecated-visible', 'DeprecationWarning'); process.emitWarning('experimental-hidden', 'ExperimentalWarning');",
  ], { encoding: 'utf-8' });
  assert.equal(probe.status, 0);
  assert.match(probe.stderr, /ordinary-stderr-visible/);
  assert.match(probe.stderr, /deprecated-visible/);
  assert.doesNotMatch(probe.stderr, /experimental-hidden/);
}
```

Call `assertSelectiveWarningPolicy()` at the beginning of R31. Rewrite the existing R33 body so it seeds and closes the store first, acquires ownership directly, snapshots, and starts only serverB:

```ts
const seeded = seedQueuedLegacyRun(root, 'ws-r33');
let ownership: ServerOwnership | undefined;
let serverB: SpawnedServer | undefined;
try {
  ownership = await acquireServerOwnership(root);
  const before = snapshotProjectTree(root);
  assert.equal(Object.keys(before).some(path => path.endsWith('.sqlite-journal')), false);
  const portB = await freePort();
  serverB = spawnServer(root, portB);
  const exitB = await waitForExit(serverB.child);
  assert.notEqual(exitB.code, 0);
  assert.match(serverB.output(), /SERVER_ALREADY_RUNNING/);
  await assert.rejects(() => fetch(`http://127.0.0.1:${portB}/api/health`, {
    signal: AbortSignal.timeout(2_000),
  }));
  assert.deepEqual(snapshotProjectTree(root), before);
  assert.deepEqual(readRunState(root, seeded.workspaceId, seeded.runId, seeded.taskId), seeded.initial);
} finally {
  killServer(serverB);
  await ownership?.release();
  rmSync(root, { recursive: true, force: true });
}
```

- [ ] **Step 2: Run the new assertions to prove they fail against old policy**

```powershell
pnpm --filter @agentos/server exec node --import tsx --test --test-concurrency=1 --test-name-pattern="R31|R33" src/serverStartup.test.ts
```

Expected: R31 fails because the package scripts do not yet contain the exact flag; R33 passes or exposes only fixture implementation mistakes, never a weakened snapshot assertion.

- [ ] **Step 3: Apply the production startup policy**

In `apps/server/package.json`, keep all dependencies and the `test` command byte-for-byte unchanged and set:

```json
"dev": "pnpm run build:workspace-deps && node --disable-warning=ExperimentalWarning -e \"process.argv.splice(1, 0, 'tsx'); import('tsx/cli')\" -- watch --exclude \"../../workspace/**\" --exclude \"../../.agentos/**\" --exclude \"../../agent-memory/**\" src/index.ts",
"dev:stable": "pnpm run build:workspace-deps && node --disable-warning=ExperimentalWarning --import tsx src/index.ts",
"start": "node --disable-warning=ExperimentalWarning dist/index.js"
```

In `spawnServer()`, use the same Node policy before the existing tsx import:

```ts
const child = spawn(process.execPath, [
  '--disable-warning=ExperimentalWarning',
  '--import',
  'tsx',
  SERVER_ENTRY,
], {
  cwd: SERVER_CWD,
  env: {
    ...process.env,
    AGENTOS_PROJECT_ROOT: root,
    PORT: String(port),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
```

- [ ] **Step 4: Prove watch remains the public tsx watch command**

```powershell
pnpm --filter @agentos/server exec node --disable-warning=ExperimentalWarning -e "process.argv.splice(1, 0, 'tsx'); import('tsx/cli')" -- watch --help
```

Expected: output begins with `tsx watch` and lists `--exclude`; no private `dist/cli.mjs` path and no launcher are used.

- [ ] **Step 5: Run the three startup findings**

```powershell
pnpm --filter @agentos/server exec node --import tsx --test --test-concurrency=1 --test-name-pattern="R31|R32|R33" src/serverStartup.test.ts
```

Expected: R31, R32, and R33 PASS; all existing `SQLITE`, `SQL`, trigger, address, database path, and project path assertions remain intact.

- [ ] **Step 6: Commit the startup deliverable**

Run from `E:\workspace\Multi-Agent`:

```powershell
git add agentos/apps/server/package.json agentos/apps/server/src/serverStartup.test.ts
git diff --cached --check
git commit -m "fix: normalize server experimental warning policy"
```

---

### Task 3: Track and fully drain critical runtime flush promises

**Files:**
- Modify: `apps/server/src/services/ConversationService.ts`
- Modify: `apps/server/src/services/ConversationService.test.ts`
- Test: `apps/server/src/services/ConversationService.test.ts`

**Interfaces:**
- Consumes: `EventBus.publish(event): Promise<AgentEvent>` and `flushRuntimeBuffer(runId): Promise<void>`.
- Produces: `trackCriticalEventWork<T>(pending: Promise<T>): Promise<T>` and a draining `flushEvents(): Promise<void>` that removes promises added while earlier tracked work is settling.

- [ ] **Step 1: Extend the existing group persistence test with the cross-run regression**

Keep the same top-level test count. Replace the always-failing bus in `does not return success when critical group-run event persistence fails` with a mutable persistence seam and use one service for two group conversations:

```ts
for (const conversationId of ['event-failure-group', 'event-recovery-group']) {
  store.createGroupConversation({
    id: conversationId,
    workspaceId: 'workspace-a',
    type: 'group',
    title: conversationId,
    createdAt: '2026-07-12T01:00:00.000Z',
    updatedAt: '2026-07-12T01:00:00.000Z',
  }, [
    { conversationId, agentId: 'codex', roleTitle: 'leader', isLeader: true, createdAt: '2026-07-12T01:00:00.000Z' },
    { conversationId, agentId: 'kimi', roleTitle: 'worker', isLeader: false, createdAt: '2026-07-12T01:00:00.000Z' },
  ]);
}

let failPersistence = true;
const bus = new EventBus(draft => {
  if (failPersistence) throw new Error('event persistence unavailable');
  return { event: { ...draft, sequence: 0 }, inserted: true };
});
const service = new ConversationService(store, bus);

await assert.rejects(
  service.sendGroupMessage({
    workspaceId: 'workspace-a', workspaceRoot: root,
    conversationId: 'event-failure-group', content: 'event failure',
  }),
  error => error instanceof Error && error.message === '关键事件持久化失败',
);
const failedRun = store.listRuns('workspace-a', 'event-failure-group')[0];
assert.equal(failedRun?.status, 'failed');
assert.match(failedRun?.failureReason ?? '', /关键事件持久化失败/);

failPersistence = false;
const recovered = await service.sendGroupMessage({
  workspaceId: 'workspace-a', workspaceRoot: root,
  conversationId: 'event-recovery-group', content: 'event recovery',
});
assert.equal(store.getRun('workspace-a', recovered.run.id)?.status, 'completed');
```

The second call must use the same `ConversationService` so a stale rejected ledger entry is observable.

- [ ] **Step 2: Run the strict regression against the old ledger**

```powershell
pnpm --filter @agentos/server exec node --unhandled-rejections=strict --import tsx --test --test-concurrency=1 --test-name-pattern="critical group-run event persistence fails" src/services/ConversationService.test.ts
```

Expected: FAIL from detached outer `flushRuntimeBuffer()` rejection or because the second run consumes the first run's stale rejection.

- [ ] **Step 3: Implement the critical work tracker**

Change the field and add the helper:

```ts
private readonly pendingEvents = new Set<Promise<unknown>>();

private trackCriticalEventWork<T>(pending: Promise<T>): Promise<T> {
  this.pendingEvents.add(pending);
  void pending.catch(() => undefined);
  return pending;
}
```

Use it for both detached runtime flush sites:

```ts
if (event.type === 'assistant.message') this.scheduleRuntimeFlush(runId);
else this.trackCriticalEventWork(this.flushRuntimeBuffer(runId));

// timer callback
this.trackCriticalEventWork(this.flushRuntimeBuffer(runId));
```

Use it in `publishEvent()` and return the original typed promise:

```ts
return this.trackCriticalEventWork(pending);
```

- [ ] **Step 4: Make ledger draining closed under newly-added promises**

Replace the one-snapshot `flushEvents()` with a loop. This is required because a tracked outer flush can add inner publish promises while it settles:

```ts
private async flushEvents(): Promise<void> {
  let rejected = false;
  while (this.pendingEvents.size > 0) {
    const pendingEvents = [...this.pendingEvents];
    const results = await Promise.allSettled(pendingEvents);
    for (const pending of pendingEvents) this.pendingEvents.delete(pending);
    if (results.some(result => result.status === 'rejected')) rejected = true;
  }
  if (rejected) throw new Error(CRITICAL_EVENT_PERSISTENCE_FAILURE);
}
```

- [ ] **Step 5: Drain the ledger on every run terminal path**

Restructure `flushEventsForRun()` so a rejected direct runtime flush cannot skip `flushEvents()`:

```ts
private async flushEventsForRun(workspaceId: string, runId: string): Promise<void> {
  let persistenceFailed = false;
  try {
    await this.trackCriticalEventWork(this.flushRuntimeBuffer(runId));
  } catch {
    persistenceFailed = true;
  }
  try {
    await this.flushEvents();
  } catch {
    persistenceFailed = true;
  }
  this.runtimeBuffers.delete(runId);
  this.runtimeQuotaNotices.forEach(key => {
    if (key.startsWith(`${runId}:`)) this.runtimeQuotaNotices.delete(key);
  });
  if (!persistenceFailed) return;
  this.store.updateRun(workspaceId, runId, {
    status: 'failed',
    failureReason: CRITICAL_EVENT_PERSISTENCE_FAILURE,
    completedAt: new Date().toISOString(),
  });
  throw new Error(CRITICAL_EVENT_PERSISTENCE_FAILURE);
}
```

- [ ] **Step 6: Run direct, group, strict rejection, and recovery coverage**

```powershell
pnpm --filter @agentos/server exec node --unhandled-rejections=strict --import tsx --test --test-concurrency=1 --test-name-pattern="critical direct-run event persistence fails|critical group-run event persistence fails" src/services/ConversationService.test.ts
```

Expected: both tests PASS; first group run rejects and is failed, second group run succeeds, and strict mode reports no unhandled rejection.

- [ ] **Step 7: Commit the critical-ledger deliverable**

Run from `E:\workspace\Multi-Agent`:

```powershell
git add agentos/apps/server/src/services/ConversationService.ts agentos/apps/server/src/services/ConversationService.test.ts
git diff --cached --check
git commit -m "fix: track critical runtime flush failures"
```

---

### Task 4: Replace the group concurrency timing assertion with a process barrier

**Files:**
- Modify: `apps/server/src/services/ConversationService.test.ts`
- Test: `apps/server/src/services/ConversationService.test.ts`

**Interfaces:**
- Consumes: existing `onExecutionEvent` status stream and Node child commands configured through workspace agent profiles.
- Produces: two marker-producing worker commands and an event-order assertion that fails if workers are started serially.

- [ ] **Step 1: Replace worker sleeps with a shared marker barrier**

Inside the existing `runs independent group workers concurrently after the leader plan` test, create a marker directory and worker command. The timeout is only a deadlock watchdog; elapsed time is never asserted:

```ts
const barrierDir = join(root, 'worker-barrier');
mkdirSync(barrierDir, { recursive: true });
const workerScript = [
  "const fs = require('node:fs')",
  "const [own, peer, label] = process.argv.slice(1)",
  "fs.writeFileSync(own, 'ready')",
  "const watchdog = setTimeout(() => process.exit(2), 15000)",
  "const poll = setInterval(() => {",
  "  if (!fs.existsSync(peer)) return",
  "  clearInterval(poll); clearTimeout(watchdog); console.log(label)",
  "}, 10)",
].join(';');
const kimiMarker = join(barrierDir, 'kimi.ready');
const opencodeMarker = join(barrierDir, 'opencode.ready');
```

Set Kimi args to `['-e', workerScript, kimiMarker, opencodeMarker, 'kimi worker']` and OpenCode args to `['-e', workerScript, opencodeMarker, kimiMarker, 'opencode worker']`. Do not retain `Date.now()`, `300`, or `<250`.

- [ ] **Step 2: Assert causal status order**

Record only non-leader events:

```ts
const workerEvents: Array<{ agentId: string; status: string }> = [];
// onExecutionEvent
if (event.agentId !== 'codex') workerEvents.push({ agentId: event.agentId, status: event.status });
```

After the group call, assert both starts occur before the first terminal state:

```ts
const terminal = new Set(['completed', 'failed', 'cancelled', 'waiting_user']);
const firstTerminal = workerEvents.findIndex(event => terminal.has(event.status));
const runningCli = ['kimi', 'opencode'].map(agentId =>
  workerEvents.findIndex(event => event.agentId === agentId && event.status === 'running_cli'),
);
assert.ok(firstTerminal >= 0);
assert.ok(runningCli.every(index => index >= 0 && index < firstTerminal));
assert.deepEqual(result.executions.map(execution => execution.agentId), ['codex', 'kimi', 'opencode', 'codex']);
```

- [ ] **Step 3: Run the deterministic concurrency test**

```powershell
pnpm --filter @agentos/server exec node --import tsx --test --test-concurrency=1 --test-name-pattern="runs independent group workers concurrently after the leader plan" src/services/ConversationService.test.ts
```

Expected: PASS without wall-clock assertions. A serialized worker loop would make the first worker hit the barrier watchdog before the second worker can start, so the test fails causally.

- [ ] **Step 4: Commit the deterministic harness**

Run from `E:\workspace\Multi-Agent`:

```powershell
git add agentos/apps/server/src/services/ConversationService.test.ts
git diff --cached --check
git commit -m "test: make group dispatch concurrency deterministic"
```

---

### Task 5: Run repetition and full local gates

**Files:**
- Verify only; no new files or code changes.

**Interfaces:**
- Consumes: Tasks 2-4 commits.
- Produces: deterministic repetition results and full local gate totals.

- [ ] **Step 1: Run startup findings ten consecutive times**

```powershell
1..10 | ForEach-Object {
  pnpm --filter @agentos/server exec node --import tsx --test --test-concurrency=1 --test-name-pattern="R31|R32|R33" src/serverStartup.test.ts
  if ($LASTEXITCODE -ne 0) { throw "startup repetition $_ failed" }
}
```

Expected: 10/10 PASS. Any failure is `NO-GO — DETERMINISM NOT PROVEN`.

- [ ] **Step 2: Run Conversation findings twenty consecutive times in strict mode**

```powershell
1..20 | ForEach-Object {
  pnpm --filter @agentos/server exec node --unhandled-rejections=strict --import tsx --test --test-concurrency=1 --test-name-pattern="critical group-run event persistence fails|runs independent group workers concurrently after the leader plan" src/services/ConversationService.test.ts
  if ($LASTEXITCODE -ne 0) { throw "conversation repetition $_ failed" }
}
```

Expected: 20/20 PASS with no unhandled rejection.

- [ ] **Step 3: Run the full server suite**

```powershell
pnpm --filter @agentos/server test
```

Expected: 1704 total, 1702 pass, 0 fail, 2 existing skips.

- [ ] **Step 4: Run the Shared M3 contract harness**

```powershell
pnpm --filter @agentos/server exec node --import tsx --test ../../packages/shared/m3-runtime.test.ts
```

Expected: 31/31 PASS.

- [ ] **Step 5: Run the workspace build**

```powershell
pnpm build
```

Expected: PASS.

---

### Task 6: Enforce diff gates, push once, and verify authoritative CI

**Files:**
- Verify only; no PR body, workflow, or source changes.

**Interfaces:**
- Consumes: `IMPLEMENTATION_BASE`, frozen old remote SHA, and all local validation evidence.
- Produces: one fast-forward remote update and one new authoritative `pull_request` CI run.

- [ ] **Step 1: Enforce implementation and cumulative allowlists**

Run from `E:\workspace\Multi-Agent`; derive the implementation base from the commit that added the authorized plan file:

```powershell
$implementationBase = git log -1 --format=%H -- agentos/docs/superpowers/plans/2026-08-11-agentos-ci-production-determinism-remediation.md
if (-not $implementationBase) { throw 'implementation base not found' }
git diff --check
git status --short --untracked-files=all
git diff --name-status "$implementationBase..HEAD"
git diff --name-status 56829742c6ec29a4a56e957deb530e34daa9b762..HEAD
git diff --exit-code 56829742c6ec29a4a56e957deb530e34daa9b762..HEAD -- .github/workflows/ci.yml agentos/pnpm-lock.yaml agentos/package.json agentos/apps/server/src/store/SqliteStore.ts
git grep -n -E "NODE_OPTIONS|--no-warnings" -- agentos/apps/server/package.json agentos/apps/server/src/serverStartup.test.ts
```

Expected implementation diff: exactly the four authorized production/test files. Expected cumulative diff: design spec, implementation plan, and those four files. Frozen-file diff is empty; grep has no matches.

- [ ] **Step 2: Verify frozen versions and test command**

```powershell
node -e "const p=require('./agentos/apps/server/package.json'); console.log(p.devDependencies.tsx); console.log(p.scripts.test)"
Select-String -Path agentos/pnpm-lock.yaml -Pattern 'tsx@4.23.11'
Select-String -Path .github/workflows/ci.yml -Pattern 'node-version: 22'
```

Expected: `^4.23.1`, unchanged test command, resolved `4.23.11`, Node 22.

- [ ] **Step 3: Recheck the remote immediately before push**

```powershell
git fetch origin
git rev-parse origin/main
git rev-parse origin/infra/github-actions-ci
gh pr view 42 --json state,isDraft,mergedAt,headRefOid
```

Expected: remote refs still `77add6a0...` and `56829742...`; PR OPEN/DRAFT/unmerged. Any remote branch drift is `NO-GO — REMOTE HEAD DRIFT`.

- [ ] **Step 4: Push once by ordinary fast-forward**

```powershell
git push origin HEAD:infra/github-actions-ci
```

Expected: non-forced fast-forward from `56829742` to final local HEAD.

- [ ] **Step 5: Find the new authoritative run**

```powershell
$newHead = git rev-parse HEAD
$runs = gh run list --branch infra/github-actions-ci --event pull_request --limit 10 --json databaseId,headSha,event,status,conclusion,url,workflowName | ConvertFrom-Json
$run = $runs | Where-Object { $_.headSha -eq $newHead -and $_.event -eq 'pull_request' } | Select-Object -First 1
if (-not $run) { throw "no pull_request run found for $newHead" }
$runId = $run.databaseId
$run | ConvertTo-Json -Depth 5
```

Select the run whose `headSha` equals `$newHead` and whose event is `pull_request`; never rerun or cite baseline run `31453823652` as final proof.

- [ ] **Step 6: Wait for and inspect the new run**

```powershell
gh run watch $runId --exit-status
gh run view $runId --json databaseId,event,headSha,status,conclusion,jobs,url
```

Expected: Install dependencies, Server tests, Shared M3 contract harness, Workspace build, and overall workflow all PASS on Node 22. If a new failure class appears, report `NO-GO — NEW REGRESSION`, preserve logs, and stop without additional remediation.

- [ ] **Step 7: Audit the final PR boundary**

```powershell
gh pr view 42 --json state,isDraft,mergedAt,headRefOid,body,url
git status --short --untracked-files=all
git rev-parse HEAD
git rev-parse origin/infra/github-actions-ci
```

Expected: PR #42 remains OPEN/DRAFT and unmerged; local/remote heads match; worktree clean. Do not change the known-stale PR body in this gate. Ready, Merge, and M4 remain not performed.
