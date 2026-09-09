/**
 * MF-5 Memory Runtime Event definitions.
 *
 * Registers the canonical Memory event family on the existing Runtime Event
 * registry so Memory facts flow through the merged Event + Outbox path. This
 * module defines payload guards and definitions only; it performs no emission
 * and no persistence.
 *
 * Payloads carry stable references, scores, reasons, and budget facts rather
 * than sensitive full Memory content (`07-Memory-Runtime.md` §15).
 */

import type { RuntimeEventDefinition, RuntimeEventPayloadGuard } from './m3-runtime-registry.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function hasOnly(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every(key => keys.includes(key));
}
function hasValue<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && values.includes(value as T);
}

export interface MemoryEntryEventPayload {
  readonly memoryEntryId: string;
  readonly version: number;
  readonly scope: string;
  readonly category: string;
  readonly authority: string;
}

export interface MemoryCandidateEventPayload {
  readonly candidateId: string;
  readonly scope: string;
  readonly category: string;
  readonly authority: string;
  readonly decision: 'auto-accept' | 'review-required' | 'reject';
}

export interface MemoryConflictEventPayload {
  readonly conflictId: string;
  readonly conflictType: string;
  readonly entryAId: string;
  readonly entryBId: string;
}

export interface MemoryRetrievalEventPayload {
  readonly queryHash: string;
  readonly strategyVersion: string;
  readonly candidateCount: number;
  readonly selectedCount: number;
  readonly totalTokens: number;
  readonly degraded: boolean;
}

export interface MemoryContextEventPayload {
  readonly memoryContextId: string;
  readonly runId: string;
  readonly selectedCount: number;
  readonly totalTokens: number;
  readonly truncated: boolean;
}

export function isMemoryEntryEventPayload(value: unknown): value is MemoryEntryEventPayload {
  if (!isRecord(value)) return false;
  return (
    hasOnly(value, ['memoryEntryId', 'version', 'scope', 'category', 'authority'])
    && isNonEmptyString(value.memoryEntryId)
    && isPositiveSafeInteger(value.version)
    && isNonEmptyString(value.scope)
    && isNonEmptyString(value.category)
    && isNonEmptyString(value.authority)
  );
}

export function isMemoryCandidateEventPayload(value: unknown): value is MemoryCandidateEventPayload {
  if (!isRecord(value)) return false;
  return (
    hasOnly(value, ['candidateId', 'scope', 'category', 'authority', 'decision'])
    && isNonEmptyString(value.candidateId)
    && isNonEmptyString(value.scope)
    && isNonEmptyString(value.category)
    && isNonEmptyString(value.authority)
    && hasValue(['auto-accept', 'review-required', 'reject'], value.decision)
  );
}

export function isMemoryConflictEventPayload(value: unknown): value is MemoryConflictEventPayload {
  if (!isRecord(value)) return false;
  return (
    hasOnly(value, ['conflictId', 'conflictType', 'entryAId', 'entryBId'])
    && isNonEmptyString(value.conflictId)
    && isNonEmptyString(value.conflictType)
    && isNonEmptyString(value.entryAId)
    && isNonEmptyString(value.entryBId)
  );
}

export function isMemoryRetrievalEventPayload(value: unknown): value is MemoryRetrievalEventPayload {
  if (!isRecord(value)) return false;
  return (
    hasOnly(value, ['queryHash', 'strategyVersion', 'candidateCount', 'selectedCount', 'totalTokens', 'degraded'])
    && isNonEmptyString(value.queryHash)
    && isNonEmptyString(value.strategyVersion)
    && isNonNegativeSafeInteger(value.candidateCount)
    && isNonNegativeSafeInteger(value.selectedCount)
    && isNonNegativeSafeInteger(value.totalTokens)
    && typeof value.degraded === 'boolean'
  );
}

export function isMemoryContextEventPayload(value: unknown): value is MemoryContextEventPayload {
  if (!isRecord(value)) return false;
  return (
    hasOnly(value, ['memoryContextId', 'runId', 'selectedCount', 'totalTokens', 'truncated'])
    && isNonEmptyString(value.memoryContextId)
    && isNonEmptyString(value.runId)
    && isNonNegativeSafeInteger(value.selectedCount)
    && isNonNegativeSafeInteger(value.totalTokens)
    && typeof value.truncated === 'boolean'
  );
}

const ENTRY_FIELDS = ['memoryEntryId', 'version', 'scope', 'category', 'authority'] as const;
const RETRIEVAL_FIELDS = [
  'queryHash', 'strategyVersion', 'candidateCount', 'selectedCount', 'totalTokens', 'degraded',
] as const;
const CONTEXT_FIELDS = ['memoryContextId', 'runId', 'selectedCount', 'totalTokens', 'truncated'] as const;

function memoryEventDefinition(
  type: string,
  description: string,
  required: readonly string[],
  validatePayload: RuntimeEventPayloadGuard<unknown>,
): RuntimeEventDefinition {
  return {
    type,
    domain: 'memory',
    description,
    schemaVersion: 1,
    source: 'memory-engine',
    defaultSeverity: 'info',
    defaultVisibility: 'internal',
    defaultDurability: 'durable',
    payloadSchema: { required, optional: [] },
    forbidsStageId: true,
    validatePayload,
  };
}

/** The Lite memory event family (07-Memory-Runtime.md §15). */
export const MF5_MEMORY_EVENT_DEFINITIONS: readonly RuntimeEventDefinition[] = Object.freeze([
  memoryEventDefinition(
    'memory.candidate_created',
    'A Memory Candidate was created from a bounded evidence bundle.',
    ['candidateId', 'scope', 'category', 'authority', 'decision'],
    isMemoryCandidateEventPayload,
  ),
  memoryEventDefinition('memory.entry_created', 'A Memory Entry became durable.', ENTRY_FIELDS, isMemoryEntryEventPayload),
  memoryEventDefinition('memory.entry_updated', 'A Memory Entry was updated under optimistic concurrency.', ENTRY_FIELDS, isMemoryEntryEventPayload),
  memoryEventDefinition('memory.entry_conflicted', 'A Memory Entry entered the conflicted state.', ENTRY_FIELDS, isMemoryEntryEventPayload),
  memoryEventDefinition('memory.entry_deduplicated', 'An exact or near duplicate converged onto an existing Entry.', ENTRY_FIELDS, isMemoryEntryEventPayload),
  memoryEventDefinition('memory.entry_superseded', 'A Memory Entry was superseded without deletion.', ENTRY_FIELDS, isMemoryEntryEventPayload),
  memoryEventDefinition('memory.entry_expired', 'A Memory Entry passed its validity window.', ENTRY_FIELDS, isMemoryEntryEventPayload),
  memoryEventDefinition('memory.entry_archived', 'A Memory Entry was archived.', ENTRY_FIELDS, isMemoryEntryEventPayload),
  memoryEventDefinition('memory.retrieval_completed', 'Scope-filtered Memory retrieval completed.', RETRIEVAL_FIELDS, isMemoryRetrievalEventPayload),
  memoryEventDefinition('memory.retrieval_failed', 'Scope-filtered Memory retrieval failed closed.', RETRIEVAL_FIELDS, isMemoryRetrievalEventPayload),
  memoryEventDefinition('memory.context_created', 'An immutable Memory Context Snapshot was persisted.', CONTEXT_FIELDS, isMemoryContextEventPayload),
  memoryEventDefinition('memory.injected', 'A persisted Memory Context Snapshot was injected into a Provider context.', CONTEXT_FIELDS, isMemoryContextEventPayload),
  memoryEventDefinition('memory.revalidation_completed', 'Memory revalidation completed.', RETRIEVAL_FIELDS, isMemoryRetrievalEventPayload),
]);
