import { createHash, randomUUID } from 'node:crypto';
import type {
  MemoryContextOwnerKind,
  MemoryFeedbackActionDtoV1,
  MemoryFeedbackActionApplyRequestV1,
  MemoryFeedbackResolutionDtoV1,
  MemoryFeedbackResolutionKindV1,
  MemoryVersionFeedbackDtoV1,
  MemoryVersionFeedbackRequestV1,
} from '@agentos/shared';
import { MemoryEntryRepository, type MemoryEntryRecord } from '../store/MemoryEntryRepository.js';
import { MemoryContextSnapshotRepository } from '../store/MemoryContextSnapshotRepository.js';
import { TurnContextSnapshotRepository } from '../store/TurnContextSnapshotRepository.js';
import { MemoryExecutionContextRepository } from '../store/MemoryExecutionContextRepository.js';
import { inTransaction, type TransactionDatabase } from '../store/Transaction.js';
import { isMemoryTextSafe } from '../store/MemoryContentSafety.js';
import { MemoryLifecycleService } from './MemoryLifecycleService.js';

export type MemoryFeedbackKind = 'helpful' | 'wrong' | 'outdated';
export type MemoryFeedbackActionKind = 'correction' | 'revalidation';
export type MemoryFeedbackActionStatus = 'pending' | 'resolved' | 'rejected';

/** Public DTO aliases keep server responses aligned with the shared API contract. */
export type MemoryFeedbackResolutionDto = MemoryFeedbackResolutionDtoV1;
export type MemoryFeedbackActionDto = MemoryFeedbackActionDtoV1;
export type MemoryVersionFeedbackDto = MemoryVersionFeedbackDtoV1;

export interface MemoryFeedbackActionApplyResult {
  readonly action: MemoryFeedbackActionDto;
  readonly entry: MemoryEntryRecord;
}

export type MemoryFeedbackEntryChange = (
  entry: MemoryEntryRecord,
  action: MemoryFeedbackActionDto,
  resolution: MemoryFeedbackActionApplyRequestV1,
  timestamp: string,
) => void;

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
  resolution_action_id: string | null;
  resolution_resolver_workspace_id: string | null;
  resolution_expected_action_version: number | null;
  resolution_expected_entry_version: number | null;
  resolution_resolved_entry_version: number | null;
  resolution: MemoryFeedbackResolutionKindV1 | null;
  resolution_conclusion: string | null;
  resolution_evidence: string | null;
  resolution_created_at: string | null;
  action_resolved_by_workspace_id: string | null;
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
  resolved_by_workspace_id: string | null;
}

interface ResolutionRow {
  action_id: string;
  feedback_id: string;
  workspace_id: string;
  resolver_workspace_id: string | null;
  entry_id: string;
  reported_entry_version: number;
  expected_action_version: number;
  expected_entry_version: number;
  resolved_entry_version: number;
  resolution: MemoryFeedbackResolutionKindV1;
  conclusion: string;
  evidence: string;
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
const MAX_CONCLUSION_LENGTH = 1000;
const MAX_EVIDENCE_LENGTH = 4000;
const FEEDBACK_KINDS: readonly MemoryFeedbackKind[] = ['helpful', 'wrong', 'outdated'];
const CONTEXT_KINDS: readonly MemoryContextOwnerKind[] = ['run', 'stage', 'turn', 'legacy-execution'];
const FEEDBACK_FIELDS = new Set(['expectedVersion', 'memoryId', 'memoryVersion', 'contextId', 'contextKind', 'kind', 'comment']);
const APPLY_FIELDS = new Set([
  'expectedActionVersion', 'expectedEntryVersion', 'resolution', 'conclusion', 'evidence', 'correctedEntry',
]);
const RESOLUTIONS = ['corrected', 'archived', 'revalidated'] as const;

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

function parseApplyInput(value: unknown): MemoryFeedbackActionApplyRequestV1 | undefined {
  try {
    if (!isPlainRecord(value)) return undefined;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some(key => typeof key !== 'string' || !APPLY_FIELDS.has(key))) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (ownKeys.some(key => {
      const descriptor = descriptors[key as string];
      return descriptor === undefined || !Object.hasOwn(descriptor, 'value');
    })) return undefined;
    const input = value as Record<string, unknown>;
    if (!isPositiveVersion(input.expectedActionVersion) || !isPositiveVersion(input.expectedEntryVersion)
      || !(RESOLUTIONS as readonly unknown[]).includes(input.resolution)
      || typeof input.conclusion !== 'string' || input.conclusion.trim().length === 0
      || input.conclusion.length > MAX_CONCLUSION_LENGTH || !isMemoryTextSafe(input.conclusion)
      || typeof input.evidence !== 'string' || input.evidence.trim().length === 0
      || input.evidence.length > MAX_EVIDENCE_LENGTH || !isMemoryTextSafe(input.evidence)) return undefined;

    if (input.resolution === 'corrected') {
      if (!isPlainRecord(input.correctedEntry)) return undefined;
      const correctionKeys = Reflect.ownKeys(input.correctedEntry);
      if (correctionKeys.some(key => typeof key !== 'string' || !['title', 'summary', 'content'].includes(key))) return undefined;
      const correctionDescriptors = Object.getOwnPropertyDescriptors(input.correctedEntry);
      if (correctionKeys.some(key => {
        const descriptor = correctionDescriptors[key as string];
        return descriptor === undefined || !Object.hasOwn(descriptor, 'value');
      })) return undefined;
      const correction = input.correctedEntry as Record<string, unknown>;
      if (typeof correction.title !== 'string' || correction.title.trim().length === 0
        || typeof correction.content !== 'string' || correction.content.trim().length === 0
        || (correction.summary !== undefined && typeof correction.summary !== 'string')
        || ![correction.title, correction.summary ?? '', correction.content].every(isMemoryTextSafe)) return undefined;
    } else if (input.correctedEntry !== undefined) return undefined;

    return input as unknown as MemoryFeedbackActionApplyRequestV1;
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

function toResolutionDto(row: Pick<ResolutionRow,
  'expected_action_version' | 'expected_entry_version' | 'resolved_entry_version'
  | 'resolver_workspace_id' | 'resolution' | 'conclusion' | 'evidence' | 'created_at'>,
): MemoryFeedbackResolutionDto {
  return {
    resolverWorkspaceId: row.resolver_workspace_id,
    expectedActionVersion: row.expected_action_version,
    expectedEntryVersion: row.expected_entry_version,
    resolvedEntryVersion: row.resolved_entry_version,
    resolution: row.resolution,
    conclusion: row.conclusion,
    evidence: row.evidence,
    createdAt: row.created_at,
  };
}

function toActionDto(row: ActionRow, resolution?: MemoryFeedbackResolutionDto): MemoryFeedbackActionDto {
  return {
    id: row.id,
    feedbackId: row.feedback_id,
    workspaceId: row.workspace_id,
    memoryId: row.entry_id,
    memoryVersion: row.entry_version,
    action: row.action,
    status: row.status,
    version: row.version,
    resolvedByWorkspaceId: row.resolved_by_workspace_id,
    createdAt: row.created_at,
    resolution: resolution ?? null,
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
    resolvedByWorkspaceId: row.action_resolved_by_workspace_id,
    createdAt: row.action_created_at!,
    resolution: row.resolution_action_id ? toResolutionDto({
      expected_action_version: row.resolution_expected_action_version!,
      resolver_workspace_id: row.resolution_resolver_workspace_id!,
      expected_entry_version: row.resolution_expected_entry_version!,
      resolved_entry_version: row.resolution_resolved_entry_version!,
      resolution: row.resolution!,
      conclusion: row.resolution_conclusion!,
      evidence: row.resolution_evidence!,
      created_at: row.resolution_created_at!,
    }) : null,
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
    a.status AS action_status, a.version AS action_version, a.created_at AS action_created_at,
    a.resolved_by_workspace_id AS action_resolved_by_workspace_id,
    r.action_id AS resolution_action_id, r.expected_action_version AS resolution_expected_action_version,
    r.resolver_workspace_id AS resolution_resolver_workspace_id,
    r.expected_entry_version AS resolution_expected_entry_version,
    r.resolved_entry_version AS resolution_resolved_entry_version,
    r.resolution AS resolution, r.conclusion AS resolution_conclusion,
    r.evidence AS resolution_evidence, r.created_at AS resolution_created_at
  FROM memory_version_feedback f
  LEFT JOIN memory_feedback_actions a ON a.feedback_id = f.id
  LEFT JOIN memory_feedback_action_resolutions r ON r.action_id = a.id`;

export class MemoryFeedbackService {
  constructor(private readonly db: TransactionDatabase) {}

  list(workspaceId: string): MemoryVersionFeedbackDto[] {
    if (!isIdentifier(workspaceId)) throw new Error('MEMORY_FEEDBACK_INPUT_INVALID');
    const rows = this.db.prepare(`${FEEDBACK_SELECT}
      WHERE f.workspace_id = ? OR EXISTS (
        SELECT 1 FROM memory_entries owned_global
        WHERE owned_global.id = f.entry_id AND owned_global.workspace_id = ? AND owned_global.scope = 'global'
      ) ORDER BY f.created_at DESC, f.id LIMIT 200`).all(workspaceId, workspaceId) as FeedbackRow[];
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
    if (status === 'resolved') {
      throw new Error('MEMORY_FEEDBACK_RESOLUTION_REQUIRED');
    }
    return inTransaction(this.db, () => {
      const row = this.requireActionActor(workspaceId, actionId);
      if (row.status !== 'pending' || row.version !== expectedVersion) {
        throw new Error('MEMORY_FEEDBACK_VERSION_CONFLICT');
      }
      return this.transitionAction(row, workspaceId, expectedVersion, status);
    });
  }

  /** Apply an evidenced Entry correction or lifecycle transition and resolve the action atomically. */
  applyAction(
    workspaceId: string,
    actionId: string,
    value: unknown,
    onEntryChange?: MemoryFeedbackEntryChange,
  ): MemoryFeedbackActionApplyResult {
    const input = parseApplyInput(value);
    if (!isIdentifier(workspaceId) || !isIdentifier(actionId) || input === undefined) {
      throw new Error('MEMORY_FEEDBACK_INPUT_INVALID');
    }
    if (!onEntryChange) throw new Error('MEMORY_FEEDBACK_AUDIT_UNAVAILABLE');

    if (input.resolution === 'corrected') {
      return inTransaction(this.db, () => {
        const row = this.requirePendingAction(workspaceId, actionId, input.expectedActionVersion);
        const entries = new MemoryEntryRepository(this.db);
        const current = this.findEntryForWorkspace(entries, workspaceId, row.entry_id);
        if (!current) throw new Error('MEMORY_FEEDBACK_ENTRY_NOT_FOUND');
        if (current.scope === 'global' && current.workspaceId !== workspaceId) {
          throw new Error('MEMORY_FEEDBACK_GLOBAL_ENTRY_OWNER_REQUIRED');
        }
        if (current.version !== input.expectedEntryVersion) throw new Error('MEMORY_FEEDBACK_ENTRY_VERSION_CONFLICT');
        const correction = input.correctedEntry!;
        if (correction.title === current.title && (correction.summary ?? current.summary) === current.summary
          && correction.content === current.content) {
          throw new Error('MEMORY_FEEDBACK_CORRECTION_UNCHANGED');
        }
        const timestamp = new Date().toISOString();
        const entry = entries.updateEntryWithinTransaction({
          workspaceId, entryId: row.entry_id, expectedVersion: input.expectedEntryVersion, updatedAt: timestamp,
          title: correction.title, summary: correction.summary, content: correction.content,
        }, 'user-correction');
        this.insertEntryVersionAudit(current.workspaceId, current, entry, 'corrected', timestamp);
        this.insertResolution(row, workspaceId, input, entry.version, timestamp);
        const action = this.transitionAction(row, workspaceId, input.expectedActionVersion, 'resolved');
        onEntryChange(entry, action, input, timestamp);
        return { action, entry };
      });
    }

    const preview = this.requireActionActor(workspaceId, actionId);
    if (preview.status !== 'pending' || preview.version !== input.expectedActionVersion) {
      throw new Error('MEMORY_FEEDBACK_VERSION_CONFLICT');
    }
    const entries = new MemoryEntryRepository(this.db);
    const visibleEntry = this.findEntryForWorkspace(entries, workspaceId, preview.entry_id);
    if (!visibleEntry) throw new Error('MEMORY_FEEDBACK_ENTRY_NOT_FOUND');
    if (visibleEntry.scope === 'global' && visibleEntry.workspaceId !== workspaceId) {
      throw new Error('MEMORY_FEEDBACK_GLOBAL_ENTRY_OWNER_REQUIRED');
    }
    if (visibleEntry.version !== input.expectedEntryVersion) throw new Error('MEMORY_FEEDBACK_ENTRY_VERSION_CONFLICT');

    let result: MemoryFeedbackActionApplyResult | undefined;
    const entry = new MemoryLifecycleService(this.db).apply({
      workspaceId,
      entryId: preview.entry_id,
      expectedVersion: input.expectedEntryVersion,
      action: input.resolution === 'archived' ? 'archive' : 'revalidate',
    }, (updatedEntry, timestamp) => {
      const row = this.requirePendingAction(workspaceId, actionId, input.expectedActionVersion);
      this.insertResolution(row, workspaceId, input, updatedEntry.version, timestamp);
      const action = this.transitionAction(row, workspaceId, input.expectedActionVersion, 'resolved');
      onEntryChange(updatedEntry, action, input, timestamp);
      result = { action, entry: updatedEntry };
    });
    if (!result || result.entry.version !== entry.version) throw new Error('MEMORY_FEEDBACK_PERSISTENCE_FAILED');
    return result;
  }

  private requirePendingAction(workspaceId: string, actionId: string, expectedVersion: number): ActionRow {
    const row = this.requireActionActor(workspaceId, actionId);
    if (row.status !== 'pending' || row.version !== expectedVersion) {
      throw new Error('MEMORY_FEEDBACK_VERSION_CONFLICT');
    }
    return row;
  }

  private requireActionActor(workspaceId: string, actionId: string): ActionRow {
    const row = this.db.prepare(`SELECT * FROM memory_feedback_actions WHERE id = ?`).get(actionId) as ActionRow | undefined;
    if (!row) throw new Error('MEMORY_FEEDBACK_ACTION_NOT_FOUND');
    const entry = this.db.prepare('SELECT workspace_id,scope FROM memory_entries WHERE id = ?')
      .get(row.entry_id) as { workspace_id: string; scope: string } | undefined;
    if (!entry) throw new Error('MEMORY_FEEDBACK_ENTRY_NOT_FOUND');
    if (entry.scope === 'global') {
      if (entry.workspace_id !== workspaceId) throw new Error('MEMORY_FEEDBACK_GLOBAL_ENTRY_OWNER_REQUIRED');
    } else if (entry.workspace_id !== workspaceId || row.workspace_id !== workspaceId) {
      throw new Error('MEMORY_FEEDBACK_ACTION_NOT_FOUND');
    }
    return row;
  }

  private findEntryForWorkspace(entries: MemoryEntryRepository, workspaceId: string, entryId: string): MemoryEntryRecord | undefined {
    return entries.findById(workspaceId, entryId)
      ?? entries.listConfirmedGlobalPreferences(workspaceId).find(entry => entry.id === entryId);
  }

  private transitionAction(
    row: ActionRow,
    workspaceId: string,
    expectedVersion: number,
    status: 'resolved' | 'rejected',
  ): MemoryFeedbackActionDto {
    const changed = this.db.prepare(`UPDATE memory_feedback_actions
      SET status = ?, resolved_by_workspace_id = ?, version = version + 1
      WHERE workspace_id = ? AND id = ? AND status = 'pending' AND version = ?
        AND resolved_by_workspace_id IS NULL`)
      .run(status, workspaceId, row.workspace_id, row.id, expectedVersion) as { changes?: number | bigint };
    if (Number(changed.changes) !== 1) throw new Error('MEMORY_FEEDBACK_VERSION_CONFLICT');

    const updated = this.db.prepare(`SELECT * FROM memory_feedback_actions
      WHERE workspace_id = ? AND id = ?`).get(row.workspace_id, row.id) as ActionRow | undefined;
    if (!updated) throw new Error('MEMORY_FEEDBACK_ACTION_NOT_FOUND');
    return toActionDto(updated, this.readResolution(row.id));
  }

  private insertResolution(
    action: ActionRow,
    resolverWorkspaceId: string,
    resolution: MemoryFeedbackActionApplyRequestV1,
    resolvedEntryVersion: number,
    timestamp: string,
  ): void {
    this.db.prepare(`INSERT INTO memory_feedback_action_resolutions (
      action_id, feedback_id, workspace_id, entry_id, reported_entry_version,
      expected_action_version, expected_entry_version, resolved_entry_version,
      resolution, conclusion, evidence, created_at, resolver_workspace_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(action.id, action.feedback_id, action.workspace_id, action.entry_id, action.entry_version,
        resolution.expectedActionVersion, resolution.expectedEntryVersion, resolvedEntryVersion,
        resolution.resolution, resolution.conclusion, resolution.evidence, timestamp, resolverWorkspaceId);
  }

  private insertEntryVersionAudit(
    workspaceId: string,
    before: MemoryEntryRecord,
    after: MemoryEntryRecord,
    action: 'corrected',
    timestamp: string,
  ): void {
    this.db.prepare(`INSERT INTO memory_lifecycle_actions (
      id, workspace_id, entry_id, action, from_version, to_version, before_json, after_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), workspaceId, before.id, action, before.version, after.version,
        JSON.stringify(before), JSON.stringify(after), timestamp);
  }

  private readResolution(actionId: string): MemoryFeedbackResolutionDto | undefined {
    const row = this.db.prepare(`SELECT expected_action_version, expected_entry_version,
        resolved_entry_version, resolver_workspace_id, resolution, conclusion, evidence, created_at
      FROM memory_feedback_action_resolutions WHERE action_id = ?`)
      .get(actionId) as Pick<ResolutionRow,
        'expected_action_version' | 'expected_entry_version' | 'resolved_entry_version'
        | 'resolver_workspace_id' | 'resolution' | 'conclusion' | 'evidence' | 'created_at'> | undefined;
    return row ? toResolutionDto(row) : undefined;
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
