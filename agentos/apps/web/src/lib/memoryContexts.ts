export const MEMORY_CONTEXT_KINDS = ['run', 'stage', 'turn', 'legacy-execution'] as const;

export type MemoryContextKind = (typeof MEMORY_CONTEXT_KINDS)[number];

export interface MemoryContextSelection {
  readonly memoryId: string;
  readonly memoryVersion: number | null;
  readonly rank: number | null;
  readonly reasons: readonly string[];
  readonly tokenCost: number | null;
  readonly store?: string;
}

export interface MemoryContextExclusion {
  readonly memoryId: string;
  readonly reason: string | null;
}

/** Client-side projection of the workspace memory contexts read API. */
export interface MemoryContextRecord {
  readonly id: string;
  readonly kind: MemoryContextKind;
  readonly ownerId: string | null;
  readonly runId?: string | null;
  readonly stageId?: string | null;
  readonly executionId?: string | null;
  readonly conversationId?: string | null;
  readonly turnId?: string | null;
  readonly createdAt: string;
  readonly queryHash: string | null;
  readonly retrievalStrategyVersion: string;
  readonly contextText: string | null;
  readonly payloadAvailable: boolean;
  readonly totalTokens: number;
  readonly truncated: boolean;
  /** Older metadata-only Turn snapshots do not have a recorded degraded flag. */
  readonly retrievalDegraded?: boolean;
  /** null means the historical record did not persist this explanation. */
  readonly selected: readonly MemoryContextSelection[] | null;
  /** null means the historical record did not persist this explanation. */
  readonly exclusions: readonly MemoryContextExclusion[] | null;
}

export interface MemoryContextQuery {
  readonly kind?: MemoryContextKind;
  readonly ownerId?: string;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(record: UnknownRecord, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid memory context response: ${field} is missing.`);
  }
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error(`Invalid memory context response: ${field} must be a string or null.`);
  return value;
}

function optionalString(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  return nullableString(value, field);
}

function optionalNonNegativeInteger(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Invalid memory context response: ${field} must be a non-negative integer or null.`);
  }
  return value as number;
}

function parseSelection(value: unknown, index: number): MemoryContextSelection {
  if (!isRecord(value)) throw new Error(`Invalid memory context response: selected[${index}] is invalid.`);
  const memoryId = requiredString(value, 'memoryId');
  const reasonsValue = value.reasons;
  const reasons = reasonsValue === undefined
    ? (typeof value.reason === 'string' ? [value.reason] : [])
    : Array.isArray(reasonsValue) && reasonsValue.every(reason => typeof reason === 'string')
      ? reasonsValue as string[]
      : null;
  if (reasons === null) throw new Error(`Invalid memory context response: selected[${index}].reasons is invalid.`);
  const store = optionalString(value.store, `selected[${index}].store`);

  return {
    memoryId,
    memoryVersion: optionalNonNegativeInteger(value.memoryVersion, `selected[${index}].memoryVersion`),
    rank: optionalNonNegativeInteger(value.rank, `selected[${index}].rank`),
    reasons,
    tokenCost: optionalNonNegativeInteger(value.tokenCost, `selected[${index}].tokenCost`),
    ...(store === undefined || store === null ? {} : { store }),
  };
}

function parseExclusion(value: unknown, index: number): MemoryContextExclusion {
  if (!isRecord(value)) throw new Error(`Invalid memory context response: exclusions[${index}] is invalid.`);
  const reasonValue = value.reason ?? value.reasons;
  let reason: string | null;
  if (reasonValue === undefined || reasonValue === null) {
    reason = null;
  } else if (typeof reasonValue === 'string') {
    reason = reasonValue;
  } else if (Array.isArray(reasonValue) && reasonValue.every(item => typeof item === 'string')) {
    reason = (reasonValue as string[]).join(', ') || null;
  } else {
    throw new Error(`Invalid memory context response: exclusions[${index}].reason is invalid.`);
  }
  return { memoryId: requiredString(value, 'memoryId'), reason };
}

function optionalExplanation<T>(
  record: UnknownRecord,
  field: 'selected' | 'exclusions',
  parseItem: (value: unknown, index: number) => T,
): readonly T[] | null {
  const value = record[field];
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw new Error(`Invalid memory context response: ${field} must be an array or null.`);
  return value.map(parseItem);
}

function parseContext(value: unknown): MemoryContextRecord {
  if (!isRecord(value)) throw new Error('Invalid memory context response: context must be an object.');
  const kindValue = value.kind;
  if (typeof kindValue !== 'string' || !(MEMORY_CONTEXT_KINDS as readonly string[]).includes(kindValue)) {
    throw new Error('Invalid memory context response: kind is unsupported.');
  }
  if (typeof value.payloadAvailable !== 'boolean') {
    throw new Error('Invalid memory context response: payloadAvailable is missing.');
  }
  if (typeof value.truncated !== 'boolean') throw new Error('Invalid memory context response: truncated is missing.');
  if (typeof value.totalTokens !== 'number' || !Number.isFinite(value.totalTokens) || value.totalTokens < 0) {
    throw new Error('Invalid memory context response: totalTokens is invalid.');
  }
  if (value.retrievalDegraded !== undefined && typeof value.retrievalDegraded !== 'boolean') {
    throw new Error('Invalid memory context response: retrievalDegraded must be a boolean.');
  }
  if (value.contextText !== undefined && value.contextText !== null && typeof value.contextText !== 'string') {
    throw new Error('Invalid memory context response: contextText must be a string or null.');
  }

  const runId = optionalString(value.runId, 'runId');
  const stageId = optionalString(value.stageId, 'stageId');
  const executionId = optionalString(value.executionId, 'executionId');
  const conversationId = optionalString(value.conversationId, 'conversationId');
  const turnId = optionalString(value.turnId, 'turnId');
  const record: MemoryContextRecord = {
    id: requiredString(value, 'id'),
    kind: kindValue as MemoryContextKind,
    ownerId: nullableString(value.ownerId, 'ownerId'),
    createdAt: requiredString(value, 'createdAt'),
    queryHash: nullableString(value.queryHash, 'queryHash'),
    retrievalStrategyVersion: requiredString(value, 'retrievalStrategyVersion'),
    contextText: nullableString(value.contextText, 'contextText'),
    payloadAvailable: value.payloadAvailable,
    totalTokens: value.totalTokens,
    truncated: value.truncated,
    selected: optionalExplanation(value, 'selected', parseSelection),
    exclusions: optionalExplanation(value, 'exclusions', parseExclusion),
    ...(value.retrievalDegraded === undefined ? {} : { retrievalDegraded: value.retrievalDegraded }),
    ...(runId === undefined ? {} : { runId }),
    ...(stageId === undefined ? {} : { stageId }),
    ...(executionId === undefined ? {} : { executionId }),
    ...(conversationId === undefined ? {} : { conversationId }),
    ...(turnId === undefined ? {} : { turnId }),
  };
  return record;
}

export function memoryContextsPath(workspaceId: string, query: MemoryContextQuery = {}): string {
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}/memory/contexts`;
  const params = new URLSearchParams();
  if (query.kind) params.set('kind', query.kind);
  if (query.ownerId !== undefined && query.ownerId.trim().length > 0) params.set('ownerId', query.ownerId);
  const serialized = params.toString();
  return serialized.length > 0 ? `${base}?${serialized}` : base;
}

export function parseMemoryContextsResponse(value: unknown): readonly MemoryContextRecord[] {
  if (!isRecord(value) || !Array.isArray(value.contexts)) {
    throw new Error('Invalid memory context response: contexts must be an array.');
  }
  return value.contexts.map(parseContext);
}
