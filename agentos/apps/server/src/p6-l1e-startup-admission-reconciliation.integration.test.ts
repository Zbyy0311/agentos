import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net, { type AddressInfo } from 'node:net';
import type { Workspace } from '@agentos/shared';
import { DEFAULT_WORKSPACE_AGENTS } from '@agentos/agent-core';
import { SqliteStore } from './store/SqliteStore.js';
import { WorkspaceAdmissionRepository } from './store/WorkspaceAdmissionRepository.js';

/**
 * P6-L1E integration tests: real spawned server process proving the production
 * startup sequencing
 *   ownership -> store/migrations -> process preflight -> existing recovery
 *   -> L1E admission reconciliation -> services/routes/listen
 * plus the fail-closed startup boundary (stable sanitized code, rollback, no
 * HTTP listen, ownership released) and restart idempotency.
 *
 * L1E validates the durable admission authority AFTER recovery. The durable
 * conflict cases below are therefore seeded directly as admission rows so they
 * survive recovery unchanged and reach the reconciler.
 */

const SERVER_SRC_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = join(SERVER_SRC_DIR, 'index.ts');
const SERVER_CWD = resolve(SERVER_SRC_DIR, '..');

const HEALTH_TIMEOUT_MS = 60_000;
const EXIT_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 15_000;

function makeTempRoot(label: string): string {
  return mkdtempSync(join(tmpdir(), 'agentos-l1e-it-' + label + '-'));
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
    env: { ...process.env, AGENTOS_PROJECT_ROOT: root, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', chunk => { buffer += String(chunk); });
  child.stderr?.on('data', chunk => { buffer += String(chunk); });
  return { child, port, output: () => buffer };
}

function waitForExit(child: ChildProcess, timeoutMs = EXIT_TIMEOUT_MS): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
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
      const response = await fetch('http://127.0.0.1:' + port + '/api/health', { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
      lastError = new Error('unexpected health status ' + response.status);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
  }
  throw new Error('server on port ' + port + ' did not become healthy: ' + String(lastError));
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
  if (server.child.exitCode === null && server.child.signalCode === null) server.child.kill('SIGKILL');
}

function seedWorkspaceGraph(root: string, workspaceId: string): void {
  const store = new SqliteStore(root);
  try {
    const now = '2026-07-25T00:00:00.000Z';
    const workspace: Workspace = {
      id: workspaceId,
      name: workspaceId,
      rootPath: join(root, workspaceId),
      gitEnabled: false,
      memoryEnabled: false,
      agents: structuredClone(DEFAULT_WORKSPACE_AGENTS),
      lastOpenedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    store.saveWorkspaces([workspace]);
  } finally {
    store.close();
  }
}

interface AdmissionSeed {
  readonly admissionId: string;
  readonly runId: string;
  readonly taskId: string;
}

/**
 * Seed a terminal run plus an Admission in the given state. The run is made
 * terminal so existing recovery is a no-op; the Admission row is what L1E
 * validates. Returns the ids used.
 */
function seedAdmission(
  root: string,
  workspaceId: string,
  opts: {
    readonly runId: string;
    readonly runStatus: string;
    readonly admissionId: string;
    readonly requestOrder: number;
    readonly state: string;
    readonly queueReason?: string | null;
    readonly releaseReason?: string | null;
    readonly grantedAt?: string | null;
    readonly releasedAt?: string | null;
    readonly effectiveClass?: string;
  },
): AdmissionSeed {
  const store = new SqliteStore(root);
  try {
    const now = '2026-07-25T00:00:00.000Z';
    const db = store.getDatabase();
    db.prepare(
      "INSERT INTO tasks (id, workspace_id, title, status, created_by, created_at, updated_at) VALUES (?, ?, 't', 'open', 'test', ?, ?)",
    ).run(opts.runId + '-task', workspaceId, now, now);
    db.prepare(
      "INSERT INTO runs (id, workspace_id, task_id, parent_run_id, root_run_id, status, reason, origin, objective, failure_code, failure_message, cancellation_requested_at, next_event_sequence, started_at, completed_at, created_by, created_at, updated_at, version) VALUES (?, ?, ?, NULL, ?, ?, 'initial', 'v2_api', NULL, NULL, NULL, NULL, 1, NULL, NULL, 'test', ?, ?, 1)",
    ).run(opts.runId, workspaceId, opts.runId + '-task', opts.runId, opts.runStatus, now, now);
    new WorkspaceAdmissionRepository(db).insertAdmission({
      id: opts.admissionId,
      workspaceId,
      subjectKind: 'CANONICAL_RUN',
      canonicalRunId: opts.runId,
      legacyRunId: null,
      requestedMutationClass: 'MODIFYING',
      effectiveMutationClass: (opts.effectiveClass ?? 'MODIFYING') as 'MODIFYING',
      enforcementEvidenceJson: null,
      requestOrder: opts.requestOrder,
      state: opts.state as 'GRANTED',
      queueReason: opts.queueReason ?? null,
      releaseReason: opts.releaseReason ?? null,
      requestedAt: now,
      grantedAt: opts.grantedAt ?? null,
      releasedAt: opts.releasedAt ?? null,
      createdAt: now,
      updatedAt: now,
      version: 1,
    });
    return { admissionId: opts.admissionId, runId: opts.runId, taskId: opts.runId + '-task' };
  } finally {
    store.close();
  }
}

/** Seed two GRANTED MODIFYING holders in one Workspace, bypassing the DB fence. */
function seedTwoModifyingGranted(root: string, workspaceId: string): [AdmissionSeed, AdmissionSeed] {
  const store = new SqliteStore(root);
  try {
    store.getDatabase().exec('DROP INDEX workspace_admissions_one_modifying_granted');
  } finally {
    store.close();
  }
  const a = seedAdmission(root, workspaceId, {
    runId: 'run-a', runStatus: 'completed', admissionId: 'grant-a', requestOrder: 1,
    state: 'GRANTED', grantedAt: '2026-07-25T00:00:01.000Z',
  });
  const b = seedAdmission(root, workspaceId, {
    runId: 'run-b', runStatus: 'completed', admissionId: 'grant-b', requestOrder: 2,
    state: 'GRANTED', grantedAt: '2026-07-25T00:00:02.000Z',
  });
  return [a, b];
}

function admissionCountAll(root: string): number {
  const store = new SqliteStore(root);
  try {
    const row = store.getDatabase().prepare('SELECT COUNT(*) AS c FROM workspace_admissions').get() as { c: number };
    return row.c;
  } finally {
    store.close();
  }
}

function readAdmissions(root: string, workspaceId: string) {
  const store = new SqliteStore(root);
  try {
    return new WorkspaceAdmissionRepository(store.getDatabase()).listByWorkspace(workspaceId);
  } finally {
    store.close();
  }
}

function readDiagnosticsLog(root: string): string {
  const dir = join(root, '.agentos', 'logs', 'diagnostics');
  if (!existsSync(dir)) return '';
  return readdirSync(dir).map(name => readFileSync(join(dir, name), 'utf-8')).join('\n');
}

function assertNoLeak(text: string, root: string, extraForbidden: string[]): void {
  const lowered = text.toLowerCase();
  for (const fragment of extraForbidden) {
    assert.ok(!lowered.includes(fragment.toLowerCase()), 'output leaked forbidden fragment: ' + fragment);
  }
  assert.ok(!lowered.includes(root.toLowerCase()), 'output leaked the absolute project root');
}

// L1E-I01 + L1E-I14: migration-016 DB with zero Admissions -> clean startup, no fabrication.
test('L1E-I01/I14 empty admissions startup clean, no fabrication, HTTP listens', { timeout: 240_000 }, async () => {
  const root = makeTempRoot('i01');
  seedWorkspaceGraph(root, 'ws-i01');
  assert.equal(admissionCountAll(root), 0, 'migration 016 leaves admissions empty before startup');
  const port = await freePort();
  const server = spawnServer(root, port);
  try {
    await waitForHealthy(port);
    assert.equal(admissionCountAll(root), 0, 'no subject means no Admission is fabricated');
  } finally {
    await stopServer(server);
    rmSync(root, { recursive: true, force: true });
  }
});

// L1E-I07 + L1E-I10 + L1E-I11 + §27: durable admission conflict -> startup fails closed
// before listen, sanitized, rolled back, ownership released so a fixed startup succeeds.
test('L1E-I07/I10/I11 conflicting GRANTED holders fail closed before HTTP listen', { timeout: 240_000 }, async () => {
  const root = makeTempRoot('i07');
  seedWorkspaceGraph(root, 'ws-i07');
  seedTwoModifyingGranted(root, 'ws-i07');
  assert.equal(admissionCountAll(root), 2);

  const port = await freePort();
  const failed = spawnServer(root, port);
  let restarted: SpawnedServer | undefined;
  try {
    const exit = await waitForExit(failed.child);
    assert.notEqual(exit.code, 0, 'conflicting holders must exit non-zero');
    const output = failed.output();
    assert.ok(
      output.includes('[AgentOS Server] startup failed: STARTUP_ADMISSION_RECONCILIATION_FAILED'),
      'must report the stable sanitized code; got: ' + output,
    );
    assertNoLeak(output, root, ['run-a', 'run-b', 'SQLITE', 'workspace_admissions', 'one_modifying_granted']);
    // Never reached HTTP listen.
    await assert.rejects(
      () => fetch('http://127.0.0.1:' + port + '/api/health', { signal: AbortSignal.timeout(2_000) }),
    );
    // Rolled back: exactly the two seeded rows, unchanged (no partial mutation).
    assert.equal(admissionCountAll(root), 2, 'failed reconciliation must not mutate admissions');
    const diagnostics = readDiagnosticsLog(root);
    assert.ok(diagnostics.includes('STARTUP_ADMISSION_RECONCILIATION_FAILED'));
    assertNoLeak(diagnostics, root, ['run-a', 'run-b', 'SQLITE', 'workspace_admissions']);

    // Ownership released: resolve the conflict (release one holder) -> next startup succeeds.
    const store = new SqliteStore(root);
    try {
      store.getDatabase().prepare(
        "UPDATE workspace_admissions SET state = 'RELEASED', release_reason = 'RUN_TERMINAL', released_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ?",
      ).run('2026-07-25T00:00:03.000Z', '2026-07-25T00:00:03.000Z', 'ws-i07', 'grant-b');
    } finally {
      store.close();
    }
    const port2 = await freePort();
    restarted = spawnServer(root, port2);
    await waitForHealthy(port2);
  } finally {
    killServer(failed);
    if (restarted) await stopServer(restarted);
    rmSync(root, { recursive: true, force: true });
  }
});

// L1E-I09 + L1E-I12: a single consistent GRANTED holder survives restart with no
// duplicate, stable request_order, and no unjustified version churn.
test('L1E-I09/I12 consistent holder restart is idempotent', { timeout: 240_000 }, async () => {
  const root = makeTempRoot('i09');
  seedWorkspaceGraph(root, 'ws-i09');
  seedAdmission(root, 'ws-i09', {
    runId: 'run-a', runStatus: 'completed', admissionId: 'grant-a', requestOrder: 1,
    state: 'GRANTED', grantedAt: '2026-07-25T00:00:01.000Z',
  });

  const port = await freePort();
  const first = spawnServer(root, port);
  try {
    await waitForHealthy(port);
    const rows1 = readAdmissions(root, 'ws-i09');
    assert.equal(rows1.length, 1);
    const snapshot1 = rows1.map(r => ({ id: r.id, order: r.requestOrder, version: r.version }));
    await stopServer(first);

    const port2 = await freePort();
    const second = spawnServer(root, port2);
    try {
      await waitForHealthy(port2);
      const rows2 = readAdmissions(root, 'ws-i09');
      assert.equal(rows2.length, 1, 'restart must not duplicate the Admission');
      assert.deepEqual(rows2.map(r => ({ id: r.id, order: r.requestOrder, version: r.version })), snapshot1,
        'restart must not churn request_order or version');
    } finally {
      await stopServer(second);
    }
  } finally {
    killServer(first);
    rmSync(root, { recursive: true, force: true });
  }
});

// L1E-I13: a terminal Admission bound to a terminal subject is left untouched.
test('L1E-I13 terminal admission + terminal subject is untouched', { timeout: 240_000 }, async () => {
  const root = makeTempRoot('i13');
  seedWorkspaceGraph(root, 'ws-i13');
  seedAdmission(root, 'ws-i13', {
    runId: 'run-a', runStatus: 'completed', admissionId: 'grant-a', requestOrder: 1,
    state: 'RELEASED', releaseReason: 'RUN_TERMINAL',
    grantedAt: '2026-07-25T00:00:01.000Z', releasedAt: '2026-07-25T00:00:02.000Z',
  });
  const port = await freePort();
  const server = spawnServer(root, port);
  try {
    await waitForHealthy(port);
    const rows = readAdmissions(root, 'ws-i13');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, 'RELEASED', 'terminal admission is never reopened');
  } finally {
    await stopServer(server);
    rmSync(root, { recursive: true, force: true });
  }
});
