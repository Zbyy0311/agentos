import { isMemoryTextSafe } from '../store/MemoryContentSafety.js';
import type { TransactionDatabase } from '../store/Transaction.js';

export const MEMORY_MAINTENANCE_MAX_SUGGESTIONS = 100;
export const MEMORY_MAINTENANCE_LOW_VALUE_MIN_AGE_MS = 180 * 24 * 60 * 60 * 1000;
export const MEMORY_MAINTENANCE_LOW_VALUE_MAX_IMPORTANCE = 0.2;
export const MEMORY_MAINTENANCE_LOW_VALUE_MAX_CONFIDENCE = 0.35;

export type MemoryMaintenanceReasonCode = 'expired' | 'outdated-feedback' | 'low-value';
export type MemoryMaintenanceLifecycleAction = 'revalidate' | 'set-validity' | 'archive';

export interface MemoryMaintenanceSuggestion {
  readonly entryId: string;
  readonly version: number;
  readonly title: string;
  readonly reasonCode: MemoryMaintenanceReasonCode;
  readonly reason: string;
  readonly proposedLifecycleAction: MemoryMaintenanceLifecycleAction;
}

export interface MemoryMaintenanceResult {
  readonly available: boolean;
  readonly evaluatedAt: string;
  readonly suggestions: readonly MemoryMaintenanceSuggestion[];
}

interface EntryRow {
  readonly id: unknown;
  readonly version: unknown;
  readonly title: unknown;
  readonly scope: unknown;
  readonly category: unknown;
  readonly tags_json: unknown;
  readonly status: unknown;
  readonly pinned: unknown;
  readonly valid_from: unknown;
  readonly valid_until: unknown;
  readonly expires_at: unknown;
  readonly confidence: unknown;
  readonly importance: unknown;
  readonly sensitivity: unknown;
  readonly updated_at: unknown;
}

interface Candidate {
  readonly row: EntryRow;
  readonly updatedAt: string;
  readonly expiredByDate: boolean;
  readonly statusExpired: boolean;
}

interface RankedSuggestion {
  readonly suggestion: MemoryMaintenanceSuggestion;
  readonly priority: number;
  readonly updatedAt: string;
}

const CORE_ENTRY_COLUMNS = [
  'id', 'workspace_id', 'scope', 'category', 'tags_json', 'status', 'pinned', 'valid_from', 'valid_until',
  'expires_at', 'confidence', 'importance', 'sensitivity', 'version', 'title', 'updated_at',
] as const;

const LIFECYCLE_COLUMNS = [
  'id', 'workspace_id', 'entry_id', 'action', 'from_version', 'to_version',
  'before_json', 'after_json', 'created_at',
] as const;

const FEEDBACK_COLUMNS = [
  'id', 'workspace_id', 'entry_id', 'entry_version', 'current_entry_version', 'kind',
] as const;

const FEEDBACK_ACTION_COLUMNS = [
  'feedback_id', 'workspace_id', 'entry_id', 'entry_version', 'action', 'status',
] as const;

const EXPIRED_REASON = 'This entry is already ineligible for retrieval because its validity ended. Revalidation leaves the expired dates unchanged; a human must explicitly review and update validity before the entry can be retrieved again.';
const EXPIRED_STATUS_REASON = 'This entry is marked expired. Set validity dates only after human review; it remains expired until a separate human revalidation.';
const OUTDATED_FEEDBACK_REASON = 'A pending outdated-memory report matches the current entry version; review the source and validity before revalidation.';
const LOW_VALUE_REASON = 'Conservative low-value heuristic: active, unpinned, ordinary-sensitivity entry with importance at or below 0.2, confidence at or below 0.35, and no update for at least 180 days; global and preference entries are excluded.';

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function readTableColumns(db: TransactionDatabase, table: 'memory_entries' | 'memory_lifecycle_actions'
  | 'memory_version_feedback' | 'memory_feedback_actions'): Set<string> | undefined {
  const found = db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (!found) return undefined;
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
  return new Set(rows.flatMap(row => typeof row.name === 'string' ? [row.name] : []));
}

function hasColumns(actual: Set<string> | undefined, required: readonly string[]): boolean {
  return actual !== undefined && required.every(column => actual.has(column));
}

function dateMs(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function candidateFromRow(row: EntryRow, nowMs: number): Candidate | undefined {
  if (typeof row.id !== 'string' || !nonBlank(row.id) || !isMemoryTextSafe(row.id)
    || typeof row.title !== 'string' || !nonBlank(row.title) || !isMemoryTextSafe(row.title)
    || typeof row.version !== 'number' || !Number.isSafeInteger(row.version) || row.version < 1
    || (row.status !== 'active' && row.status !== 'expired')
    || (row.scope !== 'workspace' && row.scope !== 'agent' && row.scope !== 'conversation' && row.scope !== 'task' && row.scope !== 'run')
    || row.category === 'preference' || row.sensitivity !== 'ordinary'
    || typeof row.tags_json !== 'string' || !isSafePreferenceTags(row.tags_json)) {
    return undefined;
  }

  const validFrom = dateMs(row.valid_from);
  const validUntil = dateMs(row.valid_until);
  const expiresAt = dateMs(row.expires_at);
  if (validFrom === undefined || validUntil === undefined || expiresAt === undefined
    || (row.status === 'active' && validFrom !== null && validFrom > nowMs)
    || typeof row.updated_at !== 'string' || !Number.isFinite(Date.parse(row.updated_at))) {
    return undefined;
  }

  const expiredByDate = (validUntil !== null && validUntil <= nowMs)
    || (expiresAt !== null && expiresAt <= nowMs);
  return {
    row,
    updatedAt: row.updated_at,
    expiredByDate,
    statusExpired: row.status === 'expired',
  };
}

function isSafePreferenceTags(value: string): boolean {
  try {
    const tags: unknown = JSON.parse(value);
    return Array.isArray(tags) && tags.every(tag => typeof tag === 'string') && !tags.includes('preference');
  } catch {
    return false;
  }
}

function isLowValueCandidate(candidate: Candidate, nowMs: number): boolean {
  const row = candidate.row;
  return row.status === 'active'
    && row.pinned === 0
    && !candidate.expiredByDate
    && typeof row.importance === 'number' && Number.isFinite(row.importance)
    && row.importance <= MEMORY_MAINTENANCE_LOW_VALUE_MAX_IMPORTANCE
    && typeof row.confidence === 'number' && Number.isFinite(row.confidence)
    && row.confidence <= MEMORY_MAINTENANCE_LOW_VALUE_MAX_CONFIDENCE
    && Date.parse(candidate.updatedAt) <= nowMs - MEMORY_MAINTENANCE_LOW_VALUE_MIN_AGE_MS;
}

/**
 * Read-only maintenance suggestions. Expiration is evaluated independently of
 * pin state because a pin cannot make an expired Entry retrievable. The
 * low-value archive heuristic is intentionally narrower: active, unpinned,
 * ordinary-sensitivity, non-global, non-preference Entries with low importance
 * and confidence that have not changed in at least 180 days. Suggestions never
 * mutate Entries, feedback, lifecycle audit rows, or frozen context history.
 */
export class MemoryMaintenanceService {
  constructor(
    private readonly db: TransactionDatabase,
    private readonly now: () => number = () => Date.now(),
  ) {}

  list(workspaceId: string): MemoryMaintenanceResult {
    if (!nonBlank(workspaceId) || workspaceId.length > 200) throw new Error('MEMORY_MAINTENANCE_INPUT_INVALID');

    const nowMs = this.now();
    if (!Number.isFinite(nowMs) || !Number.isFinite(new Date(nowMs).getTime())) {
      throw new Error('MEMORY_MAINTENANCE_CLOCK_INVALID');
    }
    const evaluatedAt = new Date(nowMs).toISOString();
    const empty = (available: boolean): MemoryMaintenanceResult => ({ available, evaluatedAt, suggestions: [] });

    const entryColumns = readTableColumns(this.db, 'memory_entries');
    const lifecycleColumns = readTableColumns(this.db, 'memory_lifecycle_actions');
    if (!hasColumns(entryColumns, CORE_ENTRY_COLUMNS) || !hasColumns(lifecycleColumns, LIFECYCLE_COLUMNS)) {
      return empty(false);
    }

    const ranked = new Map<string, RankedSuggestion>();
    const add = (candidate: Candidate, reasonCode: MemoryMaintenanceReasonCode,
      reason: string, proposedLifecycleAction: MemoryMaintenanceLifecycleAction, priority: number): void => {
      const row = candidate.row;
      const suggestion: MemoryMaintenanceSuggestion = {
        entryId: row.id as string,
        version: row.version as number,
        title: row.title as string,
        reasonCode,
        reason,
        proposedLifecycleAction,
      };
      const existing = ranked.get(suggestion.entryId);
      if (!existing || priority < existing.priority) {
        ranked.set(suggestion.entryId, { suggestion, priority, updatedAt: candidate.updatedAt });
      }
    };

    const expiredRows = this.db.prepare(`SELECT id, version, title, scope, category, tags_json, status, pinned,
        valid_from, valid_until, expires_at, confidence, importance, sensitivity, updated_at
      FROM memory_entries
      WHERE workspace_id = ? AND scope <> 'global' AND category <> 'preference'
        AND instr(tags_json, '"preference"') = 0
        AND sensitivity = 'ordinary' AND status IN ('active','expired')
        AND (status = 'expired' OR valid_from IS NULL OR julianday(valid_from) <= julianday(?))
        AND (status = 'expired' OR julianday(valid_until) <= julianday(?) OR julianday(expires_at) <= julianday(?))
      ORDER BY updated_at ASC, id ASC LIMIT ?`).all(
      workspaceId, evaluatedAt, evaluatedAt, evaluatedAt, MEMORY_MAINTENANCE_MAX_SUGGESTIONS,
    ) as EntryRow[];
    for (const row of expiredRows) {
      const candidate = candidateFromRow(row, nowMs);
      if (!candidate || (!candidate.expiredByDate && !candidate.statusExpired)) continue;
      // Keep an explicitly expired status in place until a person changes its
      // validity; date-expired active rows remain unretrievable after revalidate
      // because their old end date is intentionally preserved by M2.
      const action = candidate.expiredByDate ? 'revalidate' : 'set-validity';
      add(candidate, 'expired', candidate.statusExpired && !candidate.expiredByDate ? EXPIRED_STATUS_REASON : EXPIRED_REASON, action, 0);
    }

    const feedbackColumns = readTableColumns(this.db, 'memory_version_feedback');
    const feedbackActionColumns = readTableColumns(this.db, 'memory_feedback_actions');
    if (hasColumns(feedbackColumns, FEEDBACK_COLUMNS) && hasColumns(feedbackActionColumns, FEEDBACK_ACTION_COLUMNS)) {
      try {
        const feedbackRows = this.db.prepare(`SELECT e.id, e.version, e.title, e.scope, e.category, e.tags_json, e.status,
            e.pinned, e.valid_from, e.valid_until, e.expires_at, e.confidence, e.importance,
            e.sensitivity, e.updated_at
          FROM memory_feedback_actions a
          INNER JOIN memory_version_feedback f
            ON f.id = a.feedback_id AND f.workspace_id = a.workspace_id AND f.entry_id = a.entry_id
          INNER JOIN memory_entries e ON e.workspace_id = a.workspace_id AND e.id = a.entry_id
          WHERE a.workspace_id = ? AND f.workspace_id = ? AND e.workspace_id = ?
            AND a.action = 'revalidation' AND a.status = 'pending'
            AND f.kind = 'outdated' AND a.entry_version = f.entry_version
            AND f.current_entry_version = e.version
            AND e.scope <> 'global' AND e.category <> 'preference'
            AND instr(e.tags_json, '"preference"') = 0 AND e.sensitivity = 'ordinary'
            AND e.status IN ('active','expired')
          ORDER BY e.updated_at ASC, e.id ASC LIMIT ?`).all(
          workspaceId, workspaceId, workspaceId, MEMORY_MAINTENANCE_MAX_SUGGESTIONS,
        ) as EntryRow[];
        for (const row of feedbackRows) {
          const candidate = candidateFromRow(row, nowMs);
          if (!candidate) continue;
          if (candidate.expiredByDate || candidate.statusExpired) {
            const action = candidate.expiredByDate ? 'revalidate' : 'set-validity';
            add(candidate, 'expired', candidate.statusExpired && !candidate.expiredByDate ? EXPIRED_STATUS_REASON : EXPIRED_REASON, action, 0);
          } else {
            add(candidate, 'outdated-feedback', OUTDATED_FEEDBACK_REASON, 'revalidate', 1);
          }
        }
      } catch {
        // Feedback is optional on older M1/M2 schemas. Core maintenance remains
        // available if the optional M3 tables are absent or incompatible.
      }
    }

    const lowValueRows = this.db.prepare(`SELECT id, version, title, scope, category, tags_json, status, pinned,
        valid_from, valid_until, expires_at, confidence, importance, sensitivity, updated_at
      FROM memory_entries
      WHERE workspace_id = ? AND status = 'active' AND scope <> 'global' AND category <> 'preference'
        AND instr(tags_json, '"preference"') = 0
        AND pinned = 0 AND sensitivity = 'ordinary'
        AND importance <= ? AND confidence <= ?
        AND julianday(updated_at) <= julianday(?)
        AND (valid_from IS NULL OR julianday(valid_from) <= julianday(?))
        AND (valid_until IS NULL OR julianday(valid_until) > julianday(?))
        AND (expires_at IS NULL OR julianday(expires_at) > julianday(?))
      ORDER BY updated_at ASC, id ASC LIMIT ?`).all(
      workspaceId,
      MEMORY_MAINTENANCE_LOW_VALUE_MAX_IMPORTANCE,
      MEMORY_MAINTENANCE_LOW_VALUE_MAX_CONFIDENCE,
      new Date(nowMs - MEMORY_MAINTENANCE_LOW_VALUE_MIN_AGE_MS).toISOString(),
      evaluatedAt, evaluatedAt, evaluatedAt, MEMORY_MAINTENANCE_MAX_SUGGESTIONS,
    ) as EntryRow[];
    for (const row of lowValueRows) {
      const candidate = candidateFromRow(row, nowMs);
      if (candidate && isLowValueCandidate(candidate, nowMs)) {
        add(candidate, 'low-value', LOW_VALUE_REASON, 'archive', 2);
      }
    }

    const suggestions = [...ranked.values()]
      .sort((left, right) => left.priority - right.priority
        || compareText(left.updatedAt, right.updatedAt)
        || compareText(left.suggestion.entryId, right.suggestion.entryId))
      .slice(0, MEMORY_MAINTENANCE_MAX_SUGGESTIONS)
      .map(item => item.suggestion);
    return { available: true, evaluatedAt, suggestions };
  }
}
