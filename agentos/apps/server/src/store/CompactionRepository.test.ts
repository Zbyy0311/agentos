import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { SqliteStore } from './SqliteStore.js';
import { inTransaction } from './Transaction.js';
import {
  CompactionPolicyRepository,
  CompactionRepository,
  CompactionRepositoryError,
} from './CompactionRepository.js';

const NOW = '2026-09-12T15:00:00.000Z';
const LATER = '2026-09-12T15:01:00.000Z';
const WS = 'ws_compaction';
const CONV = 'conv_' + 'a'.repeat(26);

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentos-compaction-'));
  const store = new SqliteStore(root);
  const db = store.getDatabase();
  db.prepare('INSERT INTO workspaces (id,name,root_path,canonical_root_path,last_opened_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(WS, WS, root, root, NOW, NOW, NOW);
  db.prepare(`INSERT INTO cr_conversations (id, workspace_id, kind, status, title, created_at, updated_at, version)
    VALUES (?, ?, 'direct', 'active', 'c', ?, ?, 1)`).run(CONV, WS, NOW, NOW);
  const policies = new CompactionPolicyRepository(db);
  const compactions = new CompactionRepository(db);
  const policy = inTransaction(db, () => policies.createWithinTransaction({
    id: 'policy_lite_v1', policyVersion: 'lite-v1', triggerRatio: 0.7, targetRatio: 0.5,
    minRecentMessages: 8, summaryMaxTokens: 2048, timeoutMs: 120_000, maxAutomaticRetries: 1,
    fallbackApplicationBudgetTokens: 16384, parametersJson: JSON.stringify({ policyVersion: 'lite-v1' }),
    checksum: hash('lite-v1'), createdAt: NOW,
  }));
  // The published compaction references a real review-required Candidate (FK proof).
  db.prepare(`INSERT INTO memory_candidate_entries (
    id, workspace_id, scope, category, authority, confidence, importance, title, summary, content,
    tags_json, token_estimate, inferred_preference, scope_promotion, contains_secret, outcome, decision,
    created_at, version
  ) VALUES ('cand_1', ?, 'workspace', 'summary', 'agent-derived', 0.6, 0.5, 'compaction summary', '', '',
    '[]', 8, 0, 0, 0, 'review-required', 'review-required', ?, 1)`).run(WS, NOW);
  return { root, store, db, policies, compactions, policy, close: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: 'comp_1', workspaceId: WS, conversationId: CONV, policyId: 'policy_lite_v1',
    sourceStartMessageId: 'msg_1', sourceEndMessageId: 'msg_20', sourceMessageCount: 20,
    sourceHash: hash('source'), priorSummaryId: null, budgetJson: JSON.stringify({ applicationBudgetTokens: 16384, estimatorVersion: 'lite-v1-chars4' }),
    providerConfigId: 'pcfg_1', providerType: 'codex', adapterId: 'builtin.codex', adapterVersion: '1.0.0',
    model: 'gpt-5.6-luna', estimatorVersion: 'lite-v1-chars4', createdAt: NOW, ...overrides,
  };
}

test('S6/029: policy rows are immutable and versioned', () => {
  const fx = fixture();
  try {
    assert.equal(fx.policy.policyVersion, 'lite-v1');
    assert.equal(fx.policy.triggerRatio, 0.7);
    assert.equal(fx.policy.minRecentMessages, 8);
    assert.throws(() => fx.db.prepare("UPDATE conversation_compaction_policies SET trigger_ratio = 0.9 WHERE id = 'policy_lite_v1'").run(),
      /COMPACTION_POLICY_IMMUTABLE/);
    assert.throws(() => inTransaction(fx.db, () => fx.policies.createWithinTransaction({
      id: 'policy_dup', policyVersion: 'lite-v1', triggerRatio: 0.7, targetRatio: 0.5, minRecentMessages: 8,
      summaryMaxTokens: 2048, timeoutMs: 120_000, maxAutomaticRetries: 1, fallbackApplicationBudgetTokens: 16384,
      parametersJson: '{}', checksum: hash('x'), createdAt: NOW,
    })), /COMPACTION_CONFLICT/);
  } finally { fx.close(); }
});

test('S6/029: one compaction task moves pending -> running -> published under version CAS', () => {
  const fx = fixture();
  try {
    const created = inTransaction(fx.db, () => fx.compactions.createTaskWithinTransaction(task() as never));
    assert.equal(created.status, 'pending');
    assert.equal(created.attempts, 0);
    const running = inTransaction(fx.db, () => fx.compactions.claimRunningWithinTransaction({
      workspaceId: WS, id: created.id, expectedVersion: created.version, leaseOwner: 'holder-a',
      leaseExpiresAt: LATER, now: NOW,
    }));
    assert.equal(running.status, 'running');
    assert.equal(running.leaseOwner, 'holder-a');
    assert.equal(running.attempts, 1);
    // a second holder cannot claim the same task
    assert.throws(() => inTransaction(fx.db, () => fx.compactions.claimRunningWithinTransaction({
      workspaceId: WS, id: created.id, expectedVersion: created.version, leaseOwner: 'holder-b',
      leaseExpiresAt: LATER, now: NOW,
    })), /COMPACTION_CONFLICT/);
    const published = inTransaction(fx.db, () => fx.compactions.publishWithinTransaction({
      workspaceId: WS, id: created.id, expectedVersion: running.version, leaseOwner: 'holder-a',
      summary: 'bounded summary', summaryHash: hash('bounded summary'), summaryTokenEstimate: 12,
      candidateId: 'cand_1', publishedAt: LATER,
    }));
    assert.equal(published.status, 'published');
    assert.equal(published.leaseOwner, null);
    assert.equal(published.candidateId, 'cand_1');
    assert.throws(() => fx.db.prepare("UPDATE conversation_compactions SET summary = 'tampered' WHERE id = 'comp_1'").run(),
      /COMPACTION_PUBLISHED_IMMUTABLE/);
    assert.throws(() => fx.db.prepare("UPDATE conversation_compactions SET source_hash = ? WHERE id = 'comp_1'").run(hash('other')),
      /COMPACTION_IDENTITY_IMMUTABLE/);
    assert.equal(fx.compactions.findLatestPublished(WS, CONV)?.id, 'comp_1');
  } finally { fx.close(); }
});

test('S6/029: one running compaction per Conversation and bounded retry/failure branches', () => {
  const fx = fixture();
  try {
    const first = inTransaction(fx.db, () => fx.compactions.createTaskWithinTransaction(task() as never));
    inTransaction(fx.db, () => fx.compactions.claimRunningWithinTransaction({
      workspaceId: WS, id: first.id, expectedVersion: first.version, leaseOwner: 'holder-a',
      leaseExpiresAt: LATER, now: NOW,
    }));
    // the partial unique index refuses a second running task for the same conversation
    const second = inTransaction(fx.db, () => fx.compactions.createTaskWithinTransaction(task({ id: 'comp_2', sourceHash: hash('source-2') }) as never));
    assert.throws(() => inTransaction(fx.db, () => fx.compactions.claimRunningWithinTransaction({
      workspaceId: WS, id: second.id, expectedVersion: second.version, leaseOwner: 'holder-b',
      leaseExpiresAt: LATER, now: NOW,
    })), /COMPACTION_CONFLICT/);
    const runningFirst = fx.compactions.findById(WS, first.id)!;
    const retry = inTransaction(fx.db, () => fx.compactions.retryPendingWithinTransaction({
      workspaceId: WS, id: first.id, expectedVersion: runningFirst.version, failureCode: 'COMPACTION_TIMEOUT',
      failureMessage: 'summary timed out', now: LATER,
    }));
    assert.equal(retry.status, 'retry-pending');
    assert.equal(retry.leaseOwner, null);
    const runningRetry = inTransaction(fx.db, () => fx.compactions.claimRunningWithinTransaction({
      workspaceId: WS, id: first.id, expectedVersion: retry.version, leaseOwner: 'holder-a',
      leaseExpiresAt: LATER, now: LATER, attempt: 2,
    }));
    assert.equal(runningRetry.attempts, 2);
    const failed = inTransaction(fx.db, () => fx.compactions.failWithinTransaction({
      workspaceId: WS, id: first.id, expectedVersion: runningRetry.version, failureCode: 'COMPACTION_RETRIES_EXHAUSTED',
      failureMessage: 'retry budget exhausted', now: LATER,
    }));
    assert.equal(failed.status, 'failed');
    assert.equal(failed.failureCode, 'COMPACTION_RETRIES_EXHAUSTED');
    // a failed task is no longer the active one
    assert.equal(fx.compactions.findActive(WS, CONV)?.id, 'comp_2');
  } finally { fx.close(); }
});
