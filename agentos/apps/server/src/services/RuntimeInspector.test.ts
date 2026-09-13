import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createM3RuntimeEventRegistry } from '@agentos/shared';
import { MigrationRegistry } from '../migrations/registry.js';
import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import { createFileBackupProvider } from '../migrations/backup.js';
import type { MinimalDatabaseSync } from '../migrations/types.js';
import {
  M3_013_UNBOUND_DEFINITION_HASH,
  M3_013_UNBOUND_WORKFLOW_KEY,
  M3_013_UNBOUND_WORKFLOW_NAME,
  M3_013_UNBOUND_WORKFLOW_V2_ID,
} from '../migrations/migrations/013-workflow-creation-metadata-v2.js';
import type { TransactionDatabase } from '../store/Transaction.js';
import { RunRepository } from '../store/RunRepository.js';
import { RunStageRepository } from '../store/RunStageRepository.js';
import { RunSnapshotRepository } from '../store/RunSnapshotRepository.js';
import { RuntimeEventRepository } from '../store/RuntimeEventRepository.js';
import { MemoryContextSnapshotRepository } from '../store/MemoryContextSnapshotRepository.js';
import { RuntimeInspector, RuntimeInspectorError } from './RuntimeInspector.js';

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

const NOW = '2026-09-09T00:00:00.000Z';
const WS = 'ws_insp';
const TASK = 'task_insp';
const RUN = 'run_insp';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentos-inspector-'));
  const path = join(root, 'agentos.sqlite');
  const db = new DatabaseSync(path);
  db.prepare('PRAGMA foreign_keys = ON').run();
  new MigrationRunner(db as unknown as MinimalDatabaseSync, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS), {
    backupProvider: createFileBackupProvider(join(root, 'backup')),
  }).run();
  db.prepare(
    'INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(WS, WS, 'C:/tmp/ws_insp', 'C:/tmp/ws_insp', NOW, NOW, NOW);
  db.prepare(
    'INSERT INTO tasks (id, workspace_id, title, status, created_by, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
  ).run(TASK, WS, 'task', 'open', 'test', NOW, NOW);
  db.prepare(
    'INSERT INTO runs (id, workspace_id, task_id, root_run_id, status, reason, origin, created_by, created_at, updated_at, next_event_sequence, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)',
  ).run(RUN, WS, TASK, RUN, 'running', 'initial', 'v2_api', 'test', NOW, NOW);

  const tx = db as unknown as TransactionDatabase;
  const events = new RuntimeEventRepository(tx, createM3RuntimeEventRegistry());
  const inspector = new RuntimeInspector({
    store: { getDatabase: () => tx },
    runRepository: new RunRepository(tx),
    runStageRepository: new RunStageRepository(tx),
    runSnapshotRepository: new RunSnapshotRepository(tx),
    runtimeEventRepository: events,
    memoryContextSnapshots: new MemoryContextSnapshotRepository(tx),
  });
  return { db, tx, events, inspector, close: () => { try { db.close(); } finally { rmSync(root, { recursive: true, force: true }); } } };
}

function count(db: SqliteDb, sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...params) as { c: number }).c;
}

// INSP-01 — overview projects canonical Run state.
+// INSP-12 — LITE-13-002: Run, Stage, Provider, Process and duration are distinct.
test('INSP-12 Run, Stage, Provider, Process and duration stay distinct', () => {
  const fx = fixture();
  try {
    // A Stage, the Provider Session that owns its attempt, and the Process that
    // session spawned: three different durable records with three different ids.
    const snapshot = new RunSnapshotRepository(fx.tx).insert({
      workspaceId: WS,
      runId: RUN,
      workflowDefinitionId: M3_013_UNBOUND_WORKFLOW_V2_ID,
      payload: {
        schemaVersion: 2,
        capturedAt: NOW,
        run: { workspaceId: WS, taskId: TASK, origin: 'v2_api', reason: 'initial', parentRunId: null, rootRunId: RUN },
        workflow: {
          definitionId: M3_013_UNBOUND_WORKFLOW_V2_ID,
          definitionKey: M3_013_UNBOUND_WORKFLOW_KEY,
          definitionVersion: 2,
          name: M3_013_UNBOUND_WORKFLOW_NAME,
          definitionHash: M3_013_UNBOUND_DEFINITION_HASH,
          worktreeMode: 'disabled',
          stages: [],
        },
        security: { redactionApplied: false },
      } as never,
    });
    fx.db.prepare(
      "INSERT INTO run_stages (id, workspace_id, run_id, run_snapshot_id, workflow_stage_key, name, sequence, attempt, status, created_at, updated_at, version) VALUES ('stage_insp', ?, ?, ?, 'build', 'build', 1, 1, 'running', ?, ?, 1)",
    ).run(WS, RUN, snapshot.id, NOW, NOW);
    // Provider Sessions reference their Provider Configuration and Agent Profile,
    // so those parents are seeded the same way production creates them.
    fx.db.prepare(`INSERT INTO provider_configurations (
      id, workspace_id, name, provider_type, adapter_id, runtime_mode, executable,
      capabilities_json, timeout_policy_json, approval_mode, output_mode, enabled, version, created_at, updated_at
    ) VALUES ('pcfg_insp', ?, 'Inspector Codex', 'codex', 'builtin.codex', 'cli', 'codex.exe',
      '{}', '{}', 'disabled', 'structured', 1, 1, ?, ?)`)
      .run(WS, NOW, NOW);
    fx.db.prepare(`INSERT INTO agent_profiles (
      workspace_id, id, name, agent_role, role_title, system_prompt, permissions_json,
      enabled, cli_command, cli_args_json, created_at, updated_at
    ) VALUES (?, 'agent_codex', 'Codex', 'codex', 'Manager', 'prompt', '[]', 1, 'codex', '[]', ?, ?)`)
      .run(WS, NOW, NOW);
    fx.db.prepare(`INSERT INTO provider_sessions (
      id, workspace_id, task_id, run_id, stage_id, stage_attempt, authority_role, agent_id,
      provider_config_id, provider_config_version, provider_type, adapter_id, adapter_version,
      config_schema_version, runtime_mode, status, started_at, claim_epoch, capabilities_json, created_at, updated_at, version
    ) VALUES (?, ?, ?, ?, 'stage_insp', 1, 'primary-provider', 'agent_codex',
      'pcfg_insp', 1, 'codex', 'builtin.codex', '1.0.0', 1, 'cli', 'active', ?, 1, '{}', ?, ?, 1)`)
      .run('psess_' + 'A'.repeat(26), WS, TASK, RUN, NOW, NOW, NOW);
    fx.db.prepare(`INSERT INTO runtime_processes (
      id, workspace_id, task_id, run_id, stage_id, stage_attempt, provider_session_id,
      claim_epoch, process_type, platform, status, cwd_resolved, executable_resolved,
      args_redacted_json, shell, detached, stdin_mode, stdout_mode, stderr_mode,
      native_pid, native_started_at, started_at, timeout_policy_json, security_profile_ref, created_at, updated_at, version
    ) VALUES (?, ?, ?, ?, 'stage_insp', 1, ?, 1, 'provider', 'win32', 'running',
      'C:/tmp/ws_insp', 'codex.exe', '[]', 0, 0, 'closed', 'capture', 'capture',
      5123, ?, ?, '{}', 'default', ?, ?, 1)`)
      .run('proc_' + 'B'.repeat(26), WS, TASK, RUN, 'psess_' + 'A'.repeat(26), NOW, NOW, NOW, NOW);

    const projection = fx.inspector.inspect({ workspaceId: WS, runId: RUN });

    // Run, Stage and Task are three different identifiers.
    assert.equal(projection.overview.runId, RUN);
    assert.equal(projection.overview.taskId, TASK);
    assert.notEqual(projection.overview.runId, projection.overview.taskId);
    assert.equal(projection.stages.length, 1);
    assert.equal(projection.stages[0]!.stageId, 'stage_insp');

    // Provider is its own record, distinct from both the Process and the Stage.
    assert.equal(projection.providerSessions.length, 1);
    const session = projection.providerSessions[0]!;
    assert.equal(session.sessionId, 'psess_' + 'A'.repeat(26));
    assert.equal(session.stageId, 'stage_insp');
    assert.equal(session.adapterId, 'builtin.codex');
    assert.equal(session.adapterVersion, '1.0.0');
    assert.notEqual(session.sessionId, session.stageId);

    // Process names the Provider Session it belongs to, and its own id differs.
    assert.equal(projection.processes.length, 1);
    const process = projection.processes[0]!;
    assert.equal(process.processId, 'proc_' + 'B'.repeat(26));
    assert.equal(process.providerSessionId, session.sessionId);
    assert.notEqual(process.processId, process.providerSessionId);
    // The native PID is evidence-only and is not an AgentOS identity at all.
    assert.equal(process.nativePidEvidenceOnly, 5123);
    assert.notEqual(String(process.nativePidEvidenceOnly), process.processId);
    assert.notEqual(String(process.nativePidEvidenceOnly), process.providerSessionId);

    // Duration is derived from the Run's own timestamps, not from a Process.
    const started = '2026-09-09T00:00:00.000Z';
    const completed = '2026-09-09T00:00:02.500Z';
    fx.db.prepare('UPDATE runs SET started_at = ?, completed_at = ? WHERE id = ?').run(started, completed, RUN);
    const timed = fx.inspector.inspect({ workspaceId: WS, runId: RUN });
    assert.equal(timed.overview.durationMs, 2500);
    assert.equal(timed.overview.startedAt, started);
    assert.equal(timed.overview.completedAt, completed);
  } finally { fx.close(); }
});

test('INSP-01 overview projects canonical run state', () => {
  const fx = fixture();
  try {
    const projection = fx.inspector.inspect({ workspaceId: WS, runId: RUN });
    assert.equal(projection.overview.runId, RUN);
    assert.equal(projection.overview.taskId, TASK);
    assert.equal(projection.overview.status, 'running');
    assert.equal(projection.overview.rootRunId, RUN);
    assert.equal(projection.overview.parentRunId, null);
    assert.equal(projection.overview.version, 1);
  } finally { fx.close(); }
});

// INSP-02 — unknown Run fails closed.
test('INSP-02 unknown run fails closed', () => {
  const fx = fixture();
  try {
    assert.throws(
      () => fx.inspector.inspect({ workspaceId: WS, runId: 'run_missing' }),
      (error: unknown) => {
        assert.ok(error instanceof RuntimeInspectorError);
        assert.equal(error.code, 'RUN_NOT_FOUND');
        return true;
      },
    );
  } finally { fx.close(); }
});

// INSP-03 — invalid input fails closed.
test('INSP-03 invalid input fails closed', () => {
  const fx = fixture();
  try {
    assert.throws(() => fx.inspector.inspect({ workspaceId: '', runId: RUN }));
    assert.throws(() => fx.inspector.inspect({ workspaceId: WS, runId: RUN, afterSequence: -1 }));
    assert.throws(() => fx.inspector.inspect({ workspaceId: WS, runId: RUN, maxEvents: 0 }));
    assert.throws(() => fx.inspector.inspect({ workspaceId: WS, runId: RUN, maxEvents: 1001 }));
  } finally { fx.close(); }
});

// INSP-04 — process evidence is projected with PID labelled evidence-only.
test('INSP-04 process PID is evidence-only', () => {
  const fx = fixture();
  try {
    const processId = 'proc_' + '0'.repeat(26);
    fx.db.prepare(
      'INSERT INTO runtime_processes (id, workspace_id, task_id, run_id, status, process_type, platform, cwd_resolved, executable_resolved, args_redacted_json, shell, detached, stdin_mode, stdout_mode, stderr_mode, timeout_policy_json, security_profile_ref, native_pid, native_started_at, native_birth_identity, claim_epoch, started_at, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 1)',
    ).run(processId, WS, TASK, RUN, 'running', 'provider', 'win32', 'C:/ws', 'C:/kimi.exe', '["--flag"]', 'closed', 'capture', 'capture', '{}', 'default', 4242, NOW, 'win32:filetime:123', NOW, NOW, NOW);
    const projection = fx.inspector.inspect({ workspaceId: WS, runId: RUN });
    assert.equal(projection.processes.length, 1);
    assert.equal(projection.processes[0].processId, processId);
    assert.equal(projection.processes[0].nativePidEvidenceOnly, 4242);
    assert.equal(projection.processes[0].nativeBirthIdentity, 'win32:filetime:123');
    assert.ok(!('nativePid' in projection.processes[0]));
  } finally { fx.close(); }
});

// INSP-05 — events are strictly ordered and bounded, with a high watermark.
test('INSP-05 events are ordered and bounded', () => {
  const fx = fixture();
  try {
    for (let i = 0; i < 5; i += 1) {
      fx.events.appendWithinTransaction({
        id: 'evt_' + String(i + 1).padStart(26, '0'), schemaVersion: 1, type: 'run.queued', workspaceId: WS, runId: RUN,
        sequence: i + 1, timestamp: NOW, source: 'run-engine', correlationId: 'corr', causationId: 'cause',
        payload: { priority: 'normal', queueName: 'default' },
      });
    }
    const projection = fx.inspector.inspect({ workspaceId: WS, runId: RUN, maxEvents: 3 });
    assert.equal(projection.events.length, 3);
    assert.deepEqual(projection.events.map(e => e.sequence), [1, 2, 3]);
    assert.equal(projection.truncated, true);
    assert.equal(projection.highWatermark, 5);
    assert.ok(!('payload' in projection.events[0]));
  } finally { fx.close(); }
});

// INSP-06 — afterSequence filters and is reflected in the high watermark.
test('INSP-06 afterSequence cursor', () => {
  const fx = fixture();
  try {
    for (let i = 0; i < 4; i += 1) {
      fx.events.appendWithinTransaction({
        id: 'evt_' + String(i + 1).padStart(26, '0'), schemaVersion: 1, type: 'run.queued', workspaceId: WS, runId: RUN,
        sequence: i + 1, timestamp: NOW, source: 'run-engine', correlationId: 'corr', causationId: 'cause',
        payload: { priority: 'normal', queueName: 'default' },
      });
    }
    const projection = fx.inspector.inspect({ workspaceId: WS, runId: RUN, afterSequence: 2 });
    assert.deepEqual(projection.events.map(e => e.sequence), [3, 4]);
    assert.equal(projection.highWatermark, 4);
  } finally { fx.close(); }
});

// INSP-07 — the projection is read-only.
test('INSP-07 inspect performs no writes', () => {
  const fx = fixture();
  try {
    const before = count(fx.db, 'SELECT COUNT(*) AS c FROM runtime_events');
    fx.inspector.inspect({ workspaceId: WS, runId: RUN });
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM runtime_events'), before);
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM runs WHERE status = ?', 'running'), 1);
  } finally { fx.close(); }
});

// INSP-08 — memory context projects selection and exclusion reasons.
test('INSP-08 memory context projection', () => {
  const fx = fixture();
  try {
    fx.db.prepare(
      'INSERT INTO memory_context_snapshots (id, schema_version, workspace_id, run_id, query_hash, retrieval_strategy_version, budget_json, total_tokens, truncated, created_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?, 0, ?)',
    ).run('mctx_1', WS, RUN, 'qh', 'mf3-ranking-v1', '{"maxTokens":100}', 10, NOW);
    fx.db.prepare(
      'INSERT INTO memory_context_snapshot_entries (snapshot_id, memory_entry_id, memory_entry_version, selected, rank, score, scope, category, authority, confidence, importance, token_cost, reasons_json, source_refs_json, content_hash) VALUES (?, ?, 1, 1, 1, 9.5, ?, ?, ?, 0.9, 0.5, 10, ?, ?, NULL)',
    ).run('mctx_1', 'mem_1', 'task', 'decision', 'system-verified', '["scope-match"]', '[{"kind":"run","id":"source-run"}]');
    fx.db.prepare(
      'INSERT INTO memory_context_snapshot_entries (snapshot_id, memory_entry_id, memory_entry_version, selected, rank, score, scope, category, authority, confidence, importance, token_cost, reasons_json, source_refs_json, content_hash) VALUES (?, ?, 1, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, ?, \'[]\', NULL)',
    ).run('mctx_1', 'mem_2', '["below-confidence"]');
    const projection = fx.inspector.inspect({ workspaceId: WS, runId: RUN });
    assert.ok(projection.memoryContext !== null);
    assert.equal(projection.memoryContext?.memoryContextId, 'mctx_1');
    assert.equal(projection.memoryContext?.selected.length, 1);
    assert.equal(projection.memoryContext?.maxTokens, 100);
    assert.deepEqual(projection.memoryContext?.selected[0], {
      memoryId: 'mem_1', memoryVersion: 1, rank: 1, score: 9.5,
      scope: 'task', category: 'decision', authority: 'system-verified',
      confidence: 0.9, importance: 0.5, tokenCost: 10, reasons: ['scope-match'],
      sourceRefs: [{ kind: 'run', id: 'source-run' }],
    });
    assert.deepEqual(projection.memoryContext?.selected[0].reasons, ['scope-match']);
    assert.deepEqual(projection.memoryContext?.exclusions, [{ memoryId: 'mem_2', reason: 'below-confidence' }]);
  } finally { fx.close(); }
});

// INSP-09 — no memory context is null, not fabricated.
test('INSP-09 absent memory context is null', () => {
  const fx = fixture();
  try {
    const projection = fx.inspector.inspect({ workspaceId: WS, runId: RUN });
    assert.equal(projection.memoryContext, null);
  } finally { fx.close(); }
});

// INSP-10 — workspace isolation.
test('INSP-10 workspace isolation', () => {
  const fx = fixture();
  try {
    fx.db.prepare(
      'INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('ws_other', 'ws_other', 'C:/tmp/ws_other', 'C:/tmp/ws_other', NOW, NOW, NOW);
    assert.throws(
      () => fx.inspector.inspect({ workspaceId: 'ws_other', runId: RUN }),
      (error: unknown) => {
        assert.ok(error instanceof RuntimeInspectorError);
        assert.equal(error.code, 'RUN_NOT_FOUND');
        return true;
      },
    );
  } finally { fx.close(); }
});

// INSP-11 — stages are projected in deterministic sequence order.
test('INSP-11 stages are ordered', () => {
  const fx = fixture();
  try {
    // Migration 013 already seeds the unbound definition; reuse its id.
    const snapshot = new RunSnapshotRepository(fx.tx).insert({
      workspaceId: WS,
      runId: RUN,
      workflowDefinitionId: M3_013_UNBOUND_WORKFLOW_V2_ID,
      payload: {
        schemaVersion: 2,
        capturedAt: NOW,
        run: { workspaceId: WS, taskId: TASK, origin: 'v2_api', reason: 'initial', parentRunId: null, rootRunId: RUN },
        workflow: {
          definitionId: M3_013_UNBOUND_WORKFLOW_V2_ID,
          definitionKey: M3_013_UNBOUND_WORKFLOW_KEY,
          definitionVersion: 2,
          name: M3_013_UNBOUND_WORKFLOW_NAME,
          definitionHash: M3_013_UNBOUND_DEFINITION_HASH,
          worktreeMode: 'disabled',
          stages: [],
        },
        security: { redactionApplied: false },
      } as never,
    });
    for (const [index, key] of ['b', 'a'].entries()) {
      fx.db.prepare(
        'INSERT INTO run_stages (id, workspace_id, run_id, run_snapshot_id, workflow_stage_key, name, sequence, attempt, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 1)',
      ).run('stage_' + key, WS, RUN, snapshot.id, key, key, index + 1, 'pending', NOW, NOW);
    }
    const projection = fx.inspector.inspect({ workspaceId: WS, runId: RUN });
    assert.deepEqual(projection.stages.map(s => s.workflowStageKey), ['b', 'a']);
    assert.deepEqual(projection.stages.map(s => s.sequence), [1, 2]);
  } finally { fx.close(); }
});
