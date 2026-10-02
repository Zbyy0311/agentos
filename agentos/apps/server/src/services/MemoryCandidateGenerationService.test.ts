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
import type { TransactionDatabase } from '../store/Transaction.js';
import { MemoryEntryRepository } from '../store/MemoryEntryRepository.js';
import type { CreateMemoryEntryInput } from '../store/MemoryEntryRepository.js';
import { MemoryCandidateRepository } from '../store/MemoryCandidateRepository.js';
import { RunRepository } from '../store/RunRepository.js';
import { RunStageRepository } from '../store/RunStageRepository.js';
import { TaskRepository } from '../store/TaskRepository.js';
import { RunSnapshotRepository } from '../store/RunSnapshotRepository.js';
import { createEntityId } from '../store/Identity.js';
import { RuntimeEventRepository } from '../store/RuntimeEventRepository.js';
import { M3_013_LEGACY_WORKFLOW_V2_ID } from '../migrations/migrations/013-workflow-creation-metadata-v2.js';
import type { MemoryCandidateDraft, MemoryExtractionInput } from './MemoryExtractor.js';
import { MemoryExtractor } from './MemoryExtractor.js';
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

function seedTerminalSummaryArtifact(
  db: SqliteDb,
  runId: string,
  taskId: string,
  artifactId: string,
  summary: string,
  artifactIds: readonly string[] = [artifactId],
  summaryArtifactId = artifactId,
): void {
  db.prepare(`INSERT INTO runtime_artifacts (
    id, workspace_id, provenance_kind, canonical_run_id, artifact_type, title, summary,
    size_bytes, content_available, created_at
  ) VALUES (?, ?, 'CANONICAL', ?, 'test', 'test result', ?, ?, 0, ?)`)
    .run(artifactId, WS, runId, summary, summary.length, NOW);
  db.prepare('UPDATE runs SET next_event_sequence = 2 WHERE workspace_id = ? AND id = ?').run(WS, runId);
  const events = new RuntimeEventRepository(db as unknown as TransactionDatabase, createM3RuntimeEventRegistry());
  events.appendWithinTransaction({
    id: createEntityId('event'),
    schemaVersion: 1,
    type: 'run.completed',
    workspaceId: WS,
    taskId,
    runId,
    sequence: 1,
    timestamp: NOW,
    source: 'run-engine',
    correlationId: `corr_${runId}`,
    severity: 'info',
    visibility: 'public',
    durability: 'durable',
    payload: { durationMs: 60_000, completedStageIds: [], artifactIds: [...artifactIds], summaryArtifactId },
  });
}

function fixture(
  runStatus = 'completed',
  failure: { readonly code?: string; readonly message?: string } = {},
  extractor?: Pick<MemoryExtractor, 'extract'>,
  terminalArtifactIds?: readonly string[],
  terminalSummaryArtifactId?: string,
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
  if (runStatus === 'completed') {
    seedTerminalSummaryArtifact(db, RUN, TASK, 'artifact_mf2rg_test',
      'pass: regression tests verified the requested behavior.', terminalArtifactIds, terminalSummaryArtifactId);
  }
  const candidates = new MemoryCandidateRepository(tdb);
  const entries = new MemoryEntryRepository(tdb);
  const service = new MemoryCandidateGenerationService({
    store: { getDatabase: () => tdb },
    runs: new RunRepository(tdb as never),
    stages: new RunStageRepository(tdb as never),
    tasks: new TaskRepository(tdb as never),
    candidates,
    extractor,
  });
  return { db, service, candidates, entries, close: () => { try { db.close(); } finally { rmSync(root, { recursive: true, force: true }); } } };
}

function generatedContent(): string {
  return [
    '任务：修复登录页样式',
    '',
    `结果：持久化test结果：pass: regression tests verified the requested behavior.\nRun ${RUN} 完成（origin v2_api，reason initial）。\nStage 结果：implement: completed (attempt 1, duration 60000ms)`,
  ].join('\n');
}

test('MF2R-G1 completed Run generates a review-required Candidate with bounded evidence', () => {
  const fx = fixture();
  try {
    fx.db.prepare(`INSERT INTO runtime_artifacts (
      id, workspace_id, provenance_kind, canonical_run_id, artifact_type, title, summary,
      size_bytes, content_available, created_at
    ) VALUES ('artifact_mf2rg_unlinked', ?, 'CANONICAL', ?, 'test', 'unlinked result',
      'UNREFERENCED_OUTPUT_MUST_NOT_BE_CAPTURED', 40, 0, ?)`)
      .run(WS, RUN, NOW);
    const result = fx.service.generateForRunTerminal({ workspaceId: WS, runId: RUN, createdAt: NOW });
    assert.equal(result.outcome, 'created');
    const candidate = result.candidate!;
    assert.equal(candidate.id, `mcand_terminal_${RUN}`);
    assert.equal(candidate.outcome, 'review-required'); // agent-derived + conservative gate
    assert.equal(candidate.authority, 'agent-derived'); // never promoted by generated confidence
    assert.equal(candidate.scope, 'task');
    const terminalEvent = fx.db.prepare("SELECT id FROM runtime_events WHERE run_id = ? AND type = 'run.completed'")
      .get(RUN) as { id: string };
    assert.deepEqual(candidate.sources, [
      { kind: 'artifact', id: 'artifact_mf2rg_test' },
      { kind: 'event', id: terminalEvent.id },
      { kind: 'run', id: RUN },
      { kind: 'stage', id: 'stage_mf2rg' },
      { kind: 'task', id: TASK },
    ]);
    assert.equal(candidate.category, 'knowledge');
    assert.ok(candidate.title.includes('修复登录页样式'));
    assert.ok(candidate.content.includes('implement: completed'));
    assert.ok(candidate.content.includes('pass: regression tests verified the requested behavior.'));
    assert.ok(!candidate.content.includes('UNREFERENCED_OUTPUT_MUST_NOT_BE_CAPTURED'));
    assert.ok(!candidate.content.includes('raw-provider')); // bounded bundle only
    assert.ok(candidate.exactContentHash !== null && candidate.normalizedTextHash !== null);
  } finally { fx.close(); }
});

test('canonical Run accepts its durable summaryArtifactId when it is not repeated in artifactIds', () => {
  const fx = fixture('completed', {}, undefined, []);
  try {
    const result = fx.service.generateForRunTerminal({ workspaceId: WS, runId: RUN, createdAt: NOW });
    assert.equal(result.outcome, 'created');
    assert.ok(result.candidate?.content.includes('pass: regression tests verified the requested behavior.'));
    assert.ok(result.candidate?.sources.some(source => source.kind === 'artifact' && source.id === 'artifact_mf2rg_test'));
    assert.ok(result.candidate?.sources.some(source => source.kind === 'event'));
  } finally { fx.close(); }
});

test('canonical Run rejects a summaryArtifactId whose durable artifact belongs to another Run', () => {
  const fx = fixture('completed', {}, undefined, [], 'artifact_mf2rg_next_test');
  try {
    const otherTask = 'task_mf2rg_next';
    const otherRun = 'run_mf2rg_next';
    fx.db.prepare(`INSERT INTO tasks
      (id, workspace_id, title, status, created_by, created_at, updated_at, version)
      VALUES (?, ?, ?, 'open', 'test', ?, ?, 1)`).run(otherTask, WS, '第二个任务', NOW, NOW);
    fx.db.prepare(`INSERT INTO runs
      (id, workspace_id, task_id, root_run_id, status, reason, origin, created_by, created_at, updated_at, version)
      VALUES (?, ?, ?, ?, 'completed', 'initial', 'v2_api', 'test', ?, ?, 1)`)
      .run(otherRun, WS, otherTask, otherRun, NOW, NOW);
    seedTerminalSummaryArtifact(fx.db, otherRun, otherTask, 'artifact_mf2rg_next_test',
      'pass: FOREIGN_RUN_SUMMARY_MUST_NOT_BE_CAPTURED; verified test evidence.');

    const first = fx.service.generateForRunTerminal({ workspaceId: WS, runId: RUN, createdAt: NOW });
    assert.ok(first.candidate === undefined || first.candidate.sources.every(source => source.kind !== 'artifact'));
    assert.ok(!first.candidate?.content.includes('FOREIGN_RUN_SUMMARY_MUST_NOT_BE_CAPTURED'));

    const second = fx.service.generateForRunTerminal({ workspaceId: WS, runId: otherRun, createdAt: NOW });
    assert.equal(second.outcome, 'created');
    assert.ok(second.candidate?.content.includes('FOREIGN_RUN_SUMMARY_MUST_NOT_BE_CAPTURED'));
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

test('canonical Run reuses MemoryExtractor and caps its exact-source review queue at three', () => {
  const observed: MemoryExtractionInput[] = [];
  const extractor = {
    extract(input: MemoryExtractionInput) {
      observed.push(input);
      const drafts: MemoryCandidateDraft[] = [
        { type: 'overview', title: 'Overview', summary: 'Overview summary.', content: 'Overview content.', confidence: 100, operation: 'create' },
        { type: 'convention', title: 'Convention', summary: 'Convention summary.', content: 'Convention content.', confidence: 100, operation: 'create' },
        { type: 'decision', title: 'Decision', summary: 'Decision summary.', content: 'Decision content.', confidence: 100, operation: 'create' },
        { type: 'experience', title: 'Excess', summary: 'Excess summary.', content: 'Excess content.', confidence: 100, operation: 'create' },
      ];
      return { drafts, reason: 'explicit_marker' as const };
    },
  };
  const fx = fixture('completed', {}, extractor);
  try {
    const result = fx.service.generateForRunTerminal({ workspaceId: WS, runId: RUN, createdAt: NOW });
    assert.equal(result.outcome, 'created');
    assert.deepEqual(result.candidates?.map(candidate => candidate.id), [
      `mcand_terminal_${RUN}`, `mcand_terminal_${RUN}_2`, `mcand_terminal_${RUN}_3`,
    ]);
    assert.equal(fx.candidates.listCandidates(WS).length, 3);
    assert.ok(result.candidates?.every(candidate => candidate.outcome === 'review-required'
      && candidate.authority === 'agent-derived' && candidate.confidence < 0.9));
    assert.deepEqual(observed[0]?.fileChanges, []);
    assert.deepEqual(observed[0]?.visibleReplies, []);
    assert.equal(observed[0]?.objective, '修复登录页样式');
    assert.match(observed[0]?.resultSummary ?? '', new RegExp(RUN));
    assert.match(observed[0]?.resultSummary ?? '', /implement: completed/);
    assert.match(observed[0]?.resultSummary ?? '', /持久化test结果：pass: regression tests verified/);
    assert.ok(result.candidates?.[0]?.sources.some(source => source.kind === 'run' && source.id === RUN));
    assert.ok(result.candidates?.[0]?.sources.some(source => source.kind === 'event'));
    assert.ok(result.candidates?.[0]?.sources.some(source => source.kind === 'artifact' && source.id === 'artifact_mf2rg_test'));
    assert.ok(result.candidates?.[0]?.sources.some(source => source.kind === 'stage' && source.id === 'stage_mf2rg'));
  } finally { fx.close(); }
});

test('consecutive canonical Runs at the same timestamp cannot mix Task or Run evidence', () => {
  const fx = fixture();
  try {
    const otherTask = 'task_mf2rg_next';
    const otherRun = 'run_mf2rg_next';
    fx.db.prepare(`INSERT INTO tasks
      (id, workspace_id, title, status, created_by, created_at, updated_at, version)
      VALUES (?, ?, ?, 'open', 'test', ?, ?, 1)`).run(otherTask, WS, '修复二阶段消息隔离', NOW, NOW);
    fx.db.prepare(`INSERT INTO runs
      (id, workspace_id, task_id, root_run_id, status, reason, origin, created_by, created_at, updated_at, version)
      VALUES (?, ?, ?, ?, 'completed', 'initial', 'v2_api', 'test', ?, ?, 1)`).run(otherRun, WS, otherTask, otherRun, NOW, NOW);
    seedTerminalSummaryArtifact(fx.db, otherRun, otherTask, 'artifact_mf2rg_next_test',
      'pass: second task uses a separate test result.');

    const first = fx.service.generateForRunTerminal({ workspaceId: WS, runId: RUN, createdAt: NOW }).candidate!;
    const second = fx.service.generateForRunTerminal({ workspaceId: WS, runId: otherRun, createdAt: NOW }).candidate!;
    assert.match(first.content, new RegExp(RUN));
    assert.match(first.content, /修复登录页样式/);
    assert.ok(!first.content.includes(`Run ${otherRun} `));
    assert.doesNotMatch(first.content, /二阶段消息隔离/);
    assert.doesNotMatch(first.content, /second task uses a separate test result/);
    assert.match(second.content, new RegExp(otherRun));
    assert.match(second.content, /二阶段消息隔离/);
    assert.ok(!second.content.includes(`Run ${RUN} `));
    assert.doesNotMatch(second.content, /登录页样式/);
    assert.doesNotMatch(second.content, /regression tests verified the requested behavior/);
    assert.deepEqual(first.sources.filter(source => source.kind === 'run'), [{ kind: 'run', id: RUN }]);
    assert.deepEqual(second.sources.filter(source => source.kind === 'run'), [{ kind: 'run', id: otherRun }]);
    assert.deepEqual(first.sources.filter(source => source.kind === 'artifact'), [{ kind: 'artifact', id: 'artifact_mf2rg_test' }]);
    assert.deepEqual(second.sources.filter(source => source.kind === 'artifact'), [{ kind: 'artifact', id: 'artifact_mf2rg_next_test' }]);
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
      category: 'knowledge',
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
      category: 'knowledge',
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
      category: 'knowledge',
      authority: 'system-verified',
      confidence: 0.9,
      importance: 0.5,
      title: '执行经验：修复登录页样式',
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
        category: 'knowledge', authority: 'system-verified', confidence: 0.9,
        importance: 0.5, title: '执行经验：修复登录页样式', content: generatedContent(), status: 'active',
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
      category: 'knowledge', authority: 'system-verified', confidence: 0.9,
      importance: 0.5, title: 'accepted', content: generatedContent(), status: 'active',
      exactContentHash: hashMemoryText(generatedContent()),
      sources: [{ kind: 'task', id: TASK }], createdAt: NOW,
    });
    const input = { workspaceId: WS, runId: RUN, createdAt: '2026-09-12T01:00:00.000Z' };
    assert.equal(fx.service.generateForRunTerminal(input).outcome, 'converged');
    const merged = fx.entries.findById(WS, entry.id)!;
    assert.deepEqual(merged.sources, [
      { kind: 'artifact', id: 'artifact_mf2rg_test' },
      { kind: 'event', id: (fx.db.prepare("SELECT id FROM runtime_events WHERE run_id = ? AND type = 'run.completed'")
        .get(RUN) as { id: string }).id },
      { kind: 'run', id: RUN }, { kind: 'stage', id: 'stage_mf2rg' }, { kind: 'task', id: TASK },
    ]);
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
    assert.deepEqual(candidate.sources, [
      { kind: 'run', id: RUN },
      { kind: 'stage', id: 'stage_mf2rg' },
      { kind: 'task', id: TASK },
    ]);
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

test('generated input rejects forged authority, confidence, scope, and content claims', () => {
  const fx = fixture();
  try {
    const forged = {
      workspaceId: WS,
      runId: RUN,
      createdAt: NOW,
      authority: 'system-verified',
      confidence: 1,
      scope: 'global',
      ownerTaskId: 'task_other',
      content: 'Model-authored content claiming verification.',
    };
    assert.throws(
      () => fx.service.generateForRunTerminal(forged as never),
      (error: unknown) => error instanceof MemoryCandidateGenerationError && error.code === 'INPUT_INVALID',
    );
    assert.equal(fx.candidates.listCandidates(WS).length, 0);
  } finally { fx.close(); }
});
