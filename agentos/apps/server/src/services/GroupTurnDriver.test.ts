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
import type { ConversationMessage, ConversationReplyMode } from '@agentos/shared';
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
import type { ConversationTurnContextOptions } from './ConversationTurnDriver.js';
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

function fixture(
  behaviors: readonly SpeakerBehavior[],
  replyMode: ConversationReplyMode = 'sequential',
  turnContext?: ConversationTurnContextOptions,
) {
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
  const createInteraction = boundedGroups.createInteraction.bind(boundedGroups);
  boundedGroups.createInteraction = input => createInteraction({
    ...input, sourceMessageId: input.sourceMessageId ?? USER_MSG,
  });

  let callIndex = 0;
  const walkLog: WalkLogEntry[] = [];
  const executionOrder: string[] = [];
  const providerInputs: Array<{ readonly executionId?: string; readonly memoryContext?: string }> = [];
  const providerHistories: Array<readonly ConversationMessage[]> = [];
  const deltas: Array<{ agentId: string; delta: string }> = [];
  const runnerFactory = (options: unknown) => {
    const runnerOptions = options as {
      executionId?: string;
      memoryContext?: string;
      history?: readonly ConversationMessage[];
      onEvent?: (event: { status: string; activity: string; content?: string }) => void;
    };
    const myIndex = callIndex;
    callIndex += 1;
    executionOrder.push('provider:' + String(myIndex));
    providerInputs.push({
      ...(runnerOptions.executionId === undefined ? {} : { executionId: runnerOptions.executionId }),
      ...(runnerOptions.memoryContext === undefined ? {} : { memoryContext: runnerOptions.memoryContext }),
    });
    providerHistories.push([...(runnerOptions.history ?? [])]);
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

  const resolvedTurnContext = turnContext === undefined ? undefined : {
    ...turnContext,
    snapshots: turnContext.snapshots ?? {
      insert: (input: Parameters<NonNullable<ConversationTurnContextOptions['snapshots']>['insert']>[0]) => {
        executionOrder.push('snapshot:' + input.agentId);
        return snapshots.insertWithinTransaction(input);
      },
    },
  };

  const driver = new GroupTurnDriver(
    boundedGroups, interactions, conversations, stream,
    (_workspaceId, agentId) => (AGENTS as readonly string[]).includes(agentId) ? ({} as never) : undefined,
    resolvedTurnContext,
  );

  const counts = (table: string) => Number((db.prepare('SELECT COUNT(*) AS n FROM ' + table).get() as { n: number | bigint }).n);
  return {
    db, root, boundedGroups, interactions, driver, walkLog, deltas, counts, runnerFactory,
    executionOrder, providerInputs, providerHistories,
    close: () => { try { db.close(); } finally { rmSync(root, { recursive: true, force: true }); } },
  };
}

function siblingDriver(db: SqliteDb) {
  db.exec('PRAGMA foreign_keys = ON');
  const tx = db as unknown as TransactionDatabase;
  const conversations = new ConversationRepository(tx);
  const turns = new AgentTurnRepository(tx);
  const interactions = new GroupInteractionRepository(tx);
  const snapshots = new TurnContextSnapshotRepository(tx);
  const stream = new ConversationStreamService(tx, conversations, turns);
  const boundedGroups = new BoundedGroupService(tx, interactions, snapshots);
  const driver = new GroupTurnDriver(
    boundedGroups, interactions, conversations, stream,
    (_workspaceId, agentId) => (AGENTS as readonly string[]).includes(agentId) ? ({} as never) : undefined,
  );
  return { driver };
}
function walkInput(fx: ReturnType<typeof fixture>, overrides: Record<string, unknown> = {}) {
  const interaction = fx.boundedGroups.createInteraction({
    workspaceId: WS, conversationId: CONV, budget: BUDGET, sourceMessageId: USER_MSG, createdAt: NOW,
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
    // The real GroupTurnDriver -> ConversationTurnDriver path must pass each
    // earlier Agent reply with its durable sender identity to the next Provider.
    assert.deepEqual(
      fx.providerHistories.map(history => history.map(message => ({
        senderType: message.senderType,
        senderAgentId: message.senderAgentId,
        content: message.content,
      }))),
      [
        [],
        [{ senderType: 'agent', senderAgentId: AGENTS[0], content: 'agent_a 的意见' }],
        [
          { senderType: 'agent', senderAgentId: AGENTS[0], content: 'agent_a 的意见' },
          { senderType: 'agent', senderAgentId: AGENTS[1], content: 'agent_b 的意见' },
        ],
      ],
    );

    const after = fx.boundedGroups.findInteraction(WS, interaction.id)!;
    assert.equal(after.status, 'completed');
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

test('LITE-09-013/101 Group Provider receives each Agent frozen context and the reply cites that snapshot', async () => {
  const fx = fixture(COMPLETE, 'manual', {
    contextTokenBudget: 64,
    selection: {
      select: ({ agentId }) => ({
        selectedEntryIds: ['entry_' + agentId],
        totalTokens: 4,
        truncated: false,
        retrievalStrategyVersion: 'chat-memory.v1',
        contextText: 'frozen context for ' + agentId,
      }),
    },
  });
  try {
    const interaction = fx.boundedGroups.createInteraction({
      workspaceId: WS, conversationId: CONV, budget: BUDGET, createdAt: NOW,
    });
    const result = await fx.driver.run(
      {
        workspaceId: WS, workspaceRoot: 'C:/tmp/ws_cgw', conversationId: CONV,
        interactionId: interaction.id, sourceMessageId: USER_MSG, createdAt: NOW,
        namedAgentIds: [AGENTS[0], AGENTS[1]],
      },
      { runnerFactory: fx.runnerFactory as never },
    );

    assert.equal(result.endedBy, 'completed');
    assert.deepEqual(fx.providerInputs.map(input => input.memoryContext), [
      'frozen context for agent_a', 'frozen context for agent_b',
    ]);
    // The durable snapshot is created before each runner is constructed.
    assert.equal(fx.executionOrder[0], 'snapshot:agent_a');
    assert.match(fx.executionOrder[1]!, /^provider:/);
    assert.equal(fx.executionOrder[2], 'snapshot:agent_b');
    assert.match(fx.executionOrder[3]!, /^provider:/);

    const snapshots = new TurnContextSnapshotRepository(fx.db as unknown as TransactionDatabase);
    const replies = fx.interactions.listReplies(interaction.id);
    assert.deepEqual(replies.map(reply => reply.agentId), [AGENTS[0], AGENTS[1]]);
    for (const reply of replies) {
      assert.ok(reply.contextSnapshotId, 'a recorded Group reply must cite its used snapshot');
      const snapshot = snapshots.findById(WS, reply.contextSnapshotId!);
      assert.ok(snapshot);
      assert.equal(snapshot.interactionId, interaction.id);
      assert.equal(snapshot.turnId, reply.turnId);
      assert.equal(snapshot.agentId, reply.agentId);
      assert.deepEqual(JSON.parse(snapshot.selectedEntryIdsJson), ['entry_' + reply.agentId]);
    }
    assert.equal(fx.counts('cr_turn_context_snapshots'), 2, 'the interaction reuses the two Provider snapshots');
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

test('F09: budget=1 finalizes exactly one Message, Turn, reply, budget unit, and versioned owner event', async () => {
  const fx = fixture(COMPLETE);
  try {
    const interaction = fx.boundedGroups.createInteraction({
      workspaceId: WS, conversationId: CONV,
      budget: { ...BUDGET, maxAgentsPerTurn: 1, maxRepliesPerAgent: 1, maxTotalReplies: 1 },
      createdAt: NOW,
    });

    const result = await fx.driver.run(
      {
        workspaceId: WS, workspaceRoot: 'C:/tmp/ws_cgw', conversationId: CONV,
        interactionId: interaction.id, sourceMessageId: USER_MSG, createdAt: NOW,
      },
      { runnerFactory: fx.runnerFactory as never },
    );

    // The only allowed reply consumes the sole budget unit; the interaction is
    // exhausted only after that final Message, Turn, ledger row and counter commit.
    assert.equal(result.endedBy, 'budget-total-replies');
    assert.deepEqual(result.plan.speakers.map(speaker => speaker.agentId), [AGENTS[0]]);
    assert.deepEqual(result.speakers.map(speaker => speaker.agentId), [AGENTS[0]]);
    assert.deepEqual(fx.walkLog, [{ kind: 'start', callIndex: 0 }, { kind: 'end', callIndex: 0 }]);
    const after = fx.boundedGroups.findInteraction(WS, interaction.id)!;
    assert.equal(after.status, 'exhausted');
    assert.equal(after.stopReason, 'budget-total-replies');
    assert.equal(after.replyCount, 1);
    assert.equal(fx.boundedGroups.budgetStatus(after).repliesUsed, 1);
    assert.equal(fx.counts('cr_group_interaction_replies'), 1);
    assert.equal(fx.counts('cr_messages'), 2, 'one source plus one final provider message');
    assert.equal(fx.counts('cr_agent_turns'), 1);
    const reply = fx.interactions.listReplies(interaction.id)[0]!;
    const message = new ConversationRepository(fx.db as unknown as TransactionDatabase).findMessageById(WS, reply.messageId)!;
    const turn = new AgentTurnRepository(fx.db as unknown as TransactionDatabase).findTurnById(WS, reply.turnId!)!;
    assert.equal(message.status, 'final');
    assert.equal(message.replyToMessageId, USER_MSG);
    assert.equal(turn.status, 'final');
    assert.equal(turn.sourceMessageId, message.id);
    const owner = fx.boundedGroups.findExecutionOwner(WS, interaction.id)!;
    assert.equal(owner.status, 'completed');
    const finalEvent = fx.boundedGroups.listExecutionEvents(WS, CONV, interaction.id, owner.eventCursor - 1)[0]!;
    assert.equal(finalEvent.payload.interactionId, interaction.id);
    assert.equal(finalEvent.payload.status, after.status);
    assert.equal(finalEvent.payload.version, after.version);
    assert.equal(finalEvent.payload.ownerEpoch, owner.ownerEpoch);
    assert.equal(finalEvent.cursor, owner.eventCursor);
  } finally {
    fx.close();
  }
});

test('server stop aborts the owner signal but commits a Provider final that wins the finalization race once', async () => {
  const fx = fixture(COMPLETE);
  let releaseProvider!: () => void;
  let markProviderStarted!: () => void;
  const gate = new Promise<void>(resolve => { releaseProvider = resolve; });
  const started = new Promise<void>(resolve => { markProviderStarted = resolve; });
  try {
    const interaction = fx.boundedGroups.createInteraction({
      workspaceId: WS, conversationId: CONV, budget: { ...BUDGET, maxTotalReplies: 1, maxAgentsPerTurn: 1 }, createdAt: NOW,
    });
    let providerSignal: AbortSignal | undefined;
    const runnerFactory = ((options: { signal?: AbortSignal }) => {
      providerSignal = options.signal;
      return { run: async () => { markProviderStarted(); await gate; return makeResult('completed', 'final raced with stop'); } };
    }) as never;
    const running = fx.driver.run({
      workspaceId: WS, workspaceRoot: 'C:/tmp/ws_cgw', conversationId: CONV,
      interactionId: interaction.id, sourceMessageId: USER_MSG, createdAt: NOW,
    }, { runnerFactory });
    await started;
    const current = fx.boundedGroups.findInteraction(WS, interaction.id)!;
    const stopped = fx.boundedGroups.stopInteraction({
      workspaceId: WS, interactionId: interaction.id, expectedVersion: current.version, endedAt: NOW2,
    });
    assert.equal(stopped.status, 'stopped');
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('owner cancellation signal was not delivered')), 1500);
      providerSignal?.addEventListener('abort', () => { clearTimeout(timeout); resolve(); }, { once: true });
    });
    assert.equal(providerSignal?.aborted, true);
    releaseProvider();
    const result = await running;
    assert.equal(result.endedBy, 'user-stop');
    assert.equal(result.speakers[0]?.status, 'final', JSON.stringify({
      speaker: result.speakers[0],
      owner: fx.boundedGroups.findExecutionOwner(WS, interaction.id),
      events: fx.boundedGroups.listExecutionEvents(WS, CONV, interaction.id, 0),
    }));
    assert.equal(fx.interactions.listReplies(interaction.id).length, 1);
    assert.equal(fx.boundedGroups.findInteraction(WS, interaction.id)?.replyCount, 1);
    assert.equal(fx.counts('cr_group_interaction_replies'), 1);
    assert.equal(fx.counts('cr_messages'), 2);
    assert.equal(fx.counts('cr_agent_turns'), 1);
  } finally {
    releaseProvider();
    fx.close();
  }
});
test('startup reconciliation marks an unknown owner interrupted and prevents Provider replay', async () => {
  const fx = fixture(COMPLETE);
  try {
    const interaction = fx.boundedGroups.createInteraction({
      workspaceId: WS, conversationId: CONV, budget: BUDGET, createdAt: NOW,
    });
    const owner = fx.boundedGroups.claimExecution({
      workspaceId: WS, conversationId: CONV, interactionId: interaction.id,
      sourceMessageId: USER_MSG, participantAgentIds: [AGENTS[0]], ownerId: createEntityId('event'), createdAt: NOW,
    });
    // This is the no-argument hook SqliteStore runs after migrations/recovery.
    assert.equal(fx.interactions.reconcileInterruptedOnStartup(), 1);
    assert.equal(fx.interactions.reconcileInterruptedOnStartup(), 0);
    const reconciled = fx.boundedGroups.findInteraction(WS, interaction.id)!;
    const reconciledOwner = fx.boundedGroups.findExecutionOwner(WS, interaction.id)!;
    assert.equal(reconciled.integrityStatus, 'unusable');
    assert.equal(reconciled.version, interaction.version + 1);
    assert.equal(reconciledOwner.ownerId, owner.ownerId);
    assert.equal(reconciledOwner.ownerEpoch, owner.ownerEpoch);
    assert.equal(reconciledOwner.status, 'interrupted');
    const event = fx.boundedGroups.listExecutionEvents(WS, CONV, interaction.id, owner.eventCursor).at(-1)!;
    assert.equal(event.eventType, 'group.interrupted');
    assert.equal(event.payload.version, reconciled.version);
    assert.equal(event.payload.ownerEpoch, owner.ownerEpoch);

    let providerCalls = 0;
    await assert.rejects(fx.driver.run({
      workspaceId: WS, workspaceRoot: 'C:/tmp/ws_cgw', conversationId: CONV,
      interactionId: interaction.id, sourceMessageId: USER_MSG, createdAt: NOW,
    }, { runnerFactory: (() => { providerCalls += 1; return { run: async () => makeResult('completed', 'must not replay') }; }) as never }),
    (error: unknown) => error instanceof GroupTurnDriverError && error.code === 'GROUP_WALK_NOT_ACTIVE');
    assert.equal(providerCalls, 0);
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

test('F20: respond rejects a same-conversation message different from the frozen source before Provider work', async () => {
  const fx = fixture(COMPLETE);
  try {
    const input = walkInput(fx);
    const otherSourceId = 'msg_' + 'e'.repeat(26);
    fx.db.prepare(
      `INSERT INTO cr_messages (
        id, conversation_id, workspace_id, sequence, sender_type, sender_agent_id, kind,
        status, content, version, created_at, updated_at
      ) VALUES (?, ?, ?, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM cr_messages WHERE conversation_id = ?),
        'user', NULL, 'text', 'final', 'another source', 1, ?, ?)`,
    ).run(otherSourceId, CONV, WS, CONV, NOW, NOW);
    let providerCalls = 0;
    await assert.rejects(fx.driver.run(
      { ...input, sourceMessageId: otherSourceId },
      { runnerFactory: (() => { providerCalls += 1; return { run: async () => makeResult('completed', 'unexpected') }; }) as never },
    ), /GROUP_WALK_SOURCE_MISMATCH/);
    assert.equal(providerCalls, 0);
  } finally { fx.close(); }
});

test('F10: 2 and 10 concurrent walks across two SQLite connections claim one Provider owner in three fresh fixtures', async () => {
  for (const concurrency of [2, 10]) {
    for (let fresh = 0; fresh < 3; fresh += 1) {
      const fx = fixture(COMPLETE);
      const peerDb = new DatabaseSync(join(fx.root, 'agentos.sqlite'));
      let releaseProvider!: () => void;
      const providerGate = new Promise<void>(resolve => { releaseProvider = resolve; });
      let providerStarted!: () => void;
      const started = new Promise<void>(resolve => { providerStarted = resolve; });
      let providerCalls = 0;
      try {
        const peer = siblingDriver(peerDb);
        const interaction = fx.boundedGroups.createInteraction({
          workspaceId: WS, conversationId: CONV, sourceMessageId: USER_MSG,
          budget: { ...BUDGET, maxAgentsPerTurn: 1, maxRepliesPerAgent: 1, maxTotalReplies: 1 },
          createdAt: NOW,
        });
        const input = {
          workspaceId: WS, workspaceRoot: 'C:/tmp/ws_cgw', conversationId: CONV,
          interactionId: interaction.id, sourceMessageId: USER_MSG, createdAt: NOW,
        };
        const runnerFactory = (() => ({
          run: async () => {
            providerCalls += 1;
            providerStarted();
            await providerGate;
            return makeResult('completed', 'one reply');
          },
        })) as never;
        const requests = Array.from({ length: concurrency }, (_, index) =>
          (index % 2 === 0 ? fx.driver : peer.driver).run(input, { runnerFactory }));
        await started;
        releaseProvider();
        const settled = await Promise.allSettled(requests);
        assert.equal(providerCalls, 1, `${concurrency} competing requests, fixture ${fresh + 1}`);
        assert.equal(settled.filter(result => result.status === 'fulfilled').length, 1);
        assert.equal(fx.counts('cr_group_interaction_replies'), 1);
        assert.equal(fx.counts('cr_messages'), 2, 'one user source plus one final reply and no duplicate Provider messages');
        assert.equal(fx.boundedGroups.findInteraction(WS, interaction.id)!.replyCount, 1);
      } finally {
        releaseProvider();
        peerDb.close();
        fx.close();
      }
    }
  }
});

for (let repetition = 1; repetition <= 3; repetition += 1) {
  test(`F27: an empty participant claim remains invalid without the internal finalization flag (${repetition}/3)`, () => {
    const fx = fixture(COMPLETE, 'manual');
    try {
      const input = walkInput(fx);
      assert.throws(() => fx.boundedGroups.claimExecution({
        workspaceId: WS, conversationId: CONV, interactionId: input.interactionId,
        sourceMessageId: USER_MSG, participantAgentIds: [], ownerId: createEntityId('event'), createdAt: NOW,
      }), /GROUP_INPUT_INVALID/);
      assert.equal(fx.boundedGroups.findExecutionOwner(WS, input.interactionId), undefined);
      assert.equal(fx.boundedGroups.findInteraction(WS, input.interactionId)!.status, 'active');
      assert.equal(fx.boundedGroups.listExecutionEvents(WS, CONV, input.interactionId, 0).length, 0);
    } finally { fx.close(); }
  });

  test(`F27: empty plans serialize 2 and 10 competitors across independent SQLite connections (${repetition}/3)`, async () => {
    for (const concurrency of [2, 10]) {
      const fx = fixture(COMPLETE, 'manual');
      const peerDb = new DatabaseSync(join(fx.root, 'agentos.sqlite'));
      try {
        const peer = siblingDriver(peerDb);
        const input = walkInput(fx);
        let providerCalls = 0;
        const runnerFactory = (() => { providerCalls += 1; throw new Error('empty plan must not construct a Provider runner'); }) as never;
        let competitors: PromiseSettledResult<unknown>[] = [];
        let competing: Promise<PromiseSettledResult<unknown>[]> | undefined;
        const result = await fx.driver.run(input, {
          runnerFactory,
          onPlan: plan => {
            assert.equal(plan.speakers.length, 0);
            competing = Promise.allSettled(Array.from({ length: concurrency - 1 }, (_, index) =>
              (index % 2 === 0 ? peer.driver : fx.driver).run(input, { runnerFactory })));
          },
        });
        assert.ok(competing);
        competitors = await competing;
        assert.equal(competitors.length, concurrency - 1);
        assert.ok(competitors.every(entry => entry.status === 'rejected'
          && /GROUP_EXECUTION_ALREADY_OWNED/.test(String(entry.reason))));
        assert.equal(result.endedBy, 'no-speakers');
        assert.equal(result.interaction!.status, 'completed');
        assert.equal(result.interaction!.replyCount, 0);
        assert.equal(providerCalls, 0);
        const owner = fx.boundedGroups.findExecutionOwner(WS, input.interactionId)!;
        assert.equal(owner.status, 'completed');
        assert.equal(owner.terminalReason, 'no-speakers');
        assert.deepEqual(owner.participantAgentIds, []);
        const events = fx.boundedGroups.listExecutionEvents(WS, CONV, input.interactionId, 0);
        assert.deepEqual(events.map(event => event.eventType), ['group.claimed', 'group.plan', 'group.done']);
        assert.equal(fx.counts('cr_messages'), 1);
        assert.equal(fx.interactions.listReplies(input.interactionId).length, 0);
        await assert.rejects(() => peer.driver.run(input, { runnerFactory }), /GROUP_WALK_NOT_ACTIVE/);
        assert.equal(fx.boundedGroups.listExecutionEvents(WS, CONV, input.interactionId, 0).length, 3);
        assert.equal(providerCalls, 0);
      } finally { peerDb.close(); fx.close(); }
    }
  });

  test(`F27: a user stop during empty-plan publication retains its reason and zero Provider calls (${repetition}/3)`, async () => {
    const fx = fixture(COMPLETE, 'manual');
    try {
      const input = walkInput(fx);
      let providerCalls = 0;
      const result = await fx.driver.run(input, {
        runnerFactory: (() => { providerCalls += 1; throw new Error('empty stopped plan must not start a Provider'); }) as never,
        onPlan: () => {
          const current = fx.boundedGroups.findInteraction(WS, input.interactionId)!;
          fx.boundedGroups.stopInteraction({ workspaceId: WS, interactionId: input.interactionId,
            expectedVersion: current.version, endedAt: LATER });
        },
      });
      assert.equal(result.endedBy, 'user-stop');
      assert.equal(result.interaction!.status, 'stopped');
      assert.equal(result.interaction!.stopReason, 'user-stop');
      const owner = fx.boundedGroups.findExecutionOwner(WS, input.interactionId)!;
      assert.equal(owner.status, 'completed');
      assert.equal(owner.terminalReason, 'user-stop');
      const events = fx.boundedGroups.listExecutionEvents(WS, CONV, input.interactionId, 0);
      assert.equal((events.at(-1)!.payload as { reason: string }).reason, 'user-stop');
      assert.equal(fx.counts('cr_messages'), 1);
      assert.equal(fx.interactions.listReplies(input.interactionId).length, 0);
      assert.equal(providerCalls, 0);
    } finally { fx.close(); }
  });
}

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
