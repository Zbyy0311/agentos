/**
 * Controlled Group bounded execution — gates CG-S5..CG-S9 plus the walk's own
 * invariants (plan order, per-Agent context, no Run-scoped rows).
 *
 * Authorization: `docs/implementation/milestones/CG-orchestration-entry-audit.md`
 * section 5.2; decisions D1=B, D2=A, D3 off.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConversationRunResult } from '@agentos/agent-core';
import type { ConversationReplyMode } from '@agentos/shared';
import { MigrationRegistry } from '../migrations/registry.js';
import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import { createFileBackupProvider } from '../migrations/backup.js';
import type { MinimalDatabaseSync } from '../migrations/types.js';
import type { TransactionDatabase } from '../store/Transaction.js';
import { ConversationRepository } from '../store/ConversationRepository.js';
import { AgentTurnRepository } from '../store/AgentTurnRepository.js';
import { GroupInteractionRepository } from '../store/GroupInteractionRepository.js';
import { TurnContextSnapshotRepository } from '../store/TurnContextSnapshotRepository.js';
import { createEntityId } from '../store/Identity.js';
import { BoundedGroupService } from './BoundedGroupService.js';
import { ConversationStreamService } from './ConversationStreamService.js';
import { GroupTurnDriver, GroupTurnDriverError } from './GroupTurnDriver.js';

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

const NOW = '2026-09-11T00:00:00.000Z';
const LATER = '2026-09-11T02:00:00.000Z';
const WS = 'ws_cgw';
const CONV = 'conv_' + 'c'.repeat(26);
const USER_MSG = 'msg_' + 'd'.repeat(26);
const AGENTS = ['agent_a', 'agent_b', 'agent_c'] as const;

const BUDGET = {
  maxAgentsPerTurn: 5, maxRepliesPerAgent: 3, maxTotalReplies: 12, maxAgentHops: 8,
};
/** One mock Provider behavior per speaker, in walk order. */
interface SpeakerBehavior {
  readonly deltas?: readonly string[];
  readonly result: ConversationRunResult;
}

function makeResult(status: ConversationRunResult['status'], content: string): ConversationRunResult {
  return { status, content, mode: 'mock', startedAt: NOW, completedAt: NOW2 } as unknown as ConversationRunResult;
}

const NOW2 = '2026-09-11T01:00:00.000Z';

interface WalkLogEntry {
  readonly kind: 'start' | 'end';
  readonly callIndex: number;
}

function fixture(behaviors: readonly SpeakerBehavior[], replyMode: ConversationReplyMode = 'sequential') {
  const root = mkdtempSync(join(tmpdir(), 'agentos-cgwalk-'));
  const db = new DatabaseSync(join(root, 'agentos.sqlite'));
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner(db as unknown as MinimalDatabaseSync, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS), {
    backupProvider: createFileBackupProvider(join(root, 'backup')),
  }).run();
  db.prepare(
    'INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(WS, WS, 'C:/tmp/ws_cgw', 'C:/tmp/ws_cgw', NOW, NOW, NOW);
  const conversations = new ConversationRepository(db as unknown as TransactionDatabase);
  conversations.createConversation({
    id: CONV, workspaceId: WS, kind: 'group', title: 'G', replyMode, createdAt: NOW,
  });
  conversations.addMember({
    id: createEntityId('conversation'), conversationId: CONV, workspaceId: WS,
    subjectType: 'user', subjectId: 'user_self', displayNameSnapshot: 'You', role: 'owner',
    replyMode: 'always', joinedAt: NOW,
  });
  AGENTS.forEach((agentId, index) => conversations.addMember({
    id: createEntityId('conversation'), conversationId: CONV, workspaceId: WS,
    subjectType: 'agent', subjectId: agentId, displayNameSnapshot: agentId, role: 'participant',
    replyMode: 'always', joinedAt: '2026-09-11T00:00:0' + String(index + 1) + '.000Z',
  }));
  conversations.appendMessage({
    id: USER_MSG, conversationId: CONV, workspaceId: WS,
    senderType: 'user', kind: 'text', status: 'final', content: '请评审这个设计。', createdAt: NOW,
  });

  const tx = db as unknown as TransactionDatabase;
  const turns = new AgentTurnRepository(tx);
  const interactions = new GroupInteractionRepository(tx);
  const snapshots = new TurnContextSnapshotRepository(tx);
  const stream = new ConversationStreamService(tx, conversations, turns);
  const boundedGroups = new BoundedGroupService(tx, interactions, snapshots);

  let callIndex = 0;
  const walkLog: WalkLogEntry[] = [];
  const deltas: Array<{ agentId: string; delta: string }> = [];
  const runnerFactory = (options: unknown) => {
    const runnerOptions = options as { onEvent?: (event: { status: string; activity: string; content?: string }) => void };
    const myIndex = callIndex;
    callIndex += 1;
    const behavior = behaviors[myIndex] ?? { result: makeResult('completed', 'unexpected extra speaker') };
    return {
      run: async () => {
        walkLog.push({ kind: 'start', callIndex: myIndex });
        await new Promise<void>(resolve => setImmediate(resolve));
        for (const delta of behavior.deltas ?? []) {
          runnerOptions.onEvent?.({ status: 'streaming_response', activity: '', content: delta });
        }
        walkLog.push({ kind: 'end', callIndex: myIndex });
        return behavior.result;
      },
    };
  };

  const driver = new GroupTurnDriver(
    boundedGroups, interactions, conversations, stream,
    (_workspaceId, agentId) => (AGENTS as readonly string[]).includes(agentId) ? ({} as never) : undefined,
  );

  const counts = (table: string) => Number((db.prepare('SELECT COUNT(*) AS n FROM ' + table).get() as { n: number | bigint }).n);
  return {
    db, boundedGroups, interactions, driver, walkLog, deltas, counts, runnerFactory,
    close: () => { try { db.close(); } finally { rmSync(root, { recursive: true, force: true }); } },
  };
}
function walkInput(fx: ReturnType<typeof fixture>, overrides: Record<string, unknown> = {}) {
  const interaction = fx.boundedGroups.createInteraction({
    workspaceId: WS, conversationId: CONV, budget: BUDGET, createdAt: NOW,
  });
  return {
    workspaceId: WS, workspaceRoot: 'C:/tmp/ws_cgw', conversationId: CONV,
    interactionId: interaction.id, sourceMessageId: USER_MSG, createdAt: NOW,
    ...overrides,
  };
}

const COMPLETE: readonly SpeakerBehavior[] = AGENTS.map(agentId => ({
  deltas: ['see ', 'so '],
  result: makeResult('completed', agentId + ' 的意见'),
}));

test('CG-walk: the resolved plan executes strictly in order and records one reply per speaker', async () => {
  const fx = fixture(COMPLETE);
  try {
    const interaction = fx.boundedGroups.createInteraction({
      workspaceId: WS, conversationId: CONV, budget: BUDGET, createdAt: NOW,
    });
    const result = await fx.driver.run(
      {
        workspaceId: WS, workspaceRoot: 'C:/tmp/ws_cgw', conversationId: CONV,
        interactionId: interaction.id, sourceMessageId: USER_MSG, createdAt: NOW,
      },
      {
        runnerFactory: fx.runnerFactory as never,
        onSpeakerDelta: (agentId, _turnId, _messageId, delta) => fx.deltas.push({ agentId, delta }),
      },
    );

    assert.equal(result.endedBy, 'completed');
    assert.deepEqual(result.speakers.map(speaker => speaker.agentId), [...AGENTS]);
    assert.ok(result.speakers.every(speaker => speaker.status === 'final' && speaker.replyId !== null));
    assert.deepEqual(fx.deltas.map(entry => entry.agentId), [
      AGENTS[0], AGENTS[0], AGENTS[1], AGENTS[1], AGENTS[2], AGENTS[2],
    ]);
    assert.deepEqual(fx.walkLog, [
      { kind: 'start', callIndex: 0 }, { kind: 'end', callIndex: 0 },
      { kind: 'start', callIndex: 1 }, { kind: 'end', callIndex: 1 },
      { kind: 'start', callIndex: 2 }, { kind: 'end', callIndex: 2 },
    ]);

    const after = fx.boundedGroups.findInteraction(WS, interaction.id)!;
    assert.equal(after.status, 'active');
    assert.equal(after.replyCount, 3);
    assert.equal(after.hopCount, 2);
    const replies = fx.interactions.listReplies(interaction.id);
    assert.deepEqual(replies.map(reply => reply.agentId), [...AGENTS]);
    // CG-S8: one per-Agent context snapshot per recorded reply.
    assert.equal(fx.counts('cr_turn_context_snapshots'), 3);
    // The walk is chat-class: no Run-scoped fact or sequence was consumed.
    assert.equal(fx.counts('runtime_events'), 0);
    assert.equal(fx.counts('operations'), 0);
    assert.equal(fx.counts('outbox_messages'), 0);
    assert.equal(fx.counts('workspace_events'), 0);
  } finally {
    fx.close();
  }
});
test('CG-S5: a stop between speakers ends the walk before the next Provider call', async () => {
  const fx = fixture(COMPLETE);
  try {
    const interaction = fx.boundedGroups.createInteraction({
      workspaceId: WS, conversationId: CONV, budget: BUDGET, createdAt: NOW,
    });
    let stops = 0;
    const result = await fx.driver.run(
      {
        workspaceId: WS, workspaceRoot: 'C:/tmp/ws_cgw', conversationId: CONV,
        interactionId: interaction.id, sourceMessageId: USER_MSG, createdAt: NOW,
      },
      {
        runnerFactory: fx.runnerFactory as never,
        beforeSpeaker: (agentId) => {
          if (agentId === AGENTS[1] && stops === 0) {
            stops += 1;
            const current = fx.boundedGroups.findInteraction(WS, interaction.id)!;
            fx.boundedGroups.stopInteraction({
              workspaceId: WS, interactionId: interaction.id,
              expectedVersion: current.version, endedAt: NOW,
            });
          }
        },
      },
    );

    assert.equal(result.endedBy, 'user-stop');
    assert.deepEqual(result.speakers.map(speaker => speaker.agentId), [AGENTS[0]]);
    // The second speaker never got a Turn: only one Provider invocation.
    assert.deepEqual(fx.walkLog, [{ kind: 'start', callIndex: 0 }, { kind: 'end', callIndex: 0 }]);
    const after = fx.boundedGroups.findInteraction(WS, interaction.id)!;
    assert.equal(after.status, 'stopped');
    assert.equal(after.stopReason, 'user-stop');
    assert.equal(after.replyCount, 1);
    assert.equal(fx.counts('cr_turn_context_snapshots'), 1);
  } finally {
    fx.close();
  }
});

test('CG-S6: a repeated-content reply still trips the loop guard and ends the walk', async () => {
  const fx = fixture([
    { result: makeResult('completed', '同一段重复内容') },
    { result: makeResult('completed', '同一段重复内容') },
    { result: makeResult('completed', 'unused') },
  ]);
  try {
    const interaction = fx.boundedGroups.createInteraction({
      workspaceId: WS, conversationId: CONV, budget: BUDGET, createdAt: NOW,
    });
    const result = await fx.driver.run(
      {
        workspaceId: WS, workspaceRoot: 'C:/tmp/ws_cgw', conversationId: CONV,
        interactionId: interaction.id, sourceMessageId: USER_MSG, createdAt: NOW,
      },
      { runnerFactory: fx.runnerFactory as never },
    );

    assert.equal(result.endedBy, 'loop-guard');
    // Speaker A recorded; speaker B's Turn finalized but the loop guard refused
    // the reply, so it has no replyId and no budget was consumed for it.
    assert.deepEqual(
      result.speakers.map(speaker => [speaker.agentId, speaker.replyId !== null]),
      [[AGENTS[0], true], [AGENTS[1], false]],
    );
    const after = fx.boundedGroups.findInteraction(WS, interaction.id)!;
    assert.equal(after.status, 'exhausted');
    assert.equal(after.stopReason, 'loop-guard');
    assert.equal(after.loopGuardSignal, 'repeated-content');
    assert.equal(after.replyCount, 1);
  } finally {
    fx.close();
  }
});
test('CG-S7: a failed Provider Turn adds no reply and does not move the interaction', async () => {
  const fx = fixture([
    { result: makeResult('completed', 'agent_a 的意见') },
    { result: makeResult('failed', '') },
    { result: makeResult('completed', 'unused') },
  ]);
  try {
    const interaction = fx.boundedGroups.createInteraction({
      workspaceId: WS, conversationId: CONV, budget: BUDGET, createdAt: NOW,
    });
    const result = await fx.driver.run(
      {
        workspaceId: WS, workspaceRoot: 'C:/tmp/ws_cgw', conversationId: CONV,
        interactionId: interaction.id, sourceMessageId: USER_MSG, createdAt: NOW,
      },
      { runnerFactory: fx.runnerFactory as never },
    );

    assert.equal(result.endedBy, 'provider-failed');
    assert.deepEqual(
      result.speakers.map(speaker => [speaker.agentId, speaker.status]),
      [[AGENTS[0], 'final'], [AGENTS[1], 'failed']],
    );
    // Only the first reply was recorded; the failed Turn consumed no budget and
    // did not touch the interaction version beyond that one reply.
    const after = fx.boundedGroups.findInteraction(WS, interaction.id)!;
    assert.equal(after.replyCount, 1);
    assert.equal(after.version, 2);
    assert.equal(fx.counts('cr_turn_context_snapshots'), 1);
  } finally {
    fx.close();
  }
});

test('CG-S4 (driver): budget exhaustion ends the walk at the stable reason with no extra Provider call', async () => {
  const fx = fixture(COMPLETE);
  try {
    // One reply is already durable, and the cap leaves room for exactly one more.
    const conversations = new ConversationRepository(fx.db as unknown as TransactionDatabase);
    const interaction = fx.boundedGroups.createInteraction({
      workspaceId: WS, conversationId: CONV,
      // AGENT_LIMIT_EXCEEDS_TOTAL requires maxAgentsPerTurn <= maxTotalReplies.
      budget: { ...BUDGET, maxAgentsPerTurn: 2, maxTotalReplies: 2 },
      createdAt: NOW,
    });
    const first = conversations.appendMessage({
      id: createEntityId('message'), conversationId: CONV, workspaceId: WS,
      senderType: 'agent', senderAgentId: AGENTS[0], kind: 'text', status: 'final',
      content: '先答了', createdAt: NOW,
    });
    fx.boundedGroups.recordReply({
      workspaceId: WS, interactionId: interaction.id, agentId: AGENTS[0],
      messageId: first.id, content: '先答了', createdAt: NOW,
    });

    const result = await fx.driver.run(
      {
        workspaceId: WS, workspaceRoot: 'C:/tmp/ws_cgw', conversationId: CONV,
        interactionId: interaction.id, sourceMessageId: USER_MSG, createdAt: NOW,
      },
      { runnerFactory: fx.runnerFactory as never },
    );

    // The plan pre-check leaves only the returning Agent; the second and third
    // would exceed the total budget, so the Provider is called exactly once and
    // the walk ends at the same stable reason `recordReply` produced.
    assert.equal(result.endedBy, 'budget-total-replies');
    assert.deepEqual(result.plan.speakers.map(speaker => speaker.agentId), [AGENTS[0]]);
    assert.deepEqual(result.speakers.map(speaker => speaker.agentId), [AGENTS[0]]);
    assert.deepEqual(fx.walkLog, [{ kind: 'start', callIndex: 0 }, { kind: 'end', callIndex: 0 }]);
    const after = fx.boundedGroups.findInteraction(WS, interaction.id)!;
    assert.equal(after.status, 'exhausted');
    assert.equal(after.stopReason, 'budget-total-replies');
    assert.equal(after.replyCount, 2);
  } finally {
    fx.close();
  }
});
test('CG-walk input validation: wrong kind, unknown interaction, and a stopped interaction fail closed', async () => {
  const fx = fixture(COMPLETE);
  try {
    const conversations = new ConversationRepository(fx.db as unknown as TransactionDatabase);
    conversations.createConversation({ id: 'conv_direct', workspaceId: WS, kind: 'direct', title: 'D', createdAt: NOW });
    conversations.appendMessage({
      id: 'msg_direct', conversationId: 'conv_direct', workspaceId: WS,
      senderType: 'user', kind: 'text', status: 'final', content: 'hi', createdAt: NOW,
    });
    const interaction = fx.boundedGroups.createInteraction({
      workspaceId: WS, conversationId: CONV, budget: BUDGET, createdAt: NOW,
    });
    const base = {
      workspaceId: WS, workspaceRoot: 'C:/tmp/ws_cgw', conversationId: CONV,
      interactionId: interaction.id, sourceMessageId: USER_MSG, createdAt: NOW,
    };
    await assert.rejects(
      () => fx.driver.run({ ...base, conversationId: 'conv_direct', sourceMessageId: 'msg_direct' }, { runnerFactory: fx.runnerFactory as never }),
      (error: unknown) => error instanceof GroupTurnDriverError && error.code === 'GROUP_WALK_INPUT_INVALID',
    );
    await assert.rejects(
      () => fx.driver.run({ ...base, interactionId: 'interaction_missing' }, { runnerFactory: fx.runnerFactory as never }),
      (error: unknown) => error instanceof GroupTurnDriverError && error.code === 'GROUP_WALK_INPUT_INVALID',
    );
    await assert.rejects(
      () => fx.driver.run({ ...base, sourceMessageId: 'msg_missing' }, { runnerFactory: fx.runnerFactory as never }),
      (error: unknown) => error instanceof GroupTurnDriverError && error.code === 'GROUP_WALK_INPUT_INVALID',
    );

    const current = fx.boundedGroups.findInteraction(WS, interaction.id)!;
    fx.boundedGroups.stopInteraction({
      workspaceId: WS, interactionId: interaction.id, expectedVersion: current.version, endedAt: NOW,
    });
    await assert.rejects(
      () => fx.driver.run(base, { runnerFactory: fx.runnerFactory as never }),
      (error: unknown) => error instanceof GroupTurnDriverError && error.code === 'GROUP_WALK_NOT_ACTIVE' && error.stopReason === 'user-stop',
    );
    // No Provider call was made on any rejected path.
    assert.deepEqual(fx.walkLog, []);
  } finally {
    fx.close();
  }
});

test('CG-S2/S3 at the driver: manual and orchestrated orders drive the walk', async () => {
  const manual = fixture(COMPLETE, 'manual');
  try {
    const interaction = manual.boundedGroups.createInteraction({
      workspaceId: WS, conversationId: CONV, budget: BUDGET, createdAt: NOW,
    });
    const result = await manual.driver.run(
      {
        workspaceId: WS, workspaceRoot: 'C:/tmp/ws_cgw', conversationId: CONV,
        interactionId: interaction.id, sourceMessageId: USER_MSG, createdAt: NOW,
        namedAgentIds: [AGENTS[2], AGENTS[0]],
      },
      { runnerFactory: manual.runnerFactory as never },
    );
    assert.equal(result.endedBy, 'completed');
    assert.deepEqual(result.speakers.map(speaker => speaker.agentId), [AGENTS[2], AGENTS[0]]);
    assert.deepEqual(manual.interactions.listReplies(interaction.id).map(reply => reply.agentId), [AGENTS[2], AGENTS[0]]);
  } finally {
    manual.close();
  }

  const orchestrated = fixture(COMPLETE, 'orchestrated');
  try {
    const interaction = orchestrated.boundedGroups.createInteraction({
      workspaceId: WS, conversationId: CONV, budget: BUDGET, createdAt: NOW,
    });
    const result = await orchestrated.driver.run(
      {
        workspaceId: WS, workspaceRoot: 'C:/tmp/ws_cgw', conversationId: CONV,
        interactionId: interaction.id, sourceMessageId: USER_MSG, createdAt: NOW,
        orchestratedOrder: [AGENTS[1], AGENTS[2]],
      },
      { runnerFactory: orchestrated.runnerFactory as never },
    );
    assert.equal(result.endedBy, 'completed');
    assert.deepEqual(result.speakers.map(speaker => speaker.agentId), [AGENTS[1], AGENTS[2]]);
  } finally {
    orchestrated.close();
  }
});
