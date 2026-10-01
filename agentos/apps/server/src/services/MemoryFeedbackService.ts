import { createHash, randomUUID } from 'node:crypto';
import type { MemoryContextOwnerKind, MemoryVersionFeedbackRequestV1 } from '@agentos/shared';
import { MemoryEntryRepository } from '../store/MemoryEntryRepository.js';
import { MemoryContextSnapshotRepository } from '../store/MemoryContextSnapshotRepository.js';
import { TurnContextSnapshotRepository } from '../store/TurnContextSnapshotRepository.js';
import { MemoryExecutionContextRepository } from '../store/MemoryExecutionContextRepository.js';
import { inTransaction, type TransactionDatabase } from '../store/Transaction.js';
import { isMemoryTextSafe } from '../store/MemoryContentSafety.js';

export type MemoryFeedbackKind = 'helpful' | 'wrong' | 'outdated';
export type MemoryFeedbackActionKind = 'correction' | 'revalidation';
export type MemoryFeedbackActionStatus = 'pending' | 'resolved' | 'rejected';

/** Public API shape; database snake_case columns never escape the service. */
export interface MemoryFeedbackActionDto {
  readonly id: string;
  readonly feedbackId: string;
  readonly workspaceId: string;
  readonly memoryId: string;
  readonly memoryVersion: number;
  readonly action: MemoryFeedbackActionKind;
  readonly status: MemoryFeedbackActionStatus;
  readonly version: number;
  readonly createdAt: string;
}

/** `memoryVersion` is the frozen selected version; currentEntryVersion is the CAS version at submission. */
export interface MemoryVersionFeedbackDto {
  readonly id: string;
  readonly workspaceId: string;
  readonly memoryId: string;
  readonly memoryVersion: number;
  readonly currentEntryVersion: number;
  readonly contextKind: MemoryContextOwnerKind;
  readonly contextId: string;
  readonly contextHash: string;
  readonly kind: MemoryFeedbackKind;
  readonly comment: string;
  readonly createdAt: string;
  readonly action: MemoryFeedbackActionDto | null;
}

interface FeedbackRow {
  feedback_id: string;
  workspace_id: string;
  entry_id: string;
  entry_version: number;
  current_entry_version: number;
  context_kind: MemoryContextOwnerKind;
  context_id: string;
  context_hash: string;
  kind: MemoryFeedbackKind;
  comment: string;
  created_at: string;
  action_id: string | null;
  action_feedback_id: string | null;
  action_workspace_id: string | null;
  action_entry_id: string | null;
  action_entry_version: number | null;
  action: MemoryFeedbackActionKind | null;
  action_status: MemoryFeedbackActionStatus | null;
  action_version: number | null;
  action_created_at: string | null;
}

interface ActionRow {
  id: string;
  feedback_id: string;
  workspace_id: string;
  entry_id: string;
  entry_version: number;
  action: MemoryFeedbackActionKind;
  status: MemoryFeedbackActionStatus;
  version: number;
  created_at: string;
}

interface FrozenSelection {
  readonly memoryId: string;
  readonly memoryVersion: number | null;
  readonly store?: unknown;
}

interface FrozenContext {
  readonly text: string;
  readonly selected: readonly FrozenSelection[];
}

const MAX_IDENTIFIER_LENGTH = 200;
const MAX_COMMENT_LENGTH = 2000;
const FEEDBACK_KINDS: readonly MemoryFeedbackKind[] = ['helpful', 'wrong', 'outdated'];
const CONTEXT_KINDS: readonly MemoryContextOwnerKind[] = ['run', 'stage', 'turn', 'legacy-execution'];
const FEEDBACK_FIELDS = new Set(['expectedVersion', 'memoryId', 'memoryVersion', 'contextId', 'contextKind', 'kind', 'comment']);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_IDENTIFIER_LENGTH
    && value.trim() === value;
}

function isPositiveVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function parseFeedbackInput(value: unknown): MemoryVersionFeedbackRequestV1 | undefined {
  try {
    if (!isPlainRecord(value)) return undefined;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some(key => typeof key !== 'string' || !FEEDBACK_FIELDS.has(key))) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (ownKeys.some(key => {
      const descriptor = descriptors[key as string];
      return descriptor === undefined || !Object.hasOwn(descriptor, 'value');
    })) return undefined;

    const input = value as Record<string, unknown>;
    if (!isPositiveVersion(input.expectedVersion) || !isIdentifier(input.memoryId)
      || !isPositiveVersion(input.memoryVersion) || !isIdentifier(input.contextId)
      || !(CONTEXT_KINDS as readonly unknown[]).includes(input.contextKind)
      || !(FEEDBACK_KINDS as readonly unknown[]).includes(input.kind)
      || (input.comment !== undefined && (typeof input.comment !== 'string'
        || input.comment.length > MAX_COMMENT_LENGTH || !isMemoryTextSafe(input.comment)))) {
      return undefined;
    }
    return input as unknown as MemoryVersionFeedbackRequestV1;
  } catch {
    return undefined;
  }
}

function isFrozenSelection(value: unknown): value is FrozenSelection {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const selection = value as Record<string, unknown>;
  return isIdentifier(selection.memoryId)
    && (selection.memoryVersion === null || isPositiveVersion(selection.memoryVersion))
    && (selection.store === undefined || selection.store === 'canonical' || selection.store === 'legacy');
}

function toActionDto(row: ActionRow): MemoryFeedbackActionDto {
  return {
    id: row.id,
    feedbackId: row.feedback_id,
    workspaceId: row.workspace_id,
    memoryId: row.entry_id,
    memoryVersion: row.entry_version,
    action: row.action,
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
  };
}

function toFeedbackDto(row: FeedbackRow): MemoryVersionFeedbackDto {
  const action = row.action_id === null ? null : {
    id: row.action_id,
    feedbackId: row.action_feedback_id!,
    workspaceId: row.action_workspace_id!,
    memoryId: row.action_entry_id!,
    memoryVersion: row.action_entry_version!,
    action: row.action!,
    status: row.action_status!,
    version: row.action_version!,
    createdAt: row.action_created_at!,
  } satisfies MemoryFeedbackActionDto;
  return {
    id: row.feedback_id,
    workspaceId: row.workspace_id,
    memoryId: row.entry_id,
    memoryVersion: row.entry_version,
    currentEntryVersion: row.current_entry_version,
    contextKind: row.context_kind,
    contextId: row.context_id,
    contextHash: row.context_hash,
    kind: row.kind,
    comment: row.comment,
    createdAt: row.created_at,
    action,
  };
}

const FEEDBACK_SELECT = `SELECT
    f.id AS feedback_id, f.workspace_id, f.entry_id, f.entry_version, f.current_entry_version,
    f.context_kind, f.context_id, f.context_hash, f.kind, f.comment, f.created_at,
    a.id AS action_id, a.feedback_id AS action_feedback_id, a.workspace_id AS action_workspace_id,
    a.entry_id AS action_entry_id, a.entry_version AS action_entry_version, a.action,
    a.status AS action_status, a.version AS action_version, a.created_at AS action_created_at
  FROM memory_version_feedback f
  LEFT JOIN memory_feedback_actions a ON a.feedback_id = f.id`;

export class MemoryFeedbackService {
  constructor(private readonly db: TransactionDatabase) {}

  list(workspaceId: string): MemoryVersionFeedbackDto[] {
    if (!isIdentifier(workspaceId)) throw new Error('MEMORY_FEEDBACK_INPUT_INVALID');
    const rows = this.db.prepare(`${FEEDBACK_SELECT}
      WHERE f.workspace_id = ? ORDER BY f.created_at DESC, f.id LIMIT 200`).all(workspaceId) as FeedbackRow[];
    return rows.map(toFeedbackDto);
  }

  add(workspaceId: string, value: MemoryVersionFeedbackRequestV1): MemoryVersionFeedbackDto {
    const input = parseFeedbackInput(value);
    if (!isIdentifier(workspaceId) || input === undefined) throw new Error('MEMORY_FEEDBACK_INPUT_INVALID');

    return inTransaction(this.db, () => {
      const frozen = this.context(workspaceId, input);
      if (typeof frozen.text !== 'string' || !Array.isArray(frozen.selected)
        || !frozen.selected.every(isFrozenSelection)) {
        throw new Error('MEMORY_FEEDBACK_CONTEXT_INVALID');
      }
      const selected = frozen.selected.find(selection => selection.memoryId === input.memoryId
        && selection.memoryVersion === input.memoryVersion);
      // Legacy execution contexts must explicitly prove canonical selection. A
      // missing marker is ambiguous and could refer to a compatibility store.
      if (!selected || (selected.store !== undefined && selected.store !== 'canonical')
        || (input.contextKind === 'legacy-execution' && selected.store !== 'canonical')) {
        throw new Error('MEMORY_FEEDBACK_CONTEXT_INVALID');
      }

      const entries = new MemoryEntryRepository(this.db);
      const entry = entries.findById(workspaceId, input.memoryId)
        ?? entries.listConfirmedGlobalPreferences(workspaceId).find(item => item.id === input.memoryId);
      if (!entry) throw new Error('MEMORY_ENTRY_NOT_FOUND');
      if (entry.version !== input.expectedVersion) throw new Error('MEMORY_FEEDBACK_VERSION_CONFLICT');

      const id = randomUUID();
      const timestamp = new Date().toISOString();
      const insert = this.db.prepare(`INSERT INTO memory_version_feedback (
        id, workspace_id, entry_id, entry_version, current_entry_version,
        context_kind, context_id, context_hash, kind, comment, created_at
      ) SELECT ?, ?, e.id, ?, e.version, ?, ?, ?, ?, ?, ? FROM memory_entries e
        WHERE e.workspace_id = ? AND e.id = ? AND e.version = ?`)
        .run(id, workspaceId, input.memoryVersion, input.contextKind, input.contextId,
          createHash('sha256').update(frozen.text, 'utf8').digest('hex'), input.kind, input.comment ?? '', timestamp,
          entry.workspaceId, input.memoryId, input.expectedVersion) as { changes?: number | bigint };
      if (Number(insert.changes) !== 1) throw new Error('MEMORY_FEEDBACK_VERSION_CONFLICT');

      const action = input.kind === 'helpful' ? null : {
        id: randomUUID(),
        feedbackId: id,
        workspaceId,
        memoryId: input.memoryId,
        memoryVersion: input.memoryVersion,
        action: input.kind === 'wrong' ? 'correction' as const : 'revalidation' as const,
        status: 'pending' as const,
        version: 1,
        createdAt: timestamp,
      };
      if (action) {
        this.db.prepare(`INSERT INTO memory_feedback_actions (
          id, feedback_id, workspace_id, entry_id, entry_version, action, status, version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 1, ?)`)
          .run(action.id, id, workspaceId, input.memoryId, input.memoryVersion, action.action, timestamp);
      }

      const row = this.readFeedback(workspaceId, id);
      if (!row) throw new Error('MEMORY_FEEDBACK_PERSISTENCE_FAILED');
      return toFeedbackDto(row);
    });
  }

  resolveAction(
    workspaceId: string,
    actionId: string,
    expectedVersion: number,
    status: 'resolved' | 'rejected',
  ): MemoryFeedbackActionDto {
    if (!isIdentifier(workspaceId) || !isIdentifier(actionId) || !isPositiveVersion(expectedVersion)
      || (status !== 'resolved' && status !== 'rejected')) {
      throw new Error('MEMORY_FEEDBACK_INPUT_INVALID');
    }
    return inTransaction(this.db, () => {
      const row = this.db.prepare(`SELECT * FROM memory_feedback_actions
        WHERE workspace_id = ? AND id = ?`).get(workspaceId, actionId) as ActionRow | undefined;
      if (!row) throw new Error('MEMORY_FEEDBACK_ACTION_NOT_FOUND');
      if (row.status !== 'pending' || row.version !== expectedVersion) {
        throw new Error('MEMORY_FEEDBACK_VERSION_CONFLICT');
      }
      const timestamp = new Date().toISOString();
      const changed = this.db.prepare(`UPDATE memory_feedback_actions
        SET status = ?, version = version + 1
        WHERE workspace_id = ? AND id = ? AND status = 'pending' AND version = ?`)
        .run(status, workspaceId, actionId, expectedVersion) as { changes?: number | bigint };
      if (Number(changed.changes) !== 1) throw new Error('MEMORY_FEEDBACK_VERSION_CONFLICT');

      this.db.prepare(`INSERT INTO memory_feedback_action_audit (
        id, action_id, feedback_id, workspace_id, entry_id, entry_version, action,
        from_status, to_status, expected_version, version, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`)
        .run(randomUUID(), row.id, row.feedback_id, workspaceId, row.entry_id, row.entry_version,
          row.action, status, expectedVersion, expectedVersion + 1, timestamp);

      const updated = this.db.prepare(`SELECT * FROM memory_feedback_actions
        WHERE workspace_id = ? AND id = ?`).get(workspaceId, actionId) as ActionRow | undefined;
      if (!updated) throw new Error('MEMORY_FEEDBACK_ACTION_NOT_FOUND');
      return toActionDto(updated);
    });
  }

  private readFeedback(workspaceId: string, feedbackId: string): FeedbackRow | undefined {
    return this.db.prepare(`${FEEDBACK_SELECT} WHERE f.workspace_id = ? AND f.id = ?`)
      .get(workspaceId, feedbackId) as FeedbackRow | undefined;
  }

  private context(workspaceId: string, input: MemoryVersionFeedbackRequestV1): FrozenContext {
    if (input.contextKind === 'turn') {
      const payload = new TurnContextSnapshotRepository(this.db).readPayload(workspaceId, input.contextId);
      if (payload) return { text: payload.contextText, selected: payload.selected };
    } else if (input.contextKind === 'run' || input.contextKind === 'stage') {
      const repo = new MemoryContextSnapshotRepository(this.db);
      const snapshot = repo.findById(workspaceId, input.contextId);
      const text = repo.readContextText(workspaceId, input.contextId);
      if (snapshot && text !== undefined
        && (input.contextKind === 'run' ? snapshot.stageId === null : snapshot.stageId !== null)) {
        return { text, selected: snapshot.selected };
      }
    } else if (input.contextKind === 'legacy-execution') {
      const row = this.db.prepare(`SELECT execution_id FROM memory_execution_contexts
        WHERE workspace_id = ? AND id = ?`).get(workspaceId, input.contextId) as { execution_id: string } | undefined;
      const payload = row
        ? new MemoryExecutionContextRepository(this.db).findForExecution(workspaceId, row.execution_id)
        : undefined;
      if (payload) return { text: payload.contextText, selected: payload.selected };
    }
    throw new Error('MEMORY_FEEDBACK_CONTEXT_INVALID');
  }

}
