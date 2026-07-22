import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/SqliteStore.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import type { ModelDiscoveryService } from '../services/CliModelDiscovery.js';
import { createConversationRoutes } from './conversations.js';

function createProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentos-conversation-routes-'));
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

test('creates a direct conversation and streams a persisted response', async () => {
  const root = createProjectRoot();
  const originalForceMock = process.env.AGENTOS_FORCE_MOCK;
  const store = new SqliteStore(root);
  const app = express();
  const server = app.listen(0);
  try {
    process.env.AGENTOS_FORCE_MOCK = 'true';
    app.use(express.json());
    app.use('/api/workspaces/:workspaceId', createConversationRoutes(store, new WorkspaceManager(store)));
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind a port');
    const baseUrl = `http://127.0.0.1:${address.port}/api/workspaces/workspace-a`;

    const agents = await fetch(`${baseUrl}/agents`).then(response => response.json()) as { agents: Array<{ id: string }> };
    assert.deepEqual(agents.agents.map(agent => agent.id), ['codex', 'kimi']);

    const updatedAgent = await fetch(`${baseUrl}/agents/codex`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roleTitle: '技术负责人', systemPrompt: '先分析，再执行。', permissions: ['read', 'write'], enabled: true, model: 'selected-codex-model', thinkingEffort: 'auto' }),
    }).then(response => response.json()) as { agent: { roleTitle: string; provider: string; permissions: string[]; model: string; thinkingEffort: string; capability: { cliKind: string } } };
    assert.equal(updatedAgent.agent.roleTitle, '技术负责人');
    assert.deepEqual(updatedAgent.agent.permissions, ['read', 'write']);
    assert.equal(updatedAgent.agent.model, 'selected-codex-model');
    assert.equal(updatedAgent.agent.thinkingEffort, 'auto');
    assert.equal(updatedAgent.agent.capability.cliKind, 'codex');

    const providerUpdated = await fetch(`${baseUrl}/agents/codex`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'custom', roleTitle: '代码审查负责人' }),
    }).then(response => response.json()) as { agent: { provider: string; roleTitle: string } };
    assert.equal(providerUpdated.agent.provider, 'custom');
    assert.equal(providerUpdated.agent.roleTitle, '代码审查负责人');
    const invalidProvider = await fetch(`${baseUrl}/agents/codex`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'reviewer' }),
    });
    assert.equal(invalidProvider.status, 400);

    const clearedAgent = await fetch(`${baseUrl}/agents/codex`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: '', thinkingEffort: 'auto' }),
    }).then(response => response.json()) as { agent: { model?: string; thinkingEffort: string } };
    assert.equal(clearedAgent.agent.model, undefined);
    assert.equal(clearedAgent.agent.thinkingEffort, 'auto');

    const unsupportedEffort = await fetch(`${baseUrl}/agents/kimi`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ thinkingEffort: 'high' }),
    });
    assert.equal(unsupportedEffort.status, 400);

    const group = await fetch(`${baseUrl}/conversations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'group', title: '开发团队', memberAgentIds: ['codex', 'kimi'], leaderAgentId: 'codex' }),
    }).then(response => response.json()) as { conversation: { id: string; type: string }; members: Array<{ agentId: string; isLeader: boolean }> };
    assert.equal(group.conversation.type, 'group');
    assert.deepEqual(group.members.map(member => member.agentId), ['codex', 'kimi']);
    assert.equal(group.members[0]?.isLeader, true);

    const explicitGroup = await fetch(`${baseUrl}/conversations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'group', title: '显式协作', dispatchMode: 'mentioned_only',
        members: [
          { agentId: 'codex', roleKind: 'leader', roleTitle: '路由负责人', sequence: 10 },
          { agentId: 'kimi', roleKind: 'reviewer', roleTitle: '验证工程师', sequence: 20 },
        ],
      }),
    }).then(response => response.json()) as { conversation: { id: string; dispatchMode: string }; members: Array<{ roleKind: string; sequence: number }> };
    assert.equal(explicitGroup.conversation.dispatchMode, 'mentioned_only');
    assert.deepEqual(explicitGroup.members.map(member => [member.roleKind, member.sequence]), [['leader', 10], ['reviewer', 20]]);
    const updatedGroup = await fetch(`${baseUrl}/conversations/${explicitGroup.conversation.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dispatchMode: 'leader_route',
        members: [
          { agentId: 'codex', roleKind: 'leader', roleTitle: '总协调', sequence: 20 },
          { agentId: 'kimi', roleKind: 'worker', roleTitle: '实现工程师', sequence: 10 },
        ],
      }),
    }).then(response => response.json()) as { conversation: { dispatchMode: string }; members: Array<{ roleKind: string; sequence: number }> };
    assert.equal(updatedGroup.conversation.dispatchMode, 'leader_route');
    assert.deepEqual(updatedGroup.members.map(member => [member.roleKind, member.sequence]), [['worker', 10], ['leader', 20]]);
    const invalidGroup = await fetch(`${baseUrl}/conversations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'group', members: [
        { agentId: 'codex', roleKind: 'leader', roleTitle: 'Leader', sequence: 10 },
        { agentId: 'kimi', roleKind: 'worker', roleTitle: 'Worker', sequence: 10 },
      ] }),
    });
    assert.equal(invalidGroup.status, 400);
    const invalidMention = await fetch(`${baseUrl}/conversations/${group.conversation.id}/messages/stream`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'route', mentionedAgentIds: ['outside'] }),
    });
    assert.equal(invalidMention.status, 400);

    const renamedGroup = await fetch(`${baseUrl}/conversations/${group.conversation.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '登录重构协作群' }),
    }).then(response => response.json()) as { conversation: { title: string } };
    assert.equal(renamedGroup.conversation.title, '登录重构协作群');

    const groupResponse = await fetch(`${baseUrl}/conversations/${group.conversation.id}/messages/stream`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ content: '修复登录模块' }),
    });
    const groupStream = await groupResponse.text();
    assert.equal(groupResponse.status, 200);
    assert.equal((groupStream.match(/^event: message$/gm) ?? []).length, 3);

    const created = await fetch(`${baseUrl}/conversations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'codex', title: '项目检查' }),
    }).then(response => response.json()) as { conversation: { id: string } };

    const response = await fetch(`${baseUrl}/conversations/${created.conversation.id}/messages/stream`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ content: '检查项目状态' }),
    });
    const stream = await response.text();
    assert.equal(response.status, 200);
    assert.match(stream, /event: execution/);
    assert.match(stream, /event: runtime/);
    assert.match(stream, /event: message/);

    const messages = await fetch(`${baseUrl}/conversations/${created.conversation.id}/messages`)
      .then(response => response.json()) as { messages: Array<{ senderType: string }> };
    assert.deepEqual(messages.messages.map(message => message.senderType), ['user', 'agent']);

    const deleted = await fetch(`${baseUrl}/conversations/${created.conversation.id}`, { method: 'DELETE' });
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), { conversationId: created.conversation.id });

    const remaining = await fetch(`${baseUrl}/conversations`)
      .then(response => response.json()) as { conversations: Array<{ id: string }> };
    assert.equal(remaining.conversations.some(conversation => conversation.id === created.conversation.id), false);

    const missingWorkspace = await fetch(`http://127.0.0.1:${address.port}/api/workspaces/missing/conversations/${created.conversation.id}`, { method: 'DELETE' });
    assert.equal(missingWorkspace.status, 404);

    const missingConversation = await fetch(`${baseUrl}/conversations/missing`, { method: 'DELETE' });
    assert.equal(missingConversation.status, 404);
  } finally {
    if (originalForceMock === undefined) delete process.env.AGENTOS_FORCE_MOCK;
    else process.env.AGENTOS_FORCE_MOCK = originalForceMock;
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('persists model and thinking effort per conversation and rejects invalid combinations', async () => {
  const root = createProjectRoot();
  const store = new SqliteStore(root);
  const app = express();
  const server = app.listen(0);
  const discovery: ModelDiscoveryService = {
    async discover() {
      return {
        cliKind: 'codex',
        models: [
          { id: 'model-a', label: 'Model A', thinkingEfforts: ['auto', 'high'], defaultThinkingEffort: 'high' },
          { id: 'model-b', label: 'Model B', thinkingEfforts: ['auto', 'low'], defaultThinkingEffort: 'low' },
        ],
        source: 'live', stale: false, discoveredAt: new Date().toISOString(),
      };
    },
  };
  try {
    app.use(express.json());
    app.use('/api/workspaces/:workspaceId', createConversationRoutes(store, new WorkspaceManager(store), discovery));
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind a port');
    const baseUrl = `http://127.0.0.1:${address.port}/api/workspaces/workspace-a`;
    const create = async () => fetch(`${baseUrl}/conversations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: 'codex' }),
    }).then(response => response.json()) as Promise<{ conversation: { id: string } }>;
    const conversationA = await create();
    const conversationB = await create();

    const savedA = await fetch(`${baseUrl}/conversations/${conversationA.conversation.id}/settings`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'model-a', thinkingEffort: 'high' }),
    });
    assert.equal(savedA.status, 200);
    const savedB = await fetch(`${baseUrl}/conversations/${conversationB.conversation.id}/settings`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'model-b', thinkingEffort: 'low' }),
    });
    assert.equal(savedB.status, 200);

    const listed = await fetch(`${baseUrl}/conversations`).then(response => response.json()) as { conversations: Array<{ id: string; model?: string; thinkingEffort?: string }> };
    const listedById = new Map(listed.conversations.map(conversation => [conversation.id, conversation]));
    const selectedA = listedById.get(conversationA.conversation.id)!;
    const selectedB = listedById.get(conversationB.conversation.id)!;
    assert.deepEqual({ id: selectedA.id, model: selectedA.model, thinkingEffort: selectedA.thinkingEffort }, {
      id: conversationA.conversation.id, model: 'model-a', thinkingEffort: 'high',
    });
    assert.deepEqual({ id: selectedB.id, model: selectedB.model, thinkingEffort: selectedB.thinkingEffort }, {
      id: conversationB.conversation.id, model: 'model-b', thinkingEffort: 'low',
    });

    const invalidModel = await fetch(`${baseUrl}/conversations/${conversationA.conversation.id}/settings`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'missing-model', thinkingEffort: 'high' }),
    });
    assert.equal(invalidModel.status, 400);
    const unsupportedEffort = await fetch(`${baseUrl}/conversations/${conversationA.conversation.id}/settings`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'model-a', thinkingEffort: 'low' }),
    });
    assert.equal(unsupportedEffort.status, 400);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a direct message when the requested model is not in the discovered capability', async () => {
  const root = createProjectRoot();
  const originalForceMock = process.env.AGENTOS_FORCE_MOCK;
  const store = new SqliteStore(root);
  const app = express();
  const server = app.listen(0);
  const discovery: ModelDiscoveryService = {
    async discover(input) {
      return {
        cliKind: 'codex',
        models: [{ id: 'allowed-model', label: 'Allowed Model', thinkingEfforts: ['auto', 'high'], defaultThinkingEffort: 'high' }],
        source: 'live', stale: false, discoveredAt: new Date().toISOString(),
      };
    },
  };
  try {
    process.env.AGENTOS_FORCE_MOCK = 'true';
    app.use(express.json());
    app.use('/api/workspaces/:workspaceId', createConversationRoutes(store, new WorkspaceManager(store), discovery));
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind a port');
    const baseUrl = `http://127.0.0.1:${address.port}/api/workspaces/workspace-a`;
    const created = await fetch(`${baseUrl}/conversations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: 'codex' }),
    }).then(response => response.json()) as { conversation: { id: string } };

    const response = await fetch(`${baseUrl}/conversations/${created.conversation.id}/messages/stream`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ content: '检查项目', model: 'not-discovered', thinkingEffort: 'high' }),
    });

    assert.equal(response.status, 400);
    assert.equal(store.listExecutions('workspace-a', created.conversation.id).length, 0);

    store.updateAgentProfile('workspace-a', 'codex', { model: 'profile-only-model', roleTitle: '架构师', systemPrompt: '完成任务。', permissions: ['read', 'write'], enabled: true });
    const profileOnlyResponse = await fetch(`${baseUrl}/conversations/${created.conversation.id}/messages/stream`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ content: '不应绕过能力校验', model: 'profile-only-model', thinkingEffort: 'high' }),
    });
    assert.equal(profileOnlyResponse.status, 400);
    assert.equal(store.listExecutions('workspace-a', created.conversation.id).length, 0);

    const validResponse = await fetch(`${baseUrl}/conversations/${created.conversation.id}/messages/stream`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ content: '使用指定模型检查项目', model: 'allowed-model', thinkingEffort: 'high' }),
    });
    assert.equal(validResponse.status, 200);
    assert.equal(store.listExecutions('workspace-a', created.conversation.id).length, 1);
    assert.equal(store.listAgentProfiles('workspace-a').find(agent => agent.id === 'codex')?.model, 'profile-only-model');
  } finally {
    if (originalForceMock === undefined) delete process.env.AGENTOS_FORCE_MOCK;
    else process.env.AGENTOS_FORCE_MOCK = originalForceMock;
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('accepts an image-only direct message, persists its attachment, and serves it safely', async () => {
  const root = createProjectRoot();
  const originalForceMock = process.env.AGENTOS_FORCE_MOCK;
  const store = new SqliteStore(root);
  const app = express();
  const server = app.listen(0);
  try {
    process.env.AGENTOS_FORCE_MOCK = 'true';
    app.use(express.json({ limit: '50mb' }));
    app.use('/api/workspaces/:workspaceId', createConversationRoutes(store, new WorkspaceManager(store)));
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind a port');
    const baseUrl = `http://127.0.0.1:${address.port}/api/workspaces/workspace-a`;
    const created = await fetch(`${baseUrl}/conversations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: 'codex' }),
    }).then(response => response.json()) as { conversation: { id: string } };

    const response = await fetch(`${baseUrl}/conversations/${created.conversation.id}/messages/stream`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ content: '', attachments: [{ name: 'screen.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,aGVsbG8=' }] }),
    });
    assert.equal(response.status, 200);
    await response.text();

    const messages = await fetch(`${baseUrl}/conversations/${created.conversation.id}/messages`)
      .then(result => result.json()) as { messages: Array<{ senderType: string; attachments?: Array<{ id: string; url: string }> }> };
    const userMessage = messages.messages.find(message => message.senderType === 'user');
    assert.equal(userMessage?.attachments?.length, 1);
    const attachmentUrl = userMessage!.attachments![0]!.url;
    const attachmentResponse = await fetch(`http://127.0.0.1:${address.port}${attachmentUrl}`);
    assert.equal(attachmentResponse.status, 200);
    assert.equal(attachmentResponse.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await attachmentResponse.arrayBuffer()), Buffer.from('hello'));

    const invalid = await fetch(`${baseUrl}/conversations/${created.conversation.id}/messages/stream`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ content: '不应执行', attachments: [{ name: 'file.pdf', mimeType: 'application/pdf', dataUrl: 'data:application/pdf;base64,aGVsbG8=' }] }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(store.listExecutions('workspace-a', created.conversation.id).length, 1);

    const deleted = await fetch(`${baseUrl}/conversations/${created.conversation.id}`, { method: 'DELETE' });
    assert.equal(deleted.status, 200);
    const removedAttachmentResponse = await fetch(`http://127.0.0.1:${address.port}${attachmentUrl}`);
    assert.equal(removedAttachmentResponse.status, 404);
  } finally {
    if (originalForceMock === undefined) delete process.env.AGENTOS_FORCE_MOCK;
    else process.env.AGENTOS_FORCE_MOCK = originalForceMock;
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('pauses a direct run for user input and resumes it under the same Run', async () => {
  const root = createProjectRoot();
  const originalForceMock = process.env.AGENTOS_FORCE_MOCK;
  const config = JSON.parse(readFileSync(join(root, 'workspace', 'workspaces.json'), 'utf8')) as { workspaces: Array<{ id: string; agents: Array<{ id: string; cliCommand: string; cliArgs: string[] }> }> };
  const codex = config.workspaces.find(workspace => workspace.id === 'workspace-a')!.agents.find(agent => agent.id === 'codex')!;
  const script = "const p=process.argv.at(-1)||''; console.log(p.includes('用户补充信息') ? '恢复完成' : '<!-- agentos-waiting-user: {\"question\":\"请提供部署环境\"} -->')";
  codex.cliCommand = process.execPath;
  codex.cliArgs = ['-e', script];
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify(config), 'utf8');
  const store = new SqliteStore(root);
  const app = express();
  const server = app.listen(0);
  try {
    process.env.AGENTOS_FORCE_MOCK = 'false';
    store.updateAgentProfile('workspace-a', 'codex', { roleTitle: '架构师', systemPrompt: '完成任务。', permissions: ['read', 'write'], enabled: true });
    store.createConversation({ id: 'waiting-route-conversation', workspaceId: 'workspace-a', type: 'direct', title: 'Waiting', agentId: 'codex', createdAt: '2026-07-14T01:00:00.000Z', updatedAt: '2026-07-14T01:00:00.000Z' });
    app.use(express.json());
    app.use('/api/workspaces/:workspaceId', createConversationRoutes(store, new WorkspaceManager(store)));
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind a port');
    const base = `http://127.0.0.1:${address.port}/api/workspaces/workspace-a/conversations/waiting-route-conversation`;

    const waitingResponse = await fetch(`${base}/messages/stream`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ content: '部署项目' }),
    });
    const waitingStream = await waitingResponse.text();
    assert.equal(waitingResponse.status, 200);
    assert.match(waitingStream, /waiting_user/);
    assert.match(waitingStream, /请提供部署环境/);
    assert.doesNotMatch(waitingStream, /run\.completed/);
    const waitingRun = store.listRuns('workspace-a', 'waiting-route-conversation')[0];
    assert.equal(waitingRun?.status, 'waiting_user');
    assert.equal(waitingRun?.waitingQuestion, '请提供部署环境');

    const resumeResponse = await fetch(`${base}/runs/${waitingRun!.id}/resume/stream`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ content: '生产环境' }),
    });
    const resumeStream = await resumeResponse.text();
    assert.equal(resumeResponse.status, 200);
    assert.match(resumeStream, /恢复完成/);
    assert.match(resumeStream, /event: done/);
    const completedRun = store.getRun('workspace-a', waitingRun!.id);
    assert.equal(completedRun?.status, 'completed');
    assert.equal(store.listExecutions('workspace-a', 'waiting-route-conversation').length, 2);
    assert.equal(new Set(store.listExecutions('workspace-a', 'waiting-route-conversation').map(execution => execution.runId)).size, 1);
  } finally {
    if (originalForceMock === undefined) delete process.env.AGENTOS_FORCE_MOCK;
    else process.env.AGENTOS_FORCE_MOCK = originalForceMock;
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('reconnects to a completed Run without creating another message or execution', async () => {
  const root = createProjectRoot();
  const originalForceMock = process.env.AGENTOS_FORCE_MOCK;
  const store = new SqliteStore(root);
  const app = express();
  const server = app.listen(0);
  try {
    process.env.AGENTOS_FORCE_MOCK = 'true';
    app.use(express.json());
    app.use('/api/workspaces/:workspaceId', createConversationRoutes(store, new WorkspaceManager(store)));
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind a port');
    const base = `http://127.0.0.1:${address.port}/api/workspaces/workspace-a`;

    const created = await fetch(`${base}/conversations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'codex', title: 'Reconnect' }),
    }).then(response => response.json()) as { conversation: { id: string } };
    const initial = await fetch(`${base}/conversations/${created.conversation.id}/messages/stream`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ content: '连接恢复测试' }),
    });
    assert.equal(initial.status, 200);
    assert.match(await initial.text(), /event: run/);

    const run = store.listRuns('workspace-a', created.conversation.id)[0];
    assert.ok(run);
    const beforeMessages = store.listMessages('workspace-a', created.conversation.id).length;
    const beforeExecutions = store.listExecutions('workspace-a', created.conversation.id).length;

    const recovered = await fetch(`${base}/conversations/${created.conversation.id}/runs/${run.id}/stream?cursor=0`, {
      headers: { Accept: 'text/event-stream' },
    });
    const recoveredStream = await recovered.text();
    assert.equal(recovered.status, 200);
    assert.match(recoveredStream, /event: run/);
    assert.match(recoveredStream, /event: done/);
    assert.equal(store.listMessages('workspace-a', created.conversation.id).length, beforeMessages);
    assert.equal(store.listExecutions('workspace-a', created.conversation.id).length, beforeExecutions);
  } finally {
    if (originalForceMock === undefined) delete process.env.AGENTOS_FORCE_MOCK;
    else process.env.AGENTOS_FORCE_MOCK = originalForceMock;
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
