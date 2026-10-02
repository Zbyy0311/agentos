import { createHash } from 'node:crypto';
import { MemoryEntryRepository, type MemoryEntryRecord, type MemoryEntrySourceInput } from '../store/MemoryEntryRepository.js';
import { areMemoryTextFieldsSafe } from '../store/MemoryContentSafety.js';
import type { SqliteStore } from '../store/SqliteStore.js';
import { inTransaction, type TransactionDatabase } from '../store/Transaction.js';
import { deriveWorkspaceEventContext } from '../store/WorkspaceEventWriter.js';
import { isCanonicalUtcTimestamp } from '../store/CanonicalTimestamp.js';

export type MemoryWorkspaceKnowledgePromotionErrorCode =
  | 'INPUT_INVALID'
  | 'ENTRY_NOT_FOUND'
  | 'ENTRY_NOT_PROMOTABLE'
  | 'ENTRY_QUARANTINED'
  | 'VERSION_CONFLICT'
  | 'SOURCE_INVALID'
  | 'PROMOTION_FAILED';

export class MemoryWorkspaceKnowledgePromotionError extends Error {
  constructor(readonly code: MemoryWorkspaceKnowledgePromotionErrorCode) {
    super(`MEMORY_WORKSPACE_PROMOTION_${code}`);
    this.name = 'MemoryWorkspaceKnowledgePromotionError';
  }
}

export interface MemoryWorkspaceKnowledgePromotionResult {
  readonly outcome: 'created' | 'existing';
  readonly entry: MemoryEntryRecord;
  readonly sourceBinding: MemoryEntrySourceBindingRecord;
}

export interface MemoryEntrySourceBindingRecord {
  readonly workspaceId: string;
  readonly sourceEntryId: string;
  readonly sourceEntryVersion: number;
  readonly promotedEntryId: string;
  readonly promotedEntryVersion: number;
  readonly promotionEventId: string | null;
  readonly createdAt: string;
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function promotedId(sourceEntryId: string, sourceVersion: number): string {
  const digest = createHash('sha256')
    .update(`workspace-knowledge\0${sourceEntryId}\0${sourceVersion}`)
    .digest('hex')
    .slice(0, 26)
    .toUpperCase();
  return `mem_${digest}`;
}

function isCurrentAt(entry: MemoryEntryRecord, timestamp: string): boolean {
  const at = Date.parse(timestamp);
  if (!Number.isFinite(at)) return false;
  if (entry.validFrom !== null) {
    const start = Date.parse(entry.validFrom);
    if (!Number.isFinite(start) || at < start) return false;
  }
  for (const end of [entry.validUntil, entry.expiresAt]) {
    if (end === null) continue;
    const until = Date.parse(end);
    if (!Number.isFinite(until) || at >= until) return false;
  }
  return true;
}

/**
 * Copies an active task-, run-, or conversation-scoped Entry into workspace scope.
 * It preserves the source Entry and provenance, adds a source link to the
 * Entry's creation Event when one exists, and commits the new Entry, immutable
 * source Entry/version binding, and canonical Workspace Event in one transaction.
 */
export class MemoryWorkspaceKnowledgePromotionService {
  private readonly db: TransactionDatabase;
  private readonly entries: MemoryEntryRepository;

  constructor(
    private readonly store: Pick<SqliteStore, 'getDatabase' | 'workspaceEventWriter'>,
    dependencies: { readonly entries?: MemoryEntryRepository } = {},
  ) {
    this.db = store.getDatabase();
    this.entries = dependencies.entries ?? new MemoryEntryRepository(this.db);
  }

  promote(input: {
    readonly workspaceId: string;
    readonly entryId: string;
    readonly expectedVersion: number;
    readonly promotedAt: string;
  }): MemoryWorkspaceKnowledgePromotionResult {
    if (!nonBlank(input.workspaceId) || !nonBlank(input.entryId) || !isCanonicalUtcTimestamp(input.promotedAt)
      || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new MemoryWorkspaceKnowledgePromotionError('INPUT_INVALID');
    }
    try {
      return inTransaction(this.db, () => {
        const source = this.entries.findById(input.workspaceId, input.entryId);
        if (!source) throw new MemoryWorkspaceKnowledgePromotionError('ENTRY_NOT_FOUND');
        if (source.version !== input.expectedVersion) {
          throw new MemoryWorkspaceKnowledgePromotionError('VERSION_CONFLICT');
        }
        if (this.hasPendingWrongFeedback(input.workspaceId, source.id, source.version)) {
          throw new MemoryWorkspaceKnowledgePromotionError('ENTRY_QUARANTINED');
        }

        const binding = this.findBindingForSource(input.workspaceId, source.id, source.version);
        if (binding !== undefined) {
          const existing = this.entries.findById(input.workspaceId, binding.promotedEntryId);
          if (existing === undefined || existing.scope !== 'workspace'
            || binding.promotedEntryVersion > existing.version) {
            throw new MemoryWorkspaceKnowledgePromotionError('PROMOTION_FAILED');
          }
          return { outcome: 'existing', entry: existing, sourceBinding: binding };
        }

        const id = promotedId(source.id, source.version);
        const existing = this.entries.findById(input.workspaceId, id);
        if (existing !== undefined) {
          if (existing.scope !== 'workspace' || existing.title !== source.title
            || existing.summary !== source.summary || existing.content !== source.content
            || existing.category !== source.category || existing.sources.length < source.sources.length
            || !source.sources.every(reference => existing.sources.some(item => item.kind === reference.kind && item.id === reference.id))) {
            throw new MemoryWorkspaceKnowledgePromotionError('PROMOTION_FAILED');
          }
          const legacyEventId = this.findEntryCreatedEvent(input.workspaceId, existing.id) ?? null;
          this.insertBinding(input.workspaceId, source.id, source.version, existing, legacyEventId, input.promotedAt);
          return {
            outcome: 'existing', entry: existing,
            sourceBinding: this.requireBindingForSource(input.workspaceId, source.id, source.version),
          };
        }

        if (source.status !== 'active' || !['task', 'conversation', 'run'].includes(source.scope)
          || !isCurrentAt(source, input.promotedAt)) {
          throw new MemoryWorkspaceKnowledgePromotionError('ENTRY_NOT_PROMOTABLE');
        }
        if (!areMemoryTextFieldsSafe([source.title, source.summary, source.content, ...source.tags])
          || source.sensitivity === 'restricted'
          || source.sources.length === 0
          || (source.scope === 'run' && !this.runOwnershipIsValid(input.workspaceId, source))
          || !source.sources.every(reference => this.sourceBelongsToEntry(input.workspaceId, source, reference))) {
          throw new MemoryWorkspaceKnowledgePromotionError('SOURCE_INVALID');
        }

        const sourceEvent = this.findEntryCreatedEvent(input.workspaceId, source.id);
        const sources = [...source.sources];
        if (sourceEvent && !sources.some(reference => reference.kind === 'event' && reference.id === sourceEvent)) {
          sources.push({ kind: 'event', id: sourceEvent });
        }
        const created = this.entries.createEntryWithinTransaction({
          id,
          workspaceId: input.workspaceId,
          scope: 'workspace',
          category: source.category,
          authority: source.authority,
          confidence: source.confidence,
          importance: source.importance,
          title: source.title,
          summary: source.summary,
          content: source.content,
          tags: source.tags,
          status: 'active',
          pinned: source.pinned,
          validFrom: source.validFrom ?? undefined,
          validUntil: source.validUntil ?? undefined,
          expiresAt: source.expiresAt ?? undefined,
          exactContentHash: source.exactContentHash ?? undefined,
          normalizedTextHash: source.normalizedTextHash ?? undefined,
          tokenEstimate: source.tokenEstimate,
          sensitivity: source.sensitivity,
          sources,
          createdAt: input.promotedAt,
        });
        const origin = { kind: 'memory.entry_save', entryId: created.id, entryVersion: created.version } as const;
        const promotionEvent = this.store.workspaceEventWriter().appendWithinTransaction({
          type: 'memory.entry_created',
          workspaceId: created.workspaceId,
          timestamp: input.promotedAt,
          origin,
          context: deriveWorkspaceEventContext(origin),
          payload: {
            memoryEntryId: created.id,
            version: created.version,
            scope: created.scope,
            category: created.category,
            authority: created.authority,
          },
        });
        this.insertBinding(input.workspaceId, source.id, source.version, created, promotionEvent.id, input.promotedAt);
        return {
          outcome: 'created', entry: created,
          sourceBinding: this.requireBindingForSource(input.workspaceId, source.id, source.version),
        };
      });
    } catch (error) {
      if (error instanceof MemoryWorkspaceKnowledgePromotionError) throw error;
      throw new MemoryWorkspaceKnowledgePromotionError('PROMOTION_FAILED');
    }
  }

  findSourceBinding(workspaceId: string, promotedEntryId: string): MemoryEntrySourceBindingRecord | undefined {
    if (!nonBlank(workspaceId) || !nonBlank(promotedEntryId)) return undefined;
    const row = this.db.prepare(`SELECT workspace_id, source_entry_id, source_entry_version,
      promoted_entry_id, promoted_entry_version, promotion_event_id, created_at
      FROM memory_entry_source_bindings WHERE workspace_id = ? AND promoted_entry_id = ?`)
      .get(workspaceId, promotedEntryId) as {
        workspace_id: string; source_entry_id: string; source_entry_version: number;
        promoted_entry_id: string; promoted_entry_version: number; promotion_event_id: string | null; created_at: string;
      } | undefined;
    return row === undefined ? undefined : toBindingRecord(row);
  }

  private findEntryCreatedEvent(workspaceId: string, entryId: string): string | undefined {
    const row = this.db.prepare(
      `SELECT id FROM workspace_events
       WHERE workspace_id = ? AND type = 'memory.entry_created'
         AND json_extract(payload_json, '$.memoryEntryId') = ?
       ORDER BY sequence DESC LIMIT 1`,
    ).get(workspaceId, entryId) as { id: string } | undefined;
    return row?.id;
  }

  private findBindingForSource(workspaceId: string, sourceEntryId: string, sourceEntryVersion: number): MemoryEntrySourceBindingRecord | undefined {
    const row = this.db.prepare(`SELECT workspace_id, source_entry_id, source_entry_version,
      promoted_entry_id, promoted_entry_version, promotion_event_id, created_at
      FROM memory_entry_source_bindings
      WHERE workspace_id = ? AND source_entry_id = ? AND source_entry_version = ?`)
      .get(workspaceId, sourceEntryId, sourceEntryVersion) as {
        workspace_id: string; source_entry_id: string; source_entry_version: number;
        promoted_entry_id: string; promoted_entry_version: number; promotion_event_id: string | null; created_at: string;
      } | undefined;
    return row === undefined ? undefined : toBindingRecord(row);
  }

  private requireBindingForSource(workspaceId: string, sourceEntryId: string, sourceEntryVersion: number): MemoryEntrySourceBindingRecord {
    const binding = this.findBindingForSource(workspaceId, sourceEntryId, sourceEntryVersion);
    if (binding === undefined) throw new MemoryWorkspaceKnowledgePromotionError('PROMOTION_FAILED');
    return binding;
  }

  private insertBinding(
    workspaceId: string,
    sourceEntryId: string,
    sourceEntryVersion: number,
    promoted: MemoryEntryRecord,
    promotionEventId: string | null,
    createdAt: string,
  ): void {
    this.db.prepare(`INSERT INTO memory_entry_source_bindings (
      workspace_id, source_entry_id, source_entry_version, promoted_entry_id,
      promoted_entry_version, promotion_event_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(workspaceId, sourceEntryId, sourceEntryVersion, promoted.id, promoted.version, promotionEventId, createdAt);
  }

  private hasPendingWrongFeedback(workspaceId: string, entryId: string, entryVersion: number): boolean {
    const table = this.db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_feedback_actions'`,
    ).get();
    if (table === undefined) return false;
    return this.exists(
      `SELECT 1 FROM memory_feedback_actions a
       INNER JOIN memory_version_feedback f ON f.id = a.feedback_id
       WHERE a.workspace_id = ? AND a.entry_id = ? AND a.entry_version = ?
         AND f.workspace_id = a.workspace_id AND f.entry_id = a.entry_id
         AND f.entry_version = a.entry_version
         AND a.action = 'correction' AND a.status = 'pending' AND f.kind = 'wrong'
       LIMIT 1`,
      workspaceId, entryId, entryVersion,
    );
  }

  private sourceBelongsToEntry(
    workspaceId: string,
    entry: MemoryEntryRecord,
    source: MemoryEntrySourceInput,
  ): boolean {
    if (!nonBlank(source.id)) return false;
    const conversationId = entry.ownerConversationId;
    const taskId = entry.ownerTaskId;
    switch (source.kind) {
      case 'user':
        return this.exists('SELECT 1 FROM user_profiles WHERE id = ?', source.id);
      case 'conversation':
        return source.id === conversationId && (
          this.exists('SELECT 1 FROM cr_conversations WHERE workspace_id = ? AND id = ?', workspaceId, source.id)
          || this.exists('SELECT 1 FROM conversations WHERE workspace_id = ? AND id = ?', workspaceId, source.id)
        ) || entry.scope === 'run' && taskId !== null && this.exists(
          `SELECT 1 FROM tasks t WHERE t.workspace_id = ? AND t.id = ? AND t.source_conversation_id = ?
           AND (EXISTS (SELECT 1 FROM cr_conversations c WHERE c.workspace_id = t.workspace_id AND c.id = t.source_conversation_id)
             OR EXISTS (SELECT 1 FROM conversations c WHERE c.workspace_id = t.workspace_id AND c.id = t.source_conversation_id))`,
          workspaceId, taskId, source.id,
        );
      case 'message':
        return conversationId !== null && (
          this.exists('SELECT 1 FROM cr_messages WHERE workspace_id = ? AND conversation_id = ? AND id = ?', workspaceId, conversationId, source.id)
          || this.exists('SELECT 1 FROM messages WHERE workspace_id = ? AND conversation_id = ? AND id = ?', workspaceId, conversationId, source.id)
        ) || entry.scope === 'run' && taskId !== null && this.exists(
          `SELECT 1 FROM tasks t WHERE t.workspace_id = ? AND t.id = ? AND t.source_message_id = ?
           AND (EXISTS (SELECT 1 FROM cr_messages m WHERE m.workspace_id = t.workspace_id AND m.id = t.source_message_id)
             OR EXISTS (SELECT 1 FROM messages m WHERE m.workspace_id = t.workspace_id AND m.id = t.source_message_id))`,
          workspaceId, taskId, source.id,
        );
      case 'task':
        return taskId !== null && source.id === taskId
          && this.exists('SELECT 1 FROM tasks WHERE workspace_id = ? AND id = ?', workspaceId, source.id);
      case 'run':
        if (entry.ownerRunId !== null) {
          return source.id === entry.ownerRunId && taskId !== null
            && this.exists('SELECT 1 FROM runs WHERE workspace_id = ? AND task_id = ? AND id = ?', workspaceId, taskId, source.id);
        }
        if (taskId !== null) {
          return this.exists('SELECT 1 FROM runs WHERE workspace_id = ? AND task_id = ? AND id = ?', workspaceId, taskId, source.id);
        }
        return conversationId !== null
          && this.exists('SELECT 1 FROM agent_runs WHERE workspace_id = ? AND conversation_id = ? AND id = ?', workspaceId, conversationId, source.id);
      case 'stage':
        if (entry.ownerRunId !== null) return this.exists(
          'SELECT 1 FROM run_stages WHERE workspace_id = ? AND run_id = ? AND id = ?',
          workspaceId, entry.ownerRunId, source.id,
        );
        return taskId !== null && this.exists(
          'SELECT 1 FROM run_stages s JOIN runs r ON r.id = s.run_id'
            + ' WHERE s.workspace_id = ? AND r.workspace_id = ? AND r.task_id = ? AND s.id = ?',
          workspaceId, workspaceId, taskId, source.id,
        );
      case 'event':
        // Entry creation uses the canonical Workspace Event stream. Accept a
        // link only when the event belongs to this Workspace and names this
        // exact Entry; runtime-event checks below cover execution evidence.
        if (this.exists(
          `SELECT 1 FROM workspace_events
           WHERE workspace_id = ? AND id = ? AND type = 'memory.entry_created'
             AND json_extract(payload_json, '$.memoryEntryId') = ?`,
          workspaceId, source.id, entry.id,
        )) return true;
        if (entry.ownerRunId !== null) {
          return this.exists(
            'SELECT 1 FROM runtime_events e WHERE e.workspace_id = ? AND e.run_id = ? AND e.id = ?',
            workspaceId, entry.ownerRunId, source.id,
          );
        }
        if (taskId !== null) {
          return this.exists(
            'SELECT 1 FROM runtime_events e JOIN runs r ON r.id = e.run_id'
              + ' WHERE e.workspace_id = ? AND r.workspace_id = ? AND r.task_id = ? AND e.id = ?',
            workspaceId, workspaceId, taskId, source.id,
          );
        }
        return conversationId !== null && this.exists(
          'SELECT 1 FROM runtime_events e JOIN agent_runs r ON r.id = e.run_id'
            + ' WHERE e.workspace_id = ? AND r.workspace_id = ? AND r.conversation_id = ? AND e.id = ?',
          workspaceId, workspaceId, conversationId, source.id,
        );
      case 'artifact':
        if (entry.ownerRunId !== null) {
          return this.exists(
            `SELECT 1 FROM runtime_artifacts a WHERE a.workspace_id = ? AND a.id = ?
             AND a.provenance_kind = 'CANONICAL' AND a.canonical_run_id = ?`,
            workspaceId, source.id, entry.ownerRunId,
          );
        }
        if (taskId !== null) {
          return this.exists(
            'SELECT 1 FROM runtime_artifacts a JOIN runs r ON r.id = a.canonical_run_id'
              + ' WHERE a.workspace_id = ? AND r.workspace_id = ? AND r.task_id = ? AND a.id = ?',
            workspaceId, workspaceId, taskId, source.id,
          );
        }
        return conversationId !== null && this.exists(
          'SELECT 1 FROM runtime_artifacts a JOIN agent_runs r ON r.id = a.run_id'
            + ' WHERE a.workspace_id = ? AND r.workspace_id = ? AND r.conversation_id = ? AND a.id = ?',
          workspaceId, workspaceId, conversationId, source.id,
        );
      case 'import':
        return this.exists('SELECT 1 FROM memory_import_records WHERE workspace_id = ? AND fragment_hash = ?', workspaceId, source.id);
      default:
        return false;
    }
  }

  private exists(sql: string, ...params: unknown[]): boolean {
    return this.db.prepare(sql).get(...params) !== undefined;
  }

  private runOwnershipIsValid(workspaceId: string, entry: MemoryEntryRecord): boolean {
    return entry.ownerTaskId !== null && entry.ownerRunId !== null
      && this.exists(`SELECT 1 FROM runs WHERE workspace_id = ? AND task_id = ? AND id = ?
        AND status IN ('completed', 'failed', 'cancelled')`,
        workspaceId, entry.ownerTaskId, entry.ownerRunId)
      && entry.sources.some(source => source.kind === 'run' && source.id === entry.ownerRunId);
  }
}

function toBindingRecord(row: {
  workspace_id: string; source_entry_id: string; source_entry_version: number;
  promoted_entry_id: string; promoted_entry_version: number; promotion_event_id: string | null; created_at: string;
}): MemoryEntrySourceBindingRecord {
  return {
    workspaceId: row.workspace_id,
    sourceEntryId: row.source_entry_id,
    sourceEntryVersion: row.source_entry_version,
    promotedEntryId: row.promoted_entry_id,
    promotedEntryVersion: row.promoted_entry_version,
    promotionEventId: row.promotion_event_id,
    createdAt: row.created_at,
  };
}
