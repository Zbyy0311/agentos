import type {
  RuntimeEventDraft,
  RuntimeEventDurability,
  RuntimeEventEnvelope,
  RuntimeEventSeverity,
  RuntimeEventSource,
  RuntimeEventVisibility,
  UnknownFutureRuntimeEvent,
} from './m3-runtime.js';
import {
  RUNTIME_EVENT_DURABILITIES,
  RUNTIME_EVENT_SEVERITIES,
  RUNTIME_EVENT_SOURCES,
  RUNTIME_EVENT_VISIBILITIES,
} from './m3-runtime.js';

export const CURRENT_RUNTIME_EVENT_SCHEMA_VERSION = 1;

export type RuntimeEventDomain = 'run' | 'stage';

export interface RuntimeEventPayloadSchema {
  readonly required: readonly string[];
  readonly optional: readonly string[];
}

export type RuntimeEventPayloadGuard<TPayload> = (payload: unknown) => payload is TPayload;

export interface RuntimeEventDefinition<TPayload = unknown> {
  readonly type: string;
  readonly domain: RuntimeEventDomain;
  readonly description: string;
  readonly schemaVersion: number;
  readonly defaultSeverity: RuntimeEventSeverity;
  readonly defaultVisibility: RuntimeEventVisibility;
  readonly defaultDurability: RuntimeEventDurability;
  readonly payloadSchema: RuntimeEventPayloadSchema;
  readonly validatePayload: RuntimeEventPayloadGuard<TPayload>;
  readonly requiresStageId?: boolean;
  readonly source: RuntimeEventSource;
}

export type RuntimeEventConsumptionResult<TPayload = unknown> =
  | {
      readonly kind: 'known';
      readonly event: RuntimeEventEnvelope<TPayload>;
    }
  | {
      readonly kind: 'unknown_future';
      readonly event: UnknownFutureRuntimeEvent;
    };

export type RuntimeEventValidationResult<TPayload = unknown> = RuntimeEventConsumptionResult<TPayload>;

export type RuntimeEventRegistryErrorCode =
  | 'DUPLICATE_EVENT_TYPE'
  | 'INVALID_EVENT_DEFINITION'
  | 'UNREGISTERED_CORE_EVENT'
  | 'INVALID_EVENT_ENVELOPE'
  | 'INVALID_PERSISTED_EVENT'
  | 'INVALID_EVENT_SCHEMA_VERSION'
  | 'INVALID_EVENT_PAYLOAD'
  | 'MISSING_STAGE_ID'
  | 'UNKNOWN_FUTURE_EVENT_NOT_PUBLISHABLE';

export class RuntimeEventRegistryError extends Error {
  constructor(
    readonly code: RuntimeEventRegistryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RuntimeEventRegistryError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function hasValue<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && values.includes(value as T);
}

function validateDefinition(definition: RuntimeEventDefinition): void {
  if (
    !isNonEmptyString(definition.type)
    || !isNonEmptyString(definition.domain)
    || !isNonEmptyString(definition.description)
    || !isPositiveSafeInteger(definition.schemaVersion)
    || !isNonEmptyString(definition.source)
    || !isNonEmptyString(definition.defaultSeverity)
    || !isNonEmptyString(definition.defaultVisibility)
    || !isNonEmptyString(definition.defaultDurability)
    || typeof definition.validatePayload !== 'function'
    || !Array.isArray(definition.payloadSchema.required)
    || !Array.isArray(definition.payloadSchema.optional)
  ) {
    throw new RuntimeEventRegistryError(
      'INVALID_EVENT_DEFINITION',
      'Runtime Event definition is incomplete',
    );
  }

  if (
    !hasValue(['run', 'stage'], definition.domain)
    || !hasValue(RUNTIME_EVENT_SOURCES, definition.source)
    || !hasValue(RUNTIME_EVENT_SEVERITIES, definition.defaultSeverity)
    || !hasValue(RUNTIME_EVENT_VISIBILITIES, definition.defaultVisibility)
    || !hasValue(RUNTIME_EVENT_DURABILITIES, definition.defaultDurability)
  ) {
    throw new RuntimeEventRegistryError(
      'INVALID_EVENT_DEFINITION',
      'Runtime Event definition contains an unsupported canonical value',
    );
  }
}

function keysAreKnown(value: Record<string, unknown>, schema: RuntimeEventPayloadSchema): boolean {
  const allowed = new Set([...schema.required, ...schema.optional]);
  return Object.keys(value).every(key => allowed.has(key));
}

export class CentralRuntimeEventRegistry {
  private readonly definitions = new Map<string, RuntimeEventDefinition>();

  registerCore<TPayload>(definition: RuntimeEventDefinition<TPayload>): void {
    validateDefinition(definition);
    if (this.definitions.has(definition.type)) {
      throw new RuntimeEventRegistryError(
        'DUPLICATE_EVENT_TYPE',
        'Runtime Event type is already registered: ' + definition.type,
      );
    }
    this.definitions.set(definition.type, definition);
  }

  has(type: string): boolean {
    return this.definitions.has(type);
  }

  get(type: string): RuntimeEventDefinition | undefined {
    return this.definitions.get(type);
  }

  publish<TPayload>(draft: RuntimeEventDraft<TPayload>): RuntimeEventEnvelope<TPayload> {
    if (draft.schemaVersion > CURRENT_RUNTIME_EVENT_SCHEMA_VERSION) {
      throw new RuntimeEventRegistryError(
        'UNKNOWN_FUTURE_EVENT_NOT_PUBLISHABLE',
        'Future Runtime Event cannot be published by the current Registry: ' + draft.type,
      );
    }

    const result = this.validateCurrentDraft(draft);
    if (result.kind === 'unknown_future') {
      throw new RuntimeEventRegistryError(
        'UNKNOWN_FUTURE_EVENT_NOT_PUBLISHABLE',
        'Future Runtime Event cannot be published by the current Registry: ' + draft.type,
      );
    }
    return result.event;
  }

  consume(record: unknown): RuntimeEventConsumptionResult {
    const draft = this.toDraft(record);
    if (draft.schemaVersion > CURRENT_RUNTIME_EVENT_SCHEMA_VERSION) {
      return {
        kind: 'unknown_future',
        event: this.toUnknownFutureEvent(record as Record<string, unknown>, draft),
      };
    }
    return this.validateCurrentDraft(draft);
  }

  private validateCurrentDraft<TPayload>(
    draft: RuntimeEventDraft<TPayload>,
  ): RuntimeEventValidationResult<TPayload> {
    this.validateEnvelopeShape(draft);

    const definition = this.definitions.get(draft.type);
    if (!definition) {
      throw new RuntimeEventRegistryError(
        'UNREGISTERED_CORE_EVENT',
        'Core Runtime Event type is not registered: ' + draft.type,
      );
    }

    if (draft.schemaVersion !== definition.schemaVersion) {
      throw new RuntimeEventRegistryError(
        'INVALID_EVENT_SCHEMA_VERSION',
        'Unsupported schemaVersion for ' + draft.type + ': ' + draft.schemaVersion,
      );
    }

    if (definition.requiresStageId && !isNonEmptyString(draft.stageId)) {
      throw new RuntimeEventRegistryError(
        'MISSING_STAGE_ID',
        'Stage Runtime Event requires an envelope stageId: ' + draft.type,
      );
    }

    if (!isRecord(draft.payload) || !keysAreKnown(draft.payload, definition.payloadSchema)) {
      throw new RuntimeEventRegistryError(
        'INVALID_EVENT_PAYLOAD',
        'Payload contains unknown fields for ' + draft.type,
      );
    }

    if (!definition.validatePayload(draft.payload)) {
      throw new RuntimeEventRegistryError(
        'INVALID_EVENT_PAYLOAD',
        'Payload validation failed for ' + draft.type,
      );
    }

    return {
      kind: 'known',
      event: {
        ...draft,
        source: draft.source ?? definition.source,
        severity: draft.severity ?? definition.defaultSeverity,
        visibility: draft.visibility ?? definition.defaultVisibility,
        durability: draft.durability ?? definition.defaultDurability,
      },
    };
  }

  private toDraft(record: unknown): RuntimeEventDraft {
    if (!isRecord(record)) {
      throw new RuntimeEventRegistryError(
        'INVALID_PERSISTED_EVENT',
        'Persisted Runtime Event must be an object',
      );
    }

    const draft = record as Partial<RuntimeEventDraft>;
    if (
      !isNonEmptyString(draft.id)
      || !isNonEmptyString(draft.type)
      || !isNonEmptyString(draft.workspaceId)
      || !isNonEmptyString(draft.runId)
      || !isNonEmptyString(draft.timestamp)
      || !isNonEmptyString(draft.correlationId)
      || !isNonEmptyString(draft.source)
      || !isNonEmptyString(draft.severity)
      || !isNonEmptyString(draft.visibility)
      || !isNonEmptyString(draft.durability)
      || !isPositiveSafeInteger(draft.schemaVersion)
      || !isPositiveSafeInteger(draft.sequence)
      || !('payload' in record)
    ) {
      throw new RuntimeEventRegistryError(
        'INVALID_PERSISTED_EVENT',
        'Persisted Runtime Event is missing canonical envelope fields',
      );
    }
    return draft as RuntimeEventDraft;
  }

  private toUnknownFutureEvent(
    record: Record<string, unknown>,
    draft: RuntimeEventDraft,
  ): UnknownFutureRuntimeEvent {
    return {
      ...record,
      raw: Object.freeze({ ...record }),
      kind: 'unknown_future_event',
      id: draft.id,
      type: draft.type,
      schemaVersion: draft.schemaVersion,
      workspaceId: draft.workspaceId,
      taskId: draft.taskId,
      runId: draft.runId,
      stageId: draft.stageId,
      agentId: draft.agentId,
      providerConfigId: draft.providerConfigId,
      providerSessionId: draft.providerSessionId,
      processId: draft.processId,
      worktreeId: draft.worktreeId,
      artifactId: draft.artifactId,
      approvalRequestId: draft.approvalRequestId,
      conversationId: draft.conversationId,
      messageId: draft.messageId,
      sequence: draft.sequence,
      timestamp: draft.timestamp,
      source: String(draft.source),
      correlationId: draft.correlationId,
      severity: String(draft.severity),
      visibility: String(draft.visibility),
      durability: String(draft.durability),
      payload: draft.payload,
      metadata: draft.metadata,
      warning: 'UNKNOWN_FUTURE_EVENT_SCHEMA',
    };
  }

  private validateEnvelopeShape(draft: RuntimeEventDraft): void {
    if (!isPositiveSafeInteger(draft.schemaVersion)) {
      throw new RuntimeEventRegistryError(
        'INVALID_EVENT_SCHEMA_VERSION',
        'Runtime Event schemaVersion must be a positive safe integer',
      );
    }

    if (
      !isNonEmptyString(draft.id)
      || !isNonEmptyString(draft.type)
      || !isNonEmptyString(draft.workspaceId)
      || !isNonEmptyString(draft.runId)
      || !isNonEmptyString(draft.correlationId)
      || !isNonEmptyString(draft.timestamp)
      || !isPositiveSafeInteger(draft.sequence)
    ) {
      throw new RuntimeEventRegistryError(
        'INVALID_EVENT_ENVELOPE',
        'Runtime Event envelope is incomplete',
      );
    }

    if (draft.source !== undefined && !hasValue(RUNTIME_EVENT_SOURCES, draft.source)) {
      throw new RuntimeEventRegistryError(
        'INVALID_EVENT_ENVELOPE',
        'Unsupported Runtime Event source: ' + draft.source,
      );
    }

    if (draft.severity !== undefined && !hasValue(RUNTIME_EVENT_SEVERITIES, draft.severity)) {
      throw new RuntimeEventRegistryError(
        'INVALID_EVENT_ENVELOPE',
        'Unsupported Runtime Event severity: ' + draft.severity,
      );
    }

    if (draft.visibility !== undefined && !hasValue(RUNTIME_EVENT_VISIBILITIES, draft.visibility)) {
      throw new RuntimeEventRegistryError(
        'INVALID_EVENT_ENVELOPE',
        'Unsupported Runtime Event visibility: ' + draft.visibility,
      );
    }

    if (draft.durability !== undefined && !hasValue(RUNTIME_EVENT_DURABILITIES, draft.durability)) {
      throw new RuntimeEventRegistryError(
        'INVALID_EVENT_ENVELOPE',
        'Unsupported Runtime Event durability: ' + draft.durability,
      );
    }
  }
}

export interface RunCreatedPayload {
  readonly reason: string;
  readonly parentRunId?: string;
  readonly rootRunId: string;
  readonly workflowDefinitionId?: string;
  readonly worktreeMode: string;
  readonly createdBy: string;
}

export interface RunStartedPayload {
  readonly startedAt: string;
  readonly workflowSnapshotVersion?: number;
  readonly policySnapshotVersion?: number;
  readonly baseCommit?: string;
}

export interface StageStartedPayload {
  readonly workflowStageKey: string;
  readonly name: string;
  readonly attempt: number;
  readonly agentSnapshot: Readonly<Record<string, unknown>>;
  readonly providerSnapshot: Readonly<Record<string, unknown>>;
}

function hasString(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === 'string' && String(value[key]).length > 0;
}

function hasOptionalString(value: Record<string, unknown>, key: string): boolean {
  return value[key] === undefined || hasString(value, key);
}

function hasOptionalNumber(value: Record<string, unknown>, key: string): boolean {
  return value[key] === undefined
    || (typeof value[key] === 'number' && Number.isSafeInteger(value[key]) && Number(value[key]) >= 1);
}

function hasOnly(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}

function isRunCreatedPayload(value: unknown): value is RunCreatedPayload {
  if (!isRecord(value)) return false;
  return (
    hasOnly(value, ['reason', 'parentRunId', 'rootRunId', 'workflowDefinitionId', 'worktreeMode', 'createdBy'])
    && hasString(value, 'reason')
    && hasOptionalString(value, 'parentRunId')
    && hasString(value, 'rootRunId')
    && hasOptionalString(value, 'workflowDefinitionId')
    && hasString(value, 'worktreeMode')
    && hasString(value, 'createdBy')
  );
}

function isRunStartedPayload(value: unknown): value is RunStartedPayload {
  if (!isRecord(value)) return false;
  return (
    hasOnly(value, ['startedAt', 'workflowSnapshotVersion', 'policySnapshotVersion', 'baseCommit'])
    && hasString(value, 'startedAt')
    && hasOptionalNumber(value, 'workflowSnapshotVersion')
    && hasOptionalNumber(value, 'policySnapshotVersion')
    && hasOptionalString(value, 'baseCommit')
  );
}

function isStageStartedPayload(value: unknown): value is StageStartedPayload {
  if (!isRecord(value)) return false;
  return (
    hasOnly(value, ['workflowStageKey', 'name', 'attempt', 'agentSnapshot', 'providerSnapshot'])
    && hasString(value, 'workflowStageKey')
    && hasString(value, 'name')
    && typeof value.attempt === 'number'
    && Number.isSafeInteger(value.attempt)
    && value.attempt >= 1
    && isRecord(value.agentSnapshot)
    && isRecord(value.providerSnapshot)
  );
}

export const M3_CORE_EVENT_DEFINITIONS: readonly RuntimeEventDefinition[] = [
  {
    type: 'run.created',
    domain: 'run',
    description: 'A Task-domain Run was created with its initial lineage and workflow references.',
    schemaVersion: 1,
    source: 'run-engine',
    defaultSeverity: 'info',
    defaultVisibility: 'public',
    defaultDurability: 'durable',
    payloadSchema: {
      required: ['reason', 'rootRunId', 'worktreeMode', 'createdBy'],
      optional: ['parentRunId', 'workflowDefinitionId'],
    },
    validatePayload: isRunCreatedPayload,
  },
  {
    type: 'run.started',
    domain: 'run',
    description: 'A Task-domain Run entered execution.',
    schemaVersion: 1,
    source: 'run-engine',
    defaultSeverity: 'info',
    defaultVisibility: 'public',
    defaultDurability: 'durable',
    payloadSchema: {
      required: ['startedAt'],
      optional: ['workflowSnapshotVersion', 'policySnapshotVersion', 'baseCommit'],
    },
    validatePayload: isRunStartedPayload,
  },
  {
    type: 'stage.started',
    domain: 'stage',
    description: 'A Task-domain Run Stage entered execution.',
    schemaVersion: 1,
    source: 'stage-executor',
    defaultSeverity: 'info',
    defaultVisibility: 'public',
    defaultDurability: 'durable',
    requiresStageId: true,
    payloadSchema: {
      required: ['workflowStageKey', 'name', 'attempt', 'agentSnapshot', 'providerSnapshot'],
      optional: [],
    },
    validatePayload: isStageStartedPayload,
  },
];

export function createM3RuntimeEventRegistry(): CentralRuntimeEventRegistry {
  const registry = new CentralRuntimeEventRegistry();
  for (const definition of M3_CORE_EVENT_DEFINITIONS) {
    registry.registerCore(definition);
  }
  return registry;
}
