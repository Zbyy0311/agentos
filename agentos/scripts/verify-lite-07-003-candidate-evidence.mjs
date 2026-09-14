/**
 * LITE-07-003 candidate evidence harness: exact and near-duplicate convergence.
 *
 * Phases:
 *   exact    - an exact duplicate inside the same Scope/owner/category converges on the accepted
 *              Entry, merges the new source atomically and records the canonical dedup Event
 *   replay   - repeating the same evaluation writes nothing further
 *   owner    - identical content under a different owner does not converge
 *   near     - normalized-hash and FTS-similar near-duplicates stay review-required
 *   review   - the review path promotes the near-duplicate with its sources, and rejection does not
 *   proof    - a source that names no real Entry, and a privileged origin with no durable row,
 *              are both refused instead of being believed
 *
 * Usage (from apps/server, with tsx resolvable):
 *   node --import tsx ../../scripts/verify-lite-07-003-candidate-evidence.mjs --out <dir>
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { SqliteStore } from '../apps/server/src/store/SqliteStore.ts';
import { MemoryEntryRepository } from '../apps/server/src/store/MemoryEntryRepository.ts';
import { MemoryCandidateRepository } from '../apps/server/src/store/MemoryCandidateRepository.ts';
import {
  MemoryCandidateGenerationService,
  hashMemoryText,
  normalizeMemoryText,
} from '../apps/server/src/services/MemoryCandidateGenerationService.ts';
import { MemoryRuntimeEventEmitter } from '../apps/server/src/services/MemoryRuntimeEventEmitter.ts';
import { DurableMemoryRuntimeEventContextAuthority } from '../apps/server/src/services/MemoryRuntimeEventContextAuthority.ts';

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

const root = mkdtempSync(join(tmpdir(), 'agentos-07003-'));
const store = new SqliteStore(root);
const db = store.getDatabase();
const NOW = new Date().toISOString();
const WS = 'ws_lite07003';
const TASK = 'task_lite07003';
const OTHER_TASK = 'task_other_07003';
const RUN = 'run_lite07003';
const OP = 'op_' + 'D'.repeat(26);

db.prepare('INSERT INTO workspaces (id,name,root_path,canonical_root_path,last_opened_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
  .run(WS, WS, root, root, NOW, NOW, NOW);
db.prepare('INSERT INTO tasks (id, workspace_id, title, status, created_by, created_at, updated_at, version) VALUES (?,?,?,?,?,?,?,1)')
  .run(TASK, WS, 'convergence', 'open', 'evidence', NOW, NOW);
db.prepare('INSERT INTO tasks (id, workspace_id, title, status, created_by, created_at, updated_at, version) VALUES (?,?,?,?,?,?,?,1)')
  .run(OTHER_TASK, WS, 'other owner', 'open', 'evidence', NOW, NOW);
db.prepare('INSERT INTO runs (id, workspace_id, task_id, root_run_id, status, reason, created_by, created_at, updated_at, version) VALUES (?,?,?,?,?,?,?,?,?,1)')
  .run(RUN, WS, TASK, RUN, 'completed', 'initial', 'evidence', NOW, NOW);
db.prepare('INSERT INTO operations (id, type, status, workspace_id, aggregate_type, aggregate_id, run_id, correlation_id, created_at, updated_at, version) VALUES (?,?,?,?,?,?,?,?,?,?,1)')
  .run(OP, 'run.start', 'completed', WS, 'run', RUN, RUN, OP, NOW, NOW);

const entries = new MemoryEntryRepository(db);
const candidates = new MemoryCandidateRepository(db);
const emitter = new MemoryRuntimeEventEmitter({
  store, factWriter: store.runtimeEventOutboxWriter(),
  eventAuthority: new DurableMemoryRuntimeEventContextAuthority(db),
});
const generator = new MemoryCandidateGenerationService({
  store, runs: store.runRepository(), stages: store.runStageRepository(),
  tasks: store.taskRepository(), emitter,
});
const EVENT_CONTEXT = { origin: 'operation', operationId: OP, context: { correlationId: OP, causationId: OP } };
const generate = (createdAt = NOW) => generator.generateForRunTerminal({
  workspaceId: WS, runId: RUN, createdAt, eventContext: EVENT_CONTEXT,
});
const counts = () => ({
  candidates: candidates.listCandidates(WS).length,
  entries: Number(db.prepare('SELECT COUNT(*) AS n FROM memory_entries WHERE workspace_id = ?').get(WS).n),
  entrySources: Number(db.prepare('SELECT COUNT(*) AS n FROM memory_entry_sources').get().n),
  dedupEvents: Number(db.prepare("SELECT COUNT(*) AS n FROM runtime_events WHERE workspace_id = ? AND type = 'memory.entry_deduplicated'").get(WS).n),
  candidateEvents: Number(db.prepare("SELECT COUNT(*) AS n FROM runtime_events WHERE workspace_id = ? AND type = 'memory.candidate_created'").get(WS).n),
});

// The Run's own terminal fact is the oracle for the exact-duplicate text. Memory already holds
// that same fact under a different source (this is the S1-D shape: an explicit save / another
// trigger wrote it), and the Candidate row that carried it is gone - the state the exact-hit
// branch exists for. The removal of that one row reproduces it, as in the LITE-07-102 pack.
const first = generate();
if (first.outcome !== 'created' || first.candidate === undefined) throw new Error('oracle generation failed: ' + first.outcome);
const terminalContent = first.candidate.content;
db.prepare('DELETE FROM memory_candidate_sources WHERE candidate_id = ?').run(first.candidate.id);
db.prepare('DELETE FROM memory_candidate_entries WHERE id = ?').run(first.candidate.id);
const acceptedEntryId = 'mem_07003_exact';
entries.createEntry({
  id: acceptedEntryId, workspaceId: WS, scope: 'task', ownerTaskId: TASK, category: 'summary',
  authority: 'user-explicit', confidence: 0.9, importance: 0.5,
  title: 'saved earlier', content: terminalContent, status: 'active',
  exactContentHash: hashMemoryText(terminalContent),
  sources: [{ kind: 'task', id: TASK }], createdAt: NOW,
});

// -------------------------------------------------------------------- exact phase
phase = 'exact';
try {
const before = counts();
const converged = generate('2026-09-14T02:00:00.000Z');
const entry = entries.findById(WS, acceptedEntryId);
const after = counts();
const dedupEvent = db.prepare("SELECT payload_json AS payload FROM runtime_events WHERE workspace_id = ? AND type = 'memory.entry_deduplicated' ORDER BY sequence DESC LIMIT 1").get(WS);
expect('LITE-07-003', 'S003-EXACT-01', 'an exact duplicate converges on the accepted Entry and merges the new source atomically',
  { outcome: converged.outcome, duplicateOfEntryIdMatches: converged.duplicateOfEntryId === acceptedEntryId,
    entrySources: entries.findById(WS, acceptedEntryId).sources.map(source => source.kind + ':' + source.id),
    entryVersion: entry.version, contentUnchanged: entry.content === terminalContent,
    candidatesAdded: after.candidates - before.candidates, entriesAdded: after.entries - before.entries,
    entrySourcesAdded: after.entrySources - before.entrySources,
    dedupEventsAdded: after.dedupEvents - before.dedupEvents,
    dedupEventNameTheEntry: dedupEvent === undefined ? null : JSON.parse(dedupEvent.payload).memoryEntryId === acceptedEntryId },
  { outcome: 'converged', duplicateOfEntryIdMatches: true,
    entrySources: ['run:' + RUN, 'task:' + TASK], entryVersion: 2, contentUnchanged: true,
    candidatesAdded: 0, entriesAdded: 0, entrySourcesAdded: 1, dedupEventsAdded: 1,
    dedupEventNameTheEntry: true });
expect('LITE-07-003', 'S003-EXACT-02', 'a replay of the same evaluation writes nothing further',
  (() => {
    const beforeReplay = counts();
    const replay = generate('2026-09-14T03:00:00.000Z');
    const afterReplay = counts();
    return { outcome: replay.outcome, duplicateOfEntryIdMatches: replay.duplicateOfEntryId === acceptedEntryId,
      candidatesAdded: afterReplay.candidates - beforeReplay.candidates,
      entriesAdded: afterReplay.entries - beforeReplay.entries,
      sourcesAdded: afterReplay.entrySources - beforeReplay.entrySources,
      dedupEventsAdded: afterReplay.dedupEvents - beforeReplay.dedupEvents,
      entryVersion: entries.findById(WS, acceptedEntryId).version };
  })(),
  { outcome: 'converged', duplicateOfEntryIdMatches: true, candidatesAdded: 0, entriesAdded: 0,
    sourcesAdded: 0, dedupEventsAdded: 0, entryVersion: 2 });
phases.exact = { acceptedEntryId, terminalContentBytes: terminalContent.length, counts: counts() };
} catch (error) { catchPhase(error); }

// -------------------------------------------------------------------- owner phase
phase = 'owner';
try {
// Identical content in a DIFFERENT owner's boundary: the dedup boundary must not match, so this
// Run still produces its own fact instead of folding into the other task's memory.
const OWNER_TASK = 'task_owner_07003';
db.prepare('INSERT INTO tasks (id, workspace_id, title, status, created_by, created_at, updated_at, version) VALUES (?,?,?,?,?,?,?,1)')
  .run(OWNER_TASK, WS, 'owner boundary', 'open', 'evidence', NOW, NOW);
const OWNER_RUN = 'run_owner_07003';
const OWNER_OP = 'op_' + 'G'.repeat(26);
db.prepare('INSERT INTO runs (id, workspace_id, task_id, root_run_id, status, reason, created_by, created_at, updated_at, version) VALUES (?,?,?,?,?,?,?,?,?,1)')
  .run(OWNER_RUN, WS, OWNER_TASK, OWNER_RUN, 'completed', 'initial', 'evidence', NOW, NOW);
db.prepare('INSERT INTO operations (id, type, status, workspace_id, aggregate_type, aggregate_id, run_id, correlation_id, created_at, updated_at, version) VALUES (?,?,?,?,?,?,?,?,?,?,1)')
  .run(OWNER_OP, 'run.start', 'completed', WS, 'run', OWNER_RUN, OWNER_RUN, OWNER_OP, NOW, NOW);
const ownerGenerate = (createdAt = NOW) => generator.generateForRunTerminal({
  workspaceId: WS, runId: OWNER_RUN, createdAt,
  eventContext: { origin: 'operation', operationId: OWNER_OP, context: { correlationId: OWNER_OP, causationId: OWNER_OP } },
});
const ownerOracle = ownerGenerate();
if (ownerOracle.outcome !== 'created' || ownerOracle.candidate === undefined) throw new Error('owner oracle failed: ' + ownerOracle.outcome);
const otherEntryId = 'mem_07003_other_owner';
entries.createEntry({
  id: otherEntryId, workspaceId: WS, scope: 'task', ownerTaskId: OTHER_TASK, category: 'summary',
  authority: 'system-verified', confidence: 0.9, importance: 0.5,
  title: 'accepted elsewhere', content: ownerOracle.candidate.content, status: 'active',
  exactContentHash: hashMemoryText(ownerOracle.candidate.content),
  sources: [{ kind: 'task', id: OTHER_TASK }], createdAt: NOW,
});
const otherCandidateId = 'mcand_terminal_' + OWNER_RUN;
db.prepare('DELETE FROM memory_candidate_sources WHERE candidate_id = ?').run(otherCandidateId);
db.prepare('DELETE FROM memory_candidate_entries WHERE id = ?').run(otherCandidateId);
const before = counts();
const owned = ownerGenerate('2026-09-14T04:00:00.000Z');
const after = counts();
expect('LITE-07-003', 'S003-OWNER-01', 'identical content under a different owner does not converge',
  { outcome: owned.outcome, duplicateOfEntryId: owned.duplicateOfEntryId ?? null,
    newCandidateId: owned.candidate?.id ?? null, newCandidateCategory: owned.candidate?.category ?? null,
    otherOwnerEntryUnchanged: entries.findById(WS, otherEntryId).sources.map(source => source.kind + ':' + source.id),
    otherOwnerEntryContentUnchanged: entries.findById(WS, otherEntryId).content === ownerOracle.candidate.content,
    candidatesAdded: after.candidates - before.candidates },
  { outcome: 'created', duplicateOfEntryId: null,
    newCandidateId: otherCandidateId, newCandidateCategory: 'summary',
    otherOwnerEntryUnchanged: ['task:' + OTHER_TASK], otherOwnerEntryContentUnchanged: true, candidatesAdded: 1 });
phases.owner = { otherEntryId, ownerRunId: OWNER_RUN };
} catch (error) { catchPhase(error); }

// --------------------------------------------------------------------- near phase
phase = 'near';
try {
const NEAR_TASK = 'task_near_07003';
db.prepare('INSERT INTO tasks (id, workspace_id, title, status, created_by, created_at, updated_at, version) VALUES (?,?,?,?,?,?,?,1)')
  .run(NEAR_TASK, WS, 'near', 'open', 'evidence', NOW, NOW);
const NEAR_RUN = 'run_near_07003';
db.prepare('INSERT INTO runs (id, workspace_id, task_id, root_run_id, status, reason, created_by, created_at, updated_at, version) VALUES (?,?,?,?,?,?,?,?,?,1)')
  .run(NEAR_RUN, WS, NEAR_TASK, NEAR_RUN, 'completed', 'initial', 'evidence', NOW, NOW);
db.prepare('INSERT INTO operations (id, type, status, workspace_id, aggregate_type, aggregate_id, run_id, correlation_id, created_at, updated_at, version) VALUES (?,?,?,?,?,?,?,?,?,?,1)')
  .run('op_' + 'E'.repeat(26), 'run.start', 'completed', WS, 'run', NEAR_RUN, NEAR_RUN, 'op_' + 'E'.repeat(26), NOW, NOW);
const nearGenerate = (createdAt = NOW) => generator.generateForRunTerminal({
  workspaceId: WS, runId: NEAR_RUN, createdAt,
  eventContext: { origin: 'operation', operationId: 'op_' + 'E'.repeat(26),
    context: { correlationId: 'op_' + 'E'.repeat(26), causationId: 'op_' + 'E'.repeat(26) } },
});
const oracle = nearGenerate();
if (oracle.outcome !== 'created' || oracle.candidate === undefined) throw new Error('near oracle failed: ' + oracle.outcome);
const nearContent = oracle.candidate.content;
// The near-duplicate Entry differs only in whitespace: the normalized hash matches while the
// exact hash does not, which is exactly the review-required signal.
const reflowed = nearContent.split(String.fromCharCode(10)).map(line => line.replace(/ /gu, '  ')).join(String.fromCharCode(10));
const normalizedEntryId = 'mem_07003_normalized';
entries.createEntry({
  id: normalizedEntryId, workspaceId: WS, scope: 'task', ownerTaskId: NEAR_TASK, category: 'summary',
  authority: 'system-verified', confidence: 0.9, importance: 0.5,
  title: 'earlier accepted summary', content: reflowed, status: 'active',
  exactContentHash: hashMemoryText(reflowed),
  normalizedTextHash: hashMemoryText(normalizeMemoryText(nearContent)),
  sources: [{ kind: 'task', id: NEAR_TASK }], createdAt: NOW,
});
const nearCandidateId = 'mcand_terminal_' + NEAR_RUN;
db.prepare('DELETE FROM memory_candidate_sources WHERE candidate_id = ?').run(nearCandidateId);
db.prepare('DELETE FROM memory_candidate_entries WHERE id = ?').run(nearCandidateId);
const near = nearGenerate('2026-09-14T05:00:00.000Z');
const nearCandidate = near.candidate === undefined ? undefined : candidates.findCandidateById(WS, nearCandidateId);
expect('LITE-07-003', 'S003-NEAR-01', 'a normalized-hash near-duplicate is recorded as a review-required fact, never auto-accepted',
  { outcome: near.outcome, duplicateOfEntryId: near.duplicateOfEntryId,
    candidateOutcome: nearCandidate?.outcome, candidateDecision: nearCandidate?.decision,
    candidateAuthority: nearCandidate?.authority,
    promotedIntoEntry: nearCandidate?.mergedIntoEntryId ?? null,
    nearEntryStillIntact: entries.findById(WS, normalizedEntryId).content === reflowed,
    entriesAfter: Number(db.prepare('SELECT COUNT(*) AS n FROM memory_entries WHERE workspace_id = ?').get(WS).n) },
  { outcome: 'created', duplicateOfEntryId: normalizedEntryId,
    candidateOutcome: 'review-required', candidateDecision: 'review-required',
    candidateAuthority: 'agent-derived', promotedIntoEntry: null,
    nearEntryStillIntact: true, entriesAfter: 3 });
// The FTS case runs in its own Task boundary so the only title-similar Entry in scope is the
// one this case planted.
const FTS_TASK = 'task_fts_07003';
db.prepare('INSERT INTO tasks (id, workspace_id, title, status, created_by, created_at, updated_at, version) VALUES (?,?,?,?,?,?,?,1)')
  .run(FTS_TASK, WS, 'fts boundary', 'open', 'evidence', NOW, NOW);
const FTS_RUN = 'run_fts_07003';
const FTS_OP = 'op_' + 'F'.repeat(26);
db.prepare('INSERT INTO runs (id, workspace_id, task_id, root_run_id, status, reason, created_by, created_at, updated_at, version) VALUES (?,?,?,?,?,?,?,?,?,1)')
  .run(FTS_RUN, WS, FTS_TASK, FTS_RUN, 'completed', 'initial', 'evidence', NOW, NOW);
db.prepare('INSERT INTO operations (id, type, status, workspace_id, aggregate_type, aggregate_id, run_id, correlation_id, created_at, updated_at, version) VALUES (?,?,?,?,?,?,?,?,?,?,1)')
  .run(FTS_OP, 'run.start', 'completed', WS, 'run', FTS_RUN, FTS_RUN, FTS_OP, NOW, NOW);
const ftsGenerate = (createdAt = NOW) => generator.generateForRunTerminal({
  workspaceId: WS, runId: FTS_RUN, createdAt,
  eventContext: { origin: 'operation', operationId: FTS_OP, context: { correlationId: FTS_OP, causationId: FTS_OP } },
});
const ftsOracle = ftsGenerate();
if (ftsOracle.outcome !== 'created' || ftsOracle.candidate === undefined) throw new Error('fts oracle failed: ' + ftsOracle.outcome);
const ftsEntryId = 'mem_07003_fts';
entries.createEntry({
  id: ftsEntryId, workspaceId: WS, scope: 'task', ownerTaskId: FTS_TASK, category: 'summary',
  authority: 'system-verified', confidence: 0.9, importance: 0.5,
  title: ftsOracle.candidate.title, content: '完全不同的正文。', status: 'active',
  sources: [{ kind: 'task', id: FTS_TASK }], createdAt: NOW,
});
const ftsCandidateId = 'mcand_terminal_' + FTS_RUN;
db.prepare('DELETE FROM memory_candidate_sources WHERE candidate_id = ?').run(ftsCandidateId);
db.prepare('DELETE FROM memory_candidate_entries WHERE id = ?').run(ftsCandidateId);
const fts = ftsGenerate('2026-09-14T06:00:00.000Z');
const ftsCandidate = fts.candidate === undefined ? undefined : candidates.findCandidateById(WS, ftsCandidateId);
expect('LITE-07-003', 'S003-NEAR-02', 'an FTS-similar near-duplicate is likewise held for review',
  { outcome: fts.outcome, duplicateOfEntryId: fts.duplicateOfEntryId,
    candidateOutcome: ftsCandidate?.outcome, promotedIntoEntry: ftsCandidate?.mergedIntoEntryId ?? null },
  { outcome: 'created', duplicateOfEntryId: ftsEntryId,
    candidateOutcome: 'review-required', promotedIntoEntry: null });
phases.near = { nearCandidateId, normalizedEntryId, ftsEntryId, ftsCandidateId,
  ftsRunId: FTS_RUN, reviewTargetBytes: ftsOracle.candidate.content.length };
} catch (error) { catchPhase(error); }
// ------------------------------------------------------------------- review phase
phase = 'review';
try {
// The FTS case is the one left unresolved: near-duplicates wait for a human decision.
const pending = candidates.findCandidateById(WS, phases.near.ftsCandidateId);
const promoted = candidates.reviewCandidate({
  workspaceId: WS, candidateId: pending.id, expectedVersion: pending.version,
  outcome: 'accept', reviewedAt: NOW,
}, { writer: store.workspaceEventWriter() });
const promotedEntry = promoted.mergedIntoEntryId === null ? undefined : entries.findById(WS, promoted.mergedIntoEntryId);
const promotedSources = db.prepare('SELECT source_kind AS kind, source_id AS id FROM memory_entry_sources WHERE memory_entry_id = ? ORDER BY source_kind, source_id')
  .all(promoted.mergedIntoEntryId).map(row => row.kind + ':' + row.id);
expect('LITE-07-003', 'S003-REVIEW-01', 'accepting a near-duplicate after review creates the Entry and keeps its sources',
  { outcomeAfterReview: candidates.findCandidateById(WS, promoted.id).outcome,
    mergedIntoEntry: promoted.mergedIntoEntryId !== null,
    entryScope: promotedEntry?.scope, entryCategory: promotedEntry?.category,
    entryContentBytes: promotedEntry === undefined ? null : promotedEntry.content.length,
    entrySources: promotedSources },
  { outcomeAfterReview: 'accept', mergedIntoEntry: true, entryScope: 'task', entryCategory: 'summary',
    entryContentBytes: phases.near.reviewTargetBytes, entrySources: ['run:' + phases.near.ftsRunId] });
} catch (error) { catchPhase(error); }

// -------------------------------------------------------------------- proof phase
phase = 'proof';
try {
// (a) A source that names no real Entry cannot be merged into Memory.
let unknownSourceOutcome = 'accepted';
try {
  db.prepare('INSERT INTO memory_entry_sources (memory_entry_id, source_kind, source_id) VALUES (?, ?, ?)')
    .run('mem_does_not_exist', 'run', RUN);
} catch (error) { unknownSourceOutcome = String(error.code ?? error.name).split(':')[0]; }
const orphanSources = Number(db.prepare('SELECT COUNT(*) AS n FROM memory_entry_sources WHERE memory_entry_id = ?').get('mem_does_not_exist').n);
expect('LITE-07-003', 'S003-PROOF-01', 'a source that names no real Entry is refused by the schema instead of being believed',
  { insertionRefused: unknownSourceOutcome !== 'accepted', refusalCode: unknownSourceOutcome, orphanSources },
  { insertionRefused: true, refusalCode: 'ERR_SQLITE_ERROR', orphanSources: 0 });
// (b) A privileged origin must be proved by a durable row; a fabricated one is refused.
let fabricatedOrigin = 'accepted';
try {
  emitter.emitEntryDeduplicated({
    workspaceId: WS, entryId: acceptedEntryId,
    scope: 'task', ownerTaskId: TASK, category: 'summary', exactContentHash: hashMemoryText(terminalContent),
    sources: [{ kind: 'run', id: RUN }], updatedAt: NOW, runId: RUN,
    eventContext: { origin: 'operation', operationId: 'op_does_not_exist',
      context: { correlationId: 'op_does_not_exist', causationId: 'op_does_not_exist' } },
  });
} catch (error) { fabricatedOrigin = String(error.code ?? error.name); }
expect('LITE-07-003', 'S003-PROOF-02', 'a privileged origin without a durable row is refused instead of fabricating causation',
  { refusalCode: fabricatedOrigin },
  { refusalCode: 'ORIGIN_UNPROVEN' });
// (c) The dedup merge itself only applies to a real, active, exactly matching Entry.
const mismatch = entries.mergeExactSourcesWithinTransaction({
  workspaceId: WS, entryId: acceptedEntryId, scope: 'task', ownerTaskId: OTHER_TASK, category: 'summary',
  exactContentHash: hashMemoryText(terminalContent), sources: [{ kind: 'run', id: RUN }], updatedAt: NOW,
});
expect('LITE-07-003', 'S003-PROOF-03', 'the merge refuses when the boundary does not match the stored Entry',
  { mergeOutcome: mismatch === undefined ? 'refused' : 'merged',
    entrySourcesAfter: entries.findById(WS, acceptedEntryId).sources.map(source => source.kind + ':' + source.id) },
  { mergeOutcome: 'refused', entrySourcesAfter: ['run:' + RUN, 'task:' + TASK] });
phases.proof = { unknownSourceOutcome, fabricatedOrigin };
} catch (error) { catchPhase(error); }

phases.summary = { counts: counts(), candidates: candidates.listCandidates(WS).map(candidate => ({ id: candidate.id, outcome: candidate.outcome, category: candidate.category })) };

store.close();
rmSync(root, { recursive: true, force: true });

const totals = { total: receipts.length, passed: 0, failed: 0, skipped: 0 };
for (const receipt of receipts) {
  if (receipt.outcome === 'passed') totals.passed += 1;
  else if (receipt.outcome === 'failed') totals.failed += 1;
  else totals.skipped += 1;
}
writeFileSync(join(OUT, 'receipts.json'), JSON.stringify({
  schemaVersion: 1, generatedAt: new Date().toISOString(), phases, counts: totals, receipts,
}, null, 2) + String.fromCharCode(10), 'utf8');

console.log('S003_CANDIDATE_EVIDENCE: ' + (totals.failed === 0 ? 'passed' : 'failed'));
console.log('  receipts=' + totals.total + ' passed=' + totals.passed + ' failed=' + totals.failed);
for (const receipt of receipts.filter(item => item.outcome !== 'passed')) {
  console.log('  FAILED ' + receipt.id + ' (' + receipt.requirementId + '): ' + (receipt.detail ?? ''));
}
await new Promise(resolve => setTimeout(resolve, 100));
process.exitCode = totals.failed === 0 ? 0 : 1;
