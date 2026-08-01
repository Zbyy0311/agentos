import type {
  RuntimeEventDraft,
  RuntimeEventDurability,
  RuntimeEventEnvelope,
  RuntimeEventSeverity,
  RuntimeEventSource,
  RuntimeEventVisibility,
  UnknownFutureRuntimeEvent,
} from './m3-runtime.js';

export const CURRENT_RUNTIME_EVENT_SCHEMA_VERSION = 1;

export type RuntimeEventPayloadGuard<TPayload> = (payload: unknown) => payload is TPayload;

export interface RuntimeEventDefinition<TPayload = unknown> {
  readonly type: string;
  readonly schemaVersion: number;
  readonly source: RuntimeEventSource;
  readonly defaultSeverity: RuntimeEventSeverity;
  readonly defaultVisibility: RuntimeEventVisibility;
  readonly defaultDurability: RuntimeEventDurability;
  readonly validatePayload: RuntimeEventPayloadGuard<TPayload>;
}

export type RuntimeEventValidationResult<TPayload = unknown> =
  | {
      readonly kind: 'known';
      readonly event: RuntimeEventEnvelope<TPayload>;
    }
  | {
      readonly kind: 'unknown_future';
      readonly event: UnknownFutureRuntimeEvent;
    };

export type RuntimeEventRegistryErrorCode =
  | 'DUPLICATE_EVENT_TYPE'
  | 'INVALID_EVENT_DEFINITION'
  | 'UNREGISTERED_CORE_EVENT'
  | 'INVALID_EVENT_ENVELOPE'
  | 'INVALID_EVENT_SCHEMA_VERSION'
  | 'INVALID_EVENT_PAYLOAD'
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
    || !isPositiveSafeInteger(definition.schemaVersion)
    || typeof definition.validatePayload !== 'function'
    || !isNonEmptyString(definition.source)
    || !isNonEmptyString(definition.defaultSeverity)
    || !isNonEmptyString(definition.defaultVisibility)
    || !isNonEmptyString(definition.defaultDurability)
  ) {
    throw new RuntimeEventRegistryError(
      'INVALID_EVENT_DEFINITION',
      'Runtime Event definition is incomplete',
    );
  }

  if (
    !hasValue(['api', 'run_engine', 'stage_executor', 'recovery', 'legacy_bridge', 'system'], definition.source)
    || !hasValue(['debug', 'info', 'notice', 'warning', 'error', 'critical'], definition.defaultSeverity)
    || !hasValue(['public', 'internal', 'restricted'], definition.defaultVisibility)
    || !hasValue(['durable', 'ephemeral'], definition.defaultDurability)
  ) {
    throw new RuntimeEventRegistryError(
      'INVALID_EVENT_DEFINITION',
      'Runtime Event definition contains an unsupported default',
    );
  }
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

  validate<TPayload = unknown>(
    draft: RuntimeEventDraft<TPayload>,
  ): RuntimeEventValidationResult<TPayload> {
    this.validateEnvelopeShape(draft);

    if (draft.schemaVersion > CURRENT_RUNTIME_EVENT_SCHEMA_VERSION) {
      return {
        kind: 'unknown_future',
        event: {
          kind: 'unknown_future_event',
          id: draft.id,
          type: draft.type,
          schemaVersion: draft.schemaVersion,
          workspaceId: draft.workspaceId,
          runId: draft.runId,
          sequence: draft.sequence,
          correlationId: draft.correlationId,
          payload: draft.payload,
          warning: 'UNKNOWN_FUTURE_EVENT_SCHEMA',
        },
      };
    }

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

  assertPublishable<TPayload>(draft: RuntimeEventDraft<TPayload>): RuntimeEventEnvelope<TPayload> {
    const result = this.validate(draft);
    if (result.kind === 'unknown_future') {
      throw new RuntimeEventRegistryError(
        'UNKNOWN_FUTURE_EVENT_NOT_PUBLISHABLE',
        'Future Runtime Event cannot be published by the current Registry: ' + draft.type,
      );
    }
    return result.event;
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
      || !isNonEmptyString(draft.source ?? 'system')
      || !isPositiveSafeInteger(draft.sequence)
      || (draft.severity !== undefined && !isNonEmptyString(draft.severity))
      || (draft.visibility !== undefined && !isNonEmptyString(draft.visibility))
      || (draft.durability !== undefined && !isNonEmptyString(draft.durability))
    ) {
      throw new RuntimeEventRegistryError(
        'INVALID_EVENT_ENVELOPE',
        'Runtime Event envelope is incomplete',
      );
    }

    if (
      draft.source !== undefined
      && !hasValue(['api', 'run_engine', 'stage_executor', 'recovery', 'legacy_bridge', 'system'], draft.source)
    ) {
      throw new RuntimeEventRegistryError(
        'INVALID_EVENT_ENVELOPE',
        'Unsupported Runtime Event source: ' + draft.source,
      );
    }

    if (
      draft.severity !== undefined
      && !hasValue(['debug', 'info', 'notice', 'warning', 'error', 'critical'], draft.severity)
    ) {
      throw new RuntimeEventRegistryError(
        'INVALID_EVENT_ENVELOPE',
        'Unsupported Runtime Event severity: ' + draft.severity,
      );
    }

    if (
      draft.visibility !== undefined
      && !hasValue(['public', 'internal', 'restricted'], draft.visibility)
    ) {
      throw new RuntimeEventRegistryError(
        'INVALID_EVENT_ENVELOPE',
        'Unsupported Runtime Event visibility: ' + draft.visibility,
      );
    }

    if (
      draft.durability !== undefined
      && !hasValue(['durable', 'ephemeral'], draft.durability)
    ) {
      throw new RuntimeEventRegistryError(
        'INVALID_EVENT_ENVELOPE',
        'Unsupported Runtime Event durability: ' + draft.durability,
      );
    }
  }
}
