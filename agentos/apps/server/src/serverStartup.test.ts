import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import net, { type AddressInfo } from 'node:net';
import type { TaskItem, Workspace } from '@agentos/shared';
import { DEFAULT_WORKSPACE_AGENTS } from '@agentos/agent-core';
import { SqliteStore } from './store/SqliteStore.js';
import { TaskRunService } from './services/TaskRunService.js';
import { acquireServerOwnership, type ServerOwnership } from './serverOwnership.js';

const SERVER_SRC_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = join(SERVER_SRC_DIR, 'index.ts');
const SERVER_CWD = resolve(SERVER_SRC_DIR, '..');

const HEALTH_TIMEOUT_MS = 60_000;
const EXIT_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 15_000;

function makeTempRoot(label: string): string {
  return mkdtempSync(join(tmpdir(), `agentos-startup-${label}-`));
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => resolvePromise());
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>(resolvePromise => server.close(() => resolvePromise()));
  return port;
}

interface SpawnedServer {
  child: ChildProcess;
  port: number;
  root: string;
  output(): string;
}

function spawnServer(root: string, port: number): SpawnedServer {
  let buffer = '';
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
  child.stdout?.on('data', chunk => { buffer += String(chunk); });
  child.stderr?.on('data', chunk => { buffer += String(chunk); });
  return { child, port, root, output: () => buffer };
}

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

function waitForExit(
  child: ChildProcess,
  timeoutMs = EXIT_TIMEOUT_MS,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolvePromise({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectPromise(new Error('child process did not exit in time'));
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal });
    });
  });
}

async function waitForHealthy(port: number, timeoutMs = HEALTH_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
      lastError = new Error(`unexpected health status ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
  }
  throw new Error(`server on port ${port} did not become healthy: ${String(lastError)}`);
}

async function stopServer(server: SpawnedServer): Promise<void> {
  if (server.child.exitCode !== null || server.child.signalCode !== null) return;
  server.child.kill('SIGTERM');
  try {
    await waitForExit(server.child, STOP_TIMEOUT_MS);
  } catch {
    server.child.kill('SIGKILL');
    await waitForExit(server.child, STOP_TIMEOUT_MS).catch(() => {});
  }
}

function killServer(server: SpawnedServer | undefined): void {
  if (!server) return;
  if (server.child.exitCode === null && server.child.signalCode === null) {
    server.child.kill('SIGKILL');
  }
}

function makeWorkspace(id: string, root: string): Workspace {
  const now = '2026-07-25T00:00:00.000Z';
  return {
    id,
    name: id,
    rootPath: join(root, id),
    gitEnabled: false,
    memoryEnabled: false,
    agents: structuredClone(DEFAULT_WORKSPACE_AGENTS),
    lastOpenedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

function makeLegacyTask(workspaceId: string, status: TaskItem['status']): TaskItem {
  return {
    id: `legacy-${workspaceId}`,
    workspaceId,
    title: `Legacy ${workspaceId}`,
    status,
    currentAgent: null,
    outputs: [],
    reviewDecision: 'unknown',
    reviewBlocked: false,
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T00:00:00.000Z',
  };
}

interface RunStateSnapshot {
  runStatus: string;
  runVersion: number;
  runFailureCode: string | null;
  taskVersion: number;
  legacyTasksJson: string;
}

interface SeededQueuedRun {
  workspaceId: string;
  legacyTaskId: string;
  taskId: string;
  runId: string;
  initial: RunStateSnapshot;
}

function readRunState(
  root: string,
  workspaceId: string,
  runId: string,
  taskId: string,
): RunStateSnapshot {
  const store = new SqliteStore(root);
  try {
    const run = store.runRepository().findById(workspaceId, runId);
    const task = store.taskRepository().findById(workspaceId, taskId);
    assert.ok(run, `run ${runId} should exist`);
    assert.ok(task, `task ${taskId} should exist`);
    return {
      runStatus: run.status,
      runVersion: run.version,
      runFailureCode: run.failureCode ?? null,
      taskVersion: task.version,
      legacyTasksJson: JSON.stringify(store.loadTasks(workspaceId)),
    };
  } finally {
    store.close();
  }
}

function seedQueuedLegacyRun(root: string, workspaceId: string): SeededQueuedRun {
  const store = new SqliteStore(root);
  try {
    const workspace = makeWorkspace(workspaceId, root);
    store.saveWorkspaces([workspace]);
    const legacyTask = makeLegacyTask(workspaceId, 'completed');
    store.saveTask(workspaceId, legacyTask);
    const service = new TaskRunService(store);
    const created = service.createLegacyRunForBridge({
      workspaceId,
      legacyTaskId: legacyTask.id,
      title: `Legacy ${workspaceId}`,
      createdBy: 'legacy_pipeline',
      objective: `Legacy ${workspaceId}`,
      workspace,
    });
    assert.ok(created.snapshot);
    assert.equal(created.stages.length, 4);
    assert.equal(store.runSnapshotRepository().findByRunId(workspaceId, created.run.id)?.id, created.snapshot.id);
    assert.equal(store.runStageRepository().listByRun(workspaceId, created.run.id).length, 4);
    const initial = readRunState(root, workspaceId, created.run.id, created.task.id);
    assert.equal(initial.runStatus, 'queued');
    return {
      workspaceId,
      legacyTaskId: legacyTask.id,
      taskId: created.task.id,
      runId: created.run.id,
      initial,
    };
  } finally {
    store.close();
  }
}

function snapshotProjectTree(root: string): Record<string, string> {
  const diagnosticsDir = join(root, '.agentos', 'logs', 'diagnostics');
  const entries: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const absolute = join(dir, name);
      if (absolute === diagnosticsDir) continue;
      const stats = statSync(absolute);
      if (stats.isDirectory()) {
        walk(absolute);
      } else if (stats.isFile()) {
        const key = relative(root, absolute).split(sep).join('/');
        entries[key] = createHash('sha256').update(readFileSync(absolute)).digest('hex');
      }
    }
  };
  walk(root);
  return entries;
}

function assertNoLeak(text: string, root: string, extraForbidden: string[]): void {
  const lowered = text.toLowerCase();
  for (const fragment of extraForbidden) {
    assert.ok(!lowered.includes(fragment.toLowerCase()), `output leaked forbidden fragment: ${fragment}`);
  }
  assert.ok(!lowered.includes(root.toLowerCase()), 'output leaked the absolute project root');
  assert.ok(!text.includes('.ts'), 'output leaked a TypeScript source path');
  assert.ok(!text.includes('.js'), 'output leaked a JavaScript source path');
  assert.ok(!text.includes('node_modules'), 'output leaked a dependency path');
}

function readDiagnosticsLog(root: string): string {
  const diagnosticsDir = join(root, '.agentos', 'logs', 'diagnostics');
  if (!existsSync(diagnosticsDir)) return '';
  return readdirSync(diagnosticsDir)
    .map(name => readFileSync(join(diagnosticsDir, name), 'utf-8'))
    .join('\n');
}

test('R25 same project root with different HTTP ports blocks the second instance', { timeout: 240_000 }, async () => {
  const root = makeTempRoot('r25');
  const portA = await freePort();
  const portB = await freePort();
  const serverA = spawnServer(root, portA);
  let serverB: SpawnedServer | undefined;
  try {
    await waitForHealthy(portA);
    const seeded = seedQueuedLegacyRun(root, 'ws-r25');

    serverB = spawnServer(root, portB);
    const exitB = await waitForExit(serverB.child);
    assert.notEqual(exitB.code, 0, 'second instance must exit non-zero');
    assert.ok(serverB.output().includes('SERVER_ALREADY_RUNNING'), 'second instance must report the stable ownership code');

    const after = readRunState(root, seeded.workspaceId, seeded.runId, seeded.taskId);
    assert.deepEqual(after, seeded.initial, 'blocked instance must not mutate the queued Run or Task');

    await waitForHealthy(portA, 10_000);

    // The preserved queued Run can still be started afterwards.
    const store = new SqliteStore(root);
    try {
      const service = new TaskRunService(store);
      const started = service.startRunForBridge(seeded.workspaceId, seeded.runId);
      assert.equal(started.run.status, 'running');
      service.failRunForBridge(seeded.workspaceId, seeded.runId, 'r25 cleanup');
    } finally {
      store.close();
    }
  } finally {
    killServer(serverB);
    await stopServer(serverA);
    rmSync(root, { recursive: true, force: true });
  }
});

test('R26 same project root with the same HTTP port fails on ownership before any bind or recovery', { timeout: 240_000 }, async () => {
  const root = makeTempRoot('r26');
  const port = await freePort();
  const serverA = spawnServer(root, port);
  let serverB: SpawnedServer | undefined;
  try {
    await waitForHealthy(port);
    const seeded = seedQueuedLegacyRun(root, 'ws-r26');

    serverB = spawnServer(root, port);
    const exitB = await waitForExit(serverB.child);
    assert.notEqual(exitB.code, 0, 'second instance must exit non-zero');
    assert.ok(serverB.output().includes('SERVER_ALREADY_RUNNING'), 'second instance must fail on ownership, not on HTTP bind');

    const after = readRunState(root, seeded.workspaceId, seeded.runId, seeded.taskId);
    assert.deepEqual(after, seeded.initial, 'queued Run must not be failed by the blocked instance');
    assert.notEqual(after.runFailureCode, 'BRIDGE_PRESTART_INTERRUPTED');

    await waitForHealthy(port, 10_000);
  } finally {
    killServer(serverB);
    await stopServer(serverA);
    rmSync(root, { recursive: true, force: true });
  }
});

test('R27 different project roots run servers simultaneously', { timeout: 240_000 }, async () => {
  const rootA = makeTempRoot('r27a');
  const rootB = makeTempRoot('r27b');
  const portA = await freePort();
  const portB = await freePort();
  const serverA = spawnServer(rootA, portA);
  const serverB = spawnServer(rootB, portB);
  try {
    await waitForHealthy(portA);
    await waitForHealthy(portB);
    await waitForHealthy(portA, 10_000);
    await waitForHealthy(portB, 10_000);
  } finally {
    await stopServer(serverA);
    await stopServer(serverB);
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});

test('R28 crash releases ownership and the next instance completes orphan recovery', { timeout: 240_000 }, async () => {
  const root = makeTempRoot('r28');
  const portA = await freePort();
  const serverA = spawnServer(root, portA);
  let serverC: SpawnedServer | undefined;
  try {
    await waitForHealthy(portA);
    const seeded = seedQueuedLegacyRun(root, 'ws-r28');

    serverA.child.kill('SIGKILL');
    await waitForExit(serverA.child);

    const portC = await freePort();
    serverC = spawnServer(root, portC);
    await waitForHealthy(portC);

    const recovered = readRunState(root, seeded.workspaceId, seeded.runId, seeded.taskId);
    assert.equal(recovered.runStatus, 'failed');
    assert.equal(recovered.runFailureCode, 'BRIDGE_PRESTART_INTERRUPTED');

    const store = new SqliteStore(root);
    try {
      const service = new TaskRunService(store);
      const workspace = store.loadWorkspaces().find(candidate => candidate.id === seeded.workspaceId);
      assert.ok(workspace);
      const retry = service.createLegacyRunForBridge({
        workspaceId: seeded.workspaceId,
        legacyTaskId: seeded.legacyTaskId,
        title: `Legacy ${seeded.workspaceId}`,
        createdBy: 'legacy_pipeline',
        objective: `Legacy ${seeded.workspaceId}`,
        workspace,
      });
      assert.equal(retry.run.parentRunId, seeded.runId);
      assert.notEqual(retry.run.id, seeded.runId);
    } finally {
      store.close();
    }

    await waitForHealthy(portC, 10_000);
  } finally {
    killServer(serverA);
    if (serverC) await stopServer(serverC);
    rmSync(root, { recursive: true, force: true });
  }
});

test('R31 startup recovery failure exits sanitized and rolls back without leaking', { timeout: 240_000 }, async () => {
  assertSelectiveWarningPolicy();
  const root = makeTempRoot('r31');
  const seeded = seedQueuedLegacyRun(root, 'ws-r31');
  {
    const store = new SqliteStore(root);
    try {
      store.getDatabase().exec(`
        CREATE TRIGGER fail_queued_restart_recovery
        BEFORE UPDATE OF status ON runs
        WHEN OLD.status = 'queued' AND NEW.status = 'failed'
        BEGIN
          SELECT RAISE(ABORT, 'injected queued recovery failure');
        END;
      `);
    } finally {
      store.close();
    }
  }

  const port = await freePort();
  const failed = spawnServer(root, port);
  let restarted: SpawnedServer | undefined;
  try {
    const exit = await waitForExit(failed.child);
    assert.notEqual(exit.code, 0, 'startup recovery failure must exit non-zero');
    const output = failed.output();
    assert.ok(
      output.includes('[AgentOS Server] startup failed: STARTUP_RECOVERY_FAILED'),
      'startup recovery failure must report the stable sanitized code',
    );
    assertNoLeak(output, root, [
      'injected queued recovery failure',
      'SQLITE',
      'SQL',
      'fail_queued_restart_recovery',
      'EADDRINUSE',
    ]);

    // The failed instance never reached HTTP listen.
    await assert.rejects(
      () => fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2_000) }),
    );

    const diagnostics = readDiagnosticsLog(root);
    assert.ok(diagnostics.includes('STARTUP_RECOVERY_FAILED'), 'diagnostics must record the stable code');
    assertNoLeak(diagnostics, root, [
      'injected queued recovery failure',
      'SQLITE',
      'SQL',
      'fail_queued_restart_recovery',
    ]);

    // The recovery transaction rolled back: the queued Run is preserved.
    const afterFailure = readRunState(root, seeded.workspaceId, seeded.runId, seeded.taskId);
    assert.deepEqual(afterFailure, seeded.initial);

    // Ownership was released: once the trigger is removed the same root starts again.
    {
      const store = new SqliteStore(root);
      try {
        store.getDatabase().exec('DROP TRIGGER fail_queued_restart_recovery');
      } finally {
        store.close();
      }
    }
    const port2 = await freePort();
    restarted = spawnServer(root, port2);
    await waitForHealthy(port2);
    const afterRestart = readRunState(root, seeded.workspaceId, seeded.runId, seeded.taskId);
    assert.equal(afterRestart.runStatus, 'failed');
    assert.equal(afterRestart.runFailureCode, 'BRIDGE_PRESTART_INTERRUPTED');
  } finally {
    killServer(failed);
    if (restarted) await stopServer(restarted);
    rmSync(root, { recursive: true, force: true });
  }
});

test('R32 HTTP bind failure is sanitized and releases ownership', { timeout: 240_000 }, async () => {
  const root = makeTempRoot('r32');
  const blocker = net.createServer();
  const blockedPort = await new Promise<number>((resolvePromise, rejectPromise) => {
    blocker.once('error', rejectPromise);
    blocker.listen(0, '127.0.0.1', () => resolvePromise((blocker.address() as AddressInfo).port));
  });
  const failed = spawnServer(root, blockedPort);
  let restarted: SpawnedServer | undefined;
  try {
    const exit = await waitForExit(failed.child);
    assert.notEqual(exit.code, 0, 'HTTP bind failure must exit non-zero');
    const output = failed.output();
    assert.ok(
      output.includes('[AgentOS Server] startup failed: SERVER_LISTEN_FAILED'),
      'HTTP bind failure must report the stable sanitized code',
    );
    assertNoLeak(output, root, ['EADDRINUSE', 'SQLITE', 'SQL']);

    // Ownership was released: a new instance on a free port starts on the same root.
    const port2 = await freePort();
    restarted = spawnServer(root, port2);
    await waitForHealthy(port2);
  } finally {
    killServer(failed);
    if (restarted) await stopServer(restarted);
    await new Promise<void>(resolvePromise => blocker.close(() => resolvePromise()));
    rmSync(root, { recursive: true, force: true });
  }
});

test('R33 ownership failure has no persistent side effects beyond diagnostics', { timeout: 240_000 }, async () => {
  const root = makeTempRoot('r33');
  const seeded = seedQueuedLegacyRun(root, 'ws-r33');
  let ownership: ServerOwnership | undefined;
  let serverB: SpawnedServer | undefined;
  try {
    ownership = await acquireServerOwnership(root);
    const before = snapshotProjectTree(root);
    assert.equal(
      Object.keys(before).some(path => path.toLowerCase().endsWith('.sqlite-journal')),
      false,
      'ownership fixture must start without a journal file',
    );

    const portB = await freePort();
    serverB = spawnServer(root, portB);
    const exitB = await waitForExit(serverB.child);
    assert.notEqual(exitB.code, 0, 'second instance must exit non-zero');
    assert.ok(serverB.output().includes('SERVER_ALREADY_RUNNING'));

    const after = snapshotProjectTree(root);
    assert.deepEqual(after, before, 'blocked instance must not change any project root file outside diagnostics');

    const state = readRunState(root, seeded.workspaceId, seeded.runId, seeded.taskId);
    assert.deepEqual(state, seeded.initial, 'blocked instance must not mutate Task, Run, JSON, or versions');
    await assert.rejects(
      () => fetch(`http://127.0.0.1:${portB}/api/health`, { signal: AbortSignal.timeout(2_000) }),
      'blocked instance must not enter HTTP listen',
    );
  } finally {
    killServer(serverB);
    await ownership?.release();
    rmSync(root, { recursive: true, force: true });
  }
});
