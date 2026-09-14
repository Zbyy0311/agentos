/**
 * LITE S6 candidate evidence harness.
 *
 * Emits machine-readable assertion receipts (actual / expected / outcome) for the
 * compaction requirements, so a reader can check clause coverage instead of trusting a
 * suite-level pass. Phases:
 *
 *   real   - one compaction through the PRODUCTION engine against the real Codex CLI
 *   guard  - the single-holder and bounded-retry invariants, executed
 *   budget - the application hard-budget refusal on the production function
 *   stale  - the LITE-09-109 source validation on the production function
 *   durable- the immutable/unique invariants the schema enforces, executed
 *   turngate - the same decisions through the production Turn driver
 *   inspector - the read surface an operator sees, over real HTTP
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
import { createConversationRuntimeRoutes } from '../apps/server/src/routes/conversationRuntime.ts';
import { WorkspaceManager } from '../apps/server/src/managers/WorkspaceManager.ts';
import { createRequire } from 'node:module';

// This harness lives outside the server package, so package dependencies (express) are
// resolved from the server's own node_modules instead of the script's directory.
const serverRequire = createRequire(new URL('../apps/server/package.json', import.meta.url));
const express = serverRequire('express');
import {
  applyCompactionSummary,
  ConversationTurnDriver,
  ConversationTurnDriverError,
  createDurableTurnContextSnapshotPort,
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
let inspectorTurn;

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
let guardSummarizerCalls = 0;
const guardEngine = new ConversationCompactionService({
  store,
  summarizer: { summarize: async () => { guardSummarizerCalls += 1; return { summary: 'x'.repeat(20000) }; } },
});
const oversized = await guardEngine.compact({
  workspaceId: WS, conversationId: CONV_GUARD, policyVersion: 'lite-v1',
  messages, budget, provider, priorSummary: null,
});
expect('LITE-09-105', 'S6E-GUARD-01', 'an oversized summary is refused, never published',
  { outcome: oversized.outcome, failureCode: oversized.task?.failureCode,
    attempts: oversized.task?.attempts, summarizerCalls: guardSummarizerCalls,
    published: compactions.findLatestPublished(WS, CONV_GUARD) !== undefined,
    candidates: candidates.listCandidates(WS).filter(item => item.ownerConversationId === CONV_GUARD).length },
  { outcome: 'retry-pending', failureCode: 'COMPACTION_SUMMARY_INVALID', attempts: 1, summarizerCalls: 1,
    published: false, candidates: 0 });

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

// LITE-09-107: the automatic retry chain is bounded. The second automatic evaluation
// resumes the SAME durable attempt, spends the single allowed retry and then records the
// bounded failure; a third evaluation must not buy another Provider call.
const secondAttempt = await guardEngine.compact({
  workspaceId: WS, conversationId: CONV_GUARD, policyVersion: 'lite-v1',
  messages, budget, provider, priorSummary: null,
});
expect('LITE-09-107', 'S6E-GUARD-04', 'the automatic evaluation resumes the same attempt and stops at the bounded retry budget',
  { outcome: secondAttempt.outcome, sameTask: secondAttempt.task?.id === oversized.task?.id,
    attempts: secondAttempt.task?.attempts, failureCode: secondAttempt.task?.failureCode,
    summarizerCalls: guardSummarizerCalls,
    published: compactions.findLatestPublished(WS, CONV_GUARD) !== undefined,
    running: Number(db.prepare("SELECT COUNT(*) AS n FROM conversation_compactions WHERE workspace_id = ? AND conversation_id = ? AND status = 'running'").get(WS, CONV_GUARD).n) },
  { outcome: 'failed', sameTask: true, attempts: 2, failureCode: 'COMPACTION_RETRIES_EXHAUSTED',
    summarizerCalls: 2, published: false, running: 0 });
const thirdAttempt = await guardEngine.compact({
  workspaceId: WS, conversationId: CONV_GUARD, policyVersion: 'lite-v1',
  messages, budget, provider, priorSummary: null,
});
expect('LITE-09-107', 'S6E-GUARD-07', 'a spent automatic chain is never re-scheduled: no new attempt row and no new Provider call',
  { outcome: thirdAttempt.outcome, sameTask: thirdAttempt.task?.id === oversized.task?.id,
    failureCode: thirdAttempt.task?.failureCode, summarizerCalls: guardSummarizerCalls,
    guardTaskRows: compactions.listForConversation(WS, CONV_GUARD).length },
  { outcome: 'failed', sameTask: true, failureCode: 'COMPACTION_RETRIES_EXHAUSTED', summarizerCalls: 2, guardTaskRows: 1 });
// LITE-09-108: only the retry a human asks for may spend another attempt on that source.
const explicitRetry = await guardEngine.compact({
  workspaceId: WS, conversationId: CONV_GUARD, policyVersion: 'lite-v1',
  messages, budget, provider, priorSummary: null, resume: 'explicit',
});
expect('LITE-09-108', 'S6E-GUARD-08', 'the explicit retry spends its own attempt instead of being blocked by the spent chain',
  { outcome: explicitRetry.outcome, startsNewAttempt: explicitRetry.task?.id !== oversized.task?.id,
    attempts: explicitRetry.task?.attempts, summarizerCalls: guardSummarizerCalls,
    guardTaskRows: compactions.listForConversation(WS, CONV_GUARD).length,
    published: compactions.findLatestPublished(WS, CONV_GUARD) !== undefined },
  { outcome: 'retry-pending', startsNewAttempt: true, attempts: 1, summarizerCalls: 3, guardTaskRows: 2, published: false });
expect('LITE-07-105', 'S6E-GUARD-06', 'a refused summary leaves no Candidate, no published row and no canonical Event behind',
  { guardCandidates: candidates.listCandidates(WS).filter(item => item.ownerConversationId === CONV_GUARD).length,
    guardPublished: compactions.findLatestPublished(WS, CONV_GUARD) !== undefined,
    guardTasksWithSummary: compactions.listForConversation(WS, CONV_GUARD).filter(item => typeof item.summary === 'string' && item.summary.length > 0).length,
    compactionEvents: Number(db.prepare("SELECT COUNT(*) AS n FROM workspace_events WHERE workspace_id = ? AND type = 'memory.candidate_created'").get(WS).n) },
  { guardCandidates: 0, guardPublished: false, guardTasksWithSummary: 0, compactionEvents: 1 });
// Recorded alongside the assertions: the durable state the bounded chain left behind.
phases.guard = {
  claimRefusalMessage: secondRunningError.slice(0, 200),
  guardSummarizerCalls,
  guardTaskStatuses: compactions.listForConversation(WS, CONV_GUARD).map(item => item.status),
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
// The duplicate publish runs in its own Conversation so the real one keeps exactly the
// rows the production path produced: a summary the engine published, and nothing else.
const CONV_DUP = 'conv_' + 'd'.repeat(26);
db.prepare(`INSERT INTO cr_conversations (id, workspace_id, kind, status, title, created_at, updated_at, version)
  VALUES (?, ?, 'direct', 'active', 's6 evidence duplicate', ?, ?, 1)`).run(CONV_DUP, WS, NOW, NOW);
const DUP_SOURCE = 'd'.repeat(64);
const dupFirst = claim(makeTask(CONV_DUP, DUP_SOURCE));
inTransaction(db, () => compactions.publishWithinTransaction({
  workspaceId: WS, id: dupFirst.id, expectedVersion: dupFirst.version, leaseOwner: 'evidence-holder',
  summary: 'first published summary for this source', summaryHash: sha256Hex('first published summary for this source'),
  summaryTokenEstimate: 8, candidateId: publishedRow.candidateId, publishedAt: NOW,
}));
const duplicateClaimed = claim(makeTask(CONV_DUP, DUP_SOURCE));
const duplicatePublish = attemptRepo(() => inTransaction(db, () => compactions.publishWithinTransaction({
  workspaceId: WS, id: duplicateClaimed.id, expectedVersion: duplicateClaimed.version, leaseOwner: 'evidence-holder',
  summary: 'duplicate publish attempt', summaryHash: sha256Hex('duplicate publish attempt'),
  summaryTokenEstimate: 5, candidateId: publishedRow.candidateId, publishedAt: NOW,
})));
expect('LITE-07-105', 'S6E-DB-04', 'one published summary per Conversation source: a second publish of the same source is refused',
  { indexIsUnique: /UNIQUE INDEX/iu.test(String(publishedSourceIndex?.sql)),
    scopedToPublished: /WHERE status = 'published'/iu.test(String(publishedSourceIndex?.sql)),
    refusedByUnique: duplicatePublish.refused === true && /UNIQUE/iu.test(String(duplicatePublish.message)),
    publishedRowsInConversation: compactions.listForConversation(WS, CONV_DUP).filter(item => item.status === 'published').length },
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
/**
 * The real Turn persists its frozen context snapshot before the Provider is invoked, and
 * that snapshot is what records which summary this Turn adopted. The Inspector phase reads
 * the adoption back from those durable rows, so the snapshot port has to be the production
 * one here as well.
 */
const snapshots = createDurableTurnContextSnapshotPort({ getDatabase: () => db });
const controlDriver = new ConversationTurnDriver(conversations, stream, getAgent,
  (options) => ({ run: async () => {
    controlRunnerCalls += 1;
    controlHistory = options.history;
    return { status: 'completed', content: 'ok', mode: 'mock', startedAt: NOW, completedAt: NOW };
  } }),
  { compaction: compactionPort, compactionBudget: { hardBudgetTokens: 100000 }, snapshots, contextTokenBudget: null });
const CONTROL_TURN_ID = 'turn_' + 'c'.repeat(20);
const control = await controlDriver.replyWithTurn({
  workspaceId: WS, workspaceRoot: root, conversationId: CONV_REAL, agentId: agent.id,
  sourceMessageId: 'msg_turn_gate_input', content: 'current input',
  turnId: CONTROL_TURN_ID, responseMessageId: 'msg_' + 'q'.repeat(20), createdAt: NOW,
});
inspectorTurn = { turnId: CONTROL_TURN_ID, snapshotId: control.turn.contextSnapshotId ?? null };
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

// ------------------------------------------------------------- inspector phase
// LITE-13-101: what an operator can actually read back. The endpoint is mounted on the
// production router and reached over real HTTP, so the receipt is the response an operator
// would get, not a restatement of the projection code.
phase = 'inspector';
try {
const app = express();
app.use(express.json());
app.use('/api/workspaces/:workspaceId/runtime', createConversationRuntimeRoutes(store, new WorkspaceManager(store)));
const server = app.listen(0, '127.0.0.1');
// The HTTP phase is the only one that opens sockets. They are tracked so the phase can
// close them deterministically: an undrained keep-alive socket would otherwise leave a
// libuv async handle behind and abort the process during exit on Windows.
const sockets = new Set();
server.on('connection', socket => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});
await new Promise(resolve => server.once('listening', resolve));
const port = server.address().port;
const base = 'http://127.0.0.1:' + String(port) + '/api/workspaces/' + WS + '/runtime';
try {
  const response = await fetch(base + '/conversations/' + CONV_REAL + '/compactions');
  const body = await response.json();
  const publishedRow = compactions.findLatestPublished(WS, CONV_REAL);
  const published = body.tasks.find(item => item.id === publishedRow.id);
  const budget = JSON.parse(publishedRow.budgetJson);
  expect('LITE-13-101', 'S6E-INSPECTOR-01', 'the read surface explains why this compaction happened, to whom and under which policy',
    { status: response.status,
      taskCount: body.tasks.length,
      tasksMatchDurableRows: JSON.stringify(body.tasks.map(item => item.id).sort()) === JSON.stringify(compactions.listForConversation(WS, CONV_REAL).map(item => item.id).sort()),
      taskStatus: published?.status, taskModel: published?.model,
      adapterId: published?.adapterId, adapterVersion: published?.adapterVersion,
      estimatorVersion: published?.estimatorVersion, attempts: published?.attempts,
      failureCode: published?.failureCode, hasSummaryHash: typeof published?.summaryHash === 'string',
      candidateMatches: published?.candidateId === publishedCandidateId,
      summaryMatchesDurableRow: published?.summary === publishedRow.summary,
      sourceRange: { start: published?.sourceStartMessageId, end: published?.sourceEndMessageId, count: published?.sourceMessageCount },
      recordedTriggerAboveThreshold: published?.budget?.historyTokens > published?.budget?.triggerRatio * published?.budget?.historyBudgetTokens,
      budgetKeys: Object.keys(published?.budget ?? {}).sort() },
    { status: 200, taskCount: 1, tasksMatchDurableRows: true, taskStatus: 'published', taskModel: MODEL,
      adapterId: 'cli.codex', adapterVersion: '1.0.0', estimatorVersion: 'lite-v1-chars4', attempts: 1,
      failureCode: null, hasSummaryHash: true, candidateMatches: true, summaryMatchesDurableRow: true,
      sourceRange: { start: messages[0].id, end: messages[3].id, count: 4 },
      recordedTriggerAboveThreshold: true,
      budgetKeys: Object.keys(budget).sort() });
  expect('LITE-13-101', 'S6E-INSPECTOR-02', 'the effective policy version and its parameters are readable, not implied',
    { policies: body.policies.map(item => ({ policyVersion: item.policyVersion, triggerRatio: item.triggerRatio,
      targetRatio: item.targetRatio, minRecentMessages: item.minRecentMessages, summaryMaxTokens: item.summaryMaxTokens,
      timeoutMs: item.timeoutMs, maxAutomaticRetries: item.maxAutomaticRetries,
      fallbackApplicationBudgetTokens: item.fallbackApplicationBudgetTokens })),
      estimatorVersion: body.policies[0]?.parameters?.estimatorVersion },
    { policies: [{ policyVersion: 'lite-v1', triggerRatio: 0.7, targetRatio: 0.5, minRecentMessages: 8,
      summaryMaxTokens: 2048, timeoutMs: 120000, maxAutomaticRetries: 1, fallbackApplicationBudgetTokens: 16384 }],
      estimatorVersion: 'lite-v1-chars4' });
  const turnRow = db.prepare('SELECT context_snapshot_id AS snapshotId FROM cr_agent_turns WHERE id = ?').get(inspectorTurn.turnId);
  expect('LITE-13-101', 'S6E-INSPECTOR-03', 'the surface names the Turn and frozen snapshot that actually adopted the summary',
    { adoptions: body.adoptions,
      turnPointsAtAdoptedSnapshot: turnRow?.snapshotId === inspectorTurn.snapshotId,
      adoptedSummaryIsThePublishedRow: body.adoptions.every(item => item.summaryId === publishedRow.id) },
    { adoptions: [{ snapshotId: inspectorTurn.snapshotId, turnId: inspectorTurn.turnId, summaryId: publishedRow.id, createdAt: NOW }],
      turnPointsAtAdoptedSnapshot: true, adoptedSummaryIsThePublishedRow: true });
  const failure = await (await fetch(base + '/conversations/' + CONV_GUARD + '/compactions')).json();
  // A Conversation nobody compacted yet: the surface must report nothing rather than
  // borrowing another Conversation's state.
  const CONV_EMPTY = 'conv_' + 'z'.repeat(26);
  db.prepare(`INSERT INTO cr_conversations (id, workspace_id, kind, status, title, created_at, updated_at, version)
    VALUES (?, ?, 'direct', 'active', 's6 evidence empty', ?, ?, 1)`).run(CONV_EMPTY, WS, NOW, NOW);
  const empty = await (await fetch(base + '/conversations/' + CONV_EMPTY + '/compactions')).json();
  expect('LITE-13-101', 'S6E-INSPECTOR-04', 'failure and retry state are visible, and a Conversation without compactions reports none',
    { guardTasks: failure.tasks.map(item => ({ status: item.status, attempts: item.attempts, failureCode: item.failureCode })),
      guardAdoptions: failure.adoptions.length,
      emptyTasks: empty.tasks.length, emptyPolicies: empty.policies.length, emptyAdoptions: empty.adoptions.length },
    { guardTasks: [{ status: 'failed', attempts: 2, failureCode: 'COMPACTION_RETRIES_EXHAUSTED' },
                   { status: 'retry-pending', attempts: 1, failureCode: 'COMPACTION_SUMMARY_INVALID' }],
      guardAdoptions: 0, emptyTasks: 0, emptyPolicies: 0, emptyAdoptions: 0 });
} finally {
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(() => resolve()));
}
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
// Exit through the normal path: `process.exit` while a just-closed HTTP server still has
// handles pending trips a libuv assertion on Windows and destroys the raw exit code the
// receipt needs. An explicit process.exitCode lets the loop drain instead.
await new Promise(resolve => setTimeout(resolve, 100));
process.exitCode = counts.failed === 0 ? 0 : 1;
