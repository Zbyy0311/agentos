import type {
  RuntimeEventDraft,
  RuntimeEventDomain,
  RuntimeEventDurability,
  RuntimeEventEnvelope,
  RuntimeEventSeverity,
  RuntimeEventSource,
  RuntimeEventVisibility,
  UnknownRuntimeEvent,
} from './m3-runtime.js';
import type {
  AgentSnapshotV1,
  ProviderConfigurationSnapshotV1,
  ProviderTypeV1,
  V2TaskPriority,
} from './index.js';
import type { M3RunStatus } from './m3-run-status.js';
import type { V2RunReason, WorktreeMode } from './m3-runtime-contracts.js';
import {
  M3_RUN_STATUSES,
  RUNTIME_EVENT_DURABILITIES,
  RUNTIME_EVENT_DOMAINS,
  RUNTIME_EVENT_SEVERITIES,
  RUNTIME_EVENT_SOURCES,
  RUNTIME_EVENT_VISIBILITIES,
  isCanonicalRuntimeTimestamp,
} from './m3-runtime.js';
import { V2_RUN_REASONS, WORKTREE_MODES } from './m3-runtime-contracts.js';

export const CURRENT_RUNTIME_EVENT_SCHEMA_VERSION = 1;

const CANONICAL_PROVIDER_TYPES: readonly ProviderTypeV1[] = Object.freeze([
  'codex',
  'claude-code',
  'kimicode',
  'opencode',
  'gemini-cli',
  'custom-cli',
  'remote',
]);

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
  readonly forbidsStageId?: boolean;
  readonly requiresApprovalRequestId?: boolean;
  readonly source: RuntimeEventSource;
}

export type RuntimeEventConsumptionResult<TPayload = unknown> =
  | {
      readonly kind: 'known';
      readonly event: RuntimeEventEnvelope<TPayload>;
    }
  | {
      readonly kind: 'unknown';
      readonly event: UnknownRuntimeEvent;
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
  | 'UNEXPECTED_STAGE_ID'
  | 'MISSING_APPROVAL_REQUEST_ID'
  | 'INVALID_EVENT_TIMESTAMP'
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
    || (definition.requiresStageId !== undefined && typeof definition.requiresStageId !== 'boolean')
    || (definition.forbidsStageId !== undefined && typeof definition.forbidsStageId !== 'boolean')
    || (definition.requiresApprovalRequestId !== undefined
      && typeof definition.requiresApprovalRequestId !== 'boolean')
  ) {
    throw new RuntimeEventRegistryError(
      'INVALID_EVENT_DEFINITION',
      'Runtime Event definition is incomplete',
    );
  }

  if (
    !hasValue(RUNTIME_EVENT_DOMAINS, definition.domain)
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

function hasInvalidPayloadTimestamp(value: Record<string, unknown>): boolean {
  return ['dequeuedAt', 'startedAt', 'startingAt', 'expiresAt', 'decidedAt'].some(
    key => value[key] !== undefined && !isCanonicalRuntimeTimestamp(value[key]),
  );
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

    this.validateEnvelopeShape(draft);
    const definition = this.definitions.get(draft.type);
    if (!definition) {
      throw new RuntimeEventRegistryError(
        'UNREGISTERED_CORE_EVENT',
        'Core Runtime Event type is not registered: ' + draft.type,
      );
    }
    return this.validateKnownDraft(draft, definition as RuntimeEventDefinition<TPayload>);
  }

  consume(record: unknown): RuntimeEventConsumptionResult {
    const draft = this.toDraft(record);
    if (draft.schemaVersion > CURRENT_RUNTIME_EVENT_SCHEMA_VERSION) {
      return {
        kind: 'unknown',
        event: this.toUnknownRuntimeEvent(
          record as Record<string, unknown>,
          draft,
          'UNKNOWN_FUTURE_EVENT_SCHEMA',
        ),
      };
    }
    this.validateEnvelopeShape(draft);
    const definition = this.definitions.get(draft.type);
    if (!definition) {
      return {
        kind: 'unknown',
        event: this.toUnknownRuntimeEvent(record as Record<string, unknown>, draft, 'UNKNOWN_EVENT_TYPE'),
      };
    }
    return {
      kind: 'known',
      event: this.validateKnownDraft(draft, definition),
    };
  }

  private validateKnownDraft<TPayload>(
    draft: RuntimeEventDraft<TPayload>,
    definition: RuntimeEventDefinition<TPayload>,
  ): RuntimeEventEnvelope<TPayload> {
    if (draft.schemaVersion !== definition.schemaVersion) {
      throw new RuntimeEventRegistryError(
        'INVALID_EVENT_SCHEMA_VERSION',
        'Unsupported schemaVersion for ' + draft.type + ': ' + draft.schemaVersion,
      );
    }

    if (draft.stageId !== undefined && !isNonEmptyString(draft.stageId)) {
      throw new RuntimeEventRegistryError(
        'INVALID_EVENT_ENVELOPE',
        'Runtime Event stageId must be a non-empty string when present: ' + draft.type,
      );
    }

    if (draft.approvalRequestId !== undefined && !isNonEmptyString(draft.approvalRequestId)) {
      throw new RuntimeEventRegistryError(
        'INVALID_EVENT_ENVELOPE',
        'Runtime Event approvalRequestId must be a non-empty string when present: ' + draft.type,
      );
    }

    if (definition.requiresStageId && !isNonEmptyString(draft.stageId)) {
      throw new RuntimeEventRegistryError(
        'MISSING_STAGE_ID',
        'Stage Runtime Event requires an envelope stageId: ' + draft.type,
      );
    }

    if (
      (definition.forbidsStageId || definition.domain === 'run')
      && draft.stageId !== undefined
    ) {
      throw new RuntimeEventRegistryError(
        'UNEXPECTED_STAGE_ID',
        'Runtime Event does not allow an envelope stageId: ' + draft.type,
      );
    }

    if (definition.domain === 'stage' && !isNonEmptyString(draft.stageId)) {
      throw new RuntimeEventRegistryError(
        'MISSING_STAGE_ID',
        'Stage Runtime Event requires an envelope stageId: ' + draft.type,
      );
    }

    if (definition.requiresApprovalRequestId && !isNonEmptyString(draft.approvalRequestId)) {
      throw new RuntimeEventRegistryError(
        'MISSING_APPROVAL_REQUEST_ID',
        'Approval Runtime Event requires an envelope approvalRequestId: ' + draft.type,
      );
    }

    if (draft.source !== undefined && draft.source !== definition.source) {
      throw new RuntimeEventRegistryError(
        'INVALID_EVENT_ENVELOPE',
        'Runtime Event source does not match its definition: ' + draft.type,
      );
    }

    if (!isRecord(draft.payload) || !keysAreKnown(draft.payload, definition.payloadSchema)) {
      throw new RuntimeEventRegistryError(
        'INVALID_EVENT_PAYLOAD',
        'Payload contains unknown fields for ' + draft.type,
      );
    }

    if (hasInvalidPayloadTimestamp(draft.payload)) {
      throw new RuntimeEventRegistryError(
        'INVALID_EVENT_TIMESTAMP',
        'Runtime Event payload timestamp must use canonical UTC milliseconds: ' + draft.type,
      );
    }

    if (!definition.validatePayload(draft.payload)) {
      throw new RuntimeEventRegistryError(
        'INVALID_EVENT_PAYLOAD',
        'Payload validation failed for ' + draft.type,
      );
    }

    return {
      ...draft,
      source: draft.source ?? definition.source,
      severity: draft.severity ?? definition.defaultSeverity,
      visibility: draft.visibility ?? definition.defaultVisibility,
      durability: draft.durability ?? definition.defaultDurability,
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

  private toUnknownRuntimeEvent(
    record: Record<string, unknown>,
    draft: RuntimeEventDraft,
    warning: UnknownRuntimeEvent['warning'],
  ): UnknownRuntimeEvent {
    return {
      ...record,
      raw: Object.freeze({ ...record }),
      kind: 'unknown_runtime_event',
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
      causationId: draft.causationId,
      parentEventId: draft.parentEventId,
      severity: String(draft.severity),
      visibility: String(draft.visibility),
      durability: String(draft.durability),
      payload: draft.payload,
      metadata: draft.metadata,
      warning,
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

    if (!isCanonicalRuntimeTimestamp(draft.timestamp)) {
      throw new RuntimeEventRegistryError(
        'INVALID_EVENT_TIMESTAMP',
        'Runtime Event timestamp must use canonical UTC milliseconds: ' + draft.timestamp,
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
  readonly reason: V2RunReason;
  readonly parentRunId?: string;
  readonly rootRunId: string;
  readonly workflowDefinitionId?: string;
  readonly worktreeMode: WorktreeMode;
  readonly createdBy: string;
}

export interface RunQueuedPayload {
  readonly priority: V2TaskPriority;
  readonly queueName: string;
  readonly position?: number;
}

export interface RunDequeuedPayload {
  readonly dequeuedAt: string;
}

export interface RunStartedPayload {
  readonly startedAt: string;
  readonly workflowSnapshotVersion?: number;
  readonly policySnapshotVersion?: number;
  readonly baseCommit?: string;
}

export interface RunPausedPayload {
  readonly reason: 'user' | 'policy' | 'approval' | 'scheduler' | 'maintenance';
  readonly requestedBy?: string;
  readonly resumable: boolean;
}

export interface RunResumedPayload {
  readonly resumeMode: 'native-session' | 'process-restart' | 'scheduler';
  readonly requestedBy?: string;
}

export interface RunCancelledPayload {
  readonly requestedBy: string;
  readonly terminatedProcessIds: string[];
  readonly worktreePreserved: boolean;
  readonly reason?: string;
}

export interface RunCompletedPayload {
  readonly durationMs: number;
  readonly completedStageIds: string[];
  readonly artifactIds: string[];
  readonly worktreeStatus?: string;
  readonly summaryArtifactId?: string;
}

export interface RunFailedPayload {
  readonly errorCode: string;
  readonly message: string;
  readonly phase: string;
  readonly stageId?: string;
  readonly providerType?: ProviderTypeV1;
  readonly retryable: boolean;
  readonly suggestedAction?: string;
  readonly debugArtifactId?: string;
}

export interface RunRecoveryAttemptedPayload {
  readonly previousStatus: M3RunStatus;
  readonly processFound: boolean;
  readonly providerSessionFound: boolean;
  readonly worktreeFound: boolean;
}

export interface RunRecoveredPayload {
  readonly recoveryMode:
    | 'process-reattach'
    | 'provider-session-resume'
    | 'queue-restore'
    | 'approval-restore';
}

export interface RunRecoveryFailedPayload {
  readonly errorCode: string;
  readonly message: string;
  readonly retryableAsNewRun: boolean;
}

export interface StageCreatedPayload {
  readonly workflowStageKey: string;
  readonly name: string;
  readonly sequence: number;
  readonly dependsOn: string[];
}

export interface StageReadyPayload {
  readonly dependenciesCompleted: string[];
}

export interface StageStartingPayload {
  readonly workflowStageKey: string;
  readonly name: string;
  readonly attempt: number;
  readonly startingAt: string;
}

export interface StageStartedPayload {
  readonly workflowStageKey: string;
  readonly name: string;
  readonly attempt: number;
  readonly agentSnapshot: AgentSnapshotV1;
  readonly providerSnapshot: ProviderConfigurationSnapshotV1;
}

export interface StagePausedPayload {
  readonly reason: string;
  readonly resumable: boolean;
}

export interface StageResumedPayload {
  readonly resumeMode: string;
}

export interface StageCompletedPayload {
  readonly attempt: number;
  readonly durationMs: number;
  readonly artifactIds: string[];
  readonly summaryArtifactId?: string;
  readonly outputContractSatisfied: boolean;
}

export interface StageFailedPayload {
  readonly attempt: number;
  readonly errorCode: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly retryScheduled: boolean;
}

export interface StageCancelledPayload {
  readonly reason: string;
}

export interface StageSkippedPayload {
  readonly condition: string;
  readonly reason: string;
}

export type ApprovalCategory =
  | 'command'
  | 'file-delete'
  | 'git-push'
  | 'network'
  | 'package-install'
  | 'secret-access'
  | 'merge'
  | 'custom';

export type ApprovalRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type ApprovalResolutionDecision =
  | 'approve_once'
  | 'approve_run'
  | 'approve_workspace'
  | 'reject'
  | 'cancel_run';

export interface ApprovalRequiredPayload {
  readonly category: ApprovalCategory;
  readonly riskLevel: ApprovalRiskLevel;
  readonly title: string;
  readonly description: string;
  readonly requestSummary: Record<string, unknown>;
  readonly expiresAt?: string;
}

export interface ApprovalResolvedPayload {
  readonly decision: ApprovalResolutionDecision;
  readonly decidedBy: string;
  readonly decidedAt: string;
  readonly modifiedRequest?: Record<string, unknown>;
}

export type TextDeltaChannel = 'assistant' | 'analysis-summary' | 'status' | 'review' | 'system';

export interface TextDeltaPayload {
  readonly channel: TextDeltaChannel;
  readonly delta: string;
  readonly blockId?: string;
}

export interface TextCompletedPayload {
  readonly channel: string;
  readonly blockId?: string;
  readonly artifactId?: string;
  readonly characterCount: number;
}

function hasLifecycleString(value: Record<string, unknown>, key: string): boolean {
  return isNonEmptyString(value[key]);
}

function hasOptionalLifecycleString(value: Record<string, unknown>, key: string): boolean {
  return value[key] === undefined || hasLifecycleString(value, key);
}

function hasLifecycleCanonicalTimestamp(value: Record<string, unknown>, key: string): boolean {
  return isCanonicalRuntimeTimestamp(value[key]);
}

function hasOptionalLifecycleCanonicalTimestamp(value: Record<string, unknown>, key: string): boolean {
  return value[key] === undefined || isCanonicalRuntimeTimestamp(value[key]);
}

function hasOptionalNumber(value: Record<string, unknown>, key: string): boolean {
  return value[key] === undefined
    || (typeof value[key] === 'number' && Number.isSafeInteger(value[key]) && Number(value[key]) >= 1);
}

function hasOnly(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}

function hasSnapshotString(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === 'string' && value[key].length > 0;
}

function isSnapshotStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function isLifecycleStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => isNonEmptyString(item));
}

function isSnapshotNullableString(value: unknown): value is string | null {
  return value === null || isNonEmptyString(value);
}

function isLifecycleNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= 0
    && (!Number.isInteger(value) || Number.isSafeInteger(value));
}

function isSnapshotNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isSnapshotNonNegativeNumberOrNull(value: unknown): value is number | null {
  return value === null || isSnapshotNonNegativeNumber(value);
}

function hasOptionalRecord(value: Record<string, unknown>, key: string): boolean {
  return value[key] === undefined || isRecord(value[key]);
}

function hasBooleanFields(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every(key => typeof value[key] === 'boolean');
}

function isAgentSnapshotV1(value: unknown): value is AgentSnapshotV1 {
  if (!isRecord(value)) return false;
  return (
    hasSnapshotString(value, 'agentId')
    && hasSnapshotString(value, 'name')
    && hasValue(['codex', 'kimi', 'opencode', 'mimo'], value.role)
    && hasSnapshotString(value, 'roleTitle')
    && hasSnapshotString(value, 'systemPrompt')
    && Array.isArray(value.permissions)
    && value.permissions.every(permission => hasValue(['read', 'write', 'review'], permission))
    && hasSnapshotString(value, 'providerConfigId')
    && typeof value.enabled === 'boolean'
    && isPositiveSafeInteger(value.version)
  );
}

function isProviderConfigurationSnapshotV1(value: unknown): value is ProviderConfigurationSnapshotV1 {
  if (!isRecord(value) || !isRecord(value.capabilities) || !isRecord(value.timeoutPolicy)) return false;
  return (
    hasSnapshotString(value, 'providerConfigId')
    && hasSnapshotString(value, 'name')
    && hasValue(CANONICAL_PROVIDER_TYPES, value.providerType)
    && hasSnapshotString(value, 'adapterId')
    && hasValue(['cli', 'api', 'ssh', 'container'], value.runtimeMode)
    && isSnapshotNullableString(value.executable)
    && isSnapshotStringArray(value.argsTemplate)
    && isSnapshotNullableString(value.model)
    && isSnapshotNullableString(value.environmentProfileId)
    && isSnapshotNullableString(value.secretProfileId)
    && hasValue(['workspace', 'worktree', 'custom'], value.workingDirectoryMode)
    && isSnapshotNullableString(value.workspaceRelativeWorkingDirectory)
    && hasBooleanFields(value.capabilities, [
      'sessionResume',
      'structuredEvents',
      'nativeApprovals',
      'subagents',
      'toolEvents',
      'fileEvents',
      'usageEvents',
      'reasoningStream',
      'interactiveInput',
      'pause',
      'cancellation',
      'modelSelection',
      'workspaceAwareness',
      'nativeSandbox',
      'outputContracts',
    ])
    && isSnapshotNonNegativeNumber(value.timeoutPolicy.discoveryTimeoutMs)
    && isSnapshotNonNegativeNumber(value.timeoutPolicy.validationTimeoutMs)
    && isSnapshotNonNegativeNumber(value.timeoutPolicy.startupTimeoutMs)
    && isSnapshotNonNegativeNumberOrNull(value.timeoutPolicy.idleTimeoutMs)
    && isSnapshotNonNegativeNumberOrNull(value.timeoutPolicy.totalTimeoutMs)
    && isSnapshotNonNegativeNumber(value.timeoutPolicy.cancelGracePeriodMs)
    && isSnapshotNonNegativeNumberOrNull(value.timeoutPolicy.approvalTimeoutMs)
    && hasValue(['agentos', 'native', 'hybrid', 'disabled'], value.approvalMode)
    && hasValue(['structured', 'parsed-text', 'raw-stream'], value.outputMode)
    && typeof value.enabled === 'boolean'
    && isPositiveSafeInteger(value.version)
  );
}

export function isRunCreatedPayload(value: unknown): value is RunCreatedPayload {
  if (!isRecord(value)) return false;
  return (
    hasOnly(value, ['reason', 'parentRunId', 'rootRunId', 'workflowDefinitionId', 'worktreeMode', 'createdBy'])
    && hasValue(V2_RUN_REASONS, value.reason)
    && hasOptionalLifecycleString(value, 'parentRunId')
    && hasLifecycleString(value, 'rootRunId')
    && hasOptionalLifecycleString(value, 'workflowDefinitionId')
    && hasValue(WORKTREE_MODES, value.worktreeMode)
    && hasLifecycleString(value, 'createdBy')
  );
}

export function isRunQueuedPayload(value: unknown): value is RunQueuedPayload {
  if (!isRecord(value)) return false;
  return (
    hasOnly(value, ['priority', 'queueName', 'position'])
    && hasValue(['low', 'normal', 'high', 'critical'], value.priority)
    && hasLifecycleString(value, 'queueName')
    && (value.position === undefined
      || (typeof value.position === 'number' && Number.isSafeInteger(value.position) && value.position >= 0))
  );
}

export function isRunDequeuedPayload(value: unknown): value is RunDequeuedPayload {
  if (!isRecord(value)) return false;
  return hasOnly(value, ['dequeuedAt']) && hasLifecycleCanonicalTimestamp(value, 'dequeuedAt');
}

export function isRunStartedPayload(value: unknown): value is RunStartedPayload {
  if (!isRecord(value)) return false;
  return (
    hasOnly(value, ['startedAt', 'workflowSnapshotVersion', 'policySnapshotVersion', 'baseCommit'])
    && hasLifecycleCanonicalTimestamp(value, 'startedAt')
    && hasOptionalNumber(value, 'workflowSnapshotVersion')
    && hasOptionalNumber(value, 'policySnapshotVersion')
    && hasOptionalLifecycleString(value, 'baseCommit')
  );
}

export function isRunPausedPayload(value: unknown): value is RunPausedPayload {
  if (!isRecord(value)) return false;
  return (
    hasOnly(value, ['reason', 'requestedBy', 'resumable'])
    && hasValue(['user', 'policy', 'approval', 'scheduler', 'maintenance'], value.reason)
    && hasOptionalLifecycleString(value, 'requestedBy')
    && typeof value.resumable === 'boolean'
  );
}

export function isRunResumedPayload(value: unknown): value is RunResumedPayload {
  if (!isRecord(value)) return false;
  return (
    hasOnly(value, ['resumeMode', 'requestedBy'])
    && hasValue(['native-session', 'process-restart', 'scheduler'], value.resumeMode)
    && hasOptionalLifecycleString(value, 'requestedBy')
  );
}

export function isRunCancelledPayload(value: unknown): value is RunCancelledPayload {
  if (!isRecord(value)) return false;
  return (
    hasOnly(value, ['requestedBy', 'terminatedProcessIds', 'worktreePreserved', 'reason'])
    && hasLifecycleString(value, 'requestedBy')
    && isLifecycleStringArray(value.terminatedProcessIds)
    && typeof value.worktreePreserved === 'boolean'
    && hasOptionalLifecycleString(value, 'reason')
  );
}

export function isRunCompletedPayload(value: unknown): value is RunCompletedPayload {
  if (!isRecord(value)) return false;
  return (
    hasOnly(value, ['durationMs', 'completedStageIds', 'artifactIds', 'worktreeStatus', 'summaryArtifactId'])
    && isLifecycleNonNegativeNumber(value.durationMs)
    && isLifecycleStringArray(value.completedStageIds)
    && isLifecycleStringArray(value.artifactIds)
    && hasOptionalLifecycleString(value, 'worktreeStatus')
    && hasOptionalLifecycleString(value, 'summaryArtifactId')
  );
}

export function isRunFailedPayload(value: unknown): value is RunFailedPayload {
  if (!isRecord(value)) return false;
  return (
    hasOnly(value, [
      'errorCode',
      'message',
      'phase',
      'stageId',
      'providerType',
      'retryable',
      'suggestedAction',
      'debugArtifactId',
    ])
    && hasLifecycleString(value, 'errorCode')
    && hasLifecycleString(value, 'message')
    && hasLifecycleString(value, 'phase')
    && hasOptionalLifecycleString(value, 'stageId')
    && (value.providerType === undefined
      || hasValue(CANONICAL_PROVIDER_TYPES, value.providerType))
    && typeof value.retryable === 'boolean'
    && hasOptionalLifecycleString(value, 'suggestedAction')
    && hasOptionalLifecycleString(value, 'debugArtifactId')
  );
}

export function isRunRecoveryAttemptedPayload(value: unknown): value is RunRecoveryAttemptedPayload {
  if (!isRecord(value)) return false;
  return (
    hasOnly(value, ['previousStatus', 'processFound', 'providerSessionFound', 'worktreeFound'])
    && hasValue(M3_RUN_STATUSES, value.previousStatus)
    && typeof value.processFound === 'boolean'
    && typeof value.providerSessionFound === 'boolean'
    && typeof value.worktreeFound === 'boolean'
  );
}

export function isRunRecoveredPayload(value: unknown): value is RunRecoveredPayload {
  if (!isRecord(value)) return false;
  return (
    hasOnly(value, ['recoveryMode'])
    && hasValue(
      ['process-reattach', 'provider-session-resume', 'queue-restore', 'approval-restore'],
      value.recoveryMode,
    )
  );
}

export function isRunRecoveryFailedPayload(value: unknown): value is RunRecoveryFailedPayload {
  if (!isRecord(value)) return false;
  return (
    hasOnly(value, ['errorCode', 'message', 'retryableAsNewRun'])
    && hasLifecycleString(value, 'errorCode')
    && hasLifecycleString(value, 'message')
    && typeof value.retryableAsNewRun === 'boolean'
  );
}

export function isStageCreatedPayload(value: unknown): value is StageCreatedPayload {
  if (!isRecord(value)) return false;
  return (
    hasOnly(value, ['workflowStageKey', 'name', 'sequence', 'dependsOn'])
    && hasLifecycleString(value, 'workflowStageKey')
    && hasLifecycleString(value, 'name')
    && isPositiveSafeInteger(value.sequence)
    && isLifecycleStringArray(value.dependsOn)
  );
}

export function isStageReadyPayload(value: unknown): value is StageReadyPayload {
  if (!isRecord(value)) return false;
  return hasOnly(value, ['dependenciesCompleted']) && isLifecycleStringArray(value.dependenciesCompleted);
}

export function isStageStartingPayload(value: unknown): value is StageStartingPayload {
  if (!isRecord(value)) return false;
  return (
    hasOnly(value, ['workflowStageKey', 'name', 'attempt', 'startingAt'])
    && hasLifecycleString(value, 'workflowStageKey')
    && hasLifecycleString(value, 'name')
    && isPositiveSafeInteger(value.attempt)
    && hasLifecycleCanonicalTimestamp(value, 'startingAt')
  );
}

export function isStageStartedPayload(value: unknown): value is StageStartedPayload {
  if (!isRecord(value)) return false;
  return (
    hasOnly(value, ['workflowStageKey', 'name', 'attempt', 'agentSnapshot', 'providerSnapshot'])
    && hasLifecycleString(value, 'workflowStageKey')
    && hasLifecycleString(value, 'name')
    && typeof value.attempt === 'number'
    && Number.isSafeInteger(value.attempt)
    && value.attempt >= 1
    && isAgentSnapshotV1(value.agentSnapshot)
    && isProviderConfigurationSnapshotV1(value.providerSnapshot)
  );
}

export function isStagePausedPayload(value: unknown): value is StagePausedPayload {
  if (!isRecord(value)) return false;
  return hasOnly(value, ['reason', 'resumable']) && hasLifecycleString(value, 'reason') && typeof value.resumable === 'boolean';
}

export function isStageResumedPayload(value: unknown): value is StageResumedPayload {
  if (!isRecord(value)) return false;
  return hasOnly(value, ['resumeMode']) && hasLifecycleString(value, 'resumeMode');
}

export function isStageCompletedPayload(value: unknown): value is StageCompletedPayload {
  if (!isRecord(value)) return false;
  return (
    hasOnly(value, ['attempt', 'durationMs', 'artifactIds', 'summaryArtifactId', 'outputContractSatisfied'])
    && isPositiveSafeInteger(value.attempt)
    && isLifecycleNonNegativeNumber(value.durationMs)
    && isLifecycleStringArray(value.artifactIds)
    && hasOptionalLifecycleString(value, 'summaryArtifactId')
    && typeof value.outputContractSatisfied === 'boolean'
  );
}

export function isStageFailedPayload(value: unknown): value is StageFailedPayload {
  if (!isRecord(value)) return false;
  return (
    hasOnly(value, ['attempt', 'errorCode', 'message', 'retryable', 'retryScheduled'])
    && isPositiveSafeInteger(value.attempt)
    && hasLifecycleString(value, 'errorCode')
    && hasLifecycleString(value, 'message')
    && typeof value.retryable === 'boolean'
    && typeof value.retryScheduled === 'boolean'
  );
}

export function isStageCancelledPayload(value: unknown): value is StageCancelledPayload {
  if (!isRecord(value)) return false;
  return hasOnly(value, ['reason']) && hasLifecycleString(value, 'reason');
}

export function isStageSkippedPayload(value: unknown): value is StageSkippedPayload {
  if (!isRecord(value)) return false;
  return hasOnly(value, ['condition', 'reason'])
    && hasLifecycleString(value, 'condition')
    && hasLifecycleString(value, 'reason');
}

export function isApprovalRequiredPayload(value: unknown): value is ApprovalRequiredPayload {
  if (!isRecord(value)) return false;
  return (
    hasOnly(value, ['category', 'riskLevel', 'title', 'description', 'requestSummary', 'expiresAt'])
    && hasValue(['command', 'file-delete', 'git-push', 'network', 'package-install', 'secret-access', 'merge', 'custom'], value.category)
    && hasValue(['low', 'medium', 'high', 'critical'], value.riskLevel)
    && hasLifecycleString(value, 'title')
    && hasLifecycleString(value, 'description')
    && isRecord(value.requestSummary)
    && hasOptionalLifecycleCanonicalTimestamp(value, 'expiresAt')
  );
}

export function isApprovalResolvedPayload(value: unknown): value is ApprovalResolvedPayload {
  if (!isRecord(value)) return false;
  return (
    hasOnly(value, ['decision', 'decidedBy', 'decidedAt', 'modifiedRequest'])
    && hasValue(['approve_once', 'approve_run', 'approve_workspace', 'reject', 'cancel_run'], value.decision)
    && hasLifecycleString(value, 'decidedBy')
    && hasLifecycleCanonicalTimestamp(value, 'decidedAt')
    && hasOptionalRecord(value, 'modifiedRequest')
  );
}

export function isTextDeltaPayload(value: unknown): value is TextDeltaPayload {
  if (!isRecord(value)) return false;
  return (
    hasOnly(value, ['channel', 'delta', 'blockId'])
    && hasValue(['assistant', 'analysis-summary', 'status', 'review', 'system'], value.channel)
    && typeof value.delta === 'string'
    && hasOptionalLifecycleString(value, 'blockId')
  );
}

export function isTextCompletedPayload(value: unknown): value is TextCompletedPayload {
  if (!isRecord(value)) return false;
  return (
    hasOnly(value, ['channel', 'blockId', 'artifactId', 'characterCount'])
    && hasLifecycleString(value, 'channel')
    && hasOptionalLifecycleString(value, 'blockId')
    && hasOptionalLifecycleString(value, 'artifactId')
    && typeof value.characterCount === 'number'
    && Number.isSafeInteger(value.characterCount)
    && value.characterCount >= 0
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
    forbidsStageId: true,
    validatePayload: isRunCreatedPayload,
  },
  {
    type: 'run.queued',
    domain: 'run',
    description: 'Optional queue telemetry for a Run already established as queued.',
    schemaVersion: 1,
    source: 'run-engine',
    defaultSeverity: 'info',
    defaultVisibility: 'public',
    defaultDurability: 'durable',
    payloadSchema: {
      required: ['priority', 'queueName'],
      optional: ['position'],
    },
    forbidsStageId: true,
    validatePayload: isRunQueuedPayload,
  },
  {
    type: 'run.dequeued',
    domain: 'run',
    description: 'The scheduler acquired a queued Run and began startup preparation.',
    schemaVersion: 1,
    source: 'scheduler',
    defaultSeverity: 'info',
    defaultVisibility: 'internal',
    defaultDurability: 'durable',
    payloadSchema: {
      required: ['dequeuedAt'],
      optional: [],
    },
    forbidsStageId: true,
    validatePayload: isRunDequeuedPayload,
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
    forbidsStageId: true,
    validatePayload: isRunStartedPayload,
  },
  {
    type: 'run.paused',
    domain: 'run',
    description: 'A Task-domain Run entered the paused state.',
    schemaVersion: 1,
    source: 'run-engine',
    defaultSeverity: 'info',
    defaultVisibility: 'public',
    defaultDurability: 'durable',
    payloadSchema: {
      required: ['reason', 'resumable'],
      optional: ['requestedBy'],
    },
    forbidsStageId: true,
    validatePayload: isRunPausedPayload,
  },
  {
    type: 'run.resumed',
    domain: 'run',
    description: 'A paused Task-domain Run resumed execution.',
    schemaVersion: 1,
    source: 'run-engine',
    defaultSeverity: 'info',
    defaultVisibility: 'public',
    defaultDurability: 'durable',
    payloadSchema: {
      required: ['resumeMode'],
      optional: ['requestedBy'],
    },
    forbidsStageId: true,
    validatePayload: isRunResumedPayload,
  },
  {
    type: 'run.cancelled',
    domain: 'run',
    description: 'A Task-domain Run was cancelled after affected Stage closure.',
    schemaVersion: 1,
    source: 'run-engine',
    defaultSeverity: 'notice',
    defaultVisibility: 'public',
    defaultDurability: 'durable',
    payloadSchema: {
      required: ['requestedBy', 'terminatedProcessIds', 'worktreePreserved'],
      optional: ['reason'],
    },
    forbidsStageId: true,
    validatePayload: isRunCancelledPayload,
  },
  {
    type: 'run.completed',
    domain: 'run',
    description: 'A Task-domain Run satisfied its completion rule.',
    schemaVersion: 1,
    source: 'run-engine',
    defaultSeverity: 'info',
    defaultVisibility: 'public',
    defaultDurability: 'durable',
    payloadSchema: {
      required: ['durationMs', 'completedStageIds', 'artifactIds'],
      optional: ['worktreeStatus', 'summaryArtifactId'],
    },
    forbidsStageId: true,
    validatePayload: isRunCompletedPayload,
  },
  {
    type: 'run.failed',
    domain: 'run',
    description: 'A Task-domain Run entered a terminal failed state.',
    schemaVersion: 1,
    source: 'run-engine',
    defaultSeverity: 'error',
    defaultVisibility: 'public',
    defaultDurability: 'durable',
    payloadSchema: {
      required: ['errorCode', 'message', 'phase', 'retryable'],
      optional: ['stageId', 'providerType', 'suggestedAction', 'debugArtifactId'],
    },
    forbidsStageId: true,
    validatePayload: isRunFailedPayload,
  },
  {
    type: 'run.recovery_attempted',
    domain: 'run',
    description: 'Recovery inspection began for a Task-domain Run.',
    schemaVersion: 1,
    source: 'recovery-manager',
    defaultSeverity: 'info',
    defaultVisibility: 'internal',
    defaultDurability: 'durable',
    payloadSchema: {
      required: ['previousStatus', 'processFound', 'providerSessionFound', 'worktreeFound'],
      optional: [],
    },
    forbidsStageId: true,
    validatePayload: isRunRecoveryAttemptedPayload,
  },
  {
    type: 'run.recovered',
    domain: 'run',
    description: 'A Task-domain Run was recovered using a confirmed recovery mode.',
    schemaVersion: 1,
    source: 'recovery-manager',
    defaultSeverity: 'info',
    defaultVisibility: 'internal',
    defaultDurability: 'durable',
    payloadSchema: {
      required: ['recoveryMode'],
      optional: [],
    },
    forbidsStageId: true,
    validatePayload: isRunRecoveredPayload,
  },
  {
    type: 'run.recovery_failed',
    domain: 'run',
    description: 'Recovery of a Task-domain Run failed closed with a classified outcome.',
    schemaVersion: 1,
    source: 'recovery-manager',
    defaultSeverity: 'error',
    defaultVisibility: 'internal',
    defaultDurability: 'durable',
    payloadSchema: {
      required: ['errorCode', 'message', 'retryableAsNewRun'],
      optional: [],
    },
    forbidsStageId: true,
    validatePayload: isRunRecoveryFailedPayload,
  },
  {
    type: 'stage.created',
    domain: 'stage',
    description: 'A Run Stage was created in pending state.',
    schemaVersion: 1,
    source: 'stage-executor',
    defaultSeverity: 'info',
    defaultVisibility: 'public',
    defaultDurability: 'durable',
    requiresStageId: true,
    payloadSchema: {
      required: ['workflowStageKey', 'name', 'sequence', 'dependsOn'],
      optional: [],
    },
    validatePayload: isStageCreatedPayload,
  },
  {
    type: 'stage.ready',
    domain: 'stage',
    description: 'A Run Stage became ready after dependencies completed.',
    schemaVersion: 1,
    source: 'stage-executor',
    defaultSeverity: 'info',
    defaultVisibility: 'public',
    defaultDurability: 'durable',
    requiresStageId: true,
    payloadSchema: {
      required: ['dependenciesCompleted'],
      optional: [],
    },
    validatePayload: isStageReadyPayload,
  },
  {
    type: 'stage.starting',
    domain: 'stage',
    description: 'A Run Stage acquired scheduling rights and began startup preparation.',
    schemaVersion: 1,
    source: 'stage-executor',
    defaultSeverity: 'info',
    defaultVisibility: 'public',
    defaultDurability: 'durable',
    requiresStageId: true,
    payloadSchema: {
      required: ['workflowStageKey', 'name', 'attempt', 'startingAt'],
      optional: [],
    },
    validatePayload: isStageStartingPayload,
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
  {
    type: 'stage.paused',
    domain: 'stage',
    description: 'A Run Stage entered the paused state.',
    schemaVersion: 1,
    source: 'stage-executor',
    defaultSeverity: 'info',
    defaultVisibility: 'public',
    defaultDurability: 'durable',
    requiresStageId: true,
    payloadSchema: {
      required: ['reason', 'resumable'],
      optional: [],
    },
    validatePayload: isStagePausedPayload,
  },
  {
    type: 'stage.resumed',
    domain: 'stage',
    description: 'A paused Run Stage resumed execution.',
    schemaVersion: 1,
    source: 'stage-executor',
    defaultSeverity: 'info',
    defaultVisibility: 'public',
    defaultDurability: 'durable',
    requiresStageId: true,
    payloadSchema: {
      required: ['resumeMode'],
      optional: [],
    },
    validatePayload: isStageResumedPayload,
  },
  {
    type: 'stage.completed',
    domain: 'stage',
    description: 'A Run Stage satisfied its completion contract.',
    schemaVersion: 1,
    source: 'stage-executor',
    defaultSeverity: 'info',
    defaultVisibility: 'public',
    defaultDurability: 'durable',
    requiresStageId: true,
    payloadSchema: {
      required: ['attempt', 'durationMs', 'artifactIds', 'outputContractSatisfied'],
      optional: ['summaryArtifactId'],
    },
    validatePayload: isStageCompletedPayload,
  },
  {
    type: 'stage.failed',
    domain: 'stage',
    description: 'A Run Stage entered a terminal failed state.',
    schemaVersion: 1,
    source: 'stage-executor',
    defaultSeverity: 'error',
    defaultVisibility: 'public',
    defaultDurability: 'durable',
    requiresStageId: true,
    payloadSchema: {
      required: ['attempt', 'errorCode', 'message', 'retryable', 'retryScheduled'],
      optional: [],
    },
    validatePayload: isStageFailedPayload,
  },
  {
    type: 'stage.cancelled',
    domain: 'stage',
    description: 'A non-terminal Run Stage entered the terminal cancelled state.',
    schemaVersion: 1,
    source: 'stage-executor',
    defaultSeverity: 'notice',
    defaultVisibility: 'public',
    defaultDurability: 'durable',
    requiresStageId: true,
    payloadSchema: {
      required: ['reason'],
      optional: [],
    },
    validatePayload: isStageCancelledPayload,
  },
  {
    type: 'stage.skipped',
    domain: 'stage',
    description: 'A Run Stage was skipped by its workflow condition.',
    schemaVersion: 1,
    source: 'stage-executor',
    defaultSeverity: 'info',
    defaultVisibility: 'public',
    defaultDurability: 'durable',
    requiresStageId: true,
    payloadSchema: {
      required: ['condition', 'reason'],
      optional: [],
    },
    validatePayload: isStageSkippedPayload,
  },
  {
    type: 'approval.required',
    domain: 'approval',
    description: 'A policy decision requires a durable approval decision.',
    schemaVersion: 1,
    source: 'approval-service',
    defaultSeverity: 'notice',
    defaultVisibility: 'public',
    defaultDurability: 'durable',
    requiresApprovalRequestId: true,
    payloadSchema: {
      required: ['category', 'riskLevel', 'title', 'description', 'requestSummary'],
      optional: ['expiresAt'],
    },
    validatePayload: isApprovalRequiredPayload,
  },
  {
    type: 'approval.resolved',
    domain: 'approval',
    description: 'A pending approval received its durable decision.',
    schemaVersion: 1,
    source: 'approval-service',
    defaultSeverity: 'info',
    defaultVisibility: 'public',
    defaultDurability: 'durable',
    requiresApprovalRequestId: true,
    payloadSchema: {
      required: ['decision', 'decidedBy', 'decidedAt'],
      optional: ['modifiedRequest'],
    },
    validatePayload: isApprovalResolvedPayload,
  },
  {
    type: 'stream.text_delta',
    domain: 'stream',
    description: 'A stage executor emitted a text stream delta.',
    schemaVersion: 1,
    source: 'stage-executor',
    defaultSeverity: 'info',
    defaultVisibility: 'public',
    defaultDurability: 'durable',
    payloadSchema: {
      required: ['channel', 'delta'],
      optional: ['blockId'],
    },
    validatePayload: isTextDeltaPayload,
  },
  {
    type: 'stream.text_completed',
    domain: 'stream',
    description: 'A stage executor completed a text stream block.',
    schemaVersion: 1,
    source: 'stage-executor',
    defaultSeverity: 'info',
    defaultVisibility: 'public',
    defaultDurability: 'durable',
    payloadSchema: {
      required: ['channel', 'characterCount'],
      optional: ['blockId', 'artifactId'],
    },
    validatePayload: isTextCompletedPayload,
  },
];

export function createM3RuntimeEventRegistry(): CentralRuntimeEventRegistry {
  const registry = new CentralRuntimeEventRegistry();
  for (const definition of M3_CORE_EVENT_DEFINITIONS) {
    registry.registerCore(definition);
  }
  return registry;
}
