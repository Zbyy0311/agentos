import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RuntimeEventContextAuthoritySourceV1 } from '@agentos/shared';
import { MigrationRegistry } from '../migrations/registry.js';
import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import { createFileBackupProvider } from '../migrations/backup.js';
import type { MinimalDatabaseSync } from '../migrations/types.js';
import type { TransactionDatabase } from '../store/Transaction.js';
import { MemoryCandidateRepository } from '../store/MemoryCandidateRepository.js';
import { RunRepository } from '../store/RunRepository.js';
import { RunStageRepository } from '../store/RunStageRepository.js';
import { TaskRepository } from '../store/TaskRepository.js';
import { M3_013_LEGACY_WORKFLOW_V2_ID } from '../migrations/migrations/013-workflow-creation-metadata-v2.js';
import { MemoryCandidateGenerationService } from './MemoryCandidateGenerationService.js';
import { TerminalMemoryCandidateReconciler, terminalCandidateId } from './TerminalMemoryCandidateReconciler.js';

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}
interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  close(): void;
}
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => SqliteDb;
};

const NOW = '2026-09-12T00:00:00.000Z';
const WS = 'ws_terminal';
const OTHER_WS = 'ws_terminal_other';
/** `tasks.id` is globally unique, so each Workspace carries its own Task. */
function taskIdFor(workspaceId: string): string {
  return workspaceId === WS ? 'task_terminal' : 'task_terminal_other';
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentos-terminal-reconcile-'));
  const db = new DatabaseSync(join(root, 'agentos.sqlite'));
  db.prepare('PRAGMA foreign_keys = ON').run();
  new MigrationRunner(
    db as unknown as MinimalDatabaseSync,
    new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS),
    { backupProvider: createFileBackupProvider(join(root, 'backup')) },
  ).run();
  const tdb = db as unknown as TransactionDatabase;
  for (const workspace of [WS, OTHER_WS]) {
    db.prepare(
      'INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(workspace, workspace, 'C:/tmp/' + workspace, 'C:/tmp/' + workspace, NOW, NOW, NOW);
    db.prepare(
      'INSERT INTO tasks (id, workspace_id, title, status, created_by, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
    ).run(taskIdFor(workspace), workspace, '修复登录页样式', 'open', 'test', NOW, NOW);
  }
  return { db, tdb, root, close: () => { try { db.close(); } finally { rmSync(root, { recursive: true, force: true }); } } };
}

function seedRun(
  fx: ReturnType<typeof fixture>,
  input: { runId: string; status: string; workspaceId?: string; withEvent?: boolean; failureCode?: string },
): void {
  const workspaceId = input.workspaceId ?? WS;
  const taskId = taskIdFor(workspaceId);
  fx.db.prepare(
    'INSERT INTO runs (id, workspace_id, task_id, root_run_id, status, reason, origin, failure_code, created_by, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
  ).run(input.runId, workspaceId, taskId, input.runId, input.status, 'initial', 'v2_api', input.failureCode ?? null, 'test', NOW, NOW);
  fx.db.prepare(
    'INSERT INTO run_snapshots (id, workspace_id, run_id, workflow_definition_id, snapshot_schema_version, snapshot_json, content_hash, redaction_applied, captured_at) VALUES (?, ?, ?, ?, 2, ?, ?, 0, ?)',
  ).run('snap_' + input.runId, workspaceId, input.runId, M3_013_LEGACY_WORKFLOW_V2_ID, JSON.stringify({ schemaVersion: 2 }), '0'.repeat(64), NOW);
  fx.db.prepare(
    'INSERT INTO run_stages (id, workspace_id, run_id, run_snapshot_id, workflow_stage_key, name, sequence, attempt, status, started_at, completed_at, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
  ).run('stage_' + input.runId, workspaceId, input.runId, 'snap_' + input.runId, 'implement', 'implement', 1, 1,
    input.status === 'running' ? 'running' : 'failed', NOW, NOW, NOW, NOW);
  if (input.withEvent !== false) {
    const terminalType = input.status === 'completed' ? 'run.completed'
      : input.status === 'cancelled' ? 'run.cancelled' : 'run.failed';
    fx.db.prepare(
      'INSERT INTO runtime_events (id, schema_version, type, workspace_id, task_id, run_id, stage_id, sequence, timestamp, source, correlation_id, causation_id, severity, visibility, durability, payload_json, created_at) VALUES (?, 1, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'evt_' + input.runId, terminalType, workspaceId, taskId, input.runId, 'stage_' + input.runId,
      NOW, 'run-engine', 'corr_' + input.runId, null, 'info', 'workspace', 'durable', '{}', NOW,
    );
  }
}

function realGenerator(fx: ReturnType<typeof fixture>): MemoryCandidateGenerationService {
  return new MemoryCandidateGenerationService({
    store: { getDatabase: () => fx.tdb },
    runs: new RunRepository(fx.tdb as never),
    stages: new RunStageRepository(fx.tdb as never),
    tasks: new TaskRepository(fx.tdb as never),
  });
}

interface RecordedCall {
  readonly workspaceId: string;
  readonly runId: string;
  readonly eventContext?: RuntimeEventContextAuthoritySourceV1;
}

function recordingGenerator(calls: RecordedCall[], overrides: Record<string, { outcome: string }> = {}) {
  return {
    generateForRunTerminal(input: RecordedCall): { outcome: string } {
      calls.push(input);
      return overrides[input.runId] ?? { outcome: 'created' };
    },
  };
}

// LITE-07-102: a terminal Run that lost its Candidate to a crash is repaired
// from its own persisted terminal Event, and a repeated sweep is a no-op.
test('LITE-07-102 restart sweep creates the missing Candidate through the real generator once', () => {
  const fx = fixture();
  try {
    seedRun(fx, { runId: 'run_failed', status: 'failed', failureCode: 'PROVIDER_SESSION_FAILED' });
    const reconciler = new TerminalMemoryCandidateReconciler({
      store: { getDatabase: () => fx.tdb },
      generator: realGenerator(fx),
      now: () => NOW,
    });
    const first = reconciler.reconcileWorkspace(WS);
    assert.deepEqual(first, {
      workspaces: 1, terminalRuns: 1, generated: 1, existing: 0, missingAuthority: 0, unresolved: 0,
    });
    const candidates = new MemoryCandidateRepository(fx.tdb);
    const created = candidates.findCandidateById(WS, terminalCandidateId('run_failed'));
    assert.ok(created !== undefined);
    assert.equal(created.category, 'failure');
    assert.equal(candidates.listCandidates(WS).length, 1);

    const second = reconciler.reconcileWorkspace(WS);
    assert.deepEqual(second, {
      workspaces: 1, terminalRuns: 1, generated: 0, existing: 1, missingAuthority: 0, unresolved: 0,
    });
    assert.equal(candidates.listCandidates(WS).length, 1);
  } finally { fx.close(); }
});

// The authority is the Run's own terminal Event, never a caller-supplied value.
test('LITE-07-102 sweep proves causation from the persisted terminal Event', () => {
  const fx = fixture();
  try {
    seedRun(fx, { runId: 'run_done', status: 'completed' });
    seedRun(fx, { runId: 'run_running', status: 'running', withEvent: false });
    const calls: RecordedCall[] = [];
    const reconciler = new TerminalMemoryCandidateReconciler({
      store: { getDatabase: () => fx.tdb },
      generator: recordingGenerator(calls),
      now: () => NOW,
    });
    const outcome = reconciler.reconcileWorkspace(WS);
    // Only the terminal Run is considered; a running Run is never touched.
    assert.equal(outcome.terminalRuns, 1);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      workspaceId: WS,
      runId: 'run_done',
      createdAt: NOW,
      eventContext: {
        origin: 'persisted_event',
        eventId: 'evt_run_done',
        context: { correlationId: 'corr_run_done', causationId: 'evt_run_done' },
      },
    });
  } finally { fx.close(); }
});

// Fail closed: without a durable terminal Event there is no causation to prove,
// so the sweep reports and skips instead of inventing one.
test('LITE-07-102 a terminal Run without a terminal Event is reported, never fabricated', () => {
  const fx = fixture();
  try {
    seedRun(fx, { runId: 'run_no_event', status: 'failed', withEvent: false });
    const calls: RecordedCall[] = [];
    const problems: string[] = [];
    const reconciler = new TerminalMemoryCandidateReconciler({
      store: { getDatabase: () => fx.tdb },
      generator: recordingGenerator(calls),
      onProblem: detail => problems.push(detail),
    });
    const outcome = reconciler.reconcileWorkspace(WS);
    assert.deepEqual(outcome, {
      workspaces: 1, terminalRuns: 1, generated: 0, existing: 0, missingAuthority: 1, unresolved: 0,
    });
    assert.equal(calls.length, 0);
    assert.equal(new MemoryCandidateRepository(fx.tdb).listCandidates(WS).length, 0);
    assert.deepEqual(problems, ['TERMINAL_CANDIDATE_NO_AUTHORITY run=run_no_event workspace=ws_terminal']);
  } finally { fx.close(); }
});

// A failing generator is contained: the sweep reports it and still repairs the
// next Run in the same pass.
test('LITE-07-102 a failing generator is contained and the sweep continues', () => {
  const fx = fixture();
  try {
    seedRun(fx, { runId: 'run_a_first', status: 'failed' });
    seedRun(fx, { runId: 'run_b_second', status: 'completed' });
    const problems: string[] = [];
    const calls: RecordedCall[] = [];
    const reconciler = new TerminalMemoryCandidateReconciler({
      store: { getDatabase: () => fx.tdb },
      generator: {
        generateForRunTerminal(input: RecordedCall) {
          calls.push(input);
          if (input.runId === 'run_a_first') throw new Error('boom');
          return { outcome: 'created' };
        },
      },
      onProblem: detail => problems.push(detail),
    });
    const outcome = reconciler.reconcileWorkspace(WS);
    assert.equal(outcome.terminalRuns, 2);
    assert.equal(outcome.generated, 1);
    assert.equal(outcome.unresolved, 1);
    assert.deepEqual(calls.map(call => call.runId), ['run_a_first', 'run_b_second']);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /^TERMINAL_CANDIDATE_FAILED run=run_a_first: boom$/u);
  } finally { fx.close(); }
});

// Startup covers every Workspace, and each Workspace's Runs stay in it.
test('LITE-07-102 startup sweep is bounded per Workspace', () => {
  const fx = fixture();
  try {
    seedRun(fx, { runId: 'run_ws_one', status: 'completed' });
    seedRun(fx, { runId: 'run_ws_two', status: 'cancelled', workspaceId: OTHER_WS });
    const calls: RecordedCall[] = [];
    const reconciler = new TerminalMemoryCandidateReconciler({
      store: { getDatabase: () => fx.tdb },
      generator: recordingGenerator(calls),
    });
    const outcome = reconciler.reconcileOnStartup();
    assert.equal(outcome.workspaces, 2);
    assert.equal(outcome.terminalRuns, 2);
    assert.equal(outcome.generated, 2);
    // Workspaces are visited in id order, and each Run stays in its own scope.
    assert.deepEqual(calls.map(call => [call.workspaceId, call.runId]), [
      [WS, 'run_ws_one'],
      [OTHER_WS, 'run_ws_two'],
    ]);
  } finally { fx.close(); }
});
