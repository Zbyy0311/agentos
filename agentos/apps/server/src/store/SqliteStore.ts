import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentPermission,
  AgentRole,
  AgentProvider,
  AgentRuntimeStatus,
  AgentEvent,
  AgentEventDraft,
  PersistEventResult,
  RunStep,
  CreateRunStepInput,
  UpdateRunStepInput,
  RunStepMutation,
  PersistRunStepMutationResult,
  RunStepStatus,
  AgentProfile,
  AgentRun,
  AgentExecution,
  RunCliInvocation,
  RunFileChange,
  PendingRunDecision,
  PartialWriteDecision,
  MemoryRecord,
  MemoryStatus,
  MemoryType,
  MemoryUsage,
  MemoryCandidate,
  MemoryCandidateStatus,
  UserProfile,
  PreferenceEvidence,
  PreferenceProjection,
  PreferenceProjectionEvidence,
  PreferenceApplication,
  RuntimeArtifact,
  Conversation,
  ConversationMember,
  LegacyConversationMember,
  CollaborationRole,
  GroupDispatchMode,
  ConversationMessage,
  ExecutionEvent,
  TaskItem,
  ThinkingEffort,
  Workspace,
} from '@agentos/shared';
import { JsonFileStore } from './JsonFileStore.js';
import type { Store } from './Store.js';
import { WorkspaceRepository } from './WorkspaceRepository.js';
import { TaskRepository } from './TaskRepository.js';
import { RunRepository } from './RunRepository.js';
import { WorkflowDefinitionRepository } from './WorkflowDefinitionRepository.js';
import { RunSnapshotRepository } from './RunSnapshotRepository.js';
import { RunStageRepository } from './RunStageRepository.js';
import { IdempotencyRepository } from './IdempotencyRepository.js';
import { ProviderConfigurationRepository } from './ProviderConfigurationRepository.js';
import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { MigrationRegistry } from '../migrations/registry.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import { inTransaction } from './Transaction.js';
import { assertVersionedMutation } from './Repository.js';
import { createEntityId } from './Identity.js';
import { DEFAULT_CAPABILITIES, DEFAULT_TIMEOUT_POLICY } from './ProviderConfigurationRepository.js';
import type { StoredConversationAttachment } from '../services/ConversationAttachmentService.js';
import { MAX_SUCCESS_EVIDENCE_PER_KEY } from '../services/PreferenceRules.js';

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
  provider: AgentProvider | null;
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
  provider_config_id: string | null;
  provider_config_provider_type: string | null;
  provider_config_executable: string | null;
  provider_config_args_template_json: string | null;
  provider_config_model: string | null;
}

export interface AgentSnapshotSourceRecord {
  workspaceId: string;
  id: string;
  name: string;
  role: AgentRole;
  roleTitle: string;
  systemPrompt: string;
  permissions: AgentPermission[];
  enabled: boolean;
  providerConfigId: string | null;
  version: number;
}

interface AgentSnapshotSourceRow {
  workspace_id: string;
  id: string;
  name: string;
  agent_role: AgentRole;
  role_title: string;
  system_prompt: string;
  permissions_json: string;
  enabled: number;
  provider_config_id: string | null;
  version: number;
}

interface ConversationRow {
  id: string;
  workspace_id: string;
  conversation_type: Conversation['type'];
  title: string;
  agent_id: string | null;
  model: string | null;
  thinking_effort: string | null;
  dispatch_mode: GroupDispatchMode | null;
  created_at: string;
  updated_at: string;
}

interface ConversationMemberRow {
  conversation_id: string;
  agent_id: string;
  role_title: string;
  is_leader: number;
  role_kind: CollaborationRole | null;
  sequence: number | null;
  created_at: string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  workspace_id: string;
  sender_type: ConversationMessage['senderType'];
  sender_agent_id: string | null;
  run_id: string | null;
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
  intent: AgentRun['intent'] | null;
  runtime_policy_json: string | null;
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
  schema_version: number;
  event_type: AgentEvent['type'];
  workspace_id: string;
  conversation_id: string;
  run_id: string;
  execution_id: string | null;
  agent_id: string | null;
  sequence: number;
  timestamp: string;
  payload_json: string;
}

interface RunStepRow {
  id: string;
  stable_step_key: string;
  workspace_id: string;
  run_id: string;
  parent_step_id: string | null;
  execution_id: string | null;
  agent_id: string | null;
  kind: RunStep['kind'];
  title: string;
  status: RunStepStatus;
  sequence: number;
  attempt: number;
  created_event_sequence: number;
  updated_event_sequence: number;
  started_at: string | null;
  completed_at: string | null;
  summary: string | null;
  created_at: string;
  updated_at: string;
}

interface RunCliInvocationRow {
  id: string;
  run_id: string;
  execution_id: string;
  agent_id: string;
  cli_kind: string;
  command_label: string;
  configured_provider: AgentProvider | null;
  detected_provider: AgentProvider | null;
  provider_mismatch: number;
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

interface RunDecisionRow {
  id: string;
  workspace_id: string;
  run_id: string;
  execution_id: string;
  kind: PendingRunDecision['kind'];
  file_changes_json: string;
  allowed_decisions_json: string;
  resolved_decision: PartialWriteDecision | null;
  created_at: string;
  resolved_at: string | null;
}

interface RuntimeArtifactRow {
  id: string;
  workspace_id: string;
  run_id: string;
  source_execution_id: string;
  agent_id: string;
  artifact_type: RuntimeArtifact['type'];
  title: string;
  summary: string | null;
  original_path: string | null;
  storage_key: string | null;
  mime_type: string | null;
  size_bytes: number;
  sha256: string | null;
  content_available: number;
  created_at: string;
}

export interface RuntimeArtifactRecord {
  artifact: RuntimeArtifact;
  storageKey: string | null;
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

interface UserProfileRow {
  id: string;
  display_name: string;
  learning_enabled: number;
  created_at: string;
  updated_at: string;
}

interface PreferenceEvidenceRow {
  id: string;
  profile_id: string;
  workspace_id: string | null;
  conversation_id: string;
  run_id: string;
  source_event_id: string;
  dimension: PreferenceEvidence['dimension'];
  context_kind: PreferenceEvidence['contextKind'];
  candidate_value: string;
  signal_type: PreferenceEvidence['signalType'];
  polarity: PreferenceEvidence['polarity'];
  weight: number;
  summary: string;
  status: PreferenceEvidence['status'];
  observed_at: string;
  created_at: string;
}

interface PreferenceProjectionRow {
  id: string;
  profile_id: string;
  scope: PreferenceProjection['scope'];
  workspace_id: string | null;
  dimension: PreferenceProjection['dimension'];
  context_kind: PreferenceProjection['contextKind'];
  preferred_value: string;
  confidence: number;
  score: number;
  evidence_count: number;
  independent_run_count: number;
  status: PreferenceProjection['status'];
  last_supported_at: string;
  last_conflicted_at: string | null;
  created_at: string;
  updated_at: string;
}

export class SqliteStore implements Store {
  readonly workspaceRepo: WorkspaceRepository;
  private readonly taskRepo: TaskRepository;
  private readonly runRepo: RunRepository;
  private readonly workflowDefinitionRepo: WorkflowDefinitionRepository;
  private readonly runSnapshotRepo: RunSnapshotRepository;
  private readonly runStageRepo: RunStageRepository;
  private readonly idempotencyRepo: IdempotencyRepository;
  private readonly providerConfigRepo: ProviderConfigurationRepository;
  private readonly legacy: JsonFileStore;
  private readonly database: SqliteDatabase;

  constructor(projectRoot: string) {
    this.legacy = new JsonFileStore(projectRoot);
    const dataDir = join(projectRoot, '.agentos');
    mkdirSync(dataDir, { recursive: true });
    this.database = new DatabaseSync(join(dataDir, 'agentos.sqlite'));
    this.workspaceRepo = new WorkspaceRepository(this.database as any);
    this.taskRepo = new TaskRepository(this.database as any);
    this.runRepo = new RunRepository(this.database as any);
    this.workflowDefinitionRepo = new WorkflowDefinitionRepository(this.database as any);
    this.runSnapshotRepo = new RunSnapshotRepository(this.database as any);
    this.runStageRepo = new RunStageRepository(this.database as any);
    this.idempotencyRepo = new IdempotencyRepository(this.database as any);
    this.providerConfigRepo = new ProviderConfigurationRepository(this.database as any);
    try {
      this.database.exec('PRAGMA foreign_keys = ON');
      this.runMigrations();
      this.migrateAgentEventSequences();
      this.migrateLegacyExecutionRuns();
      this.migrateLegacyWorkspaceAggregates();
    } catch (error) {
      try { this.database.close(); } catch { /* preserve the migration error */ }
      throw error;
    }
  }

  /** M2.4 canonical v2 Task repository (shares this store's SQLite handle). */
  taskRepository(): TaskRepository {
    return this.taskRepo;
  }

  /** M2.4 canonical v2 Run repository (shares this store's SQLite handle). */
  runRepository(): RunRepository {
    return this.runRepo;
  }

  workflowDefinitionRepository(): WorkflowDefinitionRepository {
    return this.workflowDefinitionRepo;
  }

  runSnapshotRepository(): RunSnapshotRepository {
    return this.runSnapshotRepo;
  }

  runStageRepository(): RunStageRepository {
    return this.runStageRepo;
  }

  /** M2.6 idempotency record repository (shares this store's SQLite handle). */
  idempotencyRepository(): IdempotencyRepository {
    return this.idempotencyRepo;
  }

  providerConfigurationRepository(): ProviderConfigurationRepository {
    return this.providerConfigRepo;
  }

  /** Cross-repository atomic transaction boundary for services (e.g. TaskRunService). */
  runInTransaction<T>(fn: () => T): T {
    return inTransaction(this.database as any, fn);
  }

  loadWorkspaces(): Workspace[] {
    const sqlite = this.workspaceRepo.findAll();
    const sqliteIds = new Set(sqlite.map(w => w.id));
    // Load tombstones: workspace IDs explicitly deleted from SQLite must not
    // be re-imported from JSON on restart.
    const tombstoneRows = this.database.prepare(
      "SELECT workspace_id FROM _workspace_tombstones"
    ).all() as Array<{ workspace_id: string }>;
    const tombstonedIds = new Set(tombstoneRows.map(r => r.workspace_id));
    // JSON fallback: include only entries not in SQLite and not tombstoned.
    const json = this.legacy.loadWorkspaces();
    const fallback = json.filter(ws => !sqliteIds.has(ws.id) && !tombstonedIds.has(ws.id));
    return [...sqlite, ...fallback];
  }

  saveWorkspaces(workspaces: Workspace[]): void {
    const nextWorkspaces = structuredClone(workspaces);
    inTransaction(this.database, () => {
      for (const workspace of nextWorkspaces) {
        if (this.workspaceRepo.exists(workspace.id)) {
          this.workspaceRepo.updateWithinTransaction(workspace);
        } else {
          this.workspaceRepo.insertWithinTransaction(workspace);
        }
        for (const agent of workspace.agents) {
          const existing = this.database.prepare(`
            SELECT provider_config_id FROM agent_profiles WHERE workspace_id = ? AND id = ?
          `).get(workspace.id, agent.id) as { provider_config_id: string | null } | undefined;
          const providerConfigId = existing?.provider_config_id ?? createEntityId('provider');

          if (!existing?.provider_config_id) {
            this.insertLegacyProviderConfiguration(workspace, agent, providerConfigId);
          }

          if (!existing) {
            this.insertAgentProfile(workspace, agent, providerConfigId);
          } else if (!existing.provider_config_id) {
            this.database.prepare(`
              UPDATE agent_profiles SET provider_config_id = ? WHERE workspace_id = ? AND id = ?
            `).run(providerConfigId, workspace.id, agent.id);
          }
        }
      }
    });
  }

  loadTasks(workspaceId: string): TaskItem[] {
    return this.legacy.loadTasks(workspaceId);
  }

  saveTasks(workspaceId: string, tasks: TaskItem[]): void {
    this.legacy.saveTasks(workspaceId, tasks);
  }

  saveTask(workspaceId: string, task: TaskItem): void {
    this.legacy.saveTask(workspaceId, task);
  }

  deleteWorkspace(workspaceId: string): void {
    inTransaction(this.database, () => {
      this.database.prepare('DELETE FROM agent_events WHERE workspace_id = ?').run(workspaceId);
      this.database.prepare('DELETE FROM memory_fts WHERE memory_id IN (SELECT id FROM memories WHERE workspace_id = ?)').run(workspaceId);
      this.database.prepare('DELETE FROM memories WHERE workspace_id = ?').run(workspaceId);
      this.database.prepare(`
        DELETE FROM execution_events
        WHERE execution_id IN (SELECT id FROM executions WHERE workspace_id = ?)
      `).run(workspaceId);
      this.database.prepare('DELETE FROM executions WHERE workspace_id = ?').run(workspaceId);
      this.database.prepare(`
        DELETE FROM run_event_sequences
        WHERE run_id IN (SELECT id FROM agent_runs WHERE workspace_id = ?)
      `).run(workspaceId);
      this.database.prepare('DELETE FROM agent_runs WHERE workspace_id = ?').run(workspaceId);
      this.database.prepare('DELETE FROM messages WHERE workspace_id = ?').run(workspaceId);
      this.database.prepare(`
        DELETE FROM conversation_members
        WHERE conversation_id IN (SELECT id FROM conversations WHERE workspace_id = ?)
      `).run(workspaceId);
      this.database.prepare('DELETE FROM conversations WHERE workspace_id = ?').run(workspaceId);
      this.database.prepare('DELETE FROM agent_profiles WHERE workspace_id = ?').run(workspaceId);
      this.database.prepare('DELETE FROM provider_configurations WHERE workspace_id = ?').run(workspaceId);
      this.database.prepare('DELETE FROM workspaces WHERE id = ?').run(workspaceId);
      this.database.prepare('INSERT OR IGNORE INTO _workspace_tombstones (workspace_id, deleted_at) VALUES (?, ?)').run(workspaceId, new Date().toISOString());
    });
  }

  listAgentProfiles(workspaceId: string): AgentProfile[] {
    const rows = this.database.prepare(`
      SELECT ap.workspace_id, ap.id, ap.name, ap.agent_role, ap.role_title, ap.system_prompt,
        ap.provider, ap.permissions_json, ap.enabled, ap.cli_command, ap.cli_args_json, ap.model, ap.thinking_effort,
        ap.provider_config_id, ap.created_at, ap.updated_at,
        pc.provider_type AS provider_config_provider_type,
        pc.executable AS provider_config_executable,
        pc.args_template_json AS provider_config_args_template_json,
        pc.model AS provider_config_model
      FROM agent_profiles ap
      LEFT JOIN provider_configurations pc
        ON pc.id = ap.provider_config_id AND pc.workspace_id = ap.workspace_id
      WHERE ap.workspace_id = ?
      ORDER BY ap.name COLLATE NOCASE
    `).all(workspaceId) as AgentProfileRow[];
    return rows.map(row => this.toAgentProfile(row, this.latestAgentRuntime(workspaceId, row.id)));
  }

  findAgentSnapshotSource(workspaceId: string, agentId: string): AgentSnapshotSourceRecord | undefined {
    const row = this.database.prepare(`
      SELECT workspace_id, id, name, agent_role, role_title, system_prompt,
        permissions_json, enabled, provider_config_id, version
      FROM agent_profiles
      WHERE workspace_id = ? AND id = ?
    `).get(workspaceId, agentId) as AgentSnapshotSourceRow | undefined;
    if (!row) return undefined;

    let permissions: AgentPermission[];
    try {
      permissions = JSON.parse(row.permissions_json) as AgentPermission[];
    } catch {
      permissions = [];
    }
    return {
      workspaceId: row.workspace_id,
      id: row.id,
      name: row.name,
      role: row.agent_role,
      roleTitle: row.role_title,
      systemPrompt: row.system_prompt,
      permissions: Array.isArray(permissions) ? permissions : [],
      enabled: row.enabled === 1,
      providerConfigId: row.provider_config_id,
      version: row.version,
    };
  }

  updateAgentProfile(
    workspaceId: string,
    agentId: string,
    update: Pick<AgentProfile, 'roleTitle' | 'systemPrompt' | 'permissions' | 'enabled'> & Partial<Pick<AgentProfile, 'name' | 'model' | 'thinkingEffort' | 'provider'>>,
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

    const newVersion = inTransaction(this.database, () => {
      const row = this.database.prepare('SELECT version FROM agent_profiles WHERE workspace_id = ? AND id = ?')
        .get(workspaceId, agentId) as { version: number } | undefined;
      if (!row) throw new Error('Agent not found');

      const result = this.database.prepare(`
        UPDATE agent_profiles
        SET name = ?, provider = ?, role_title = ?, system_prompt = ?, permissions_json = ?,
            enabled = ?, model = ?, thinking_effort = ?, updated_at = ?,
            version = version + 1
        WHERE workspace_id = ? AND id = ? AND version = ?
      `).run(
        next.name,
        next.provider ?? providerFromLegacyRole(next.role),
        next.roleTitle,
        next.systemPrompt,
        JSON.stringify(next.permissions),
        next.enabled ? 1 : 0,
        next.model ?? null,
        normalizeThinkingEffort(next.thinkingEffort),
        next.updatedAt,
        workspaceId,
        agentId,
        row.version,
      );

      const nextVersion = assertVersionedMutation(result as { changes: number }, {
        entityType: 'agent_profiles',
        entityId: agentId,
        expectedVersion: row.version,
      });

      const binding = this.database.prepare(`
        SELECT provider_config_id FROM agent_profiles WHERE workspace_id = ? AND id = ?
      `).get(workspaceId, agentId) as { provider_config_id: string | null } | undefined;
      if (binding?.provider_config_id) {
        this.database.prepare(`
          UPDATE provider_configurations
          SET provider_type = ?, model = ?, updated_at = ?, version = version + 1
          WHERE id = ? AND workspace_id = ?
        `).run(
          providerConfigurationTypeFromAgentProvider(next.provider),
          next.model ?? null,
          next.updatedAt,
          binding.provider_config_id,
          workspaceId,
        );
      }
      return nextVersion;
    });
    return this.listAgentProfiles(workspaceId).find(agent => agent.id === agentId) ?? next;
  }

  createConversation(conversation: Conversation): Conversation {
    this.assertWorkspaceExists(conversation.workspaceId);
    if (conversation.type === 'direct' && !conversation.agentId) {
      throw new Error('Direct conversations require an agentId');
    }
    this.database.prepare(`
      INSERT INTO conversations (id, workspace_id, conversation_type, title, agent_id, model, thinking_effort, dispatch_mode, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      conversation.id,
      conversation.workspaceId,
      conversation.type,
      conversation.title,
      conversation.agentId ?? null,
      conversation.model ?? null,
      conversation.thinkingEffort ?? null,
      conversation.dispatchMode ?? null,
      conversation.createdAt,
      conversation.updatedAt,
    );
    return conversation;
  }

  listConversations(workspaceId: string): Conversation[] {
    const rows = this.database.prepare(`
      SELECT id, workspace_id, conversation_type, title, agent_id, model, thinking_effort, dispatch_mode, created_at, updated_at
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
      ...(row.dispatch_mode ? { dispatchMode: normalizeDispatchMode(row.dispatch_mode) } : {}),
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

  createGroupConversation(conversation: Conversation, members: Array<ConversationMember | LegacyConversationMember>): Conversation {
    if (conversation.type !== 'group') throw new Error('Group conversations require group type');
    if (members.length < 2) throw new Error('Group conversations require at least two members');
    const normalizedMembers = normalizeConversationMembers(members);
    if (normalizedMembers.filter(member => member.roleKind === 'leader').length !== 1) throw new Error('Group conversations require exactly one leader');
    if (new Set(members.map(member => member.agentId)).size !== members.length) throw new Error('Group conversation members must be unique');
    if (new Set(normalizedMembers.map(member => member.sequence)).size !== normalizedMembers.length) throw new Error('Group member sequence values must be unique');
    const profiles = new Set(this.listAgentProfiles(conversation.workspaceId).filter(profile => profile.enabled).map(profile => profile.id));
    if (normalizedMembers.some(member => member.conversationId !== conversation.id || !profiles.has(member.agentId))) {
      throw new Error('Group members must be enabled agents in the workspace');
    }

    this.database.exec('BEGIN');
    try {
      this.createConversation(conversation);
      const insert = this.database.prepare(`
        INSERT INTO conversation_members (conversation_id, agent_id, role_title, is_leader, role_kind, sequence, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const member of normalizedMembers) {
        insert.run(member.conversationId, member.agentId, member.roleTitle, member.roleKind === 'leader' ? 1 : 0, member.roleKind, member.sequence, member.createdAt);
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
      SELECT members.conversation_id, members.agent_id, members.role_title, members.is_leader, members.role_kind, members.sequence, members.created_at
      FROM conversation_members AS members
      INNER JOIN conversations ON conversations.id = members.conversation_id
      WHERE conversations.workspace_id = ? AND members.conversation_id = ?
      ORDER BY COALESCE(members.sequence, 2147483647) ASC, members.created_at ASC
    `).all(workspaceId, conversationId) as ConversationMemberRow[];
    return rows.map(row => ({
      conversationId: row.conversation_id,
      agentId: row.agent_id,
      roleTitle: row.role_title,
      isLeader: row.role_kind === 'leader' || row.is_leader === 1,
      roleKind: normalizeCollaborationRole(row.role_kind, row.is_leader === 1),
      sequence: row.sequence ?? 0,
      createdAt: row.created_at,
    }));
  }

  updateGroupConversation(
    workspaceId: string,
    conversationId: string,
    update: { dispatchMode?: GroupDispatchMode; members: Array<ConversationMember | LegacyConversationMember> },
  ): { conversation: Conversation; members: ConversationMember[] } {
    const conversation = this.listConversations(workspaceId).find(item => item.id === conversationId);
    if (!conversation) throw new Error('Conversation not found');
    if (conversation.type !== 'group') throw new Error('Only group conversations support collaboration settings');
    const normalizedMembers = normalizeConversationMembers(update.members);
    if (normalizedMembers.length < 2) throw new Error('Group conversations require at least two members');
    if (normalizedMembers.filter(member => member.roleKind === 'leader').length !== 1) throw new Error('Group conversations require exactly one leader');
    if (new Set(normalizedMembers.map(member => member.agentId)).size !== normalizedMembers.length) throw new Error('Group conversation members must be unique');
    if (new Set(normalizedMembers.map(member => member.sequence)).size !== normalizedMembers.length) throw new Error('Group member sequence values must be unique');
    const profiles = new Set(this.listAgentProfiles(workspaceId).filter(profile => profile.enabled).map(profile => profile.id));
    if (normalizedMembers.some(member => member.conversationId !== conversationId || !profiles.has(member.agentId))) {
      throw new Error('Group members must be enabled agents in the workspace');
    }
    const dispatchMode = update.dispatchMode ?? conversation.dispatchMode ?? 'leader_route';
    const updatedAt = new Date().toISOString();
    this.database.exec('BEGIN');
    try {
      this.database.prepare('UPDATE conversations SET dispatch_mode = ?, updated_at = ? WHERE id = ? AND workspace_id = ?')
        .run(dispatchMode, updatedAt, conversationId, workspaceId);
      this.database.prepare('DELETE FROM conversation_members WHERE conversation_id = ?').run(conversationId);
      const insert = this.database.prepare(`
        INSERT INTO conversation_members (conversation_id, agent_id, role_title, is_leader, role_kind, sequence, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const member of normalizedMembers) {
        insert.run(conversationId, member.agentId, member.roleTitle, member.roleKind === 'leader' ? 1 : 0, member.roleKind, member.sequence, member.createdAt);
      }
      this.database.exec('COMMIT');
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch {}
      throw error;
    }
    return {
      conversation: { ...conversation, dispatchMode, updatedAt },
      members: [...normalizedMembers].sort((left, right) => left.sequence - right.sequence).map(member => ({ ...member, isLeader: member.roleKind === 'leader' })),
    };
  }

  createMessage(message: ConversationMessage, attachments: StoredConversationAttachment[] = []): ConversationMessage {
    this.assertConversationWorkspace(message.conversationId, message.workspaceId);
    this.database.prepare(`
      INSERT INTO messages (id, conversation_id, workspace_id, sender_type, sender_agent_id, run_id, content, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      message.id,
      message.conversationId,
      message.workspaceId,
      message.senderType,
      message.senderAgentId ?? null,
      message.runId ?? null,
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

  updateMessageRunId(workspaceId: string, messageId: string, runId: string): void {
    this.database.prepare('UPDATE messages SET run_id = ? WHERE workspace_id = ? AND id = ?')
      .run(runId, workspaceId, messageId);
  }

  listMessages(workspaceId: string, conversationId: string, limit = 50): ConversationMessage[] {
    const rows = this.database.prepare(`
      SELECT id, conversation_id, workspace_id, sender_type, sender_agent_id, run_id, content, created_at
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
      ...(row.run_id ? { runId: row.run_id } : {}),
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
        waiting_execution_id, waiting_agent_id, intent, runtime_policy_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      run.intent ?? 'execute',
      run.runtimePolicy ? JSON.stringify(run.runtimePolicy) : null,
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
        waiting_execution_id, waiting_agent_id, intent, runtime_policy_json, created_at, updated_at
      FROM agent_runs
      WHERE workspace_id = ? AND id = ?
    `).get(workspaceId, runId) as AgentRunRow | undefined;
    return row ? this.toRun(row) : undefined;
  }

  listRuns(workspaceId: string, conversationId: string, limit = 50): AgentRun[] {
    const rows = this.database.prepare(`
      SELECT id, workspace_id, conversation_id, source_message_id, objective, status,
        result_summary, failure_reason, started_at, completed_at, waiting_question,
        waiting_execution_id, waiting_agent_id, intent, runtime_policy_json, created_at, updated_at
      FROM agent_runs
      WHERE workspace_id = ? AND conversation_id = ?
      ORDER BY updated_at DESC, created_at DESC
      LIMIT ?
    `).all(workspaceId, conversationId, limit) as AgentRunRow[];
    return rows.map(row => this.toRun(row));
  }

  listRunsForWorkspace(workspaceId: string, limit = 100_000): AgentRun[] {
    const rows = this.database.prepare(`
      SELECT id, workspace_id, conversation_id, source_message_id, objective, status,
        result_summary, failure_reason, started_at, completed_at, waiting_question,
        waiting_execution_id, waiting_agent_id, intent, runtime_policy_json, created_at, updated_at
      FROM agent_runs
      WHERE workspace_id = ?
      ORDER BY updated_at DESC, created_at DESC
      LIMIT ?
    `).all(workspaceId, limit) as AgentRunRow[];
    return rows.map(row => this.toRun(row));
  }

  deleteRunData(workspaceId: string, runId: string): void {
    const run = this.getRun(workspaceId, runId);
    if (!run) return;
    this.database.exec('BEGIN');
    try {
      this.database.prepare('DELETE FROM agent_events WHERE workspace_id = ? AND run_id = ?').run(workspaceId, runId);
      this.database.prepare('DELETE FROM run_event_sequences WHERE run_id = ?').run(runId);
      this.database.prepare('UPDATE messages SET run_id = NULL WHERE workspace_id = ? AND run_id = ?').run(workspaceId, runId);
      this.database.prepare('DELETE FROM executions WHERE workspace_id = ? AND run_id = ?').run(workspaceId, runId);
      this.database.prepare('DELETE FROM agent_runs WHERE workspace_id = ? AND id = ?').run(workspaceId, runId);
      this.database.exec('COMMIT');
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  listRunsForRecovery(): AgentRun[] {
    const rows = this.database.prepare(`
      SELECT id, workspace_id, conversation_id, source_message_id, objective, status,
        result_summary, failure_reason, started_at, completed_at, waiting_question,
        waiting_execution_id, waiting_agent_id, intent, runtime_policy_json, created_at, updated_at
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

  listExecutionsForWorkspace(workspaceId: string): AgentExecution[] {
    const rows = this.database.prepare(`
      SELECT id, run_id, conversation_id, workspace_id, source_message_id, agent_id, status, mode, error,
        started_at, completed_at, created_at, updated_at
      FROM executions
      WHERE workspace_id = ?
      ORDER BY updated_at DESC, created_at DESC
    `).all(workspaceId) as ExecutionRow[];
    return rows.map(row => this.toExecution(row));
  }

  getExecution(workspaceId: string, executionId: string): AgentExecution | undefined {
    const row = this.database.prepare(`
      SELECT id, run_id, conversation_id, workspace_id, source_message_id, agent_id, status, mode, error,
        started_at, completed_at, created_at, updated_at
      FROM executions
      WHERE workspace_id = ? AND id = ?
    `).get(workspaceId, executionId) as ExecutionRow | undefined;
    return row ? this.toExecution(row) : undefined;
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

  appendAgentEvent(draft: AgentEventDraft): PersistEventResult {
    this.database.exec('BEGIN');
    try {
      const result = this.appendAgentEventInTransaction(draft);
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  private appendAgentEventInTransaction(draft: AgentEventDraft): PersistEventResult {
    const existing = this.database.prepare(`
      SELECT event_id, schema_version, event_type, workspace_id, conversation_id, run_id,
        execution_id, agent_id, sequence, timestamp, payload_json
      FROM agent_events
      WHERE event_id = ?
    `).get(draft.eventId) as AgentEventRow | undefined;
    if (existing) return { event: this.toAgentEvent(existing), inserted: false };

    const sequence = this.allocateAgentEventSequence(draft.runId);
    this.insertAgentEventRow(draft, sequence);
    return { event: { ...draft, sequence }, inserted: true };
  }

  private allocateAgentEventSequence(runId: string): number {
    const sequenceRow = this.database.prepare(`
      SELECT next_sequence FROM run_event_sequences WHERE run_id = ?
    `).get(runId) as { next_sequence: number } | undefined;
    const sequence = sequenceRow?.next_sequence ?? 1;
    if (sequenceRow) {
      this.database.prepare('UPDATE run_event_sequences SET next_sequence = ? WHERE run_id = ?')
        .run(sequence + 1, runId);
    } else {
      this.database.prepare('INSERT INTO run_event_sequences (run_id, next_sequence) VALUES (?, ?)')
        .run(runId, sequence + 1);
    }
    return sequence;
  }

  private insertAgentEventRow(draft: AgentEventDraft, sequence: number): void {
    this.database.prepare(`
      INSERT INTO agent_events (
        event_id, schema_version, event_type, workspace_id, conversation_id, run_id,
        execution_id, agent_id, sequence, timestamp, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      draft.eventId,
      draft.schemaVersion,
      draft.type,
      draft.workspaceId,
      draft.conversationId,
      draft.runId,
      draft.executionId ?? null,
      draft.agentId ?? null,
      sequence,
      draft.timestamp,
      JSON.stringify(draft.payload),
    );
  }

  listAgentEvents(workspaceId: string, runId: string): AgentEvent[] {
    const rows = this.database.prepare(`
      SELECT event_id, schema_version, event_type, workspace_id, conversation_id, run_id,
        execution_id, agent_id, sequence, timestamp, payload_json
      FROM agent_events
      WHERE workspace_id = ? AND run_id = ?
      ORDER BY sequence ASC
    `).all(workspaceId, runId) as AgentEventRow[];
    return rows.map(row => this.toAgentEvent(row));
  }

  listRunSteps(workspaceId: string, runId: string): RunStep[] {
    const rows = this.database.prepare(`
      SELECT id, stable_step_key, workspace_id, run_id, parent_step_id, execution_id, agent_id,
        kind, title, status, sequence, attempt, created_event_sequence, updated_event_sequence,
        started_at, completed_at, summary, created_at, updated_at
      FROM run_steps
      WHERE workspace_id = ? AND run_id = ?
      ORDER BY sequence ASC, id ASC
    `).all(workspaceId, runId) as RunStepRow[];
    return rows.map(row => this.toRunStep(row));
  }

  getRunStep(workspaceId: string, runId: string, stableStepKey: string): RunStep | undefined {
    const row = this.database.prepare(`
      SELECT id, stable_step_key, workspace_id, run_id, parent_step_id, execution_id, agent_id,
        kind, title, status, sequence, attempt, created_event_sequence, updated_event_sequence,
        started_at, completed_at, summary, created_at, updated_at
      FROM run_steps
      WHERE workspace_id = ? AND run_id = ? AND stable_step_key = ?
    `).get(workspaceId, runId, stableStepKey) as RunStepRow | undefined;
    return row ? this.toRunStep(row) : undefined;
  }

  persistRunStepMutation(mutation: RunStepMutation, eventDraft: AgentEventDraft): PersistRunStepMutationResult {
    this.database.exec('BEGIN');
    try {
      const existingEvent = this.database.prepare(`
        SELECT event_id, schema_version, event_type, workspace_id, conversation_id, run_id,
          execution_id, agent_id, sequence, timestamp, payload_json
        FROM agent_events WHERE event_id = ?
      `).get(mutation.eventId) as AgentEventRow | undefined;
      if (existingEvent) {
        const input = mutation.input;
        const step = this.getRunStep(input.workspaceId, input.runId, input.stableStepKey);
        if (!step) throw new Error('RunStep for duplicate event was not found');
        this.database.exec('COMMIT');
        return { step, event: this.toAgentEvent(existingEvent), inserted: false };
      }

      const input = mutation.input;
      const current = this.getRunStep(input.workspaceId, input.runId, input.stableStepKey);
      const now = eventDraft.timestamp;
      const eventSequence = this.allocateAgentEventSequence(input.runId);
      let step: RunStep;
      if (mutation.operation === 'create') {
        const createInput = input as CreateRunStepInput;
        if (current) {
          this.database.exec('ROLLBACK');
          throw new Error(`RunStep stable key already exists: ${input.stableStepKey}`);
        }
        const id = `step-${eventDraft.eventId}`;
        step = {
          id,
          stableStepKey: createInput.stableStepKey,
          workspaceId: createInput.workspaceId,
          runId: createInput.runId,
          ...(createInput.parentStepId ? { parentStepId: createInput.parentStepId } : {}),
          ...(createInput.agentId ? { agentId: createInput.agentId } : {}),
          kind: createInput.kind,
          title: createInput.title,
          status: 'pending',
          sequence: createInput.sequence,
          attempt: 1,
          createdEventSequence: eventSequence,
          updatedEventSequence: eventSequence,
          createdAt: now,
          updatedAt: now,
        };
        this.database.prepare(`
          INSERT INTO run_steps (
            id, stable_step_key, workspace_id, run_id, parent_step_id, execution_id, agent_id,
            kind, title, status, sequence, attempt, created_event_sequence, updated_event_sequence,
            started_at, completed_at, summary, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          step.id, step.stableStepKey, step.workspaceId, step.runId, step.parentStepId ?? null, null, step.agentId ?? null,
          step.kind, step.title, step.status, step.sequence, step.attempt, step.createdEventSequence, step.updatedEventSequence,
          null, null, null, step.createdAt, step.updatedAt,
        );
      } else {
        const updateInput = input as UpdateRunStepInput;
        if (!current) {
          this.database.exec('ROLLBACK');
          throw new Error(`RunStep not found: ${input.stableStepKey}`);
        }
        const nextAttempt = current.status === 'waiting' && updateInput.status === 'running' ? current.attempt + 1 : current.attempt;
        const startedAt = updateInput.status === 'running' && current.status !== 'running' ? now : current.startedAt;
        const completedAt = isTerminalRunStepStatus(updateInput.status) ? now : undefined;
        step = {
          ...current,
          status: updateInput.status,
          attempt: nextAttempt,
          updatedEventSequence: eventSequence,
          updatedAt: now,
          ...(updateInput.executionId ? { executionId: updateInput.executionId } : {}),
          ...(updateInput.summary !== undefined ? { summary: updateInput.summary } : {}),
          ...(startedAt ? { startedAt } : {}),
          ...(completedAt ? { completedAt } : {}),
        };
        this.database.prepare(`
          UPDATE run_steps
          SET execution_id = ?, status = ?, attempt = ?, updated_event_sequence = ?,
            started_at = ?, completed_at = ?, summary = ?, updated_at = ?
          WHERE workspace_id = ? AND run_id = ? AND stable_step_key = ?
        `).run(
          step.executionId ?? null, step.status, step.attempt, step.updatedEventSequence,
          step.startedAt ?? null, step.completedAt ?? null, step.summary ?? null, step.updatedAt,
          step.workspaceId, step.runId, step.stableStepKey,
        );
      }
      const event: AgentEvent = { ...eventDraft, sequence: eventSequence, payload: { ...eventDraft.payload, step } };
      this.insertAgentEventRow({ ...eventDraft, payload: event.payload }, eventSequence);
      this.database.exec('COMMIT');
      return { step, event, inserted: true };
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  saveRunCliInvocation(invocation: RunCliInvocation): void {
    const run = this.database.prepare('SELECT id FROM agent_runs WHERE id = ?').get(invocation.runId) as { id: string } | undefined;
    const execution = this.database.prepare('SELECT id FROM executions WHERE id = ? AND run_id = ? AND agent_id = ?')
      .get(invocation.executionId, invocation.runId, invocation.agentId) as { id: string } | undefined;
    if (!run || !execution) throw new Error('Run not found for CLI invocation');
    this.database.prepare(`
      INSERT INTO run_cli_invocations (
        id, run_id, execution_id, agent_id, cli_kind, command_label, configured_provider, detected_provider, provider_mismatch, model, thinking_effort,
        exit_code, duration_ms, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        exit_code = excluded.exit_code,
        duration_ms = excluded.duration_ms,
        completed_at = excluded.completed_at,
        model = excluded.model,
        thinking_effort = excluded.thinking_effort,
        configured_provider = excluded.configured_provider,
        detected_provider = excluded.detected_provider,
        provider_mismatch = excluded.provider_mismatch
    `).run(
      invocation.id, invocation.runId, invocation.executionId, invocation.agentId, invocation.cliKind, invocation.commandLabel,
      invocation.configuredProvider ?? null, invocation.detectedProvider ?? null, invocation.providerMismatch ? 1 : 0,
      invocation.model ?? null, invocation.thinkingEffort ?? null, invocation.exitCode, invocation.durationMs,
      invocation.startedAt, invocation.completedAt,
    );
  }

  listRunCliInvocations(workspaceId: string, runId: string): RunCliInvocation[] {
    const rows = this.database.prepare(`
      SELECT invocations.id, invocations.run_id, invocations.execution_id, invocations.agent_id,
        invocations.cli_kind, invocations.command_label, invocations.model, invocations.thinking_effort,
        invocations.configured_provider, invocations.detected_provider, invocations.provider_mismatch,
        invocations.exit_code, invocations.duration_ms, invocations.started_at, invocations.completed_at
      FROM run_cli_invocations AS invocations
      INNER JOIN agent_runs ON agent_runs.id = invocations.run_id
      WHERE agent_runs.workspace_id = ? AND invocations.run_id = ?
      ORDER BY invocations.started_at ASC
    `).all(workspaceId, runId) as RunCliInvocationRow[];
    return rows.map(row => ({
      id: row.id, runId: row.run_id, executionId: row.execution_id, agentId: row.agent_id,
      cliKind: row.cli_kind, commandLabel: row.command_label,
      ...(row.configured_provider ? { configuredProvider: row.configured_provider } : {}),
      ...(row.detected_provider ? { detectedProvider: row.detected_provider } : {}),
      ...(row.provider_mismatch === 1 ? { providerMismatch: true } : {}),
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

  createPendingRunDecision(input: Omit<PendingRunDecision, 'resolvedDecision' | 'resolvedAt'>): PendingRunDecision {
    const existing = this.getPendingRunDecision(input.workspaceId, input.runId, input.executionId, input.kind);
    if (existing) return existing;
    this.database.prepare(`
      INSERT INTO run_decisions (id, workspace_id, run_id, execution_id, kind, file_changes_json, allowed_decisions_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.id, input.workspaceId, input.runId, input.executionId, input.kind, JSON.stringify(input.fileChanges), JSON.stringify(input.allowedDecisions), input.createdAt);
    return input;
  }

  getPendingRunDecision(workspaceId: string, runId: string, executionId?: string, kind: PendingRunDecision['kind'] = 'partial_write_failure'): PendingRunDecision | undefined {
    const row = this.database.prepare(`
      SELECT decisions.id, decisions.workspace_id, decisions.run_id, decisions.execution_id, decisions.kind,
        decisions.file_changes_json, decisions.allowed_decisions_json, decisions.resolved_decision, decisions.created_at, decisions.resolved_at
      FROM run_decisions AS decisions
      INNER JOIN agent_runs ON agent_runs.id = decisions.run_id
      WHERE agent_runs.workspace_id = ? AND decisions.run_id = ? AND decisions.kind = ?
        AND (? IS NULL OR decisions.execution_id = ?)
      ORDER BY decisions.created_at DESC LIMIT 1
    `).get(workspaceId, runId, kind, executionId ?? null, executionId ?? null) as RunDecisionRow | undefined;
    return row ? toPendingRunDecision(row) : undefined;
  }

  resolvePendingRunDecision(workspaceId: string, decisionId: string, decision: PartialWriteDecision): PendingRunDecision {
    const row = this.database.prepare(`
      SELECT id, workspace_id, run_id, execution_id, kind, file_changes_json, allowed_decisions_json, resolved_decision, created_at, resolved_at
      FROM run_decisions WHERE id = ? AND workspace_id = ?
    `).get(decisionId, workspaceId) as RunDecisionRow | undefined;
    if (!row) throw new Error('Run decision not found');
    const current = toPendingRunDecision(row);
    if (!current.allowedDecisions.includes(decision)) throw new Error('Decision is not allowed');
    if (current.resolvedDecision) {
      if (current.resolvedDecision !== decision) throw new Error('Run decision has already been resolved');
      return current;
    }
    const resolvedAt = new Date().toISOString();
    this.database.prepare('UPDATE run_decisions SET resolved_decision = ?, resolved_at = ? WHERE id = ? AND workspace_id = ? AND resolved_decision IS NULL')
      .run(decision, resolvedAt, decisionId, workspaceId);
    return { ...current, resolvedDecision: decision, resolvedAt };
  }

  createRuntimeArtifact(artifact: RuntimeArtifact, storageKey: string | null): void {
    const run = this.getRun(artifact.workspaceId, artifact.runId);
    const execution = this.getExecution(artifact.workspaceId, artifact.sourceExecutionId);
    if (!run || !execution || execution.runId !== artifact.runId || execution.agentId !== artifact.agentId) {
      throw new Error('Runtime artifact provenance is invalid');
    }
    this.database.prepare(`
      INSERT INTO runtime_artifacts (
        id, workspace_id, run_id, source_execution_id, agent_id, artifact_type, title, summary,
        original_path, storage_key, mime_type, size_bytes, sha256, content_available, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      artifact.id, artifact.workspaceId, artifact.runId, artifact.sourceExecutionId, artifact.agentId, artifact.type,
      artifact.title, artifact.summary ?? null, artifact.originalPath ?? null, storageKey, artifact.mimeType ?? null,
      artifact.sizeBytes, artifact.sha256 ?? null, artifact.contentAvailable ? 1 : 0, artifact.createdAt,
    );
  }

  listRuntimeArtifacts(workspaceId: string, runId: string): RuntimeArtifact[] {
    const rows = this.database.prepare(`
      SELECT artifacts.id, artifacts.workspace_id, artifacts.run_id, artifacts.source_execution_id, artifacts.agent_id,
        artifacts.artifact_type, artifacts.title, artifacts.summary, artifacts.original_path, artifacts.storage_key,
        artifacts.mime_type, artifacts.size_bytes, artifacts.sha256, artifacts.content_available, artifacts.created_at
      FROM runtime_artifacts AS artifacts
      INNER JOIN agent_runs ON agent_runs.id = artifacts.run_id
      WHERE artifacts.workspace_id = ? AND artifacts.run_id = ?
      ORDER BY artifacts.created_at ASC, artifacts.id ASC
    `).all(workspaceId, runId) as RuntimeArtifactRow[];
    return rows.map(row => this.toRuntimeArtifact(row));
  }

  getRuntimeArtifactRecord(workspaceId: string, artifactId: string): RuntimeArtifactRecord | undefined {
    const row = this.database.prepare(`
      SELECT id, workspace_id, run_id, source_execution_id, agent_id, artifact_type, title, summary,
        original_path, storage_key, mime_type, size_bytes, sha256, content_available, created_at
      FROM runtime_artifacts
      WHERE workspace_id = ? AND id = ?
    `).get(workspaceId, artifactId) as RuntimeArtifactRow | undefined;
    return row ? { artifact: this.toRuntimeArtifact(row), storageKey: row.storage_key } : undefined;
  }

  deleteRuntimeArtifact(workspaceId: string, artifactId: string): void {
    this.database.prepare('DELETE FROM runtime_artifacts WHERE workspace_id = ? AND id = ?').run(workspaceId, artifactId);
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

  getDefaultUserProfile(): UserProfile {
    const existing = this.database.prepare(`
      SELECT id, display_name, learning_enabled, created_at, updated_at
      FROM user_profiles WHERE id = 'default'
    `).get() as UserProfileRow | undefined;
    if (existing) return this.toUserProfile(existing);
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO user_profiles (id, display_name, learning_enabled, created_at, updated_at)
      VALUES ('default', '本地用户', 1, ?, ?)
    `).run(now, now);
    return { id: 'default', displayName: '本地用户', learningEnabled: true, createdAt: now, updatedAt: now };
  }

  setPreferenceLearningEnabled(profileId: string, enabled: boolean): UserProfile {
    const profile = this.getUserProfile(profileId);
    if (!profile) throw new Error('User profile not found');
    const updatedAt = new Date().toISOString();
    this.database.prepare('UPDATE user_profiles SET learning_enabled = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, updatedAt, profileId);
    return this.getUserProfile(profileId)!;
  }

  createPreferenceEvidence(evidence: PreferenceEvidence): PreferenceEvidence {
    if (!evidence.id || !evidence.profileId || !evidence.sourceEventId || !evidence.summary.trim()) {
      throw new Error('Invalid preference evidence');
    }
    this.database.prepare(`
      INSERT OR IGNORE INTO preference_evidence (
        id, profile_id, workspace_id, conversation_id, run_id, source_event_id, dimension, context_kind,
        candidate_value, signal_type, polarity, weight, summary, status, observed_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      evidence.id, evidence.profileId, evidence.workspaceId ?? null, evidence.conversationId, evidence.runId,
      evidence.sourceEventId, evidence.dimension, evidence.contextKind, evidence.candidateValue, evidence.signalType,
      evidence.polarity, evidence.weight, evidence.summary.trim(), evidence.status, evidence.observedAt, evidence.createdAt,
    );
    return this.getPreferenceEvidence(evidence.profileId, evidence.id) ?? evidence;
  }

  pruneSuccessfulPreferenceEvidence(profileId: string, workspaceId: string): number {
    const result = this.database.prepare(`
      DELETE FROM preference_evidence
      WHERE id IN (
        SELECT id FROM (
          SELECT id,
            ROW_NUMBER() OVER (
              PARTITION BY profile_id, workspace_id, dimension, context_kind, candidate_value
              ORDER BY observed_at DESC, id DESC
            ) AS row_number
          FROM preference_evidence
          WHERE profile_id = ?
            AND workspace_id = ?
            AND signal_type = 'successful_application'
            AND polarity = 'positive'
        )
        WHERE row_number > ?
      )
    `).run(profileId, workspaceId, MAX_SUCCESS_EVIDENCE_PER_KEY) as { changes: number };
    return result.changes;
  }

  getPreferenceEvidence(profileId: string, evidenceId: string): PreferenceEvidence | undefined {
    const row = this.database.prepare(`
      SELECT id, profile_id, workspace_id, conversation_id, run_id, source_event_id, dimension, context_kind,
        candidate_value, signal_type, polarity, weight, summary, status, observed_at, created_at
      FROM preference_evidence WHERE profile_id = ? AND id = ?
    `).get(profileId, evidenceId) as PreferenceEvidenceRow | undefined;
    return row ? this.toPreferenceEvidence(row) : undefined;
  }

  listPreferenceEvidence(profileId: string, workspaceId?: string): PreferenceEvidence[] {
    const rows = (workspaceId
      ? this.database.prepare(`
        SELECT id, profile_id, workspace_id, conversation_id, run_id, source_event_id, dimension, context_kind,
          candidate_value, signal_type, polarity, weight, summary, status, observed_at, created_at
        FROM preference_evidence
        WHERE profile_id = ? AND (workspace_id = ? OR workspace_id IS NULL)
        ORDER BY observed_at ASC, id ASC
      `).all(profileId, workspaceId)
      : this.database.prepare(`
        SELECT id, profile_id, workspace_id, conversation_id, run_id, source_event_id, dimension, context_kind,
          candidate_value, signal_type, polarity, weight, summary, status, observed_at, created_at
        FROM preference_evidence WHERE profile_id = ?
        ORDER BY observed_at ASC, id ASC
      `).all(profileId)) as PreferenceEvidenceRow[];
    return rows.map(row => this.toPreferenceEvidence(row));
  }

  listPreferenceProjections(profileId: string, workspaceId?: string): PreferenceProjection[] {
    const rows = (workspaceId
      ? this.database.prepare(`
        SELECT id, profile_id, scope, workspace_id, dimension, context_kind, preferred_value, confidence, score,
          evidence_count, independent_run_count, status, last_supported_at, last_conflicted_at, created_at, updated_at
        FROM preference_projections
        WHERE profile_id = ? AND (scope = 'global' OR (scope = 'workspace' AND workspace_id = ?))
        ORDER BY updated_at DESC, id ASC
      `).all(profileId, workspaceId)
      : this.database.prepare(`
        SELECT id, profile_id, scope, workspace_id, dimension, context_kind, preferred_value, confidence, score,
          evidence_count, independent_run_count, status, last_supported_at, last_conflicted_at, created_at, updated_at
        FROM preference_projections WHERE profile_id = ?
        ORDER BY updated_at DESC, id ASC
      `).all(profileId)) as PreferenceProjectionRow[];
    return rows.map(row => this.toPreferenceProjection(row));
  }

  upsertPreferenceProjection(projection: PreferenceProjection, links: Array<Pick<PreferenceProjectionEvidence, 'evidenceId' | 'contribution'>> = []): PreferenceProjection {
    this.database.exec('BEGIN');
    try {
      this.database.prepare(`
        INSERT INTO preference_projections (
          id, profile_id, scope, workspace_id, dimension, context_kind, preferred_value, confidence, score,
          evidence_count, independent_run_count, status, last_supported_at, last_conflicted_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET
          profile_id = excluded.profile_id, scope = excluded.scope, workspace_id = excluded.workspace_id,
          dimension = excluded.dimension, context_kind = excluded.context_kind, preferred_value = excluded.preferred_value,
          confidence = excluded.confidence, score = excluded.score, evidence_count = excluded.evidence_count,
          independent_run_count = excluded.independent_run_count, status = excluded.status,
          last_supported_at = excluded.last_supported_at, last_conflicted_at = excluded.last_conflicted_at,
          updated_at = excluded.updated_at
      `).run(
        projection.id, projection.profileId, projection.scope, projection.workspaceId ?? null, projection.dimension,
        projection.contextKind, projection.preferredValue, projection.confidence, projection.score,
        projection.evidenceCount, projection.independentRunCount, projection.status, projection.lastSupportedAt,
        projection.lastConflictedAt ?? null, projection.createdAt, projection.updatedAt,
      );
      this.database.prepare('DELETE FROM preference_projection_evidence WHERE projection_id = ?').run(projection.id);
      for (const link of links) {
        this.database.prepare(`
          INSERT INTO preference_projection_evidence (projection_id, evidence_id, contribution)
          VALUES (?, ?, ?)
        `).run(projection.id, link.evidenceId, link.contribution);
      }
      this.database.exec('COMMIT');
      return projection;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  createPreferenceApplication(application: PreferenceApplication): PreferenceApplication {
    this.database.prepare(`
      INSERT OR IGNORE INTO preference_applications (run_id, projection_id, resolved_value, rank, injected_characters, applied_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(application.runId, application.projectionId, application.resolvedValue, application.rank, application.injectedCharacters, application.appliedAt);
    return application;
  }

  listPreferenceApplications(workspaceId: string, runId: string): PreferenceApplication[] {
    const rows = this.database.prepare(`
      SELECT applications.run_id, applications.projection_id, applications.resolved_value,
        applications.rank, applications.injected_characters, applications.applied_at
      FROM preference_applications AS applications
      INNER JOIN agent_runs ON agent_runs.id = applications.run_id
      WHERE agent_runs.workspace_id = ? AND applications.run_id = ?
      ORDER BY applications.rank ASC, applications.projection_id ASC
    `).all(workspaceId, runId) as Array<{ run_id: string; projection_id: string; resolved_value: string; rank: number; injected_characters: number; applied_at: string }>;
    return rows.map(row => ({
      runId: row.run_id, projectionId: row.projection_id, resolvedValue: row.resolved_value,
      rank: row.rank, injectedCharacters: row.injected_characters, appliedAt: row.applied_at,
    }));
  }

  clearPreferenceProjections(profileId: string): void {
    this.database.exec('BEGIN');
    try {
      this.database.prepare(`
        DELETE FROM preference_applications
        WHERE projection_id IN (SELECT id FROM preference_projections WHERE profile_id = ?)
      `).run(profileId);
      this.database.prepare('DELETE FROM preference_projections WHERE profile_id = ?').run(profileId);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  sleepPreferenceProjection(profileId: string, projectionId: string): PreferenceProjection {
    this.database.prepare(`UPDATE preference_projections SET status = 'dormant', updated_at = ? WHERE profile_id = ? AND id = ?`)
      .run(new Date().toISOString(), profileId, projectionId);
    const projection = this.listPreferenceProjections(profileId).find(item => item.id === projectionId);
    if (!projection) throw new Error('Preference projection not found');
    return projection;
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

  pruneReviewedMemoryCandidates(cutoffAt: string, minimumPerWorkspace: number): number {
    const minimum = Math.max(0, Math.floor(minimumPerWorkspace));
    const result = this.database.prepare(`
      DELETE FROM memory_candidates AS candidates
      WHERE candidates.status IN ('accepted', 'rejected')
        AND candidates.reviewed_at IS NOT NULL
        AND candidates.reviewed_at < ?
        AND candidates.id NOT IN (
          SELECT retained.id
          FROM memory_candidates AS retained
          WHERE retained.workspace_id = candidates.workspace_id
            AND retained.status IN ('accepted', 'rejected')
            AND retained.reviewed_at IS NOT NULL
          ORDER BY retained.reviewed_at DESC, retained.id DESC
          LIMIT ?
        )
    `).run(cutoffAt, minimum) as { changes: number };
    return result.changes;
  }

  updateMemoryCandidateStatus(workspaceId: string, candidateId: string, status: MemoryCandidateStatus, reviewedAt = new Date().toISOString()): MemoryCandidate {
    const current = this.getMemoryCandidate(workspaceId, candidateId);
    if (!current) throw new Error('Memory candidate not found');
    if (current.status !== 'pending') throw new Error('Memory candidate has already been reviewed');
    this.database.prepare('UPDATE memory_candidates SET status = ?, reviewed_at = ? WHERE workspace_id = ? AND id = ?')
      .run(status, reviewedAt, workspaceId, candidateId);
    return this.getMemoryCandidate(workspaceId, candidateId) ?? { ...current, status, reviewedAt };
  }

  private runMigrations(): void {
    // MigrationRunner takes over schema initialization.
    // migrateSchema() is kept as the implementation source for baseline DDL.
    const registry = new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS);
    const runner = new MigrationRunner(this.database as any, registry);
    runner.run();
  }

  /** @internal Exposed for route-layer repository construction. */
  getDatabase(): SqliteDatabase {
    return this.database;
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
        provider TEXT,
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
        dispatch_mode TEXT,
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
        role_kind TEXT NOT NULL DEFAULT 'worker',
        sequence INTEGER NOT NULL DEFAULT 0,
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
        run_id TEXT,
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
        waiting_question TEXT,
        waiting_execution_id TEXT,
        waiting_agent_id TEXT,
        intent TEXT NOT NULL DEFAULT 'execute',
        runtime_policy_json TEXT,
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

      CREATE TABLE IF NOT EXISTS run_steps (
        id TEXT PRIMARY KEY,
        stable_step_key TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        parent_step_id TEXT,
        execution_id TEXT,
        agent_id TEXT,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 1,
        created_event_sequence INTEGER NOT NULL,
        updated_event_sequence INTEGER NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        summary TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
      );

      CREATE UNIQUE INDEX IF NOT EXISTS run_steps_stable_key
        ON run_steps (run_id, stable_step_key);

      CREATE UNIQUE INDEX IF NOT EXISTS run_steps_sibling_sequence
        ON run_steps (run_id, IFNULL(parent_step_id, ''), sequence);

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
        sequence INTEGER,
        timestamp TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS run_event_sequences (
        run_id TEXT PRIMARY KEY,
        next_sequence INTEGER NOT NULL
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
        configured_provider TEXT,
        detected_provider TEXT,
        provider_mismatch INTEGER NOT NULL DEFAULT 0,
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

      CREATE TABLE IF NOT EXISTS run_decisions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        file_changes_json TEXT NOT NULL,
        allowed_decisions_json TEXT NOT NULL,
        resolved_decision TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        UNIQUE (run_id, execution_id, kind),
        FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
        FOREIGN KEY (execution_id) REFERENCES executions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS run_decisions_workspace_run
        ON run_decisions (workspace_id, run_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS runtime_artifacts (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        source_execution_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        artifact_type TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT,
        original_path TEXT,
        storage_key TEXT,
        mime_type TEXT,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT,
        content_available INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
        FOREIGN KEY (source_execution_id) REFERENCES executions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS runtime_artifacts_run_created
        ON runtime_artifacts (workspace_id, run_id, created_at, id);

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

      CREATE TABLE IF NOT EXISTS user_profiles (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        learning_enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS preference_evidence (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        workspace_id TEXT,
        conversation_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        dimension TEXT NOT NULL,
        context_kind TEXT NOT NULL,
        candidate_value TEXT NOT NULL,
        signal_type TEXT NOT NULL,
        polarity TEXT NOT NULL,
        weight INTEGER NOT NULL,
        summary TEXT NOT NULL,
        status TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (profile_id, source_event_id, dimension, context_kind, candidate_value, signal_type, polarity),
        FOREIGN KEY (profile_id) REFERENCES user_profiles(id) ON DELETE CASCADE,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
        FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS preference_evidence_profile_scope_time
        ON preference_evidence (profile_id, workspace_id, observed_at ASC);

      CREATE TABLE IF NOT EXISTS preference_projections (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        workspace_id TEXT,
        dimension TEXT NOT NULL,
        context_kind TEXT NOT NULL,
        preferred_value TEXT NOT NULL,
        confidence INTEGER NOT NULL,
        score INTEGER NOT NULL,
        evidence_count INTEGER NOT NULL,
        independent_run_count INTEGER NOT NULL,
        status TEXT NOT NULL,
        last_supported_at TEXT NOT NULL,
        last_conflicted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (profile_id, scope, workspace_id, dimension, context_kind),
        FOREIGN KEY (profile_id) REFERENCES user_profiles(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS preference_projections_profile_scope_status
        ON preference_projections (profile_id, scope, workspace_id, status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS preference_projection_evidence (
        projection_id TEXT NOT NULL,
        evidence_id TEXT NOT NULL,
        contribution INTEGER NOT NULL,
        PRIMARY KEY (projection_id, evidence_id),
        FOREIGN KEY (projection_id) REFERENCES preference_projections(id) ON DELETE CASCADE,
        FOREIGN KEY (evidence_id) REFERENCES preference_evidence(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS preference_applications (
        run_id TEXT NOT NULL,
        projection_id TEXT NOT NULL,
        resolved_value TEXT NOT NULL,
        rank INTEGER NOT NULL,
        injected_characters INTEGER NOT NULL,
        applied_at TEXT NOT NULL,
        PRIMARY KEY (run_id, projection_id),
        FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS preference_applications_run_rank
        ON preference_applications (run_id, rank ASC);
    `);
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT OR IGNORE INTO user_profiles (id, display_name, learning_enabled, created_at, updated_at)
      VALUES ('default', '本地用户', 1, ?, ?)
    `).run(now, now);
    this.ensureColumn('agent_profiles', 'thinking_effort', "TEXT NOT NULL DEFAULT 'auto'");
    this.ensureColumn('agent_profiles', 'provider', 'TEXT');
    this.ensureColumn('conversations', 'model', 'TEXT');
    this.ensureColumn('conversations', 'thinking_effort', 'TEXT');
    this.ensureColumn('conversations', 'dispatch_mode', 'TEXT');
    this.ensureColumn('conversation_members', 'role_kind', "TEXT NOT NULL DEFAULT 'worker'");
    this.ensureColumn('conversation_members', 'sequence', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('messages', 'run_id', 'TEXT');
    this.ensureColumn('executions', 'run_id', 'TEXT');
    this.ensureColumn('agent_runs', 'waiting_question', 'TEXT');
    this.ensureColumn('agent_runs', 'waiting_execution_id', 'TEXT');
    this.ensureColumn('agent_runs', 'waiting_agent_id', 'TEXT');
    this.ensureColumn('agent_runs', 'intent', "TEXT NOT NULL DEFAULT 'execute'");
    this.ensureColumn('agent_runs', 'runtime_policy_json', 'TEXT');
    this.ensureColumn('run_cli_invocations', 'configured_provider', 'TEXT');
    this.ensureColumn('run_cli_invocations', 'detected_provider', 'TEXT');
    this.ensureColumn('run_cli_invocations', 'provider_mismatch', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('agent_events', 'sequence', 'INTEGER');
    this.ensureColumn('run_steps', 'attempt', 'INTEGER NOT NULL DEFAULT 1');
    this.migrateAgentEventSequences();
    this.migrateLegacyExecutionRuns();
    this.migrateConversationCollaboration();
  }

  private migrateConversationCollaboration(): void {
    this.database.exec('BEGIN');
    try {
      const rows = this.database.prepare(`
        SELECT members.rowid, members.conversation_id, members.is_leader, members.role_kind, members.sequence, members.created_at
        FROM conversation_members AS members
        INNER JOIN conversations ON conversations.id = members.conversation_id
        ORDER BY members.conversation_id ASC, members.is_leader DESC, members.created_at ASC, members.rowid ASC
      `).all() as Array<{ rowid: number; conversation_id: string; is_leader: number; role_kind: string | null; sequence: number | null; created_at: string }>;
      let currentConversation = '';
      let nextSequence = 10;
      for (const row of rows) {
        if (row.conversation_id !== currentConversation) {
          currentConversation = row.conversation_id;
          nextSequence = 10;
        }
        const roleKind = normalizeCollaborationRole(row.role_kind as CollaborationRole | null, row.is_leader === 1);
        this.database.prepare('UPDATE conversation_members SET role_kind = ?, sequence = ?, is_leader = ? WHERE rowid = ?')
          .run(roleKind, nextSequence, roleKind === 'leader' ? 1 : 0, row.rowid);
        nextSequence += 10;
      }
      this.database.prepare(`
        UPDATE conversations
        SET dispatch_mode = 'leader_route'
        WHERE conversation_type = 'group' AND (dispatch_mode IS NULL OR dispatch_mode = '')
      `).run();
      this.database.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS conversation_members_conversation_sequence
        ON conversation_members (conversation_id, sequence)
      `);
      this.database.exec('COMMIT');
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  private migrateAgentEventSequences(): void {
    this.database.exec('BEGIN');
    try {
      const runRows = this.database.prepare(`
        SELECT DISTINCT run_id FROM agent_events ORDER BY run_id ASC
      `).all() as Array<{ run_id: string }>;
      for (const { run_id: runId } of runRows) {
        const missing = this.database.prepare(`
          SELECT event_id FROM agent_events
          WHERE run_id = ? AND sequence IS NULL
          ORDER BY timestamp ASC, rowid ASC
        `).all(runId) as Array<{ event_id: string }>;
        const maxRow = this.database.prepare(`
          SELECT COALESCE(MAX(sequence), 0) AS max_sequence
          FROM agent_events WHERE run_id = ?
        `).get(runId) as { max_sequence: number };
        let next = maxRow.max_sequence + 1;
        for (const row of missing) {
          this.database.prepare('UPDATE agent_events SET sequence = ? WHERE event_id = ?')
            .run(next, row.event_id);
          next += 1;
        }
        const existing = this.database.prepare('SELECT next_sequence FROM run_event_sequences WHERE run_id = ?')
          .get(runId) as { next_sequence: number } | undefined;
        const nextSequence = Math.max(next, existing?.next_sequence ?? 1);
        this.database.prepare(`
          INSERT INTO run_event_sequences (run_id, next_sequence) VALUES (?, ?)
          ON CONFLICT(run_id) DO UPDATE SET next_sequence = excluded.next_sequence
        `).run(runId, nextSequence);
      }
      this.database.exec('UPDATE agent_events SET schema_version = 2 WHERE schema_version < 2');
      this.database.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS agent_events_run_sequence
        ON agent_events (run_id, sequence)
      `);
      this.database.exec('COMMIT');
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch {}
      throw error;
    }
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

  private migrateLegacyWorkspaceAggregates(): void {
    const workspaces = this.loadLegacyWorkspacesForMigration();
    for (const workspace of workspaces) {
      try {
        inTransaction(this.database, () => {
          const tombstone = this.database.prepare(
            'SELECT 1 FROM _workspace_tombstones WHERE workspace_id = ?',
          ).get(workspace.id);
          if (tombstone) return;
          if (!this.workspaceRepo.exists(workspace.id)) {
            this.workspaceRepo.insertWithinTransaction(workspace);
          }
          this.migrateLegacyAgentsWithinTransaction(workspace);
        });
      } catch (error) {
        if (isExpectedLegacyCanonicalPathConflict(error)) {
          console.warn(`[legacy-migration] skipped Workspace ${workspace.id}: canonical_root_path already exists`);
          continue;
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Legacy Workspace aggregate migration failed for ${workspace.id}: ${message}`, { cause: error });
      }
    }
  }

  private migrateLegacyAgentsWithinTransaction(workspace: Workspace): void {
    for (const agent of workspace.agents) {
      const existing = this.database.prepare(`
        SELECT provider_config_id FROM agent_profiles WHERE workspace_id = ? AND id = ?
      `).get(workspace.id, agent.id) as { provider_config_id: string | null } | undefined;
      const providerConfigId = existing?.provider_config_id ?? createEntityId('provider');

      if (!existing?.provider_config_id) {
        this.insertLegacyProviderConfiguration(workspace, agent, providerConfigId);
      } else {
        const provider = this.database.prepare(
          'SELECT workspace_id FROM provider_configurations WHERE id = ?',
        ).get(providerConfigId) as { workspace_id: string } | undefined;
        if (!provider || provider.workspace_id !== workspace.id) {
          throw new Error(`Legacy agent ${workspace.id}/${agent.id} has an invalid Provider Configuration binding`);
        }
      }

      if (!existing) {
        this.insertAgentProfile(workspace, agent, providerConfigId);
      } else if (!existing.provider_config_id) {
        this.database.prepare(`
          UPDATE agent_profiles SET provider_config_id = ? WHERE workspace_id = ? AND id = ?
        `).run(providerConfigId, workspace.id, agent.id);
      }
    }
  }

  private loadLegacyWorkspacesForMigration(): Workspace[] {
    const workspaces = structuredClone(this.legacy.loadWorkspaces());
    migrateLegacyKimiAgents(workspaces);
    return workspaces;
  }

  private insertLegacyProviderConfiguration(workspace: Workspace, agent: Workspace['agents'][number], providerConfigId: string): void {
    const now = workspace.updatedAt;
    this.database.prepare(`
      INSERT INTO provider_configurations (
        id, workspace_id, name, provider_type, adapter_id, runtime_mode,
        executable, args_template_json, model,
        capabilities_json, timeout_policy_json,
        approval_mode, output_mode, enabled, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'cli', ?, ?, ?, ?, ?, 'agentos', 'parsed-text', ?, 1, ?, ?)
    `).run(
      providerConfigId,
      workspace.id,
      `${agent.name} Provider`,
      providerConfigurationType(agent),
      `builtin.${agent.role}`,
      agent.cliCommand,
      JSON.stringify(agent.cliArgs),
      agent.model ?? null,
      JSON.stringify(DEFAULT_CAPABILITIES),
      JSON.stringify(DEFAULT_TIMEOUT_POLICY),
      agent.enabled ? 1 : 0,
      now,
      now,
    );
  }

  private insertAgentProfile(workspace: Workspace, agent: Workspace['agents'][number], providerConfigId: string): void {
    this.database.prepare(`
      INSERT INTO agent_profiles (
        workspace_id, id, name, agent_role, provider, role_title, system_prompt,
        permissions_json, enabled, cli_command, cli_args_json, model, thinking_effort,
        provider_config_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      workspace.id,
      agent.id,
      agent.name,
      agent.role,
      agent.provider ?? providerFromLegacyRole(agent.role),
      defaultRoleTitle(agent.role),
      defaultSystemPrompt(agent.role),
      JSON.stringify(defaultPermissions(agent.role)),
      agent.enabled ? 1 : 0,
      agent.cliCommand,
      JSON.stringify(agent.cliArgs),
      agent.model ?? null,
      agent.thinkingEffort ?? 'auto',
      providerConfigId,
      workspace.createdAt,
      workspace.updatedAt,
    );
  }

  private assertWorkspaceExists(workspaceId: string): void {
    if (this.workspaceRepo.exists(workspaceId)) return;
    const tombstone = this.database.prepare(
      'SELECT 1 FROM _workspace_tombstones WHERE workspace_id = ?',
    ).get(workspaceId);
    if (tombstone) throw new Error('Workspace not found');
    if (!this.legacy.loadWorkspaces().some(workspace => workspace.id === workspaceId)) throw new Error('Workspace not found');
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

  private getUserProfile(profileId: string): UserProfile | undefined {
    const row = this.database.prepare(`
      SELECT id, display_name, learning_enabled, created_at, updated_at
      FROM user_profiles WHERE id = ?
    `).get(profileId) as UserProfileRow | undefined;
    return row ? this.toUserProfile(row) : undefined;
  }

  private toUserProfile(row: UserProfileRow): UserProfile {
    return {
      id: row.id,
      displayName: row.display_name,
      learningEnabled: row.learning_enabled === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private toPreferenceEvidence(row: PreferenceEvidenceRow): PreferenceEvidence {
    return {
      id: row.id,
      profileId: row.profile_id,
      ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}),
      conversationId: row.conversation_id,
      runId: row.run_id,
      sourceEventId: row.source_event_id,
      dimension: row.dimension,
      contextKind: row.context_kind,
      candidateValue: row.candidate_value,
      signalType: row.signal_type,
      polarity: row.polarity,
      weight: row.weight,
      summary: row.summary,
      status: row.status,
      observedAt: row.observed_at,
      createdAt: row.created_at,
    };
  }

  private toPreferenceProjection(row: PreferenceProjectionRow): PreferenceProjection {
    return {
      id: row.id,
      profileId: row.profile_id,
      scope: row.scope,
      ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}),
      dimension: row.dimension,
      contextKind: row.context_kind,
      preferredValue: row.preferred_value,
      confidence: row.confidence,
      score: row.score,
      evidenceCount: row.evidence_count,
      independentRunCount: row.independent_run_count,
      status: row.status,
      lastSupportedAt: row.last_supported_at,
      ...(row.last_conflicted_at ? { lastConflictedAt: row.last_conflicted_at } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private toAgentProfile(row: AgentProfileRow & { provider_config_id: string | null }, runtime?: AgentRuntimeStatus): AgentProfile {
    const hasProviderConfiguration = row.provider_config_id !== null;
    const projectedProvider = hasProviderConfiguration
      ? providerFromConfigurationType(row.provider_config_provider_type)
      : (row.provider ?? providerFromLegacyRole(row.agent_role));
    const projectedCliCommand = hasProviderConfiguration
      ? row.provider_config_executable ?? row.cli_command
      : row.cli_command;
    const projectedCliArgs = hasProviderConfiguration
      ? parseJson<string[]>(row.provider_config_args_template_json ?? '[]', [])
      : parseJson<string[]>(row.cli_args_json, []);
    const projectedModel = hasProviderConfiguration ? row.provider_config_model : row.model;
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      name: row.name,
      role: row.agent_role,
      provider: projectedProvider,
      ...(runtime ? { runtime } : {}),
      roleTitle: row.role_title,
      systemPrompt: row.system_prompt,
      permissions: parseJson<AgentPermission[]>(row.permissions_json, []),
      enabled: row.enabled === 1,
      cliCommand: projectedCliCommand,
      cliArgs: projectedCliArgs,
      ...(projectedModel ? { model: projectedModel } : {}),
      thinkingEffort: normalizeThinkingEffort(row.thinking_effort),
      ...(row.provider_config_id ? { providerConfigId: row.provider_config_id } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private latestAgentRuntime(workspaceId: string, agentId: string): AgentRuntimeStatus | undefined {
    const row = this.database.prepare(`
      SELECT invocations.configured_provider, invocations.detected_provider, invocations.provider_mismatch
      FROM run_cli_invocations AS invocations
      INNER JOIN agent_runs ON agent_runs.id = invocations.run_id
      WHERE agent_runs.workspace_id = ? AND invocations.agent_id = ?
      ORDER BY invocations.completed_at DESC, invocations.started_at DESC
      LIMIT 1
    `).get(workspaceId, agentId) as { configured_provider: AgentProvider | null; detected_provider: AgentProvider | null; provider_mismatch: number } | undefined;
    if (!row?.configured_provider) return undefined;
    return {
      configuredProvider: row.configured_provider,
      ...(row.detected_provider ? { detectedProvider: row.detected_provider } : {}),
      mismatch: row.provider_mismatch === 1,
    };
  }

  private toAgentEvent(row: AgentEventRow): AgentEvent {
    return {
      eventId: row.event_id,
      schemaVersion: 2,
      type: row.event_type,
      workspaceId: row.workspace_id,
      conversationId: row.conversation_id,
      runId: row.run_id,
      ...(row.execution_id ? { executionId: row.execution_id } : {}),
      ...(row.agent_id ? { agentId: row.agent_id } : {}),
      sequence: row.sequence,
      timestamp: row.timestamp,
      payload: parseJson<Record<string, unknown>>(row.payload_json, {}),
    };
  }

  private toRunStep(row: RunStepRow): RunStep {
    return {
      id: row.id,
      stableStepKey: row.stable_step_key,
      workspaceId: row.workspace_id,
      runId: row.run_id,
      ...(row.parent_step_id ? { parentStepId: row.parent_step_id } : {}),
      ...(row.execution_id ? { executionId: row.execution_id } : {}),
      ...(row.agent_id ? { agentId: row.agent_id } : {}),
      kind: row.kind,
      title: row.title,
      status: row.status,
      sequence: row.sequence,
      attempt: row.attempt,
      createdEventSequence: row.created_event_sequence,
      updatedEventSequence: row.updated_event_sequence,
      ...(row.started_at ? { startedAt: row.started_at } : {}),
      ...(row.completed_at ? { completedAt: row.completed_at } : {}),
      ...(row.summary ? { summary: row.summary } : {}),
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
      ...((row.runtime_policy_json || row.intent === 'ask' || row.intent === 'review') ? { intent: row.intent === 'ask' || row.intent === 'review' || row.intent === 'execute' ? row.intent : 'execute' } : {}),
      ...(row.runtime_policy_json ? { runtimePolicy: parseJson(row.runtime_policy_json, undefined) } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private toRuntimeArtifact(row: RuntimeArtifactRow): RuntimeArtifact {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      runId: row.run_id,
      sourceExecutionId: row.source_execution_id,
      agentId: row.agent_id,
      type: row.artifact_type,
      title: row.title,
      ...(row.summary ? { summary: row.summary } : {}),
      ...(row.original_path ? { originalPath: row.original_path } : {}),
      ...(row.mime_type ? { mimeType: row.mime_type } : {}),
      sizeBytes: row.size_bytes,
      ...(row.sha256 ? { sha256: row.sha256 } : {}),
      contentAvailable: row.content_available === 1,
      createdAt: row.created_at,
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

function isTerminalRunStepStatus(status: RunStepStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'skipped';
}

function normalizeThinkingEffort(value: string | null | undefined): ThinkingEffort {
  return value === 'low' || value === 'medium' || value === 'high' ? value : 'auto';
}

function normalizeDispatchMode(value: string | null | undefined): GroupDispatchMode {
  return value === 'full_pipeline' || value === 'mentioned_only' ? value : 'leader_route';
}

function normalizeCollaborationRole(value: CollaborationRole | string | null | undefined, isLeader: boolean): CollaborationRole {
  if (isLeader || value === 'leader') return 'leader';
  if (value === 'reviewer' || value === 'specialist') return value;
  return 'worker';
}

function normalizeConversationMembers(members: Array<ConversationMember | LegacyConversationMember>): Array<ConversationMember & { roleKind: CollaborationRole; sequence: number }> {
  return members.map((member, index) => {
    const explicitRole = 'roleKind' in member ? member.roleKind : undefined;
    const explicitSequence = 'sequence' in member ? member.sequence : undefined;
    if (explicitRole !== undefined && !isCollaborationRole(explicitRole)) throw new Error('Group member roleKind is invalid');
    const roleTitle = member.roleTitle.trim();
    if (roleTitle.length === 0 || roleTitle.length > 80) throw new Error('Group member roleTitle must be 1-80 characters');
    if (explicitSequence !== undefined && (!Number.isInteger(explicitSequence) || explicitSequence <= 0)) throw new Error('Group member sequence must be a positive integer');
    const roleKind = normalizeCollaborationRole(explicitRole, member.isLeader === true);
    return {
      ...member,
      roleTitle,
      roleKind,
      isLeader: roleKind === 'leader',
      sequence: explicitSequence ?? (index + 1) * 10,
    };
  });
}

function isCollaborationRole(value: unknown): value is CollaborationRole {
  return value === 'leader' || value === 'worker' || value === 'reviewer' || value === 'specialist';
}

function providerFromLegacyRole(role: AgentProfile['role']): AgentProvider {
  return role === 'codex' || role === 'kimi' || role === 'opencode' || role === 'mimo' ? role : 'custom';
}

function providerFromConfigurationType(providerType: string | null): AgentProvider {
  if (providerType === 'codex' || providerType === 'opencode' || providerType === 'mimo') return providerType;
  if (providerType === 'kimicode') return 'kimi';
  return 'custom';
}

function providerConfigurationType(agent: Workspace['agents'][number]): string {
  if (agent.role === 'codex') return 'codex';
  if (agent.role === 'opencode') return 'opencode';
  if (agent.role === 'kimi') return 'kimicode';
  return 'custom-cli';
}

function providerConfigurationTypeFromAgentProvider(provider: AgentProvider | undefined): string {
  if (provider === 'codex' || provider === 'opencode') return provider;
  if (provider === 'kimi') return 'kimicode';
  return 'custom-cli';
}

function isExpectedLegacyCanonicalPathConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unique constraint failed:\s*workspaces\.canonical_root_path/i.test(message);
}

export { providerFromLegacyRole, defaultRoleTitle, defaultSystemPrompt, defaultPermissions };

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

function toPendingRunDecision(row: RunDecisionRow): PendingRunDecision {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    executionId: row.execution_id,
    kind: row.kind,
    fileChanges: parseJson<RunFileChange[]>(row.file_changes_json, []),
    allowedDecisions: parseJson<PartialWriteDecision[]>(row.allowed_decisions_json, ['keep_and_continue', 'retry_current', 'abort']),
    ...(row.resolved_decision ? { resolvedDecision: row.resolved_decision } : {}),
    createdAt: row.created_at,
    ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {}),
  };
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
