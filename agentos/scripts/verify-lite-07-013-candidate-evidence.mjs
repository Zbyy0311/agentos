/**
 * LITE-07-013 candidate evidence harness: the FTS degraded mode on the real context path.
 *
 * Both Run contexts are resolved through the production MemoryContextResolver with the
 * production emitter, so the snapshot, its canonical Event and its Outbox row commit the way
 * the Run path commits them. The only difference between the two resolutions is the query:
 * the second one carries no usable FTS token, which is exactly what the retrieval service
 * reports as degraded.
 *
 * Usage (from apps/server, with tsx resolvable):
 *   node --import tsx ../../scripts/verify-lite-07-013-candidate-evidence.mjs --out <dir>
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { SqliteStore } from '../apps/server/src/store/SqliteStore.ts';
import { MemoryEntryRepository } from '../apps/server/src/store/MemoryEntryRepository.ts';
import { MemoryRetrievalService } from '../apps/server/src/services/MemoryRetrievalService.ts';
import { MemoryContextSnapshotRepository } from '../apps/server/src/store/MemoryContextSnapshotRepository.ts';
import { MemoryContextResolver } from '../apps/server/src/services/MemoryContextResolver.ts';
import { MemoryRuntimeEventEmitter } from '../apps/server/src/services/MemoryRuntimeEventEmitter.ts';
import { DurableMemoryRuntimeEventContextAuthority } from '../apps/server/src/services/MemoryRuntimeEventContextAuthority.ts';
import { MemoryContextBudgetSelector } from '../apps/server/src/services/MemoryContextBudgetSelector.ts';

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const OUT = resolve(argValue('--out', '.'));
mkdirSync(OUT, { recursive: true });

const receipts = [];
const phases = {};
let phase = 'setup';
class ReceiptFailure extends Error {}

function expect(requirementId, id, step, actual, expected) {
  let passed = true;
  let detail;
  try { assert.deepEqual(actual, expected); }
  catch (error) { passed = false; detail = String(error.message).split(String.fromCharCode(10))[0]; }
  receipts.push({ id, requirementId, phase, step, actual, expected,
    outcome: passed ? 'passed' : 'failed',
    ...(detail === undefined ? {} : { detail }) });
  if (!passed) throw new ReceiptFailure(id);
  return actual;
}

function catchPhase(error) {
  if (!(error instanceof ReceiptFailure)) throw error;
  phases[phase] = { ...(phases[phase] ?? {}), failedReceipt: error.message };
}

const root = mkdtempSync(join(tmpdir(), 'agentos-0713-'));
const store = new SqliteStore(root);
const db = store.getDatabase();
const NOW = new Date().toISOString();
const WS = 'ws_lite0713';
const TASK = 'task_lite0713';
const RUN = 'run_lite0713';
const AGENT = 'agent_lite0713';

db.prepare('INSERT INTO workspaces (id,name,root_path,canonical_root_path,last_opened_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
  .run(WS, WS, root, root, NOW, NOW, NOW);
db.prepare('INSERT INTO tasks (id, workspace_id, title, status, created_by, created_at, updated_at, version) VALUES (?,?,?,?,?,?,?,1)')
  .run(TASK, WS, 'degraded evidence', 'open', 'evidence', NOW, NOW);
db.prepare('INSERT INTO runs (id, workspace_id, task_id, root_run_id, status, reason, created_by, created_at, updated_at, version) VALUES (?,?,?,?,?,?,?,?,?,1)')
  .run(RUN, WS, TASK, RUN, 'queued', 'initial', 'evidence', NOW, NOW);

const entries = new MemoryEntryRepository(db);
entries.createEntry({
  id: 'mem_0713_shared', workspaceId: WS, scope: 'task', ownerTaskId: TASK, category: 'knowledge',
  authority: 'system-verified', confidence: 0.9, importance: 0.6,
  title: 'runtime invariant', summary: 'tasks runs processes',
  content: 'the runtime keeps tasks runs and processes distinct',
  tags: [], status: 'active', sources: [{ kind: 'task', id: TASK }], createdAt: NOW,
});

// The production composition the Run path uses: retrieval + emitter-backed resolver.
const retrieval = new MemoryRetrievalService(entries);
const snapshots = new MemoryContextSnapshotRepository(db);
const resolver = new MemoryContextResolver({
  store, retrieval, snapshots,
  selector: new MemoryContextBudgetSelector(retrieval, snapshots),
  emitter: new MemoryRuntimeEventEmitter({
    store, factWriter: store.runtimeEventOutboxWriter(),
    eventAuthority: new DurableMemoryRuntimeEventContextAuthority(db),
  }),
});
const budget = {
  maxTokens: 2000, maxEntries: 5, perScopeLimits: {}, perCategoryLimits: {},
  minConfidence: 0.5, minImportance: 0.3, maxTruncation: 1, requireDiversity: false,
};
const apiOperation = { id: 'op_' + 'B'.repeat(26), correlationId: 'op_' + 'B'.repeat(26) };
// The privileged origin is proved against a persisted Operation, so the fixture writes one the
// way the Run path does before any context is resolved.
db.prepare('INSERT INTO operations (id, type, status, workspace_id, aggregate_type, aggregate_id, run_id, correlation_id, created_at, updated_at, version) VALUES (?,?,?,?,?,?,?,?,?,?,1)')
  .run(apiOperation.id, 'run.start', 'queued', WS, 'run', RUN, RUN, apiOperation.correlationId, NOW, NOW);
const resolveWith = (query, runId, stageId) => resolver.resolve({
  workspaceId: WS, runId, taskId: TASK, stageId, agentId: AGENT,
  ...(query === undefined ? {} : { query }),
  budget, createdAt: NOW, eventContext: { origin: 'operation', operationId: apiOperation.id,
    context: { correlationId: apiOperation.correlationId, causationId: apiOperation.id } },
});

// ----------------------------------------------------------------- resolved phase
phase = 'resolved';
try {
// A real ranked query: FTS participates, so the snapshot must record a non-degraded run.
const ranked = resolveWith('tasks runs processes', RUN, 'stage_0713_ranked');
// A query whose FTS tokens are all neutralized: the retrieval service reports degraded while
// the structured ranking still produces a bounded selection.
const degraded = resolveWith('***', RUN, 'stage_0713_degraded');
const rankedRow = db.prepare('SELECT id, retrieval_degraded AS degraded FROM memory_context_snapshots WHERE id = ?').get(ranked.snapshot.id);
const degradedRow = db.prepare('SELECT id, retrieval_degraded AS degraded FROM memory_context_snapshots WHERE id = ?').get(degraded.snapshot.id);
expect('LITE-07-013', 'S0713-RESOLVE-01', 'the real Run context path records whether its retrieval ran degraded, per snapshot',
  { rankedSelectsEntry: ranked.snapshot.selected.length > 0,
    rankedSnapshotFlag: ranked.snapshot.retrievalDegraded,
    rankedDurableColumn: Number(rankedRow.degraded),
    degradedSelectsEntry: degraded.snapshot.selected.length > 0,
    degradedSnapshotFlag: degraded.snapshot.retrievalDegraded,
    degradedDurableColumn: Number(degradedRow.degraded),
    snapshotsDiffer: ranked.snapshot.id !== degraded.snapshot.id,
    sameSelectionEitherWay: JSON.stringify(ranked.snapshot.selected.map(item => item.memoryId))
      === JSON.stringify(degraded.snapshot.selected.map(item => item.memoryId)) },
  { rankedSelectsEntry: true, rankedSnapshotFlag: false, rankedDurableColumn: 0,
    degradedSelectsEntry: true, degradedSnapshotFlag: true, degradedDurableColumn: 1,
    snapshotsDiffer: true, sameSelectionEitherWay: true });
const readBack = snapshots.findById(WS, degraded.snapshot.id);
const rankedReadBack = snapshots.findById(WS, ranked.snapshot.id);
expect('LITE-07-013', 'S0713-RESOLVE-02', 'the flag survives the production read path and the injected text is unaffected by it',
  { degradedReadBack: readBack?.retrievalDegraded, rankedReadBack: rankedReadBack?.retrievalDegraded,
    degradedContextMatchesItsOwnSelection: degraded.contextText.includes('the runtime keeps tasks runs and processes distinct'),
    contextTextEqualsPersisted: degraded.contextText === snapshots.readContextText(WS, degraded.snapshot.id),
    eventsWritten: db.prepare("SELECT COUNT(*) AS n FROM runtime_events WHERE run_id = ? AND type = 'memory.context_created'").get(RUN).n,
    outboxMatchesEvents: Number(db.prepare('SELECT COUNT(*) AS c FROM outbox_messages WHERE aggregate_id = ?').get(RUN).c)
      === Number(db.prepare('SELECT COUNT(*) AS c FROM runtime_events WHERE run_id = ?').get(RUN).c) },
  { degradedReadBack: true, rankedReadBack: false,
    degradedContextMatchesItsOwnSelection: true, contextTextEqualsPersisted: true,
    eventsWritten: 2, outboxMatchesEvents: true });
phases.resolved = { rankedSnapshotId: ranked.snapshot.id, degradedSnapshotId: degraded.snapshot.id,
  degradedTokens: degraded.snapshot.totalTokens, rankedTokens: ranked.snapshot.totalTokens };
} catch (error) { catchPhase(error); }

// ------------------------------------------------------------------ default phase
phase = 'default';
try {
// The migration's default is what every pre-existing snapshot row reads as: the column is
// NOT NULL DEFAULT 0, so a row written before 031 reads as a non-degraded retrieval.
// Aliases must not begin with a SQL keyword token, so the nullability flag is named explicitly.
const column = db.prepare("SELECT name, type, [notnull] AS requiredFlag, dflt_value AS defaultValue FROM pragma_table_info('memory_context_snapshots') WHERE name = 'retrieval_degraded'").get();
const legacyRow = db.prepare('SELECT COUNT(*) AS n FROM memory_context_snapshots WHERE retrieval_degraded = 0').get();
expect('LITE-07-013', 'S0713-DEFAULT-01', 'the stored flag is a non-null boolean column defaulting to the non-degraded value',
  { column: column === undefined ? null : { name: column.name, type: column.type, notNull: Number(column.requiredFlag), defaultValue: column.defaultValue },
    nonDegradedRows: Number(legacyRow.n),
    totalSnapshots: Number(db.prepare('SELECT COUNT(*) AS n FROM memory_context_snapshots').get().n) },
  { column: { name: 'retrieval_degraded', type: 'INTEGER', notNull: 1, defaultValue: '0' },
    nonDegradedRows: 1, totalSnapshots: 2 });
} catch (error) { catchPhase(error); }

store.close();
rmSync(root, { recursive: true, force: true });

const counts = { total: receipts.length, passed: 0, failed: 0, skipped: 0 };
for (const receipt of receipts) {
  if (receipt.outcome === 'passed') counts.passed += 1;
  else if (receipt.outcome === 'failed') counts.failed += 1;
  else counts.skipped += 1;
}
writeFileSync(join(OUT, 'receipts.json'), JSON.stringify({
  schemaVersion: 1, generatedAt: new Date().toISOString(), phases, counts, receipts,
}, null, 2) + String.fromCharCode(10), 'utf8');

console.log('S0713_CANDIDATE_EVIDENCE: ' + (counts.failed === 0 ? 'passed' : 'failed'));
console.log('  receipts=' + counts.total + ' passed=' + counts.passed + ' failed=' + counts.failed);
for (const receipt of receipts.filter(item => item.outcome !== 'passed')) {
  console.log('  FAILED ' + receipt.id + ' (' + receipt.requirementId + '): ' + (receipt.detail ?? ''));
}
await new Promise(resolve => setTimeout(resolve, 100));
process.exitCode = counts.failed === 0 ? 0 : 1;
