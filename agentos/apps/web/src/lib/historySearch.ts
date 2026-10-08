/**
 * Agent History + Search — the query model (Lite 09 §13, 12 §16).
 *
 * Pure, framework-agnostic search state for the unified Agent History surface. History
 * is unified by Agent Profile across Provider changes; results link to canonical source
 * records. Secrets and native Provider transcript content are never indexed — the query
 * model has no content-search mode, and the Server's history read surface returns
 * non-secret-bearing labels only.
 */

export const HISTORY_KINDS = [
  'conversation', 'message', 'turn', 'task', 'run',
  'memory', 'context-snapshot', 'turn-context', 'artifact',
] as const;
export type HistoryKind = (typeof HISTORY_KINDS)[number];

export interface HistorySearchFilters {
  readonly agentId: string;
  readonly kind?: HistoryKind;
  readonly status?: string;
  readonly conversationId?: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly providerConfigId?: string;
  readonly from?: string;
  readonly to?: string;
  /** Non-secret-bearing label search (titles/summaries only). */
  readonly q?: string;
  readonly limit?: number;
}

export const HISTORY_LIMIT_DEFAULT = 50;
export const HISTORY_LIMIT_MAX = 200;

export class HistorySearchError extends Error {
  constructor(readonly code: 'AGENT_REQUIRED' | 'LIMIT_INVALID' | 'TIME_RANGE_INVALID' | 'KIND_INVALID') {
    super(`HISTORY_SEARCH_${code}`);
    this.name = 'HistorySearchError';
  }
}

export interface HistorySearchValidation {
  readonly valid: boolean;
  readonly code?: HistorySearchError['code'];
}

/** Fail-closed validation for untyped callers. */
export function validateHistorySearch(filters: HistorySearchFilters): HistorySearchValidation {
  if (typeof filters !== 'object' || filters === null
    || typeof filters.agentId !== 'string' || filters.agentId.trim().length === 0) {
    return { valid: false, code: 'AGENT_REQUIRED' };
  }
  if (filters.kind !== undefined && !HISTORY_KINDS.includes(filters.kind)) {
    return { valid: false, code: 'KIND_INVALID' };
  }
  if (filters.limit !== undefined
    && (!Number.isSafeInteger(filters.limit) || filters.limit < 1 || filters.limit > HISTORY_LIMIT_MAX)) {
    return { valid: false, code: 'LIMIT_INVALID' };
  }
  if (filters.from !== undefined && filters.to !== undefined) {
    const start = Date.parse(filters.from);
    const end = Date.parse(filters.to);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      return { valid: false, code: 'TIME_RANGE_INVALID' };
    }
  }
  return { valid: true };
}

/** Build the forward history query string (order-stable, encodes every filter). */
export function historyQueryString(filters: HistorySearchFilters): string {
  const validation = validateHistorySearch(filters);
  if (!validation.valid) throw new HistorySearchError(validation.code!);
  const params = new URLSearchParams();
  if (filters.kind !== undefined) params.set('kind', filters.kind);
  if (filters.status !== undefined) params.set('status', filters.status);
  if (filters.conversationId !== undefined) params.set('conversationId', filters.conversationId);
  if (filters.taskId !== undefined) params.set('taskId', filters.taskId);
  if (filters.runId !== undefined) params.set('runId', filters.runId);
  if (filters.providerConfigId !== undefined) params.set('providerConfigId', filters.providerConfigId);
  if (filters.from !== undefined) params.set('from', filters.from);
  if (filters.to !== undefined) params.set('to', filters.to);
  if (filters.q !== undefined && filters.q.trim().length > 0) params.set('q', filters.q.trim());
  params.set('limit', String(filters.limit ?? HISTORY_LIMIT_DEFAULT));
  return params.toString();
}

export interface HistoryEntry {
  readonly kind: HistoryKind;
  readonly id: string;
  readonly at: string;
  readonly status: string | null;
  readonly label: string | null;
  readonly conversationId: string | null;
  readonly taskId: string | null;
  readonly runId: string | null;
  readonly messageId: string | null;
  readonly turnId: string | null;
  readonly providerSessionId: string | null;
  readonly referenceId: string | null;
}

/** Group results by kind in the displayed order, preserving newest-first within a kind. */
export function groupHistoryByKind(entries: readonly HistoryEntry[]): ReadonlyArray<{ kind: HistoryKind; entries: readonly HistoryEntry[] }> {
  const groups: Array<{ kind: HistoryKind; entries: HistoryEntry[] }> = [];
  for (const entry of entries) {
    let group = groups.find(g => g.kind === entry.kind);
    if (group === undefined) {
      group = { kind: entry.kind, entries: [] };
      groups.push(group);
    }
    group.entries.push(entry);
  }
  return groups.map(group => ({ kind: group.kind, entries: group.entries }));
}

/**
 * The canonical-source link target for one History entry: the Inspector for a Run,
 * the Conversation for a Message, and so on. Results always link to canonical source
 * records rather than re-rendering them.
 */
export function historyReferenceTarget(entry: HistoryEntry): { readonly kind: 'run' | 'conversation' | 'task' | 'agent' | 'none'; readonly id: string | null } {
  switch (entry.kind) {
    case 'run': return { kind: 'run', id: entry.runId };
    case 'message': return { kind: 'conversation', id: entry.conversationId };
    case 'turn': return { kind: 'conversation', id: entry.conversationId };
    case 'turn-context': return { kind: 'conversation', id: entry.conversationId };
    case 'conversation': return { kind: 'conversation', id: entry.conversationId };
    case 'task': return { kind: 'task', id: entry.taskId };
    case 'context-snapshot': return { kind: 'run', id: entry.runId };
    case 'artifact': return { kind: 'run', id: entry.runId };
    case 'memory': return { kind: 'none', id: null };
  }
}

/** True when an entry carries no indexable label (nothing for search to match). */
export function isLabelSearchable(entry: HistoryEntry): boolean {
  return entry.label !== null && entry.label.trim().length > 0;
}

