/**
 * LITE S6 candidate evidence harness.
 *
 * Emits machine-readable assertion receipts (actual / expected / outcome) for the
 * compaction requirements, so a reader can check clause coverage instead of trusting a
 * suite-level pass. Phases:
 *
 *   real   - one compaction through the PRODUCTION engine against the real Codex CLI
 *   guard  - the durable single-holder and idempotent-source invariants, executed
 *   budget - the application hard-budget refusal on the production function
 *   stale  - the LITE-09-109 source validation on the production function
 *
 * Usage (from apps/server, with tsx resolvable and the codex CLI on PATH):
 *   node --import tsx ../../scripts/verify-lite-s6-candidate-evidence.mjs --out <dir>
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { SqliteStore } from '../apps/server/src/store/SqliteStore.ts';
import { ConversationCompactionService } from '../apps/server/src/services/ConversationCompactionService.ts';
import { ProviderCompactionSummarizer } from '../apps/server/src/services/ProviderCompactionSummarizer.ts';
import { SUMMARIZATION_CLI_PROFILES, summarizationIdentityFor } from '../apps/server/src/services/summarizationCliProfiles.ts';
import { CompactionRepository } from '../apps/server/src/store/CompactionRepository.ts';
import { MemoryCandidateRepository } from '../apps/server/src/store/MemoryCandidateRepository.ts';
import { inTransaction } from '../apps/server/src/store/Transaction.ts';
import { createEntityId } from '../apps/server/src/store/Identity.ts';
import { ConversationRepository } from '../apps/server/src/store/ConversationRepository.ts';
import { AgentTurnRepository } from '../apps/server/src/store/AgentTurnRepository.ts';
import { ConversationStreamService } from '../apps/server/src/services/ConversationStreamService.ts';
import {
  applyCompactionSummary,
  ConversationTurnDriver,
  ConversationTurnDriverError,
} from '../apps/server/src/services/ConversationTurnDriver.ts';

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const OUT = resolve(argValue('--out') ?? '.');
mkdirSync(OUT, { recursive: true });
const MODEL = process.env.AGENTOS_COMPACTION_MODEL ?? 'gpt-5.6-luna';
const SCRATCH = process.env.AGENTOS_COMPACTION_SCRATCH ?? join(tmpdir(), 'agentos-s6-evidence-scratch');

const receipts = [];
let phase = 'setup';

class ReceiptFailure extends Error {}

/** Record one assertion with its actual and expected values. */
function expect(requirementId, id, step, actual, expected, ok = undefined) {
  let passed = true;
  let detail;
  try {
    if (ok === undefined) assert.deepEqual(actual, expected);
    else if (!ok) throw new Error('condition was false');
  } catch (error) {
    passed = false;
    detail = String(error.message).split('\n')[0];
  }
  receipts.push({
    id, requirementId, phase, step,
    actual, expected,
    outcome: passed ? 'passed' : 'failed',
    ...(detail === undefined ? {} : { detail }),
  });
  if (!passed) throw new ReceiptFailure(id);
  return actual;
}

function sha256Hex(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** A failed assertion ends its phase; later phases still run and receipts still land. */
function catchPhase(error) {
  if (!(error instanceof ReceiptFailure)) throw error;
  phases[phase] = { ...(phases[phase] ?? {}), failedReceipt: error.message };
}

const root = mkdtempSync(join(tmpdir(), 'agentos-s6-evidence-'));
const store = new SqliteStore(root);
const db = store.getDatabase();
const NOW = new Date().toISOString();

const WS = 'ws_s6_evidence';
const CONV_REAL = 'conv_' + 'e'.repeat(26);
const CONV_GUARD = 'conv_' + 'g'.repeat(26);

db.prepare('INSERT INTO workspaces (id,name,root_path,canonical_root_path,last_opened_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
  .run(WS, WS, root, root, NOW, NOW, NOW);
for (const conversationId of [CONV_REAL, CONV_GUARD]) {
  db.prepare(`INSERT INTO cr_conversations (id, workspace_id, kind, status, title, created_at, updated_at, version)
    VALUES (?, ?, 'direct', 'active', 's6 evidence', ?, ?, 1)`).run(conversationId, WS, NOW, NOW);
}

const agent = {
  id: 'agent_codex', name: 'Codex', role: 'codex', enabled: true,
  cliCommand: 'codex', cliArgs: [], model: MODEL, thinkingEffort: 'low',
  provider: 'codex', systemPrompt: 'runtime manager', workspaceId: WS,
};
const provider = summarizationIdentityFor(agent);
const compactions = new CompactionRepository(db);
const candidates = new MemoryCandidateRepository(db);
const messages = Array.from({ length: 12 }, (_value, index) => ({
  id: 'msg_' + String(index).padStart(3, '0'),
  senderType: index % 2 === 0 ? 'user' : 'agent',
  content: `message ${index}: ` + 'The runtime keeps Tasks, Runs and Processes distinct. '.repeat(60),
  status: 'final',
  createdAt: NOW,
}));
const budget = { providerContextTokens: 12000, systemPromptTokens: 0, memoryContextTokens: 0, outputReserveTokens: 2048 };

// LITE-09-105: the canonical Message rows the summary is derived from. They are written
// through the real schema before any compaction runs, so "the original Messages survive"
// is checked against persisted rows instead of the in-memory fixture alone.
const insertMessage = db.prepare(`INSERT INTO cr_messages
  (id, conversation_id, workspace_id, sequence, sender_type, sender_agent_id, kind, status, content, created_at, updated_at, version)
  VALUES (?, ?, ?, ?, ?, ?, 'text', 'final', ?, ?, ?, 1)`);
messages.forEach((message, index) => {
  insertMessage.run(message.id, CONV_REAL, WS, index + 1, message.senderType,
    message.senderType === 'agent' ? agent.id : null, message.content, NOW, NOW);
});
const messageDigest = () => db.prepare('SELECT id, status, version, content FROM cr_messages WHERE workspace_id = ? ORDER BY sequence')
  .all(WS).map(row => [row.id, row.status, row.version, sha256Hex(row.content)]);
const messageDigestBefore = messageDigest();

const phases = {};

// Declared at module scope so every phase can read what an earlier phase produced.
let policy;
let summaryForBudget;
let historyForBudget;
let publishedTask;
let publishedCandidateId;
let makeTask;
let claim;

// ---------------------------------------------------------------- real phase
phase = 'real';
try {
const realEngine = new ConversationCompactionService({
  store,
  summarizer: new ProviderCompactionSummarizer({ scratchRoot: SCRATCH, profiles: SUMMARIZATION_CLI_PROFILES }),
});
const realStartedAt = Date.now();
const real = await realEngine.compact({
  workspaceId: WS, conversationId: CONV_REAL, policyVersion: 'lite-v1',
  messages, budget, provider, priorSummary: null,
});
const realElapsedMs = Date.now() - realStartedAt;
phases.real = { outcome: real.outcome, elapsedMs: realElapsedMs };

expect('LITE-07-105', 'S6E-REAL-01', 'a real Provider compaction publishes a durable task', real.outcome, 'published');
const task = real.task;
publishedTask = task;
expect('LITE-09-106', 'S6E-REAL-02', 'the summary was produced by a real Provider process',
  { summaryNonEmpty: typeof task.summary === 'string' && task.summary.trim().length > 0 },
  { summaryNonEmpty: true });
expect('LITE-09-106', 'S6E-REAL-03', 'the frozen Provider identity is recorded on the task',
  { adapterId: task.adapterId, adapterVersion: task.adapterVersion, providerType: task.providerType, model: task.model },
  { adapterId: 'cli.codex', adapterVersion: '1.0.0', providerType: 'codex', model: MODEL });
expect('LITE-09-106', 'S6E-REAL-04', 'the summary ran under the allowlisted read-only CLI profile',
  { readOnly: SUMMARIZATION_CLI_PROFILES.codex.cliArgs.includes('read-only'),
    skipGitRepoCheck: SUMMARIZATION_CLI_PROFILES.codex.cliArgs.includes('--skip-git-repo-check') },
  { readOnly: true, skipGitRepoCheck: true });

policy = realEngine.policy('lite-v1');
expect('LITE-09-105', 'S6E-REAL-05', 'the published summary is non-empty and inside the recorded budget',
  { lengthOk: task.summary.length > 0 && task.summary.length <= policy.summaryMaxTokens * 4,
    summaryHashMatches: task.summaryHash === sha256Hex(task.summary) },
  { lengthOk: true, summaryHashMatches: true });
expect('LITE-09-105', 'S6E-REAL-06', 'the source range it covered is recorded',
  { sourceMessageCount: task.sourceMessageCount,
    hasStart: typeof task.sourceStartMessageId === 'string',
    hasEnd: typeof task.sourceEndMessageId === 'string',
    hasSourceHash: typeof task.sourceHash === 'string' && task.sourceHash.length === 64 },
  { sourceMessageCount: 4, hasStart: true, hasEnd: true, hasSourceHash: true });

const realCandidate = candidates.findCandidateById(WS, task.candidateId);
expect('LITE-07-105', 'S6E-REAL-07', 'publishing records a review-required agent-derived Candidate',
  { decision: realCandidate?.decision, outcome: realCandidate?.outcome, authority: realCandidate?.authority,
    scope: realCandidate?.scope },
  { decision: 'review-required', outcome: 'review-required', authority: 'agent-derived', scope: 'conversation' });
const realEvent = db.prepare("SELECT type, correlation_id, causation_id, payload_json FROM workspace_events WHERE workspace_id = ? AND type = 'memory.candidate_created' AND correlation_id = ?")
  .get(WS, 'memory-compaction:' + task.id);
expect('LITE-07-105', 'S6E-REAL-08', 'the fact and its canonical Workspace Event are one causal record',
  { type: realEvent?.type, causationId: realEvent?.causation_id,
    payloadCandidateMatches: JSON.parse(realEvent?.payload_json ?? '{}').candidateId === realCandidate?.id },
  { type: 'memory.candidate_created', causationId: task.id, payloadCandidateMatches: true });
publishedCandidateId = realCandidate?.id;

const repeat = await realEngine.compact({
  workspaceId: WS, conversationId: CONV_REAL, policyVersion: 'lite-v1',
  messages, budget, provider, priorSummary: null,
});
expect('LITE-07-105', 'S6E-REAL-09', 'a repeat over the same source converges without a second fact',
  { outcome: repeat.outcome, sameTask: repeat.task?.id === task.id,
    tasks: compactions.listForConversation(WS, CONV_REAL).length },
  { outcome: 'published', sameTask: true, tasks: 1 });

expect('LITE-09-104', 'S6E-REAL-10', 'the lite-v1 policy records the versioned thresholds',
  { policyVersion: policy.policyVersion, triggerRatio: policy.triggerRatio, targetRatio: policy.targetRatio,
    minRecentMessages: policy.minRecentMessages, summaryMaxTokens: policy.summaryMaxTokens,
    timeoutMs: policy.timeoutMs, maxAutomaticRetries: policy.maxAutomaticRetries },
  { policyVersion: 'lite-v1', triggerRatio: 0.7, targetRatio: 0.5, minRecentMessages: 8,
    summaryMaxTokens: 2048, timeoutMs: 120000, maxAutomaticRetries: 1 });
const recordedBudget = JSON.parse(task.budgetJson);
expect('LITE-09-104', 'S6E-REAL-11', 'the task records the budget composition and estimator that produced it',
  { policyVersion: recordedBudget.policyVersion,
    estimatorVersion: recordedBudget.estimatorVersion,
    providerContextTokens: recordedBudget.providerContextTokens,
    outputReserveTokens: recordedBudget.outputReserveTokens,
    applicationBudgetSource: recordedBudget.applicationBudgetSource,
    triggerRatio: recordedBudget.triggerRatio,
    targetRatio: recordedBudget.targetRatio,
    retainedRecentMessages: recordedBudget.retainedRecentMessages,
    taskEstimatorVersion: task.estimatorVersion },
  { policyVersion: 'lite-v1', estimatorVersion: 'lite-v1-chars4', providerContextTokens: 12000,
    outputReserveTokens: 2048, applicationBudgetSource: 'provider', triggerRatio: 0.7,
    targetRatio: 0.5, retainedRecentMessages: 8, taskEstimatorVersion: 'lite-v1-chars4' });

const summaryRows = db.prepare('SELECT COUNT(*) AS n FROM conversation_compactions WHERE workspace_id = ? AND summary IS NOT NULL').get(WS);
expect('LITE-09-110', 'S6E-REAL-12', 'only the AgentOS-persisted summary is canonical',
  { persistedSummaries: Number(summaryRows.n),
    matchesTask: compactions.findById(WS, task.id)?.summary === task.summary,
    nativeRows: Number(db.prepare("SELECT COUNT(*) AS n FROM conversation_compactions WHERE workspace_id = ? AND provider_type = 'native'").get(WS).n) },
  { persistedSummaries: 1, matchesTask: true, nativeRows: 0 });
const messageDigestAfter = messageDigest();
expect('LITE-09-105', 'S6E-REAL-13', 'the Messages the summary covered survive the published compaction unchanged',
  { rowsBefore: messageDigestBefore.length, rowsAfter: messageDigestAfter.length,
    digestUnchanged: JSON.stringify(messageDigestAfter) === JSON.stringify(messageDigestBefore),
    distinctStatuses: [...new Set(messageDigestAfter.map(row => row[1]))] },
  { rowsBefore: 12, rowsAfter: 12, digestUnchanged: true, distinctStatuses: ['final'] });

const summaryArgs = SUMMARIZATION_CLI_PROFILES.codex.cliArgs;
const bypassFlags = ['--dangerously-bypass-approvals-and-sandbox', '--full-auto', 'workspace-write', 'danger-full-access'];
expect('LITE-09-106', 'S6E-REAL-14', 'the summary run is read-only sandboxed with no approval or tool bypass',
  { args: summaryArgs,
    sandboxReadOnly: summaryArgs.includes('read-only') && summaryArgs.includes('--sandbox'),
    bypassFlagsPresent: bypassFlags.filter(flag => summaryArgs.includes(flag)),
    approvalDecisions: Number(db.prepare('SELECT COUNT(*) AS n FROM approval_decisions WHERE workspace_id = ?').get(WS).n),
    nonCandidateEvents: Number(db.prepare("SELECT COUNT(*) AS n FROM workspace_events WHERE workspace_id = ? AND type <> 'memory.candidate_created'").get(WS).n) },
  { args: ['exec', '--sandbox', 'read-only', '--skip-git-repo-check'], sandboxReadOnly: true,
    bypassFlagsPresent: [], approvalDecisions: 0, nonCandidateEvents: 0 });
expect('LITE-07-105', 'S6E-REAL-15', 'publishing a summary does not create a Memory Entry: availability is not approval',
  { memoryEntries: Number(db.prepare('SELECT COUNT(*) AS n FROM memory_entries WHERE workspace_id = ?').get(WS).n),
    candidateDecision: candidates.findCandidateById(WS, task.candidateId)?.decision,
    candidateOutcome: candidates.findCandidateById(WS, task.candidateId)?.outcome },
  { memoryEntries: 0, candidateDecision: 'review-required', candidateOutcome: 'review-required' });
expect('LITE-09-105', 'S6E-REAL-16', 'only the bounded old prefix is compacted: the recent window stays uncompressed',
  { totalMessages: messages.length, sourceMessageCount: task.sourceMessageCount,
    retainedMessages: messages.length - task.sourceMessageCount, minRecentMessages: policy.minRecentMessages,
    sourceStartIsOldest: task.sourceStartMessageId === messages[0].id,
    sourceEndIsLastCoveredMessage: task.sourceEndMessageId === messages[messages.length - policy.minRecentMessages - 1].id },
  { totalMessages: 12, sourceMessageCount: 4, retainedMessages: 8, minRecentMessages: 8,
    sourceStartIsOldest: true, sourceEndIsLastCoveredMessage: true });
} catch (error) { catchPhase(error); }

// --------------------------------------------------------------- guard phase
phase = 'guard';
try {
const guardEngine = new ConversationCompactionService({
  store,
  summarizer: { summarize: async () => ({ summary: 'x'.repeat(20000) }) },
});
const oversized = await guardEngine.compact({
  workspaceId: WS, conversationId: CONV_GUARD, policyVersion: 'lite-v1',
  messages, budget, provider, priorSummary: null,
});
expect('LITE-09-105', 'S6E-GUARD-01', 'an oversized summary is refused, never published',
  { outcome: oversized.outcome, failureCode: oversized.task?.failureCode,
    published: compactions.findLatestPublished(WS, CONV_GUARD) !== undefined,
    candidates: candidates.listCandidates(WS).filter(item => item.ownerConversationId === CONV_GUARD).length },
  { outcome: 'retry-pending', failureCode: 'COMPACTION_SUMMARY_INVALID', published: false, candidates: 0 });

// One durable execution holder per Conversation, enforced by the schema itself: a second
// running row for the same Conversation cannot exist.
const runningIndex = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'conversation_compactions_one_running'").get();
expect('LITE-09-107', 'S6E-GUARD-02', 'the schema carries a one-running-holder index per Conversation',
  { unwrapped: String(runningIndex.sql).replace(/\s+/gu, ' ').trim(),
    isUnique: /UNIQUE INDEX/iu.test(String(runningIndex.sql)),
    scopedToRunning: /WHERE status = 'running'/iu.test(String(runningIndex.sql)) },
  { unwrapped: 'CREATE UNIQUE INDEX conversation_compactions_one_running ON conversation_compactions (conversation_id) WHERE status = \'running\'',
    isUnique: true, scopedToRunning: true });
// The invariant is one RUNNING holder per Conversation, so the executed check claims a
// second task to `running` while the first still holds it and records the refusal.
const CONV_INDEX = 'conv_' + 'h'.repeat(26);
db.prepare(`INSERT INTO cr_conversations (id, workspace_id, kind, status, title, created_at, updated_at, version)
  VALUES (?, ?, 'direct', 'active', 's6 evidence index', ?, ?, 1)`).run(CONV_INDEX, WS, NOW, NOW);
makeTask = (conversationId, sourceHash) => inTransaction(db, () => compactions.createTaskWithinTransaction({
  id: createEntityId('snapshot'),
  workspaceId: WS, conversationId, policyId: policy.id,
  sourceStartMessageId: messages[0].id, sourceEndMessageId: messages[3].id,
  sourceMessageCount: 4, sourceHash, priorSummaryId: null,
  budgetJson: JSON.stringify({ providerContextTokens: 12000 }),
  providerConfigId: provider.providerConfigId, providerType: provider.providerType,
  adapterId: provider.adapterId, adapterVersion: provider.adapterVersion,
  model: provider.model, estimatorVersion: 'chars-4-v1', createdAt: NOW,
}));
claim = (task) => inTransaction(db, () => compactions.claimRunningWithinTransaction({
  workspaceId: WS, id: task.id, expectedVersion: task.version, leaseOwner: 'evidence-holder',
  leaseExpiresAt: new Date(Date.parse(NOW) + 120000).toISOString(), now: NOW, attempt: 1,
}));
const holder = makeTask(CONV_INDEX, 'a'.repeat(64));
claim(holder);
let secondRunningRefused = false;
let secondRunningError = '';
try {
  const challenger = makeTask(CONV_INDEX, 'b'.repeat(64));
  claim(challenger);
} catch (error) {
  secondRunningRefused = true;
  secondRunningError = String(error?.message ?? error);
}
expect('LITE-09-107', 'S6E-GUARD-03', 'a second running holder for the same Conversation is refused by the store',
  { refused: secondRunningRefused,
    refusalIsStable: /COMPACTION_CONFLICT|one_running|UNIQUE constraint/iu.test(secondRunningError) },
  { refused: true, refusalIsStable: true });
const runningNow = Number(db.prepare("SELECT COUNT(*) AS n FROM conversation_compactions WHERE workspace_id = ? AND conversation_id = ? AND status = 'running'").get(WS, CONV_INDEX).n);
expect('LITE-09-107', 'S6E-GUARD-05', 'exactly one running holder remains after the refusal',
  { running: runningNow }, { running: 1 });

// A retry-pending task stays the Conversation's active attempt: another evaluation does
// not start a parallel execution or publish a second fact.
const secondAttempt = await guardEngine.compact({
  workspaceId: WS, conversationId: CONV_GUARD, policyVersion: 'lite-v1',
  messages, budget, provider, priorSummary: null,
});
expect('LITE-09-107', 'S6E-GUARD-04', 'a pending attempt is not duplicated by another evaluation',
  { outcome: secondAttempt.outcome, published: compactions.findLatestPublished(WS, CONV_GUARD) !== undefined,
    running: Number(db.prepare("SELECT COUNT(*) AS n FROM conversation_compactions WHERE workspace_id = ? AND conversation_id = ? AND status = 'running'").get(WS, CONV_GUARD).n) },
  { outcome: 'retry-pending', published: false, running: 0 });
expect('LITE-07-105', 'S6E-GUARD-06', 'a refused summary leaves no Candidate, no published row and no canonical Event behind',
  { guardCandidates: candidates.listCandidates(WS).filter(item => item.ownerConversationId === CONV_GUARD).length,
    guardPublished: compactions.findLatestPublished(WS, CONV_GUARD) !== undefined,
    guardTasksWithSummary: compactions.listForConversation(WS, CONV_GUARD).filter(item => typeof item.summary === 'string' && item.summary.length > 0).length,
    compactionEvents: Number(db.prepare("SELECT COUNT(*) AS n FROM workspace_events WHERE workspace_id = ? AND type = 'memory.candidate_created'").get(WS).n) },
  { guardCandidates: 0, guardPublished: false, guardTasksWithSummary: 0, compactionEvents: 1 });
// Recorded, not asserted: how many durable task rows a repeated evaluation left behind.
// The requirement bounds execution holders and published facts, so a leftover pending row
// is reported here for review rather than silently folded into the assertion above.
phases.guard = {
  claimRefusalMessage: secondRunningError.slice(0, 200),

  guardTasksAfterRepeat: compactions.listForConversation(WS, CONV_GUARD).map(item => item.status),
  guardPublished: compactions.findLatestPublished(WS, CONV_GUARD) !== undefined,
};
} catch (error) { catchPhase(error); }

// -------------------------------------------------------------- budget phase
phase = 'budget';
try {
summaryForBudget = { id: 'comp_budget', summary: 'S', sourceStartMessageId: 'm1', sourceEndMessageId: 'm2',
  sourceMessageCount: 2, sourceHash: sha256Hex(JSON.stringify([['m1', 'a'], ['m2', 'b']])) };
historyForBudget = [
  { id: 'm1', conversationId: 'c', workspaceId: 'w', senderType: 'user', content: 'a', createdAt: NOW },
  { id: 'm2', conversationId: 'c', workspaceId: 'w', senderType: 'user', content: 'b', createdAt: NOW },
  { id: 'm3', conversationId: 'c', workspaceId: 'w', senderType: 'user', content: 'c'.repeat(400), createdAt: NOW },
];
const overBudget = applyCompactionSummary(historyForBudget, summaryForBudget, { hardBudgetTokens: 5 });
expect('LITE-09-108', 'S6E-BUDGET-01', 'summary plus tail beyond the hard budget is refused',
  { kind: overBudget.kind }, { kind: 'over-budget' });
expect('LITE-09-108', 'S6E-BUDGET-02', 'the refusal never truncates or drops the messages',
  { historyLength: historyForBudget.length, contents: historyForBudget.map(item => item.content.length) },
  { historyLength: 3, contents: [1, 1, 400] });
const withinBudget = applyCompactionSummary(historyForBudget, summaryForBudget, { hardBudgetTokens: 1000 });
expect('LITE-09-108', 'S6E-BUDGET-03', 'the same history inside the budget applies the summary',
  { kind: withinBudget.kind, summarizedMessages: withinBudget.summarizedMessages },
  { kind: 'applied', summarizedMessages: 2 });
} catch (error) { catchPhase(error); }

// --------------------------------------------------------------- stale phase
phase = 'stale';
try {
const edited = [historyForBudget[0], { ...historyForBudget[1], content: 'EDITED' }, historyForBudget[2]];
const stale = applyCompactionSummary(edited, summaryForBudget, { hardBudgetTokens: 1000 });
expect('LITE-09-109', 'S6E-STALE-01', 'a summary whose covered Message was edited is refused',
  { kind: stale.kind, reason: stale.reason }, { kind: 'stale-source', reason: 'source-content-changed' });
} catch (error) { catchPhase(error); }

// -------------------------------------------------------------- durable phase
// LITE-09-104/105/106/107: the durable invariants named by the exit criteria are enforced
// by the schema itself. Each refusal is EXECUTED here, so the receipt carries the real
// error rather than a restatement of the DDL text.
phase = 'durable';
try {
const attemptRun = (sql, ...params) => {
  try { db.prepare(sql).run(...params); return { refused: false, message: null }; }
  catch (error) { return { refused: true, message: String(error?.message ?? error) }; }
};
const attemptRepo = fn => {
  try { fn(); return { refused: false, message: null }; }
  catch (error) { return { refused: true, message: String(error?.message ?? error) }; }
};
const refusedWith = (outcome, code) => outcome.refused === true && String(outcome.message).includes(code);
const policyRow = db.prepare("SELECT id, summary_max_tokens AS maxTokens FROM conversation_compaction_policies WHERE policy_version = 'lite-v1'").get();
const publishedRow = compactions.findLatestPublished(WS, CONV_REAL);

const policyEdit = attemptRun('UPDATE conversation_compaction_policies SET summary_max_tokens = 4096 WHERE id = ?', policyRow.id);
expect('LITE-09-104', 'S6E-DB-01', 'a versioned policy row cannot be rewritten, so an old budget keeps its interpretation',
  { refusedWithCode: refusedWith(policyEdit, 'COMPACTION_POLICY_IMMUTABLE'),
    storedMaxTokens: Number(db.prepare('SELECT summary_max_tokens AS n FROM conversation_compaction_policies WHERE id = ?').get(policyRow.id).n) },
  { refusedWithCode: true, storedMaxTokens: 2048 });

const summaryEdit = attemptRun('UPDATE conversation_compactions SET summary = ? WHERE id = ?', 'TAMPERED SUMMARY', publishedRow.id);
expect('LITE-09-105', 'S6E-DB-02', 'a published summary cannot be rewritten after it became canonical',
  { refusedWithCode: refusedWith(summaryEdit, 'COMPACTION_PUBLISHED_IMMUTABLE'),
    summaryHashUnchanged: compactions.findById(WS, publishedRow.id)?.summaryHash === publishedRow.summaryHash },
  { refusedWithCode: true, summaryHashUnchanged: true });

const modelEdit = attemptRun('UPDATE conversation_compactions SET model = ? WHERE id = ?', 'other/model', publishedRow.id);
expect('LITE-09-106', 'S6E-DB-03', 'the frozen Provider identity cannot be rewritten after the summary was published',
  { refusedWithCode: refusedWith(modelEdit, 'COMPACTION_IDENTITY_IMMUTABLE'),
    storedModel: compactions.findById(WS, publishedRow.id)?.model },
  { refusedWithCode: true, storedModel: MODEL });

const publishedSourceIndex = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'conversation_compactions_one_published_source'").get();
const duplicateClaimed = claim(makeTask(CONV_REAL, publishedRow.sourceHash));
const duplicatePublish = attemptRepo(() => inTransaction(db, () => compactions.publishWithinTransaction({
  workspaceId: WS, id: duplicateClaimed.id, expectedVersion: duplicateClaimed.version, leaseOwner: 'evidence-holder',
  summary: 'duplicate publish attempt', summaryHash: sha256Hex('duplicate publish attempt'),
  summaryTokenEstimate: 5, candidateId: publishedRow.candidateId, publishedAt: NOW,
})));
expect('LITE-07-105', 'S6E-DB-04', 'one published summary per Conversation source: a second publish of the same source is refused',
  { indexIsUnique: /UNIQUE INDEX/iu.test(String(publishedSourceIndex?.sql)),
    scopedToPublished: /WHERE status = 'published'/iu.test(String(publishedSourceIndex?.sql)),
    refusedByUnique: duplicatePublish.refused === true && /UNIQUE/iu.test(String(duplicatePublish.message)),
    publishedRowsInConversation: compactions.listForConversation(WS, CONV_REAL).filter(item => item.status === 'published').length },
  { indexIsUnique: true, scopedToPublished: true, refusedByUnique: true, publishedRowsInConversation: 1 });

const CONV_LEASE = 'conv_' + 'l'.repeat(26);
db.prepare(`INSERT INTO cr_conversations (id, workspace_id, kind, status, title, created_at, updated_at, version)
  VALUES (?, ?, 'direct', 'active', 's6 evidence lease', ?, ?, 1)`).run(CONV_LEASE, WS, NOW, NOW);
const leaseClaimed = claim(makeTask(CONV_LEASE, 'c'.repeat(64)));
const stalePublish = attemptRepo(() => inTransaction(db, () => compactions.publishWithinTransaction({
  workspaceId: WS, id: leaseClaimed.id, expectedVersion: leaseClaimed.version, leaseOwner: 'a-different-holder',
  summary: 'stale attempt', summaryHash: sha256Hex('stale attempt'),
  summaryTokenEstimate: 5, candidateId: publishedRow.candidateId, publishedAt: NOW,
})));
expect('LITE-09-107', 'S6E-DB-05', 'a publish from a lease that no longer holds the attempt is refused',
  { refused: stalePublish.refused === true,
    stableCode: String(stalePublish.message).includes('COMPACTION_CONFLICT'),
    rowStillRunning: compactions.findById(WS, leaseClaimed.id)?.status },
  { refused: true, stableCode: true, rowStillRunning: 'running' });
} catch (error) { catchPhase(error); }

// ------------------------------------------------------------ turngate phase
// LITE-09-105/09-108 on the production Turn driver: the real published summary is the
// actual input of the next Provider context, and a summary that no longer fits blocks the
// call instead of truncating the history.
phase = 'turngate';
try {
const conversations = new ConversationRepository(db);
const turns = new AgentTurnRepository(db);
const stream = new ConversationStreamService(db, conversations, turns);
const compactionPort = {
  latestPublished: (workspaceId, conversationId) => {
    const found = compactions.findLatestPublished(workspaceId, conversationId);
    if (found === undefined || typeof found.summary !== 'string') return undefined;
    return {
      id: found.id, summary: found.summary,
      sourceStartMessageId: found.sourceStartMessageId, sourceEndMessageId: found.sourceEndMessageId,
      sourceMessageCount: found.sourceMessageCount, sourceHash: found.sourceHash,
    };
  },
};
const publishedRow = compactions.findLatestPublished(WS, CONV_REAL);
const getAgent = (_workspaceId, agentId) => (agentId === agent.id ? agent : undefined);
insertMessage.run('msg_turn_gate_input', CONV_REAL, WS, 13, 'user', null, 'current input', NOW, NOW);
const countRows = () => ({
  messages: Number(db.prepare('SELECT COUNT(*) AS n FROM cr_messages WHERE workspace_id = ?').get(WS).n),
  turns: Number(db.prepare('SELECT COUNT(*) AS n FROM cr_agent_turns WHERE workspace_id = ?').get(WS).n),
});
const before = countRows();
const digestBeforeGate = messageDigest();
let gateError;
let gateRunnerCalls = 0;
const blockedDriver = new ConversationTurnDriver(conversations, stream, getAgent,
  () => ({ run: async () => { gateRunnerCalls += 1; throw new Error('runner must not run while the summary is over budget'); } }),
  { compaction: compactionPort, compactionBudget: { hardBudgetTokens: 4 } });
try {
  await blockedDriver.replyWithTurn({
    workspaceId: WS, workspaceRoot: root, conversationId: CONV_REAL, agentId: agent.id,
    sourceMessageId: 'msg_turn_gate_input', content: 'current input',
    turnId: 'turn_' + 'g'.repeat(20), responseMessageId: 'msg_' + 'r'.repeat(20), createdAt: NOW,
  });
} catch (error) {
  gateError = { type: error?.constructor?.name, code: error?.code };
}
const after = countRows();
expect('LITE-09-108', 'S6E-TURNGATE-01', 'an over-budget summary and tail block the Provider call before any reservation',
  { error: gateError, runnerCalls: gateRunnerCalls,
    messagesAdded: after.messages - before.messages, turnsAdded: after.turns - before.turns,
    digestsUnchanged: JSON.stringify(messageDigest()) === JSON.stringify(digestBeforeGate) },
  { error: { type: 'ConversationTurnDriverError', code: 'TURN_DRIVER_COMPACTION_BUDGET_EXCEEDED' },
    runnerCalls: 0, messagesAdded: 0, turnsAdded: 0, digestsUnchanged: true });

let controlHistory;
let controlRunnerCalls = 0;
const controlDriver = new ConversationTurnDriver(conversations, stream, getAgent,
  (options) => ({ run: async () => {
    controlRunnerCalls += 1;
    controlHistory = options.history;
    return { status: 'completed', content: 'ok', mode: 'mock', startedAt: NOW, completedAt: NOW };
  } }),
  { compaction: compactionPort, compactionBudget: { hardBudgetTokens: 100000 } });
const control = await controlDriver.replyWithTurn({
  workspaceId: WS, workspaceRoot: root, conversationId: CONV_REAL, agentId: agent.id,
  sourceMessageId: 'msg_turn_gate_input', content: 'current input',
  turnId: 'turn_' + 'c'.repeat(20), responseMessageId: 'msg_' + 'q'.repeat(20), createdAt: NOW,
});
const contextIds = (controlHistory ?? []).map(entry => entry.id);
const coveredIds = ['msg_000', 'msg_001', 'msg_002', 'msg_003'];
const tailIds = ['msg_004', 'msg_005', 'msg_006', 'msg_007'];
expect('LITE-09-105', 'S6E-TURNGATE-02', 'the real published summary reaches the Provider context and replaces exactly the covered Messages',
  { status: control.status, runnerCalls: controlRunnerCalls,
    summaryEntryIdPresent: contextIds.includes('compaction:' + publishedRow.id),
    summaryTextInContext: (controlHistory ?? []).some(entry => entry.content === publishedRow.summary),
    coveredIdsStillInContext: coveredIds.filter(id => contextIds.includes(id)),
    tailIdsStillInContext: tailIds.filter(id => contextIds.includes(id)) },
  { status: 'completed', runnerCalls: 1, summaryEntryIdPresent: true, summaryTextInContext: true,
    coveredIdsStillInContext: [], tailIdsStillInContext: tailIds });
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
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  model: MODEL,
  phases,
  counts,
  receipts,
}, null, 2)}\n`, 'utf8');

console.log(`S6_CANDIDATE_EVIDENCE: ${counts.failed === 0 ? 'passed' : 'failed'}`);
console.log(`  model=${MODEL} receipts=${counts.total} passed=${counts.passed} failed=${counts.failed}`);
for (const receipt of receipts.filter(item => item.outcome !== 'passed')) {
  console.log(`  FAILED ${receipt.id} (${receipt.requirementId}): ${receipt.detail ?? ''}`);
}
process.exit(counts.failed === 0 ? 0 : 1);
