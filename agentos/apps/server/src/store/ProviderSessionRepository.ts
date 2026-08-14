import { canonicalizeJson } from '../snapshots/canonicalJson.js';
import type { RuntimeEventContext } from '@agentos/shared';
import { isCanonicalUtcTimestamp } from './CanonicalTimestamp.js';
import { createEntityId, isValidEntityId } from './Identity.js';
import { inTransaction, isTransactionActive, type TransactionDatabase } from './Transaction.js';
import type { DurableRuntimeFactWriter } from './RuntimeEventRepository.js';

/**
 * M4-P2B durable Provider Session repository (Migration 014
 * `provider_sessions`). The first durable row of a Stage attempt is always
 * `starting`; the five-column
 * (workspace_id, run_id, stage_id, stage_attempt, authority_role) UNIQUE key
 * guarantees exactly one primary Provider Session per Stage attempt.
 *
 * Every mutation is a single-statement expected-version CAS (plus the claim
 * epoch/owner fence where the claim is involved). Zero affected rows is
 * classified by a scoped follow-up read (not-found / workspace-mismatch /
 * state-mismatch / version-conflict / fence-conflict / already-requested /
 * terminal) and never retries implicitly. Terminal states are immutable
 * (DB trigger) and duplicate terminal observation returns the stored fact.
 */

export const PROVIDER_SESSION_STATUSES = [
  'starting',
  'active',
  'waiting',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const;

export type ProviderSessionStatus = (typeof PROVIDER_SESSION_STATUSES)[number];

export const TERMINAL_PROVIDER_SESSION_STATUSES = ['completed', 'failed', 'cancelled'] as const;
export type TerminalProviderSessionStatus = (typeof TERMINAL_PROVIDER_SESSION_STATUSES)[number];

export const PROVIDER_SESSION_ALLOWED_TRANSITIONS: Readonly<
  Record<ProviderSessionStatus, readonly ProviderSessionStatus[]>
> = {
  starting: ['active', 'waiting', 'paused', 'failed', 'cancelled'],
  active: ['waiting', 'paused', 'completed', 'failed', 'cancelled'],
  waiting: ['active', 'completed', 'failed', 'cancelled'],
  paused: ['active', 'completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

export function isProviderSessionTransitionAllowed(
  from: ProviderSessionStatus,
  to: ProviderSessionStatus,
): boolean {
  return from === to || PROVIDER_SESSION_ALLOWED_TRANSITIONS[from].includes(to);
}

export const PROVIDER_SESSION_RUNTIME_MODES = ['cli', 'api', 'ssh', 'container'] as const;
export type ProviderSessionRuntimeMode = (typeof PROVIDER_SESSION_RUNTIME_MODES)[number];

export const PROVIDER_SESSION_AUTHORITY_ROLE = 'primary-provider' as const;

/** Frozen P1 launch/env contract ceiling; canonical capabilities stay bounded. */
export const PROVIDER_SESSION_CAPABILITIES_JSON_MAX_BYTES = 64 * 1024;
/** Bounded safe failure detail (never raw output or secret material). */
export const PROVIDER_SESSION_ERROR_DETAIL_MAX_BYTES = 4096;

interface ProviderSessionRow {
  id: string;
  workspace_id: string;
  task_id: string;
  run_id: string;
  stage_id: string;
  stage_attempt: number;
  authority_role: string;
  agent_id: string;
  provider_config_id: string;
  provider_config_version: number;
  provider_type: string;
  adapter_id: string;
  adapter_version: string;
  config_schema_version: number;
  runtime_mode: string;
  native_session_id: string | null;
  status: string;
  claim_epoch: number;
  claim_owner_id: string | null;
  claim_lease_expires_at: string | null;
  adapter_start_requested_at: string | null;
  capabilities_json: string;
  error_code: string | null;
  error_detail_redacted: string | null;
  started_at: string | null;
  last_activity_at: string | null;
  completed_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface ProviderSession {
  readonly id: string;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly stageId: string;
  readonly stageAttempt: number;
  readonly authorityRole: typeof PROVIDER_SESSION_AUTHORITY_ROLE;
  readonly agentId: string;
  readonly providerConfigId: string;
  readonly providerConfigVersion: number;
  readonly providerType: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly configSchemaVersion: number;
  readonly runtimeMode: ProviderSessionRuntimeMode;
  readonly nativeSessionId: string | null;
  readonly status: ProviderSessionStatus;
  readonly claimEpoch: number;
  readonly claimOwnerId: string | null;
  readonly claimLeaseExpiresAt: string | null;
  readonly adapterStartRequestedAt: string | null;
  /** Canonical schema-validated JSON (code-point sorted, bounded). */
  readonly capabilitiesJson: string;
  readonly errorCode: string | null;
  readonly errorDetailRedacted: string | null;
  readonly startedAt: string | null;
  readonly lastActivityAt: string | null;
  readonly completedAt: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

export interface CreateProviderSessionInput {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly stageId: string;
  readonly stageAttempt: number;
  readonly authorityRole: typeof PROVIDER_SESSION_AUTHORITY_ROLE;
  readonly agentId: string;
  readonly providerConfigId: string;
  readonly providerConfigVersion: number;
  readonly providerType: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly configSchemaVersion: number;
  readonly runtimeMode: ProviderSessionRuntimeMode;
  readonly nativeSessionId?: string | null;
  readonly claimEpoch?: number;
  readonly claimOwnerId?: string | null;
  readonly claimLeaseExpiresAt?: string | null;
  /** Canonicalized and bounded at this repository layer before persistence. */
  readonly capabilities: unknown;
  readonly createdAt?: string;
  /** Accepted Operation/Run context for the session_claimed fact. */
  readonly eventContext?: RuntimeEventContext;
}

export type CreateProviderSessionResult =
  | { readonly kind: 'created'; readonly session: ProviderSession }
  | { readonly kind: 'joined'; readonly session: ProviderSession };

export type ProviderSessionMutationOutcome =
  | { readonly kind: 'applied'; readonly session: ProviderSession }
  | { readonly kind: 'already-requested'; readonly session: ProviderSession }
  | { readonly kind: 'terminal'; readonly session: ProviderSession }
  | { readonly kind: 'state-mismatch'; readonly session: ProviderSession }
  | { readonly kind: 'version-conflict'; readonly session: ProviderSession }
  | { readonly kind: 'fence-conflict'; readonly session: ProviderSession }
  | { readonly kind: 'workspace-mismatch' }
  | { readonly kind: 'not-found' };

export interface SessionClaimFence {
  readonly expectedClaimEpoch: number;
  /** Null matches an unclaimed Session; otherwise the exact service owner. */
  readonly expectedClaimOwner: string | null;
}

export interface CasSetAdapterStartRequestedInput extends SessionClaimFence {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly expectedVersion: number;
  readonly timestamp: string;
  readonly eventContext?: RuntimeEventContext;
}

export interface SessionStatusTransitionInput extends SessionClaimFence {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly expectedVersion: number;
  readonly expectedFrom: ProviderSessionStatus;
  readonly to: ProviderSessionStatus;
  readonly timestamp: string;
  readonly failureCode?: string;
  readonly failureDetailRedacted?: string;
  readonly eventContext?: RuntimeEventContext;
}

export interface SessionClaimTransferInput extends SessionClaimFence {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly expectedVersion: number;
  readonly timestamp: string;
  readonly newClaimOwner: string;
  readonly newClaimLeaseExpiresAt: string;
  readonly eventContext?: RuntimeEventContext;
}

function integrityFailure(reason: string): ProviderSessionIntegrityError {
  return new ProviderSessionIntegrityError(
    `PROVIDER_SESSION_INTEGRITY_FAILED: ${reason}`,
  );
}

function assertNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw integrityFailure(`${field} is invalid`);
  }
  return value;
}

function assertPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw integrityFailure(`${field} is invalid`);
  }
  return value;
}

function assertOptionalString(value: unknown, field: string): void {
  if (value !== null && typeof value !== 'string') {
    throw integrityFailure(`${field} is invalid`);
  }
}

function assertOptionalTimestamp(value: unknown, field: string): void {
  if (value !== null && !isCanonicalUtcTimestamp(value)) {
    throw integrityFailure(`${field} is invalid`);
  }
}

function validateSessionRow(row: unknown): asserts row is ProviderSessionRow {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) {
    throw integrityFailure('row is invalid');
  }
  const value = row as Record<string, unknown>;
  assertNonEmptyString(value.id, 'id');
  if (!isValidEntityId(value.id as string, 'providerSession')) {
    throw integrityFailure('id is not a canonical psess_ identity');
  }
  assertNonEmptyString(value.workspace_id, 'workspace_id');
  assertNonEmptyString(value.task_id, 'task_id');
  assertNonEmptyString(value.run_id, 'run_id');
  assertNonEmptyString(value.stage_id, 'stage_id');
  assertPositiveInteger(value.stage_attempt, 'stage_attempt');
  if (value.authority_role !== PROVIDER_SESSION_AUTHORITY_ROLE) {
    throw integrityFailure('authority_role is invalid');
  }
  assertNonEmptyString(value.agent_id, 'agent_id');
  assertNonEmptyString(value.provider_config_id, 'provider_config_id');
  assertPositiveInteger(value.provider_config_version, 'provider_config_version');
  assertNonEmptyString(value.provider_type, 'provider_type');
  assertNonEmptyString(value.adapter_id, 'adapter_id');
  assertNonEmptyString(value.adapter_version, 'adapter_version');
  assertPositiveInteger(value.config_schema_version, 'config_schema_version');
  if (!PROVIDER_SESSION_RUNTIME_MODES.includes(value.runtime_mode as ProviderSessionRuntimeMode)) {
    throw integrityFailure('runtime_mode is invalid');
  }
  assertOptionalString(value.native_session_id, 'native_session_id');
  if (!PROVIDER_SESSION_STATUSES.includes(value.status as ProviderSessionStatus)) {
    throw integrityFailure('status is invalid');
  }
  assertPositiveInteger(value.claim_epoch, 'claim_epoch');
  assertOptionalString(value.claim_owner_id, 'claim_owner_id');
  assertOptionalTimestamp(value.claim_lease_expires_at, 'claim_lease_expires_at');
  assertOptionalTimestamp(value.adapter_start_requested_at, 'adapter_start_requested_at');
  assertNonEmptyString(value.capabilities_json, 'capabilities_json');
  assertOptionalString(value.error_code, 'error_code');
  assertOptionalString(value.error_detail_redacted, 'error_detail_redacted');
  assertOptionalTimestamp(value.started_at, 'started_at');
  assertOptionalTimestamp(value.last_activity_at, 'last_activity_at');
  assertOptionalTimestamp(value.completed_at, 'completed_at');
  assertPositiveInteger(value.version, 'version');
  if (!isCanonicalUtcTimestamp(value.created_at)) throw integrityFailure('created_at is invalid');
  if (!isCanonicalUtcTimestamp(value.updated_at)) throw integrityFailure('updated_at is invalid');
  assertOptionalTimestamp(value.archived_at, 'archived_at');
  if ((value.claim_owner_id === null) !== (value.claim_lease_expires_at === null)) {
    throw integrityFailure('claim pair is inconsistent');
  }
  if (value.status === 'active' && value.started_at === null) {
    throw integrityFailure('active session requires started_at');
  }
  if (
    TERMINAL_PROVIDER_SESSION_STATUSES.includes(value.status as TerminalProviderSessionStatus)
    && value.completed_at === null
  ) {
    throw integrityFailure('terminal session requires completed_at');
  }
}

function mapSession(row: ProviderSessionRow): ProviderSession {
  validateSessionRow(row);
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    taskId: row.task_id,
    runId: row.run_id,
    stageId: row.stage_id,
    stageAttempt: row.stage_attempt,
    authorityRole: row.authority_role as typeof PROVIDER_SESSION_AUTHORITY_ROLE,
    agentId: row.agent_id,
    providerConfigId: row.provider_config_id,
    providerConfigVersion: row.provider_config_version,
    providerType: row.provider_type,
    adapterId: row.adapter_id,
    adapterVersion: row.adapter_version,
    configSchemaVersion: row.config_schema_version,
    runtimeMode: row.runtime_mode as ProviderSessionRuntimeMode,
    nativeSessionId: row.native_session_id,
    status: row.status as ProviderSessionStatus,
    claimEpoch: row.claim_epoch,
    claimOwnerId: row.claim_owner_id,
    claimLeaseExpiresAt: row.claim_lease_expires_at,
    adapterStartRequestedAt: row.adapter_start_requested_at,
    capabilitiesJson: row.capabilities_json,
    errorCode: row.error_code,
    errorDetailRedacted: row.error_detail_redacted,
    startedAt: row.started_at,
    lastActivityAt: row.last_activity_at,
    completedAt: row.completed_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

export class ProviderSessionValidationError extends Error {
  readonly code = 'PROVIDER_SESSION_VALIDATION_FAILED' as const;

  constructor(message = 'PROVIDER_SESSION_VALIDATION_FAILED') {
    super(message);
    this.name = 'ProviderSessionValidationError';
  }
}

export class ProviderSessionIntegrityError extends Error {
  readonly code = 'PROVIDER_SESSION_INTEGRITY_FAILED' as const;

  constructor(message = 'PROVIDER_SESSION_INTEGRITY_FAILED') {
    super(message);
    this.name = 'ProviderSessionIntegrityError';
  }
}

function assertCanonicalTimestamp(value: string, field: string): void {
  if (!isCanonicalUtcTimestamp(value)) {
    throw new ProviderSessionValidationError(
      `PROVIDER_SESSION_VALIDATION_FAILED: ${field} must be canonical UTC ISO 8601 milliseconds`,
    );
  }
}

function canonicalBoundedJson(value: unknown, field: string, maxBytes: number): string {
  let canonical: string;
  try {
    canonical = canonicalizeJson(value);
  } catch (error) {
    throw new ProviderSessionValidationError(
      `PROVIDER_SESSION_VALIDATION_FAILED: ${field} must be canonical JSON (${error instanceof Error ? error.message : 'invalid'})`,
    );
  }
  const byteLength = new TextEncoder().encode(canonical).length;
  if (byteLength > maxBytes) {
    throw new ProviderSessionValidationError(
      `PROVIDER_SESSION_VALIDATION_FAILED: ${field} exceeds ${maxBytes} canonical bytes`,
    );
  }
  return canonical;
}

function assertSafeDetail(value: string | null | undefined, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ProviderSessionValidationError(
      `PROVIDER_SESSION_VALIDATION_FAILED: ${field} must be a non-empty string`,
    );
  }
  const byteLength = new TextEncoder().encode(value).length;
  if (byteLength > PROVIDER_SESSION_ERROR_DETAIL_MAX_BYTES) {
    throw new ProviderSessionValidationError(
      `PROVIDER_SESSION_VALIDATION_FAILED: ${field} exceeds ${PROVIDER_SESSION_ERROR_DETAIL_MAX_BYTES} bytes`,
    );
  }
  return value;
}

function assertSafeCode(value: string | null | undefined, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 128) {
    throw new ProviderSessionValidationError(
      `PROVIDER_SESSION_VALIDATION_FAILED: ${field} must be a bounded stable code`,
    );
  }
  return value;
}

function assertFence(fence: SessionClaimFence): void {
  if (!Number.isSafeInteger(fence.expectedClaimEpoch) || fence.expectedClaimEpoch < 1) {
    throw new ProviderSessionValidationError(
      'PROVIDER_SESSION_VALIDATION_FAILED: expectedClaimEpoch must be a positive safe integer',
    );
  }
  if (fence.expectedClaimOwner !== null && typeof fence.expectedClaimOwner !== 'string') {
    throw new ProviderSessionValidationError(
      'PROVIDER_SESSION_VALIDATION_FAILED: expectedClaimOwner must be a string or null',
    );
  }
}

function assertExpectedVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new ProviderSessionValidationError(
      'PROVIDER_SESSION_VALIDATION_FAILED: expectedVersion must be a positive safe integer',
    );
  }
}

export class ProviderSessionRepository {
  constructor(
    private readonly db: TransactionDatabase,
    private readonly factWriter?: DurableRuntimeFactWriter,
  ) {}

  /**
   * Create the first durable Session row with status `starting`. A duplicate
   * five-column Stage-attempt claim joins the existing Session (exactly-one
   * winner; the loser never re-claims and never triggers a second spawn).
   */
  createSession(input: CreateProviderSessionInput): CreateProviderSessionResult {
    const workspaceId = assertNonEmptyString(input.workspaceId, 'workspaceId');
    const taskId = assertNonEmptyString(input.taskId, 'taskId');
    const runId = assertNonEmptyString(input.runId, 'runId');
    const stageId = assertNonEmptyString(input.stageId, 'stageId');
    const stageAttempt = assertPositiveInteger(input.stageAttempt, 'stageAttempt');
    const agentId = assertNonEmptyString(input.agentId, 'agentId');
    const providerConfigId = assertNonEmptyString(input.providerConfigId, 'providerConfigId');
    const providerConfigVersion = assertPositiveInteger(
      input.providerConfigVersion,
      'providerConfigVersion',
    );
    if (input.authorityRole !== PROVIDER_SESSION_AUTHORITY_ROLE) {
      throw new ProviderSessionValidationError(
        'PROVIDER_SESSION_VALIDATION_FAILED: authorityRole must be primary-provider',
      );
    }
    const providerType = assertNonEmptyString(input.providerType, 'providerType');
    if (providerType.trim().toLowerCase() === 'kimi') {
      throw new ProviderSessionValidationError(
        'PROVIDER_SESSION_VALIDATION_FAILED: providerType must use the canonical vocabulary (kimi is forbidden)',
      );
    }
    const adapterId = assertNonEmptyString(input.adapterId, 'adapterId');
    const adapterVersion = assertNonEmptyString(input.adapterVersion, 'adapterVersion');
    const configSchemaVersion = assertPositiveInteger(
      input.configSchemaVersion,
      'configSchemaVersion',
    );
    if (!PROVIDER_SESSION_RUNTIME_MODES.includes(input.runtimeMode)) {
      throw new ProviderSessionValidationError(
        'PROVIDER_SESSION_VALIDATION_FAILED: runtimeMode must be one of cli/api/ssh/container',
      );
    }
    const nativeSessionId = input.nativeSessionId === undefined ? null : input.nativeSessionId;
    if (nativeSessionId !== null && typeof nativeSessionId !== 'string') {
      throw new ProviderSessionValidationError(
        'PROVIDER_SESSION_VALIDATION_FAILED: nativeSessionId must be a string or null',
      );
    }
    const claimEpoch = input.claimEpoch === undefined ? 1 : input.claimEpoch;
    if (!Number.isSafeInteger(claimEpoch) || claimEpoch < 1) {
      throw new ProviderSessionValidationError(
        'PROVIDER_SESSION_VALIDATION_FAILED: claimEpoch must be a positive safe integer',
      );
    }
    const claimOwnerId = input.claimOwnerId === undefined ? null : input.claimOwnerId;
    const claimLeaseExpiresAt =
      input.claimLeaseExpiresAt === undefined ? null : input.claimLeaseExpiresAt;
    if ((claimOwnerId === null) !== (claimLeaseExpiresAt === null)) {
      throw new ProviderSessionValidationError(
        'PROVIDER_SESSION_VALIDATION_FAILED: claimOwnerId and claimLeaseExpiresAt must be set together',
      );
    }
    if (claimLeaseExpiresAt !== null) {
      assertCanonicalTimestamp(claimLeaseExpiresAt, 'claimLeaseExpiresAt');
    }
    const capabilitiesJson = canonicalBoundedJson(
      input.capabilities,
      'capabilities',
      PROVIDER_SESSION_CAPABILITIES_JSON_MAX_BYTES,
    );
    const createdAt = input.createdAt ?? new Date().toISOString();
    assertCanonicalTimestamp(createdAt, 'createdAt');

    const insert = () => {
      const existing = this.findByClaimKey(
        workspaceId,
        runId,
        stageId,
        stageAttempt,
        PROVIDER_SESSION_AUTHORITY_ROLE,
      );
      if (existing !== undefined) return { kind: 'joined' as const, session: existing };

      const id = createEntityId('providerSession');
      const run = this.db.prepare(`
        INSERT INTO provider_sessions (
          id, workspace_id, task_id, run_id, stage_id, stage_attempt,
          authority_role, agent_id, provider_config_id, provider_config_version,
          provider_type, adapter_id, adapter_version, config_schema_version,
          runtime_mode, native_session_id, status, claim_epoch, claim_owner_id,
          claim_lease_expires_at, adapter_start_requested_at, capabilities_json,
          error_code, error_detail_redacted, started_at, last_activity_at,
          completed_at, version, created_at, updated_at, archived_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'starting', ?, ?, ?, NULL, ?, NULL, NULL, NULL, NULL, NULL, 1, ?, ?, NULL)
      `).run(
        id,
        workspaceId,
        taskId,
        runId,
        stageId,
        stageAttempt,
        PROVIDER_SESSION_AUTHORITY_ROLE,
        agentId,
        providerConfigId,
        providerConfigVersion,
        providerType,
        adapterId,
        adapterVersion,
        configSchemaVersion,
        input.runtimeMode,
        nativeSessionId,
        claimEpoch,
        claimOwnerId,
        claimLeaseExpiresAt,
        capabilitiesJson,
        createdAt,
        createdAt,
      ) as { changes: number };

      if (run.changes !== 1) {
        // A concurrent winner committed the same five-column claim first.
        const joined = this.findByClaimKey(
          workspaceId,
          runId,
          stageId,
          stageAttempt,
          PROVIDER_SESSION_AUTHORITY_ROLE,
        );
        if (joined !== undefined) return { kind: 'joined' as const, session: joined };
        throw new ProviderSessionValidationError(
          'PROVIDER_SESSION_VALIDATION_FAILED: session claim insert failed',
        );
      }

      const session = this.findById(workspaceId, id);
      if (session === undefined) {
        throw new ProviderSessionValidationError(
          'PROVIDER_SESSION_VALIDATION_FAILED: inserted session not found',
        );
      }
      if (this.factWriter !== undefined) {
        if (input.eventContext === undefined) {
          throw new ProviderSessionValidationError(
            'PROVIDER_SESSION_VALIDATION_FAILED: eventContext is required for durable session facts',
          );
        }
        this.factWriter.appendWithinTransaction({
        type: 'process.session_claimed',
        workspaceId: session.workspaceId,
        taskId: session.taskId,
        runId: session.runId,
        stageId: session.stageId,
        providerSessionId: session.id,
        timestamp: session.createdAt,
        eventContext: input.eventContext,
        payload: {
          stageAttempt: session.stageAttempt,
          authorityRole: session.authorityRole,
          claimEpoch: session.claimEpoch,
          runtimeMode: session.runtimeMode,
        },
        });
      }
      return { kind: 'created' as const, session };
    };
    // Match ProcessRepository: BEGIN IMMEDIATE serializes the claim read +
    // insert, while an existing repository transaction reuses its lock and
    // never attempts a nested BEGIN.
    return isTransactionActive(this.db) ? insert() : inTransaction(this.db, insert);
  }

  findById(workspaceId: string, sessionId: string): ProviderSession | undefined {
    const row = this.db.prepare(`
      SELECT * FROM provider_sessions WHERE workspace_id = ? AND id = ?
    `).get(workspaceId, sessionId) as ProviderSessionRow | undefined;
    return row === undefined ? undefined : mapSession(row);
  }

  findByClaimKey(
    workspaceId: string,
    runId: string,
    stageId: string,
    stageAttempt: number,
    authorityRole: typeof PROVIDER_SESSION_AUTHORITY_ROLE,
  ): ProviderSession | undefined {
    const row = this.db.prepare(`
      SELECT * FROM provider_sessions
      WHERE workspace_id = ? AND run_id = ? AND stage_id = ? AND stage_attempt = ?
        AND authority_role = ?
    `).get(workspaceId, runId, stageId, stageAttempt, authorityRole) as
      ProviderSessionRow | undefined;
    return row === undefined ? undefined : mapSession(row);
  }

  /**
   * CAS-set `adapter_start_requested_at` exactly once before any Adapter
   * start. A duplicate observation returns the stored fact
   * (already-requested) and never re-marks the marker.
   */
  casSetAdapterStartRequested(input: CasSetAdapterStartRequestedInput): ProviderSessionMutationOutcome {
    if (this.factWriter && !isTransactionActive(this.db)) {
      return inTransaction(this.db, () => this.casSetAdapterStartRequested(input));
    }
    assertNonEmptyString(input.workspaceId, 'workspaceId');
    assertNonEmptyString(input.sessionId, 'sessionId');
    assertExpectedVersion(input.expectedVersion);
    assertFence(input);
    assertCanonicalTimestamp(input.timestamp, 'timestamp');

    const result = this.db.prepare(`
      UPDATE provider_sessions
      SET adapter_start_requested_at = ?, updated_at = ?, version = version + 1
      WHERE workspace_id = ? AND id = ?
        AND status = 'starting'
        AND adapter_start_requested_at IS NULL
        AND version = ?
        AND claim_epoch = ?
        AND claim_owner_id IS ?
    `).run(
      input.timestamp,
      input.timestamp,
      input.workspaceId,
      input.sessionId,
      input.expectedVersion,
      input.expectedClaimEpoch,
      input.expectedClaimOwner,
    ) as { changes: number };

    if (result.changes === 1) {
      const session = this.findById(input.workspaceId, input.sessionId)!;
      if (this.factWriter !== undefined) {
        if (input.eventContext === undefined) {
          throw new ProviderSessionValidationError(
            'PROVIDER_SESSION_VALIDATION_FAILED: eventContext is required for durable session facts',
          );
        }
        this.factWriter.appendWithinTransaction({
        type: 'process.session_state_changed',
        workspaceId: session.workspaceId,
        taskId: session.taskId,
        runId: session.runId,
        stageId: session.stageId,
        providerSessionId: session.id,
        timestamp: input.timestamp,
        eventContext: input.eventContext,
        payload: {
          from: session.status,
          to: session.status,
          adapterStartRequested: true,
          terminal: false,
        },
        });
      }
      return { kind: 'applied', session };
    }
    return this.#classifyMutationFailure(
      input.workspaceId,
      input.sessionId,
      input.expectedVersion,
      input.expectedClaimEpoch,
      input.expectedClaimOwner,
      (session) => {
        if (session.adapterStartRequestedAt !== null) return 'already-requested';
        return null;
      },
      { expectedFrom: 'starting' },
    );
  }

  /**
   * Expected-version + claim-fence CAS status transition. Terminal targets
   * are immutable once applied; duplicate terminal observation returns the
   * stored terminal fact (never an implicit retry).
   */
  transitionStatus(input: SessionStatusTransitionInput): ProviderSessionMutationOutcome {
    if (this.factWriter && !isTransactionActive(this.db)) {
      return inTransaction(this.db, () => this.transitionStatus(input));
    }
    assertNonEmptyString(input.workspaceId, 'workspaceId');
    assertNonEmptyString(input.sessionId, 'sessionId');
    assertExpectedVersion(input.expectedVersion);
    assertFence(input);
    assertCanonicalTimestamp(input.timestamp, 'timestamp');
    if (!PROVIDER_SESSION_STATUSES.includes(input.expectedFrom)) {
      throw new ProviderSessionValidationError(
        'PROVIDER_SESSION_VALIDATION_FAILED: expectedFrom is not a valid session status',
      );
    }
    if (!PROVIDER_SESSION_STATUSES.includes(input.to)) {
      throw new ProviderSessionValidationError(
        'PROVIDER_SESSION_VALIDATION_FAILED: to is not a valid session status',
      );
    }
    if (!isProviderSessionTransitionAllowed(input.expectedFrom, input.to)) {
      throw new ProviderSessionValidationError(
        `PROVIDER_SESSION_VALIDATION_FAILED: cannot transition session from '${input.expectedFrom}' to '${input.to}'`,
      );
    }
    const failureCode = assertSafeCode(input.failureCode, 'failureCode');
    const failureDetailRedacted = assertSafeDetail(
      input.failureDetailRedacted,
      'failureDetailRedacted',
    );
    if (input.to === 'failed' && (failureCode === null || failureDetailRedacted === null)) {
      throw new ProviderSessionValidationError(
        'PROVIDER_SESSION_VALIDATION_FAILED: failureCode and failureDetailRedacted are required for failed',
      );
    }

    const result = this.db.prepare(`
      UPDATE provider_sessions
      SET status = ?,
        started_at = CASE
          WHEN ? = 'active' AND started_at IS NULL THEN ?
          ELSE started_at
        END,
        last_activity_at = CASE
          WHEN ? IN ('active','waiting','paused') THEN ?
          ELSE last_activity_at
        END,
        completed_at = CASE
          WHEN ? IN ('completed','failed','cancelled') AND completed_at IS NULL THEN ?
          ELSE completed_at
        END,
        error_code = CASE WHEN ? = 'failed' THEN ? ELSE error_code END,
        error_detail_redacted = CASE WHEN ? = 'failed' THEN ? ELSE error_detail_redacted END,
        updated_at = ?,
        version = version + 1
      WHERE workspace_id = ? AND id = ?
        AND status = ? AND version = ?
        AND claim_epoch = ? AND claim_owner_id IS ?
    `).run(
      input.to,
      input.to, input.timestamp,
      input.to, input.timestamp,
      input.to, input.timestamp,
      input.to, failureCode,
      input.to, failureDetailRedacted,
      input.timestamp,
      input.workspaceId, input.sessionId,
      input.expectedFrom, input.expectedVersion,
      input.expectedClaimEpoch, input.expectedClaimOwner,
    ) as { changes: number };

    if (result.changes === 1) {
      const session = this.findById(input.workspaceId, input.sessionId)!;
      if (this.factWriter !== undefined) {
        if (input.eventContext === undefined) {
          throw new ProviderSessionValidationError(
            'PROVIDER_SESSION_VALIDATION_FAILED: eventContext is required for durable session facts',
          );
        }
        this.factWriter.appendWithinTransaction({
        type: 'process.session_state_changed',
        workspaceId: session.workspaceId,
        taskId: session.taskId,
        runId: session.runId,
        stageId: session.stageId,
        providerSessionId: session.id,
        timestamp: input.timestamp,
        eventContext: input.eventContext,
        payload: {
          from: input.expectedFrom,
          to: input.to,
          adapterStartRequested: session.adapterStartRequestedAt !== null,
          terminal: TERMINAL_PROVIDER_SESSION_STATUSES.includes(session.status as TerminalProviderSessionStatus),
          ...(session.errorCode === null ? {} : { errorCode: session.errorCode }),
        },
        });
      }
      return { kind: 'applied', session };
    }
    return this.#classifyMutationFailure(
      input.workspaceId,
      input.sessionId,
      input.expectedVersion,
      input.expectedClaimEpoch,
      input.expectedClaimOwner,
      (session) => {
        if (TERMINAL_PROVIDER_SESSION_STATUSES.includes(
          session.status as TerminalProviderSessionStatus,
        )) {
          return 'terminal';
        }
        if (session.status !== input.expectedFrom) return 'state-mismatch';
        return null;
      },
      { expectedFrom: input.expectedFrom },
    );
  }

  /**
   * Ownership transfer (claim takeover) — the only permitted ownership
   * change. Preconditions are fail-closed: the Session must still be
   * `starting`, `adapter_start_requested_at` must be absent, the recorded
   * lease must be expired under the injected canonical clock, and the
   * expected version/epoch/owner must all match. The winner increments the
   * epoch and installs a new owner/lease; anything else is a fence conflict.
   */
  casTransferClaim(input: SessionClaimTransferInput): ProviderSessionMutationOutcome {
    if (this.factWriter && !isTransactionActive(this.db)) {
      return inTransaction(this.db, () => this.casTransferClaim(input));
    }
    assertNonEmptyString(input.workspaceId, 'workspaceId');
    assertNonEmptyString(input.sessionId, 'sessionId');
    assertExpectedVersion(input.expectedVersion);
    assertFence(input);
    assertCanonicalTimestamp(input.timestamp, 'timestamp');
    if (typeof input.newClaimOwner !== 'string' || input.newClaimOwner.length === 0) {
      throw new ProviderSessionValidationError(
        'PROVIDER_SESSION_VALIDATION_FAILED: newClaimOwner is required',
      );
    }
    assertCanonicalTimestamp(input.newClaimLeaseExpiresAt, 'newClaimLeaseExpiresAt');

    const result = this.db.prepare(`
      UPDATE provider_sessions
      SET claim_epoch = claim_epoch + 1,
        claim_owner_id = ?,
        claim_lease_expires_at = ?,
        updated_at = ?,
        version = version + 1
      WHERE workspace_id = ? AND id = ?
        AND status = 'starting'
        AND adapter_start_requested_at IS NULL
        AND claim_lease_expires_at IS NOT NULL
        AND claim_lease_expires_at <= ?
        AND version = ?
        AND claim_epoch = ?
        AND claim_owner_id IS ?
    `).run(
      input.newClaimOwner,
      input.newClaimLeaseExpiresAt,
      input.timestamp,
      input.workspaceId,
      input.sessionId,
      input.timestamp,
      input.expectedVersion,
      input.expectedClaimEpoch,
      input.expectedClaimOwner,
    ) as { changes: number };

    if (result.changes === 1) {
      const session = this.findById(input.workspaceId, input.sessionId)!;
      if (this.factWriter !== undefined) {
        if (input.eventContext === undefined) {
          throw new ProviderSessionValidationError(
            'PROVIDER_SESSION_VALIDATION_FAILED: eventContext is required for durable session facts',
          );
        }
        this.factWriter.appendWithinTransaction({
        type: 'process.claim_transferred',
        workspaceId: session.workspaceId,
        taskId: session.taskId,
        runId: session.runId,
        stageId: session.stageId,
        providerSessionId: session.id,
        timestamp: input.timestamp,
        eventContext: input.eventContext,
        payload: {
          claimEpoch: session.claimEpoch,
          authorityRole: session.authorityRole,
          ownerChanged: true,
        },
        });
      }
      return { kind: 'applied', session };
    }
    return this.#classifyMutationFailure(
      input.workspaceId,
      input.sessionId,
      input.expectedVersion,
      input.expectedClaimEpoch,
      input.expectedClaimOwner,
      (session) => {
        if (TERMINAL_PROVIDER_SESSION_STATUSES.includes(
          session.status as TerminalProviderSessionStatus,
        )) {
          return 'terminal';
        }
        if (session.adapterStartRequestedAt !== null) return 'already-requested';
        if (session.status !== 'starting') return 'state-mismatch';
        return null; // lease not expired / epoch / owner mismatch → fence conflict
      },
      { expectedFrom: 'starting' },
    );
  }

  #classifyMutationFailure(
    workspaceId: string,
    sessionId: string,
    expectedVersion: number,
    expectedClaimEpoch: number,
    expectedClaimOwner: string | null,
    extra: (session: ProviderSession) => ProviderSessionMutationOutcome['kind'] | null,
    options: { expectedFrom?: ProviderSessionStatus } = {},
  ): ProviderSessionMutationOutcome {
    const row = this.db.prepare(`
      SELECT id FROM provider_sessions WHERE id = ?
    `).get(sessionId) as { id: string } | undefined;
    if (row === undefined) return { kind: 'not-found' };
    const session = this.findById(workspaceId, sessionId);
    if (session === undefined) return { kind: 'workspace-mismatch' };
    const specific = extra(session);
    if (specific !== null) {
      return { kind: specific, session };
    }
    if (session.version !== expectedVersion) {
      return { kind: 'version-conflict', session };
    }
    if (
      session.claimEpoch !== expectedClaimEpoch
      || session.claimOwnerId !== expectedClaimOwner
    ) {
      return { kind: 'fence-conflict', session };
    }
    if (options.expectedFrom !== undefined && session.status === options.expectedFrom) {
      return { kind: 'fence-conflict', session };
    }
    return { kind: 'state-mismatch', session };
  }
}
