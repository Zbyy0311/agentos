import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MigrationRegistry } from '../migrations/registry.js';
import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import { createFileBackupProvider } from '../migrations/backup.js';
import type { MinimalDatabaseSync } from '../migrations/types.js';
import type { TransactionDatabase } from '../store/Transaction.js';
import { MemoryEntryRepository } from '../store/MemoryEntryRepository.js';
import type { CreateMemoryEntryInput } from '../store/MemoryEntryRepository.js';
import { MemoryCandidateRepository } from '../store/MemoryCandidateRepository.js';
import { RunRepository } from '../store/RunRepository.js';
import { RunStageRepository } from '../store/RunStageRepository.js';
import { TaskRepository } from '../store/TaskRepository.js';
import { RunSnapshotRepository } from '../store/RunSnapshotRepository.js';
import { M3_013_LEGACY_WORKFLOW_V2_ID } from '../migrations/migrations/013-workflow-creation-metadata-v2.js';
import {
  MemoryCandidateGenerationService,
  MemoryCandidateGenerationError,
  hashMemoryText,
  normalizeMemoryText,
} from './MemoryCandidateGenerationService.js';

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

const NOW = '2026-09-11T00:00:00.000Z';
const WS = 'ws_mf2rg';
const TASK = 'task_mf2rg';
const RUN = 'run_mf2rg';

function fixture(
  runStatus = 'completed',
  failure: { readonly code?: string; readonly message?: string } = {},
): {
  db: SqliteDb;
  service: MemoryCandidateGenerationService;
  candidates: MemoryCandidateRepository;
  entries: MemoryEntryRepository;
  close(): void;
} {
  const root = mkdtempSync(join(tmpdir(), 'agentos-mf2r-gen-'));
  const path = join(root, 'agentos.sqlite');
  const db = new DatabaseSync(path);
  db.prepare('PRAGMA foreign_keys = ON').run();
  new MigrationRunner(
    db as unknown as MinimalDatabaseSync,
    new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS),
    { backupProvider: createFileBackupProvider(join(root, 'backup')) },
  ).run();
  const tdb = db as unknown as TransactionDatabase;
  db.prepare(
    'INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(WS, WS, 'C:/tmp/ws_mf2rg', 'C:/tmp/ws_mf2rg', NOW, NOW, NOW);
  db.prepare(
    'INSERT INTO tasks (id, workspace_id, title, status, created_by, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
  ).run(TASK, WS, '修复登录页样式', 'open', 'test', NOW, NOW);
  db.prepare(
    'INSERT INTO runs (id, workspace_id, task_id, root_run_id, status, reason, origin, failure_code, failure_message, created_by, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
  ).run(RUN, WS, TASK, RUN, runStatus, 'initial', 'v2_api', failure.code ?? null, failure.message ?? null, 'test', NOW, NOW);
  // run_stages references run_snapshots(id, run_id); the snapshot row is pure
  // fixture plumbing here, so a raw insert is enough (no repo validation path
  // is under test).
  db.prepare(
    'INSERT INTO run_snapshots (id, workspace_id, run_id, workflow_definition_id, snapshot_schema_version, snapshot_json, content_hash, redaction_applied, captured_at)'
      + ' VALUES (?, ?, ?, ?, 2, ?, ?, 0, ?)',
  ).run('snap_mf2rg', WS, RUN, M3_013_LEGACY_WORKFLOW_V2_ID, JSON.stringify({ schemaVersion: 2 }), '0'.repeat(64), NOW);
  db.prepare(
    'INSERT INTO run_stages (id, workspace_id, run_id, run_snapshot_id, workflow_stage_key, name, sequence, attempt, status, started_at, completed_at, created_at, updated_at, version)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
  ).run('stage_mf2rg', WS, RUN, 'snap_mf2rg', 'implement', 'implement', 1, 1,
    runStatus === 'completed' ? 'completed' : 'running',
    NOW, runStatus === 'completed' ? '2026-09-11T00:01:00.000Z' : null, NOW, NOW);
  const candidates = new MemoryCandidateRepository(tdb);
  const entries = new MemoryEntryRepository(tdb);
  const service = new MemoryCandidateGenerationService({
    store: { getDatabase: () => tdb },
    runs: new RunRepository(tdb as never),
    stages: new RunStageRepository(tdb as never),
    tasks: new TaskRepository(tdb as never),
    candidates,
  });
  return { db, service, candidates, entries, close: () => { try { db.close(); } finally { rmSync(root, { recursive: true, force: true }); } } };
}

function generatedContent(): string {
  return [
    '任务：修复登录页样式',
    `结果：Run ${RUN} 完成（origin v2_api，reason initial）。`,
    'Stage 结果：implement: completed (attempt 1, duration 60000ms)',
  ].join('\n');
}

test('MF2R-G1 completed Run generates a review-required Candidate with bounded evidence', () => {
  const fx = fixture();
  try {
    const result = fx.service.generateForRunTerminal({ workspaceId: WS, runId: RUN, createdAt: NOW });
    assert.equal(result.outcome, 'created');
    const candidate = result.candidate!;
    assert.equal(candidate.id, `mcand_terminal_${RUN}`);
    assert.equal(candidate.outcome, 'review-required'); // agent-derived + conservative gate
    assert.equal(candidate.scope, 'task');
    assert.deepEqual(candidate.sources, [{ kind: 'run', id: RUN }]);
    assert.ok(candidate.title.includes('修复登录页样式'));
    assert.ok(candidate.content.includes('implement: completed'));
    assert.ok(!candidate.content.includes('raw-provider')); // bounded bundle only
    assert.ok(candidate.exactContentHash !== null && candidate.normalizedTextHash !== null);
  } finally { fx.close(); }
});

test('MF2R-G2 replay converges on the existing Candidate', () => {
  const fx = fixture();
  try {
    const first = fx.service.generateForRunTerminal({ workspaceId: WS, runId: RUN, createdAt: NOW });
    const second = fx.service.generateForRunTerminal({ workspaceId: WS, runId: RUN, createdAt: NOW });
    assert.equal(first.outcome, 'created');
    assert.equal(second.outcome, 'existing');
    assert.equal(second.candidate!.id, first.candidate!.id);
    assert.equal(fx.candidates.listCandidates(WS).length, 1);
  } finally { fx.close(); }
});

test('MF2R-G3 exact duplicate content converges with no new Candidate', () => {
  const fx = fixture();
  try {
    fx.entries.createEntry({
      id: 'mem_' + 'x'.repeat(26),
      workspaceId: WS,
      scope: 'task',
      ownerTaskId: TASK,
      category: 'summary',
      authority: 'system-verified',
      confidence: 0.9,
      importance: 0.5,
      title: 'earlier',
      content: 'earlier body',
      status: 'active',
      exactContentHash: hashMemoryText(generatedContent()),
      sources: [{ kind: 'run', id: RUN }],
      createdAt: NOW,
    });
    const result = fx.service.generateForRunTerminal({ workspaceId: WS, runId: RUN, createdAt: NOW });
    assert.equal(result.outcome, 'converged');
    assert.equal(result.duplicateOfEntryId, 'mem_' + 'x'.repeat(26));
    assert.equal(fx.candidates.listCandidates(WS).length, 0);
  } finally { fx.close(); }
});

test('MF2R-G4 normalized-hash near-duplicate forces review-required', () => {
  const fx = fixture();
  try {
    fx.entries.createEntry({
      id: 'mem_' + 'n'.repeat(26),
      workspaceId: WS,
      scope: 'task',
      ownerTaskId: TASK,
      category: 'summary',
      authority: 'system-verified',
      confidence: 0.9,
      importance: 0.5,
      title: 'earlier',
      content: 'earlier body',
      status: 'active',
      normalizedTextHash: hashMemoryText(normalizeMemoryText(generatedContent())),
      sources: [{ kind: 'run', id: RUN }],
      createdAt: NOW,
    });
    const result = fx.service.generateForRunTerminal({ workspaceId: WS, runId: RUN, createdAt: NOW });
    assert.equal(result.outcome, 'created');
    assert.equal(result.duplicateOfEntryId, 'mem_' + 'n'.repeat(26));
    assert.equal(result.candidate!.outcome, 'review-required');
  } finally { fx.close(); }
});

test('MF2R-G4b FTS-similar near-duplicate forces review-required', () => {
  const fx = fixture();
  try {
    fx.entries.createEntry({
      id: 'mem_' + 'f'.repeat(26),
      workspaceId: WS,
      scope: 'task',
      ownerTaskId: TASK,
      category: 'summary',
      authority: 'system-verified',
      confidence: 0.9,
      importance: 0.5,
      title: '执行结果：修复登录页样式',
      content: '完全不同的正文。',
      status: 'active',
      sources: [{ kind: 'run', id: RUN }],
      createdAt: NOW,
    });
    const result = fx.service.generateForRunTerminal({ workspaceId: WS, runId: RUN, createdAt: NOW });
    assert.equal(result.outcome, 'created');
    assert.equal(result.duplicateOfEntryId, 'mem_' + 'f'.repeat(26));
    assert.equal(result.candidate!.outcome, 'review-required');
  } finally { fx.close(); }
});

for (const [label, overrides] of [
  ['another task', { ownerTaskId: 'task_other' }],
  ['workspace scope', { scope: 'workspace', ownerTaskId: undefined }],
  ['another category', { category: 'decision' }],
  ['archived', { status: 'archived' }],
  ['deleted', { status: 'deleted' }],
] as const) {
  test(`LITE-07-003 LITE-07-107 terminal dedup ignores ${label}`, () => {
    const fx = fixture();
    try {
      fx.db.prepare('INSERT INTO tasks (id, workspace_id, title, status, created_by, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1)')
        .run('task_other', WS, 'other', 'open', 'test', NOW, NOW);
      fx.entries.createEntry(Object.assign({
        id: 'mem_dedup_boundary', workspaceId: WS, scope: 'task', ownerTaskId: TASK,
        category: 'summary', authority: 'system-verified', confidence: 0.9,
        importance: 0.5, title: '执行结果：修复登录页样式', content: generatedContent(), status: 'active',
        exactContentHash: hashMemoryText(generatedContent()),
        normalizedTextHash: hashMemoryText(normalizeMemoryText(generatedContent())),
        sources: [{ kind: 'run', id: RUN }], createdAt: NOW,
      }, overrides) as CreateMemoryEntryInput);
      const result = fx.service.generateForRunTerminal({ workspaceId: WS, runId: RUN, createdAt: NOW });
      assert.equal(result.outcome, 'created');
      assert.equal(result.duplicateOfEntryId, undefined);
      assert.equal(result.candidate!.outcome, 'review-required');
      assert.equal(fx.entries.findById(WS, 'mem_dedup_boundary')!.version, 1);
    } finally { fx.close(); }
  });
}

test('LITE-07-107 exact terminal dedup adds source once without changing accepted content', () => {
  const fx = fixture();
  try {
    const entry = fx.entries.createEntry({
      id: 'mem_dedup_source', workspaceId: WS, scope: 'task', ownerTaskId: TASK,
      category: 'summary', authority: 'system-verified', confidence: 0.9,
      importance: 0.5, title: 'accepted', content: generatedContent(), status: 'active',
      exactContentHash: hashMemoryText(generatedContent()),
      sources: [{ kind: 'task', id: TASK }], createdAt: NOW,
    });
    const input = { workspaceId: WS, runId: RUN, createdAt: '2026-09-12T01:00:00.000Z' };
    assert.equal(fx.service.generateForRunTerminal(input).outcome, 'converged');
    const merged = fx.entries.findById(WS, entry.id)!;
    assert.deepEqual(merged.sources, [{ kind: 'run', id: RUN }, { kind: 'task', id: TASK }]);
    assert.equal(merged.version, 2);
    assert.equal(merged.updatedAt, input.createdAt);
    assert.equal(merged.content, entry.content);
    assert.equal(merged.authority, entry.authority);
    assert.equal(fx.service.generateForRunTerminal(input).outcome, 'converged');
    assert.deepEqual(fx.entries.findById(WS, entry.id), merged);
  } finally { fx.close(); }
});

test('MF2R-G5 non-terminal or unknown Run generates nothing', () => {
  const running = fixture('running');
  try {
    assert.equal(running.service.generateForRunTerminal({ workspaceId: WS, runId: RUN, createdAt: NOW }).outcome, 'not-terminal');
    assert.equal(running.candidates.listCandidates(WS).length, 0);
    assert.equal(running.service.generateForRunTerminal({ workspaceId: WS, runId: 'run_missing', createdAt: NOW }).outcome, 'run-not-found');
  } finally { running.close(); }
});

// LITE-07-102: a failed Run is a terminal outcome and its factual fingerprint
// is exactly the memory that stops the same failure being repeated. The bundle
// stays record-only: status, failure code/message and stage outcomes.
test('MF2R-G6 failed Run generates one bounded failure Candidate, idempotent per Run', () => {
  const fx = fixture('failed', { code: 'PROVIDER_SESSION_FAILED', message: 'provider exited with code 1' });
  try {
    const first = fx.service.generateForRunTerminal({ workspaceId: WS, runId: RUN, createdAt: NOW });
    assert.equal(first.outcome, 'created');
    const candidate = first.candidate!;
    assert.equal(candidate.id, `mcand_terminal_${RUN}`);
    assert.equal(candidate.outcome, 'review-required');
    assert.equal(candidate.category, 'failure');
    assert.equal(candidate.authority, 'agent-derived');
    assert.equal(candidate.scope, 'task');
    assert.deepEqual(candidate.sources, [{ kind: 'run', id: RUN }]);
    assert.ok(candidate.title.includes('失败'));
    assert.ok(candidate.content.includes('PROVIDER_SESSION_FAILED'));
    assert.ok(candidate.content.includes('provider exited with code 1'));
    assert.ok(candidate.content.includes('implement: running'));
    assert.ok(!candidate.content.includes('raw-provider'));

    // Replay converges on the same row instead of writing a second fact.
    const replay = fx.service.generateForRunTerminal({ workspaceId: WS, runId: RUN, createdAt: NOW });
    assert.equal(replay.outcome, 'existing');
    assert.equal(replay.candidate!.id, candidate.id);
    assert.equal(fx.candidates.listCandidates(WS).length, 1);
  } finally { fx.close(); }
});

// LITE-07-102: cancellation is terminal too, and it carries no failure code.
test('MF2R-G7 cancelled Run generates one bounded failure Candidate without a failure code', () => {
  const fx = fixture('cancelled');
  try {
    const result = fx.service.generateForRunTerminal({ workspaceId: WS, runId: RUN, createdAt: NOW });
    assert.equal(result.outcome, 'created');
    const candidate = result.candidate!;
    assert.equal(candidate.category, 'failure');
    assert.ok(candidate.title.includes('已取消'));
    assert.ok(candidate.content.includes('status cancelled'));
    assert.ok(!candidate.content.includes('失败代码'));
    assert.equal(fx.candidates.listCandidates(WS).length, 1);
  } finally { fx.close(); }
});

test('MF2R input validation fails closed', () => {
  const fx = fixture();
  try {
    assert.throws(
      () => fx.service.generateForRunTerminal({ workspaceId: '', runId: RUN, createdAt: NOW }),
      (error: unknown) => error instanceof MemoryCandidateGenerationError && error.code === 'INPUT_INVALID',
    );
  } finally { fx.close(); }
});
