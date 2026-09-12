import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/SqliteStore.js';
import { ConversationCompactionService } from './ConversationCompactionService.js';
import { ConversationCompactionTrigger } from './ConversationCompactionTrigger.js';
import { CompactionRepository } from '../store/CompactionRepository.js';
import { inTransaction } from '../store/Transaction.js';
import type { AgentProfile } from '@agentos/shared';

const WS = 'ws_s6_trigger';
const CONV = 'conv_' + 't'.repeat(26);
const NOW = '2026-09-12T16:00:00.000Z';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentos-s6-trigger-'));
  const store = new SqliteStore(root);
  const db = store.getDatabase();
  db.prepare('INSERT INTO workspaces (id,name,root_path,canonical_root_path,last_opened_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(WS, WS, root, root, NOW, NOW, NOW);
  db.prepare(`INSERT INTO cr_conversations (id, workspace_id, kind, status, title, created_at, updated_at, version)
    VALUES (?, ?, 'direct', 'active', 'c', ?, ?, 1)`).run(CONV, WS, NOW, NOW);
  // The real engine seeds the frozen lite-v1 policy row on construction; the
  // trigger reads that row instead of carrying its own defaults.
  const seeder = new ConversationCompactionService({ store, now: () => NOW });
  assert.ok(seeder.policy('lite-v1'), 'lite-v1 policy must be seeded');
  return { root, store, close: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

function agent(overrides: Partial<AgentProfile>): AgentProfile {
  return {
    id: 'agent_codex',
    name: 'Codex',
    role: 'codex_manager',
    enabled: true,
    cliCommand: 'codex',
    cliArgs: [],
    model: 'gpt-5.6-luna',
    thinkingEffort: 'low',
    systemPrompt: 'you are a manager',
    workspaceId: WS,
    ...overrides,
  } as unknown as AgentProfile;
}

function fakeEngine(captured: { input?: Record<string, unknown> }, outcome: string = 'noop') {
  return {
    compact: async (input: Record<string, unknown>) => {
      captured.input = input;
      return { outcome, task: { id: 'cmp_task_1' } };
    },
  } as unknown as ConversationCompactionService;
}

test('S6 trigger fails closed when the lite-v1 policy row is missing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentos-s6-nopolicy-'));
  const store = new SqliteStore(root);
  const db = store.getDatabase();
  db.prepare('INSERT INTO workspaces (id,name,root_path,canonical_root_path,last_opened_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(WS, WS, root, root, NOW, NOW, NOW);
  db.prepare(`INSERT INTO cr_conversations (id, workspace_id, kind, status, title, created_at, updated_at, version)
    VALUES (?, ?, 'direct', 'active', 'c', ?, ?, 1)`).run(CONV, WS, NOW, NOW);
  const errors: string[] = [];
  const captured: { input?: Record<string, unknown> } = {};
  const trigger = new ConversationCompactionTrigger({
    store,
    engine: fakeEngine(captured),
    getAgent: () => agent({}),
    onError: code => errors.push(code),
  });
  await trigger.ensureCompacted({ workspaceId: WS, conversationId: CONV, agentId: 'agent_codex' });
  assert.deepEqual(errors, ['COMPACTION_POLICY_UNAVAILABLE']);
  assert.equal(captured.input, undefined);
  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('S6 trigger reports a missing Agent and never calls the engine', async () => {
  const fx = fixture();
  const errors: string[] = [];
  const captured: { input?: Record<string, unknown> } = {};
  const trigger = new ConversationCompactionTrigger({
    store: fx.store,
    engine: fakeEngine(captured),
    getAgent: () => undefined,
    onError: code => errors.push(code),
  });
  await trigger.ensureCompacted({ workspaceId: WS, conversationId: CONV, agentId: 'agent_codex' });
  assert.deepEqual(errors, ['COMPACTION_AGENT_UNAVAILABLE']);
  assert.equal(captured.input, undefined);
  fx.close();
});

test('S6 trigger fails closed for a CLI with no allowlisted summary profile', async () => {
  const fx = fixture();
  const errors: string[] = [];
  const captured: { input?: Record<string, unknown> } = {};
  const trigger = new ConversationCompactionTrigger({
    store: fx.store,
    engine: fakeEngine(captured),
    getAgent: () => agent({ cliCommand: 'kimi', role: 'kimi' }),
    onError: code => errors.push(code),
  });
  await trigger.ensureCompacted({ workspaceId: WS, conversationId: CONV, agentId: 'agent_codex' });
  assert.deepEqual(errors, ['COMPACTION_SUMMARIZER_UNAVAILABLE']);
  assert.equal(captured.input, undefined);
  fx.close();
});

test('S6 trigger freezes the Conversation model and the allowlisted adapter identity', async () => {
  const fx = fixture();
  const attempts: Array<Record<string, unknown>> = [];
  const captured: { input?: Record<string, unknown> } = {};
  const trigger = new ConversationCompactionTrigger({
    store: fx.store,
    engine: fakeEngine(captured, 'published'),
    getAgent: () => agent({ providerConfigId: 'pc_1' }),
    onAttempt: attempt => attempts.push(attempt as unknown as Record<string, unknown>),
  });
  await trigger.ensureCompacted({ workspaceId: WS, conversationId: CONV, agentId: 'agent_codex' });
  const provider = captured.input?.provider as Record<string, unknown>;
  assert.deepEqual(provider, {
    providerConfigId: 'pc_1',
    providerType: 'codex',
    adapterId: 'cli.codex',
    adapterVersion: '1.0.0',
    model: 'gpt-5.6-luna',
  });
  assert.equal(captured.input?.policyVersion, 'lite-v1');
  const budget = captured.input?.budget as Record<string, unknown>;
  assert.equal(budget.providerContextTokens, null);
  assert.equal(budget.outputReserveTokens, 2048);
  assert.ok(Number(budget.systemPromptTokens) > 0);
  assert.deepEqual(attempts, [{ outcome: 'published', policyVersion: 'lite-v1', taskId: 'cmp_task_1' }]);
  fx.close();
});

/**
 * S6 / LITE-09-107: a crash or restart leaves a durable `running` row. The
 * trigger must decide from the PERSISTED lease, never from elapsed wall-clock
 * guessed by the caller.
 */
function seedRunningAttempt(fx: ReturnType<typeof fixture>, leaseExpiresAt: string): string {
  const db = fx.store.getDatabase();
  const policy = db.prepare("SELECT id FROM conversation_compaction_policies WHERE policy_version = 'lite-v1'").get() as { id: string };
  const repository = new CompactionRepository(db);
  const created = inTransaction(db, () => repository.createTaskWithinTransaction({
    id: 'snapshot_recovery_1', workspaceId: WS, conversationId: CONV, policyId: policy.id,
    sourceStartMessageId: 'msg_001', sourceEndMessageId: 'msg_004', sourceMessageCount: 4,
    sourceHash: 'a'.repeat(64), priorSummaryId: null,
    budgetJson: JSON.stringify({ policyVersion: 'lite-v1' }),
    providerConfigId: null, providerType: 'codex', adapterId: 'cli.codex', adapterVersion: '1.0.0',
    model: 'gpt-5.6-luna', estimatorVersion: 'lite-v1-chars4', createdAt: NOW,
  }));
  inTransaction(db, () => repository.claimRunningWithinTransaction({
    workspaceId: WS, id: created.id, expectedVersion: created.version,
    leaseOwner: 'compaction-engine', leaseExpiresAt, now: NOW, attempt: 1,
  }));
  return created.id;
}

test('S6 trigger reclaims an EXPIRED running lease before attempting again', async () => {
  const fx = fixture();
  const expiredAt = '2026-09-12T15:00:00.000Z';
  const taskId = seedRunningAttempt(fx, expiredAt);
  const recoveries: Array<{ taskId: string; expiredLeaseAt: string }> = [];
  const captured: { input?: Record<string, unknown> } = {};
  const trigger = new ConversationCompactionTrigger({
    store: fx.store,
    engine: fakeEngine(captured, 'published'),
    getAgent: () => agent({}),
    now: () => NOW,
    onRecovery: observation => recoveries.push(observation),
  });
  await trigger.ensureCompacted({ workspaceId: WS, conversationId: CONV, agentId: 'agent_codex' });
  assert.deepEqual(recoveries, [{ taskId, expiredLeaseAt: expiredAt }]);
  const stored = fx.store.getDatabase()
    .prepare('SELECT status, failure_code FROM conversation_compactions WHERE id = ?')
    .get(taskId) as { status: string; failure_code: string | null };
  assert.equal(stored.status, 'retry-pending');
  assert.equal(stored.failure_code, 'COMPACTION_LEASE_EXPIRED');
  // The reclaimed attempt does not block the new one.
  assert.ok(captured.input, 'the trigger must continue after reclaiming');
  fx.close();
});

test('S6 trigger never steals a live lease', async () => {
  const fx = fixture();
  const liveUntil = '2026-09-12T17:00:00.000Z';
  const taskId = seedRunningAttempt(fx, liveUntil);
  const captured: { input?: Record<string, unknown> } = {};
  const recoveries: unknown[] = [];
  const trigger = new ConversationCompactionTrigger({
    store: fx.store,
    engine: fakeEngine(captured, 'published'),
    getAgent: () => agent({}),
    now: () => NOW,
    onRecovery: observation => recoveries.push(observation),
  });
  await trigger.ensureCompacted({ workspaceId: WS, conversationId: CONV, agentId: 'agent_codex' });
  assert.deepEqual(recoveries, []);
  assert.equal(captured.input, undefined, 'a live attempt must not be duplicated');
  const stored = fx.store.getDatabase()
    .prepare('SELECT status, lease_owner FROM conversation_compactions WHERE id = ?')
    .get(taskId) as { status: string; lease_owner: string | null };
  assert.equal(stored.status, 'running');
  assert.equal(stored.lease_owner, 'compaction-engine');
  fx.close();
});

test('S6 trigger never breaks the Turn when the engine attempt throws', async () => {
  const fx = fixture();
  const errors: Array<[string, unknown]> = [];
  const trigger = new ConversationCompactionTrigger({
    store: fx.store,
    engine: {
      compact: async () => { throw new Error('lease conflict'); },
    } as unknown as ConversationCompactionService,
    getAgent: () => agent({}),
    onError: (code, error) => errors.push([code, error]),
  });
  await trigger.ensureCompacted({ workspaceId: WS, conversationId: CONV, agentId: 'agent_codex' });
  assert.equal(errors.length, 1);
  assert.equal(errors[0]![0], 'COMPACTION_ATTEMPT_FAILED');
  assert.equal((errors[0]![1] as Error).message, 'lease conflict');
  fx.close();
});
