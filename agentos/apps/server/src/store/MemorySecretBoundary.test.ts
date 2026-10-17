import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createM3RuntimeEventRegistry,
  type RuntimeEventContextAuthoritySourceV1,
} from '@agentos/shared';
import { MigrationRegistry } from '../migrations/registry.js';
import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import { createFileBackupProvider } from '../migrations/backup.js';
import type { MinimalDatabaseSync } from '../migrations/types.js';
import { eventRedactionServiceForDatabase } from '../services/EventRedactionService.js';
import { MemoryCandidateGenerationService } from '../services/MemoryCandidateGenerationService.js';
import { MemorySourceAccumulationService } from '../services/MemorySourceAccumulationService.js';
import { ConversationStreamService } from '../services/ConversationStreamService.js';
import { DurableMemoryRuntimeEventContextAuthority } from '../services/MemoryRuntimeEventContextAuthority.js';
import { MemoryRuntimeEventEmitter } from '../services/MemoryRuntimeEventEmitter.js';
import { MemorySecretDetectedError } from '../services/MemorySecretGuard.js';
import { SqliteStore } from './SqliteStore.js';
import { MemoryCandidateRepository, type CreateMemoryCandidateInput, type ReviewMemoryCandidateInput } from './MemoryCandidateRepository.js';
import { MemoryEntryRepository, type CreateMemoryEntryInput, type UpdateMemoryEntryInput } from './MemoryEntryRepository.js';
import { OutboxRepository } from './OutboxRepository.js';
import { RunSequenceAllocator } from './RunSequenceAllocator.js';
import { RuntimeEventOutboxWriter, RuntimeEventRepository } from './RuntimeEventRepository.js';
import { inTransaction, type TransactionDatabase } from './Transaction.js';

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

const NOW = '2026-10-13T00:00:00.000Z';
const NOW2 = '2026-10-13T00:01:00.000Z';
const WS = 'ws_memory_secret_boundary';
const WS_OTHER = 'ws_memory_secret_boundary_other';
const TASK = 'task_memory_secret_boundary';
const TASK_OTHER = 'task_memory_secret_boundary_other';
const RUN = 'run_memory_secret_boundary';
const RUN_OTHER = 'run_memory_secret_boundary_other';
const OP = 'op_memory_secret_boundary';
const OP_OTHER = 'op_memory_secret_boundary_other';
const SECRET = 'mosaicHarbor~cedarField~709348';

const EVENT_CONTEXT: RuntimeEventContextAuthoritySourceV1 = {
  origin: 'operation',
  operationId: OP,
  context: { correlationId: 'corr-memory-secret-boundary', causationId: OP },
};
const OTHER_EVENT_CONTEXT: RuntimeEventContextAuthoritySourceV1 = {
  origin: 'operation',
  operationId: OP_OTHER,
  context: { correlationId: 'corr-memory-secret-boundary-other', causationId: OP_OTHER },
};

function insertWorkspace(db: SqliteDb, id: string): void {
  db.prepare(
    'INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, id, 'C:/tmp/' + id, 'C:/tmp/' + id, NOW, NOW, NOW);
  const taskId = id === WS ? TASK : TASK_OTHER;
  const runId = id === WS ? RUN : RUN_OTHER;
  const operationId = id === WS ? OP : OP_OTHER;
  const correlationId = id === WS ? 'corr-memory-secret-boundary' : 'corr-memory-secret-boundary-other';
  db.prepare(
    'INSERT INTO tasks (id, workspace_id, title, status, created_by, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
  ).run(taskId, id, 'task', 'open', 'test', NOW, NOW);
  db.prepare(
    'INSERT INTO runs (id, workspace_id, task_id, root_run_id, status, reason, created_by, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
  ).run(runId, id, taskId, runId, 'queued', 'initial', 'test', NOW, NOW);
  db.prepare(
    'INSERT INTO operations (id, type, status, workspace_id, aggregate_type, aggregate_id, run_id, correlation_id, created_at, started_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
  ).run(operationId, 'run.start', 'running', id, 'run', runId, runId, correlationId, NOW, NOW, NOW);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentos-memory-secret-boundary-'));
  const db = new DatabaseSync(join(root, 'agentos.sqlite'));
  db.prepare('PRAGMA foreign_keys = ON').run();
  new MigrationRunner(
    db as unknown as MinimalDatabaseSync,
    new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS),
    { backupProvider: createFileBackupProvider(join(root, 'backup')) },
  ).run();
  insertWorkspace(db, WS);
  insertWorkspace(db, WS_OTHER);

  const tx = db as unknown as TransactionDatabase;
  const detector = eventRedactionServiceForDatabase(tx);
  const entries = new MemoryEntryRepository(tx, detector);
  const candidates = new MemoryCandidateRepository(tx, detector);
  const events = new RuntimeEventRepository(tx, createM3RuntimeEventRegistry());
  const outbox = new OutboxRepository(tx, events);
  const writer = new RuntimeEventOutboxWriter(events, new RunSequenceAllocator(tx), outbox, tx);
  const emitter = new MemoryRuntimeEventEmitter({
    store: { getDatabase: () => tx },
    factWriter: writer,
    eventAuthority: new DurableMemoryRuntimeEventContextAuthority(tx),
    entries,
    candidates,
    now: () => new Date(NOW),
  });
  return {
    root, db, tx, detector, entries, candidates, emitter,
    close: () => { try { db.close(); } finally { rmSync(root, { recursive: true, force: true }); } },
  };
}

function candidateInput(
  id: string,
  overrides: Partial<CreateMemoryCandidateInput> = {},
): CreateMemoryCandidateInput {
  return {
    id,
    workspaceId: WS,
    scope: 'task',
    ownerTaskId: TASK,
    category: 'decision',
    authority: 'system-verified',
    confidence: 0.9,
    importance: 0.5,
    title: 'Candidate title ' + id,
    summary: 'Candidate summary',
    content: 'Safe candidate content',
    tags: ['candidate-tag'],
    exactContentHash: 'exact-' + id,
    normalizedTextHash: 'normalized-' + id,
    tokenEstimate: 12,
    inferredPreference: true,
    sources: [{ kind: 'run', id: RUN }],
    createdAt: NOW,
    minConfidence: 0.5,
    maxTokenEstimate: 100,
    ...overrides,
  };
}

function candidateEventInput(input: CreateMemoryCandidateInput) {
  const other = input.workspaceId === WS_OTHER;
  return {
    ...input,
    runId: other ? RUN_OTHER : RUN,
    eventContext: other ? OTHER_EVENT_CONTEXT : EVENT_CONTEXT,
  };
}

function entryInput(
  id: string,
  overrides: Partial<CreateMemoryEntryInput> = {},
): CreateMemoryEntryInput {
  return {
    id,
    workspaceId: WS,
    scope: 'task',
    ownerTaskId: TASK,
    category: 'decision',
    authority: 'system-verified',
    confidence: 0.9,
    importance: 0.6,
    title: 'Entry title ' + id,
    summary: 'Entry summary',
    content: 'Safe entry content',
    tags: ['entry-tag'],
    status: 'active',
    sources: [{ kind: 'run', id: RUN }],
    createdAt: NOW,
    ...overrides,
  };
}

function entryEventInput(input: CreateMemoryEntryInput) {
  return { ...input, runId: RUN, eventContext: EVENT_CONTEXT };
}

function reviewEventInput(input: ReviewMemoryCandidateInput) {
  return { ...input, runId: RUN, eventContext: EVENT_CONTEXT };
}

type SinkCounts = {
  candidates: number;
  candidateSources: number;
  entries: number;
  entrySources: number;
  fts: number;
  events: number;
  outbox: number;
};

function count(db: SqliteDb, table: string): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM ' + table).get() as { c: number }).c;
}

function sinkCounts(db: SqliteDb): SinkCounts {
  return {
    candidates: count(db, 'memory_candidate_entries'),
    candidateSources: count(db, 'memory_candidate_sources'),
    entries: count(db, 'memory_entries'),
    entrySources: count(db, 'memory_entry_sources'),
    fts: count(db, 'memory_entries_fts'),
    events: count(db, 'runtime_events'),
    outbox: count(db, 'outbox_messages'),
  };
}

function candidateState(db: SqliteDb, id: string): { version: number; outcome: string } | undefined {
  const row = db.prepare(
    'SELECT version, outcome FROM memory_candidate_entries WHERE workspace_id = ? AND id = ?',
  ).get(WS, id) as { version: number; outcome: string } | undefined;
  return row === undefined ? undefined : { ...row };
}

function entryState(db: SqliteDb, id: string): {
  version: number; status: string; title: string; summary: string; content: string; tags_json: string;
} | undefined {
  const row = db.prepare(
    'SELECT version, status, title, summary, content, tags_json FROM memory_entries WHERE workspace_id = ? AND id = ?',
  ).get(WS, id) as {
    version: number; status: string; title: string; summary: string; content: string; tags_json: string;
  } | undefined;
  return row === undefined ? undefined : { ...row };
}

function assertRejectedWithoutSecret(action: () => unknown): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(
      error.message.includes('MEMORY_SECRET_DETECTED') || error.message.includes('MEMORY_EVENT_EMISSION_FAILED'),
      'expected the known-secret guard to reject the write',
    );
    assert.ok(!error.message.includes(SECRET), 'error message must not disclose the secret value');
    return true;
  });
}

function assertGuardError(error: unknown): void {
  assert.ok(error instanceof MemorySecretDetectedError);
  assert.equal(error.violations[0]?.kind, 'known-value');
  assert.ok(!JSON.stringify(error).includes(SECRET));
}

// F2: known workspace values block candidate creation before auto-accept; clean and isolated writes still work.
test('F2 candidate creation and auto-accept use the workspace-scoped known-secret detector', () => {
  const fx = fixture();
  try {
    fx.detector.registerSecrets(WS, [SECRET]);
    assert.equal(eventRedactionServiceForDatabase(fx.tx), fx.detector);
    assert.equal(fx.detector.detectSecretInText(WS, SECRET), 'known-value');
    assert.equal(fx.detector.detectSecretInText(WS_OTHER, SECRET), undefined);

    const unsafeCandidateFields: Array<Partial<CreateMemoryCandidateInput>> = [
      { title: 'Known workspace value: ' + SECRET },
      { summary: 'Known workspace value: ' + SECRET },
      { content: 'Known workspace value: ' + SECRET },
      { tags: ['Known workspace value: ' + SECRET] },
    ];
    for (const [index, fields] of unsafeCandidateFields.entries()) {
      const id = 'mcand_boundary_create_unsafe_' + index;
      const beforeUnsafe = sinkCounts(fx.db);
      assertRejectedWithoutSecret(() => fx.emitter.emitCandidateCreated(candidateEventInput(candidateInput(
        id,
        { inferredPreference: false, ...fields },
      ))));
      assert.deepEqual(sinkCounts(fx.db), beforeUnsafe);
      assert.equal(candidateState(fx.db, id), undefined);
    }

    const safe = fx.emitter.emitCandidateCreated(candidateEventInput(candidateInput(
      'mcand_boundary_create_safe',
      { inferredPreference: false, title: 'Safe title', summary: 'Safe summary', content: 'Safe content' },
    )));
    assert.equal(safe.record.outcome, 'accept');
    assert.equal(safe.record.decision, 'auto-accept');
    assert.equal(safe.record.mergedIntoEntryId, safe.record.id);
    assert.equal(entryState(fx.db, safe.record.id)?.content, 'Safe content');
    assert.deepEqual(sinkCounts(fx.db), {
      candidates: 1, candidateSources: 1, entries: 1, entrySources: 1, fts: 1, events: 2, outbox: 2,
    });

    const isolated = fx.emitter.emitCandidateCreated(candidateEventInput(candidateInput(
      'mcand_boundary_other_workspace',
      {
        workspaceId: WS_OTHER,
        ownerTaskId: TASK_OTHER,
        sources: [{ kind: 'run', id: RUN_OTHER }],
        inferredPreference: false,
        title: 'Other workspace secret control',
        content: 'Workspace-only value: ' + SECRET,
      },
    )));
    assert.equal(isolated.record.outcome, 'accept');
    assert.equal(isolated.record.workspaceId, WS_OTHER);
    assert.equal(fx.detector.detectSecretInText(WS_OTHER, SECRET), undefined);
    assert.equal(fx.candidates.findCandidateById(WS_OTHER, isolated.record.id)?.content, 'Workspace-only value: ' + SECRET);
    assert.deepEqual(sinkCounts(fx.db), {
      candidates: 2, candidateSources: 2, entries: 2, entrySources: 2, fts: 2, events: 4, outbox: 4,
    });
  } finally {
    fx.close();
  }
});

// F2: Entry create is checked through the real Event + Outbox seam; field updates roll back in SQLite.
test('F2 Entry create and update reject known secrets without changing durable state', () => {
  const fx = fixture();
  try {
    fx.detector.registerSecrets(WS, [SECRET]);

    const createFields: Array<Partial<CreateMemoryEntryInput>> = [
      { title: SECRET },
      { summary: SECRET },
      { content: SECRET },
      { tags: [SECRET] },
    ];
    for (const [index, fields] of createFields.entries()) {
      const before = sinkCounts(fx.db);
      const id = 'mem_boundary_create_unsafe_' + index;
      assertRejectedWithoutSecret(() => fx.emitter.emitEntryCreated(entryEventInput(entryInput(id, fields))));
      assert.deepEqual(sinkCounts(fx.db), before);
      assert.equal(entryState(fx.db, id), undefined);
    }

    const created = fx.emitter.emitEntryCreated(entryEventInput(entryInput(
      'mem_boundary_update_target',
      { title: 'Original title', summary: 'Original summary', content: 'Original content', tags: ['original-tag'] },
    )));
    assert.equal(created.record.version, 1);
    const baseline = sinkCounts(fx.db);
    const updateFields: Array<Partial<UpdateMemoryEntryInput>> = [
      { title: SECRET },
      { summary: SECRET },
      { content: SECRET },
      { tags: [SECRET] },
    ];
    for (const fields of updateFields) {
      const before = sinkCounts(fx.db);
      let failure: unknown;
      try {
        inTransaction(fx.tx, () => fx.entries.updateEntryWithinTransaction({
          workspaceId: WS,
          entryId: created.record.id,
          expectedVersion: 1,
          updatedAt: NOW2,
          ...fields,
        }));
      } catch (error) {
        failure = error;
      }
      assertGuardError(failure);
      assert.deepEqual(sinkCounts(fx.db), before);
      assert.deepEqual(entryState(fx.db, created.record.id), {
        version: 1, status: 'active', title: 'Original title', summary: 'Original summary',
        content: 'Original content', tags_json: JSON.stringify(['original-tag']),
      });
    }

    const updated = inTransaction(fx.tx, () => fx.entries.updateEntryWithinTransaction({
      workspaceId: WS,
      entryId: created.record.id,
      expectedVersion: 1,
      updatedAt: NOW2,
      title: 'Updated title',
      summary: 'Updated summary',
      content: 'Updated content',
      tags: ['updated-tag'],
    }));
    assert.equal(updated.version, 2);
    assert.equal(updated.content, 'Updated content');
    assert.deepEqual(updated.tags, ['updated-tag']);
    assert.deepEqual(sinkCounts(fx.db), baseline, 'repository-only text update emits no Runtime Event or Outbox row');
  } finally {
    fx.close();
  }
});

// F2: a secret discovered after persistence prevents promotion, while reject remains available for cleanup.
test('F2 stored old candidate is blocked on accept but can be rejected', () => {
  const fx = fixture();
  try {
    const id = 'mcand_boundary_historical_secret';
    const old = fx.candidates.createCandidate(candidateInput(id, { content: 'Legacy value: ' + SECRET }));
    assert.equal(old.outcome, 'review-required');
    fx.detector.registerSecrets(WS, [SECRET]);

    const beforeAccept = sinkCounts(fx.db);
    assertRejectedWithoutSecret(() => fx.emitter.emitCandidateReviewed(reviewEventInput({
      workspaceId: WS, candidateId: id, expectedVersion: 1, outcome: 'accept', reviewedAt: NOW2,
    })));
    assert.deepEqual(sinkCounts(fx.db), beforeAccept);
    assert.deepEqual(candidateState(fx.db, id), { version: 1, outcome: 'review-required' });
    assert.equal(entryState(fx.db, id), undefined);

    const rejected = fx.emitter.emitCandidateReviewed(reviewEventInput({
      workspaceId: WS, candidateId: id, expectedVersion: 1, outcome: 'reject', reviewedAt: NOW2,
    }));
    assert.equal(rejected.record.outcome, 'reject');
    assert.equal(rejected.record.version, 2);
    assert.equal(entryState(fx.db, id), undefined);
    assert.deepEqual(sinkCounts(fx.db), {
      candidates: 1, candidateSources: 1, entries: 0, entrySources: 0, fts: 0, events: 1, outbox: 1,
    });
  } finally {
    fx.close();
  }
});

// F2: review validates the complete edited result and preserves untouched stored fields.
test('F2 edit-and-accept validates merged title, summary, content, and tags', () => {
  const fx = fixture();
  try {
    fx.detector.registerSecrets(WS, [SECRET]);

    const unsafeEdits: Array<{ id: string; edits: ReviewMemoryCandidateInput['edits'] }> = [
      { id: 'mcand_boundary_edit_title', edits: { title: 'Unsafe ' + SECRET } },
      { id: 'mcand_boundary_edit_summary', edits: { summary: 'Unsafe ' + SECRET } },
      { id: 'mcand_boundary_edit_content', edits: { content: 'Unsafe ' + SECRET } },
      { id: 'mcand_boundary_edit_tags', edits: { tags: ['Unsafe ' + SECRET] } },
    ];
    for (const item of unsafeEdits) {
      fx.candidates.createCandidate(candidateInput(item.id));
      const before = sinkCounts(fx.db);
      assertRejectedWithoutSecret(() => fx.emitter.emitCandidateReviewed(reviewEventInput({
        workspaceId: WS,
        candidateId: item.id,
        expectedVersion: 1,
        outcome: 'edit-and-accept',
        edits: item.edits,
        reviewedAt: NOW2,
      })));
      assert.deepEqual(sinkCounts(fx.db), before);
      assert.deepEqual(candidateState(fx.db, item.id), { version: 1, outcome: 'review-required' });
      assert.equal(entryState(fx.db, item.id), undefined);
    }

    const safeId = 'mcand_boundary_edit_safe';
    fx.candidates.createCandidate(candidateInput(safeId, {
      title: 'Original candidate title',
      summary: 'Original candidate summary',
      content: 'Original candidate content',
      tags: ['original-tag'],
    }));
    const edited = fx.emitter.emitCandidateReviewed(reviewEventInput({
      workspaceId: WS,
      candidateId: safeId,
      expectedVersion: 1,
      outcome: 'edit-and-accept',
      edits: { summary: 'Reviewed summary', tags: ['reviewed-tag'] },
      reviewedAt: NOW2,
    }));
    assert.equal(edited.record.version, 2);
    assert.equal(edited.record.title, 'Original candidate title');
    assert.equal(edited.record.summary, 'Reviewed summary');
    assert.equal(edited.record.content, 'Original candidate content');
    assert.deepEqual(edited.record.tags, ['reviewed-tag']);
    assert.deepEqual(entryState(fx.db, safeId), {
      version: 1, status: 'active', title: 'Original candidate title', summary: 'Reviewed summary',
      content: 'Original candidate content', tags_json: JSON.stringify(['reviewed-tag']),
    });
    assert.equal(count(fx.db, 'runtime_events'), 2);
    assert.equal(count(fx.db, 'outbox_messages'), 2);
  } finally {
    fx.close();
  }
});

// F2: merge guards inspect both the old target Entry and old Candidate before adding provenance.
test('F2 merge-with-existing rejects secrets on either side and still permits a safe merge', () => {
  const fx = fixture();
  try {
    const secretTargetId = 'mem_boundary_merge_secret_target';
    const cleanCandidateId = 'mcand_boundary_merge_target_secret';
    const cleanTargetId = 'mem_boundary_merge_clean_target';
    const secretCandidateId = 'mcand_boundary_merge_secret_candidate';
    fx.entries.createEntry(entryInput(secretTargetId, { content: 'Old target ' + SECRET }));
    fx.candidates.createCandidate(candidateInput(cleanCandidateId, {
      sources: [{ kind: 'message', id: 'source-for-clean-candidate' }],
    }));
    fx.entries.createEntry(entryInput(cleanTargetId, { content: 'Clean target content' }));
    fx.candidates.createCandidate(candidateInput(secretCandidateId, {
      content: 'Old candidate ' + SECRET,
      sources: [{ kind: 'message', id: 'source-for-secret-candidate' }],
    }));
    fx.detector.registerSecrets(WS, [SECRET]);

    for (const [candidateId, targetId] of [
      [cleanCandidateId, secretTargetId],
      [secretCandidateId, cleanTargetId],
    ] as const) {
      const before = sinkCounts(fx.db);
      assertRejectedWithoutSecret(() => fx.emitter.emitCandidateReviewed(reviewEventInput({
        workspaceId: WS,
        candidateId,
        expectedVersion: 1,
        outcome: 'merge-with-existing',
        mergedIntoEntryId: targetId,
        reviewedAt: NOW2,
      })));
      assert.deepEqual(sinkCounts(fx.db), before);
      assert.deepEqual(candidateState(fx.db, candidateId), { version: 1, outcome: 'review-required' });
      assert.equal(entryState(fx.db, targetId)?.version, 1);
      assert.equal(count(fx.db, 'memory_entry_sources'), before.entrySources);
    }

    const safeTargetId = 'mem_boundary_merge_safe_target';
    const safeCandidateId = 'mcand_boundary_merge_safe_candidate';
    fx.entries.createEntry(entryInput(safeTargetId, { content: 'Safe target content' }));
    fx.candidates.createCandidate(candidateInput(safeCandidateId, {
      content: 'Safe candidate content',
      sources: [{ kind: 'message', id: 'source-for-safe-candidate' }],
    }));
    const merged = fx.emitter.emitCandidateReviewed(reviewEventInput({
      workspaceId: WS,
      candidateId: safeCandidateId,
      expectedVersion: 1,
      outcome: 'merge-with-existing',
      mergedIntoEntryId: safeTargetId,
      reviewedAt: NOW2,
    }));
    assert.equal(merged.record.outcome, 'merge-with-existing');
    assert.equal(merged.record.version, 2);
    assert.equal(entryState(fx.db, safeTargetId)?.version, 2);
    assert.equal(count(fx.db, 'memory_entry_sources'), 4);
    assert.equal(count(fx.db, 'runtime_events'), 2);
    assert.equal(count(fx.db, 'outbox_messages'), 2);
  } finally {
    fx.close();
  }
});

// F2: terminal generation skips a known-secret draft, then persists a safe draft in real SQLite.
test('F2 terminal candidate generation skips unsafe draft and continues with safe draft', () => {
  const fx = fixture();
  const warnings: string[] = [];
  const originalWarn = console.warn;
  try {
    fx.detector.registerSecrets(WS, [SECRET]);
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
    const service = new MemoryCandidateGenerationService({
      store: { getDatabase: () => fx.tx },
      runs: {
        findById: () => ({
          id: RUN, taskId: TASK, status: 'completed', nextEventSequence: 1,
          origin: 'test', reason: 'completed', objective: 'safe objective',
        }),
      } as never,
      stages: { listByRun: () => [] } as never,
      tasks: { findById: () => ({ title: 'Safe terminal task' }) } as never,
      extractor: {
        extract: () => ({
          drafts: [
            {
              type: 'decision', title: 'Unsafe generated title', summary: 'Unsafe summary',
              content: 'Generated value ' + SECRET, confidence: 95, operation: 'create',
            },
            {
              type: 'decision', title: 'Safe generated title', summary: 'Safe generated summary',
              content: 'Safe generated memory', confidence: 95, operation: 'create',
            },
          ],
          reason: 'public_evidence',
        }),
      },
    });
    const result = service.generateForRunTerminal({ workspaceId: WS, runId: RUN, createdAt: NOW });
    assert.equal(result.outcome, 'created');
    assert.equal(result.candidates?.length, 1);
    assert.equal(result.candidates?.[0]?.content, 'Safe generated memory');
    assert.equal(count(fx.db, 'memory_candidate_entries'), 1);
    assert.ok(warnings.length > 0);
    assert.ok(!warnings.join(' ').includes(SECRET), 'skip diagnostics must not echo the secret');
  } finally {
    console.warn = originalWarn;
    fx.close();
  }
});

// F2: direct-turn accumulation uses the same per-database detector and continues after an unsafe draft.
test('F2 direct accumulation skips unsafe draft and persists a safe draft', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentos-memory-secret-accumulation-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({
    workspaces: [{
      id: 'ws_memory_secret_accumulation',
      name: 'Secret boundary accumulation test',
      rootPath: root,
      gitEnabled: true,
      memoryEnabled: true,
      agents: [{ id: 'codex', name: 'Codex', role: 'codex', enabled: true, cliCommand: 'codex', cliArgs: [] }],
      lastOpenedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    }],
  }), 'utf8');

  let store: SqliteStore | undefined;
  try {
    store = new SqliteStore(root);
    const workspaceId = 'ws_memory_secret_accumulation';
    const detector = eventRedactionServiceForDatabase(store.getDatabase());
    detector.registerSecrets(workspaceId, [SECRET]);
    assert.equal(eventRedactionServiceForDatabase(store.getDatabase()), detector);

    const conversations = store.conversationRepository();
    const conversationId = 'conversation-secret-boundary';
    conversations.createConversation({ id: conversationId, workspaceId, kind: 'direct', title: 'Direct', createdAt: NOW });
    const sourceMessageId = 'message-secret-boundary-source';
    const responseMessageId = 'message-secret-boundary-reply';
    conversations.appendMessage({
      id: sourceMessageId, workspaceId, conversationId, senderType: 'user', kind: 'text',
      status: 'final', content: 'Use a safe workspace convention.', createdAt: NOW,
    });
    const stream = new ConversationStreamService(store.getDatabase(), conversations, store.agentTurnRepository());
    const turnId = 'turn-secret-boundary';
    const reservation = stream.beginAgentTurnStream({
      workspaceId, conversationId, turnId, messageId: responseMessageId, agentId: 'codex',
      sourceMessageId, createdAt: NOW,
    });
    stream.finalizeStream({
      workspaceId, turnId, messageId: responseMessageId,
      expectedTurnVersion: reservation.turn.version,
      expectedMessageVersion: reservation.message.version,
      outcome: 'final', content: 'The safe answer is to keep the convention documented.', updatedAt: NOW,
    });

    const service = new MemorySourceAccumulationService(store, {
      extractor: {
        extract: () => ({
          drafts: [
            {
              type: 'decision', title: 'Unsafe accumulated draft', summary: 'Contains a known value',
              content: 'Accumulated value ' + SECRET, confidence: 90, operation: 'create',
            },
            {
              type: 'decision', title: 'Safe accumulated draft', summary: 'A safe reviewed decision',
              content: 'Keep the durable workspace convention.', confidence: 90, operation: 'create',
            },
          ],
          reason: 'public_evidence',
        }),
      } as never,
    });
    const result = service.generateForDirectTurn({
      workspaceId, conversationId, turnId, sourceMessageId, responseMessageId, createdAt: NOW,
    });
    assert.equal(result.outcome, 'created');
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0]?.title, 'Safe accumulated draft');
    assert.equal(result.candidates[0]?.content, 'Keep the durable workspace convention.');
    assert.equal(count(store.getDatabase() as unknown as SqliteDb, 'memory_candidate_entries'), 1);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
