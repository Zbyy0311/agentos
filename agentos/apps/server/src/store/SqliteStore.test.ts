import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { SqliteStore } from './SqliteStore.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => { exec(sql: string): void; close(): void } };

function createProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentos-sqlite-store-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({
    workspaces: [
      {
        id: 'workspace-a',
        name: 'Workspace A',
        rootPath: 'C:\\workspace-a',
        gitEnabled: true,
        memoryEnabled: true,
        agents: [{
          id: 'codex', name: 'Codex', role: 'codex', enabled: true, cliCommand: 'codex', cliArgs: [],
        }],
        lastOpenedAt: '2026-07-12T00:00:00.000Z',
        createdAt: '2026-07-12T00:00:00.000Z',
        updatedAt: '2026-07-12T00:00:00.000Z',
      },
      {
        id: 'workspace-b',
        name: 'Workspace B',
        rootPath: 'C:\\workspace-b',
        gitEnabled: true,
        memoryEnabled: true,
        agents: [{
          id: 'kimi', name: 'KimiCode', role: 'kimi', enabled: true, cliCommand: 'kimi', cliArgs: ['-p'],
        }],
        lastOpenedAt: '2026-07-12T00:00:00.000Z',
        createdAt: '2026-07-12T00:00:00.000Z',
        updatedAt: '2026-07-12T00:00:00.000Z',
      },
    ],
  }), 'utf-8');
  return root;
}

test('migrates legacy workspace agents into SQLite exactly once', () => {
  const root = createProjectRoot();
  try {
    const first = new SqliteStore(root);
    assert.deepEqual(first.listAgentProfiles('workspace-a').map(agent => agent.id), ['codex']);
    first.close();

    const second = new SqliteStore(root);
    assert.deepEqual(second.listAgentProfiles('workspace-a').map(agent => agent.id), ['codex']);
    assert.deepEqual(second.listAgentProfiles('workspace-b').map(agent => agent.id), ['kimi']);
    second.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('migrates legacy Kimi CLI configuration in JSON and SQLite', () => {
  const root = createProjectRoot();
  let store: SqliteStore | undefined;
  try {
    const workspaces = JSON.parse(readFileSync(join(root, 'workspace', 'workspaces.json'), 'utf-8'));
    const kimi = workspaces.workspaces[1].agents[0];
    kimi.cliCommand = 'opencode';
    kimi.cliArgs = ['--pure', 'run'];
    writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify(workspaces), 'utf-8');

    store = new SqliteStore(root);

    const workspaceAgent = store.loadWorkspaces()[1].agents[0];
    assert.equal(workspaceAgent.cliCommand, 'kimi');
    assert.deepEqual(workspaceAgent.cliArgs, ['-m', 'kimi-code/kimi-for-coding', '-p']);
    const profile = store.listAgentProfiles('workspace-b')[0];
    assert.equal(profile?.cliCommand, 'kimi');
    assert.deepEqual(profile?.cliArgs, ['-m', 'kimi-code/kimi-for-coding', '-p']);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('synchronizes existing SQLite CLI configuration from workspace JSON', () => {
  const root = createProjectRoot();
  let store: SqliteStore | undefined;
  try {
    const initialWorkspaces = JSON.parse(readFileSync(join(root, 'workspace', 'workspaces.json'), 'utf-8'));
    initialWorkspaces.workspaces[0].agents[0].name = 'OpenCode (Codex fallback)';
    writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify(initialWorkspaces), 'utf-8');
    store = new SqliteStore(root);
    store.close();
    store = undefined;

    const workspaces = JSON.parse(readFileSync(join(root, 'workspace', 'workspaces.json'), 'utf-8'));
    const codex = workspaces.workspaces[0].agents[0];
    codex.name = 'OpenCode';
    codex.cliCommand = 'E:\\software\\opencode\\node_modules\\opencode-ai\\bin\\opencode.exe';
    codex.cliArgs = ['--pure', 'run', '--model', 'deepseek/deepseek-v4-flash'];
    codex.model = 'deepseek/deepseek-v4-flash';
    writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify(workspaces), 'utf-8');

    store = new SqliteStore(root);
    const profile = store.listAgentProfiles('workspace-a')[0];
    assert.equal(profile?.name, codex.name);
    assert.equal(profile?.cliCommand, codex.cliCommand);
    assert.deepEqual(profile?.cliArgs, codex.cliArgs);
    assert.equal(profile?.model, codex.model);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('updates editable agent identity fields without changing CLI configuration', () => {
  const root = createProjectRoot();
  let store: SqliteStore | undefined;
  try {
    store = new SqliteStore(root);
    const updated = store.updateAgentProfile('workspace-a', 'codex', {
      roleTitle: '技术负责人', systemPrompt: '先确认范围，再给出可验证结论。', permissions: ['read', 'write'], enabled: true,
    });

    assert.equal(updated.roleTitle, '技术负责人');
    assert.deepEqual(updated.permissions, ['read', 'write']);
    assert.equal(updated.cliCommand, 'codex');
    assert.deepEqual(updated.cliArgs, []);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('persists model and thinking effort while defaulting legacy values to auto', () => {
  const root = createProjectRoot();
  let store: SqliteStore | undefined;
  try {
    store = new SqliteStore(root);
    const initial = store.listAgentProfiles('workspace-a')[0];
    assert.equal(initial?.thinkingEffort, 'auto');

    const updated = store.updateAgentProfile('workspace-a', 'codex', {
      roleTitle: initial!.roleTitle,
      systemPrompt: initial!.systemPrompt,
      permissions: initial!.permissions,
      enabled: initial!.enabled,
      model: 'selected-model',
      thinkingEffort: 'auto',
    });
    assert.equal(updated.model, 'selected-model');
    assert.equal(updated.thinkingEffort, 'auto');
    assert.equal(store.loadWorkspaces()[0]?.agents[0]?.model, 'selected-model');
    assert.equal(store.loadWorkspaces()[0]?.agents[0]?.thinkingEffort, 'auto');
    store.close();
    store = new SqliteStore(root);

    const reloaded = store.listAgentProfiles('workspace-a')[0];
    assert.equal(reloaded?.model, 'selected-model');
    assert.equal(reloaded?.thinkingEffort, 'auto');
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('adds the thinking effort column when opening a legacy SQLite database', () => {
  const root = createProjectRoot();
  let store: SqliteStore | undefined;
  try {
    mkdirSync(join(root, '.agentos'), { recursive: true });
    const database = new DatabaseSync(join(root, '.agentos', 'agentos.sqlite'));
    database.exec(`
      CREATE TABLE agent_profiles (
        workspace_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL,
        agent_role TEXT NOT NULL, role_title TEXT NOT NULL, system_prompt TEXT NOT NULL,
        permissions_json TEXT NOT NULL, enabled INTEGER NOT NULL,
        cli_command TEXT NOT NULL, cli_args_json TEXT NOT NULL, model TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, id)
      )
    `);
    database.close();

    store = new SqliteStore(root);
    assert.equal(store.listAgentProfiles('workspace-a')[0]?.thinkingEffort, 'auto');
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('keeps conversations isolated by workspace', () => {
  const root = createProjectRoot();
  try {
    const store = new SqliteStore(root);
    store.createConversation({
      id: 'conversation-a',
      workspaceId: 'workspace-a',
      type: 'direct',
      title: 'Codex chat',
      agentId: 'codex',
      createdAt: '2026-07-12T01:00:00.000Z',
      updatedAt: '2026-07-12T01:00:00.000Z',
    });

    assert.deepEqual(store.listConversations('workspace-a').map(conversation => conversation.id), ['conversation-a']);
    assert.deepEqual(store.listConversations('workspace-b'), []);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('persists model and thinking effort independently for each conversation', () => {
  const root = createProjectRoot();
  let store: SqliteStore | undefined;
  try {
    store = new SqliteStore(root);
    store.createConversation({
      id: 'conversation-a', workspaceId: 'workspace-a', type: 'direct', title: 'Conversation A', agentId: 'codex',
      createdAt: '2026-07-12T05:00:00.000Z', updatedAt: '2026-07-12T05:00:00.000Z',
    });
    store.createConversation({
      id: 'conversation-b', workspaceId: 'workspace-a', type: 'direct', title: 'Conversation B', agentId: 'codex',
      createdAt: '2026-07-12T05:01:00.000Z', updatedAt: '2026-07-12T05:01:00.000Z',
    });

    store.updateConversationSettings('workspace-a', 'conversation-a', { model: 'model-a', thinkingEffort: 'high' });
    store.updateConversationSettings('workspace-a', 'conversation-b', { model: 'model-b', thinkingEffort: 'low' });
    store.close();
    store = new SqliteStore(root);

    assert.deepEqual(store.listConversations('workspace-a').map(conversation => ({
      id: conversation.id,
      model: conversation.model,
      thinkingEffort: conversation.thinkingEffort,
    })), [
      { id: 'conversation-b', model: 'model-b', thinkingEffort: 'low' },
      { id: 'conversation-a', model: 'model-a', thinkingEffort: 'high' },
    ]);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('adds conversation settings columns to a legacy SQLite database', () => {
  const root = createProjectRoot();
  let store: SqliteStore | undefined;
  try {
    mkdirSync(join(root, '.agentos'), { recursive: true });
    const database = new DatabaseSync(join(root, '.agentos', 'agentos.sqlite'));
    database.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        conversation_type TEXT NOT NULL,
        title TEXT NOT NULL,
        agent_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO conversations (id, workspace_id, conversation_type, title, agent_id, created_at, updated_at)
      VALUES ('legacy-conversation', 'workspace-a', 'direct', 'Legacy', 'codex', '2026-07-12T06:00:00.000Z', '2026-07-12T06:00:00.000Z');
    `);
    database.close();

    store = new SqliteStore(root);
    const updated = store.updateConversationSettings('workspace-a', 'legacy-conversation', { model: 'legacy-model', thinkingEffort: 'medium' });
    assert.equal(updated.model, 'legacy-model');
    assert.equal(updated.thinkingEffort, 'medium');
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('persists execution activity with the conversation it belongs to', () => {
  const root = createProjectRoot();
  let store: SqliteStore | undefined;
  try {
    store = new SqliteStore(root);
    const activeStore = store;
    activeStore.createConversation({
      id: 'conversation-a', workspaceId: 'workspace-a', type: 'direct', title: 'Codex chat', agentId: 'codex',
      createdAt: '2026-07-12T01:00:00.000Z', updatedAt: '2026-07-12T01:00:00.000Z',
    });
    activeStore.createMessage({
      id: 'message-a', conversationId: 'conversation-a', workspaceId: 'workspace-a', senderType: 'user',
      content: '检查项目', createdAt: '2026-07-12T01:01:00.000Z',
    });
    activeStore.createExecution({
      id: 'execution-a', conversationId: 'conversation-a', workspaceId: 'workspace-a', sourceMessageId: 'message-a',
      agentId: 'codex', status: 'queued', mode: 'mock', error: 'initial error', createdAt: '2026-07-12T01:01:00.000Z', updatedAt: '2026-07-12T01:01:00.000Z',
    });
    activeStore.appendExecutionEvent({
      id: 'event-a', executionId: 'execution-a', status: 'running_cli', activity: '正在调用 Agent CLI',
      createdAt: '2026-07-12T01:01:01.000Z',
    });
    activeStore.updateExecution('workspace-a', 'execution-a', {
      status: 'running_cli', startedAt: '2026-07-12T01:01:01.000Z', updatedAt: '2026-07-12T01:01:01.000Z',
    });
    activeStore.updateExecution('workspace-a', 'execution-a', {
      status: 'completed', completedAt: '2026-07-12T01:01:02.000Z', updatedAt: '2026-07-12T01:01:02.000Z',
    });

    assert.equal(activeStore.listMessages('workspace-a', 'conversation-a').length, 1);
    assert.equal(activeStore.listExecutions('workspace-a', 'conversation-a')[0]?.status, 'completed');
    assert.equal(activeStore.listExecutions('workspace-a', 'conversation-a')[0]?.startedAt, '2026-07-12T01:01:01.000Z');
    assert.equal(activeStore.listExecutions('workspace-a', 'conversation-a')[0]?.error, 'initial error');
    assert.deepEqual(activeStore.listExecutionEvents('workspace-a', 'execution-a').map(event => event.activity), ['正在调用 Agent CLI']);
    assert.deepEqual(activeStore.listExecutionEvents('workspace-b', 'execution-a'), []);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('creates a group conversation with exactly one leader', () => {
  const root = createProjectRoot();
  let store: SqliteStore | undefined;
  try {
    const workspaces = JSON.parse(readFileSync(join(root, 'workspace', 'workspaces.json'), 'utf-8'));
    workspaces.workspaces[0].agents.push(
      { id: 'kimi', name: 'KimiCode', role: 'kimi', enabled: true, cliCommand: 'kimi', cliArgs: ['-p'] },
    );
    writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify(workspaces), 'utf-8');
    store = new SqliteStore(root);
    const conversation = store.createGroupConversation({
      id: 'group-a', workspaceId: 'workspace-a', type: 'group', title: '开发团队',
      createdAt: '2026-07-12T02:00:00.000Z', updatedAt: '2026-07-12T02:00:00.000Z',
    }, [
      { conversationId: 'group-a', agentId: 'codex', roleTitle: '群主', isLeader: true, createdAt: '2026-07-12T02:00:00.000Z' },
      { conversationId: 'group-a', agentId: 'kimi', roleTitle: '执行工程师', isLeader: false, createdAt: '2026-07-12T02:00:00.000Z' },
    ]);

    assert.equal(conversation.type, 'group');
    assert.deepEqual(store.listConversationMembers('workspace-a', 'group-a').map(member => member.agentId), ['codex', 'kimi']);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('deletes one conversation and all dependent records without affecting another conversation', () => {
  const root = createProjectRoot();
  let store: SqliteStore | undefined;
  try {
    const workspaces = JSON.parse(readFileSync(join(root, 'workspace', 'workspaces.json'), 'utf-8'));
    workspaces.workspaces[0].agents.push(
      { id: 'kimi', name: 'KimiCode', role: 'kimi', enabled: true, cliCommand: 'kimi', cliArgs: ['-p'] },
    );
    writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify(workspaces), 'utf-8');

    store = new SqliteStore(root);
    store.createGroupConversation({
      id: 'group-to-delete', workspaceId: 'workspace-a', type: 'group', title: 'Delete me',
      createdAt: '2026-07-12T04:00:00.000Z', updatedAt: '2026-07-12T04:00:00.000Z',
    }, [
      { conversationId: 'group-to-delete', agentId: 'codex', roleTitle: 'Leader', isLeader: true, createdAt: '2026-07-12T04:00:00.000Z' },
      { conversationId: 'group-to-delete', agentId: 'kimi', roleTitle: 'Worker', isLeader: false, createdAt: '2026-07-12T04:00:00.000Z' },
    ]);
    store.createConversation({
      id: 'conversation-to-keep', workspaceId: 'workspace-a', type: 'direct', title: 'Keep me', agentId: 'codex',
      createdAt: '2026-07-12T04:01:00.000Z', updatedAt: '2026-07-12T04:01:00.000Z',
    });
    store.createMessage({
      id: 'message-to-delete', conversationId: 'group-to-delete', workspaceId: 'workspace-a', senderType: 'user',
      content: 'Delete this message', createdAt: '2026-07-12T04:02:00.000Z',
    });
    store.createExecution({
      id: 'execution-to-delete', conversationId: 'group-to-delete', workspaceId: 'workspace-a', sourceMessageId: 'message-to-delete',
      agentId: 'codex', status: 'completed', mode: 'mock', createdAt: '2026-07-12T04:02:00.000Z', updatedAt: '2026-07-12T04:02:00.000Z',
    });
    store.appendExecutionEvent({
      id: 'event-to-delete', executionId: 'execution-to-delete', status: 'completed', activity: 'Done',
      createdAt: '2026-07-12T04:02:01.000Z',
    });

    store.deleteConversation('workspace-a', 'group-to-delete');

    assert.deepEqual(store.listConversations('workspace-a').map(conversation => conversation.id), ['conversation-to-keep']);
    assert.deepEqual(store.listConversationMembers('workspace-a', 'group-to-delete'), []);
    assert.deepEqual(store.listMessages('workspace-a', 'group-to-delete'), []);
    assert.deepEqual(store.listExecutions('workspace-a', 'group-to-delete'), []);
    assert.deepEqual(store.listExecutionEvents('workspace-a', 'execution-to-delete'), []);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('removes all SQLite workspace data when the workspace is removed', () => {
  const root = createProjectRoot();
  let store: SqliteStore | undefined;
  try {
    store = new SqliteStore(root);
    const manager = new WorkspaceManager(store);
    store.createConversation({
      id: 'conversation-a', workspaceId: 'workspace-a', type: 'direct', title: 'Codex chat', agentId: 'codex',
      createdAt: '2026-07-12T03:00:00.000Z', updatedAt: '2026-07-12T03:00:00.000Z',
    });
    store.createMessage({
      id: 'message-a', conversationId: 'conversation-a', workspaceId: 'workspace-a', senderType: 'user',
      content: '检查项目', createdAt: '2026-07-12T03:00:01.000Z',
    });
    store.createExecution({
      id: 'execution-a', conversationId: 'conversation-a', workspaceId: 'workspace-a', sourceMessageId: 'message-a',
      agentId: 'codex', status: 'queued', mode: 'mock', createdAt: '2026-07-12T03:00:01.000Z', updatedAt: '2026-07-12T03:00:01.000Z',
    });
    store.appendExecutionEvent({
      id: 'event-a', executionId: 'execution-a', status: 'running_cli', activity: '正在执行',
      createdAt: '2026-07-12T03:00:02.000Z',
    });

    manager.remove('workspace-a');

    assert.equal(manager.get('workspace-a'), undefined);
    assert.deepEqual(store.listAgentProfiles('workspace-a'), []);
    assert.deepEqual(store.listConversations('workspace-a'), []);
    assert.deepEqual(store.listMessages('workspace-a', 'conversation-a'), []);
    assert.deepEqual(store.listExecutions('workspace-a', 'conversation-a'), []);
    assert.deepEqual(store.listExecutionEvents('workspace-a', 'execution-a'), []);
    assert.deepEqual(store.listAgentProfiles('workspace-b').map(agent => agent.id), ['kimi']);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('persists and hydrates message attachments across store reopen', () => {
  const root = createProjectRoot();
  let store: SqliteStore | undefined;
  try {
    store = new SqliteStore(root);
    store.createConversation({
      id: 'conversation-attachments', workspaceId: 'workspace-a', type: 'direct', title: 'Image chat', agentId: 'codex',
      createdAt: '2026-07-13T05:00:00.000Z', updatedAt: '2026-07-13T05:00:00.000Z',
    });
    store.createMessage({
      id: 'message-attachments', conversationId: 'conversation-attachments', workspaceId: 'workspace-a', senderType: 'user',
      content: '分析图片', createdAt: '2026-07-13T05:00:01.000Z',
    }, [{
      id: 'attachment-a', messageId: 'message-attachments', conversationId: 'conversation-attachments', workspaceId: 'workspace-a',
      name: 'screen.png', mimeType: 'image/png', size: 5, relativePath: '.agentos/attachments/conversation-attachments/attachment-a.png',
    }]);

    assert.deepEqual(store.listMessages('workspace-a', 'conversation-attachments')[0]?.attachments, [{
      id: 'attachment-a', name: 'screen.png', mimeType: 'image/png', size: 5,
      url: '/api/workspaces/workspace-a/attachments/attachment-a',
    }]);

    store.close();
    store = new SqliteStore(root);
    assert.equal(store.listMessages('workspace-a', 'conversation-attachments')[0]?.attachments?.[0]?.name, 'screen.png');
    store.deleteConversation('workspace-a', 'conversation-attachments');
    assert.deepEqual(store.listMessages('workspace-a', 'conversation-attachments'), []);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
