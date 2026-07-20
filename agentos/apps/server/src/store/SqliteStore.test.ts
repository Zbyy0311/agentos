import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { SqliteStore } from './SqliteStore.js';
import { EventBus } from '../events/EventBus.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import type { PreferenceEvidence, PreferenceProjection, TaskItem } from '@agentos/shared';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => { exec(sql: string): void; prepare(sql: string): { get(...parameters: unknown[]): unknown }; close(): void } };

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

function makeTask(id: string): TaskItem {
  return {
    id,
    workspaceId: 'workspace-a',
    title: id,
    status: 'pending',
    currentAgent: null,
    outputs: [],
    reviewDecision: 'unknown',
    reviewBlocked: false,
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
  };
}

test('saveTask preserves peer tasks through the default SQLite store path', () => {
  const root = createProjectRoot();
  let store: SqliteStore | undefined;
  try {
    store = new SqliteStore(root);
    store.saveTasks('workspace-a', [makeTask('task-a')]);
    const stale = store.loadTasks('workspace-a');

    store.saveTask('workspace-a', makeTask('task-b'));
    stale[0].status = 'running';
    store.saveTask('workspace-a', stale[0]);

    assert.deepEqual(
      store.loadTasks('workspace-a').map(task => `${task.id}:${task.status}`).sort(),
      ['task-a:running', 'task-b:pending'],
    );
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('migrates legacy workspace agents into SQLite exactly once', () => {
  const root = createProjectRoot();
  try {
    const first = new SqliteStore(root);
    assert.deepEqual(first.listAgentProfiles('workspace-a').map(agent => agent.id), ['codex']);
    first.close();

    const second = new SqliteStore(root);
    assert.deepEqual(second.listAgentProfiles('workspace-a').map(agent => agent.id), ['codex']);
    assert.deepEqual(second.listAgentProfiles('workspace-b').map(agent => agent.id), ['kimi']);
    assert.equal(second.listAgentProfiles('workspace-a')[0]?.provider, 'codex');
    assert.equal(second.listAgentProfiles('workspace-b')[0]?.provider, 'kimi');
    second.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('migrates a legacy role into provider without rewriting a custom command', () => {
  const root = createProjectRoot();
  let store: SqliteStore | undefined;
  try {
    const workspaces = JSON.parse(readFileSync(join(root, 'workspace', 'workspaces.json'), 'utf-8'));
    workspaces.workspaces[1].agents[0].cliCommand = 'custom-kimi.cmd';
    writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify(workspaces), 'utf-8');
    store = new SqliteStore(root);
    const profile = store.listAgentProfiles('workspace-b')[0];
    assert.equal(profile?.provider, 'kimi');
    assert.equal(profile?.cliCommand, 'custom-kimi.cmd');
  } finally {
    store?.close();
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

test('persists explicit group roles, sequence, and dispatch mode', () => {
  const root = createProjectRoot();
  let store: SqliteStore | undefined;
  try {
    const workspaces = JSON.parse(readFileSync(join(root, 'workspace', 'workspaces.json'), 'utf-8')) as { workspaces: Array<{ id: string; agents: unknown[] }> };
    workspaces.workspaces[0]!.agents.push({ id: 'kimi', name: 'KimiCode', role: 'kimi', enabled: true, cliCommand: 'kimi', cliArgs: ['-p'] });
    writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify(workspaces), 'utf-8');
    store = new SqliteStore(root);
    const now = '2026-07-18T01:00:00.000Z';
    store.createGroupConversation({ id: 'group-a', workspaceId: 'workspace-a', type: 'group', title: 'Explicit group', dispatchMode: 'mentioned_only', createdAt: now, updatedAt: now }, [
      { conversationId: 'group-a', agentId: 'codex', roleTitle: 'Router', isLeader: true, roleKind: 'leader', sequence: 20, createdAt: now },
      { conversationId: 'group-a', agentId: 'kimi', roleTitle: 'Reviewer', isLeader: false, roleKind: 'reviewer', sequence: 10, createdAt: now },
    ]);
    assert.equal(store.listConversations('workspace-a')[0]?.dispatchMode, 'mentioned_only');
    assert.deepEqual(store.listConversationMembers('workspace-a', 'group-a').map(member => ({ agentId: member.agentId, roleKind: member.roleKind, sequence: member.sequence })), [
      { agentId: 'kimi', roleKind: 'reviewer', sequence: 10 },
      { agentId: 'codex', roleKind: 'leader', sequence: 20 },
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
    activeStore.createRun({
      id: 'run-a', workspaceId: 'workspace-a', conversationId: 'conversation-a', sourceMessageId: 'message-a',
      objective: '检查项目', status: 'queued', createdAt: '2026-07-12T01:01:00.000Z', updatedAt: '2026-07-12T01:01:00.000Z',
    });
    activeStore.createExecution({
      id: 'execution-a', conversationId: 'conversation-a', workspaceId: 'workspace-a', sourceMessageId: 'message-a',
      runId: 'run-a', agentId: 'codex', status: 'queued', mode: 'mock', error: 'initial error', createdAt: '2026-07-12T01:01:00.000Z', updatedAt: '2026-07-12T01:01:00.000Z',
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

test('persists request-level runs, keeps workspace isolation, and cascades with conversations', () => {
  const root = createProjectRoot();
  let store: SqliteStore | undefined;
  try {
    store = new SqliteStore(root);
    store.createConversation({
      id: 'run-conversation-a', workspaceId: 'workspace-a', type: 'direct', title: 'Run A', agentId: 'codex',
      createdAt: '2026-07-12T05:00:00.000Z', updatedAt: '2026-07-12T05:00:00.000Z',
    });
    store.createMessage({
      id: 'run-message-a', conversationId: 'run-conversation-a', workspaceId: 'workspace-a', senderType: 'user',
      content: '运行任务', createdAt: '2026-07-12T05:00:01.000Z',
    });
    const run = store.createRun({
      id: 'run-a', workspaceId: 'workspace-a', conversationId: 'run-conversation-a', sourceMessageId: 'run-message-a',
      objective: '运行任务', status: 'queued', createdAt: '2026-07-12T05:00:01.000Z', updatedAt: '2026-07-12T05:00:01.000Z',
    });
    assert.equal(store.getRun('workspace-b', 'run-a'), undefined);
    assert.deepEqual(store.listRuns('workspace-a', 'run-conversation-a'), [run]);

    store.updateRun('workspace-a', 'run-a', { status: 'completed', resultSummary: '完成', completedAt: '2026-07-12T05:00:02.000Z' });
    store.close();
    store = new SqliteStore(root);
    assert.equal(store.getRun('workspace-a', 'run-a')?.status, 'completed');
    assert.equal(store.getRun('workspace-a', 'run-a')?.resultSummary, '完成');

    store.deleteConversation('workspace-a', 'run-conversation-a');
    assert.equal(store.getRun('workspace-a', 'run-a'), undefined);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('persists waiting-user fields across restart and allows a resumed execution source message', () => {
  const root = createProjectRoot();
  let store: SqliteStore | undefined;
  try {
    store = new SqliteStore(root);
    store.createConversation({ id: 'waiting-conversation', workspaceId: 'workspace-a', type: 'direct', title: 'Waiting', agentId: 'codex', createdAt: '2026-07-12T05:10:00.000Z', updatedAt: '2026-07-12T05:10:00.000Z' });
    store.createMessage({ id: 'waiting-source', workspaceId: 'workspace-a', conversationId: 'waiting-conversation', senderType: 'user', content: '需要环境信息', createdAt: '2026-07-12T05:10:01.000Z' });
    store.createRun({
      id: 'waiting-run', workspaceId: 'workspace-a', conversationId: 'waiting-conversation', sourceMessageId: 'waiting-source',
      objective: '需要环境信息', status: 'waiting_user', waitingQuestion: '请提供部署环境', waitingExecutionId: 'waiting-execution', waitingAgentId: 'codex',
      createdAt: '2026-07-12T05:10:01.000Z', updatedAt: '2026-07-12T05:10:02.000Z',
    });
    store.close();
    store = new SqliteStore(root);
    const persisted = store.getRun('workspace-a', 'waiting-run');
    assert.equal(persisted?.status, 'waiting_user');
    assert.equal(persisted?.waitingQuestion, '请提供部署环境');
    assert.equal(persisted?.waitingExecutionId, 'waiting-execution');
    assert.equal(persisted?.waitingAgentId, 'codex');
    assert.deepEqual(store!.listRunsForRecovery(), []);

    store!.createMessage({ id: 'waiting-resume-message', workspaceId: 'workspace-a', conversationId: 'waiting-conversation', senderType: 'user', content: '生产环境', createdAt: '2026-07-12T05:10:03.000Z' });
    assert.doesNotThrow(() => store!.createExecution({
      id: 'waiting-resume-execution', runId: 'waiting-run', conversationId: 'waiting-conversation', workspaceId: 'workspace-a', sourceMessageId: 'waiting-resume-message',
      agentId: 'codex', status: 'queued', mode: 'mock', createdAt: '2026-07-12T05:10:03.000Z', updatedAt: '2026-07-12T05:10:03.000Z',
    }));
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('migrates legacy executions without reducing historical row counts', () => {
  const root = createProjectRoot();
  let store: SqliteStore | undefined;
  try {
    mkdirSync(join(root, '.agentos'), { recursive: true });
    const database = new DatabaseSync(join(root, '.agentos', 'agentos.sqlite'));
    database.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, conversation_type TEXT NOT NULL,
        title TEXT NOT NULL, agent_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        sender_type TEXT NOT NULL, sender_agent_id TEXT, content TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE executions (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        source_message_id TEXT NOT NULL, agent_id TEXT NOT NULL, status TEXT NOT NULL,
        mode TEXT NOT NULL, error TEXT, started_at TEXT, completed_at TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE execution_events (
        id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, status TEXT NOT NULL,
        activity TEXT NOT NULL, content TEXT, created_at TEXT NOT NULL
      );
      INSERT INTO conversations VALUES ('legacy-conversation', 'workspace-a', 'direct', 'Legacy', 'codex', '2026-07-12T06:00:00.000Z', '2026-07-12T06:00:00.000Z');
      INSERT INTO messages VALUES ('legacy-message', 'legacy-conversation', 'workspace-a', 'user', NULL, '历史任务', '2026-07-12T06:00:01.000Z');
      INSERT INTO executions VALUES ('legacy-execution', 'legacy-conversation', 'workspace-a', 'legacy-message', 'codex', 'completed', 'mock', NULL, NULL, '2026-07-12T06:00:02.000Z', '2026-07-12T06:00:01.000Z', '2026-07-12T06:00:02.000Z');
      INSERT INTO execution_events VALUES ('legacy-event', 'legacy-execution', 'completed', '历史完成', NULL, '2026-07-12T06:00:02.000Z');
    `);
    const before = { workspaces: 2, agents: 1, conversations: 1, messages: 1, executions: 1, executionEvents: 1 };
    database.close();

    store = new SqliteStore(root);
    const execution = store.listExecutions('workspace-a', 'legacy-conversation')[0];
    assert.equal(execution?.runId, 'legacy-run-legacy-execution');
    assert.equal(store.getRun('workspace-a', 'legacy-run-legacy-execution')?.objective, '历史任务');
    const reopened = new DatabaseSync(join(root, '.agentos', 'agentos.sqlite'));
    const count = (table: string) => Number((reopened.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
    assert.ok(store.loadWorkspaces().length >= before.workspaces);
    assert.ok(store.listAgentProfiles('workspace-a').length >= before.agents);
    assert.ok(count('conversations') >= before.conversations);
    assert.ok(count('messages') >= before.messages);
    assert.ok(count('executions') >= before.executions);
    assert.ok(count('execution_events') >= before.executionEvents);
    reopened.close();
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('persists unified agent events and isolates them by workspace and run', () => {
  const root = createProjectRoot();
  let store: SqliteStore | undefined;
  try {
    store = new SqliteStore(root);
    store.createConversation({ id: 'event-conversation', workspaceId: 'workspace-a', type: 'direct', title: 'Events', agentId: 'codex', createdAt: '2026-07-12T07:00:00.000Z', updatedAt: '2026-07-12T07:00:00.000Z' });
    store.createMessage({ id: 'event-message', conversationId: 'event-conversation', workspaceId: 'workspace-a', senderType: 'user', content: '事件', createdAt: '2026-07-12T07:00:01.000Z' });
    store.createRun({ id: 'event-run', workspaceId: 'workspace-a', conversationId: 'event-conversation', sourceMessageId: 'event-message', objective: '事件', status: 'queued', createdAt: '2026-07-12T07:00:01.000Z', updatedAt: '2026-07-12T07:00:01.000Z' });
    store.appendAgentEvent({ eventId: 'event-1', schemaVersion: 2, type: 'run.created', workspaceId: 'workspace-a', conversationId: 'event-conversation', runId: 'event-run', timestamp: '2026-07-12T07:00:01.000Z', payload: { objective: '事件' } });
    store.appendAgentEvent({ eventId: 'event-1', schemaVersion: 2, type: 'run.created', workspaceId: 'workspace-a', conversationId: 'event-conversation', runId: 'event-run', timestamp: '2026-07-12T07:00:01.000Z', payload: { objective: '重复事件' } });
    store.close();
    store = new SqliteStore(root);
    assert.deepEqual(store.listAgentEvents('workspace-a', 'event-run').map(event => event.payload), [{ objective: '事件' }]);
    assert.deepEqual(store.listAgentEvents('workspace-b', 'event-run'), []);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('assigns monotonic sequences per run and keeps duplicate event ids idempotent', async () => {
  const root = createProjectRoot();
  let store: SqliteStore | undefined;
  try {
    store = new SqliteStore(root);
    store.createConversation({ id: 'sequence-conversation', workspaceId: 'workspace-a', type: 'direct', title: 'Sequence', agentId: 'codex', createdAt: '2026-07-12T08:00:00.000Z', updatedAt: '2026-07-12T08:00:00.000Z' });
    store.createMessage({ id: 'sequence-message', conversationId: 'sequence-conversation', workspaceId: 'workspace-a', senderType: 'user', content: 'sequence', createdAt: '2026-07-12T08:00:01.000Z' });
    for (const runId of ['sequence-run', 'parallel-run', 'other-run']) {
      store.createRun({ id: runId, workspaceId: 'workspace-a', conversationId: 'sequence-conversation', sourceMessageId: 'sequence-message', objective: runId, status: 'queued', createdAt: '2026-07-12T08:00:01.000Z', updatedAt: '2026-07-12T08:00:01.000Z' });
    }
    const first = store.appendAgentEvent({ eventId: 'sequence-a', schemaVersion: 2, type: 'run.created', workspaceId: 'workspace-a', conversationId: 'sequence-conversation', runId: 'sequence-run', timestamp: '2026-07-12T08:00:02.000Z', payload: {} });
    const second = store.appendAgentEvent({ eventId: 'sequence-b', schemaVersion: 2, type: 'run.started', workspaceId: 'workspace-a', conversationId: 'sequence-conversation', runId: 'sequence-run', timestamp: '2026-07-12T08:00:01.000Z', payload: {} });
    const duplicate = store.appendAgentEvent({ eventId: 'sequence-a', schemaVersion: 2, type: 'run.created', workspaceId: 'workspace-a', conversationId: 'sequence-conversation', runId: 'sequence-run', timestamp: '2026-07-12T08:00:02.000Z', payload: { duplicate: true } });
    assert.equal(first.event.sequence, 1);
    assert.equal(second.event.sequence, 2);
    assert.equal(duplicate.event.sequence, 1);
    assert.equal(duplicate.inserted, false);

    const bus = new EventBus(draft => store!.appendAgentEvent(draft));
    const parallel = await Promise.all(Array.from({ length: 1000 }, (_, index) => bus.publish({
      eventId: `parallel-${index}`,
      schemaVersion: 2,
      type: 'execution.diagnostic',
      workspaceId: 'workspace-a',
      conversationId: 'sequence-conversation',
      runId: 'parallel-run',
      timestamp: new Date(1_700_000_000_000 + index).toISOString(),
      payload: { index },
    })));
    assert.deepEqual(parallel.map(event => event.sequence).sort((a, b) => a - b), Array.from({ length: 1000 }, (_, index) => index + 1));
    assert.equal(store.listAgentEvents('workspace-a', 'parallel-run').length, 1000);
    assert.equal(store.appendAgentEvent({ eventId: 'other-run-event', schemaVersion: 2, type: 'run.created', workspaceId: 'workspace-a', conversationId: 'sequence-conversation', runId: 'other-run', timestamp: '2026-07-12T08:00:03.000Z', payload: {} }).event.sequence, 1);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('backfills legacy event order once without changing timestamp ordering rules for new events', () => {
  const root = createProjectRoot();
  let store: SqliteStore | undefined;
  try {
    store = new SqliteStore(root);
    store.createConversation({ id: 'migration-conversation', workspaceId: 'workspace-a', type: 'direct', title: 'Migration', agentId: 'codex', createdAt: '2026-07-12T09:00:00.000Z', updatedAt: '2026-07-12T09:00:00.000Z' });
    store.createMessage({ id: 'migration-message', conversationId: 'migration-conversation', workspaceId: 'workspace-a', senderType: 'user', content: 'migration', createdAt: '2026-07-12T09:00:01.000Z' });
    store.createRun({ id: 'migration-run', workspaceId: 'workspace-a', conversationId: 'migration-conversation', sourceMessageId: 'migration-message', objective: 'migration', status: 'queued', createdAt: '2026-07-12T09:00:01.000Z', updatedAt: '2026-07-12T09:00:01.000Z' });
    store.appendAgentEvent({ eventId: 'legacy-late', schemaVersion: 2, type: 'run.started', workspaceId: 'workspace-a', conversationId: 'migration-conversation', runId: 'migration-run', timestamp: '2026-07-12T09:00:03.000Z', payload: {} });
    store.appendAgentEvent({ eventId: 'legacy-early', schemaVersion: 2, type: 'run.created', workspaceId: 'workspace-a', conversationId: 'migration-conversation', runId: 'migration-run', timestamp: '2026-07-12T09:00:02.000Z', payload: {} });
    store.close();
    store = undefined;
    const database = new DatabaseSync(join(root, '.agentos', 'agentos.sqlite'));
    database.exec('DELETE FROM run_event_sequences; UPDATE agent_events SET sequence = NULL;');
    database.close();
    store = new SqliteStore(root);
    assert.deepEqual(store.listAgentEvents('workspace-a', 'migration-run').map(event => `${event.sequence}:${event.eventId}`), ['1:legacy-early', '2:legacy-late']);
    const databaseAfter = new DatabaseSync(join(root, '.agentos', 'agentos.sqlite'));
    const next = (databaseAfter.prepare('SELECT next_sequence FROM run_event_sequences WHERE run_id = ?').get('migration-run') as { next_sequence: number }).next_sequence;
    databaseAfter.close();
    assert.equal(next, 3);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('persists sanitized CLI invocation and deduplicated file evidence', () => {
  const root = createProjectRoot();
  let store: SqliteStore | undefined;
  try {
    store = new SqliteStore(root);
    store.createConversation({ id: 'evidence-conversation', workspaceId: 'workspace-a', type: 'direct', title: 'Evidence', agentId: 'codex', createdAt: '2026-07-12T07:10:00.000Z', updatedAt: '2026-07-12T07:10:00.000Z' });
    store.createMessage({ id: 'evidence-message', conversationId: 'evidence-conversation', workspaceId: 'workspace-a', senderType: 'user', content: '证据', createdAt: '2026-07-12T07:10:01.000Z' });
    store.createRun({ id: 'evidence-run', workspaceId: 'workspace-a', conversationId: 'evidence-conversation', sourceMessageId: 'evidence-message', objective: '证据', status: 'running', createdAt: '2026-07-12T07:10:01.000Z', updatedAt: '2026-07-12T07:10:01.000Z' });
    store.createExecution({ id: 'evidence-execution', runId: 'evidence-run', conversationId: 'evidence-conversation', workspaceId: 'workspace-a', sourceMessageId: 'evidence-message', agentId: 'codex', status: 'running_cli', mode: 'mock', createdAt: '2026-07-12T07:10:01.000Z', updatedAt: '2026-07-12T07:10:01.000Z' });
    store.saveRunCliInvocation({ id: 'invocation-a', runId: 'evidence-run', executionId: 'evidence-execution', agentId: 'codex', cliKind: 'codex', commandLabel: 'codex exec', configuredProvider: 'opencode', detectedProvider: 'codex', providerMismatch: true, model: 'gpt-5.5', thinkingEffort: 'medium', exitCode: 0, durationMs: 42, startedAt: '2026-07-12T07:10:02.000Z', completedAt: '2026-07-12T07:10:02.042Z' });
    store.createRunFileChange({ runId: 'evidence-run', path: 'src/index.ts', changeType: 'modified' });
    store.createRunFileChange({ runId: 'evidence-run', path: 'src/index.ts', changeType: 'modified' });
    assert.equal(store.listRunCliInvocations('workspace-a', 'evidence-run')[0]?.commandLabel, 'codex exec');
    const invocation = store.listRunCliInvocations('workspace-a', 'evidence-run')[0];
    assert.equal(invocation?.configuredProvider, 'opencode');
    assert.equal(invocation?.detectedProvider, 'codex');
    assert.equal(invocation?.providerMismatch, true);
    assert.deepEqual(store.listRunFileChanges('workspace-a', 'evidence-run'), [{ runId: 'evidence-run', path: 'src/index.ts', changeType: 'modified' }]);
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
    store.createRun({
      id: 'run-to-delete', workspaceId: 'workspace-a', conversationId: 'group-to-delete', sourceMessageId: 'message-to-delete',
      objective: 'Delete this message', status: 'completed', createdAt: '2026-07-12T04:02:00.000Z', updatedAt: '2026-07-12T04:02:00.000Z',
    });
    store.createExecution({
      id: 'execution-to-delete', conversationId: 'group-to-delete', workspaceId: 'workspace-a', sourceMessageId: 'message-to-delete',
      runId: 'run-to-delete', agentId: 'codex', status: 'completed', mode: 'mock', createdAt: '2026-07-12T04:02:00.000Z', updatedAt: '2026-07-12T04:02:00.000Z',
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
    store.createRun({
      id: 'run-a', workspaceId: 'workspace-a', conversationId: 'conversation-a', sourceMessageId: 'message-a',
      objective: '检查项目', status: 'queued', createdAt: '2026-07-12T03:00:01.000Z', updatedAt: '2026-07-12T03:00:01.000Z',
    });
    store.createExecution({
      id: 'execution-a', conversationId: 'conversation-a', workspaceId: 'workspace-a', sourceMessageId: 'message-a',
      runId: 'run-a', agentId: 'codex', status: 'queued', mode: 'mock', createdAt: '2026-07-12T03:00:01.000Z', updatedAt: '2026-07-12T03:00:01.000Z',
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

test('persists preference evidence, projections, applications, and scoped controls across reopen', () => {
  const root = createProjectRoot();
  let store: SqliteStore | undefined;
  try {
    store = new SqliteStore(root);
    for (const [workspaceId, suffix] of [['workspace-a', 'a'], ['workspace-b', 'b']] as const) {
      store.createConversation({
        id: `preference-conversation-${suffix}`, workspaceId, type: 'direct', title: `Preference ${suffix}`, agentId: 'codex',
        createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-17T00:00:00.000Z',
      });
      store.createMessage({
        id: `preference-message-${suffix}`, conversationId: `preference-conversation-${suffix}`, workspaceId,
        senderType: 'user', content: '偏好测试', createdAt: '2026-07-17T00:00:00.000Z',
      });
      store.createRun({
        id: `run-${suffix}`, workspaceId, conversationId: `preference-conversation-${suffix}`,
        sourceMessageId: `preference-message-${suffix}`, objective: '偏好测试', status: 'completed',
        createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-17T00:00:00.000Z',
      });
    }
    const profile = store.getDefaultUserProfile();
    const evidence: PreferenceEvidence = {
      id: 'preference-evidence-a', profileId: profile.id, workspaceId: 'workspace-a',
      conversationId: 'preference-conversation-a', runId: 'run-a', sourceEventId: 'event-a',
      dimension: 'response_detail', contextKind: 'coding', candidateValue: 'concise',
      signalType: 'direct_correction', polarity: 'positive', weight: 4,
      summary: '用户要求回答更简洁', status: 'active',
      observedAt: '2026-07-17T00:00:00.000Z', createdAt: '2026-07-17T00:00:00.000Z',
    };
    store.createPreferenceEvidence(evidence);
    store.createPreferenceEvidence({ ...evidence, id: 'preference-evidence-b', workspaceId: 'workspace-b', runId: 'run-b', sourceEventId: 'event-b' });
    const projection: PreferenceProjection = {
      id: 'preference-projection-a', profileId: profile.id, scope: 'workspace', workspaceId: 'workspace-a',
      dimension: 'response_detail', contextKind: 'coding', preferredValue: 'concise', confidence: 62,
      score: 4, evidenceCount: 1, independentRunCount: 1, status: 'observed',
      lastSupportedAt: '2026-07-17T00:00:00.000Z', lastConflictedAt: undefined,
      createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-17T00:00:00.000Z',
    };
    store.upsertPreferenceProjection(projection, [{ evidenceId: evidence.id, contribution: 4 }]);
    store.createPreferenceApplication({
      runId: 'run-a', projectionId: projection.id, resolvedValue: 'concise', rank: 1,
      injectedCharacters: 42, appliedAt: '2026-07-17T00:00:00.000Z',
    });

    assert.equal(store.listPreferenceEvidence(profile.id, 'workspace-a').length, 1);
    assert.equal(store.listPreferenceProjections(profile.id, 'workspace-a')[0]?.preferredValue, 'concise');
    assert.equal(store.listPreferenceApplications('workspace-a', 'run-a')[0]?.projectionId, projection.id);
    assert.deepEqual(store.listPreferenceProjections(profile.id, 'workspace-b'), []);

    store.close();
    store = new SqliteStore(root);
    assert.equal(store.listPreferenceEvidence(profile.id, 'workspace-a')[0]?.id, evidence.id);
    assert.equal(store.listPreferenceProjections(profile.id, 'workspace-a')[0]?.status, 'observed');
    store.clearPreferenceProjections(profile.id);
    assert.deepEqual(store.listPreferenceProjections(profile.id, 'workspace-a'), []);
    assert.equal(store.listPreferenceEvidence(profile.id, 'workspace-a').length, 1);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
