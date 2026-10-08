import type { TransactionDatabase } from '../store/Transaction.js';

/**
 * CR-6 unified Agent History read surface.
 *
 * Product authority: docs/Runtime-Specification lite/09-Conversation-Runtime.md section 13
 * and docs/Runtime-Specification lite/11-API-Specification.md section 16.
 *
 * Frozen rules:
 *
 * - History is a READ over existing durable tables; this slice adds no migration and
 *   no write path. Conversation archive/restore is already merged (CR-1) and is not
 *   re-implemented here.
 * - History is unified by Agent Profile across Providers: every entry is keyed by the
 *   durable Agent id, never by a Provider-native session id.
 * - Secrets never enter search: no content column is returned by this surface, and the
 *   `q` text filter matches only non-secret-bearing labels (Task titles, Artifact
 *   titles/summaries, Memory titles/summaries). Message body search is deliberately
 *   NOT in this slice; it requires the sanitization gate that arrives with the
 *   Direct Conversation UX step. Filtering by content TYPE (kind) is supported.
 * - No route or transport is added here; the API surface belongs to the UI step.
 */

export type AgentHistoryKind =
  | 'conversation'
  | 'message'
  | 'turn'
  | 'task'
  | 'run'
  | 'memory'
  | 'context-snapshot'
  | 'turn-context'
  | 'artifact';

export const AGENT_HISTORY_KINDS: readonly AgentHistoryKind[] = [
  'conversation', 'message', 'turn', 'task', 'run',
  'memory', 'context-snapshot', 'turn-context', 'artifact',
];

export interface AgentHistoryFilter {
  readonly conversationId?: string;
  readonly taskId?: string;
  readonly runId?: string;
  /** Filter Turns by their Provider Session's Provider Configuration id. */
  readonly providerConfigId?: string;
  readonly kind?: AgentHistoryKind;
  readonly status?: string;
  readonly from?: string;
  readonly to?: string;
  /** Non-secret-bearing label search (titles/summaries only). */
  readonly q?: string;
  readonly limit?: number;
}

export interface AgentHistoryEntry {
  readonly kind: AgentHistoryKind;
  readonly id: string;
  readonly at: string;
  readonly status: string | null;
  /** Non-secret-bearing label (title/summary); null for kinds that carry none. */
  readonly label: string | null;
  readonly conversationId: string | null;
  readonly taskId: string | null;
  readonly runId: string | null;
  readonly messageId: string | null;
  readonly turnId: string | null;
  readonly providerSessionId: string | null;
  readonly referenceId: string | null;
}

export type AgentHistoryErrorCode = 'HISTORY_INPUT_INVALID';

export class AgentHistoryError extends Error {
  constructor(readonly code: AgentHistoryErrorCode) {
    super(`AGENT_HISTORY_${code}`);
    this.name = 'AgentHistoryError';
  }
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

interface Row { [key: string]: unknown }

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIsoLike(value: unknown): value is string {
  return nonBlank(value) && !Number.isNaN(Date.parse(value));
}

export class AgentHistoryService {
  constructor(private readonly db: TransactionDatabase) {}

  /**
   * Unified, time-ordered History for one Agent. Filters compose; every entry is a
   * durable reference and never a content-bearing record.
   */
  history(workspaceId: string, agentId: string, filter: AgentHistoryFilter = {}): AgentHistoryEntry[] {
    this.assertInput(workspaceId, agentId, filter);
    const kinds = filter.kind !== undefined ? [filter.kind] : AGENT_HISTORY_KINDS;
    const entries: AgentHistoryEntry[] = [];
    if (kinds.includes('conversation')) entries.push(...this.conversationEntries(workspaceId, agentId, filter));
    if (kinds.includes('message')) entries.push(...this.messageEntries(workspaceId, agentId, filter));
    if (kinds.includes('turn')) entries.push(...this.turnEntries(workspaceId, agentId, filter));
    if (kinds.includes('task')) entries.push(...this.taskEntries(workspaceId, agentId, filter));
    if (kinds.includes('run')) entries.push(...this.runEntries(workspaceId, agentId, filter));
    if (kinds.includes('memory')) entries.push(...this.memoryEntries(workspaceId, agentId, filter));
    if (kinds.includes('context-snapshot')) entries.push(...this.contextSnapshotEntries(workspaceId, agentId, filter));
    if (kinds.includes('turn-context')) entries.push(...this.turnContextEntries(workspaceId, agentId, filter));
    if (kinds.includes('artifact')) entries.push(...this.artifactEntries(workspaceId, agentId, filter));
    const limit = filter.limit ?? DEFAULT_LIMIT;
    return entries
      .filter(entry => this.matchesCommon(entry, filter))
      .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))
      .slice(0, limit);
  }

  private matchesCommon(entry: AgentHistoryEntry, filter: AgentHistoryFilter): boolean {
    if (filter.status !== undefined && entry.status !== filter.status) return false;
    if (filter.from !== undefined && entry.at < filter.from) return false;
    if (filter.to !== undefined && entry.at > filter.to) return false;
    // Cross-kind linkage filters exclude any entry that does not carry that link.
    if (filter.conversationId !== undefined && entry.conversationId !== filter.conversationId) return false;
    if (filter.taskId !== undefined && entry.taskId !== filter.taskId) return false;
    if (filter.runId !== undefined && entry.runId !== filter.runId) return false;
    if (nonBlank(filter.q)) {
      const q = filter.q!.toLowerCase();
      // Memory and Artifact entries already q-matched on title + summary in their
      // kind query. For every other kind, q matches only the non-secret-bearing label;
      // message/turn bodies are never searched.
      if (entry.kind !== 'memory' && entry.kind !== 'artifact'
        && (entry.label === null || !entry.label.toLowerCase().includes(q))) {
        return false;
      }
    }
    return true;
  }

  private conversationEntries(workspaceId: string, agentId: string, filter: AgentHistoryFilter): AgentHistoryEntry[] {
    const rows = this.db.prepare(
      `SELECT c.id, c.status, c.created_at, c.title FROM cr_conversations c
       JOIN cr_conversation_members m
         ON m.conversation_id = c.id AND m.workspace_id = c.workspace_id
       WHERE c.workspace_id = ? AND m.subject_type = 'agent' AND m.subject_id = ?
       ORDER BY c.created_at DESC`,
    ).all(workspaceId, agentId) as Row[];
    return rows
      .filter(row => filter.conversationId === undefined || row.id === filter.conversationId)
      .map(row => ({
        kind: 'conversation' as const,
        id: String(row.id),
        at: String(row.created_at),
        status: String(row.status),
        label: null,
        conversationId: String(row.id),
        taskId: null, runId: null, messageId: null, turnId: null,
        providerSessionId: null, referenceId: String(row.id),
      }));
  }

  private messageEntries(workspaceId: string, agentId: string, filter: AgentHistoryFilter): AgentHistoryEntry[] {
    const rows = this.db.prepare(
      `SELECT id, conversation_id, task_id, run_id, status, created_at FROM cr_messages
       WHERE workspace_id = ? AND sender_agent_id = ? ORDER BY created_at DESC`,
    ).all(workspaceId, agentId) as Row[];
    return rows
      .filter(row => filter.conversationId === undefined || row.conversation_id === filter.conversationId)
      .filter(row => filter.taskId === undefined || row.task_id === filter.taskId)
      .filter(row => filter.runId === undefined || row.run_id === filter.runId)
      .map(row => ({
        kind: 'message' as const,
        id: String(row.id),
        at: String(row.created_at),
        status: String(row.status),
        label: null,                                  // message content is never surfaced here
        conversationId: String(row.conversation_id),
        taskId: row.task_id === null ? null : String(row.task_id),
        runId: row.run_id === null ? null : String(row.run_id),
        messageId: String(row.id), turnId: null,
        providerSessionId: null, referenceId: String(row.id),
      }));
  }

  private turnEntries(workspaceId: string, agentId: string, filter: AgentHistoryFilter): AgentHistoryEntry[] {
    const rows = this.db.prepare(
      `SELECT id, conversation_id, task_id, run_id, status, provider_session_id, created_at FROM cr_agent_turns
       WHERE workspace_id = ? AND agent_id = ? ORDER BY created_at DESC`,
    ).all(workspaceId, agentId) as Row[];
    return rows
      .filter(row => filter.conversationId === undefined || row.conversation_id === filter.conversationId)
      .filter(row => filter.taskId === undefined || row.task_id === filter.taskId)
      .filter(row => filter.runId === undefined || row.run_id === filter.runId)
      .filter(row => {
        if (filter.providerConfigId === undefined) return true;
        if (row.provider_session_id === null) return false;
        return this.providerConfigOfSession(String(row.provider_session_id)) === filter.providerConfigId;
      })
      .map(row => ({
        kind: 'turn' as const,
        id: String(row.id),
        at: String(row.created_at),
        status: String(row.status),
        label: null,
        conversationId: String(row.conversation_id),
        taskId: row.task_id === null ? null : String(row.task_id),
        runId: row.run_id === null ? null : String(row.run_id),
        messageId: null, turnId: String(row.id),
        providerSessionId: row.provider_session_id === null ? null : String(row.provider_session_id),
        referenceId: String(row.id),
      }));
  }

  private taskEntries(workspaceId: string, agentId: string, filter: AgentHistoryFilter): AgentHistoryEntry[] {
    const rows = this.db.prepare(
      `SELECT id, status, title, created_at FROM tasks WHERE workspace_id = ? AND
        (created_by = ? OR id IN (SELECT task_id FROM cr_agent_turns WHERE agent_id = ?))
       ORDER BY created_at DESC`,
    ).all(workspaceId, agentId, agentId) as Row[];
    return rows
      .filter(row => filter.taskId === undefined || row.id === filter.taskId)
      .map(row => ({
        kind: 'task' as const,
        id: String(row.id),
        at: String(row.created_at),
        status: String(row.status),
        label: String(row.title),
        conversationId: null, runId: null, messageId: null, turnId: null,
        taskId: String(row.id),
        providerSessionId: null, referenceId: String(row.id),
      }));
  }

  private runEntries(workspaceId: string, agentId: string, filter: AgentHistoryFilter): AgentHistoryEntry[] {
    const rows = this.db.prepare(
      `SELECT id, task_id, status, created_at FROM runs WHERE workspace_id = ? AND
        (task_id IN (SELECT id FROM tasks WHERE workspace_id = ? AND created_by = ?)
         OR id IN (SELECT run_id FROM cr_agent_turns WHERE agent_id = ?))
       ORDER BY created_at DESC`,
    ).all(workspaceId, workspaceId, agentId, agentId) as Row[];
    return rows
      .filter(row => filter.runId === undefined || row.id === filter.runId)
      .filter(row => filter.taskId === undefined || row.task_id === filter.taskId)
      .map(row => ({
        kind: 'run' as const,
        id: String(row.id),
        at: String(row.created_at),
        status: String(row.status),
        label: null,
        conversationId: null,
        taskId: String(row.task_id),
        runId: String(row.id), messageId: null, turnId: null,
        providerSessionId: null, referenceId: String(row.id),
      }));
  }

  private memoryEntries(workspaceId: string, agentId: string, filter: AgentHistoryFilter): AgentHistoryEntry[] {
    const rows = this.db.prepare(
      `SELECT id, status, title, summary, created_at FROM memory_entries
       WHERE workspace_id = ? AND owner_agent_id = ? ORDER BY created_at DESC`,
    ).all(workspaceId, agentId) as Row[];
    return rows
      .filter(row => this.labelMatches(filter, String(row.title) + ' ' + String(row.summary)))
      .map(row => ({
        kind: 'memory' as const,
        id: String(row.id),
        at: String(row.created_at),
        status: String(row.status),
        label: String(row.title),
        conversationId: null, taskId: null, runId: null, messageId: null, turnId: null,
        providerSessionId: null, referenceId: String(row.id),
      }));
  }

  private contextSnapshotEntries(workspaceId: string, agentId: string, filter: AgentHistoryFilter): AgentHistoryEntry[] {
    const rows = this.db.prepare(
      `SELECT id, run_id, created_at FROM memory_context_snapshots
       WHERE workspace_id = ? AND agent_id = ? ORDER BY created_at DESC`,
    ).all(workspaceId, agentId) as Row[];
    return rows
      .filter(row => filter.runId === undefined || row.run_id === filter.runId)
      .map(row => ({
        kind: 'context-snapshot' as const,
        id: String(row.id),
        at: String(row.created_at),
        status: null,
        label: null,
        conversationId: null, taskId: null, messageId: null, turnId: null,
        runId: row.run_id === null ? null : String(row.run_id),
        providerSessionId: null, referenceId: String(row.id),
      }));
  }

  private turnContextEntries(workspaceId: string, agentId: string, filter: AgentHistoryFilter): AgentHistoryEntry[] {
    const rows = this.db.prepare(
      `SELECT id, conversation_id, turn_id, created_at FROM cr_turn_context_snapshots
       WHERE workspace_id = ? AND agent_id = ? ORDER BY created_at DESC`,
    ).all(workspaceId, agentId) as Row[];
    return rows
      .filter(row => filter.conversationId === undefined || row.conversation_id === filter.conversationId)
      .map(row => ({
        kind: 'turn-context' as const,
        id: String(row.id),
        at: String(row.created_at),
        status: null,
        label: null,
        conversationId: String(row.conversation_id),
        taskId: null, runId: null, messageId: null,
        turnId: row.turn_id === null ? null : String(row.turn_id),
        providerSessionId: null, referenceId: String(row.id),
      }));
  }

  private artifactEntries(workspaceId: string, agentId: string, filter: AgentHistoryFilter): AgentHistoryEntry[] {
    const rows = this.db.prepare(
      `SELECT id, run_id, canonical_run_id, title, summary, artifact_type, created_at FROM runtime_artifacts
       WHERE workspace_id = ? AND agent_id = ? ORDER BY created_at DESC`,
    ).all(workspaceId, agentId) as Row[];
    return rows
      .filter(row => filter.runId === undefined || row.run_id === filter.runId)
      .filter(row => this.labelMatches(filter, String(row.title) + ' ' + String(row.summary ?? '')))
      .map(row => ({
        kind: 'artifact' as const,
        id: String(row.id),
        at: String(row.created_at),
        status: null,
        label: String(row.title),
        conversationId: null, taskId: null, messageId: null, turnId: null,
        // LEGACY artifacts reference agent_runs; CANONICAL artifacts reference runs.
        runId: (row.run_id ?? row.canonical_run_id) === null ? null : String(row.run_id ?? row.canonical_run_id),
        providerSessionId: null, referenceId: String(row.id),
      }));
  }

  private providerConfigOfSession(providerSessionId: string): string | null {
    const row = this.db.prepare(
      'SELECT provider_config_id FROM provider_sessions WHERE id = ?',
    ).get(providerSessionId) as Row | undefined;
    return row === undefined || row.provider_config_id === null ? null : String(row.provider_config_id);
  }

  private labelMatches(filter: AgentHistoryFilter, label: string): boolean {
    if (!nonBlank(filter.q)) return true;
    return label.toLowerCase().includes(filter.q!.toLowerCase());
  }

  private assertInput(workspaceId: string, agentId: string, filter: AgentHistoryFilter): void {
    if (!nonBlank(workspaceId) || !nonBlank(agentId)) {
      throw new AgentHistoryError('HISTORY_INPUT_INVALID');
    }
    if (filter.kind !== undefined && !AGENT_HISTORY_KINDS.includes(filter.kind)) {
      throw new AgentHistoryError('HISTORY_INPUT_INVALID');
    }
    if ((filter.from !== undefined && !isIsoLike(filter.from)) || (filter.to !== undefined && !isIsoLike(filter.to))) {
      throw new AgentHistoryError('HISTORY_INPUT_INVALID');
    }
    if (filter.limit !== undefined && (!Number.isSafeInteger(filter.limit) || filter.limit < 1 || filter.limit > MAX_LIMIT)) {
      throw new AgentHistoryError('HISTORY_INPUT_INVALID');
    }
  }
}
