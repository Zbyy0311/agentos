import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net, { type AddressInfo } from 'node:net';
import type { Workspace } from '@agentos/shared';
import { DEFAULT_WORKSPACE_AGENTS } from '@agentos/agent-core';
import { SqliteStore } from './store/SqliteStore.js';
import { createEntityId } from './store/Identity.js';
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

function spawnServer(
  root: string,
  port: number,
  extraEnv: Record<string, string> = {},
): SpawnedServer {
  let buffer = '';
  const child = spawn(process.execPath, [
    '--disable-warning=ExperimentalWarning',
    '--import',
    'tsx',
    SERVER_ENTRY,
  ], {
    cwd: SERVER_CWD,
    env: { ...process.env, AGENTOS_PROJECT_ROOT: root, PORT: String(port), ...extraEnv },
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

async function waitForHealthy(
  port: number,
  timeoutMs = HEALTH_TIMEOUT_MS,
  output: () => string = () => '',
): Promise<void> {
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
  throw new Error(
    'server on port ' + port + ' did not become healthy: ' + String(lastError)
      + '\n--- server output ---\n' + output(),
  );
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
    /** When set, seed a completed run.start Operation so recovery can run. */
    readonly withStartOperation?: boolean;
    /** When set, seed a Run Stage in this status. */
    readonly stageStatus?: string;
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
    if (opts.stageStatus !== undefined) {
      db.prepare(
        "INSERT INTO run_snapshots (id, workspace_id, run_id, workflow_definition_id, snapshot_schema_version, snapshot_json, content_hash, redaction_applied, captured_at) VALUES (?, ?, ?, 'workflow_00000000000000000000000002', 1, '{}', ?, 0, ?)",
      ).run(opts.runId + '-snapshot', workspaceId, opts.runId, '0'.repeat(64), now);
      db.prepare(
        "INSERT INTO run_stages (id, workspace_id, run_id, run_snapshot_id, workflow_stage_key, name, sequence, attempt, status, failure_code, failure_message, started_at, completed_at, created_at, updated_at, version) VALUES (?, ?, ?, ?, 'stage_one', 'stage_one', 1, 1, ?, NULL, NULL, NULL, NULL, ?, ?, 1)",
      ).run(opts.runId + '-stage', workspaceId, opts.runId, opts.runId + '-snapshot', opts.stageStatus, now, now);
    }
    if (opts.withStartOperation === true) {
      const operationId = createEntityId('operation');
      db.prepare(
        "INSERT INTO operations (id, type, status, workspace_id, aggregate_type, aggregate_id, run_id, correlation_id, result_json, error_json, created_at, started_at, completed_at, updated_at, version) VALUES (?, 'run.start', 'completed', ?, 'run', ?, ?, ?, NULL, NULL, ?, ?, ?, ?, 1)",
      ).run(operationId, workspaceId, opts.runId, opts.runId, operationId, now, now, now, now);
    }
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

/**
 * Seed two GRANTED MODIFYING holders in one Workspace, bypassing the DB fence.
 * The subjects are `paused` with a completed start Operation and a pending
 * Stage, which production recovery leaves untouched. That keeps the durable
 * conflict reachable AFTER the HIGH-2 terminal-release pass: a terminal subject
 * would now be released instead of conflicting.
 */
function seedTwoModifyingGranted(root: string, workspaceId: string): [AdmissionSeed, AdmissionSeed] {
  const store = new SqliteStore(root);
  try {
    store.getDatabase().exec('DROP INDEX workspace_admissions_one_modifying_granted');
  } finally {
    store.close();
  }
  const a = seedAdmission(root, workspaceId, {
    runId: 'run-a', runStatus: 'paused', admissionId: 'grant-a', requestOrder: 1,
    withStartOperation: true, stageStatus: 'pending',
    state: 'GRANTED', grantedAt: '2026-07-25T00:00:01.000Z',
  });
  const b = seedAdmission(root, workspaceId, {
    runId: 'run-b', runStatus: 'paused', admissionId: 'grant-b', requestOrder: 2,
    withStartOperation: true, stageStatus: 'pending',
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

    // Ownership released: resolve the conflict -> next startup succeeds. The
    // loser's subject must become terminal first, because an ACTIVE subject
    // with a terminal Admission is (correctly) still fail-closed.
    const store = new SqliteStore(root);
    try {
      store.getDatabase().prepare(
        "UPDATE runs SET status = 'cancelled', cancellation_requested_at = ?, completed_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ?",
      ).run('2026-07-25T00:00:03.000Z', '2026-07-25T00:00:03.000Z', '2026-07-25T00:00:03.000Z', 'ws-i07', 'run-b');
      store.getDatabase().prepare(
        "UPDATE workspace_admissions SET state = 'RELEASED', release_reason = 'RUN_TERMINAL', released_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ?",
      ).run('2026-07-25T00:00:03.000Z', '2026-07-25T00:00:03.000Z', 'ws-i07', 'grant-b');
    } finally {
      store.close();
    }
    const port2 = await freePort();
    restarted = spawnServer(root, port2);
    await waitForHealthy(port2, HEALTH_TIMEOUT_MS, restarted.output);
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

// ---------------------------------------------------------------------------
// Real recovery -> L1E ordering. These tests seed a genuine pre-restart
// canonical Run graph (run + snapshot + stage + run.start Operation, plus a
// durable Process when a process-missing classification is required) and then
// let the PRODUCTION startup path run: ownership -> store/migrations ->
// process preflight -> existing recovery -> L1E -> listen.
// ---------------------------------------------------------------------------

interface CanonicalFixture {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly stageId: string;
}

/**
 * A PID that is provably absent: run a child to completion, reuse its PID, and
 * assert the OS reports ESRCH. This keeps the process-missing proof real (no
 * stubbed verifier) while staying deterministic.
 */
function provablyAbsentPid(): number {
  const child = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
  assert.ok(typeof child.pid === 'number' && child.pid > 0, 'child pid must be observable');
  const pid = child.pid as number;
  assert.throws(
    () => process.kill(pid, 0),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH',
    'the reused child pid must be provably absent before it is persisted',
  );
  return pid;
}

/**
 * Seed a canonical Run graph that reaches production recovery with the given
 * pre-restart shape. `nativePid` additionally seeds the durable root Process
 * with a provider session so the P6-M2b preflight can classify it.
 */
function seedCanonicalRun(
  root: string,
  workspaceId: string,
  opts: {
    readonly runId: string;
    readonly runStatus: 'queued' | 'starting' | 'running';
    readonly stageStatus: 'pending' | 'starting' | 'running';
    readonly startStatus: 'queued' | 'running' | 'completed';
    readonly nativePid?: number;
  },
): CanonicalFixture {
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
    // saveWorkspaces materializes the agent profiles and provider
    // configurations that the provider_sessions / runtime_processes FKs need.
    store.saveWorkspaces([workspace]);
    const db = store.getDatabase();
    const profile = db.prepare(
      'SELECT id, provider_config_id FROM agent_profiles WHERE workspace_id = ? ORDER BY id ASC LIMIT 1',
    ).get(workspaceId) as { id: string; provider_config_id: string };

    const taskId = opts.runId + '-task';
    const stageId = opts.runId + '-stage';
    const snapshotId = opts.runId + '-snapshot';
    // Operations enforce canonical op_<ULID> identity, so use the real generator.
    const operationId = createEntityId('operation');
    // Recovery's entered-state vocabulary excludes 'starting': a Run/Stage that
    // was still starting has no started_at yet.
    const entered = opts.runStatus === 'running';
    const stageEntered = opts.stageStatus === 'running';

    db.prepare(
      "INSERT INTO tasks (id, workspace_id, title, status, priority, created_by, created_at, updated_at) VALUES (?, ?, 't', 'open', 'normal', 'test', ?, ?)",
    ).run(taskId, workspaceId, now, now);
    db.prepare(
      "INSERT INTO runs (id, workspace_id, task_id, parent_run_id, root_run_id, status, reason, origin, objective, failure_code, failure_message, cancellation_requested_at, next_event_sequence, started_at, completed_at, created_by, created_at, updated_at, version, recovery_required) VALUES (?, ?, ?, NULL, ?, ?, 'initial', 'v2_api', NULL, NULL, NULL, NULL, 1, ?, NULL, 'test', ?, ?, 1, 0)",
    ).run(opts.runId, workspaceId, taskId, opts.runId, opts.runStatus, entered ? now : null, now, now);
    db.prepare(
      "INSERT INTO run_snapshots (id, workspace_id, run_id, workflow_definition_id, snapshot_schema_version, snapshot_json, content_hash, redaction_applied, captured_at) VALUES (?, ?, ?, 'workflow_00000000000000000000000002', 1, '{}', ?, 0, ?)",
    ).run(snapshotId, workspaceId, opts.runId, '0'.repeat(64), now);
    db.prepare(
      "INSERT INTO run_stages (id, workspace_id, run_id, run_snapshot_id, workflow_stage_key, name, sequence, attempt, status, failure_code, failure_message, started_at, completed_at, created_at, updated_at, version) VALUES (?, ?, ?, ?, 'stage_one', 'stage_one', 1, 1, ?, NULL, NULL, ?, NULL, ?, ?, 1)",
    ).run(stageId, workspaceId, opts.runId, snapshotId, opts.stageStatus, stageEntered ? now : null, now, now);
    db.prepare(
      "INSERT INTO operations (id, type, status, workspace_id, aggregate_type, aggregate_id, run_id, correlation_id, result_json, error_json, created_at, started_at, completed_at, updated_at, version) VALUES (?, 'run.start', ?, ?, 'run', ?, ?, ?, NULL, NULL, ?, ?, ?, ?, 1)",
    ).run(operationId, opts.startStatus, workspaceId, opts.runId, opts.runId, operationId, now,
      opts.startStatus === 'queued' ? null : now,
      opts.startStatus === 'completed' ? now : null, now);

    if (opts.nativePid !== undefined) {
      const sessionId = 'psess_' + 'B'.repeat(26);
      db.prepare(
        "INSERT INTO provider_sessions (id, workspace_id, task_id, run_id, stage_id, stage_attempt, authority_role, agent_id, provider_config_id, provider_config_version, provider_type, adapter_id, adapter_version, config_schema_version, runtime_mode, status, claim_epoch, capabilities_json, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 'primary-provider', ?, ?, 1, 'kimicode', 'adapter.cli', '1.0.0', 1, 'cli', 'starting', 1, '{}', 1, ?, ?)",
      ).run(sessionId, workspaceId, taskId, opts.runId, stageId, profile.id, profile.provider_config_id, now, now);
      const tokenHash = 'c'.repeat(64);
      db.prepare(
        "INSERT INTO runtime_processes (id, workspace_id, task_id, run_id, stage_id, stage_attempt, provider_session_id, parent_process_id, authority_role, claim_epoch, process_type, platform, status, executable_resolved, args_redacted_json, cwd_resolved, shell, detached, stdin_mode, stdout_mode, stderr_mode, timeout_policy_json, security_profile_ref, native_pid, native_started_at, recovery_token_hash, recovery_evidence_json, started_at, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, NULL, 'primary-provider', 1, 'provider', ?, 'running', 'node', '[]', ?, 0, 0, 'closed', 'capture', 'capture', '{}', 'secprofile_default', ?, ?, ?, ?, ?, 1, ?, ?)",
      ).run(
        'proc_' + 'D'.repeat(26), workspaceId, taskId, opts.runId, stageId, sessionId,
        process.platform, root, opts.nativePid, now, tokenHash,
        JSON.stringify({
          schemaVersion: 2,
          nativePid: opts.nativePid,
          nativeStartedAt: now,
          nativeBirthIdentity: null,
          recoveryTokenHash: tokenHash,
          platform: process.platform,
        }),
        now, now, now,
      );
    }
    return { workspaceId, taskId, runId: opts.runId, stageId };
  } finally {
    store.close();
  }
}

function readRun(
  root: string,
  workspaceId: string,
  runId: string,
): { status: string; failure_code: string | null } {
  const store = new SqliteStore(root);
  try {
    return store.getDatabase().prepare(
      'SELECT status, failure_code FROM runs WHERE workspace_id = ? AND id = ?',
    ).get(workspaceId, runId) as { status: string; failure_code: string | null };
  } finally {
    store.close();
  }
}

// L1E-I02: canonical starting + missing Admission -> existing recovery makes the
// Run terminal -> L1E creates NO Admission.
test('L1E-I02 starting Run is recovery-terminal and gets no Admission', { timeout: 240_000 }, async () => {
  const root = makeTempRoot('i02');
  seedWorkspaceGraph(root, 'ws-i02');
  const fixture = seedCanonicalRun(root, 'ws-i02', {
    runId: 'run-starting', runStatus: 'starting', stageStatus: 'starting', startStatus: 'running',
  });
  const port = await freePort();
  const server = spawnServer(root, port);
  try {
    await waitForHealthy(port, HEALTH_TIMEOUT_MS, server.output);
    const run = readRun(root, fixture.workspaceId, fixture.runId);
    assert.equal(run.status, 'failed', 'production recovery terminalizes the interrupted startup');
    assert.equal(run.failure_code, 'RUN_STARTUP_INTERRUPTED');
    assert.equal(admissionCountAll(root), 0,
      'L1E must not fabricate an Admission for a recovery-terminal subject');
  } finally {
    await stopServer(server);
    rmSync(root, { recursive: true, force: true });
  }
});

// L1E-I03: canonical running + durable Process whose native PID is provably gone
// -> P6-M2b recovery terminalizes with RUN_PROCESS_MISSING -> no Admission.
test('L1E-I03 running Run with missing Process is recovery-terminal and gets no Admission', { timeout: 240_000 }, async () => {
  const root = makeTempRoot('i03');
  seedWorkspaceGraph(root, 'ws-i03');
  const absentPid = provablyAbsentPid();
  const fixture = seedCanonicalRun(root, 'ws-i03', {
    runId: 'run-missing', runStatus: 'running', stageStatus: 'running',
    startStatus: 'completed', nativePid: absentPid,
  });
  const port = await freePort();
  const server = spawnServer(root, port);
  try {
    await waitForHealthy(port);
    const run = readRun(root, fixture.workspaceId, fixture.runId);
    assert.equal(run.status, 'failed', 'a proven-missing process reconciles to a terminal failure');
    assert.equal(run.failure_code, 'RUN_PROCESS_MISSING');
    assert.equal(admissionCountAll(root), 0,
      'L1E must not fabricate an Admission for a recovery-terminal subject');
  } finally {
    await stopServer(server);
    rmSync(root, { recursive: true, force: true });
  }
});

// L1E-I05: canonical queued survivor -> recovery restores the queue -> L1E
// bootstraps -> L1D advances to a single GRANTED MODIFYING holder.
test('L1E-I05 queued survivor is bootstrapped then advanced by L1D', { timeout: 240_000 }, async () => {
  const root = makeTempRoot('i05');
  seedWorkspaceGraph(root, 'ws-i05');
  const fixture = seedCanonicalRun(root, 'ws-i05', {
    runId: 'run-queued', runStatus: 'queued', stageStatus: 'pending', startStatus: 'queued',
  });
  const port = await freePort();
  const server = spawnServer(root, port);
  try {
    await waitForHealthy(port);
    const run = readRun(root, fixture.workspaceId, fixture.runId);
    assert.equal(run.status, 'queued', 'queue-restore leaves the Run queued for L1E');
    const rows = readAdmissions(root, fixture.workspaceId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].canonicalRunId, fixture.runId);
    assert.equal(rows[0].state, 'GRANTED');
    assert.equal(rows[0].effectiveMutationClass, 'MODIFYING');
    assert.equal(rows[0].requestOrder, 1);
  } finally {
    await stopServer(server);
    rmSync(root, { recursive: true, force: true });
  }
});

// L1E-I06: a surviving executing holder keeps the Workspace, and a queued
// follower stays QUEUED behind it. Under the frozen recovery contract the
// reachable survivor is a running Run whose Process cannot be proven gone:
// recovery marks uncertainty (recovery_required = 1) and leaves the Run
// active, which is exactly the holder L1E must then bootstrap as GRANTED.
test('L1E-I06 surviving executing holder keeps the Workspace and blocks the follower', { timeout: 240_000 }, async () => {
  const root = makeTempRoot('i06');
  seedWorkspaceGraph(root, 'ws-i06');
  const holder = seedCanonicalRun(root, 'ws-i06', {
    runId: 'run-holder', runStatus: 'running', stageStatus: 'running',
    startStatus: 'completed',
  });
  const follower = seedCanonicalRun(root, 'ws-i06', {
    runId: 'run-follower', runStatus: 'queued', stageStatus: 'pending', startStatus: 'queued',
  });
  const port = await freePort();
  const server = spawnServer(root, port);
  try {
    await waitForHealthy(port, HEALTH_TIMEOUT_MS, server.output);
    const holderRun = readRun(root, holder.workspaceId, holder.runId);
    assert.equal(holderRun.status, 'running',
      'an unprovable Process leaves the running Run active (uncertainty, never a terminal guess)');
    const rows = readAdmissions(root, follower.workspaceId);
    assert.equal(rows.length, 2);
    const holderRow = rows.find(row => row.canonicalRunId === holder.runId);
    const followerRow = rows.find(row => row.canonicalRunId === follower.runId);
    assert.ok(holderRow !== undefined && followerRow !== undefined);
    assert.equal(holderRow.state, 'GRANTED', 'the surviving executing holder keeps the Workspace');
    assert.equal(followerRow.state, 'QUEUED', 'the follower must not co-hold a modifying Workspace');
    assert.equal(followerRow.queueReason, 'WAITING_FOR_WORKSPACE_ADMISSION');
    assert.ok(holderRow.requestOrder < followerRow.requestOrder);
  } finally {
    await stopServer(server);
    rmSync(root, { recursive: true, force: true });
  }
});

// L1E-I15: legacy active runs are terminalized by the frozen legacy recovery,
// so L1E never fabricates an active Admission for them.
test('L1E-I15 legacy active run is recovery-terminal and gets no Admission', { timeout: 240_000 }, async () => {
  const root = makeTempRoot('i15');
  seedWorkspaceGraph(root, 'ws-i15');
  const store = new SqliteStore(root);
  try {
    const now = '2026-07-25T00:00:00.000Z';
    const db = store.getDatabase();
    db.prepare("INSERT INTO conversations (id, workspace_id, conversation_type, title, created_at, updated_at) VALUES ('conv-l', ?, 'direct', 'c', ?, ?)")
      .run('ws-i15', now, now);
    db.prepare("INSERT INTO messages (id, conversation_id, workspace_id, sender_type, content, created_at) VALUES ('msg-l', 'conv-l', ?, 'user', 'm', ?)")
      .run('ws-i15', now);
    db.prepare("INSERT INTO agent_runs (id, workspace_id, conversation_id, source_message_id, objective, status, created_at, updated_at) VALUES ('legacy-active', ?, 'conv-l', 'msg-l', 'o', 'running', ?, ?)")
      .run('ws-i15', now, now);
  } finally {
    store.close();
  }
  const port = await freePort();
  const server = spawnServer(root, port);
  try {
    await waitForHealthy(port);
    const store2 = new SqliteStore(root);
    try {
      const legacy = store2.getDatabase().prepare(
        'SELECT status FROM agent_runs WHERE workspace_id = ? AND id = ?',
      ).get('ws-i15', 'legacy-active') as { status: string };
      assert.notEqual(legacy.status, 'running', 'frozen legacy recovery terminalizes active agent_runs');
    } finally {
      store2.close();
    }
    assert.equal(admissionCountAll(root), 0,
      'L1E must not fabricate an active Admission for a legacy recovery-terminal subject');
  } finally {
    await stopServer(server);
    rmSync(root, { recursive: true, force: true });
  }
});

// L1E-I16: HIGH-1 crash window proven with a REAL process death between the
// bootstrap COMMIT and L1D advancement, then reconverged by the next startup.
test('L1E-I16 crash after bootstrap commit is reconverged by the next startup', { timeout: 300_000 }, async () => {
  const root = makeTempRoot('i16');
  seedWorkspaceGraph(root, 'ws-i16');
  const fixture = seedCanonicalRun(root, 'ws-i16', {
    runId: 'run-crash', runStatus: 'queued', stageStatus: 'pending', startStatus: 'queued',
  });

  const port = await freePort();
  const crashed = spawnServer(root, port, {
    AGENTOS_TEST_FAIL_AFTER_L1E_BOOTSTRAP_BEFORE_ADVANCE: 'true',
  });
  try {
    const exit = await waitForExit(crashed.child);
    assert.notEqual(exit.code, 0, 'the injected crash must abort startup');
    assert.ok(
      crashed.output().includes('[AgentOS Server] startup failed: STARTUP_ADMISSION_RECONCILIATION_FAILED'),
      'the crash reports the stable sanitized code; got: ' + crashed.output(),
    );
    // Durable proof: the bootstrap COMMIT survived the process death.
    const afterCrash = readAdmissions(root, fixture.workspaceId);
    assert.equal(afterCrash.length, 1);
    assert.equal(afterCrash[0].state, 'QUEUED');
    assert.equal(afterCrash[0].requestOrder, 1);
    assert.equal(afterCrash[0].version, 1);
    const crashedAdmissionId = afterCrash[0].id;

    const port2 = await freePort();
    const restarted = spawnServer(root, port2);
    try {
      await waitForHealthy(port2);
      const afterRestart = readAdmissions(root, fixture.workspaceId);
      assert.equal(afterRestart.length, 1, 'restart must not duplicate the Admission');
      assert.equal(afterRestart[0].id, crashedAdmissionId, 'the same Admission converges in place');
      assert.equal(afterRestart[0].requestOrder, 1, 'request_order is unchanged across the crash');
      assert.equal(afterRestart[0].state, 'GRANTED', 'the durable pending row is advanced on restart');
    } finally {
      await stopServer(restarted);
    }
  } finally {
    killServer(crashed);
    rmSync(root, { recursive: true, force: true });
  }
});

// L1E-I17: HIGH-2 terminal GRANTED release proven end to end on a real
// production startup, including follower advancement and restart idempotency.
test('L1E-I17 terminal GRANTED holder is released and the follower advances', { timeout: 240_000 }, async () => {
  const root = makeTempRoot('i17');
  seedWorkspaceGraph(root, 'ws-i17');
  const holder = seedCanonicalRun(root, 'ws-i17', {
    runId: 'run-done', runStatus: 'running', stageStatus: 'running', startStatus: 'completed',
  });
  const store = new SqliteStore(root);
  try {
    // Terminalize the holder and bind a durable GRANTED Admission to it, plus a
    // queued follower waiting behind the phantom holder.
    const db = store.getDatabase();
    db.prepare(
      "UPDATE runs SET status = 'completed', started_at = '2026-07-25T00:00:01.000Z', completed_at = '2026-07-25T00:00:02.000Z' WHERE workspace_id = ? AND id = ?",
    ).run(holder.workspaceId, holder.runId);
    db.prepare(
      "INSERT INTO tasks (id, workspace_id, title, status, priority, created_by, created_at, updated_at) VALUES ('run-next-task', ?, 't', 'open', 'normal', 'test', '2026-07-25T00:00:00.000Z', '2026-07-25T00:00:00.000Z')",
    ).run('ws-i17');
    db.prepare(
      "INSERT INTO runs (id, workspace_id, task_id, parent_run_id, root_run_id, status, reason, origin, objective, failure_code, failure_message, cancellation_requested_at, next_event_sequence, started_at, completed_at, created_by, created_at, updated_at, version, recovery_required) VALUES ('run-next', ?, 'run-next-task', NULL, 'run-next', 'queued', 'initial', 'v2_api', NULL, NULL, NULL, NULL, 1, NULL, NULL, 'test', '2026-07-25T00:00:03.000Z', '2026-07-25T00:00:03.000Z', 1, 0)",
    ).run('ws-i17');
    const repo = new WorkspaceAdmissionRepository(db);
    repo.insertAdmission({
      id: 'grant-holder', workspaceId: 'ws-i17', subjectKind: 'CANONICAL_RUN',
      canonicalRunId: holder.runId, legacyRunId: null,
      requestedMutationClass: 'MODIFYING', effectiveMutationClass: 'MODIFYING',
      enforcementEvidenceJson: null, requestOrder: 1, state: 'GRANTED',
      queueReason: null, releaseReason: null,
      requestedAt: '2026-07-25T00:00:01.000Z', grantedAt: '2026-07-25T00:00:01.000Z', releasedAt: null,
      createdAt: '2026-07-25T00:00:01.000Z', updatedAt: '2026-07-25T00:00:01.000Z', version: 1,
    });
    repo.insertAdmission({
      id: 'grant-follower', workspaceId: 'ws-i17', subjectKind: 'CANONICAL_RUN',
      canonicalRunId: 'run-next', legacyRunId: null,
      requestedMutationClass: 'MODIFYING', effectiveMutationClass: 'MODIFYING',
      enforcementEvidenceJson: null, requestOrder: 2, state: 'QUEUED',
      queueReason: 'WAITING_FOR_WORKSPACE_ADMISSION', releaseReason: null,
      requestedAt: '2026-07-25T00:00:03.000Z', grantedAt: null, releasedAt: null,
      createdAt: '2026-07-25T00:00:03.000Z', updatedAt: '2026-07-25T00:00:03.000Z', version: 1,
    });
  } finally {
    store.close();
  }

  const port = await freePort();
  const server = spawnServer(root, port);
  try {
    await waitForHealthy(port);
    const rows = readAdmissions(root, 'ws-i17');
    assert.equal(rows.length, 2);
    const holderRow = rows.find(row => row.id === 'grant-holder');
    const followerRow = rows.find(row => row.id === 'grant-follower');
    assert.ok(holderRow !== undefined && followerRow !== undefined);
    assert.equal(holderRow.state, 'RELEASED');
    assert.equal(holderRow.releaseReason, 'RUN_TERMINAL');
    assert.ok(holderRow.releasedAt !== null);
    assert.equal(followerRow.state, 'GRANTED', 'the follower advances once the phantom holder is released');
    const snapshot = rows.map(row => ({ id: row.id, state: row.state, order: row.requestOrder, version: row.version }));
    await stopServer(server);

    const port2 = await freePort();
    const second = spawnServer(root, port2);
    try {
      await waitForHealthy(port2);
      const rows2 = readAdmissions(root, 'ws-i17');
      assert.deepEqual(
        rows2.map(row => ({ id: row.id, state: row.state, order: row.requestOrder, version: row.version })),
        snapshot,
        'restart performs no repeated release and no unjustified version churn',
      );
    } finally {
      await stopServer(second);
    }
  } finally {
    killServer(server);
    rmSync(root, { recursive: true, force: true });
  }
});
