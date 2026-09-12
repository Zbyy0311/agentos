import {
  MEMORY_AUTHORITIES,
  MEMORY_CATEGORIES,
  MEMORY_ENTRY_STATUSES,
  MEMORY_SCOPES,
  MEMORY_SOURCE_KINDS,
  validateMemoryScopeOwner,
  type MemoryAuthority,
  type MemoryCategory,
  type MemoryEntryStatus,
  type MemoryScope,
  type MemorySourceKind,
} from '@agentos/shared';
import { inTransaction, type TransactionDatabase } from './Transaction.js';

/**
 * MF-1 Memory Entry persistence primitive.
 *
 * This is a narrow persistence seam ONLY. It contains no retrieval ranking, no
 * budget selection, no Context Snapshot, no candidate promotion, no event
 * emission, and no Provider injection; those belong to later Memory Foundation
 * slices. MF-1 only persists and reads the forward `memory_entries`,
 * `memory_entry_sources`, and `memory_entries_fts` rows.
 *
 * Frozen design: `docs/implementation/milestones/MF1-schema-authorization.md`.
 * Contracts: `packages/shared/src/types/mf0-memory-contracts.ts`.
 */

export type MemoryEntryRepositoryErrorCode =
  | 'INPUT_INVALID'
  | 'WORKSPACE_NOT_FOUND'
  | 'ENTRY_NOT_FOUND'
  | 'ENTRY_NOT_UPDATABLE'
  | 'SOURCE_REQUIRED'
  | 'PERSISTENCE_FAILED';

/** Stable, data-free error boundary. */
export class MemoryEntryRepositoryError extends Error {
  constructor(readonly code: MemoryEntryRepositoryErrorCode) {
    super(`MEMORY_ENTRY_${code}`);
    this.name = 'MemoryEntryRepositoryError';
  }
}

export interface MemoryEntrySourceInput {
  readonly kind: MemorySourceKind;
  readonly id: string;
}

export interface CreateMemoryEntryInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly scope: MemoryScope;
  readonly ownerAgentId?: string;
  readonly ownerConversationId?: string;
  readonly ownerTaskId?: string;
  readonly ownerRunId?: string;
  readonly category: MemoryCategory;
  readonly authority: MemoryAuthority;
  readonly confidence: number;
  readonly importance: number;
  readonly title: string;
  readonly summary?: string;
  readonly content?: string;
  readonly tags?: readonly string[];
  readonly status: MemoryEntryStatus;
  readonly pinned?: boolean;
  readonly validFrom?: string;
  readonly validUntil?: string;
  readonly expiresAt?: string;
  readonly exactContentHash?: string;
  readonly normalizedTextHash?: string;
  readonly tokenEstimate?: number;
  readonly sensitivity?: 'ordinary' | 'restricted';
  readonly sources: readonly MemoryEntrySourceInput[];
  readonly createdAt: string;
}

export interface UpdateMemoryEntryStatusInput {
  readonly workspaceId: string;
  readonly entryId: string;
  readonly expectedVersion: number;
  readonly status: MemoryEntryStatus;
  readonly updatedAt: string;
}

export interface ListMemoryRetrievalCandidatesInput {
  readonly workspaceId: string;
  readonly reach: readonly { readonly scope: MemoryScope; readonly ownerId: string | null }[];
  readonly statuses: readonly MemoryEntryStatus[];
}

/** LITE-07-003/107: deduplication cannot cross an Entry's ownership boundary. */
export type MemoryEntryDedupScope = Pick<CreateMemoryEntryInput,
  'scope' | 'category' | 'ownerAgentId' | 'ownerConversationId' | 'ownerTaskId' | 'ownerRunId'>;

export interface MergeExactMemorySourcesInput extends MemoryEntryDedupScope {
  readonly workspaceId: string;
  readonly entryId: string;
  readonly exactContentHash: string;
  readonly sources: readonly MemoryEntrySourceInput[];
  readonly updatedAt: string;
}

export interface MemoryEntryRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly scope: MemoryScope;
  readonly ownerAgentId: string | null;
  readonly ownerConversationId: string | null;
  readonly ownerTaskId: string | null;
  readonly ownerRunId: string | null;
  readonly category: MemoryCategory;
  readonly authority: MemoryAuthority;
  readonly confidence: number;
  readonly importance: number;
  readonly title: string;
  readonly summary: string;
  readonly content: string;
  readonly tags: readonly string[];
  readonly status: MemoryEntryStatus;
  readonly pinned: boolean;
  readonly validFrom: string | null;
  readonly validUntil: string | null;
  readonly expiresAt: string | null;
  readonly exactContentHash: string | null;
  readonly normalizedTextHash: string | null;
  readonly tokenEstimate: number;
  readonly sensitivity: 'ordinary' | 'restricted';
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sources: readonly MemoryEntrySourceInput[];
}

interface EntryRow {
  id: string;
  workspace_id: string;
  scope: string;
  owner_agent_id: string | null;
  owner_conversation_id: string | null;
  owner_task_id: string | null;
  owner_run_id: string | null;
  category: string;
  authority: string;
  confidence: number;
  importance: number;
  title: string;
  summary: string;
  content: string;
  tags_json: string;
  status: string;
  pinned: number;
  valid_from: string | null;
  valid_until: string | null;
  expires_at: string | null;
  exact_content_hash: string | null;
  normalized_text_hash: string | null;
  token_estimate: number;
  sensitivity: string;
  version: number;
  created_at: string;
  updated_at: string;
}

const SELECT_COLUMNS = [
  'id', 'workspace_id', 'scope', 'owner_agent_id', 'owner_conversation_id',
  'owner_task_id', 'owner_run_id', 'category', 'authority', 'confidence',
  'importance', 'title', 'summary', 'content', 'tags_json', 'status', 'pinned',
  'valid_from', 'valid_until', 'expires_at', 'exact_content_hash',
  'normalized_text_hash', 'token_estimate', 'sensitivity', 'version',
  'created_at', 'updated_at',
].join(', ');

const OWNER_COLUMN: Record<MemoryScope, string> = {
  global: 'owner_task_id',
  workspace: 'owner_task_id',
  agent: 'owner_agent_id',
  conversation: 'owner_conversation_id',
  task: 'owner_task_id',
  run: 'owner_run_id',
};

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function unitInterval(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isScope(value: unknown): value is MemoryScope {
  return (MEMORY_SCOPES as readonly unknown[]).includes(value);
}
function isCategory(value: unknown): value is MemoryCategory {
  return (MEMORY_CATEGORIES as readonly unknown[]).includes(value);
}
function isAuthority(value: unknown): value is MemoryAuthority {
  return (MEMORY_AUTHORITIES as readonly unknown[]).includes(value);
}
function isStatus(value: unknown): value is MemoryEntryStatus {
  return (MEMORY_ENTRY_STATUSES as readonly unknown[]).includes(value);
}
function isSourceKind(value: unknown): value is MemorySourceKind {
  return (MEMORY_SOURCE_KINDS as readonly unknown[]).includes(value);
}

function parseTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tags: string[] = [];
  for (const tag of value) {
    if (typeof tag !== 'string') return undefined;
    tags.push(tag);
  }
  return tags;
}

function toRecord(row: EntryRow, sources: readonly MemoryEntrySourceInput[]): MemoryEntryRecord {
  const tags = JSON.parse(row.tags_json) as string[];
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    scope: row.scope as MemoryScope,
    ownerAgentId: row.owner_agent_id,
    ownerConversationId: row.owner_conversation_id,
    ownerTaskId: row.owner_task_id,
    ownerRunId: row.owner_run_id,
    category: row.category as MemoryCategory,
    authority: row.authority as MemoryAuthority,
    confidence: row.confidence,
    importance: row.importance,
    title: row.title,
    summary: row.summary,
    content: row.content,
    tags,
    status: row.status as MemoryEntryStatus,
    pinned: row.pinned === 1,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    expiresAt: row.expires_at,
    exactContentHash: row.exact_content_hash,
    normalizedTextHash: row.normalized_text_hash,
    tokenEstimate: row.token_estimate,
    sensitivity: row.sensitivity as 'ordinary' | 'restricted',
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sources,
  };
}

export class MemoryEntryRepository {
  constructor(private readonly db: TransactionDatabase) {}

  /** @internal Read-only database seam for the MF-3 retrieval service. */
  getDatabase(): TransactionDatabase {
    return this.db;
  }

  /**
   * Insert a forward Memory Entry with its sources and FTS row in one
   * transaction. Fails closed on any invalid input; never fabricates a missing
   * owner or a default Scope.
   */
  createEntry(input: CreateMemoryEntryInput): MemoryEntryRecord {
    try {
      return inTransaction(this.db, () => this.createEntryWithinTransaction(input));
    } catch (error) {
      throw this.publicError(error);
    }
  }

  /**
   * MF-5 emission seam: perform the Entry write inside an ALREADY ACTIVE
   * transaction so a caller can commit the Entry and its Runtime Event +
   * Outbox row atomically. The caller owns BEGIN/COMMIT.
   */
  createEntryWithinTransaction(input: CreateMemoryEntryInput): MemoryEntryRecord {
    const validated = this.validateCreateInput(input);
    this.assertWorkspaceExists(validated.workspaceId);
    this.db.prepare(
      'INSERT INTO memory_entries ('
        + SELECT_COLUMNS
        + ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      validated.id, validated.workspaceId, validated.scope,
      validated.ownerAgentId ?? null, validated.ownerConversationId ?? null,
      validated.ownerTaskId ?? null, validated.ownerRunId ?? null,
      validated.category, validated.authority, validated.confidence,
      validated.importance, validated.title, validated.summary ?? '',
      validated.content ?? '', JSON.stringify(validated.tags ?? []),
      validated.status, validated.pinned === true ? 1 : 0,
      validated.validFrom ?? null, validated.validUntil ?? null,
      validated.expiresAt ?? null, validated.exactContentHash ?? null,
      validated.normalizedTextHash ?? null, validated.tokenEstimate ?? 0,
      validated.sensitivity ?? 'ordinary', 1, validated.createdAt,
      validated.createdAt,
    );
    for (const source of validated.sources) {
      this.db.prepare(
        'INSERT INTO memory_entry_sources (memory_entry_id, source_kind, source_id) VALUES (?, ?, ?)',
      ).run(validated.id, source.kind, source.id);
    }
    this.replaceFts(validated.id, validated.title, validated.content ?? '', validated.summary ?? '', (validated.tags ?? []).join(' '));
    return this.requireEntry(validated.workspaceId, validated.id);
  }

  /** Read one Entry with its sources; Workspace-scoped. */
  findById(workspaceId: string, entryId: string): MemoryEntryRecord | undefined {
    if (!nonBlank(workspaceId) || !nonBlank(entryId)) return undefined;
    const row = this.db.prepare(
      'SELECT ' + SELECT_COLUMNS + ' FROM memory_entries WHERE workspace_id = ? AND id = ?',
    ).get(workspaceId, entryId) as EntryRow | undefined;
    if (row === undefined) return undefined;
    return toRecord(row, this.readSources(entryId));
  }

  /**
   * Update the Entry status under optimistic concurrency. `version` must match
   * and the new version increments by exactly one (enforced by trigger).
   */
  updateStatus(input: UpdateMemoryEntryStatusInput): MemoryEntryRecord {
    try {
      return inTransaction(this.db, () => this.updateStatusWithinTransaction(input));
    } catch (error) {
      throw this.publicError(error);
    }
  }

  /**
   * MF-5 emission seam: perform the status update inside an ALREADY ACTIVE
   * transaction so a caller can commit the update and its Runtime Event +
   * Outbox row atomically. The caller owns BEGIN/COMMIT.
   */
  updateStatusWithinTransaction(input: UpdateMemoryEntryStatusInput): MemoryEntryRecord {
    if (!nonBlank(input.workspaceId) || !nonBlank(input.entryId) || !isStatus(input.status)
      || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1
      || !nonBlank(input.updatedAt)) {
      throw new MemoryEntryRepositoryError('INPUT_INVALID');
    }
    const current = this.db.prepare(
      'SELECT ' + SELECT_COLUMNS + ' FROM memory_entries WHERE workspace_id = ? AND id = ?',
    ).get(input.workspaceId, input.entryId) as EntryRow | undefined;
    if (current === undefined) throw new MemoryEntryRepositoryError('ENTRY_NOT_FOUND');
    if (current.status === 'deleted') throw new MemoryEntryRepositoryError('ENTRY_NOT_UPDATABLE');
    if (current.version !== input.expectedVersion) {
      throw new MemoryEntryRepositoryError('ENTRY_NOT_UPDATABLE');
    }
    this.db.prepare(
      'UPDATE memory_entries SET status = ?, version = version + 1, updated_at = ? WHERE workspace_id = ? AND id = ? AND version = ?',
    ).run(input.status, input.updatedAt, input.workspaceId, input.entryId, input.expectedVersion);
    return this.requireEntry(input.workspaceId, input.entryId);
  }

  /** Soft delete (status = 'deleted'); never a hard row removal. */
  softDelete(workspaceId: string, entryId: string, expectedVersion: number, updatedAt: string): MemoryEntryRecord {
    return this.updateStatus({ workspaceId, entryId, expectedVersion, status: 'deleted', updatedAt });
  }

  /** Caller owns the transaction and the corresponding canonical Event. */
  mergeExactSourcesWithinTransaction(input: MergeExactMemorySourcesInput): { record: MemoryEntryRecord; changed: boolean } | undefined {
    if (!nonBlank(input.exactContentHash) || !nonBlank(input.updatedAt)
      || !Array.isArray(input.sources) || input.sources.length === 0
      || input.sources.some(source => !isSourceKind(source.kind) || !nonBlank(source.id))) {
      throw new MemoryEntryRepositoryError('INPUT_INVALID');
    }
    const current = this.findById(input.workspaceId, input.entryId);
    if (current === undefined || current.status !== 'active' || current.exactContentHash !== input.exactContentHash
      || current.scope !== input.scope || current.category !== input.category
      || current.ownerAgentId !== (input.ownerAgentId ?? null)
      || current.ownerConversationId !== (input.ownerConversationId ?? null)
      || current.ownerTaskId !== (input.ownerTaskId ?? null)
      || current.ownerRunId !== (input.ownerRunId ?? null)) {
      // The pre-transaction match became ineligible: no writes, caller may
      // continue generating the review Candidate. Persistence failures still throw.
      return undefined;
    }
    let added = 0;
    for (const source of input.sources) {
      const result = this.db.prepare(
        'INSERT OR IGNORE INTO memory_entry_sources (memory_entry_id, source_kind, source_id) VALUES (?, ?, ?)',
      ).run(current.id, source.kind, source.id) as { changes: number | bigint };
      added += Number(result.changes);
    }
    if (added > 0) {
      const update = this.db.prepare(
        'UPDATE memory_entries SET version = version + 1, updated_at = ? WHERE workspace_id = ? AND id = ? AND version = ?',
      ).run(input.updatedAt, input.workspaceId, current.id, current.version) as { changes: number | bigint };
      if (Number(update.changes) !== 1) throw new MemoryEntryRepositoryError('ENTRY_NOT_UPDATABLE');
    }
    return { record: this.requireEntry(input.workspaceId, current.id), changed: added > 0 };
  }

  /** Pure validation also used before explicit-save duplicate lookup (LITE-07-107). */
  validateCreateInput(input: CreateMemoryEntryInput): CreateMemoryEntryInput {
    if (typeof input !== 'object' || input === null) throw new MemoryEntryRepositoryError('INPUT_INVALID');
    if (!nonBlank(input.id) || !nonBlank(input.workspaceId)) {
      throw new MemoryEntryRepositoryError('INPUT_INVALID');
    }
    if (!isScope(input.scope) || !isCategory(input.category)
      || !isAuthority(input.authority) || !isStatus(input.status)) {
      throw new MemoryEntryRepositoryError('INPUT_INVALID');
    }
    const owner = validateMemoryScopeOwner({
      scope: input.scope,
      ...(input.scope === 'global' ? {} : { workspaceId: input.workspaceId }),
      ...(input.ownerAgentId === undefined ? {} : { agentId: input.ownerAgentId }),
      ...(input.ownerConversationId === undefined ? {} : { conversationId: input.ownerConversationId }),
      ...(input.ownerTaskId === undefined ? {} : { taskId: input.ownerTaskId }),
      ...(input.ownerRunId === undefined ? {} : { runId: input.ownerRunId }),
    });
    if (!owner.valid) throw new MemoryEntryRepositoryError('INPUT_INVALID');
    if (!unitInterval(input.confidence) || !unitInterval(input.importance)) {
      throw new MemoryEntryRepositoryError('INPUT_INVALID');
    }
    if (!nonBlank(input.title) || !nonBlank(input.createdAt)) {
      throw new MemoryEntryRepositoryError('INPUT_INVALID');
    }
    if (input.tags !== undefined && parseTags(input.tags) === undefined) {
      throw new MemoryEntryRepositoryError('INPUT_INVALID');
    }
    if (input.tokenEstimate !== undefined
      && (!Number.isSafeInteger(input.tokenEstimate) || input.tokenEstimate < 0)) {
      throw new MemoryEntryRepositoryError('INPUT_INVALID');
    }
    if (!Array.isArray(input.sources)) throw new MemoryEntryRepositoryError('INPUT_INVALID');
    const seen = new Set<string>();
    for (const source of input.sources) {
      if (typeof source !== 'object' || source === null || !isSourceKind(source.kind) || !nonBlank(source.id)) {
        throw new MemoryEntryRepositoryError('INPUT_INVALID');
      }
      const key = source.kind + ' ' + source.id;
      if (seen.has(key)) throw new MemoryEntryRepositoryError('INPUT_INVALID');
      seen.add(key);
    }
    // Automatic Entries require at least one stable source (MF-0 rule).
    if (input.authority !== 'user-explicit' && input.sources.length < 1) {
      throw new MemoryEntryRepositoryError('SOURCE_REQUIRED');
    }
    return input;
  }

  private assertWorkspaceExists(workspaceId: string): void {
    const row = this.db.prepare('SELECT 1 AS present FROM workspaces WHERE id = ?').get(workspaceId);
    if (row === undefined) throw new MemoryEntryRepositoryError('WORKSPACE_NOT_FOUND');
  }

  private requireEntry(workspaceId: string, entryId: string): MemoryEntryRecord {
    const entry = this.findById(workspaceId, entryId);
    if (entry === undefined) throw new MemoryEntryRepositoryError('ENTRY_NOT_FOUND');
    return entry;
  }

  /**
   * Scope-filtered retrieval candidates for one Workspace.
   *
   * Only rows whose Scope/owner pair is in `reach` are considered, and only
   * statuses eligible for retrieval. `ftsQuery` is optional; when supplied, the
   * FTS5 rank is joined in but rows are never dropped for a zero/absent rank
   * (structured filters remain authoritative).
   */
  listRetrievalCandidates(input: ListMemoryRetrievalCandidatesInput): MemoryEntryRecord[] {
    if (!nonBlank(input.workspaceId)) throw new MemoryEntryRepositoryError('INPUT_INVALID');
    if (input.reach.length === 0) return [];
    const scopeClauses: string[] = [];
    const params: unknown[] = [input.workspaceId];
    for (const reach of input.reach) {
      scopeClauses.push('(scope = ? AND ' + OWNER_COLUMN[reach.scope] + ' IS ?)');
      params.push(reach.scope, reach.ownerId);
    }
    const statusClauses = input.statuses.map(() => '?').join(', ');
    params.push(...input.statuses);
    const rows = this.db.prepare(
      'SELECT ' + SELECT_COLUMNS + ' FROM memory_entries'
        + ' WHERE workspace_id = ?'
        + ' AND (' + scopeClauses.join(' OR ') + ')'
        + ' AND status IN (' + statusClauses + ')'
        + ' ORDER BY updated_at DESC, id ASC',
    ).all(...params) as EntryRow[];
    return rows.map(row => toRecord(row, this.readSources(row.id)));
  }

  private readSources(entryId: string): MemoryEntrySourceInput[] {    const rows = this.db.prepare(
      'SELECT source_kind, source_id FROM memory_entry_sources WHERE memory_entry_id = ? ORDER BY source_kind ASC, source_id ASC',
    ).all(entryId) as Array<{ source_kind: string; source_id: string }>;
    return rows.map(row => ({ kind: row.source_kind as MemorySourceKind, id: row.source_id }));
  }

  private replaceFts(entryId: string, title: string, content: string, summary: string, tags: string): void {
    this.db.prepare('DELETE FROM memory_entries_fts WHERE memory_entry_id = ?').run(entryId);
    this.db.prepare(
      'INSERT INTO memory_entries_fts (memory_entry_id, title, content, summary, tags) VALUES (?, ?, ?, ?, ?)',
    ).run(entryId, title, content, summary, tags);
  }

  /** Collapse internal errors to the stable, data-free public boundary. */
  private publicError(error: unknown): MemoryEntryRepositoryError {
    if (error instanceof MemoryEntryRepositoryError) return error;
    return new MemoryEntryRepositoryError('PERSISTENCE_FAILED');
  }
}
