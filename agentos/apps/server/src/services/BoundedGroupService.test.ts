import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { GroupInteractionBudgetV1 } from '@agentos/shared';
import { MigrationRegistry } from '../migrations/registry.js';
import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import { createFileBackupProvider } from '../migrations/backup.js';
import type { MinimalDatabaseSync } from '../migrations/types.js';
import { inTransaction, type TransactionDatabase } from '../store/Transaction.js';
import { ConversationRepository } from '../store/ConversationRepository.js';
import { AgentTurnRepository } from '../store/AgentTurnRepository.js';
import { GroupInteractionRepository } from '../store/GroupInteractionRepository.js';
import { TurnContextSnapshotRepository } from '../store/TurnContextSnapshotRepository.js';
import { createEntityId } from '../store/Identity.js';
import { ConversationStreamService } from './ConversationStreamService.js';
import {
  BoundedGroupError,
  BoundedGroupService,
  hashGroupReplyContent,
  type BoundedGroupErrorCode,
  type TurnContextSelector,
} from './BoundedGroupService.js';

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => SqliteDb;
};

const NOW = '2026-09-10T00:00:00.000Z';
const NOW2 = '2026-09-10T00:00:01.000Z';
const NOW3 = '2026-09-10T00:00:02.000Z';
const NOW4 = '2026-09-10T00:00:03.000Z';
const NOW5 = '2026-09-10T00:00:04.000Z';
const NOW6 = '2026-09-10T00:00:05.000Z';
const NOW7 = '2026-09-10T00:00:06.000Z';
const WS = 'ws_cr5s';
const CONV = 'conv_' + 'b'.repeat(26);
const SOURCE = 'msg_' + 'a'.repeat(26);

const BUDGET: GroupInteractionBudgetV1 = {
  maxAgentsPerTurn: 3,
  maxRepliesPerAgent: 2,
  maxTotalReplies: 5,
  maxAgentHops: 4,
};

function fixture(selector?: TurnContextSelector) {
  const root = mkdtempSync(join(tmpdir(), 'agentos-cr5-group-'));
  const db = new DatabaseSync(join(root, 'agentos.sqlite'));
  db.prepare('PRAGMA foreign_keys = ON').run();
  new MigrationRunner(db as unknown as MinimalDatabaseSync, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS), {
    backupProvider: createFileBackupProvider(join(root, 'backup')),
  }).run();
  db.prepare(
    'INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(WS, WS, 'C:/tmp/ws_cr5s', 'C:/tmp/ws_cr5s', NOW, NOW, NOW);
  const conversations = new ConversationRepository(db as unknown as TransactionDatabase);
  conversations.createConversation({ id: CONV, workspaceId: WS, kind: 'group', title: 'G', replyMode: 'sequential', createdAt: NOW });
  conversations.appendMessage({
    id: SOURCE, conversationId: CONV, workspaceId: WS,
    senderType: 'user', kind: 'text', status: 'final', content: 'source', createdAt: NOW,
  });
  const interactions = new GroupInteractionRepository(db as unknown as TransactionDatabase);
  const turns = new AgentTurnRepository(db as unknown as TransactionDatabase);
  const stream = new ConversationStreamService(db as unknown as TransactionDatabase, conversations, turns);
  const snapshots = new TurnContextSnapshotRepository(db as unknown as TransactionDatabase);
  const service = new BoundedGroupService(
    db as unknown as TransactionDatabase, interactions, snapshots, selector,
  );
  const createInteraction = service.createInteraction.bind(service);
  service.createInteraction = input => createInteraction({
    ...input, sourceMessageId: input.sourceMessageId ?? SOURCE,
  });
  return {
    db, conversations, interactions, turns, stream, snapshots, service,
    close: () => { try { db.close(); } finally { rmSync(root, { recursive: true, force: true }); } },
  };
}

let msgSeq = 0;
function agentMessage(fx: ReturnType<typeof fixture>, agentId: string, content: string) {
  msgSeq += 1;
  const n = String(msgSeq).padStart(4, '0');
  return fx.conversations.appendMessage({
    id: 'msg_' + n + 'c'.repeat(20),
    conversationId: CONV, workspaceId: WS,
    senderType: 'agent', senderAgentId: agentId, kind: 'text', status: 'final',
    content, createdAt: NOW,
  });
}

function replyInput(fx: ReturnType<typeof fixture>, agentId: string, content: string, extra: Record<string, unknown> = {}) {
  const createdAt = typeof extra.createdAt === 'string' ? extra.createdAt : NOW2;
  const interaction = fx.interactions.listInteractions(WS, CONV).slice(-1)[0];
  if (interaction === undefined || interaction.status !== 'active' || interaction.sourceMessageId === null) {
    const message = agentMessage(fx, agentId, content);
    const owner = interaction === undefined ? undefined : fx.service.findExecutionOwner(WS, interaction.id);
    return {
      workspaceId: WS, agentId, content, messageId: message.id,
      turnId: createEntityId('turn'), ownerId: owner?.ownerId ?? createEntityId('event'), ownerEpoch: owner?.ownerEpoch ?? 1,
      createdAt, ...extra,
    };
  }
  let owner = fx.service.findExecutionOwner(WS, interaction.id);
  if (owner === undefined) {
    owner = fx.service.claimExecution({
      workspaceId: WS, conversationId: CONV, interactionId: interaction.id,
      sourceMessageId: interaction.sourceMessageId, participantAgentIds: [agentId],
      ownerId: createEntityId('event'), createdAt,
    });
  }
  const turnId = createEntityId('turn');
  const messageId = createEntityId('message');
  fx.service.setExecutionCurrentTurn({
    workspaceId: WS, interactionId: interaction.id, ownerId: owner.ownerId,
    ownerEpoch: owner.ownerEpoch, agentId, turnId, messageId, updatedAt: createdAt,
  });
  const reservation = fx.stream.beginAgentTurnStream({
    workspaceId: WS, conversationId: CONV, turnId, messageId, agentId,
    sourceMessageId: interaction.sourceMessageId, createdAt,
  });
  fx.stream.finalizeStream({
    workspaceId: WS, turnId, messageId,
    expectedTurnVersion: reservation.turn.version, expectedMessageVersion: reservation.message.version,
    outcome: 'final', content, updatedAt: createdAt,
  });
  return {
    workspaceId: WS, agentId, content, messageId, turnId,
    ownerId: owner.ownerId, ownerEpoch: owner.ownerEpoch,
    createdAt,
    ...extra,
  };
}

function expectError(code: BoundedGroupErrorCode, fn: () => unknown): BoundedGroupError {
  let caught: unknown;
  try { fn(); } catch (error) { caught = error; }
  assert.ok(caught instanceof BoundedGroupError, 'expected BoundedGroupError');
  assert.equal((caught as BoundedGroupError).code, code);
  return caught as BoundedGroupError;
}

test('CR5S-01 a valid budget creates an active interaction; an invalid budget fails closed', () => {
  const fx = fixture();
  try {
    const interaction = fx.service.createInteraction({ workspaceId: WS, conversationId: CONV, budget: BUDGET, createdAt: NOW });
    assert.equal(interaction.status, 'active');
    assert.equal(interaction.replyCount, 0);
    assert.equal(interaction.hopCount, 0);
    assert.equal(interaction.maxTotalReplies, 5);
    expectError('GROUP_INPUT_INVALID', () => fx.service.createInteraction({
      workspaceId: WS, conversationId: CONV, createdAt: NOW,
      budget: { ...BUDGET, maxTotalReplies: 0 },
    }));
    assert.equal(fx.interactions.listInteractions(WS, CONV).length, 1);
  } finally { fx.close(); }
});

test('CR5S-02 recording replies increments counters transactionally', () => {
  const fx = fixture();
  try {
    const interaction = fx.service.createInteraction({ workspaceId: WS, conversationId: CONV, budget: BUDGET, createdAt: NOW });
    const r1 = fx.service.recordReply({ ...replyInput(fx, 'agent_a', 'one'), interactionId: interaction.id });
    assert.equal(r1.interaction.replyCount, 1);
    assert.equal(r1.interaction.hopCount, 0);
    assert.equal(r1.reply.hopOrder, 0);
    const r2 = fx.service.recordReply({ ...replyInput(fx, 'agent_b', 'two', { hopFromAgentId: 'agent_a' }), interactionId: interaction.id, createdAt: NOW3 });
    assert.equal(r2.interaction.replyCount, 2);
    assert.equal(r2.interaction.hopCount, 1);
    assert.equal(r2.reply.hopOrder, 1);
  } finally { fx.close(); }
});

test('CR5S-03 reaching the total cap exhausts the interaction with a stable reason', () => {
  const fx = fixture();
  try {
    const interaction = fx.service.createInteraction({
      workspaceId: WS, conversationId: CONV, createdAt: NOW,
      budget: { ...BUDGET, maxTotalReplies: 2, maxAgentsPerTurn: 2 },
    });
    fx.service.recordReply({ ...replyInput(fx, 'agent_a', 'one'), interactionId: interaction.id });
    const last = fx.service.recordReply({ ...replyInput(fx, 'agent_b', 'two'), interactionId: interaction.id, createdAt: NOW3 });
    assert.equal(last.interaction.status, 'exhausted');
    assert.equal(last.interaction.stopReason, 'budget-total-replies');
    assert.equal(last.interaction.endedAt, NOW3);
  } finally { fx.close(); }
});

test('CR5S-04 a reply beyond the total cap is blocked and not recorded', () => {
  const fx = fixture();
  try {
    const interaction = fx.service.createInteraction({
      workspaceId: WS, conversationId: CONV, createdAt: NOW,
      budget: { ...BUDGET, maxTotalReplies: 2, maxAgentsPerTurn: 2 },
    });
    fx.service.recordReply({ ...replyInput(fx, 'agent_a', 'one'), interactionId: interaction.id });
    fx.service.recordReply({ ...replyInput(fx, 'agent_b', 'two'), interactionId: interaction.id, createdAt: NOW3 });
    // the cap already exhausted the interaction at the boundary; further replies are
    // blocked because the interaction has terminated, carrying the same stable reason
    const err = expectError('GROUP_INTERACTION_TERMINATED', () => fx.service.recordReply({
      ...replyInput(fx, 'agent_c', 'three'), interactionId: interaction.id, createdAt: NOW4,
    }));
    assert.equal(err.stopReason, 'budget-total-replies');
    assert.equal(fx.interactions.listReplies(interaction.id).length, 2);
  } finally { fx.close(); }
});

test('CR5S-05 a per-Agent budget breach ends the interaction', () => {
  const fx = fixture();
  try {
    const interaction = fx.service.createInteraction({
      workspaceId: WS, conversationId: CONV, createdAt: NOW,
      budget: { ...BUDGET, maxRepliesPerAgent: 1 },
    });
    fx.service.recordReply({ ...replyInput(fx, 'agent_a', 'one'), interactionId: interaction.id });
    const err = expectError('GROUP_BUDGET_EXCEEDED', () => fx.service.recordReply({
      ...replyInput(fx, 'agent_a', 'two'), interactionId: interaction.id, createdAt: NOW3,
    }));
    assert.equal(err.stopReason, 'budget-replies-per-agent');
    assert.equal(fx.interactions.listReplies(interaction.id).length, 1);
  } finally { fx.close(); }
});

test('CR5S-06 a distinct-Agent budget breach ends the interaction', () => {
  const fx = fixture();
  try {
    const interaction = fx.service.createInteraction({
      workspaceId: WS, conversationId: CONV, createdAt: NOW,
      budget: { ...BUDGET, maxAgentsPerTurn: 2 },
    });
    fx.service.recordReply({ ...replyInput(fx, 'agent_a', 'one'), interactionId: interaction.id });
    fx.service.recordReply({ ...replyInput(fx, 'agent_b', 'two'), interactionId: interaction.id, createdAt: NOW3 });
    const err = expectError('GROUP_BUDGET_EXCEEDED', () => fx.service.recordReply({
      ...replyInput(fx, 'agent_c', 'three'), interactionId: interaction.id, createdAt: NOW4,
    }));
    assert.equal(err.stopReason, 'budget-agents');
    assert.equal(fx.interactions.listReplies(interaction.id).length, 2);
  } finally { fx.close(); }
});

test('CR5S-07 Stop blocks new replies and never cancels a Run', () => {
  const fx = fixture();
  try {
    const interaction = fx.service.createInteraction({ workspaceId: WS, conversationId: CONV, budget: BUDGET, createdAt: NOW });
    fx.service.recordReply({ ...replyInput(fx, 'agent_a', 'one'), interactionId: interaction.id });
    const stopped = fx.service.stopInteraction({
      workspaceId: WS, interactionId: interaction.id,
      expectedVersion: interaction.version + 1, endedAt: NOW3,
    });
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.stopReason, 'user-stop');
    expectError('GROUP_INTERACTION_TERMINATED', () => fx.service.recordReply({
      ...replyInput(fx, 'agent_b', 'two'), interactionId: interaction.id, createdAt: NOW4,
    }));
    // no Run was ever created by the group interaction
    assert.equal((fx.db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n, 0);
  } finally { fx.close(); }
});

test('CR5S-07b a final Provider result that races with stop is accounted once', () => {
  const fx = fixture();
  try {
    const interaction = fx.service.createInteraction({ workspaceId: WS, conversationId: CONV, budget: BUDGET, createdAt: NOW });
    // The Provider's final Message and Turn are already durable when stop wins;
    // reconciliation must attach that exact owner/current Turn once.
    const finalReply = replyInput(fx, 'agent_a', 'already finalized');
    const stopped = fx.service.stopInteraction({
      workspaceId: WS, interactionId: interaction.id,
      expectedVersion: interaction.version, endedAt: NOW2,
    });
    const reconciled = fx.service.recordFinalReplyAfterUserStop({
      ...finalReply,
      interactionId: interaction.id,
      createdAt: NOW3,
    });
    assert.equal(reconciled.reply.agentId, 'agent_a');
    assert.equal(reconciled.interaction.status, 'stopped');
    assert.equal(reconciled.interaction.stopReason, 'user-stop');
    assert.equal(reconciled.interaction.replyCount, 1);
    assert.equal(fx.interactions.listReplies(interaction.id).length, 1);
    assert.equal(stopped.version + 1, reconciled.interaction.version);
  } finally { fx.close(); }
});

test('F09: a stale stop version is a version conflict, never a budget error', () => {
  const fx = fixture();
  try {
    const interaction = fx.service.createInteraction({ workspaceId: WS, conversationId: CONV, budget: BUDGET, createdAt: NOW });
    const afterReply = fx.service.recordReply({ ...replyInput(fx, 'agent_a', 'one'), interactionId: interaction.id }).interaction;
    assert.equal(afterReply.version, interaction.version + 1);
    const error = expectError('GROUP_VERSION_CONFLICT', () => fx.service.stopInteraction({
      workspaceId: WS, interactionId: interaction.id,
      expectedVersion: interaction.version, endedAt: NOW3,
    }));
    assert.equal(error.code, 'GROUP_VERSION_CONFLICT');
    const latest = fx.service.findInteraction(WS, interaction.id)!;
    assert.equal(latest.status, 'active');
    assert.equal(latest.version, afterReply.version);
    assert.equal(latest.replyCount, 1);
  } finally { fx.close(); }
});

test('F11: a reply message from another workspace and conversation is rejected without ledger or budget writes', () => {
  const fx = fixture();
  try {
    fx.db.prepare(
      `INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('ws_foreign', 'Foreign', 'C:/tmp/foreign', 'C:/tmp/foreign', NOW, NOW, NOW);
    const foreignConversation = 'conv_' + 'f'.repeat(26);
    fx.conversations.createConversation({
      id: foreignConversation, workspaceId: 'ws_foreign', kind: 'group', title: 'Foreign',
      replyMode: 'sequential', createdAt: NOW,
    });
    const foreignMessage = fx.conversations.appendMessage({
      id: 'msg_' + 'f'.repeat(26), conversationId: foreignConversation, workspaceId: 'ws_foreign',
      senderType: 'agent', senderAgentId: 'agent_a', kind: 'text', status: 'final',
      content: 'foreign reply', createdAt: NOW,
    });
    const interaction = fx.service.createInteraction({ workspaceId: WS, conversationId: CONV, budget: BUDGET, createdAt: NOW });
    const associatedReply = replyInput(fx, 'agent_a', 'foreign reply');
    expectError('GROUP_REPLY_ASSOCIATION_INVALID', () => fx.service.recordReply({
      ...associatedReply,
      interactionId: interaction.id,
      messageId: foreignMessage.id,
    }));
    const unrelatedTurnId = createEntityId('turn');
    const unrelatedMessageId = createEntityId('message');
    const reservation = fx.stream.beginAgentTurnStream({
      workspaceId: WS, conversationId: CONV, turnId: unrelatedTurnId,
      messageId: unrelatedMessageId, agentId: 'agent_a', sourceMessageId: SOURCE, createdAt: NOW2,
    });
    fx.stream.finalizeStream({
      workspaceId: WS, turnId: unrelatedTurnId, messageId: unrelatedMessageId,
      expectedTurnVersion: reservation.turn.version, expectedMessageVersion: reservation.message.version,
      outcome: 'final', content: 'unrelated final message', updatedAt: NOW2,
    });
    expectError('GROUP_REPLY_ASSOCIATION_INVALID', () => fx.service.recordReply({
      ...associatedReply, interactionId: interaction.id, turnId: unrelatedTurnId,
    }));
    expectError('GROUP_REPLY_ASSOCIATION_INVALID', () => fx.service.recordReply({
      ...associatedReply, interactionId: interaction.id, agentId: 'agent_b',
    }));
    expectError('GROUP_REPLY_ASSOCIATION_INVALID', () => fx.service.recordReply({
      ...associatedReply, interactionId: interaction.id, content: 'content hash does not match final Message',
    }));
    assert.equal(fx.interactions.listReplies(interaction.id).length, 0);
    const latest = fx.service.findInteraction(WS, interaction.id)!;
    assert.equal(latest.replyCount, 0);
    assert.equal(latest.version, interaction.version);
  } finally { fx.close(); }
});

test('CR5S-08 a same-Agent cycle terminates the interaction with loop-guard', () => {
  const fx = fixture();
  try {
    const interaction = fx.service.createInteraction({ workspaceId: WS, conversationId: CONV, budget: BUDGET, createdAt: NOW });
    fx.service.recordReply({ ...replyInput(fx, 'agent_a', 'one'), interactionId: interaction.id });
    const err = expectError('GROUP_LOOP_GUARD', () => fx.service.recordReply({
      ...replyInput(fx, 'agent_a', 'self hop', { hopFromAgentId: 'agent_a' }), interactionId: interaction.id, createdAt: NOW3,
    }));
    assert.equal(err.loopGuardSignal, 'same-agent-cycle');
    assert.equal(fx.service.findInteraction(WS, interaction.id)?.loopGuardSignal, 'same-agent-cycle');
    assert.equal(fx.service.findInteraction(WS, interaction.id)?.status, 'exhausted');
    assert.equal(fx.interactions.listReplies(interaction.id).length, 1);
  } finally { fx.close(); }
});

test('CR5S-09 repeated content terminates the interaction with loop-guard', () => {
  const fx = fixture();
  try {
    const interaction = fx.service.createInteraction({ workspaceId: WS, conversationId: CONV, budget: BUDGET, createdAt: NOW });
    fx.service.recordReply({ ...replyInput(fx, 'agent_a', 'same text'), interactionId: interaction.id });
    const err = expectError('GROUP_LOOP_GUARD', () => fx.service.recordReply({
      ...replyInput(fx, 'agent_b', 'same text'), interactionId: interaction.id, createdAt: NOW3,
    }));
    assert.equal(err.loopGuardSignal, 'repeated-content');
    assert.equal(fx.interactions.listReplies(interaction.id).length, 1);
  } finally { fx.close(); }
});

test('CR5S-10 hops beyond the configured limit terminate the interaction', () => {
  const fx = fixture();
  try {
    const interaction = fx.service.createInteraction({
      workspaceId: WS, conversationId: CONV, createdAt: NOW,
      budget: { ...BUDGET, maxAgentHops: 1 },
    });
    fx.service.recordReply({ ...replyInput(fx, 'agent_a', 'one'), interactionId: interaction.id });
    fx.service.recordReply({ ...replyInput(fx, 'agent_b', 'two', { hopFromAgentId: 'agent_a' }), interactionId: interaction.id, createdAt: NOW3 });
    const err = expectError('GROUP_BUDGET_EXCEEDED', () => fx.service.recordReply({
      ...replyInput(fx, 'agent_a', 'three', { hopFromAgentId: 'agent_b' }), interactionId: interaction.id, createdAt: NOW4,
    }));
    assert.equal(err.stopReason, 'budget-hops');
    assert.equal(err.loopGuardSignal, 'hops-exceeded');
    assert.equal(fx.interactions.listReplies(interaction.id).length, 2);
  } finally { fx.close(); }
});

test('CR5S-11 a repeated mention with no new information terminates the interaction', () => {
  const fx = fixture();
  try {
    const interaction = fx.service.createInteraction({ workspaceId: WS, conversationId: CONV, budget: BUDGET, createdAt: NOW });
    fx.service.recordReply({ ...replyInput(fx, 'agent_a', 'first', { mentionTargets: ['agent_b'] }), interactionId: interaction.id });
    fx.service.recordReply({ ...replyInput(fx, 'agent_b', 'reply', { hopFromAgentId: 'agent_a' }), interactionId: interaction.id, createdAt: NOW3 });
    // agent_a mentions agent_b again (re-mention by the same Agent)
    const err = expectError('GROUP_LOOP_GUARD', () => fx.service.recordReply({
      ...replyInput(fx, 'agent_a', 'again', { hopFromAgentId: 'agent_b', mentionTargets: ['agent_b'] }),
      interactionId: interaction.id, createdAt: NOW4,
    }));
    assert.equal(err.loopGuardSignal, 'repeated-mention-no-new-information');
    assert.equal(fx.interactions.listReplies(interaction.id).length, 2);
  } finally { fx.close(); }
});

test('CR5S-12 every recorded reply stores a distinct Turn-scoped per-Agent context snapshot', () => {
  const selector: TurnContextSelector = {
    select: ({ agentId }) => ({ selectedEntryIds: ['mem_' + agentId], totalTokens: 3, truncated: false }),
  };
  const fx = fixture(selector);
  try {
    const interaction = fx.service.createInteraction({ workspaceId: WS, conversationId: CONV, budget: BUDGET, createdAt: NOW });
    const r1 = fx.service.recordReply({ ...replyInput(fx, 'agent_a', 'one'), interactionId: interaction.id });
    const r2 = fx.service.recordReply({ ...replyInput(fx, 'agent_b', 'two'), interactionId: interaction.id, createdAt: NOW3 });
    assert.notEqual(r1.contextSnapshot.id, r2.contextSnapshot.id);
    assert.equal(r1.contextSnapshot.agentId, 'agent_a');
    assert.equal(r2.contextSnapshot.agentId, 'agent_b');
    assert.equal(r1.reply.contextSnapshotId, r1.contextSnapshot.id);
    assert.equal(r2.reply.contextSnapshotId, r2.contextSnapshot.id);
    assert.equal(fx.snapshots.listByInteraction(interaction.id).length, 2);
  } finally { fx.close(); }
});

test('CR5S-13 per-Agent snapshots are isolated for the same interaction', () => {
  const selector: TurnContextSelector = {
    select: ({ agentId }) => ({ selectedEntryIds: ['mem_only_' + agentId], totalTokens: 1, truncated: false }),
  };
  const fx = fixture(selector);
  try {
    const interaction = fx.service.createInteraction({ workspaceId: WS, conversationId: CONV, budget: BUDGET, createdAt: NOW });
    fx.service.recordReply({ ...replyInput(fx, 'agent_a', 'one'), interactionId: interaction.id });
    fx.service.recordReply({ ...replyInput(fx, 'agent_b', 'two'), interactionId: interaction.id, createdAt: NOW3 });
    const aSnap = fx.snapshots.listByInteraction(interaction.id).find(s => s.agentId === 'agent_a');
    const bSnap = fx.snapshots.listByInteraction(interaction.id).find(s => s.agentId === 'agent_b');
    assert.deepEqual(JSON.parse(aSnap!.selectedEntryIdsJson), ['mem_only_agent_a']);
    assert.deepEqual(JSON.parse(bSnap!.selectedEntryIdsJson), ['mem_only_agent_b']);
    assert.ok(!JSON.parse(aSnap!.selectedEntryIdsJson).some((id: string) => id.includes('agent_b')));
  } finally { fx.close(); }
});

test('CR5S-14 reply content is stored as a hash only, never as text', () => {
  const fx = fixture();
  try {
    const interaction = fx.service.createInteraction({ workspaceId: WS, conversationId: CONV, budget: BUDGET, createdAt: NOW });
    const r = fx.service.recordReply({ ...replyInput(fx, 'agent_a', 'the secret draft'), interactionId: interaction.id });
    assert.equal(r.reply.contentHash, hashGroupReplyContent('the secret draft'));
    const columns = (fx.db.prepare('PRAGMA table_info(cr_group_interaction_replies)').all() as Array<{ name: string }>).map(c => c.name);
    assert.ok(!columns.includes('content'));
    assert.ok(r.reply.contentHash.length === 64 && !r.reply.contentHash.includes('secret'));
  } finally { fx.close(); }
});

test('CR5S-15 the timeout budget ends the interaction', () => {
  const fx = fixture();
  try {
    const interaction = fx.service.createInteraction({
      workspaceId: WS, conversationId: CONV, createdAt: NOW,
      budget: { ...BUDGET, timeoutMs: 1000 },
    });
    fx.service.recordReply({ ...replyInput(fx, 'agent_a', 'one', { createdAt: NOW2 }), interactionId: interaction.id });
    const err = expectError('GROUP_BUDGET_EXCEEDED', () => fx.service.recordReply({
      ...replyInput(fx, 'agent_b', 'two', { createdAt: '2026-09-10T00:00:03.000Z' }), interactionId: interaction.id,
    }));
    assert.equal(err.stopReason, 'budget-timeout');
  } finally { fx.close(); }
});

test('CR5S-16 unknown interaction and invalid input fail closed', () => {
  const fx = fixture();
  try {
    expectError('GROUP_INTERACTION_NOT_FOUND', () => fx.service.recordReply({ ...replyInput(fx, 'agent_a', 'x'), interactionId: 'conv_missing' }));
    const interaction = fx.service.createInteraction({ workspaceId: WS, conversationId: CONV, budget: BUDGET, createdAt: NOW });
    expectError('GROUP_INPUT_INVALID', () => fx.service.recordReply({ ...replyInput(fx, 'agent_a', 'x'), interactionId: interaction.id, agentId: '  ' }));
  } finally { fx.close(); }
});

test('CR5S-17 within-transaction composition rolls back atomically', () => {
  const fx = fixture();
  try {
    const interaction = fx.service.createInteraction({ workspaceId: WS, conversationId: CONV, budget: BUDGET, createdAt: NOW });
    assert.throws(() => inTransaction(fx.db, () => {
      fx.service.recordReplyWithinTransaction({ ...replyInput(fx, 'agent_a', 'one'), interactionId: interaction.id });
      throw new Error('boom');
    }));
    assert.equal(fx.interactions.listReplies(interaction.id).length, 0);
    assert.equal(fx.interactions.findInteractionById(WS, interaction.id)?.replyCount, 0);
    assert.equal(fx.snapshots.listByInteraction(interaction.id).length, 0);
  } finally { fx.close(); }
});
