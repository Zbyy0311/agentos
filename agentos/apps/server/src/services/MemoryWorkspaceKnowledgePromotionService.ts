import { createHash } from 'node:crypto';
import { MemoryEntryRepository, type MemoryEntryRecord, type MemoryEntrySourceInput } from '../store/MemoryEntryRepository.js';
import { areMemoryTextFieldsSafe } from '../store/MemoryContentSafety.js';
import type { SqliteStore } from '../store/SqliteStore.js';
import { inTransaction, type TransactionDatabase } from '../store/Transaction.js';
import { deriveWorkspaceEventContext } from '../store/WorkspaceEventWriter.js';

export type MemoryWorkspaceKnowledgePromotionErrorCode =
  | 'INPUT_INVALID'
  | 'ENTRY_NOT_FOUND'
  | 'ENTRY_NOT_PROMOTABLE'
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

/**
 * Copies an active task- or conversation-scoped Entry into workspace scope.
 * It preserves the source Entry and provenance, adds a source link to the
 * Entry's creation Event when one exists, and commits the new Entry with its
 * canonical Workspace Event in one transaction.
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
    if (!nonBlank(input.workspaceId) || !nonBlank(input.entryId) || !nonBlank(input.promotedAt)
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
        if (source.status !== 'active' || (source.scope !== 'task' && source.scope !== 'conversation')) {
          throw new MemoryWorkspaceKnowledgePromotionError('ENTRY_NOT_PROMOTABLE');
        }
        if (!areMemoryTextFieldsSafe([source.title, source.summary, source.content, ...source.tags])
          || source.sensitivity === 'restricted'
          || source.sources.length === 0
          || !source.sources.every(reference => this.sourceBelongsToEntry(input.workspaceId, source, reference))) {
          throw new MemoryWorkspaceKnowledgePromotionError('SOURCE_INVALID');
        }

        const id = promotedId(source.id, source.version);
        const existing = this.entries.findById(input.workspaceId, id);
        if (existing) {
          if (existing.scope !== 'workspace' || existing.title !== source.title
            || existing.summary !== source.summary || existing.content !== source.content
            || existing.category !== source.category || existing.sources.length < source.sources.length
            || !source.sources.every(reference => existing.sources.some(item => item.kind === reference.kind && item.id === reference.id))) {
            throw new MemoryWorkspaceKnowledgePromotionError('PROMOTION_FAILED');
          }
          return { outcome: 'existing', entry: existing };
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
        this.store.workspaceEventWriter().appendWithinTransaction({
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
        return { outcome: 'created', entry: created };
      });
    } catch (error) {
      if (error instanceof MemoryWorkspaceKnowledgePromotionError) throw error;
      throw new MemoryWorkspaceKnowledgePromotionError('PROMOTION_FAILED');
    }
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
        );
      case 'message':
        return conversationId !== null && (
          this.exists('SELECT 1 FROM cr_messages WHERE workspace_id = ? AND conversation_id = ? AND id = ?', workspaceId, conversationId, source.id)
          || this.exists('SELECT 1 FROM messages WHERE workspace_id = ? AND conversation_id = ? AND id = ?', workspaceId, conversationId, source.id)
        );
      case 'task':
        return taskId !== null && source.id === taskId
          && this.exists('SELECT 1 FROM tasks WHERE workspace_id = ? AND id = ?', workspaceId, source.id);
      case 'run':
        if (taskId !== null) {
          return this.exists('SELECT 1 FROM runs WHERE workspace_id = ? AND task_id = ? AND id = ?', workspaceId, taskId, source.id);
        }
        return conversationId !== null
          && this.exists('SELECT 1 FROM agent_runs WHERE workspace_id = ? AND conversation_id = ? AND id = ?', workspaceId, conversationId, source.id);
      case 'stage':
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
}
