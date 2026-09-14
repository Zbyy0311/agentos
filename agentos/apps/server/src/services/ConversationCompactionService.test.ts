import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/SqliteStore.js';
import { CompactionRepository } from '../store/CompactionRepository.js';
import { ConversationCompactionService, COMPACTION_ESTIMATOR_VERSION } from './ConversationCompactionService.js';
import { MemoryCandidateRepository } from '../store/MemoryCandidateRepository.js';
import { inTransaction } from '../store/Transaction.js';

const WS = 'ws_s6';
const CONV = 'conv_' + 'c'.repeat(26);
const NOW = '2026-09-12T16:00:00.000Z';

function fixture(summarizer?: { summarize: (request: never) => Promise<{ summary: string }> }) {
  const root = mkdtempSync(join(tmpdir(), 'agentos-s6-'));
  const store = new SqliteStore(root);
  const db = store.getDatabase();
  db.prepare('INSERT INTO workspaces (id,name,root_path,canonical_root_path,last_opened_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(WS, WS, root, root, NOW, NOW, NOW);
  db.prepare(`INSERT INTO cr_conversations (id, workspace_id, kind, status, title, created_at, updated_at, version)
    VALUES (?, ?, 'direct', 'active', 'c', ?, ?, 1)`).run(CONV, WS, NOW, NOW);
  const service = new ConversationCompactionService({
    store,
    ...(summarizer === undefined ? {} : { summarizer: summarizer as never }),
    now: () => NOW,
  });
  const compactions = new CompactionRepository(db);
  const candidates = new MemoryCandidateRepository(db);
  return { root, store, db, service, compactions, candidates, close: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

function messages(count: number, charsPerMessage: number) {
  return Array.from({ length: count }, (_v, index) => ({
    id: 'msg_' + String(index).padStart(3, '0'),
    senderType: index % 2 === 0 ? 'user' : 'agent',
    content: 'm' + index + ':' + 'x'.repeat(charsPerMessage),
    status: 'final',
    createdAt: NOW,
  }));
}

const BUDGET = {
  providerContextTokens: 2000, systemPromptTokens: 100, memoryContextTokens: 100, outputReserveTokens: 300,
};

test('S6: below the trigger ratio the engine is a noop', () => {
  const fx = fixture();
  try {
    const result = fx.service.evaluate({
      conversationId: CONV,
      policy: fx.service.policy('lite-v1')!,
      messages: messages(10, 40),
      budget: BUDGET,
    });
    assert.equal(result, undefined);
  } finally { fx.close(); }
});

test('S6: above the trigger the plan compresses a bounded prefix and keeps the recent window', () => {
  const fx = fixture();
  try {
    const policy = fx.service.policy('lite-v1')!;
    const history = messages(20, 400); // 20 * 100 tokens = 2000 tokens vs 1500 budget
    const plan = fx.service.evaluate({ conversationId: CONV, policy, messages: history, budget: BUDGET });
    assert.ok(plan);
    // Never touches the newest minRecentMessages (8) messages.
    assert.ok(plan!.sourceMessages.length <= 12);
    const retained = history.slice(-policy.minRecentMessages).map(message => message.id);
    for (const source of plan!.sourceMessages) assert.ok(!retained.includes(source.id));
    assert.equal(plan!.sourceStartMessageId, history[0]!.id);
    const budget = JSON.parse(plan!.budgetJson) as Record<string, unknown>;
    assert.equal(budget.policyVersion, 'lite-v1');
    assert.equal(budget.estimatorVersion, COMPACTION_ESTIMATOR_VERSION);
    assert.equal(budget.applicationBudgetSource, 'provider');
    assert.equal(budget.providerContextTokens, 2000);
    assert.equal(budget.historyBudgetTokens, 1500);
    assert.equal(budget.triggerRatio, 0.7);
    assert.equal(budget.retainedRecentMessages, 8);
  } finally { fx.close(); }
});

test('S6: the fallback application budget is labeled when no provider bound exists', () => {
  const fx = fixture();
  try {
    const policy = fx.service.policy('lite-v1')!;
    const plan = fx.service.evaluate({
      conversationId: CONV, policy,
      messages: messages(200, 400),
      budget: { ...BUDGET, providerContextTokens: null },
    });
    assert.ok(plan);
    const budget = JSON.parse(plan!.budgetJson) as Record<string, unknown>;
    assert.equal(budget.applicationBudgetSource, 'lite-v1-fallback');
    assert.equal(budget.appliedApplicationBudgetTokens, 16384);
  } finally { fx.close(); }
});

test('S6: publish writes summary, review-required candidate and workspace event atomically', async () => {
  const summaries: string[] = [];
  const fx = fixture({ summarize: async () => ({ summary: 'bounded summary of the old prefix' }) });
  try {
    const result = await fx.service.compact({
      workspaceId: WS, conversationId: CONV, policyVersion: 'lite-v1',
      messages: messages(20, 400), budget: BUDGET,
      provider: { providerConfigId: 'pcfg', providerType: 'codex', adapterId: 'builtin.codex', adapterVersion: '1.0.0', model: 'gpt-5.6-luna' },
    });
    assert.equal(result.outcome, 'published');
    assert.equal(result.task?.status, 'published');
    assert.equal(result.task?.providerType, 'codex');
    assert.equal(result.task?.model, 'gpt-5.6-luna');
    assert.equal(result.task?.sourceMessageCount, 12);
    assert.ok(result.task?.summary);
    const candidate = fx.candidates.findCandidateById(WS, result.task!.candidateId!)!;
    assert.equal(candidate.decision, 'review-required');
    assert.equal(candidate.authority, 'agent-derived');
    assert.equal(candidate.outcome, 'review-required');
    assert.deepEqual(candidate.sources.map((source: { kind: string }) => source.kind), ['conversation', 'message']);
    const events = fx.db.prepare("SELECT type, payload_json FROM workspace_events").all() as Array<{ type: string; payload_json: string }>;
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, 'memory.candidate_created');
    assert.equal((JSON.parse(events[0]!.payload_json) as { candidateId: string }).candidateId, candidate.id);
    assert.equal(summaries.length, 0);
    // replay over the same source converges on the published row without a second candidate
    const replay = await fx.service.compact({
      workspaceId: WS, conversationId: CONV, policyVersion: 'lite-v1',
      messages: messages(20, 400), budget: BUDGET,
      provider: { providerConfigId: 'pcfg', providerType: 'codex', adapterId: 'builtin.codex', adapterVersion: '1.0.0', model: 'gpt-5.6-luna' },
    });
    assert.equal(replay.outcome, 'published');
    assert.equal(replay.task?.id, result.task?.id);
    assert.equal((fx.db.prepare('SELECT COUNT(*) AS n FROM memory_candidate_entries').get() as { n: number }).n, 1);
    assert.equal((fx.db.prepare('SELECT COUNT(*) AS n FROM workspace_events').get() as { n: number }).n, 1);
  } finally { fx.close(); }
});

test('S6: the automatic retry chain is bounded, and only an explicit retry spends a new attempt', async () => {
  let calls = 0;
  const fx = fixture({ summarize: async () => { calls += 1; throw new Error('provider timeout'); } });
  try {
    const input = {
      workspaceId: WS, conversationId: CONV, policyVersion: 'lite-v1',
      messages: messages(20, 400), budget: BUDGET,
      provider: { providerConfigId: null, providerType: null, adapterId: null, adapterVersion: null, model: null },
    } as const;
    const first = await fx.service.compact(input as never);
    assert.equal(first.outcome, 'retry-pending');
    assert.equal(first.task?.attempts, 1);
    assert.equal(calls, 1, 'the first automatic attempt really called the summarizer');
    // LITE-09-107: the automatic retry continues the SAME durable attempt, so the bound
    // is spent instead of being renewed by evaluating again.
    const second = await fx.service.compact(input as never);
    assert.equal(second.outcome, 'failed');
    assert.equal(second.task?.id, first.task?.id, 'the retry resumes the existing attempt');
    assert.equal(second.task?.attempts, 2);
    assert.equal(second.task?.failureCode, 'COMPACTION_RETRIES_EXHAUSTED');
    assert.equal(calls, 2, 'one initial attempt plus exactly one automatic retry');
    // A spent source stays spent: the next Turn reports the durable failure and does not
    // schedule another Provider call.
    const third = await fx.service.compact(input as never);
    assert.equal(third.outcome, 'failed');
    assert.equal(third.task?.id, first.task?.id);
    assert.equal(calls, 2, 'a spent chain must not start a new Provider call');
    assert.equal(fx.compactions.listForConversation(WS, CONV).length, 1, 'no new task row for a spent source');
    // The retry the user explicitly asks for is the only way to spend another attempt.
    const explicit = await fx.service.compact({ ...input, resume: 'explicit' } as never);
    assert.equal(explicit.outcome, 'retry-pending');
    assert.notEqual(explicit.task?.id, first.task?.id, 'an explicit retry starts its own attempt');
    assert.equal(explicit.task?.attempts, 1);
    assert.equal(calls, 3);
    assert.equal((fx.db.prepare('SELECT COUNT(*) AS n FROM memory_candidate_entries').get() as { n: number }).n, 0);
    assert.equal((fx.db.prepare('SELECT COUNT(*) AS n FROM workspace_events').get() as { n: number }).n, 0);
  } finally { fx.close(); }
});

test('S6: an oversized or empty summary is refused instead of published', async () => {
  const oversized = fixture({ summarize: async () => ({ summary: 'y'.repeat(20000) }) });
  try {
    const result = await oversized.service.compact({
      workspaceId: WS, conversationId: CONV, policyVersion: 'lite-v1',
      messages: messages(20, 400), budget: BUDGET,
      provider: { providerConfigId: null, providerType: null, adapterId: null, adapterVersion: null, model: null },
    });
    assert.equal(result.outcome, 'retry-pending');
    assert.match(result.task!.failureCode ?? '', /COMPACTION_SUMMARY_INVALID/);
    assert.equal((oversized.db.prepare('SELECT COUNT(*) AS n FROM memory_candidate_entries').get() as { n: number }).n, 0);
  } finally { oversized.close(); }
});

test('S6: without a summary execution channel the task fails closed', async () => {
  const fx = fixture();
  try {
    const result = await fx.service.compact({
      workspaceId: WS, conversationId: CONV, policyVersion: 'lite-v1',
      messages: messages(20, 400), budget: BUDGET,
      provider: { providerConfigId: null, providerType: null, adapterId: null, adapterVersion: null, model: null },
    });
    assert.equal(result.outcome, 'failed');
    assert.equal(result.task?.failureCode, 'COMPACTION_SUMMARIZER_UNAVAILABLE');
    assert.equal((fx.db.prepare('SELECT COUNT(*) AS n FROM memory_candidate_entries').get() as { n: number }).n, 0);
  } finally { fx.close(); }
});
