import type { PreferenceEvidence, PreferenceProjection } from '@agentos/shared';
import { MemoryEntryRepository, type MemoryEntryRecord } from '../store/MemoryEntryRepository.js';
import { createEntityId } from '../store/Identity.js';
import { inTransaction, type TransactionDatabase } from '../store/Transaction.js';
import { deriveWorkspaceEventContext } from '../store/WorkspaceEventWriter.js';
import { SqliteStore } from '../store/SqliteStore.js';
import { PREFERENCE_CONTEXTS, PREFERENCE_DIMENSIONS, PREFERENCE_VALUES } from './PreferenceRules.js';

export type PreferenceSuggestionStatus = 'pending' | 'confirmed' | 'rejected' | 'revoked';

/** The API view is deliberately local so the feature does not widen shared contracts. */
export interface PreferenceSuggestion {
  readonly id: string;
  readonly projectionId: string;
  readonly workspaceId: string;
  readonly status: PreferenceSuggestionStatus;
  readonly version: number;
  readonly entryId: string | null;
  readonly preferredValue: string;
  readonly dimension: string;
  readonly contextKind: string;
  readonly scope: 'workspace' | 'global';
  readonly confidence: number;
  readonly evidenceCount: number;
}

export interface PreferenceSuggestionResult {
  readonly suggestion: PreferenceSuggestion;
  readonly entry?: MemoryEntryRecord;
}

export class PreferenceConfirmationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'PreferenceConfirmationError';
  }
}

interface ConfirmationRow {
  id: string; projection_id: string; profile_id: string;
  projection_scope: 'workspace' | 'global'; projection_workspace_id: string | null; workspace_id: string | null;
  status: PreferenceSuggestionStatus; version: number; preferred_value: string; dimension: string;
  context_kind: string; scope: 'workspace' | 'global'; confidence: number; evidence_count: number;
  evidence_json: string; entry_id: string | null; entry_workspace_id: string | null; entry_version: number | null;
  created_at: string; updated_at: string;
}

interface ProjectionRow {
  id: string; profile_id: string; scope: 'workspace' | 'global'; workspace_id: string | null;
  preferred_value: string; dimension: string; context_kind: string; confidence: number;
  evidence_count: number; status: PreferenceProjection['status']; created_at: string; updated_at: string;
}

interface EvidenceRow {
  id: string; profile_id: string; workspace_id: string | null; conversation_id: string; run_id: string;
  source_event_id: string; dimension: string; context_kind: string; candidate_value: string;
  signal_type: string; polarity: string; weight: number; summary: string; status: string;
  observed_at: string; created_at: string;
}

function isPositiveVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function isPreferenceProjectionValue(dimension: string, value: string): boolean {
  return Object.prototype.hasOwnProperty.call(PREFERENCE_VALUES, dimension)
    && PREFERENCE_VALUES[dimension as keyof typeof PREFERENCE_VALUES].includes(value);
}

function toSuggestion(row: ConfirmationRow, workspaceId: string): PreferenceSuggestion {
  return {
    id: row.id, projectionId: row.projection_id, workspaceId, status: row.status,
    version: row.version, entryId: row.entry_id, preferredValue: row.preferred_value,
    dimension: row.dimension, contextKind: row.context_kind, scope: row.scope,
    confidence: row.confidence, evidenceCount: row.evidence_count,
  };
}

function encodeEvidence(row: EvidenceRow): Record<string, unknown> {
  return {
    evidenceId: row.id, profileId: row.profile_id, workspaceId: row.workspace_id,
    conversationId: row.conversation_id, runId: row.run_id, sourceEventId: row.source_event_id,
    dimension: row.dimension, contextKind: row.context_kind, candidateValue: row.candidate_value,
    signalType: row.signal_type, polarity: row.polarity, weight: row.weight, summary: row.summary,
    status: row.status, observedAt: row.observed_at, createdAt: row.created_at,
  };
}

function decodeEvidenceSnapshot(evidenceJson: string): PreferenceEvidence[] {
  const rows = JSON.parse(evidenceJson) as Array<Record<string, unknown>>;
  return rows.map(row => ({
    id: row.evidenceId as string, profileId: row.profileId as string,
    ...(typeof row.workspaceId === 'string' ? { workspaceId: row.workspaceId } : {}),
    conversationId: row.conversationId as string, runId: row.runId as string,
    sourceEventId: row.sourceEventId as string, dimension: row.dimension as PreferenceEvidence['dimension'],
    contextKind: row.contextKind as PreferenceEvidence['contextKind'], candidateValue: row.candidateValue as string,
    signalType: row.signalType as PreferenceEvidence['signalType'], polarity: row.polarity as PreferenceEvidence['polarity'],
    weight: row.weight as number, summary: row.summary as string, status: row.status as PreferenceEvidence['status'],
    observedAt: row.observedAt as string, createdAt: row.createdAt as string,
  }));
}

function entryPreferenceValue(entry: MemoryEntryRecord): string | undefined {
  return entry.tags.find(tag => tag.startsWith('value:'))?.slice('value:'.length);
}

/**
 * A projection is a learning view, never reply authority. This service snapshots
 * its evidence as a suggestion and binds a Memory Entry only after explicit
 * confirmation. Confirmed Entry text is consumed by normal Memory retrieval.
 */
export class PreferenceConfirmationService {
  private readonly db: TransactionDatabase;
  private readonly entries: MemoryEntryRepository;

  constructor(private readonly store: SqliteStore, private readonly now: () => string = () => new Date().toISOString()) {
    this.db = store.getDatabase();
    this.entries = new MemoryEntryRepository(this.db);
  }

  private memorySources(evidenceJson: string): Array<{ kind: 'user' | 'run' | 'conversation' | 'message'; id: string }> {
    const sources = new Map<string, { kind: 'user' | 'run' | 'conversation' | 'message'; id: string }>();
    const add = (kind: 'user' | 'run' | 'conversation' | 'message', id: unknown) => {
      if (typeof id !== 'string' || id.trim() === '') return;
      sources.set(`${kind}:${id}`, { kind, id });
    };
    add('user', 'default');
    const evidence = JSON.parse(evidenceJson) as Array<Record<string, unknown>>;
    const findRunMessage = this.db.prepare(`
      SELECT source_message_id FROM agent_runs
      WHERE id = ? AND conversation_id = ? AND workspace_id IS ?
    `);
    const findMessage = this.db.prepare('SELECT id FROM messages WHERE id = ? AND workspace_id IS ?');
    for (const item of evidence) {
      add('run', item.runId);
      add('conversation', item.conversationId);
      if (typeof item.runId === 'string' && typeof item.conversationId === 'string') {
        const source = findRunMessage.get(item.runId, item.conversationId, item.workspaceId) as { source_message_id: string | null } | undefined;
        if (source?.source_message_id && findMessage.get(source.source_message_id, item.workspaceId)) {
          add('message', source.source_message_id);
        }
      }
      if (item.signalType === 'conflict' && typeof item.sourceEventId === 'string') {
        const conflictMarker = item.sourceEventId.lastIndexOf(':conflict:');
        if (item.sourceEventId.startsWith('preference:') && conflictMarker > 'preference:'.length) {
          const correctionId = item.sourceEventId.slice('preference:'.length, conflictMarker);
          if (findMessage.get(correctionId, item.workspaceId)) add('message', correctionId);
        }
      }
    }
    return [...sources.values()];
  }

  listSuggestions(workspaceId: string, profileId = 'default'): PreferenceSuggestion[] {
    const rows = this.db.prepare(`
      SELECT id, projection_id, profile_id, projection_scope, projection_workspace_id, workspace_id,
        status, version, preferred_value, dimension, context_kind, scope, confidence, evidence_count,
        evidence_json, entry_id, entry_workspace_id, entry_version, created_at, updated_at
      FROM preference_confirmations
      WHERE profile_id = ? AND (
        projection_scope = 'global' OR projection_workspace_id = ?
        OR (scope = 'global' AND status IN ('confirmed', 'revoked') AND entry_id IS NOT NULL)
      )
      ORDER BY updated_at DESC, id ASC
    `).all(profileId, workspaceId) as ConfirmationRow[];
    return rows.map(row => toSuggestion(row, workspaceId));
  }

  /** Returns the frozen evidence snapshot only when this Workspace can see the suggestion or binding. */
  evidenceForProjection(projectionId: string, workspaceId: string, profileId = 'default'): PreferenceEvidence[] | null | undefined {
    const rows = this.db.prepare(`
      SELECT id, projection_id, profile_id, projection_scope, projection_workspace_id, workspace_id,
        status, version, preferred_value, dimension, context_kind, scope, confidence, evidence_count,
        evidence_json, entry_id, entry_workspace_id, entry_version, created_at, updated_at
      FROM preference_confirmations WHERE projection_id = ? AND profile_id = ?
      ORDER BY updated_at DESC, id ASC
    `).all(projectionId, profileId) as ConfirmationRow[];
    if (rows.length === 0) return undefined;

    const confirmedGlobal = rows.find(row => row.status === 'confirmed' && row.scope === 'global'
      && row.entry_id !== null && row.entry_workspace_id !== null && row.entry_version !== null
      && row.entry_workspace_id !== workspaceId);
    if (confirmedGlobal) {
      const entry = this.entries.findById(confirmedGlobal.entry_workspace_id!, confirmedGlobal.entry_id!);
      const expectedTags = [
        `dimension:${confirmedGlobal.dimension}`,
        `context:${confirmedGlobal.context_kind}`,
        `value:${confirmedGlobal.preferred_value}`,
      ];
      if (!entry || entry.workspaceId !== confirmedGlobal.entry_workspace_id
        || entry.version < confirmedGlobal.entry_version || entry.scope !== 'global'
        || entry.category !== 'preference' || entry.authority !== 'user-explicit' || entry.status !== 'active'
        || expectedTags.some(tag => !entry.tags.includes(tag))) return null;
      return decodeEvidenceSnapshot(confirmedGlobal.evidence_json);
    }

    const workspaceBinding = rows.find(row => row.projection_workspace_id === workspaceId
      || row.workspace_id === workspaceId || row.entry_workspace_id === workspaceId);
    if (workspaceBinding) return decodeEvidenceSnapshot(workspaceBinding.evidence_json);

    // A sidecar row exists, but none of its bindings authorizes this Workspace.
    return null;
  }

  /** Called after the projection and its evidence links have been persisted. */
  synchronizeProjection(projection: PreferenceProjection): PreferenceSuggestion | undefined {
    if (!['observed', 'provisional', 'stable'].includes(projection.status)) return undefined;
    const timestamp = this.now();
    return inTransaction(this.db, () => {
      const current = this.db.prepare(`
        SELECT id, profile_id, scope, workspace_id, preferred_value, dimension, context_kind,
          confidence, evidence_count, status, created_at, updated_at
        FROM preference_projections WHERE id = ? AND profile_id = ?
      `).get(projection.id, projection.profileId) as ProjectionRow | undefined;
      if (!current || !['workspace', 'global'].includes(current.scope)
        || !PREFERENCE_DIMENSIONS.includes(current.dimension as typeof PREFERENCE_DIMENSIONS[number])
        || !PREFERENCE_CONTEXTS.includes(current.context_kind as typeof PREFERENCE_CONTEXTS[number])
        || !isPreferenceProjectionValue(current.dimension, current.preferred_value)
        || !['observed', 'provisional', 'stable'].includes(current.status)) return undefined;

      const evidence = this.db.prepare(`
        SELECT e.id, e.profile_id, e.workspace_id, e.conversation_id, e.run_id, e.source_event_id,
          e.dimension, e.context_kind, e.candidate_value, e.signal_type, e.polarity, e.weight, e.summary,
          e.status, e.observed_at, e.created_at
        FROM preference_projection_evidence AS pe
        INNER JOIN preference_evidence AS e ON e.id = pe.evidence_id
        WHERE pe.projection_id = ? ORDER BY e.observed_at, e.id
      `).all(current.id) as EvidenceRow[];
      const evidenceJson = JSON.stringify(evidence.map(encodeEvidence));
      const confirmed = this.db.prepare(`
        SELECT id, entry_id, entry_workspace_id, entry_version, preferred_value, dimension, context_kind, scope
        FROM preference_confirmations
        WHERE profile_id = ? AND dimension = ? AND context_kind = ? AND status = 'confirmed'
          AND (scope = 'global' OR (scope = 'workspace' AND entry_workspace_id IS ?))
        ORDER BY updated_at DESC, id ASC
      `).all(current.profile_id, current.dimension, current.context_kind, current.workspace_id) as Array<{
        id: string; entry_id: string; entry_workspace_id: string; entry_version: number;
        preferred_value: string; dimension: string; context_kind: string; scope: 'workspace' | 'global';
      }>;
      const matchingConfirmed = confirmed.some(binding => {
        const entry = this.entries.findById(binding.entry_workspace_id, binding.entry_id);
        return entry?.status === 'active' && entry.category === 'preference' && entry.authority === 'user-explicit'
          && entry.scope === binding.scope && entry.version >= binding.entry_version
          && entryPreferenceValue(entry) === binding.preferred_value && binding.preferred_value === current.preferred_value
          && entry.tags.includes(`dimension:${binding.dimension}`)
          && entry.tags.includes(`context:${binding.context_kind}`);
      });
      if (matchingConfirmed) return undefined;

      const pending = this.db.prepare(`
        SELECT id, projection_id, profile_id, projection_scope, projection_workspace_id, workspace_id,
          status, version, preferred_value, dimension, context_kind, scope, confidence, evidence_count,
          evidence_json, entry_id, entry_workspace_id, entry_version, created_at, updated_at
        FROM preference_confirmations WHERE projection_id = ? AND status = 'pending'
      `).get(current.id) as ConfirmationRow | undefined;
      const nextVersion = pending ? pending.version + 1 : 1;
      const id = pending?.id ?? createEntityId('projection');
      const createdAt = pending?.created_at ?? timestamp;
      this.db.prepare(`
        INSERT INTO preference_confirmations (
          id, projection_id, profile_id, projection_scope, projection_workspace_id, workspace_id,
          status, version, preferred_value, dimension, context_kind, scope, confidence, evidence_count,
          evidence_json, entry_id, entry_workspace_id, entry_version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          profile_id = excluded.profile_id, projection_scope = excluded.projection_scope,
          projection_workspace_id = excluded.projection_workspace_id, workspace_id = excluded.workspace_id,
          preferred_value = excluded.preferred_value, dimension = excluded.dimension,
          context_kind = excluded.context_kind, scope = excluded.scope, confidence = excluded.confidence,
          evidence_count = excluded.evidence_count, evidence_json = excluded.evidence_json,
          version = excluded.version, updated_at = excluded.updated_at
      `).run(id, current.id, current.profile_id, current.scope, current.workspace_id, current.workspace_id,
        nextVersion, current.preferred_value, current.dimension, current.context_kind, current.scope,
        current.confidence, current.evidence_count, evidenceJson, createdAt, timestamp);
      this.appendAudit({ id, projectionId: current.id, workspaceId: current.workspace_id,
        action: pending ? 'refreshed' : 'suggested', actor: 'learner', expectedVersion: pending?.version ?? null,
        version: nextVersion, details: {
          previous: pending ? { preferredValue: pending.preferred_value, evidence: JSON.parse(pending.evidence_json) } : null,
          current: { preferredValue: current.preferred_value, evidence: JSON.parse(evidenceJson) },
        }, occurredAt: timestamp });
      const saved = this.getById(id);
      return saved ? toSuggestion(saved, current.workspace_id ?? '') : undefined;
    });
  }

  confirm(input: { projectionId: string; workspaceId: string; expectedVersion: number; confirmGlobal?: boolean }): PreferenceSuggestionResult {
    this.validateActionInput(input);
    const timestamp = this.now();
    return inTransaction(this.db, () => {
      this.requireWorkspace(input.workspaceId);
      const pending = this.findPending(input.projectionId, input.workspaceId);
      this.requireVersion(pending, input.expectedVersion);
      const targetScope = input.confirmGlobal === true ? 'global' : 'workspace';
      this.archiveExistingBinding(pending, targetScope, input.workspaceId, timestamp);

      const entry = this.entries.createEntryWithinTransaction({
        id: createEntityId('memory'), workspaceId: input.workspaceId, scope: targetScope,
        category: 'preference', authority: 'user-explicit',
        confidence: 1, importance: 0.8,
        title: `用户偏好：${pending.dimension}`,
        summary: `${pending.context_kind} 场景下偏好 ${pending.preferred_value}`,
        content: `用户明确确认：在 ${pending.context_kind} 场景下，${pending.dimension} 偏好为“${pending.preferred_value}”。`,
        tags: ['preference', `dimension:${pending.dimension}`, `context:${pending.context_kind}`, `value:${pending.preferred_value}`],
        status: 'active', sources: this.memorySources(pending.evidence_json), createdAt: timestamp,
      });
      this.appendEntryEvent(entry, 'memory.entry_created', timestamp, 'memory.entry_save');
      const updated = this.db.prepare(`
        UPDATE preference_confirmations SET status = 'confirmed', scope = ?, workspace_id = ?,
          entry_id = ?, entry_workspace_id = ?, entry_version = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND status = 'pending' AND version = ?
      `).run(targetScope, input.workspaceId, entry.id, input.workspaceId, entry.version, timestamp, pending.id, input.expectedVersion) as { changes: number | bigint };
      if (Number(updated.changes) !== 1) throw new PreferenceConfirmationError('PREFERENCE_VERSION_CONFLICT');
      this.appendAudit({ id: pending.id, projectionId: pending.projection_id, workspaceId: input.workspaceId,
        action: 'confirmed', actor: 'user', expectedVersion: input.expectedVersion, version: pending.version + 1,
        entryId: entry.id, details: { scope: targetScope, evidence: JSON.parse(pending.evidence_json), entryVersion: entry.version }, occurredAt: timestamp });
      return { suggestion: toSuggestion(this.getById(pending.id)!, input.workspaceId), entry };
    });
  }

  reject(input: { projectionId: string; workspaceId: string; expectedVersion: number }): PreferenceSuggestionResult {
    this.validateActionInput(input);
    const timestamp = this.now();
    return inTransaction(this.db, () => {
      this.requireWorkspace(input.workspaceId);
      const pending = this.findPending(input.projectionId, input.workspaceId);
      this.requireVersion(pending, input.expectedVersion);
      this.updateTerminalState(pending, 'rejected', input.expectedVersion, input.workspaceId, timestamp, 'rejected');
      return { suggestion: toSuggestion(this.getById(pending.id)!, input.workspaceId) };
    });
  }

  revoke(input: { projectionId: string; workspaceId: string; expectedVersion: number }): PreferenceSuggestionResult {
    this.validateActionInput(input);
    const timestamp = this.now();
    return inTransaction(this.db, () => {
      this.requireWorkspace(input.workspaceId);
      const confirmed = this.findConfirmed(input.projectionId, input.workspaceId);
      if (confirmed) {
        this.requireVersion(confirmed, input.expectedVersion);
        const entry = this.findBoundEntry(confirmed);
        if (entry && this.canArchiveBoundEntry(confirmed, entry)) {
          const archived = this.entries.updateStatusWithinTransaction({ workspaceId: entry.workspaceId,
            entryId: entry.id, expectedVersion: confirmed.entry_version!, status: 'archived', updatedAt: timestamp });
          this.appendEntryEvent(archived, 'memory.entry_archived', timestamp, 'memory.entry_edit');
          this.updateTerminalState(confirmed, 'revoked', input.expectedVersion, input.workspaceId, timestamp,
            'revoked', archived.version);
          return { suggestion: toSuggestion(this.getById(confirmed.id)!, input.workspaceId), entry: archived };
        }
        const reason = !entry ? 'entry_missing'
          : entry.status === 'archived' ? 'entry_already_archived'
            : entry.status === 'deleted' ? 'entry_already_deleted'
              : entry.version !== confirmed.entry_version ? 'entry_version_changed'
                : 'entry_binding_changed';
        this.updateTerminalState(confirmed, 'revoked', input.expectedVersion, input.workspaceId,
          timestamp, 'revoked', undefined, { entryPreservedReason: reason,
            ...(entry ? { observedEntryVersion: entry.version, observedEntryStatus: entry.status } : {}) });
        return { suggestion: toSuggestion(this.getById(confirmed.id)!, input.workspaceId), ...(entry ? { entry } : {}) };
      }
      const pending = this.findPending(input.projectionId, input.workspaceId);
      this.requireVersion(pending, input.expectedVersion);
      this.updateTerminalState(pending, 'revoked', input.expectedVersion, input.workspaceId, timestamp, 'revoked');
      return { suggestion: toSuggestion(this.getById(pending.id)!, input.workspaceId) };
    });
  }

  private validateActionInput(input: { projectionId: string; workspaceId: string; expectedVersion: number }): void {
    if (!input || typeof input.projectionId !== 'string' || input.projectionId.trim() === ''
      || typeof input.workspaceId !== 'string' || input.workspaceId.trim() === '' || !isPositiveVersion(input.expectedVersion)) {
      throw new PreferenceConfirmationError('PREFERENCE_INPUT_INVALID');
    }
  }

  private requireWorkspace(workspaceId: string): void {
    if (!this.db.prepare('SELECT 1 FROM workspaces WHERE id = ?').get(workspaceId)) {
      throw new PreferenceConfirmationError('PREFERENCE_WORKSPACE_NOT_FOUND');
    }
  }

  private findPending(projectionId: string, workspaceId: string): ConfirmationRow {
    const row = this.db.prepare(`
      SELECT id, projection_id, profile_id, projection_scope, projection_workspace_id, workspace_id,
        status, version, preferred_value, dimension, context_kind, scope, confidence, evidence_count,
        evidence_json, entry_id, entry_workspace_id, entry_version, created_at, updated_at
      FROM preference_confirmations WHERE projection_id = ? AND status = 'pending'
        AND (projection_scope = 'global' OR projection_workspace_id = ?)
    `).get(projectionId, workspaceId) as ConfirmationRow | undefined;
    if (!row) throw new PreferenceConfirmationError('PREFERENCE_SUGGESTION_NOT_FOUND');
    return row;
  }

  private findConfirmed(projectionId: string, workspaceId: string): ConfirmationRow | undefined {
    return this.db.prepare(`
      SELECT id, projection_id, profile_id, projection_scope, projection_workspace_id, workspace_id,
        status, version, preferred_value, dimension, context_kind, scope, confidence, evidence_count,
        evidence_json, entry_id, entry_workspace_id, entry_version, created_at, updated_at
      FROM preference_confirmations WHERE projection_id = ? AND status = 'confirmed'
        AND (projection_workspace_id = ? OR entry_workspace_id = ? OR (scope = 'global' AND entry_id IS NOT NULL))
    `).get(projectionId, workspaceId, workspaceId) as ConfirmationRow | undefined;
  }

  private requireVersion(row: ConfirmationRow, expectedVersion: number): void {
    if (row.version !== expectedVersion) throw new PreferenceConfirmationError('PREFERENCE_VERSION_CONFLICT');
  }

  private archiveExistingBinding(pending: ConfirmationRow, scope: 'workspace' | 'global', workspaceId: string, timestamp: string): void {
    const conflicts = this.db.prepare(`
      SELECT id, projection_id, profile_id, projection_scope, projection_workspace_id, workspace_id,
        status, version, preferred_value, dimension, context_kind, scope, confidence, evidence_count,
        evidence_json, entry_id, entry_workspace_id, entry_version, created_at, updated_at
      FROM preference_confirmations WHERE profile_id = ? AND dimension = ? AND context_kind = ?
        AND status = 'confirmed' AND scope = ? AND (? = 'global' OR entry_workspace_id = ?)
      ORDER BY updated_at DESC, id ASC
    `).all(pending.profile_id, pending.dimension, pending.context_kind, scope, scope, workspaceId) as ConfirmationRow[];
    for (const conflict of conflicts) {
      const entry = this.findBoundEntry(conflict);
      const canArchive = entry !== undefined && this.canArchiveBoundEntry(conflict, entry);
      const archived = canArchive ? this.entries.updateStatusWithinTransaction({ workspaceId: entry.workspaceId,
        entryId: entry.id, expectedVersion: conflict.entry_version!, status: 'archived', updatedAt: timestamp }) : undefined;
      if (archived) this.appendEntryEvent(archived, 'memory.entry_archived', timestamp, 'memory.entry_edit');
      const update = this.db.prepare(`
        UPDATE preference_confirmations SET status = 'revoked', version = version + 1,
          entry_version = COALESCE(?, entry_version), updated_at = ? WHERE id = ? AND status = 'confirmed' AND version = ?
      `).run(archived?.version ?? null, timestamp, conflict.id, conflict.version) as { changes: number | bigint };
      if (Number(update.changes) !== 1) throw new PreferenceConfirmationError('PREFERENCE_VERSION_CONFLICT');
      this.appendAudit({ id: conflict.id, projectionId: conflict.projection_id,
        workspaceId: entry?.workspaceId ?? conflict.entry_workspace_id ?? workspaceId,
        action: 'replaced', actor: 'user', expectedVersion: conflict.version, version: conflict.version + 1,
        entryId: entry?.id ?? conflict.entry_id ?? undefined, details: { replacedByProjectionId: pending.projection_id,
          ...(archived ? { archivedEntryVersion: archived.version } : {
            entryPreservedReason: this.preservedEntryReason(conflict, entry),
            ...(entry ? { observedEntryVersion: entry.version, observedEntryStatus: entry.status } : {}),
          }) }, occurredAt: timestamp });
    }
  }

  private findBoundEntry(row: ConfirmationRow): MemoryEntryRecord | undefined {
    if (!row.entry_id || !row.entry_workspace_id || row.entry_version === null) return undefined;
    const entry = this.entries.findById(row.entry_workspace_id, row.entry_id);
    return entry?.workspaceId === row.entry_workspace_id ? entry : undefined;
  }

  private matchesConfirmedPreference(row: ConfirmationRow, entry: MemoryEntryRecord): boolean {
    return entry.category === 'preference' && entry.authority === 'user-explicit' && entry.scope === row.scope
      && entry.tags.includes(`dimension:${row.dimension}`) && entry.tags.includes(`context:${row.context_kind}`)
      && entry.tags.includes(`value:${row.preferred_value}`);
  }

  private canArchiveBoundEntry(row: ConfirmationRow, entry: MemoryEntryRecord): boolean {
    return entry.status !== 'archived' && entry.status !== 'deleted'
      && entry.version === row.entry_version && this.matchesConfirmedPreference(row, entry);
  }

  private preservedEntryReason(row: ConfirmationRow, entry: MemoryEntryRecord | undefined): string {
    if (!entry) return 'entry_missing';
    if (entry.status === 'archived') return 'entry_already_archived';
    if (entry.status === 'deleted') return 'entry_already_deleted';
    if (entry.version !== row.entry_version) return 'entry_version_changed';
    return 'entry_binding_changed';
  }

  private updateTerminalState(
    row: ConfirmationRow, status: 'rejected' | 'revoked', expectedVersion: number, workspaceId: string,
    timestamp: string, action: 'rejected' | 'revoked', entryVersion?: number, extraDetails: Record<string, unknown> = {},
  ): void {
    const update = this.db.prepare(`
      UPDATE preference_confirmations SET status = ?, version = version + 1,
        entry_version = COALESCE(?, entry_version), updated_at = ?
      WHERE id = ? AND status = ? AND version = ?
    `).run(status, entryVersion ?? null, timestamp, row.id, row.status, expectedVersion) as { changes: number | bigint };
    if (Number(update.changes) !== 1) throw new PreferenceConfirmationError('PREFERENCE_VERSION_CONFLICT');
    this.appendAudit({ id: row.id, projectionId: row.projection_id, workspaceId, action, actor: 'user',
      expectedVersion, version: expectedVersion + 1, entryId: row.entry_id ?? undefined,
      details: { previousStatus: row.status, preferredValue: row.preferred_value,
        evidence: JSON.parse(row.evidence_json), ...extraDetails }, occurredAt: timestamp });
  }

  private appendEntryEvent(entry: MemoryEntryRecord, type: 'memory.entry_created' | 'memory.entry_archived', timestamp: string,
    originKind: 'memory.entry_save' | 'memory.entry_edit'): void {
    const origin = { kind: originKind, entryId: entry.id, entryVersion: entry.version } as const;
    this.store.workspaceEventWriter().appendWithinTransaction({
      type, workspaceId: entry.workspaceId, timestamp, origin, context: deriveWorkspaceEventContext(origin),
      payload: { memoryEntryId: entry.id, version: entry.version, scope: entry.scope, category: entry.category, authority: entry.authority },
    });
  }

  private appendAudit(input: {
    id: string; projectionId: string; workspaceId: string | null;
    action: 'suggested' | 'refreshed' | 'confirmed' | 'rejected' | 'revoked' | 'replaced';
    actor: 'learner' | 'user'; expectedVersion: number | null; version: number; entryId?: string;
    details: Record<string, unknown>; occurredAt: string;
  }): void {
    this.db.prepare(`
      INSERT INTO preference_confirmation_audit (
        suggestion_id, projection_id, workspace_id, action, actor, expected_version,
        version, entry_id, details_json, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.id, input.projectionId, input.workspaceId, input.action, input.actor, input.expectedVersion,
      input.version, input.entryId ?? null, JSON.stringify(input.details), input.occurredAt);
  }

  private getById(id: string): ConfirmationRow | undefined {
    return this.db.prepare(`
      SELECT id, projection_id, profile_id, projection_scope, projection_workspace_id, workspace_id,
        status, version, preferred_value, dimension, context_kind, scope, confidence, evidence_count,
        evidence_json, entry_id, entry_workspace_id, entry_version, created_at, updated_at
      FROM preference_confirmations WHERE id = ?
    `).get(id) as ConfirmationRow | undefined;
  }
}
