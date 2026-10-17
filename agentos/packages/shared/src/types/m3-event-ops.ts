/**
 * P5A Event Operations vocabulary (03-Event-Model §47/§58/§59/§61).
 *
 * Adds the two operational Event types — `event.corrected` (§61, correction
 * is a new append-only Event, never an UPDATE) and `event.compacted` (§59,
 * high-volume compaction replaces a Sequence range with one canonical
 * replacement Artifact plus one durable summary Event) — plus the §47 64KB
 * payload offload summary shape. Both Events are Run-scoped durable facts
 * with internal visibility; `event.corrected` must itself never be compacted
 * or retention-cleaned (auditability, §79 invariant 20/25).
 */
import type { RuntimeEventDefinition } from './m3-runtime-registry.js';

/** §47: recommended durable Event payload limit (bytes of canonical JSON). */
export const MAX_RUNTIME_EVENT_PAYLOAD_BYTES = 64 * 1024;

export const EVENT_PAYLOAD_OFFLOAD_DISCRIMINATOR = 'runtime-event-payload-offload' as const;

/**
 * Persisted in place of an oversized payload. The full canonical payload JSON
 * lives in a canonical raw Artifact; the Event keeps only this summary plus
 * the artifactId, exactly as 03-Event-Model §47 prescribes.
 */
export interface RuntimeEventPayloadOffloadSummary {
  readonly payloadKind: typeof EVENT_PAYLOAD_OFFLOAD_DISCRIMINATOR;
  readonly artifactId: string;
  readonly eventType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  /** Canonical JSON of the original payload, truncated for display. */
  readonly preview: string;
  /** Original payload top-level keys, so consumers know what was offloaded. */
  readonly storedKeys: readonly string[];
}

export function isRuntimeEventPayloadOffloadSummary(value: unknown): value is RuntimeEventPayloadOffloadSummary {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.payloadKind === EVENT_PAYLOAD_OFFLOAD_DISCRIMINATOR
    && typeof record.artifactId === 'string' && record.artifactId.trim().length > 0
    && typeof record.eventType === 'string' && record.eventType.trim().length > 0
    && typeof record.sizeBytes === 'number' && Number.isSafeInteger(record.sizeBytes) && record.sizeBytes > 0
    && typeof record.sha256 === 'string' && /^[0-9a-f]{64}$/.test(record.sha256)
    && typeof record.preview === 'string'
    && Array.isArray(record.storedKeys)
    && record.storedKeys.every(key => typeof key === 'string');
}

export interface EventCorrectedPayload {
  readonly targetEventId: string;
  readonly reason: string;
  readonly correctedFields: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isEventCorrectedPayload(value: unknown): value is EventCorrectedPayload {
  return isRecord(value)
    && typeof value.targetEventId === 'string' && value.targetEventId.trim().length > 0
    && typeof value.reason === 'string' && value.reason.trim().length > 0
    && isRecord(value.correctedFields);
}

export interface EventCompactedPayload {
  readonly fromSequence: number;
  readonly toSequence: number;
  readonly eventTypes: readonly string[];
  readonly replacementArtifactId: string;
  readonly originalCount: number;
}

export function isEventCompactedPayload(value: unknown): value is EventCompactedPayload {
  if (!isRecord(value)) return false;
  return typeof value.fromSequence === 'number'
    && Number.isSafeInteger(value.fromSequence) && value.fromSequence >= 1
    && typeof value.toSequence === 'number'
    && Number.isSafeInteger(value.toSequence) && value.toSequence >= value.fromSequence
    && Array.isArray(value.eventTypes)
    && value.eventTypes.length > 0
    && value.eventTypes.every(type => typeof type === 'string' && type.trim().length > 0)
    && typeof value.replacementArtifactId === 'string' && value.replacementArtifactId.trim().length > 0
    && typeof value.originalCount === 'number'
    && Number.isSafeInteger(value.originalCount) && value.originalCount >= 1;
}

/**
 * High-volume Event types eligible for §59 compaction. Terminal, approval,
 * policy, correction and compaction facts are intentionally absent.
 */
export const COMPACTABLE_RUNTIME_EVENT_TYPES = Object.freeze([
  'stream.text_delta',
  'command.stdout',
  'command.stderr',
  'process.heartbeat',
  'tool.progress',
] as const);

export type CompactableRuntimeEventType = (typeof COMPACTABLE_RUNTIME_EVENT_TYPES)[number];

/**
 * §58 categories retained forever. The cleanup trigger (migration 060) and
 * the server-side cleanup service share this list; cleanup code must refuse
 * to delete anything on it, and the trigger is the final DB-level backstop.
 */
export const PERMANENTLY_RETAINED_RUNTIME_EVENT_TYPES = Object.freeze([
  'run.cancelled',
  'run.completed',
  'run.failed',
  'stage.cancelled',
  'stage.completed',
  'stage.failed',
  'stage.skipped',
  'approval.required',
  'approval.resolved',
  'approval.expired',
  'approval.cancelled',
  'policy.denied',
  'git.merge_started',
  'git.merge_completed',
  'git.merge_conflicted',
  'worktree.merged',
  'artifact.created',
  'artifact.finalized',
  'memory.created',
  'event.corrected',
  'event.compacted',
] as const);

export function isPermanentlyRetainedRuntimeEventType(type: string): boolean {
  return (PERMANENTLY_RETAINED_RUNTIME_EVENT_TYPES as readonly string[]).includes(type);
}

/**
 * §61 projection rule: apply every `event.corrected` to its target in
 * sequence order (later corrections win) and return corrected copies. The
 * input Events are never mutated; Events without a correction pass through
 * unchanged, and unknown correction targets are ignored rather than thrown
 * so a corrupt correction can never break the whole read.
 */
export function applyEventCorrections<TEvent extends { readonly type: string; readonly payload: unknown }>(
  events: readonly TEvent[],
  corrections: readonly EventCorrectedPayload[],
): TEvent[] {
  if (corrections.length === 0) return [...events];
  const byTarget = new Map<string, EventCorrectedPayload[]>();
  for (const correction of corrections) {
    const list = byTarget.get(correction.targetEventId);
    if (list) list.push(correction);
    else byTarget.set(correction.targetEventId, [correction]);
  }
  return events.map(event => {
    const applied = byTarget.get((event as { readonly id?: unknown }).id as string);
    if (!applied || !isRecord(event.payload)) return event;
    let payload: Record<string, unknown> = { ...event.payload };
    for (const correction of applied) {
      payload = { ...payload, ...correction.correctedFields };
    }
    return { ...event, payload } as TEvent;
  });
}

export const EVENT_OPS_EVENT_DEFINITIONS: readonly RuntimeEventDefinition[] = [
  {
    type: 'event.corrected',
    domain: 'run',
    description: 'A correction to a previously appended Event; the original Event is retained unchanged (§61).',
    schemaVersion: 1,
    source: 'event-store',
    defaultSeverity: 'notice',
    defaultVisibility: 'internal',
    defaultDurability: 'durable',
    payloadSchema: {
      required: ['targetEventId', 'reason', 'correctedFields'],
      optional: [],
    },
    forbidsStageId: true,
    validatePayload: isEventCorrectedPayload,
  },
  {
    type: 'event.compacted',
    domain: 'run',
    description: 'A range of high-volume Events was compacted into one raw replacement Artifact (§59).',
    schemaVersion: 1,
    source: 'event-store',
    defaultSeverity: 'info',
    defaultVisibility: 'internal',
    defaultDurability: 'durable',
    payloadSchema: {
      required: ['fromSequence', 'toSequence', 'eventTypes', 'replacementArtifactId', 'originalCount'],
      optional: [],
    },
    forbidsStageId: true,
    validatePayload: isEventCompactedPayload,
  },
];
