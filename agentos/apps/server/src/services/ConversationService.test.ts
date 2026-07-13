import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/SqliteStore.js';
import { ConversationService } from './ConversationService.js';

function createProjectRoot(options: {
  codex?: { cliCommand: string; cliArgs: string[] };
  kimi?: { cliCommand: string; cliArgs: string[] };
} = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'agentos-conversation-service-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({
    workspaces: [{
      id: 'workspace-a', name: 'Workspace A', rootPath: root, gitEnabled: true, memoryEnabled: true,
      agents: [
        { id: 'codex', name: 'Codex', role: 'codex', enabled: true, cliCommand: options.codex?.cliCommand ?? 'codex', cliArgs: options.codex?.cliArgs ?? [] },
        { id: 'kimi', name: 'KimiCode', role: 'kimi', enabled: true, cliCommand: options.kimi?.cliCommand ?? 'kimi', cliArgs: options.kimi?.cliArgs ?? ['-p'] },
      ],
      lastOpenedAt: '2026-07-12T00:00:00.000Z', createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z',
    }],
  }), 'utf-8');
  return root;
}

test('persists public status events and the final direct-agent reply', async () => {
  const root = createProjectRoot();
  const originalForceMock = process.env.AGENTOS_FORCE_MOCK;
  let store: SqliteStore | undefined;
  try {
    process.env.AGENTOS_FORCE_MOCK = 'true';
    store = new SqliteStore(root);
    store.createConversation({
      id: 'conversation-a', workspaceId: 'workspace-a', type: 'direct', title: 'Codex chat', agentId: 'codex',
      createdAt: '2026-07-12T01:00:00.000Z', updatedAt: '2026-07-12T01:00:00.000Z',
    });

    const service = new ConversationService(store);
    const result = await service.sendDirectMessage({
      workspaceId: 'workspace-a', workspaceRoot: root, conversationId: 'conversation-a', agentId: 'codex',
      content: '检查项目状态',
    });

    assert.equal(result.execution.status, 'completed');
    assert.equal(store.listMessages('workspace-a', 'conversation-a').length, 2);
    assert.deepEqual(
      store.listExecutionEvents('workspace-a', result.execution.id).map(event => event.status),
      ['queued', 'preparing_context', 'running_cli', 'streaming_response', 'completed'],
    );
  } finally {
    if (originalForceMock === undefined) delete process.env.AGENTOS_FORCE_MOCK;
    else process.env.AGENTOS_FORCE_MOCK = originalForceMock;
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects unsupported image input before persisting a message or execution', async () => {
  const root = createProjectRoot({ codex: { cliCommand: 'custom-agent', cliArgs: [] } });
  const store = new SqliteStore(root);
  const originalForceMock = process.env.AGENTOS_FORCE_MOCK;
  try {
    process.env.AGENTOS_FORCE_MOCK = 'true';
    store.createConversation({
      id: 'conversation-image-unsupported', workspaceId: 'workspace-a', type: 'direct', title: 'Unsupported image', agentId: 'codex',
      createdAt: '2026-07-13T06:00:00.000Z', updatedAt: '2026-07-13T06:00:00.000Z',
    });
    const service = new ConversationService(store);
    await assert.rejects(service.sendDirectMessage({
      workspaceId: 'workspace-a', workspaceRoot: root, conversationId: 'conversation-image-unsupported', agentId: 'codex', content: '',
      attachments: [{ name: 'screen.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,aGVsbG8=' }],
    }), /不支持图片输入/);
    assert.deepEqual(store.listMessages('workspace-a', 'conversation-image-unsupported'), []);
    assert.deepEqual(store.listExecutions('workspace-a', 'conversation-image-unsupported'), []);
  } finally {
    if (originalForceMock === undefined) delete process.env.AGENTOS_FORCE_MOCK;
    else process.env.AGENTOS_FORCE_MOCK = originalForceMock;
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('runs group work through leader, member, and leader summary in order', async () => {
  const root = createProjectRoot();
  const originalForceMock = process.env.AGENTOS_FORCE_MOCK;
  let store: SqliteStore | undefined;
  try {
    process.env.AGENTOS_FORCE_MOCK = 'true';
    store = new SqliteStore(root);
    store.createGroupConversation({
      id: 'group-a', workspaceId: 'workspace-a', type: 'group', title: '开发团队',
      createdAt: '2026-07-12T01:00:00.000Z', updatedAt: '2026-07-12T01:00:00.000Z',
    }, [
      { conversationId: 'group-a', agentId: 'codex', roleTitle: '群主', isLeader: true, createdAt: '2026-07-12T01:00:00.000Z' },
      { conversationId: 'group-a', agentId: 'kimi', roleTitle: '执行工程师', isLeader: false, createdAt: '2026-07-12T01:00:00.000Z' },
    ]);

    const deliveredAgentIds: string[] = [];
    const result = await new ConversationService(store).sendGroupMessage({
      workspaceId: 'workspace-a', workspaceRoot: root, conversationId: 'group-a', content: '修复登录模块',
      onAgentMessage: message => deliveredAgentIds.push(message.senderAgentId ?? ''),
    });

    assert.deepEqual(result.executions.map(execution => execution.agentId), ['codex', 'kimi', 'codex']);
    assert.deepEqual(deliveredAgentIds, ['codex', 'kimi', 'codex']);
    assert.deepEqual(
      store.listMessages('workspace-a', 'group-a').map(message => message.senderAgentId ?? message.senderType),
      ['user', 'codex', 'kimi', 'codex'],
    );
  } finally {
    if (originalForceMock === undefined) delete process.env.AGENTOS_FORCE_MOCK;
    else process.env.AGENTOS_FORCE_MOCK = originalForceMock;
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('uses the execution agent id when a worker turn fails', async () => {
  const root = createProjectRoot({
    codex: { cliCommand: process.execPath, cliArgs: ['-e', 'console.log(process.argv.at(-1))'] },
    kimi: { cliCommand: process.execPath, cliArgs: ['-e', 'process.exit(1)'] },
  });
  const originalForceMock = process.env.AGENTOS_FORCE_MOCK;
  let store: SqliteStore | undefined;
  try {
    process.env.AGENTOS_FORCE_MOCK = 'false';
    store = new SqliteStore(root);
    store.updateAgentProfile('workspace-a', 'codex', {
      roleTitle: '群主', systemPrompt: '完成任务。', permissions: ['read', 'write'], enabled: true,
    });
    store.createGroupConversation({
      id: 'group-failure', workspaceId: 'workspace-a', type: 'group', title: '失败测试',
      createdAt: '2026-07-12T01:00:00.000Z', updatedAt: '2026-07-12T01:00:00.000Z',
    }, [
      { conversationId: 'group-failure', agentId: 'codex', roleTitle: '群主', isLeader: true, createdAt: '2026-07-12T01:00:00.000Z' },
      { conversationId: 'group-failure', agentId: 'kimi', roleTitle: '执行工程师', isLeader: false, createdAt: '2026-07-12T01:00:00.000Z' },
    ]);

    const result = await new ConversationService(store).sendGroupMessage({
      workspaceId: 'workspace-a', workspaceRoot: root, conversationId: 'group-failure', content: '执行失败测试',
    });
    const summary = result.agentMessages.at(-1)?.content ?? '';

    assert.match(summary, /kimi: 执行失败/);
    assert.doesNotMatch(summary, /undefined:/);
  } finally {
    if (originalForceMock === undefined) delete process.env.AGENTOS_FORCE_MOCK;
    else process.env.AGENTOS_FORCE_MOCK = originalForceMock;
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('runs independent group workers concurrently after the leader plan', async () => {
  const root = createProjectRoot({
    codex: { cliCommand: process.execPath, cliArgs: ['-e', 'console.log(process.argv.at(-1))'] },
    kimi: { cliCommand: process.execPath, cliArgs: ['-e', 'setTimeout(() => console.log("kimi worker"), 300)'] },
  });
  const originalForceMock = process.env.AGENTOS_FORCE_MOCK;
  let store: SqliteStore | undefined;
  try {
    process.env.AGENTOS_FORCE_MOCK = 'false';
    const workspaces = JSON.parse(readFileSync(join(root, 'workspace', 'workspaces.json'), 'utf-8'));
    workspaces.workspaces[0].agents.push({
      id: 'opencode', name: 'OpenCode', role: 'opencode', enabled: true,
      cliCommand: process.execPath, cliArgs: ['-e', 'setTimeout(() => console.log("opencode worker"), 300)'],
    });
    writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify(workspaces), 'utf-8');

    store = new SqliteStore(root);
    store.updateAgentProfile('workspace-a', 'codex', {
      roleTitle: '群主', systemPrompt: '完成任务。', permissions: ['read', 'write'], enabled: true,
    });
    store.updateAgentProfile('workspace-a', 'opencode', {
      roleTitle: '审查工程师', systemPrompt: '完成任务。', permissions: ['read', 'write'], enabled: true,
    });
    store.createGroupConversation({
      id: 'group-parallel', workspaceId: 'workspace-a', type: 'group', title: '并行测试',
      createdAt: '2026-07-12T01:00:00.000Z', updatedAt: '2026-07-12T01:00:00.000Z',
    }, [
      { conversationId: 'group-parallel', agentId: 'codex', roleTitle: '群主', isLeader: true, createdAt: '2026-07-12T01:00:00.000Z' },
      { conversationId: 'group-parallel', agentId: 'kimi', roleTitle: '执行工程师', isLeader: false, createdAt: '2026-07-12T01:00:00.000Z' },
      { conversationId: 'group-parallel', agentId: 'opencode', roleTitle: '审查工程师', isLeader: false, createdAt: '2026-07-12T01:00:00.000Z' },
    ]);

    const startedAt = Date.now();
    const result = await new ConversationService(store).sendGroupMessage({
      workspaceId: 'workspace-a', workspaceRoot: root, conversationId: 'group-parallel', content: '并行执行测试',
    });

    assert.ok(Date.now() - startedAt < 850, `workers took ${Date.now() - startedAt}ms`);
    assert.deepEqual(result.executions.map(execution => execution.agentId), ['codex', 'kimi', 'opencode', 'codex']);
  } finally {
    if (originalForceMock === undefined) delete process.env.AGENTOS_FORCE_MOCK;
    else process.env.AGENTOS_FORCE_MOCK = originalForceMock;
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
