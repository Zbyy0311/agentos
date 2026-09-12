/**
 * MF-5 Workspace Event stream contracts.
 *
 * The Workspace stream is the frozen companion to the Run-scoped Runtime Event
 * stream: Workspace-scoped Memory facts that carry no Run binding are appended
 * to `workspace_events` under their own per-Workspace sequence. This module
 * owns the envelope shape and the frozen appendable-type allowlist only; it
 * performs no persistence and no emission.
 *
 * Authorization: PR #127,
 * `docs/implementation/milestones/MF5-workspace-event-schema-authorization.md`
 * section 7.
 */

import type {
  RuntimeEventDurability,
  RuntimeEventMetadata,
  RuntimeEventSeverity,
  RuntimeEventSource,
  RuntimeEventVisibility,
} from './m3-runtime.js';

/**
 * Workspace stream allowlist v1 (authorization section 7.3): exactly the
 * Memory fact types whose durable subject lives in the Workspace. Every entry
 * is already a registered definition with source `memory-engine`; this module
 * introduces no new Runtime Event type.
 */
export const WORKSPACE_EVENT_STREAM_TYPES = Object.freeze([
  // S2-027: only the proven source-specific Artifact completion origin.
  'memory.candidate_created',
  'memory.candidate_reviewed',
  'memory.conflict_opened',
  'memory.conflict_resolved',
  'memory.entry_created',
  'memory.entry_updated',
  'memory.entry_rejected',
  'memory.entry_superseded',
  'memory.entry_deduplicated',
] as const);

export type WorkspaceEventStreamType = (typeof WORKSPACE_EVENT_STREAM_TYPES)[number];

export function isWorkspaceEventStreamType(value: unknown): value is WorkspaceEventStreamType {
  return typeof value === 'string'
    && (WORKSPACE_EVENT_STREAM_TYPES as readonly string[]).includes(value);
}

/**
 * Envelope keys that would bind an Event to the Run stream. They are
 * structurally absent from the Workspace envelope, and a draft that carries
 * any of them at runtime is refused instead of silently dropped, so a
 * Run-bound reference can neither be represented nor persisted here (MF5W-A8).
 * `taskId` is included: it belongs to the Run family and the frozen envelope
 * carries no reference of that family.
 */
export const WORKSPACE_EVENT_FORBIDDEN_ENVELOPE_KEYS = Object.freeze([
  'runId',
  'taskId',
  'stageId',
  'agentId',
  'providerConfigId',
  'providerSessionId',
  'processId',
  'worktreeId',
  'artifactId',
  'approvalRequestId',
  'conversationId',
  'messageId',
] as const);

/**
 * A committed Workspace Event. It mirrors the Run envelope minus every
 * Run-bound reference; `causationId` is required because the Workspace writer
 * only accepts an origin it can prove against a durable row in the same
 * Workspace (authorization section 8.1).
 */
export interface WorkspaceEventEnvelope<TPayload = unknown> {
  readonly id: string;
  readonly schemaVersion: number;
  readonly type: string;
  readonly workspaceId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly source: RuntimeEventSource;
  readonly correlationId: string;
  readonly causationId: string;
  readonly parentEventId?: string;
  readonly severity: RuntimeEventSeverity;
  readonly visibility: RuntimeEventVisibility;
  readonly durability: RuntimeEventDurability;
  readonly payload: TPayload;
  readonly metadata?: RuntimeEventMetadata;
}

/** Pre-validation shape: canonical defaults are filled in by the Registry. */
export interface WorkspaceEventDraft<TPayload = unknown> {
  readonly id: string;
  readonly schemaVersion: number;
  readonly type: string;
  readonly workspaceId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly source?: RuntimeEventSource;
  readonly correlationId: string;
  readonly causationId: string;
  readonly parentEventId?: string;
  readonly severity?: RuntimeEventSeverity;
  readonly visibility?: RuntimeEventVisibility;
  readonly durability?: RuntimeEventDurability;
  readonly payload: TPayload;
  readonly metadata?: RuntimeEventMetadata;
}
