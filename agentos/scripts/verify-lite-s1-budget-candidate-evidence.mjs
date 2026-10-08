/**
 * LITE S1 retrieval/budget candidate evidence harness.
 *
 * Phases:
 *   budget      - the five budget dimensions on the production applyBudget
 *   eligibility - temporal and access eligibility plus the FTS-degraded status
 *
 * Every assertion records its own actual/expected values, so coverage can be checked
 * clause by clause instead of trusting a suite-level pass.
 *
 * Usage (from apps/server, with tsx resolvable):
 *   node --import tsx ../../scripts/verify-lite-s1-budget-candidate-evidence.mjs --out <dir>
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { SqliteStore } from '../apps/server/src/store/SqliteStore.ts';
import { MemoryEntryRepository } from '../apps/server/src/store/MemoryEntryRepository.ts';
import { MemoryRetrievalService } from '../apps/server/src/services/MemoryRetrievalService.ts';
import { applyBudget, estimateInjectedTokens } from '../apps/server/src/services/MemoryContextBudgetSelector.ts';

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const OUT = resolve(argValue('--out') ?? '.');
mkdirSync(OUT, { recursive: true });

const receipts = [];
const phases = {};
let phase = 'setup';
class ReceiptFailure extends Error {}

function expect(requirementId, id, step, actual, expected) {
  let passed = true;
  let detail;
  try { assert.deepEqual(actual, expected); }
  catch (error) { passed = false; detail = String(error.message).split('\n')[0]; }
  receipts.push({ id, requirementId, phase, step, actual, expected, outcome: passed ? 'passed' : 'failed',
    ...(detail === undefined ? {} : { detail }) });
  if (!passed) throw new ReceiptFailure(id);
  return actual;
}

function catchPhase(error) {
  if (!(error instanceof ReceiptFailure)) throw error;
  phases[phase] = { ...(phases[phase] ?? {}), failedReceipt: error.message };
}

const root = mkdtempSync(join(tmpdir(), 'agentos-s1-budget-'));
const store = new SqliteStore(root);
const db = store.getDatabase();
const NOW = '2026-09-14T00:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const WS = 'ws_s1_budget';
const TASK = 'task_s1_budget';
const RUN = 'run_s1_budget';

db.prepare('INSERT INTO workspaces (id,name,root_path,canonical_root_path,last_opened_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
  .run(WS, WS, root, root, NOW, NOW, NOW);
db.prepare('INSERT INTO tasks (id, workspace_id, title, status, created_by, created_at, updated_at, version) VALUES (?,?,?,?,?,?,?,1)')
  .run(TASK, WS, 'task', 'open', 'evidence', NOW, NOW);
db.prepare('INSERT INTO runs (id, workspace_id, task_id, root_run_id, status, reason, created_by, created_at, updated_at, version) VALUES (?,?,?,?,?,?,?,?,?,1)')
  .run(RUN, WS, TASK, RUN, 'queued', 'initial', 'evidence', NOW, NOW);

const BASE_BUDGET = {
  maxTokens: 1000, maxEntries: 10, perScopeLimits: {}, perCategoryLimits: {},
  minConfidence: 0.5, minImportance: 0.3, maxTruncation: 1, requireDiversity: false,
};

/** One ranked Entry as the retrieval layer hands it to the budget. */
function ranked(id, overrides = {}) {
  return {
    rank: 1, score: 1, reasons: [],
    entry: {
      id, scope: 'task', category: 'decision', confidence: 0.9, importance: 0.5,
      authority: 'system-verified', version: 1, sources: [], pinned: 0,
      title: id, content: 'content of ' + id, tokenEstimate: 1, ...overrides,
    },
  };
}

const reasonsOf = (outcome) => Object.fromEntries(outcome.exclusions.map(item => [item.memoryId, item.reason]));
const selectedIds = (outcome) => outcome.selected.map(item => item.entry.id);

// ------------------------------------------------------------------ budget phase
phase = 'budget';
try {
const longContent = 'The runtime keeps Tasks, Runs and Processes distinct. '.repeat(9);
const longEntry = ranked('mem_long', { title: 'long', content: longContent, tokenEstimate: 1 });
const shortEntry = ranked('mem_short', { title: 'short', content: 'tiny', tokenEstimate: 9999 });
const longCost = estimateInjectedTokens(longEntry.entry);
const shortCost = estimateInjectedTokens(shortEntry.entry);
// The contract is chars/4 over the text that is injected ("### <title>\n<content>"), computed
// here independently so the receipt shows why the number is what it is.
const longInjectedText = '### long\n' + longContent;
const priced = applyBudget([shortEntry, longEntry], { ...BASE_BUDGET, maxTokens: shortCost, maxTruncation: 0 });
expect('LITE-07-007', 'S1E-PRICING-01', 'an Entry is priced by the text that is actually injected, not by its stored estimate',
  { injectedText: '### short\ntiny', longInjectedTokens: longCost, shortInjectedTokens: shortCost,
    storedEstimates: { long: longEntry.entry.tokenEstimate, short: shortEntry.entry.tokenEstimate },
    selected: selectedIds(priced), totalTokens: priced.totalTokens, reasons: reasonsOf(priced) },
  { injectedText: '### short\ntiny', longInjectedTokens: Math.ceil(longInjectedText.length / 4), shortInjectedTokens: 4,
    storedEstimates: { long: 1, short: 9999 },
    selected: ['mem_short'], totalTokens: shortCost, reasons: { mem_long: 'token-budget' } });

const thresholds = applyBudget([
  ranked('mem_low_confidence', { confidence: 0.2 }),
  ranked('mem_low_importance', { importance: 0.1 }),
  ranked('mem_ok'),
], BASE_BUDGET);
expect('LITE-07-007', 'S1E-THRESHOLD-01', 'confidence and importance thresholds exclude with their own reason',
  { selected: selectedIds(thresholds), reasons: reasonsOf(thresholds) },
  { selected: ['mem_ok'], reasons: { mem_low_confidence: 'below-confidence', mem_low_importance: 'below-importance' } });

const counted = applyBudget([ranked('mem_a'), ranked('mem_b'), ranked('mem_c')], { ...BASE_BUDGET, maxEntries: 2 });
expect('LITE-07-007', 'S1E-COUNT-01', 'the Entry count budget excludes the overflow and records every considered Entry',
  { selected: selectedIds(counted), reasons: reasonsOf(counted),
    considered: counted.selected.length + counted.exclusions.length },
  { selected: ['mem_a', 'mem_b'], reasons: { mem_c: 'entry-budget' }, considered: 3 });

const scoped = applyBudget([
  ranked('mem_task_1', { scope: 'task' }),
  ranked('mem_task_2', { scope: 'task' }),
  ranked('mem_workspace', { scope: 'workspace' }),
], { ...BASE_BUDGET, perScopeLimits: { task: 1 } });
expect('LITE-07-007', 'S1E-SCOPE-01', 'a per-Scope limit is attributed to the Scope, not to the category',
  { selected: selectedIds(scoped), reasons: reasonsOf(scoped) },
  { selected: ['mem_task_1', 'mem_workspace'], reasons: { mem_task_2: 'scope-excluded' } });

const categoried = applyBudget([
  ranked('mem_decision_1', { category: 'decision' }),
  ranked('mem_decision_2', { category: 'decision' }),
  ranked('mem_knowledge', { category: 'knowledge' }),
], { ...BASE_BUDGET, perCategoryLimits: { decision: 1 } });
expect('LITE-07-007', 'S1E-CATEGORY-01', 'a per-category limit is attributed to the category',
  { selected: selectedIds(categoried), reasons: reasonsOf(categoried) },
  { selected: ['mem_decision_1', 'mem_knowledge'], reasons: { mem_decision_2: 'category-budget' } });

const diversified = applyBudget([
  ranked('mem_decision_1', { category: 'decision' }),
  ranked('mem_decision_2', { category: 'decision' }),
  ranked('mem_knowledge_1', { category: 'knowledge' }),
  ranked('mem_knowledge_2', { category: 'knowledge' }),
], { ...BASE_BUDGET, maxEntries: 2, requireDiversity: true });
expect('LITE-07-007', 'S1E-DIVERSITY-01', 'requireDiversity keeps the set from being monopolized and explains the exclusion',
  { selected: selectedIds(diversified), reasons: reasonsOf(diversified) },
  { selected: ['mem_decision_1', 'mem_knowledge_1'],
    reasons: { mem_decision_2: 'diversity-limit', mem_knowledge_2: 'entry-budget' } });

// Room for exactly one Entry: the second overflow is the bounded, explicit truncation and the
// third can no longer be truncated, so it is a plain token-budget exclusion.
const perEntryTokens = estimateInjectedTokens(ranked('mem_t1').entry);
const truncating = applyBudget([ranked('mem_t1'), ranked('mem_t2'), ranked('mem_t3')],
  { ...BASE_BUDGET, maxTokens: 2 * perEntryTokens - 1, maxTruncation: 1 });
expect('LITE-07-007', 'S1E-TRUNC-01', 'token-budget overflow is truncated explicitly and bounded, never silently',
  { selected: selectedIds(truncating), reasons: reasonsOf(truncating), truncated: truncating.truncated,
    totalTokens: truncating.totalTokens, perEntryTokens, budgetTokens: 2 * perEntryTokens - 1 },
  { selected: ['mem_t1'], reasons: { mem_t2: 'truncated', mem_t3: 'token-budget' }, truncated: true,
    totalTokens: perEntryTokens, perEntryTokens, budgetTokens: 2 * perEntryTokens - 1 });
} catch (error) { catchPhase(error); }

// ------------------------------------------------------------- eligibility phase
phase = 'eligibility';
try {
const entries = new MemoryEntryRepository(db);
const retrieval = new MemoryRetrievalService(entries, () => NOW_MS);
let seq = 0;
const addEntry = (overrides) => {
  seq += 1;
  const id = 'mem_' + String(seq).padStart(3, '0') + 'e'.repeat(20);
  entries.createEntry({
    id, workspaceId: WS, scope: 'task', ownerTaskId: TASK, category: 'knowledge',
    authority: 'system-verified', confidence: 0.9, importance: 0.6,
    title: 'entry ' + String(seq), summary: 'summary',
    content: 'the runtime keeps tasks runs and processes distinct ' + String(seq),
    tags: [], status: 'active', sources: [{ kind: 'run', id: RUN }], createdAt: NOW,
    ...overrides,
  });
  return id;
};
const inWindow = addEntry({ validFrom: '2026-09-01T00:00:00.000Z', validUntil: '2026-10-01T00:00:00.000Z' });
const noWindow = addEntry({});
const expired = addEntry({ expiresAt: '2026-09-13T00:00:00.000Z' });
const notYetValid = addEntry({ validFrom: '2026-10-01T00:00:00.000Z' });
const restricted = addEntry({ sensitivity: 'restricted' });
const expiresLater = addEntry({ expiresAt: '2026-12-01T00:00:00.000Z' });
const results = retrieval.retrieveWithStatus({ context: { workspaceId: WS, taskId: TASK, runId: RUN }, query: 'runtime' });
expect('LITE-07-109', 'S1E-ELIGIBILITY-01', 'temporal and access eligibility decide before ranking',
  { now: NOW, returned: results.results.map(item => item.entry.id).sort(), degraded: results.degraded,
    excludedIdsPresent: [expired, notYetValid, restricted].filter(id => results.results.some(item => item.entry.id === id)) },
  { now: NOW, returned: [inWindow, noWindow, expiresLater].sort(), degraded: false, excludedIdsPresent: [] });
const degraded = retrieval.retrieveWithStatus({ context: { workspaceId: WS, taskId: TASK, runId: RUN }, query: '***' });
expect('LITE-07-109', 'S1E-DEGRADED-01', 'a query with no usable FTS tokens reports degraded while structured filters stay authoritative',
  { degraded: degraded.degraded, rankedResults: degraded.results.map(item => item.entry.id).sort(),
    sameSetAsRankedQuery: JSON.stringify(degraded.results.map(item => item.entry.id).sort()) === JSON.stringify(results.results.map(item => item.entry.id).sort()),
    queryTextStored: Number(db.prepare('SELECT COUNT(*) AS n FROM memory_context_snapshots').get().n) },
  { degraded: true, rankedResults: [inWindow, noWindow, expiresLater].sort(), sameSetAsRankedQuery: true, queryTextStored: 0 });
phases.eligibility = { inWindow, noWindow, expired, notYetValid, restricted, expiresLater };
} catch (error) { catchPhase(error); }

store.close();
rmSync(root, { recursive: true, force: true });

const counts = { total: receipts.length, passed: 0, failed: 0, skipped: 0 };
for (const receipt of receipts) {
  if (receipt.outcome === 'passed') counts.passed += 1;
  else if (receipt.outcome === 'failed') counts.failed += 1;
  else counts.skipped += 1;
}

writeFileSync(join(OUT, 'receipts.json'), `${JSON.stringify({
  schemaVersion: 1, generatedAt: new Date().toISOString(), phases, counts, receipts,
}, null, 2)}\n`, 'utf8');

console.log(`S1_BUDGET_CANDIDATE_EVIDENCE: ${counts.failed === 0 ? 'passed' : 'failed'}`);
console.log(`  receipts=${counts.total} passed=${counts.passed} failed=${counts.failed}`);
for (const receipt of receipts.filter(item => item.outcome !== 'passed')) {
  console.log(`  FAILED ${receipt.id} (${receipt.requirementId}): ${receipt.detail ?? ''}`);
}
await new Promise(resolve => setTimeout(resolve, 100));
process.exitCode = counts.failed === 0 ? 0 : 1;
