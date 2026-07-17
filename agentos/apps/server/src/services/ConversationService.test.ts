import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/SqliteStore.js';
import { ConversationService } from './ConversationService.js';
import { EventBus } from '../events/EventBus.js';
import { MemoryService } from './MemoryService.js';
import { RuntimeArtifactService } from './RuntimeArtifactService.js';
import type { AgentEvent } from '@agentos/shared';

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

function createFailingEventBus(): EventBus {
  const bus = new EventBus();
  bus.subscribe(() => { throw new Error('event persistence unavailable'); });
  return bus;
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
    assert.ok(result.execution.runId);
    assert.equal(store.listRuns('workspace-a', 'conversation-a').length, 1);
    assert.equal(store.listRuns('workspace-a', 'conversation-a')[0]?.id, result.execution.runId);
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

test('persists runtime log artifacts and artifact-created events for an observable run', async () => {
  const root = createProjectRoot();
  const originalForceMock = process.env.AGENTOS_FORCE_MOCK;
  let store: SqliteStore | undefined;
  try {
    process.env.AGENTOS_FORCE_MOCK = 'true';
    store = new SqliteStore(root);
    store.createConversation({ id: 'artifact-conversation', workspaceId: 'workspace-a', type: 'direct', title: 'Artifacts', agentId: 'codex', createdAt: '2026-07-12T01:00:00.000Z', updatedAt: '2026-07-12T01:00:00.000Z' });
    const bus = new EventBus();
    bus.subscribe(event => store!.appendAgentEvent(event));
    const service = new ConversationService(store, bus, new RuntimeArtifactService(store, root));
    const result = await service.sendDirectMessage({ workspaceId: 'workspace-a', workspaceRoot: root, conversationId: 'artifact-conversation', agentId: 'codex', content: 'artifact evidence' });
    const artifacts = store.listRuntimeArtifacts('workspace-a', result.execution.runId);
    assert.ok(artifacts.some(artifact => artifact.type === 'log' && artifact.contentAvailable));
    assert.ok(store.listAgentEvents('workspace-a', result.execution.runId).some(event => event.type === 'execution.artifact.created'));
  } finally {
    if (originalForceMock === undefined) delete process.env.AGENTOS_FORCE_MOCK;
    else process.env.AGENTOS_FORCE_MOCK = originalForceMock;
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('runs a direct real child process and persists observable invocation evidence', async () => {
  const root = createProjectRoot({ codex: { cliCommand: process.execPath, cliArgs: ['-e', "console.log('direct real reply')"] } });
  const originalForceMock = process.env.AGENTOS_FORCE_MOCK;
  let store: SqliteStore | undefined;
  try {
    process.env.AGENTOS_FORCE_MOCK = 'false';
    store = new SqliteStore(root);
    store.updateAgentProfile('workspace-a', 'codex', { roleTitle: '架构师', systemPrompt: '完成任务。', permissions: ['read', 'write'], enabled: true });
    store.createConversation({ id: 'real-direct', workspaceId: 'workspace-a', type: 'direct', title: 'Real direct', agentId: 'codex', createdAt: '2026-07-12T01:00:00.000Z', updatedAt: '2026-07-12T01:00:00.000Z' });
    const result = await new ConversationService(store).sendDirectMessage({ workspaceId: 'workspace-a', workspaceRoot: root, conversationId: 'real-direct', agentId: 'codex', content: '真实子进程路径' });
    assert.equal(result.execution.status, 'completed');
    assert.match(result.responseMessage.content, /direct real reply/);
    assert.equal(store.listRunCliInvocations('workspace-a', result.execution.runId).length, 1);
  } finally {
    if (originalForceMock === undefined) delete process.env.AGENTOS_FORCE_MOCK;
    else process.env.AGENTOS_FORCE_MOCK = originalForceMock;
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('publishes and persists unified events for a direct run', async () => {
  const root = createProjectRoot();
  const originalForceMock = process.env.AGENTOS_FORCE_MOCK;
  let store: SqliteStore | undefined;
  try {
    process.env.AGENTOS_FORCE_MOCK = 'true';
    store = new SqliteStore(root);
    store.createConversation({ id: 'event-conversation', workspaceId: 'workspace-a', type: 'direct', title: 'Events', agentId: 'codex', createdAt: '2026-07-12T01:00:00.000Z', updatedAt: '2026-07-12T01:00:00.000Z' });
    const bus = new EventBus();
    bus.subscribe(event => store!.appendAgentEvent(event));
    const result = await new ConversationService(store, bus).sendDirectMessage({
      workspaceId: 'workspace-a', workspaceRoot: root, conversationId: 'event-conversation', agentId: 'codex', content: '统一事件',
    });
    const events = store.listAgentEvents('workspace-a', result.execution.runId);
    assert.ok(events.length >= 8);
    assert.equal(new Set(events.map(event => event.runId)).size, 1);
    assert.equal(events[0]?.schemaVersion, 1);
    assert.equal(events.some(event => event.type === 'run.created'), true);
    assert.equal(events.some(event => event.type === 'run.completed'), true);
  } finally {
    if (originalForceMock === undefined) delete process.env.AGENTOS_FORCE_MOCK;
    else process.env.AGENTOS_FORCE_MOCK = originalForceMock;
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('projects normalized runtime events into persisted AgentEvents and callback output', async () => {
  const root = createProjectRoot();
  const originalForceMock = process.env.AGENTOS_FORCE_MOCK;
  let store: SqliteStore | undefined;
  try {
    process.env.AGENTOS_FORCE_MOCK = 'true';
    store = new SqliteStore(root);
    store.createConversation({ id: 'runtime-event-conversation', workspaceId: 'workspace-a', type: 'direct', title: 'Runtime events', agentId: 'codex', createdAt: '2026-07-12T01:00:00.000Z', updatedAt: '2026-07-12T01:00:00.000Z' });
    const bus = new EventBus();
    bus.subscribe(event => store!.appendAgentEvent(event));
    const observed: AgentEvent[] = [];
    const result = await new ConversationService(store, bus).sendDirectMessage({
      workspaceId: 'workspace-a', workspaceRoot: root, conversationId: 'runtime-event-conversation', agentId: 'codex', content: '运行时事件',
      onRuntimeEvent: event => observed.push(event),
    });
    const persisted = store.listAgentEvents('workspace-a', result.execution.runId);
    assert.equal(observed.some(event => event.type === 'execution.output.appended'), true);
    assert.equal(persisted.some(event => event.type === 'execution.output.appended'), true);
    assert.equal(persisted.some(event => event.type === 'execution.tool.started'), false);
    assert.equal(persisted.every(event => event.executionId === undefined || event.executionId === result.execution.id), true);
  } finally {
    if (originalForceMock === undefined) delete process.env.AGENTOS_FORCE_MOCK;
    else process.env.AGENTOS_FORCE_MOCK = originalForceMock;
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('does not return success when critical direct-run event persistence fails', async () => {
  const root = createProjectRoot();
  const originalForceMock = process.env.AGENTOS_FORCE_MOCK;
  let store: SqliteStore | undefined;
  try {
    process.env.AGENTOS_FORCE_MOCK = 'true';
    store = new SqliteStore(root);
    store.createConversation({ id: 'event-failure-direct', workspaceId: 'workspace-a', type: 'direct', title: 'Event failure', agentId: 'codex', createdAt: '2026-07-12T01:00:00.000Z', updatedAt: '2026-07-12T01:00:00.000Z' });

    await assert.rejects(
      new ConversationService(store, createFailingEventBus()).sendDirectMessage({
        workspaceId: 'workspace-a', workspaceRoot: root, conversationId: 'event-failure-direct', agentId: 'codex', content: 'event failure',
      }),
      error => error instanceof Error && error.message === '关键事件持久化失败',
    );

    const run = store.listRuns('workspace-a', 'event-failure-direct')[0];
    assert.equal(run?.status, 'failed');
    assert.match(run?.failureReason ?? '', /关键事件持久化失败/);
  } finally {
    if (originalForceMock === undefined) delete process.env.AGENTOS_FORCE_MOCK;
    else process.env.AGENTOS_FORCE_MOCK = originalForceMock;
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('does not return success when critical group-run event persistence fails', async () => {
  const root = createProjectRoot();
  const originalForceMock = process.env.AGENTOS_FORCE_MOCK;
  let store: SqliteStore | undefined;
  try {
    process.env.AGENTOS_FORCE_MOCK = 'true';
    store = new SqliteStore(root);
    store.createGroupConversation({ id: 'event-failure-group', workspaceId: 'workspace-a', type: 'group', title: 'Event failure', createdAt: '2026-07-12T01:00:00.000Z', updatedAt: '2026-07-12T01:00:00.000Z' }, [
      { conversationId: 'event-failure-group', agentId: 'codex', roleTitle: 'leader', isLeader: true, createdAt: '2026-07-12T01:00:00.000Z' },
      { conversationId: 'event-failure-group', agentId: 'kimi', roleTitle: 'worker', isLeader: false, createdAt: '2026-07-12T01:00:00.000Z' },
    ]);

    await assert.rejects(
      new ConversationService(store, createFailingEventBus()).sendGroupMessage({
        workspaceId: 'workspace-a', workspaceRoot: root, conversationId: 'event-failure-group', content: 'event failure',
      }),
      error => error instanceof Error && error.message === '关键事件持久化失败',
    );

    const run = store.listRuns('workspace-a', 'event-failure-group')[0];
    assert.equal(run?.status, 'failed');
    assert.match(run?.failureReason ?? '', /关键事件持久化失败/);
  } finally {
    if (originalForceMock === undefined) delete process.env.AGENTOS_FORCE_MOCK;
    else process.env.AGENTOS_FORCE_MOCK = originalForceMock;
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('marks the direct run failed and persists a failure message when memory usage persistence fails', async () => {
  const root = createProjectRoot();
  const originalForceMock = process.env.AGENTOS_FORCE_MOCK;
  let store: SqliteStore | undefined;
  try {
    process.env.AGENTOS_FORCE_MOCK = 'true';
    store = new SqliteStore(root);
    store.createConversation({ id: 'memory-failure-direct', workspaceId: 'workspace-a', type: 'direct', title: 'Memory failure', agentId: 'codex', createdAt: '2026-07-12T01:00:00.000Z', updatedAt: '2026-07-12T01:00:00.000Z' });
    await new MemoryService(store).create({
      workspaceId: 'workspace-a', workspaceRoot: root, memoryEnabled: true,
      type: 'decision', title: '需要注入的记忆', summary: '测试摘要', content: '测试内容', importance: 80,
    });
    store.createMemoryUsage = () => { throw new Error('memory usage storage unavailable'); };

    await assert.rejects(
      new ConversationService(store).sendDirectMessage({
        workspaceId: 'workspace-a', workspaceRoot: root, conversationId: 'memory-failure-direct', agentId: 'codex', content: '触发记忆写入失败',
      }),
      /记忆使用记录持久化失败/,
    );

    const run = store.listRuns('workspace-a', 'memory-failure-direct')[0];
    assert.equal(run?.status, 'failed');
    assert.match(run?.failureReason ?? '', /记忆使用记录持久化失败/);
    assert.match(store.listMessages('workspace-a', 'memory-failure-direct').at(-1)?.content ?? '', /记忆使用记录持久化失败/);
  } finally {
    if (originalForceMock === undefined) delete process.env.AGENTOS_FORCE_MOCK;
    else process.env.AGENTOS_FORCE_MOCK = originalForceMock;
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('persists group memory usage after all group executions have been created', async () => {
  const root = createProjectRoot();
  const originalForceMock = process.env.AGENTOS_FORCE_MOCK;
  let store: SqliteStore | undefined;
  try {
    process.env.AGENTOS_FORCE_MOCK = 'true';
    store = new SqliteStore(root);
    store.createGroupConversation({ id: 'memory-timing-group', workspaceId: 'workspace-a', type: 'group', title: 'Memory timing', createdAt: '2026-07-12T01:00:00.000Z', updatedAt: '2026-07-12T01:00:00.000Z' }, [
      { conversationId: 'memory-timing-group', agentId: 'codex', roleTitle: 'leader', isLeader: true, createdAt: '2026-07-12T01:00:00.000Z' },
      { conversationId: 'memory-timing-group', agentId: 'kimi', roleTitle: 'worker', isLeader: false, createdAt: '2026-07-12T01:00:00.000Z' },
    ]);
    await new MemoryService(store).create({
      workspaceId: 'workspace-a', workspaceRoot: root, memoryEnabled: true,
      type: 'decision', title: '群聊记忆', summary: '群聊摘要', content: '群聊内容', importance: 80,
    });
    let executionCountAtUsage = -1;
    const originalCreateMemoryUsage = store.createMemoryUsage.bind(store);
    store.createMemoryUsage = usage => {
      executionCountAtUsage = store!.listExecutions('workspace-a', 'memory-timing-group').length;
      originalCreateMemoryUsage(usage);
    };

    await new ConversationService(store).sendGroupMessage({
      workspaceId: 'workspace-a', workspaceRoot: root, conversationId: 'memory-timing-group', content: '检查群聊记忆',
    });

    assert.equal(executionCountAtUsage, 3);
  } finally {
    if (originalForceMock === undefined) delete process.env.AGENTOS_FORCE_MOCK;
    else process.env.AGENTOS_FORCE_MOCK = originalForceMock;
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('injects only active memories and persists per-run memory usage', async () => {
  const root = createProjectRoot();
  const originalForceMock = process.env.AGENTOS_FORCE_MOCK;
  let store: SqliteStore | undefined;
  try {
    process.env.AGENTOS_FORCE_MOCK = 'true';
    store = new SqliteStore(root);
    store.createConversation({ id: 'memory-conversation', workspaceId: 'workspace-a', type: 'direct', title: 'Memory', agentId: 'codex', createdAt: '2026-07-12T01:00:00.000Z', updatedAt: '2026-07-12T01:00:00.000Z' });
    await new MemoryService(store).create({ workspaceId: 'workspace-a', workspaceRoot: root, memoryEnabled: true, type: 'decision', title: '认证决策', summary: '令牌决策', content: '令牌必须短期有效。', importance: 90 });
    const result = await new ConversationService(store).sendDirectMessage({ workspaceId: 'workspace-a', workspaceRoot: root, conversationId: 'memory-conversation', agentId: 'codex', content: '请检查令牌决策', memoryEnabled: true });
    const usage = store.listMemoryUsage('workspace-a', result.execution.runId);
    assert.equal(usage.length, 1);
    assert.equal(usage[0]?.injectedCharacters > 0, true);
    const disabled = await new ConversationService(store).sendDirectMessage({ workspaceId: 'workspace-a', workspaceRoot: root, conversationId: 'memory-conversation', agentId: 'codex', content: '不要注入记忆', memoryEnabled: false });
    assert.deepEqual(store.listMemoryUsage('workspace-a', disabled.execution.runId), []);
  } finally {
    if (originalForceMock === undefined) delete process.env.AGENTOS_FORCE_MOCK;
    else process.env.AGENTOS_FORCE_MOCK = originalForceMock;
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('records terminal failed and cancelled Run states without persisting CLI output', async () => {
  const root = createProjectRoot({
    codex: { cliCommand: process.execPath, cliArgs: ['-e', "const prompt=process.argv.at(-1)||''; if(prompt.includes('取消路径')) setInterval(() => {}, 1000); else { console.error('PRIVATE_CLI_OUTPUT'); process.exit(1); }"] },
  });
  const originalForceMock = process.env.AGENTOS_FORCE_MOCK;
  let store: SqliteStore | undefined;
  try {
    process.env.AGENTOS_FORCE_MOCK = 'false';
    store = new SqliteStore(root);
    store.updateAgentProfile('workspace-a', 'codex', { roleTitle: '架构师', systemPrompt: '完成任务。', permissions: ['read', 'write'], enabled: true });
    store.createConversation({ id: 'failure-conversation', workspaceId: 'workspace-a', type: 'direct', title: 'Failure', agentId: 'codex', createdAt: '2026-07-12T01:00:00.000Z', updatedAt: '2026-07-12T01:00:00.000Z' });
    const failed = await new ConversationService(store).sendDirectMessage({ workspaceId: 'workspace-a', workspaceRoot: root, conversationId: 'failure-conversation', agentId: 'codex', content: '失败路径' });
    assert.equal(failed.execution.status, 'failed');
    assert.equal(store.listRuns('workspace-a', 'failure-conversation')[0]?.status, 'failed');
    assert.doesNotMatch(store.listRuns('workspace-a', 'failure-conversation')[0]?.failureReason ?? '', /PRIVATE_CLI_OUTPUT/);

    store.createConversation({ id: 'cancel-conversation', workspaceId: 'workspace-a', type: 'direct', title: 'Cancel', agentId: 'codex', createdAt: '2026-07-12T01:00:00.000Z', updatedAt: '2026-07-12T01:00:00.000Z' });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 40);
    const cancelled = await new ConversationService(store).sendDirectMessage({ workspaceId: 'workspace-a', workspaceRoot: root, conversationId: 'cancel-conversation', agentId: 'codex', content: '取消路径', signal: controller.signal });
    assert.equal(cancelled.execution.status, 'cancelled');
    assert.equal(store.listRuns('workspace-a', 'cancel-conversation')[0]?.status, 'cancelled');
    assert.equal(store.listMessages('workspace-a', 'cancel-conversation').at(-1)?.content, '执行已取消：Codex 执行已取消');
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
    assert.equal(new Set(result.executions.map(execution => execution.runId)).size, 1);
    assert.equal(store.listRuns('workspace-a', 'group-a').length, 1);
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

    const workerStarts: number[] = [];
    const result = await new ConversationService(store).sendGroupMessage({
      workspaceId: 'workspace-a', workspaceRoot: root, conversationId: 'group-parallel', content: '并行执行测试',
      onExecutionEvent: event => {
        if (event.status === 'running_cli' && event.agentId !== 'codex') workerStarts.push(Date.now());
      },
    });

    assert.equal(workerStarts.length, 2);
    assert.ok(Math.abs(workerStarts[0]! - workerStarts[1]!) < 250, `workers started ${Math.abs(workerStarts[0]! - workerStarts[1]!)}ms apart`);
    assert.deepEqual(result.executions.map(execution => execution.agentId), ['codex', 'kimi', 'opencode', 'codex']);
  } finally {
    if (originalForceMock === undefined) delete process.env.AGENTOS_FORCE_MOCK;
    else process.env.AGENTOS_FORCE_MOCK = originalForceMock;
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('fails a group explicitly when an agent requests user input', async () => {
  const root = createProjectRoot({
    codex: { cliCommand: process.execPath, cliArgs: ['-e', "console.log('<!-- agentos-waiting-user: {\\\"question\\\":\\\"请提供群聊信息\\\"} -->')"] },
    kimi: { cliCommand: process.execPath, cliArgs: ['-e', "console.log('worker')"] },
  });
  const originalForceMock = process.env.AGENTOS_FORCE_MOCK;
  let store: SqliteStore | undefined;
  try {
    process.env.AGENTOS_FORCE_MOCK = 'false';
    store = new SqliteStore(root);
    store.updateAgentProfile('workspace-a', 'codex', { roleTitle: '群主', systemPrompt: '完成任务。', permissions: ['read', 'write'], enabled: true });
    store.createGroupConversation({ id: 'group-waiting', workspaceId: 'workspace-a', type: 'group', title: '等待测试', createdAt: '2026-07-12T01:00:00.000Z', updatedAt: '2026-07-12T01:00:00.000Z' }, [
      { conversationId: 'group-waiting', agentId: 'codex', roleTitle: '群主', isLeader: true, createdAt: '2026-07-12T01:00:00.000Z' },
      { conversationId: 'group-waiting', agentId: 'kimi', roleTitle: '执行工程师', isLeader: false, createdAt: '2026-07-12T01:00:00.000Z' },
    ]);
    const observedRunStatuses: string[] = [];
    await assert.rejects(new ConversationService(store).sendGroupMessage({
      workspaceId: 'workspace-a', workspaceRoot: root, conversationId: 'group-waiting', content: '需要补充信息',
      onExecutionEvent: event => {
        if (event.status === 'waiting_user') observedRunStatuses.push(store!.listRuns('workspace-a', 'group-waiting')[0]?.status ?? 'missing');
      },
    }), /群聊暂不支持等待用户恢复/);
    assert.deepEqual(observedRunStatuses, ['failed']);
    const run = store.listRuns('workspace-a', 'group-waiting')[0];
    assert.equal(run?.status, 'failed');
    assert.equal(run?.failureReason, '群聊暂不支持等待用户恢复');
  } finally {
    if (originalForceMock === undefined) delete process.env.AGENTOS_FORCE_MOCK;
    else process.env.AGENTOS_FORCE_MOCK = originalForceMock;
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('applies learned preference context and keeps learning failures out of Run success', async () => {
  const root = createProjectRoot();
  const originalForceMock = process.env.AGENTOS_FORCE_MOCK;
  let store: SqliteStore | undefined;
  try {
    process.env.AGENTOS_FORCE_MOCK = 'true';
    store = new SqliteStore(root);
    store.createConversation({ id: 'preference-direct', workspaceId: 'workspace-a', type: 'direct', title: 'Preference', agentId: 'codex', createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-17T00:00:00.000Z' });
    const preferenceService = {
      resolved: [] as Array<{ objective: string; conversationType?: string }>,
      applications: [] as unknown[],
      observed: [] as unknown[],
      resolveForRun(input: { objective: string; conversationType?: string }) {
        this.resolved.push(input);
        return {
          contextKind: 'coding' as const,
          text: 'PREFERENCE_MARKER',
          applications: [{ runId: 'filled-by-test', projectionId: 'projection-a', resolvedValue: 'concise', rank: 1, injectedCharacters: 16, appliedAt: '2026-07-17T00:00:00.000Z' }],
        };
      },
      recordApplications(applications: unknown[]) { this.applications.push(...applications); },
      recordRunEvidence(input: unknown) { this.observed.push(input); return Promise.reject(new Error('learning unavailable')); },
    };
    const result = await new ConversationService(store, undefined, undefined, preferenceService).sendDirectMessage({
      workspaceId: 'workspace-a', workspaceRoot: root, conversationId: 'preference-direct', agentId: 'codex', content: '实现设置页面',
    });
    assert.equal(result.responseMessage.senderType, 'agent');
    assert.equal(preferenceService.resolved[0]?.conversationType, 'direct');
    assert.equal(preferenceService.applications.length, 1);
    assert.equal(preferenceService.observed.length, 1);
    assert.equal(store.getRun('workspace-a', result.execution.runId)?.status, 'completed');
  } finally {
    if (originalForceMock === undefined) delete process.env.AGENTOS_FORCE_MOCK;
    else process.env.AGENTOS_FORCE_MOCK = originalForceMock;
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
