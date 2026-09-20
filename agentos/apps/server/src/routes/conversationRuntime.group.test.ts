import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { SqliteStore } from '../store/SqliteStore.js';
import { MemoryEntryRepository } from '../store/MemoryEntryRepository.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { createConversationRuntimeRoutes } from './conversationRuntime.js';
import type { ModelDiscoveryService } from '../services/CliModelDiscovery.js';

function createProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentos-group-route-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({
    workspaces: [{
      id: 'workspace-a', name: 'Workspace A', rootPath: root, gitEnabled: true, memoryEnabled: true,
      agents: [
        { id: 'codex', name: 'Codex', role: 'codex', enabled: true, cliCommand: 'codex', cliArgs: [] },
        { id: 'kimi', name: 'KimiCode', role: 'kimi', enabled: true, cliCommand: 'kimi', cliArgs: ['-p'] },
      ],
      lastOpenedAt: '2026-07-12T00:00:00.000Z', createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z',
    }],
  }), 'utf-8');
  return root;
}

async function withServer(
  run: (baseUrl: string, store: SqliteStore) => Promise<void>,
  modelDiscovery?: ModelDiscoveryService,
): Promise<void> {
  const root = createProjectRoot();
  const store = new SqliteStore(root);
  const app = express();
  const server = app.listen(0);
  try {
    app.use(express.json());
    app.use('/api/workspaces/:workspaceId/runtime', createConversationRuntimeRoutes(store, new WorkspaceManager(store), modelDiscovery));
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}/api/workspaces/workspace-a/runtime`, store);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

async function postJson(url: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const response = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

async function seedConversation(baseUrl: string): Promise<{ conversationId: string; messageId: string }> {
  const created = await postJson(`${baseUrl}/conversations`, { kind: 'group', replyMode: 'sequential', memberAgentIds: ['codex', 'kimi'] });
  assert.equal(created.status, 201);
  const conversation = (created.json as { conversation: { id: string } }).conversation;
  const sent = await postJson(`${baseUrl}/conversations/${conversation.id}/messages`, { content: 'hello' });
  const message = (sent.json as { message: { id: string } }).message;
  return { conversationId: conversation.id, messageId: message.id };
}

test('bounded group interaction: create, reply, budget status, stop', async () => {
  await withServer(async (baseUrl, store) => {
    const { conversationId, messageId } = await seedConversation(baseUrl);
    const created = await postJson(`${baseUrl}/conversations/${conversationId}/interactions`, {
      budget: { maxAgentsPerTurn: 2, maxRepliesPerAgent: 2, maxTotalReplies: 3, maxAgentHops: 2 },
    });
    assert.equal(created.status, 201);
    const interaction = (created.json as { interaction: { id: string; status: string } }).interaction;
    assert.equal(interaction.status, 'active');

    const reply = await postJson(`${baseUrl}/interactions/${interaction.id}/replies`, { agentId: 'codex', messageId, content: 'reply one' });
    assert.equal(reply.status, 201);

    const read = await fetch(`${baseUrl}/interactions/${interaction.id}`).then(r => r.json()) as {
      budget: { repliesUsed: number; repliesRemaining: number; distinctAgents: number };
      replies: unknown[];
    };
    assert.equal(read.budget.repliesUsed, 1);
    assert.equal(read.budget.repliesRemaining, 2);
    assert.equal(read.replies.length, 1);

    const current = store.boundedGroupService().findInteraction('workspace-a', interaction.id);
    const stopped = await postJson(`${baseUrl}/interactions/${interaction.id}/stop`, { expectedVersion: current!.version });
    assert.equal(stopped.status, 200);
    assert.equal((stopped.json as { interaction: { status: string } }).interaction.status, 'stopped');

    const afterStop = await postJson(`${baseUrl}/interactions/${interaction.id}/replies`, { agentId: 'kimi', messageId, content: 'late' });
    assert.equal(afterStop.status, 409);
    assert.equal((afterStop.json as { error: string }).error, 'GROUP_INTERACTION_TERMINATED');
  });
});

test('budget exhaustion and loop guard return the stable reason via HTTP', async () => {
  await withServer(async (baseUrl) => {
    const { conversationId, messageId } = await seedConversation(baseUrl);
    const created = await postJson(`${baseUrl}/conversations/${conversationId}/interactions`, {
      budget: { maxAgentsPerTurn: 1, maxRepliesPerAgent: 1, maxTotalReplies: 1, maxAgentHops: 2 },
    });
    const interaction = (created.json as { interaction: { id: string } }).interaction;
    await postJson(`${baseUrl}/interactions/${interaction.id}/replies`, { agentId: 'codex', messageId, content: 'only one' });
    const exceeded = await postJson(`${baseUrl}/interactions/${interaction.id}/replies`, { agentId: 'kimi', messageId, content: 'over the cap' });
    assert.equal(exceeded.status, 409);
    assert.equal((exceeded.json as { error: string }).error, 'GROUP_INTERACTION_TERMINATED');
  });
});

test('create interaction fails closed for an invalid budget or missing conversation', async () => {
  await withServer(async (baseUrl) => {
    const { conversationId } = await seedConversation(baseUrl);
    const bad = await postJson(`${baseUrl}/conversations/${conversationId}/interactions`, {
      budget: { maxAgentsPerTurn: 0, maxRepliesPerAgent: 2, maxTotalReplies: 3, maxAgentHops: 2 },
    });
    assert.equal(bad.status, 400);
    const noConv = await postJson(`${baseUrl}/conversations/conv_missing/interactions`, {
      budget: { maxAgentsPerTurn: 2, maxRepliesPerAgent: 2, maxTotalReplies: 3, maxAgentHops: 2 },
    });
    assert.equal(noConv.status, 404);
  });
});
test('bounded group respond: the runtime selects speakers, streams the walk, and records replies', async () => {
  process.env.AGENTOS_FORCE_MOCK = 'true';
  try {
    await withServer(async (baseUrl, store) => {
      const { conversationId, messageId } = await seedConversation(baseUrl);
      const created = await postJson(`${baseUrl}/conversations/${conversationId}/interactions`, {
        budget: { maxAgentsPerTurn: 4, maxRepliesPerAgent: 2, maxTotalReplies: 6, maxAgentHops: 4 },
      });
      assert.equal(created.status, 201);
      const interaction = (created.json as { interaction: { id: string } }).interaction;

      const response = await fetch(
        `${baseUrl}/conversations/${conversationId}/interactions/${interaction.id}/respond`,
        {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sourceMessageId: messageId }),
        },
      );
      assert.equal(response.status, 200);
      assert.ok((response.headers.get('content-type') ?? '').includes('text/event-stream'));
      const text = await response.text();

      // The plan is announced before any Turn starts; the walk finishes with group.done.
      assert.ok(text.indexOf('event: group.plan') < text.indexOf('event: group.turn.start'));
      assert.ok(text.indexOf('event: group.done') > text.lastIndexOf('event: group.turn.'));
      assert.ok(text.includes('"endedBy":"completed"'));
      // Both members spoke, in membership order (codex joined before kimi).
      assert.equal((text.match(/event: group.turn.start/g) ?? []).length, 2);
      assert.equal((text.match(/event: group.turn.final/g) ?? []).length, 2);
      assert.ok(text.indexOf('"agentId":"codex"') < text.indexOf('"agentId":"kimi"'));
      assert.ok(text.includes('event: checkpoint'));

      const read = await fetch(`${baseUrl}/interactions/${interaction.id}`).then(r => r.json()) as {
        interaction: { replyCount: number; status: string };
        replies: Array<{ agentId: string }>;
      };
      assert.equal(read.interaction.replyCount, 2);
      assert.deepEqual(read.replies.map(reply => reply.agentId), ['codex', 'kimi']);

      const db = store.getDatabase();
      // The interaction reply must reuse the exact LITE-09-101 snapshot that
      // was frozen before the Provider call. There is one durable row per
      // speaker Turn; a second, after-the-fact CR-5 selection would make the
      // reply evidence diverge from the context the Provider actually used.
      const rows = db.prepare('SELECT turn_id, interaction_id, budget_json FROM cr_turn_context_snapshots').all() as Array<{
        turn_id: string | null; interaction_id: string | null; budget_json: string;
      }>;
      assert.equal(rows.length, 2);
      const byTurn = new Map<string, typeof rows>();
      for (const row of rows) {
        assert.ok(row.turn_id);
        byTurn.set(row.turn_id!, [...(byTurn.get(row.turn_id!) ?? []), row]);
      }
      assert.equal(byTurn.size, 2);
      for (const turnRows of byTurn.values()) {
        assert.equal(turnRows.length, 1, 'each recorded reply reuses exactly one Provider context snapshot');
        assert.equal(turnRows[0]!.interaction_id, interaction.id);
        const budget = JSON.parse(turnRows[0]!.budget_json) as {
          maxFrozenHistoryMessages: number; frozenHistoryMessageIds: string[];
        };
        assert.ok(budget.maxFrozenHistoryMessages > 0);
        assert.ok(Array.isArray(budget.frozenHistoryMessageIds));
      }
      const wsEvents = db.prepare('SELECT COUNT(*) AS n FROM workspace_events').get() as { n: number | bigint };
      assert.equal(Number(wsEvents.n), 0);
    });
  } finally {
    delete process.env.AGENTOS_FORCE_MOCK;
  }
});

test('bounded group respond: validation and lifecycle failures fail closed', async () => {
  await withServer(async (baseUrl) => {
    const { conversationId, messageId } = await seedConversation(baseUrl);
    const created = await postJson(`${baseUrl}/conversations/${conversationId}/interactions`, {
      budget: { maxAgentsPerTurn: 2, maxRepliesPerAgent: 2, maxTotalReplies: 3, maxAgentHops: 2 },
    });
    const interaction = (created.json as { interaction: { id: string; version: number } }).interaction;
    const respond = `${baseUrl}/conversations/${conversationId}/interactions/${interaction.id}/respond`;

    const missingMessage = await postJson(respond, {});
    assert.equal(missingMessage.status, 400);
    const badMessage = await postJson(respond, { sourceMessageId: 'msg_missing' });
    assert.equal(badMessage.status, 400);
    const badList = await postJson(respond, { sourceMessageId: messageId, orchestratedOrder: 'codex' });
    assert.equal(badList.status, 400);

    const stopped = await postJson(`${baseUrl}/interactions/${interaction.id}/stop`, { expectedVersion: interaction.version });
    assert.equal(stopped.status, 200);
    const inactive = await postJson(respond, { sourceMessageId: messageId });
    assert.equal(inactive.status, 409);

    const missingInteraction = await postJson(
      `${baseUrl}/conversations/${conversationId}/interactions/interaction_missing/respond`,
      { sourceMessageId: messageId },
    );
    assert.equal(missingInteraction.status, 404);

    // A direct Conversation can never host a bounded walk.
    const direct = await postJson(`${baseUrl}/conversations`, { kind: 'direct', agentId: 'codex' });
    const directConversation = (direct.json as { conversation: { id: string } }).conversation;
    const directMessage = await postJson(`${baseUrl}/conversations/${directConversation.id}/messages`, { content: 'hi' });
    const directMessageId = (directMessage.json as { message: { id: string } }).message.id;
    const onDirect = await postJson(
      `${baseUrl}/conversations/${directConversation.id}/interactions/${interaction.id}/respond`,
      { sourceMessageId: directMessageId },
    );
    assert.equal(onDirect.status, 400);
  });
});

// LITE-09-013: per-Agent contexts remain isolated. Each speaker Turn freezes its OWN
// selection, so an `agent`-scoped Memory Entry reaches only the Agent that owns it. The
// existing walk test asserts one frozen snapshot per speaker; this asserts they are
// actually different contexts rather than the same one recorded twice.
test('LITE-09-013 each group speaker freezes only its own Agent-scoped Memory', async () => {
  process.env.AGENTOS_FORCE_MOCK = 'true';
  try {
    await withServer(async (baseUrl, store) => {
      const entries = new MemoryEntryRepository(store.getDatabase() as never);
      const codexOnly = 'mem_' + 'a'.repeat(26);
      const kimiOnly = 'mem_' + 'b'.repeat(26);
      const shared = 'mem_' + 'c'.repeat(26);
      const base = {
        workspaceId: 'workspace-a', authority: 'system-verified' as const, confidence: 0.9, importance: 0.7,
        tags: [], status: 'active' as const, sources: [{ kind: 'task' as const, id: 'task_origin' }],
        createdAt: '2026-07-12T00:00:00.000Z',
      };
      entries.createEntry({ ...base, id: codexOnly, scope: 'agent', ownerAgentId: 'codex', category: 'preference',
        title: 'codex only', summary: 'codex private', content: 'codex private preference' } as never);
      entries.createEntry({ ...base, id: kimiOnly, scope: 'agent', ownerAgentId: 'kimi', category: 'preference',
        title: 'kimi only', summary: 'kimi private', content: 'kimi private preference' } as never);
      entries.createEntry({ ...base, id: shared, scope: 'workspace', category: 'constraint',
        title: 'shared', summary: 'shared constraint', content: 'shared workspace constraint' } as never);

      const { conversationId, messageId } = await seedConversation(baseUrl);
      const created = await postJson(`${baseUrl}/conversations/${conversationId}/interactions`, {
        budget: { maxAgentsPerTurn: 4, maxRepliesPerAgent: 2, maxTotalReplies: 6, maxAgentHops: 4 },
      });
      assert.equal(created.status, 201);
      const interaction = (created.json as { interaction: { id: string } }).interaction;
      const response = await fetch(
        `${baseUrl}/conversations/${conversationId}/interactions/${interaction.id}/respond`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceMessageId: messageId }) },
      );
      assert.equal(response.status, 200);
      await response.text();

      const frozen = store.getDatabase().prepare(
        "SELECT agent_id AS agentId, selected_entry_ids_json AS ids FROM cr_turn_context_snapshots WHERE conversation_id = ? AND interaction_id = ? ORDER BY agent_id",
      ).all(conversationId, interaction.id) as Array<{ agentId: string; ids: string }>;
      assert.equal(frozen.length, 2, 'each speaker Turn froze exactly one bounded context');
      const byAgent = new Map(frozen.map(row => [row.agentId, JSON.parse(row.ids) as string[]]));
      assert.deepEqual([...byAgent.keys()].sort(), ['codex', 'kimi']);

      // The isolation itself: an Agent-scoped Entry reaches only its owner.
      assert.ok(byAgent.get('codex')!.includes(codexOnly), 'codex must receive its own Agent-scoped Entry');
      assert.ok(!byAgent.get('codex')!.includes(kimiOnly), 'codex must NOT receive kimi\'s private Entry');
      assert.ok(byAgent.get('kimi')!.includes(kimiOnly), 'kimi must receive its own Agent-scoped Entry');
      assert.ok(!byAgent.get('kimi')!.includes(codexOnly), 'kimi must NOT receive codex\'s private Entry');
      // Both still reach the Workspace-scoped Entry, so the isolation is about owner, not reach.
      assert.ok(byAgent.get('codex')!.includes(shared));
      assert.ok(byAgent.get('kimi')!.includes(shared));
      // And the two frozen selections are genuinely different records.
      assert.notDeepEqual(byAgent.get('codex'), byAgent.get('kimi'));
    });
  } finally {
    delete process.env.AGENTOS_FORCE_MOCK;
  }
});

test('LITE-GROUP-032 runtime group create/edit validates and freezes member settings', async () => {
  const discovery: ModelDiscoveryService = {
    async discover(input) {
      const cliKind = input.role === 'kimi' ? 'kimi' : input.role === 'opencode' ? 'opencode' : 'codex';
      return {
        cliKind,
        models: [
          { id: 'model-a', label: 'Model A', thinkingEfforts: ['auto', 'high'], defaultThinkingEffort: 'high' },
          { id: 'model-b', label: 'Model B', thinkingEfforts: ['auto', 'low'], defaultThinkingEffort: 'low' },
        ],
        source: 'live', stale: false, discoveredAt: '2026-09-16T00:00:00.000Z',
      };
    },
  };
  const originalForceMock = process.env.AGENTOS_FORCE_MOCK;
  process.env.AGENTOS_FORCE_MOCK = 'true';
  try {
    await withServer(async (baseUrl, store) => {
      const created = await postJson(`${baseUrl}/conversations`, {
        kind: 'group', replyMode: 'sequential', title: '可配置运行时群聊',
        members: [
          { agentId: 'codex', roleTitle: '规划负责人', model: 'model-a', thinkingEffort: 'high', additionalInstructions: '先列出风险' },
          { agentId: 'kimi', roleTitle: '执行负责人', model: 'model-b', thinkingEffort: 'low', additionalInstructions: '给出可复现步骤' },
        ],
      });
      assert.equal(created.status, 201);
      const createdBody = created.json as {
        conversation: { id: string; settingsVersion: number };
        members: Array<{ id: string; subjectType: string; subjectId: string; roleTitle: string; model?: string; thinkingEffort?: string; additionalInstructions?: string }>;
      };
      assert.equal(createdBody.conversation.settingsVersion, 1);
      const createdAgents = createdBody.members.filter(member => member.subjectType === 'agent');
      assert.deepEqual(createdAgents.map(member => ({ subjectId: member.subjectId, roleTitle: member.roleTitle, model: member.model, thinkingEffort: member.thinkingEffort, additionalInstructions: member.additionalInstructions })), [
        { subjectId: 'codex', roleTitle: '规划负责人', model: 'model-a', thinkingEffort: 'high', additionalInstructions: '先列出风险' },
        { subjectId: 'kimi', roleTitle: '执行负责人', model: 'model-b', thinkingEffort: 'low', additionalInstructions: '给出可复现步骤' },
      ]);

      const memberUpdates = createdAgents.map(member => ({
        memberId: member.id,
        roleTitle: member.subjectId === 'codex' ? '新的规划负责人' : '新的执行负责人',
        model: member.subjectId === 'codex' ? 'model-b' : null,
        thinkingEffort: member.subjectId === 'codex' ? 'low' : null,
        additionalInstructions: member.subjectId === 'codex' ? '只报告阻塞项' : null,
      }));
      const updated = await fetch(`${baseUrl}/conversations/${createdBody.conversation.id}/members`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedSettingsVersion: 1, members: memberUpdates }),
      });
      assert.equal(updated.status, 200);
      const updatedBody = await updated.json() as { conversation: { settingsVersion: number }; members: typeof createdBody.members };
      assert.equal(updatedBody.conversation.settingsVersion, 2);
      const updatedCodex = updatedBody.members.find(member => member.subjectId === 'codex')!;
      const updatedKimi = updatedBody.members.find(member => member.subjectId === 'kimi')!;
      assert.deepEqual({ model: updatedCodex.model, thinkingEffort: updatedCodex.thinkingEffort, additionalInstructions: updatedCodex.additionalInstructions }, { model: 'model-b', thinkingEffort: 'low', additionalInstructions: '只报告阻塞项' });
      assert.deepEqual({ model: updatedKimi.model, thinkingEffort: updatedKimi.thinkingEffort, additionalInstructions: updatedKimi.additionalInstructions }, { model: undefined, thinkingEffort: undefined, additionalInstructions: undefined });

      const stale = await fetch(`${baseUrl}/conversations/${createdBody.conversation.id}/members`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedSettingsVersion: 1, members: memberUpdates }),
      });
      assert.equal(stale.status, 409);
      const current = await fetch(`${baseUrl}/conversations/${createdBody.conversation.id}`).then(response => response.json()) as { conversation: { settingsVersion: number } };
      assert.equal(current.conversation.settingsVersion, 2);

      const sent = await postJson(`${baseUrl}/conversations/${createdBody.conversation.id}/messages`, { content: '请执行配置化群聊' });
      assert.equal(sent.status, 201);
      const sourceMessageId = (sent.json as { message: { id: string } }).message.id;
      const interaction = await postJson(`${baseUrl}/conversations/${createdBody.conversation.id}/interactions`, {
        budget: { maxAgentsPerTurn: 2, maxRepliesPerAgent: 1, maxTotalReplies: 2, maxAgentHops: 2 },
      });
      assert.equal(interaction.status, 201);
      const interactionId = (interaction.json as { interaction: { id: string } }).interaction.id;
      const response = await fetch(`${baseUrl}/conversations/${createdBody.conversation.id}/interactions/${interactionId}/respond`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceMessageId }),
      });
      assert.equal(response.status, 200);
      assert.match(await response.text(), /event: group\.done/);

      const snapshots = store.getDatabase().prepare(
        'SELECT agent_id AS agentId, budget_json AS budgetJson FROM cr_turn_context_snapshots WHERE interaction_id = ? ORDER BY agent_id',
      ).all(interactionId) as Array<{ agentId: string; budgetJson: string }>;
      assert.equal(snapshots.length, 2);
      const configByAgent = new Map(snapshots.map(snapshot => [snapshot.agentId, JSON.parse(snapshot.budgetJson) as { groupRuntimeConfig: { model: string | null; thinkingEffort: string | null; roleTitle: string | null; additionalInstructions: string | null; settingsVersion: number | null } }]));
      assert.deepEqual(configByAgent.get('codex')!.groupRuntimeConfig, { model: 'model-b', thinkingEffort: 'low', roleTitle: '新的规划负责人', additionalInstructions: '只报告阻塞项', settingsVersion: 2 });
      assert.deepEqual(configByAgent.get('kimi')!.groupRuntimeConfig, { model: null, thinkingEffort: null, roleTitle: '新的执行负责人', additionalInstructions: null, settingsVersion: 2 });
    }, discovery);
  } finally {
    if (originalForceMock === undefined) delete process.env.AGENTOS_FORCE_MOCK;
    else process.env.AGENTOS_FORCE_MOCK = originalForceMock;
  }
});
