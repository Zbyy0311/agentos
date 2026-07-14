import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentPermission,
  AgentEvent,
  AgentProfile,
  AgentRun,
  AgentExecution,
  RunCliInvocation,
  RunFileChange,
  MemoryRecord,
  MemoryStatus,
  MemoryType,
  MemoryUsage,
  MemoryCandidate,
  MemoryCandidateStatus,
  Conversation,
  ConversationMember,
  ConversationMessage,
  ExecutionEvent,
  TaskItem,
  ThinkingEffort,
  Workspace,
} from '@agentos/shared';
import { JsonFileStore } from './JsonFileStore.js';
import type { Store } from './Store.js';
import type { StoredConversationAttachment } from '../services/ConversationAttachmentService.js';

type SqliteStatement = {
  all(...parameters: unknown[]): unknown[];
  get(...parameters: unknown[]): unknown;
  run(...parameters: unknown[]): unknown;
};

type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
};

type DatabaseSyncConstructor = new (path: string) => SqliteDatabase;

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: DatabaseSyncConstructor };

interface AgentProfileRow {
  workspace_id: string;
  id: string;
  name: string;
  agent_role: AgentProfile['role'];
  role_title: string;
  system_prompt: string;
  permissions_json: string;
  enabled: number;
  cli_command: string;
  cli_args_json: string;
  model: string | null;
  thinking_effort: string | null;
  created_at: string;
  updated_at: string;
}

interface ConversationRow {
  id: string;
  workspace_id: string;
  conversation_type: Conversation['type'];
  title: string;
  agent_id: string | null;
  model: string | null;
  thinking_effort: string | null;
  created_at: string;
  updated_at: string;
}

interface ConversationMemberRow {
  conversation_id: string;
  agent_id: string;
  role_title: string;
  is_leader: number;
  created_at: string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  workspace_id: string;
  sender_type: ConversationMessage['senderType'];
  sender_agent_id: string | null;
  content: string;
  created_at: string;
}

interface MessageAttachmentRow {
  id: string;
  message_id: string;
  conversation_id: string;
  workspace_id: string;
  name: string;
  mime_type: string;
  size: number;
  relative_path: string;
}

interface ExecutionRow {
  id: string;
  run_id: string;
  conversation_id: string;
  workspace_id: string;
  source_message_id: string;
  agent_id: string;
  status: AgentExecution['status'];
  mode: AgentExecution['mode'];
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface AgentRunRow {
  id: string;
  workspace_id: string;
  conversation_id: string;
  source_message_id: string;
  objective: string;
  status: AgentRun['status'];
  result_summary: string | null;
  failure_reason: string | null;
  started_at: string | null;
  completed_at: string | null;
  waiting_question: string | null;
  waiting_execution_id: string | null;
  waiting_agent_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ExecutionEventRow {
  id: string;
  execution_id: string;
  status: ExecutionEvent['status'];
  activity: string;
  content: string | null;
  created_at: string;
}

interface AgentEventRow {
  event_id: string;
  schema_version: 1;
  event_type: AgentEvent['type'];
  workspace_id: string;
  conversation_id: string;
  run_id: string;
  execution_id: string | null;
  agent_id: string | null;
  timestamp: string;
  payload_json: string;
}

interface RunCliInvocationRow {
  id: string;
  run_id: string;
  execution_id: string;
  agent_id: string;
  cli_kind: string;
  command_label: string;
  model: string | null;
  thinking_effort: string | null;
  exit_code: number | null;
  duration_ms: number;
  started_at: string;
  completed_at: string;
}

interface RunFileChangeRow {
  run_id: string;
  path: string;
  change_type: RunFileChange['changeType'];
}

interface MemoryRow {
  id: string;
  workspace_id: string;
  memory_type: MemoryType;
  status: MemoryStatus;
  title: string;
  summary: string;
  content_path: string;
  tags_json: string;
  related_files_json: string;
  importance: number;
  confidence: number;
  created_at: string;
  updated_at: string;
  last_accessed_at: string | null;
}

export interface MemorySearchResult {
  memory: MemoryRecord;
  ftsRank: number | null;
}

interface MemoryCandidateRow {
  id: string;
  workspace_id: string;
  run_id: string;
  memory_type: MemoryCandidate['type'];
  title: string;
  summary: string;
  content: string;
  confidence: number;
  operation: MemoryCandidate['operation'];
  conflicting_memory_ids_json: string;
  status: MemoryCandidateStatus;
  created_at: string;
  reviewed_at: string | null;
}

export class SqliteStore implements Store {
  private readonly legacy: JsonFileStore;
  private readonly database: SqliteDatabase;

  constructor(projectRoot: string) {
    this.legacy = new JsonFileStore(projectRoot);
    const dataDir = join(projectRoot, '.agentos');
    mkdirSync(dataDir, { recursive: true });
    this.database = new DatabaseSync(join(dataDir, 'agentos.sqlite'));
    this.database.exec('PRAGMA foreign_keys = ON');
    this.migrateSchema();
    this.migrateLegacyKimiWorkspaceConfigs();
    this.migrateLegacyAgentProfiles();
  }

  loadWorkspaces(): Workspace[] {
    return this.legacy.loadWorkspaces();
  }

  saveWorkspaces(workspaces: Workspace[]): void {
    const nextWorkspaces = structuredClone(workspaces);
    migrateLegacyKimiAgents(nextWorkspaces);
    this.legacy.saveWorkspaces(nextWorkspaces);
    this.migrateLegacyAgentProfiles();
  }

  loadTasks(workspaceId: string): TaskItem[] {
    return this.legacy.loadTasks(workspaceId);
  }

  saveTasks(workspaceId: string, tasks: TaskItem[]): void {
    this.legacy.saveTasks(workspaceId, tasks);
  }

  deleteWorkspace(workspaceId: string): void {
    this.database.exec('BEGIN');
    try {
      this.database.prepare('DELETE FROM agent_events WHERE workspace_id = ?').run(workspaceId);
      this.database.prepare('DELETE FROM memory_fts WHERE memory_id IN (SELECT id FROM memories WHERE workspace_id = ?)').run(workspaceId);
      this.database.prepare('DELETE FROM memories WHERE workspace_id = ?').run(workspaceId);
      this.database.prepare(`
        DELETE FROM execution_events
        WHERE execution_id IN (SELECT id FROM executions WHERE workspace_id = ?)
      `).run(workspaceId);
      this.database.prepare('DELETE FROM executions WHERE workspace_id = ?').run(workspaceId);
      this.database.prepare('DELETE FROM agent_runs WHERE workspace_id = ?').run(workspaceId);
      this.database.prepare('DELETE FROM messages WHERE workspace_id = ?').run(workspaceId);
      this.database.prepare(`
        DELETE FROM conversation_members
        WHERE conversation_id IN (SELECT id FROM conversations WHERE workspace_id = ?)
      `).run(workspaceId);
      this.database.prepare('DELETE FROM conversations WHERE workspace_id = ?').run(workspaceId);
      this.database.prepare('DELETE FROM agent_profiles WHERE workspace_id = ?').run(workspaceId);
      this.database.exec('COMMIT');
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  listAgentProfiles(workspaceId: string): AgentProfile[] {
    const rows = this.database.prepare(`
      SELECT workspace_id, id, name, agent_role, role_title, system_prompt,
        permissions_json, enabled, cli_command, cli_args_json, model, thinking_effort, created_at, updated_at
      FROM agent_profiles
      WHERE workspace_id = ?
      ORDER BY name COLLATE NOCASE
    `).all(workspaceId) as AgentProfileRow[];
    return rows.map(row => this.toAgentProfile(row));
  }

  updateAgentProfile(
    workspaceId: string,
    agentId: string,
    update: Pick<AgentProfile, 'roleTitle' | 'systemPrompt' | 'permissions' | 'enabled'> & Partial<Pick<AgentProfile, 'name' | 'model' | 'thinkingEffort'>>,
  ): AgentProfile {
    const current = this.listAgentProfiles(workspaceId).find(agent => agent.id === agentId);
    if (!current) throw new Error('Agent not found');
    const next = {
      ...current,
      ...update,
      name: update.name?.trim() || current.name,
      roleTitle: update.roleTitle.trim(),
      systemPrompt: update.systemPrompt.trim(),
      updatedAt: new Date().toISOString(),
    };
    if (!next.roleTitle || !next.systemPrompt || next.permissions.length === 0) {
      throw new Error('Agent identity fields are required');
    }
    this.database.prepare(`
      UPDATE agent_profiles
      SET name = ?, role_title = ?, system_prompt = ?, permissions_json = ?, enabled = ?, model = ?, thinking_effort = ?, updated_at = ?
      WHERE workspace_id = ? AND id = ?
    `).run(
      next.name,
      next.roleTitle,
      next.systemPrompt,
      JSON.stringify(next.permissions),
      next.enabled ? 1 : 0,
      next.model ?? null,
      normalizeThinkingEffort(next.thinkingEffort),
      next.updatedAt,
      workspaceId,
      agentId,
    );
    const workspaces = this.legacy.loadWorkspaces();
    const legacyAgent = workspaces
      .find(workspace => workspace.id === workspaceId)
      ?.agents.find(agent => agent.id === agentId);
    if (legacyAgent) {
      const nextModel = next.model?.trim();
      legacyAgent.model = nextModel || undefined;
      legacyAgent.thinkingEffort = normalizeThinkingEffort(next.thinkingEffort);
      this.legacy.saveWorkspaces(workspaces);
    }
    return this.listAgentProfiles(workspaceId).find(agent => agent.id === agentId) ?? next;
  }

  createConversation(conversation: Conversation): Conversation {
    this.assertWorkspaceExists(conversation.workspaceId);
    if (conversation.type === 'direct' && !conversation.agentId) {
      throw new Error('Direct conversations require an agentId');
    }
    this.database.prepare(`
      INSERT INTO conversations (id, workspace_id, conversation_type, title, agent_id, model, thinking_effort, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      conversation.id,
      conversation.workspaceId,
      conversation.type,
      conversation.title,
      conversation.agentId ?? null,
      conversation.model ?? null,
      conversation.thinkingEffort ?? null,
      conversation.createdAt,
      conversation.updatedAt,
    );
    return conversation;
  }

  listConversations(workspaceId: string): Conversation[] {
    const rows = this.database.prepare(`
      SELECT id, workspace_id, conversation_type, title, agent_id, model, thinking_effort, created_at, updated_at
      FROM conversations
      WHERE workspace_id = ?
      ORDER BY updated_at DESC, created_at DESC
    `).all(workspaceId) as ConversationRow[];
    return rows.map(row => ({
      id: row.id,
      workspaceId: row.workspace_id,
      type: row.conversation_type,
      title: row.title,
      ...(row.agent_id ? { agentId: row.agent_id } : {}),
      ...(row.model ? { model: row.model } : {}),
      ...(row.thinking_effort ? { thinkingEffort: normalizeThinkingEffort(row.thinking_effort) } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  updateConversationTitle(workspaceId: string, conversationId: string, title: string): Conversation {
    const current = this.listConversations(workspaceId).find(conversation => conversation.id === conversationId);
    if (!current) throw new Error('Conversation not found');
    const nextTitle = title.trim();
    if (!nextTitle) throw new Error('Conversation title is required');
    const updatedAt = new Date().toISOString();
    this.database.prepare(`
      UPDATE conversations
      SET title = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ?
    `).run(nextTitle, updatedAt, conversationId, workspaceId);
    return { ...current, title: nextTitle, updatedAt };
  }

  updateConversationSettings(
    workspaceId: string,
    conversationId: string,
    settings: { model?: string | null; thinkingEffort?: ThinkingEffort | null },
  ): Conversation {
    const current = this.listConversations(workspaceId).find(conversation => conversation.id === conversationId);
    if (!current) throw new Error('Conversation not found');
    const nextModel = settings.model === undefined ? current.model : settings.model?.trim() || undefined;
    const nextThinkingEffort = settings.thinkingEffort === undefined ? current.thinkingEffort : settings.thinkingEffort ?? undefined;
    const updatedAt = new Date().toISOString();
    this.database.prepare(`
      UPDATE conversations
      SET model = ?, thinking_effort = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ?
    `).run(nextModel ?? null, nextThinkingEffort ?? null, updatedAt, conversationId, workspaceId);
    return {
      ...current,
      ...(nextModel ? { model: nextModel } : { model: undefined }),
      ...(nextThinkingEffort ? { thinkingEffort: nextThinkingEffort } : { thinkingEffort: undefined }),
      updatedAt,
    };
  }

  deleteConversation(workspaceId: string, conversationId: string): void {
    this.assertConversationWorkspace(conversationId, workspaceId);
    this.database.exec('BEGIN');
    try {
      this.database.prepare('DELETE FROM agent_events WHERE workspace_id = ? AND conversation_id = ?').run(workspaceId, conversationId);
      this.database.prepare(`
        DELETE FROM execution_events
        WHERE execution_id IN (
          SELECT id FROM executions WHERE conversation_id = ? AND workspace_id = ?
        )
      `).run(conversationId, workspaceId);
      this.database.prepare('DELETE FROM executions WHERE conversation_id = ? AND workspace_id = ?')
        .run(conversationId, workspaceId);
      this.database.prepare('DELETE FROM agent_runs WHERE conversation_id = ? AND workspace_id = ?')
        .run(conversationId, workspaceId);
      this.database.prepare('DELETE FROM messages WHERE conversation_id = ? AND workspace_id = ?')
        .run(conversationId, workspaceId);
      this.database.prepare('DELETE FROM conversation_members WHERE conversation_id = ?')
        .run(conversationId);
      this.database.prepare('DELETE FROM conversations WHERE id = ? AND workspace_id = ?')
        .run(conversationId, workspaceId);
      this.database.exec('COMMIT');
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  createGroupConversation(conversation: Conversation, members: ConversationMember[]): Conversation {
    if (conversation.type !== 'group') throw new Error('Group conversations require group type');
    if (members.length < 2) throw new Error('Group conversations require at least two members');
    if (members.filter(member => member.isLeader).length !== 1) throw new Error('Group conversations require exactly one leader');
    if (new Set(members.map(member => member.agentId)).size !== members.length) throw new Error('Group conversation members must be unique');
    const profiles = new Set(this.listAgentProfiles(conversation.workspaceId).filter(profile => profile.enabled).map(profile => profile.id));
    if (members.some(member => member.conversationId !== conversation.id || !profiles.has(member.agentId))) {
      throw new Error('Group members must be enabled agents in the workspace');
    }

    this.database.exec('BEGIN');
    try {
      this.createConversation(conversation);
      const insert = this.database.prepare(`
        INSERT INTO conversation_members (conversation_id, agent_id, role_title, is_leader, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const member of members) {
        insert.run(member.conversationId, member.agentId, member.roleTitle, member.isLeader ? 1 : 0, member.createdAt);
      }
      this.database.exec('COMMIT');
      return conversation;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  listConversationMembers(workspaceId: string, conversationId: string): ConversationMember[] {
    const rows = this.database.prepare(`
      SELECT members.conversation_id, members.agent_id, members.role_title, members.is_leader, members.created_at
      FROM conversation_members AS members
      INNER JOIN conversations ON conversations.id = members.conversation_id
      WHERE conversations.workspace_id = ? AND members.conversation_id = ?
      ORDER BY members.is_leader DESC, members.created_at ASC
    `).all(workspaceId, conversationId) as ConversationMemberRow[];
    return rows.map(row => ({
      conversationId: row.conversation_id,
      agentId: row.agent_id,
      roleTitle: row.role_title,
      isLeader: row.is_leader === 1,
      createdAt: row.created_at,
    }));
  }

  createMessage(message: ConversationMessage, attachments: StoredConversationAttachment[] = []): ConversationMessage {
    this.assertConversationWorkspace(message.conversationId, message.workspaceId);
    this.database.prepare(`
      INSERT INTO messages (id, conversation_id, workspace_id, sender_type, sender_agent_id, content, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      message.id,
      message.conversationId,
      message.workspaceId,
      message.senderType,
      message.senderAgentId ?? null,
      message.content,
      message.createdAt,
    );
    const insertAttachment = this.database.prepare(`
      INSERT INTO message_attachments (
        id, message_id, conversation_id, workspace_id, name, mime_type, size, relative_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const attachment of attachments) {
      if (attachment.messageId !== message.id || attachment.conversationId !== message.conversationId || attachment.workspaceId !== message.workspaceId) {
        throw new Error('Attachment does not belong to message');
      }
      insertAttachment.run(
        attachment.id,
        attachment.messageId,
        attachment.conversationId,
        attachment.workspaceId,
        attachment.name,
        attachment.mimeType,
        attachment.size,
        attachment.relativePath,
      );
    }
    this.database.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
      .run(message.createdAt, message.conversationId);
    return message;
  }

  listMessages(workspaceId: string, conversationId: string, limit = 50): ConversationMessage[] {
    const rows = this.database.prepare(`
      SELECT id, conversation_id, workspace_id, sender_type, sender_agent_id, content, created_at
      FROM messages
      WHERE workspace_id = ? AND conversation_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `).all(workspaceId, conversationId, limit) as MessageRow[];
    const attachmentRows = this.database.prepare(`
      SELECT id, message_id, conversation_id, workspace_id, name, mime_type, size, relative_path
      FROM message_attachments
      WHERE workspace_id = ? AND conversation_id = ?
      ORDER BY rowid ASC
    `).all(workspaceId, conversationId) as MessageAttachmentRow[];
    const attachmentsByMessage = new Map<string, MessageAttachmentRow[]>();
    for (const attachment of attachmentRows) {
      const current = attachmentsByMessage.get(attachment.message_id) ?? [];
      current.push(attachment);
      attachmentsByMessage.set(attachment.message_id, current);
    }
    return rows.reverse().map(row => ({
      id: row.id,
      conversationId: row.conversation_id,
      workspaceId: row.workspace_id,
      senderType: row.sender_type,
      ...(row.sender_agent_id ? { senderAgentId: row.sender_agent_id } : {}),
      content: row.content,
      ...(attachmentsByMessage.has(row.id) ? {
        attachments: attachmentsByMessage.get(row.id)!.map(attachment => ({
          id: attachment.id,
          name: attachment.name,
          mimeType: attachment.mime_type,
          size: attachment.size,
          url: `/api/workspaces/${workspaceId}/attachments/${attachment.id}`,
        })),
      } : {}),
      createdAt: row.created_at,
    }));
  }

  getMessage(workspaceId: string, messageId: string): ConversationMessage | undefined {
    const row = this.database.prepare(`
      SELECT conversation_id FROM messages WHERE workspace_id = ? AND id = ?
    `).get(workspaceId, messageId) as { conversation_id: string } | undefined;
    return row ? this.listMessages(workspaceId, row.conversation_id, 1000).find(message => message.id === messageId) : undefined;
  }

  getAttachment(workspaceId: string, attachmentId: string): StoredConversationAttachment | undefined {
    const row = this.database.prepare(`
      SELECT id, message_id, conversation_id, workspace_id, name, mime_type, size, relative_path
      FROM message_attachments
      WHERE workspace_id = ? AND id = ?
    `).get(workspaceId, attachmentId) as MessageAttachmentRow | undefined;
    return row ? this.toStoredAttachment(row) : undefined;
  }

  listConversationAttachments(workspaceId: string, conversationId: string): StoredConversationAttachment[] {
    const rows = this.database.prepare(`
      SELECT id, message_id, conversation_id, workspace_id, name, mime_type, size, relative_path
      FROM message_attachments
      WHERE workspace_id = ? AND conversation_id = ?
      ORDER BY rowid ASC
    `).all(workspaceId, conversationId) as MessageAttachmentRow[];
    return rows.map(row => this.toStoredAttachment(row));
  }

  createRun(run: AgentRun): AgentRun {
    this.assertConversationWorkspace(run.conversationId, run.workspaceId);
    this.assertMessageWorkspace(run.sourceMessageId, run.conversationId, run.workspaceId);
    this.database.prepare(`
      INSERT INTO agent_runs (
        id, workspace_id, conversation_id, source_message_id, objective, status,
        result_summary, failure_reason, started_at, completed_at, waiting_question,
        waiting_execution_id, waiting_agent_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.id,
      run.workspaceId,
      run.conversationId,
      run.sourceMessageId,
      run.objective,
      run.status,
      run.resultSummary ?? null,
      run.failureReason ?? null,
      run.startedAt ?? null,
      run.completedAt ?? null,
      run.waitingQuestion ?? null,
      run.waitingExecutionId ?? null,
      run.waitingAgentId ?? null,
      run.createdAt,
      run.updatedAt,
    );
    return run;
  }

  updateRun(
    workspaceId: string,
    runId: string,
    update: Partial<Pick<AgentRun, 'status' | 'resultSummary' | 'failureReason' | 'startedAt' | 'completedAt' | 'waitingQuestion' | 'waitingExecutionId' | 'waitingAgentId'>>,
  ): AgentRun {
    const current = this.getRun(workspaceId, runId);
    if (!current) throw new Error('Run not found');
    const next = {
      ...current,
      ...update,
      updatedAt: new Date().toISOString(),
    };
    this.database.prepare(`
      UPDATE agent_runs
      SET status = ?, result_summary = ?, failure_reason = ?, started_at = ?, completed_at = ?, updated_at = ?
        , waiting_question = ?, waiting_execution_id = ?, waiting_agent_id = ?
      WHERE workspace_id = ? AND id = ?
    `).run(
      next.status,
      next.resultSummary ?? null,
      next.failureReason ?? null,
      next.startedAt ?? null,
      next.completedAt ?? null,
      next.updatedAt,
      next.waitingQuestion ?? null,
      next.waitingExecutionId ?? null,
      next.waitingAgentId ?? null,
      workspaceId,
      runId,
    );
    return this.getRun(workspaceId, runId) ?? next;
  }

  getRun(workspaceId: string, runId: string): AgentRun | undefined {
    const row = this.database.prepare(`
      SELECT id, workspace_id, conversation_id, source_message_id, objective, status,
        result_summary, failure_reason, started_at, completed_at, waiting_question,
        waiting_execution_id, waiting_agent_id, created_at, updated_at
      FROM agent_runs
      WHERE workspace_id = ? AND id = ?
    `).get(workspaceId, runId) as AgentRunRow | undefined;
    return row ? this.toRun(row) : undefined;
  }

  listRuns(workspaceId: string, conversationId: string, limit = 50): AgentRun[] {
    const rows = this.database.prepare(`
      SELECT id, workspace_id, conversation_id, source_message_id, objective, status,
        result_summary, failure_reason, started_at, completed_at, waiting_question,
        waiting_execution_id, waiting_agent_id, created_at, updated_at
      FROM agent_runs
      WHERE workspace_id = ? AND conversation_id = ?
      ORDER BY updated_at DESC, created_at DESC
      LIMIT ?
    `).all(workspaceId, conversationId, limit) as AgentRunRow[];
    return rows.map(row => this.toRun(row));
  }

  listRunsForRecovery(): AgentRun[] {
    const rows = this.database.prepare(`
      SELECT id, workspace_id, conversation_id, source_message_id, objective, status,
        result_summary, failure_reason, started_at, completed_at, waiting_question,
        waiting_execution_id, waiting_agent_id, created_at, updated_at
      FROM agent_runs
      WHERE status IN ('queued', 'running')
      ORDER BY updated_at ASC
    `).all() as AgentRunRow[];
    return rows.map(row => this.toRun(row));
  }

  createExecution(execution: AgentExecution): AgentExecution {
    this.assertConversationWorkspace(execution.conversationId, execution.workspaceId);
    this.assertMessageWorkspace(execution.sourceMessageId, execution.conversationId, execution.workspaceId);
    const run = this.getRun(execution.workspaceId, execution.runId);
    if (!run || run.conversationId !== execution.conversationId) {
      throw new Error('Execution run does not belong to conversation');
    }
    this.database.prepare(`
      INSERT INTO executions (
        id, run_id, conversation_id, workspace_id, source_message_id, agent_id, status, mode, error,
        started_at, completed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      execution.id,
      execution.runId,
      execution.conversationId,
      execution.workspaceId,
      execution.sourceMessageId,
      execution.agentId,
      execution.status,
      execution.mode,
      execution.error ?? null,
      execution.startedAt ?? null,
      execution.completedAt ?? null,
      execution.createdAt,
      execution.updatedAt,
    );
    return execution;
  }

  updateExecution(
    workspaceId: string,
    executionId: string,
    update: Pick<AgentExecution, 'status' | 'updatedAt'> & Partial<Pick<AgentExecution, 'error' | 'startedAt' | 'completedAt'>>,
  ): void {
    this.database.prepare(`
      UPDATE executions
      SET status = ?, error = COALESCE(?, error), started_at = COALESCE(?, started_at),
        completed_at = COALESCE(?, completed_at), updated_at = ?
      WHERE id = ? AND workspace_id = ?
    `).run(
      update.status,
      update.error ?? null,
      update.startedAt ?? null,
      update.completedAt ?? null,
      update.updatedAt,
      executionId,
      workspaceId,
    );
  }

  listExecutions(workspaceId: string, conversationId: string): AgentExecution[] {
    const rows = this.database.prepare(`
      SELECT id, run_id, conversation_id, workspace_id, source_message_id, agent_id, status, mode, error,
        started_at, completed_at, created_at, updated_at
      FROM executions
      WHERE workspace_id = ? AND conversation_id = ?
      ORDER BY updated_at DESC, created_at DESC
    `).all(workspaceId, conversationId) as ExecutionRow[];
    return rows.map(row => this.toExecution(row));
  }

  appendExecutionEvent(event: ExecutionEvent): ExecutionEvent {
    this.database.prepare(`
      INSERT INTO execution_events (id, execution_id, status, activity, content, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.executionId,
      event.status,
      event.activity,
      event.content ?? null,
      event.createdAt,
    );
    return event;
  }

  listExecutionEvents(workspaceId: string, executionId: string): ExecutionEvent[] {
    const rows = this.database.prepare(`
      SELECT events.id, events.execution_id, events.status, events.activity, events.content, events.created_at
      FROM execution_events AS events
      INNER JOIN executions ON executions.id = events.execution_id
      WHERE executions.workspace_id = ? AND events.execution_id = ?
      ORDER BY events.created_at ASC, events.rowid ASC
    `).all(workspaceId, executionId) as ExecutionEventRow[];
    return rows.map(row => ({
      id: row.id,
      executionId: row.execution_id,
      status: row.status,
      activity: row.activity,
      ...(row.content ? { content: row.content } : {}),
      createdAt: row.created_at,
    }));
  }

  appendAgentEvent(event: AgentEvent): void {
    this.database.prepare(`
      INSERT OR IGNORE INTO agent_events (
        event_id, schema_version, event_type, workspace_id, conversation_id, run_id,
        execution_id, agent_id, timestamp, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.eventId,
      event.schemaVersion,
      event.type,
      event.workspaceId,
      event.conversationId,
      event.runId,
      event.executionId ?? null,
      event.agentId ?? null,
      event.timestamp,
      JSON.stringify(event.payload),
    );
  }

  listAgentEvents(workspaceId: string, runId: string): AgentEvent[] {
    const rows = this.database.prepare(`
      SELECT event_id, schema_version, event_type, workspace_id, conversation_id, run_id,
        execution_id, agent_id, timestamp, payload_json
      FROM agent_events
      WHERE workspace_id = ? AND run_id = ?
      ORDER BY timestamp ASC, rowid ASC
    `).all(workspaceId, runId) as AgentEventRow[];
    return rows.map(row => ({
      eventId: row.event_id,
      schemaVersion: row.schema_version,
      type: row.event_type,
      workspaceId: row.workspace_id,
      conversationId: row.conversation_id,
      runId: row.run_id,
      ...(row.execution_id ? { executionId: row.execution_id } : {}),
      ...(row.agent_id ? { agentId: row.agent_id } : {}),
      timestamp: row.timestamp,
      payload: parseJson<Record<string, unknown>>(row.payload_json, {}),
    }));
  }

  saveRunCliInvocation(invocation: RunCliInvocation): void {
    const run = this.database.prepare('SELECT id FROM agent_runs WHERE id = ?').get(invocation.runId) as { id: string } | undefined;
    const execution = this.database.prepare('SELECT id FROM executions WHERE id = ? AND run_id = ? AND agent_id = ?')
      .get(invocation.executionId, invocation.runId, invocation.agentId) as { id: string } | undefined;
    if (!run || !execution) throw new Error('Run not found for CLI invocation');
    this.database.prepare(`
      INSERT INTO run_cli_invocations (
        id, run_id, execution_id, agent_id, cli_kind, command_label, model, thinking_effort,
        exit_code, duration_ms, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        exit_code = excluded.exit_code,
        duration_ms = excluded.duration_ms,
        completed_at = excluded.completed_at,
        model = excluded.model,
        thinking_effort = excluded.thinking_effort
    `).run(
      invocation.id, invocation.runId, invocation.executionId, invocation.agentId, invocation.cliKind, invocation.commandLabel,
      invocation.model ?? null, invocation.thinkingEffort ?? null, invocation.exitCode, invocation.durationMs,
      invocation.startedAt, invocation.completedAt,
    );
  }

  listRunCliInvocations(workspaceId: string, runId: string): RunCliInvocation[] {
    const rows = this.database.prepare(`
      SELECT invocations.id, invocations.run_id, invocations.execution_id, invocations.agent_id,
        invocations.cli_kind, invocations.command_label, invocations.model, invocations.thinking_effort,
        invocations.exit_code, invocations.duration_ms, invocations.started_at, invocations.completed_at
      FROM run_cli_invocations AS invocations
      INNER JOIN agent_runs ON agent_runs.id = invocations.run_id
      WHERE agent_runs.workspace_id = ? AND invocations.run_id = ?
      ORDER BY invocations.started_at ASC
    `).all(workspaceId, runId) as RunCliInvocationRow[];
    return rows.map(row => ({
      id: row.id, runId: row.run_id, executionId: row.execution_id, agentId: row.agent_id,
      cliKind: row.cli_kind, commandLabel: row.command_label,
      ...(row.model ? { model: row.model } : {}),
      ...(row.thinking_effort ? { thinkingEffort: normalizeThinkingEffort(row.thinking_effort) } : {}),
      exitCode: row.exit_code, durationMs: row.duration_ms, startedAt: row.started_at, completedAt: row.completed_at,
    }));
  }

  createRunFileChange(change: RunFileChange): void {
    const run = this.database.prepare('SELECT id FROM agent_runs WHERE id = ?').get(change.runId) as { id: string } | undefined;
    if (!run) throw new Error('Run not found for file change');
    this.database.prepare(`
      INSERT OR IGNORE INTO run_file_changes (run_id, path, change_type)
      VALUES (?, ?, ?)
    `).run(change.runId, change.path, change.changeType);
  }

  listRunFileChanges(workspaceId: string, runId: string): RunFileChange[] {
    const rows = this.database.prepare(`
      SELECT changes.run_id, changes.path, changes.change_type
      FROM run_file_changes AS changes
      INNER JOIN agent_runs ON agent_runs.id = changes.run_id
      WHERE agent_runs.workspace_id = ? AND changes.run_id = ?
      ORDER BY changes.path ASC
    `).all(workspaceId, runId) as RunFileChangeRow[];
    return rows.map(row => ({ runId: row.run_id, path: row.path, changeType: row.change_type }));
  }

  createMemory(memory: MemoryRecord, content: string): MemoryRecord {
    this.assertWorkspaceExists(memory.workspaceId);
    this.database.prepare(`
      INSERT INTO memories (
        id, workspace_id, memory_type, status, title, summary, content_path, tags_json,
        related_files_json, importance, confidence, created_at, updated_at, last_accessed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      memory.id, memory.workspaceId, memory.type, memory.status, memory.title, memory.summary, memory.contentPath,
      JSON.stringify(memory.tags), JSON.stringify(memory.relatedFiles), memory.importance, memory.confidence,
      memory.createdAt, memory.updatedAt, memory.lastAccessedAt ?? null,
    );
    this.replaceMemorySources(memory);
    this.replaceMemoryFts(memory, content);
    return memory;
  }

  deleteMemory(workspaceId: string, memoryId: string): void {
    this.database.prepare('DELETE FROM memory_fts WHERE memory_id = ?').run(memoryId);
    this.database.prepare('DELETE FROM memories WHERE workspace_id = ? AND id = ?').run(workspaceId, memoryId);
  }

  updateMemory(workspaceId: string, memoryId: string, update: Partial<Pick<MemoryRecord, 'type' | 'status' | 'title' | 'summary' | 'contentPath' | 'tags' | 'relatedFiles' | 'sourceRunIds' | 'importance' | 'confidence' | 'lastAccessedAt'>>, content?: string): MemoryRecord {
    const current = this.getMemory(workspaceId, memoryId);
    if (!current) throw new Error('Memory not found');
    const next = { ...current, ...update, updatedAt: new Date().toISOString() };
    this.database.prepare(`
      UPDATE memories
      SET memory_type = ?, status = ?, title = ?, summary = ?, content_path = ?, tags_json = ?,
        related_files_json = ?, importance = ?, confidence = ?, updated_at = ?, last_accessed_at = ?
      WHERE workspace_id = ? AND id = ?
    `).run(
      next.type, next.status, next.title, next.summary, next.contentPath, JSON.stringify(next.tags), JSON.stringify(next.relatedFiles),
      next.importance, next.confidence, next.updatedAt, next.lastAccessedAt ?? null, workspaceId, memoryId,
    );
    this.replaceMemorySources(next);
    if (content !== undefined) this.replaceMemoryFts(next, content);
    return next;
  }

  getMemory(workspaceId: string, memoryId: string): MemoryRecord | undefined {
    const row = this.database.prepare(`
      SELECT id, workspace_id, memory_type, status, title, summary, content_path, tags_json,
        related_files_json, importance, confidence, created_at, updated_at, last_accessed_at
      FROM memories WHERE workspace_id = ? AND id = ?
    `).get(workspaceId, memoryId) as MemoryRow | undefined;
    if (!row) return undefined;
    const sourceRows = this.database.prepare('SELECT run_id FROM memory_sources WHERE memory_id = ? ORDER BY run_id').all(memoryId) as Array<{ run_id: string }>;
    return this.toMemory(row, sourceRows.map(source => source.run_id));
  }

  listMemories(workspaceId: string, filter: { query?: string; type?: MemoryType; status?: MemoryStatus | 'all'; limit?: number } = {}): MemoryRecord[] {
    const status = filter.status ?? 'active';
    const limit = Math.min(100, Math.max(1, filter.limit ?? 50));
    const params: unknown[] = [workspaceId];
    const conditions = ['memories.workspace_id = ?'];
    if (status !== 'all') { conditions.push('memories.status = ?'); params.push(status); }
    if (filter.type) { conditions.push('memories.memory_type = ?'); params.push(filter.type); }
    const query = filter.query?.trim();
    let sql = `
      SELECT memories.id, memories.workspace_id, memories.memory_type, memories.status, memories.title, memories.summary,
        memories.content_path, memories.tags_json, memories.related_files_json, memories.importance, memories.confidence,
        memories.created_at, memories.updated_at, memories.last_accessed_at
      FROM memories
      WHERE ${conditions.join(' AND ')}
    `;
    if (query) {
      sql += ' AND (memories.title LIKE ? OR memories.summary LIKE ? OR memories.id IN (SELECT memory_id FROM memory_fts WHERE memory_fts MATCH ?) OR memories.id IN (SELECT memory_id FROM memory_fts WHERE content LIKE ? OR tags LIKE ?))';
      const likeQuery = `%${query}%`;
      params.push(likeQuery, likeQuery, toFtsQuery(query), likeQuery, likeQuery);
    }
    sql += ' ORDER BY memories.updated_at DESC LIMIT ?';
    params.push(limit);
    const rows = this.database.prepare(sql).all(...params) as MemoryRow[];
    return rows.map(row => {
      const sourceRows = this.database.prepare('SELECT run_id FROM memory_sources WHERE memory_id = ? ORDER BY run_id').all(row.id) as Array<{ run_id: string }>;
      return this.toMemory(row, sourceRows.map(source => source.run_id));
    });
  }

  searchMemories(workspaceId: string, filter: { query?: string; type?: MemoryType; status?: MemoryStatus | 'all'; limit?: number } = {}): MemorySearchResult[] {
    const query = filter.query?.trim();
    const records = this.listMemories(workspaceId, filter);
    if (!query || records.length === 0) return records.map(memory => ({ memory, ftsRank: null }));

    let rankedRows: Array<{ memory_id: string; fts_rank: number }>;
    try {
      rankedRows = this.database.prepare(`
        SELECT memory_fts.memory_id, bm25(memory_fts) AS fts_rank
        FROM memory_fts
        INNER JOIN memories ON memories.id = memory_fts.memory_id
        WHERE memories.workspace_id = ?
          AND (? = 'all' OR memories.status = ?)
          AND (? IS NULL OR memories.memory_type = ?)
          AND memory_fts MATCH ?
        ORDER BY fts_rank ASC
      `).all(
        workspaceId,
        filter.status ?? 'active', filter.status ?? 'active',
        filter.type ?? null, filter.type ?? null,
        toFtsQuery(query),
      ) as Array<{ memory_id: string; fts_rank: number }>;
    } catch {
      rankedRows = [];
    }
    const ranks = new Map(rankedRows.map(row => [row.memory_id, row.fts_rank]));
    return records.map(memory => ({ memory, ftsRank: ranks.get(memory.id) ?? null }));
  }

  private replaceMemorySources(memory: MemoryRecord): void {
    this.database.prepare('DELETE FROM memory_sources WHERE memory_id = ?').run(memory.id);
    const insert = this.database.prepare('INSERT OR IGNORE INTO memory_sources (memory_id, run_id) VALUES (?, ?)');
    for (const runId of memory.sourceRunIds) insert.run(memory.id, runId);
  }

  private replaceMemoryFts(memory: MemoryRecord, content: string): void {
    this.database.prepare('DELETE FROM memory_fts WHERE memory_id = ?').run(memory.id);
    this.database.prepare('INSERT INTO memory_fts (memory_id, title, summary, content, tags) VALUES (?, ?, ?, ?, ?)')
      .run(memory.id, memory.title, memory.summary, content, memory.tags.join(' '));
  }

  createMemoryUsage(usage: MemoryUsage): void {
    this.database.prepare(`
      INSERT OR IGNORE INTO run_memory_usage (run_id, memory_id, rank, injected_characters, used_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(usage.runId, usage.memoryId, usage.rank, usage.injectedCharacters, usage.usedAt);
  }

  listMemoryUsage(workspaceId: string, runId: string): MemoryUsage[] {
    const rows = this.database.prepare(`
      SELECT usage.run_id, usage.memory_id, usage.rank, usage.injected_characters, usage.used_at
      FROM run_memory_usage AS usage
      INNER JOIN agent_runs ON agent_runs.id = usage.run_id
      WHERE agent_runs.workspace_id = ? AND usage.run_id = ?
      ORDER BY usage.rank ASC
    `).all(workspaceId, runId) as Array<{ run_id: string; memory_id: string; rank: number; injected_characters: number; used_at: string }>;
    return rows.map(row => ({ runId: row.run_id, memoryId: row.memory_id, rank: row.rank, injectedCharacters: row.injected_characters, usedAt: row.used_at }));
  }

  createMemoryCandidate(candidate: MemoryCandidate): MemoryCandidate {
    const run = this.getRun(candidate.workspaceId, candidate.runId);
    if (!run) throw new Error('Run not found for memory candidate');
    this.database.prepare(`
      INSERT INTO memory_candidates (
        id, workspace_id, run_id, memory_type, title, summary, content, confidence,
        operation, conflicting_memory_ids_json, status, created_at, reviewed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      candidate.id, candidate.workspaceId, candidate.runId, candidate.type, candidate.title, candidate.summary,
      candidate.content, candidate.confidence, candidate.operation, JSON.stringify(candidate.conflictingMemoryIds),
      candidate.status, candidate.createdAt, candidate.reviewedAt ?? null,
    );
    return candidate;
  }

  getMemoryCandidate(workspaceId: string, candidateId: string): MemoryCandidate | undefined {
    const row = this.database.prepare(`
      SELECT id, workspace_id, run_id, memory_type, title, summary, content, confidence,
        operation, conflicting_memory_ids_json, status, created_at, reviewed_at
      FROM memory_candidates WHERE workspace_id = ? AND id = ?
    `).get(workspaceId, candidateId) as MemoryCandidateRow | undefined;
    return row ? this.toMemoryCandidate(row) : undefined;
  }

  listMemoryCandidates(workspaceId: string, status: MemoryCandidateStatus | 'all' = 'pending', limit = 100): MemoryCandidate[] {
    const normalizedLimit = Math.min(100, Math.max(1, limit));
    const params: unknown[] = [workspaceId];
    const statusClause = status === 'all' ? '' : ' AND status = ?';
    if (status !== 'all') params.push(status);
    params.push(normalizedLimit);
    const rows = this.database.prepare(`
      SELECT id, workspace_id, run_id, memory_type, title, summary, content, confidence,
        operation, conflicting_memory_ids_json, status, created_at, reviewed_at
      FROM memory_candidates
      WHERE workspace_id = ?${statusClause}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...params) as MemoryCandidateRow[];
    return rows.map(row => this.toMemoryCandidate(row));
  }

  updateMemoryCandidateStatus(workspaceId: string, candidateId: string, status: MemoryCandidateStatus, reviewedAt = new Date().toISOString()): MemoryCandidate {
    const current = this.getMemoryCandidate(workspaceId, candidateId);
    if (!current) throw new Error('Memory candidate not found');
    if (current.status !== 'pending') throw new Error('Memory candidate has already been reviewed');
    this.database.prepare('UPDATE memory_candidates SET status = ?, reviewed_at = ? WHERE workspace_id = ? AND id = ?')
      .run(status, reviewedAt, workspaceId, candidateId);
    return this.getMemoryCandidate(workspaceId, candidateId) ?? { ...current, status, reviewedAt };
  }

  close(): void {
    this.database.close();
  }

  private migrateSchema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS agent_profiles (
        workspace_id TEXT NOT NULL,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        agent_role TEXT NOT NULL,
        role_title TEXT NOT NULL,
        system_prompt TEXT NOT NULL,
        permissions_json TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        cli_command TEXT NOT NULL,
        cli_args_json TEXT NOT NULL,
        model TEXT,
        thinking_effort TEXT NOT NULL DEFAULT 'auto',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, id)
      );

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        conversation_type TEXT NOT NULL CHECK (conversation_type IN ('direct', 'group')),
        title TEXT NOT NULL,
        agent_id TEXT,
        model TEXT,
        thinking_effort TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS conversations_workspace_updated
        ON conversations (workspace_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS conversation_members (
        conversation_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        role_title TEXT NOT NULL,
        is_leader INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        PRIMARY KEY (conversation_id, agent_id),
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        sender_type TEXT NOT NULL CHECK (sender_type IN ('user', 'agent', 'system')),
        sender_agent_id TEXT,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS message_attachments (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        relative_path TEXT NOT NULL,
        FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS message_attachments_conversation
        ON message_attachments (conversation_id, id);

      CREATE INDEX IF NOT EXISTS message_attachments_workspace
        ON message_attachments (workspace_id, id);

      CREATE INDEX IF NOT EXISTS messages_conversation_created
        ON messages (conversation_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY,
        run_id TEXT,
        conversation_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        source_message_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('real', 'mock')),
        error TEXT,
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
        FOREIGN KEY (source_message_id) REFERENCES messages(id) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        source_message_id TEXT NOT NULL,
        objective TEXT NOT NULL,
        status TEXT NOT NULL,
        result_summary TEXT,
        failure_reason TEXT,
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
        FOREIGN KEY (source_message_id) REFERENCES messages(id) ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS agent_runs_conversation_updated
        ON agent_runs (conversation_id, updated_at DESC);

      CREATE INDEX IF NOT EXISTS executions_conversation_updated
        ON executions (conversation_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS execution_events (
        id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL,
        status TEXT NOT NULL,
        activity TEXT NOT NULL,
        content TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (execution_id) REFERENCES executions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS execution_events_execution_created
      ON execution_events (execution_id, created_at ASC);

      CREATE TABLE IF NOT EXISTS agent_events (
        event_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        execution_id TEXT,
        agent_id TEXT,
        timestamp TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS agent_events_workspace_run_timestamp
        ON agent_events (workspace_id, run_id, timestamp ASC);

      CREATE TABLE IF NOT EXISTS run_cli_invocations (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        cli_kind TEXT NOT NULL,
        command_label TEXT NOT NULL,
        model TEXT,
        thinking_effort TEXT,
        exit_code INTEGER,
        duration_ms INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS run_cli_invocations_run_started
        ON run_cli_invocations (run_id, started_at ASC);

      CREATE TABLE IF NOT EXISTS run_file_changes (
        run_id TEXT NOT NULL,
        path TEXT NOT NULL,
        change_type TEXT NOT NULL,
        PRIMARY KEY (run_id, path, change_type),
        FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        memory_type TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        content_path TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        related_files_json TEXT NOT NULL,
        importance INTEGER NOT NULL,
        confidence INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_accessed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS memories_workspace_updated
        ON memories (workspace_id, status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS memory_sources (
        memory_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        PRIMARY KEY (memory_id, run_id),
        FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        memory_id UNINDEXED, title, summary, content, tags
      );

      CREATE TABLE IF NOT EXISTS run_memory_usage (
        run_id TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        rank INTEGER NOT NULL,
        injected_characters INTEGER NOT NULL,
        used_at TEXT NOT NULL,
        PRIMARY KEY (run_id, memory_id),
        FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
        FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS memory_candidates (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        memory_type TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        content TEXT NOT NULL,
        confidence INTEGER NOT NULL,
        operation TEXT NOT NULL,
        conflicting_memory_ids_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        reviewed_at TEXT,
        FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS memory_candidates_workspace_status_created
        ON memory_candidates (workspace_id, status, created_at DESC);
    `);
    this.ensureColumn('agent_profiles', 'thinking_effort', "TEXT NOT NULL DEFAULT 'auto'");
    this.ensureColumn('conversations', 'model', 'TEXT');
    this.ensureColumn('conversations', 'thinking_effort', 'TEXT');
    this.ensureColumn('executions', 'run_id', 'TEXT');
    this.ensureColumn('agent_runs', 'waiting_question', 'TEXT');
    this.ensureColumn('agent_runs', 'waiting_execution_id', 'TEXT');
    this.ensureColumn('agent_runs', 'waiting_agent_id', 'TEXT');
    this.migrateLegacyExecutionRuns();
  }

  private migrateLegacyExecutionRuns(): void {
    const rows = this.database.prepare(`
      SELECT id, conversation_id, workspace_id, source_message_id, status, error, created_at, updated_at
      FROM executions
      WHERE run_id IS NULL
      ORDER BY rowid ASC
    `).all() as Array<Pick<ExecutionRow, 'id' | 'conversation_id' | 'workspace_id' | 'source_message_id' | 'status' | 'error' | 'created_at' | 'updated_at'>>;
    for (const row of rows) {
      const runId = `legacy-run-${row.id}`;
      const message = this.database.prepare('SELECT content FROM messages WHERE id = ?').get(row.source_message_id) as { content: string } | undefined;
      const status = legacyRunStatus(row.status);
      this.database.prepare(`
        INSERT OR IGNORE INTO agent_runs (
          id, workspace_id, conversation_id, source_message_id, objective, status,
          result_summary, failure_reason, started_at, completed_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        runId,
        row.workspace_id,
        row.conversation_id,
        row.source_message_id,
        message?.content || '历史执行记录',
        status,
        status === 'completed' ? '历史执行记录' : null,
        status === 'failed' ? row.error ?? '历史执行失败' : null,
        status === 'running' ? row.created_at : null,
        status === 'completed' || status === 'failed' || status === 'cancelled' ? row.updated_at : null,
        row.created_at,
        row.updated_at,
      );
      this.database.prepare('UPDATE executions SET run_id = ? WHERE id = ? AND run_id IS NULL').run(runId, row.id);
    }
  }

  private migrateLegacyAgentProfiles(): void {
    const insert = this.database.prepare(`
      INSERT OR IGNORE INTO agent_profiles (
        workspace_id, id, name, agent_role, role_title, system_prompt,
        permissions_json, enabled, cli_command, cli_args_json, model, thinking_effort, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const updateCliConfiguration = this.database.prepare(`
      UPDATE agent_profiles
      SET cli_command = ?, cli_args_json = ?,
        model = CASE WHEN ? IS NULL THEN model ELSE ? END,
        thinking_effort = CASE WHEN ? IS NULL THEN thinking_effort ELSE ? END,
        name = CASE WHEN name = 'OpenCode (Codex fallback)' THEN ? ELSE name END,
        updated_at = ?
      WHERE workspace_id = ? AND id = ?
    `);

    for (const workspace of this.legacy.loadWorkspaces()) {
      for (const agent of workspace.agents) {
        insert.run(
          workspace.id,
          agent.id,
          agent.name,
          agent.role,
          defaultRoleTitle(agent.role),
          defaultSystemPrompt(agent.role),
          JSON.stringify(defaultPermissions(agent.role)),
          agent.enabled ? 1 : 0,
          agent.cliCommand,
          JSON.stringify(agent.cliArgs),
          agent.model ?? null,
          agent.thinkingEffort ?? 'auto',
          workspace.createdAt,
          workspace.updatedAt,
        );
        updateCliConfiguration.run(
          agent.cliCommand,
          JSON.stringify(agent.cliArgs),
          agent.model ?? null,
          agent.model ?? null,
          agent.thinkingEffort ?? null,
          agent.thinkingEffort ?? null,
          agent.name,
          workspace.updatedAt,
          workspace.id,
          agent.id,
        );
      }
    }
  }

  private migrateLegacyKimiWorkspaceConfigs(): void {
    const workspaces = this.legacy.loadWorkspaces();
    if (migrateLegacyKimiAgents(workspaces)) {
      this.legacy.saveWorkspaces(workspaces);
    }
  }

  private assertWorkspaceExists(workspaceId: string): void {
    if (!this.legacy.loadWorkspaces().some(workspace => workspace.id === workspaceId)) {
      throw new Error('Workspace not found');
    }
  }

  private assertConversationWorkspace(conversationId: string, workspaceId: string): void {
    const row = this.database.prepare('SELECT id FROM conversations WHERE id = ? AND workspace_id = ?')
      .get(conversationId, workspaceId) as { id: string } | undefined;
    if (!row) throw new Error('Conversation not found in workspace');
  }

  private assertMessageWorkspace(messageId: string, conversationId: string, workspaceId: string): void {
    const row = this.database.prepare(`
      SELECT id FROM messages WHERE id = ? AND conversation_id = ? AND workspace_id = ?
    `).get(messageId, conversationId, workspaceId) as { id: string } | undefined;
    if (!row) throw new Error('Message not found in conversation');
  }

  private toAgentProfile(row: AgentProfileRow): AgentProfile {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      name: row.name,
      role: row.agent_role,
      roleTitle: row.role_title,
      systemPrompt: row.system_prompt,
      permissions: parseJson<AgentPermission[]>(row.permissions_json, []),
      enabled: row.enabled === 1,
      cliCommand: row.cli_command,
      cliArgs: parseJson<string[]>(row.cli_args_json, []),
      ...(row.model ? { model: row.model } : {}),
      thinkingEffort: normalizeThinkingEffort(row.thinking_effort),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private toStoredAttachment(row: MessageAttachmentRow): StoredConversationAttachment {
    return {
      id: row.id,
      messageId: row.message_id,
      conversationId: row.conversation_id,
      workspaceId: row.workspace_id,
      name: row.name,
      mimeType: row.mime_type,
      size: row.size,
      relativePath: row.relative_path,
    };
  }

  private toExecution(row: ExecutionRow): AgentExecution {
    return {
      id: row.id,
      runId: row.run_id,
      conversationId: row.conversation_id,
      workspaceId: row.workspace_id,
      sourceMessageId: row.source_message_id,
      agentId: row.agent_id,
      status: row.status,
      mode: row.mode,
      ...(row.error ? { error: row.error } : {}),
      ...(row.started_at ? { startedAt: row.started_at } : {}),
      ...(row.completed_at ? { completedAt: row.completed_at } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private toRun(row: AgentRunRow): AgentRun {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      conversationId: row.conversation_id,
      sourceMessageId: row.source_message_id,
      objective: row.objective,
      status: row.status,
      ...(row.result_summary ? { resultSummary: row.result_summary } : {}),
      ...(row.failure_reason ? { failureReason: row.failure_reason } : {}),
      ...(row.started_at ? { startedAt: row.started_at } : {}),
      ...(row.completed_at ? { completedAt: row.completed_at } : {}),
      ...(row.waiting_question ? { waitingQuestion: row.waiting_question } : {}),
      ...(row.waiting_execution_id ? { waitingExecutionId: row.waiting_execution_id } : {}),
      ...(row.waiting_agent_id ? { waitingAgentId: row.waiting_agent_id } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private toMemory(row: MemoryRow, sourceRunIds: string[]): MemoryRecord {
    return {
      id: row.id, workspaceId: row.workspace_id, type: row.memory_type, status: row.status, title: row.title, summary: row.summary,
      contentPath: row.content_path, tags: parseJson<string[]>(row.tags_json, []), relatedFiles: parseJson<string[]>(row.related_files_json, []),
      sourceRunIds, importance: row.importance, confidence: row.confidence, createdAt: row.created_at, updatedAt: row.updated_at,
      ...(row.last_accessed_at ? { lastAccessedAt: row.last_accessed_at } : {}),
    };
  }

  private toMemoryCandidate(row: MemoryCandidateRow): MemoryCandidate {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      runId: row.run_id,
      type: row.memory_type,
      title: row.title,
      summary: row.summary,
      content: row.content,
      confidence: row.confidence,
      operation: row.operation,
      conflictingMemoryIds: parseJson<string[]>(row.conflicting_memory_ids_json, []),
      status: row.status,
      createdAt: row.created_at,
      ...(row.reviewed_at ? { reviewedAt: row.reviewed_at } : {}),
    };
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some(item => item.name === column)) {
      this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
}

function normalizeThinkingEffort(value: string | null | undefined): ThinkingEffort {
  return value === 'low' || value === 'medium' || value === 'high' ? value : 'auto';
}

function legacyRunStatus(status: AgentExecution['status']): AgentRun['status'] {
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'queued') return 'queued';
  return 'running';
}

function migrateLegacyKimiAgents(workspaces: Workspace[]): boolean {
  let changed = false;
  for (const workspace of workspaces) {
    for (const agent of workspace.agents) {
      if (agent.id !== 'kimi' || agent.role !== 'kimi' || agent.cliCommand !== 'opencode') continue;
      agent.cliCommand = 'kimi';
      agent.cliArgs = ['-m', 'kimi-code/kimi-for-coding', '-p'];
      changed = true;
    }
  }
  return changed;
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function toFtsQuery(query: string): string {
  return query.split(/\s+/).filter(Boolean).map(token => `"${token.replaceAll('"', '""')}"`).join(' AND ');
}

function defaultRoleTitle(role: AgentProfile['role']): string {
  switch (role) {
    case 'codex': return '首席架构师';
    case 'kimi': return '高级开发工程师';
    case 'opencode': return '代码审查工程师';
    case 'mimo': return '视觉分析工程师';
  }
}

function defaultSystemPrompt(role: AgentProfile['role']): string {
  switch (role) {
    case 'codex': return '负责分析需求、制定方案和完成最终决策。';
    case 'kimi': return '负责实现、调试和验证已明确的开发任务。';
    case 'opencode': return '负责审查正确性、安全性、性能和风格，不直接修改代码。';
    case 'mimo': return '负责分析图像与多模态输入，并输出可追溯结论。';
  }
}

function defaultPermissions(role: AgentProfile['role']): AgentPermission[] {
  switch (role) {
    case 'codex': return ['read', 'review'];
    case 'kimi': return ['read', 'write'];
    case 'opencode': return ['read', 'review'];
    case 'mimo': return ['read'];
  }
}
