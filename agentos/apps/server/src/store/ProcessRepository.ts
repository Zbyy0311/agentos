import { createHash } from 'node:crypto';
import type { RuntimeEventContext } from '@agentos/shared';
import { isValidNativeBirthIdentity } from '@agentos/process-runtime';
import { canonicalizeJson } from '../snapshots/canonicalJson.js';
import { isCanonicalUtcTimestamp } from './CanonicalTimestamp.js';
import { createEntityId, isValidEntityId } from './Identity.js';
import { inTransaction, isTransactionActive, type TransactionDatabase } from './Transaction.js';
import type { DurableRuntimeFactWriter } from './RuntimeEventRepository.js';

/**
 * M4-P2B durable Runtime Process repository (Migration 014
 * `runtime_processes`). The `proc_` reservation is created with status
 * `created` BEFORE any spawn; the winning fenced CAS `created -> starting`
 * consumes the one spawn right; a null PID in `starting` never means
 * unspawned. The partial UNIQUE root-claim index guarantees exactly one root
 * Process per Stage attempt. Native PID binds only to the same Process and is
 * never identity. Every mutation is an expected-version CAS plus the claim
 * epoch/owner fence; zero affected rows is classified (never an implicit
 * retry) and terminal states (exited/failed) are immutable with duplicate
 * terminal observation returning the stored fact.
 *
 * The state machine below is the frozen P0 §7 table adopted by the P1
 * process-runtime package (ALLOWED_TRANSITIONS) and is mirrored here
 * faithfully; the only process-runtime symbol this store consumes is the
 * shared canonical native-birth-identity validator (a pure function).
 */

export const PROCESS_STATES = [
  'created',
  'starting',
  'running',
  'waiting',
  'stopping',
  'exited',
  'failed',
  'orphaned',
  'unknown',
] as const;

export type ProcessState = (typeof PROCESS_STATES)[number];

export const TERMINAL_PROCESS_STATES = ['exited', 'failed'] as const;
export type TerminalProcessState = (typeof TERMINAL_PROCESS_STATES)[number];

export const PROCESS_ALLOWED_TRANSITIONS: Readonly<
  Record<ProcessState, readonly ProcessState[]>
> = {
  created: ['starting', 'failed', 'unknown'],
  starting: ['running', 'stopping', 'failed', 'unknown'],
  running: ['waiting', 'stopping', 'exited', 'orphaned', 'unknown'],
  waiting: ['running', 'stopping', 'exited', 'orphaned', 'unknown'],
  stopping: ['exited', 'failed', 'orphaned', 'unknown'],
  exited: [],
  failed: [],
  orphaned: ['exited', 'unknown'],
  unknown: ['orphaned', 'failed', 'exited'],
};

export function isProcessTransitionAllowed(from: ProcessState, to: ProcessState): boolean {
  return from === to || PROCESS_ALLOWED_TRANSITIONS[from].includes(to);
}

export const PROCESS_TYPES = [
  'provider',
  'tool',
  'command',
  'git',
  'test',
  'system',
  'extension',
] as const;
export type ProcessType = (typeof PROCESS_TYPES)[number];

export const PROCESS_STDIN_MODES = ['closed', 'pipe'] as const;
export const PROCESS_CAPTURE_MODES = ['capture', 'null'] as const;

export const PROCESS_AUTHORITY_ROLE = 'primary-provider' as const;

export const CLEANUP_RESULTS = [
  'TERMINATED',
  'ALREADY_EXITED',
  'SURVIVORS',
  'IDENTITY_MISMATCH',
  'UNKNOWN_PLATFORM_UNAVAILABLE',
] as const;
export type CleanupResult = (typeof CLEANUP_RESULTS)[number];

export const RECOVERY_CLASSIFICATIONS = ['same', 'missing', 'mismatch', 'unknown'] as const;

/** Frozen P1 launch/redaction ceilings for canonical JSON columns. */
export const PROCESS_ARGS_REDACTED_JSON_MAX_BYTES = 64 * 1024;
export const PROCESS_TIMEOUT_POLICY_JSON_MAX_BYTES = 16 * 1024;
export const PROCESS_RECOVERY_EVIDENCE_JSON_MAX_BYTES = 16 * 1024;
export const PROCESS_SURVIVOR_PIDS_JSON_MAX_BYTES = 16 * 1024;
export const PROCESS_ERROR_DETAIL_MAX_BYTES = 4096;
export const PROCESS_PLATFORM_MAX_BYTES = 256;

interface RuntimeProcessRow {
  id: string;
  workspace_id: string;
  task_id: string;
  run_id: string;
  stage_id: string | null;
  stage_attempt: number | null;
  provider_session_id: string | null;
  parent_process_id: string | null;
  authority_role: string | null;
  claim_epoch: number;
  claim_owner_id: string | null;
  claim_lease_expires_at: string | null;
  process_type: string;
  platform: string;
  status: string;
  executable_resolved: string;
  executable_fingerprint: string | null;
  args_redacted_json: string;
  cwd_resolved: string;
  shell: number;
  detached: number;
  stdin_mode: string;
  stdout_mode: string;
  stderr_mode: string;
  timeout_policy_json: string;
  security_profile_ref: string;
  native_pid: number | null;
  native_parent_pid: number | null;
  native_started_at: string | null;
  native_birth_identity: string | null;
  process_group_id: string | null;
  tree_ownership_mode: string | null;
  platform_handle_id: string | null;
  recovery_token_hash: string | null;
  recovery_classification: string | null;
  recovery_evidence_json: string | null;
  recovery_checked_at: string | null;
  recovery_classifier_version: string | null;
  started_at: string | null;
  ready_at: string | null;
  last_activity_at: string | null;
  stopping_at: string | null;
  exited_at: string | null;
  exit_code: number | null;
  exit_signal: string | null;
  termination_reason: string | null;
  cleanup_result: string | null;
  survivor_pids_redacted_json: string | null;
  error_code: string | null;
  error_detail_redacted: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface RuntimeProcess {
  readonly id: string;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly stageId: string | null;
  readonly stageAttempt: number | null;
  readonly providerSessionId: string | null;
  readonly parentProcessId: string | null;
  readonly authorityRole: string | null;
  readonly claimEpoch: number;
  readonly claimOwnerId: string | null;
  readonly claimLeaseExpiresAt: string | null;
  readonly processType: ProcessType;
  readonly platform: string;
  readonly status: ProcessState;
  readonly executableResolved: string;
  readonly executableFingerprint: string | null;
  /** Canonical bounded redacted launch arguments (never raw argument values). */
  readonly argsRedactedJson: string;
  readonly cwdResolved: string;
  readonly shell: 0 | 1;
  readonly detached: 0 | 1;
  readonly stdinMode: 'closed' | 'pipe';
  readonly stdoutMode: 'capture' | 'null';
  readonly stderrMode: 'capture' | 'null';
  /** Canonical bounded JSON of the frozen safe timeout policy. */
  readonly timeoutPolicyJson: string;
  readonly securityProfileRef: string;
  readonly nativePid: number | null;
  readonly nativeParentPid: number | null;
  readonly nativeStartedAt: string | null;
  readonly nativeBirthIdentity: string | null;
  readonly processGroupId: string | null;
  readonly treeOwnershipMode: string | null;
  readonly platformHandleId: string | null;
  readonly recoveryTokenHash: string | null;
  readonly recoveryClassification: string | null;
  readonly recoveryEvidenceJson: string | null;
  readonly recoveryCheckedAt: string | null;
  readonly recoveryClassifierVersion: string | null;
  readonly startedAt: string | null;
  readonly readyAt: string | null;
  readonly lastActivityAt: string | null;
  readonly stoppingAt: string | null;
  readonly exitedAt: string | null;
  readonly exitCode: number | null;
  readonly exitSignal: string | null;
  readonly terminationReason: string | null;
  readonly cleanupResult: CleanupResult | null;
  readonly survivorPidsRedactedJson: string | null;
  readonly errorCode: string | null;
  readonly errorDetailRedacted: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

export interface CreateProcessInput {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly stageId?: string | null;
  readonly stageAttempt?: number | null;
  readonly providerSessionId?: string | null;
  readonly parentProcessId?: string | null;
  readonly authorityRole?: typeof PROCESS_AUTHORITY_ROLE | null;
  readonly claimEpoch?: number;
  readonly claimOwnerId?: string | null;
  readonly claimLeaseExpiresAt?: string | null;
  readonly processType: ProcessType;
  readonly platform: string;
  readonly executableResolved: string;
  readonly executableFingerprint?: string | null;
  /** Redacted launch arguments; canonicalized and bounded before persistence. */
  readonly argsRedacted: unknown;
  readonly cwdResolved: string;
  readonly shell: 0 | 1;
  readonly detached: 0 | 1;
  readonly stdinMode: 'closed' | 'pipe';
  readonly stdoutMode: 'capture' | 'null';
  readonly stderrMode: 'capture' | 'null';
  /** Frozen safe timeout policy; canonicalized and bounded before persistence. */
  readonly timeoutPolicy: unknown;
  readonly securityProfileRef: string;
  readonly createdAt?: string;
  /** Accepted Operation/Run context for the launch_requested fact. */
  readonly eventContext?: RuntimeEventContext;
}

export type CreateProcessResult =
  | { readonly kind: 'created'; readonly process: RuntimeProcess; readonly eventId?: string }
  | { readonly kind: 'joined'; readonly process: RuntimeProcess; readonly eventId?: string };

export type ProcessMutationOutcome =
  | { readonly kind: 'applied'; readonly process: RuntimeProcess; readonly eventId?: string }
  | { readonly kind: 'terminal'; readonly process: RuntimeProcess; readonly eventId?: string }
  | { readonly kind: 'state-mismatch'; readonly process: RuntimeProcess; readonly eventId?: string }
  | { readonly kind: 'version-conflict'; readonly process: RuntimeProcess; readonly eventId?: string }
  | { readonly kind: 'fence-conflict'; readonly process: RuntimeProcess; readonly eventId?: string }
  | { readonly kind: 'workspace-mismatch'; readonly eventId?: string }
  | { readonly kind: 'not-found'; readonly eventId?: string };

export interface ProcessClaimFence {
  readonly expectedClaimEpoch: number;
  /** Null matches an unclaimed Process; otherwise the exact service owner. */
  readonly expectedClaimOwner: string | null;
}

export interface CasStartProcessInput extends ProcessClaimFence {
  readonly workspaceId: string;
  readonly processId: string;
  readonly expectedVersion: number;
  readonly timestamp: string;
  readonly eventContext?: RuntimeEventContext;
}

export interface BindNativeIdentityInput extends ProcessClaimFence {
  readonly workspaceId: string;
  readonly processId: string;
  readonly expectedVersion: number;
  readonly timestamp: string;
  readonly nativePid: number;
  readonly nativeParentPid?: number | null;
  readonly nativeStartedAt: string;
  /** P6-M3b: lossless native birth identity (canonical column); null when unavailable. */
  readonly nativeBirthIdentity?: string | null;
  readonly processGroupId?: string | null;
  readonly platformHandleId?: string | null;
  /**
   * P6-M2a: one-time random recovery token captured at spawn. Plaintext is
   * accepted in-transit only; this method stores ONLY its SHA-256 hash and a
   * classifier-ready recovery_evidence_json. The raw token is never persisted.
   */
  readonly recoveryToken?: string;
  readonly eventContext?: RuntimeEventContext;
}

export interface ProcessStatusTransitionInput extends ProcessClaimFence {
  readonly workspaceId: string;
  readonly processId: string;
  readonly expectedVersion: number;
  readonly expectedFrom: ProcessState;
  readonly to: ProcessState;
  readonly timestamp: string;
  readonly exitCode?: number | null;
  readonly exitSignal?: string | null;
  readonly terminationReason?: string | null;
  readonly cleanupResult?: CleanupResult | null;
  readonly survivorPidsRedacted?: unknown | null;
  readonly errorCode?: string | null;
  readonly errorDetailRedacted?: string | null;
  readonly eventContext?: RuntimeEventContext;
  /** Frozen stop evidence required for a durable process.stopping fact. */
  readonly gracefulRequested?: boolean;
  readonly graceDeadline?: string;
  readonly forceDeadline?: string;
  readonly idempotencyKeyHash?: string;
  /** Frozen terminal evidence required for a durable process.exited fact. */
  readonly durationMs?: number;
  readonly graceful?: boolean;
  readonly force?: boolean;
  /** Explicit P0 outcome/evidence for a durable process.failed fact. */
  readonly failureOutcome?:
    | 'spawn-failure'
    | 'spawn-failure-after-cancel'
    | 'registration-failure'
    | 'cancelled-before-spawn';
  readonly cancelReason?: string;
  readonly cancelCausationId?: string;
  readonly spawnFailureEvidence?: string;
}

export interface ProcessClaimTransferInput extends ProcessClaimFence {
  readonly workspaceId: string;
  readonly processId: string;
  readonly expectedVersion: number;
  readonly timestamp: string;
  readonly newClaimOwner: string;
  readonly newClaimLeaseExpiresAt: string;
  readonly eventContext?: RuntimeEventContext;
}

function integrityFailure(reason: string): RuntimeProcessIntegrityError {
  return new RuntimeProcessIntegrityError(
    `RUNTIME_PROCESS_INTEGRITY_FAILED: ${reason}`,
  );
}

function assertNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw integrityFailure(`${field} is invalid`);
  }
  return value;
}

function assertOptionalString(value: unknown, field: string): void {
  if (value !== null && typeof value !== 'string') {
    throw integrityFailure(`${field} is invalid`);
  }
}

function assertOptionalInteger(value: unknown, field: string): void {
  if (value !== null && (typeof value !== 'number' || !Number.isInteger(value))) {
    throw integrityFailure(`${field} is invalid`);
  }
}

function assertOptionalTimestamp(value: unknown, field: string): void {
  if (value !== null && !isCanonicalUtcTimestamp(value)) {
    throw integrityFailure(`${field} is invalid`);
  }
}

function assertProcessId(value: string, field: string): void {
  assertNonEmptyString(value, field);
  if (!isValidEntityId(value, 'process')) {
    throw integrityFailure(`${field} is not a canonical proc_ identity`);
  }
}

function validateProcessRow(row: unknown): asserts row is RuntimeProcessRow {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) {
    throw integrityFailure('row is invalid');
  }
  const value = row as Record<string, unknown>;
  assertProcessId(value.id as string, 'id');
  assertNonEmptyString(value.workspace_id, 'workspace_id');
  assertNonEmptyString(value.task_id, 'task_id');
  assertNonEmptyString(value.run_id, 'run_id');
  assertOptionalString(value.stage_id, 'stage_id');
  if (
    value.stage_attempt !== null
    && (typeof value.stage_attempt !== 'number' || !Number.isInteger(value.stage_attempt) || value.stage_attempt < 1)
  ) {
    throw integrityFailure('stage_attempt is invalid');
  }
  assertOptionalString(value.provider_session_id, 'provider_session_id');
  assertOptionalString(value.parent_process_id, 'parent_process_id');
  if (value.authority_role !== null && value.authority_role !== PROCESS_AUTHORITY_ROLE) {
    throw integrityFailure('authority_role is invalid');
  }
  if (typeof value.claim_epoch !== 'number' || !Number.isInteger(value.claim_epoch) || value.claim_epoch < 1) {
    throw integrityFailure('claim_epoch is invalid');
  }
  assertOptionalString(value.claim_owner_id, 'claim_owner_id');
  assertOptionalTimestamp(value.claim_lease_expires_at, 'claim_lease_expires_at');
  if (!PROCESS_TYPES.includes(value.process_type as ProcessType)) {
    throw integrityFailure('process_type is invalid');
  }
  assertNonEmptyString(value.platform, 'platform');
  if (!PROCESS_STATES.includes(value.status as ProcessState)) {
    throw integrityFailure('status is invalid');
  }
  assertNonEmptyString(value.executable_resolved, 'executable_resolved');
  assertOptionalString(value.executable_fingerprint, 'executable_fingerprint');
  assertNonEmptyString(value.args_redacted_json, 'args_redacted_json');
  assertNonEmptyString(value.cwd_resolved, 'cwd_resolved');
  if (value.shell !== 0 && value.shell !== 1) throw integrityFailure('shell is invalid');
  if (value.detached !== 0 && value.detached !== 1) throw integrityFailure('detached is invalid');
  if (!PROCESS_STDIN_MODES.includes(value.stdin_mode as 'closed' | 'pipe')) {
    throw integrityFailure('stdin_mode is invalid');
  }
  if (!PROCESS_CAPTURE_MODES.includes(value.stdout_mode as 'capture' | 'null')) {
    throw integrityFailure('stdout_mode is invalid');
  }
  if (!PROCESS_CAPTURE_MODES.includes(value.stderr_mode as 'capture' | 'null')) {
    throw integrityFailure('stderr_mode is invalid');
  }
  assertNonEmptyString(value.timeout_policy_json, 'timeout_policy_json');
  assertNonEmptyString(value.security_profile_ref, 'security_profile_ref');
  assertOptionalInteger(value.native_pid, 'native_pid');
  assertOptionalInteger(value.native_parent_pid, 'native_parent_pid');
  assertOptionalTimestamp(value.native_started_at, 'native_started_at');
  assertOptionalString(value.native_birth_identity, 'native_birth_identity');
  assertOptionalString(value.process_group_id, 'process_group_id');
  assertOptionalString(value.tree_ownership_mode, 'tree_ownership_mode');
  assertOptionalString(value.platform_handle_id, 'platform_handle_id');
  assertOptionalString(value.recovery_token_hash, 'recovery_token_hash');
  if (
    value.recovery_classification !== null
    && !RECOVERY_CLASSIFICATIONS.includes(value.recovery_classification as 'same' | 'missing' | 'mismatch' | 'unknown')
  ) {
    throw integrityFailure('recovery_classification is invalid');
  }
  assertOptionalString(value.recovery_evidence_json, 'recovery_evidence_json');
  assertOptionalTimestamp(value.recovery_checked_at, 'recovery_checked_at');
  assertOptionalString(value.recovery_classifier_version, 'recovery_classifier_version');
  assertOptionalTimestamp(value.started_at, 'started_at');
  assertOptionalTimestamp(value.ready_at, 'ready_at');
  assertOptionalTimestamp(value.last_activity_at, 'last_activity_at');
  assertOptionalTimestamp(value.stopping_at, 'stopping_at');
  assertOptionalTimestamp(value.exited_at, 'exited_at');
  assertOptionalInteger(value.exit_code, 'exit_code');
  assertOptionalString(value.exit_signal, 'exit_signal');
  assertOptionalString(value.termination_reason, 'termination_reason');
  if (value.cleanup_result !== null && !CLEANUP_RESULTS.includes(value.cleanup_result as CleanupResult)) {
    throw integrityFailure('cleanup_result is invalid');
  }
  assertOptionalString(value.survivor_pids_redacted_json, 'survivor_pids_redacted_json');
  assertOptionalString(value.error_code, 'error_code');
  assertOptionalString(value.error_detail_redacted, 'error_detail_redacted');
  if (typeof value.version !== 'number' || !Number.isInteger(value.version) || value.version < 1) {
    throw integrityFailure('version is invalid');
  }
  if (!isCanonicalUtcTimestamp(value.created_at)) throw integrityFailure('created_at is invalid');
  if (!isCanonicalUtcTimestamp(value.updated_at)) throw integrityFailure('updated_at is invalid');
  assertOptionalTimestamp(value.archived_at, 'archived_at');
  if ((value.claim_owner_id === null) !== (value.claim_lease_expires_at === null)) {
    throw integrityFailure('claim pair is inconsistent');
  }
  if (value.status === 'created' && (value.native_pid !== null || value.native_started_at !== null)) {
    throw integrityFailure('created process must not carry native identity');
  }
  if (value.status === 'running' && (value.native_pid === null || value.native_started_at === null || value.started_at === null)) {
    throw integrityFailure('running process requires native pid, native_started_at and started_at');
  }
  if (TERMINAL_PROCESS_STATES.includes(value.status as TerminalProcessState) && value.exited_at === null) {
    throw integrityFailure('terminal process requires exited_at');
  }
}

function mapProcess(row: RuntimeProcessRow): RuntimeProcess {
  validateProcessRow(row);
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    taskId: row.task_id,
    runId: row.run_id,
    stageId: row.stage_id,
    stageAttempt: row.stage_attempt,
    providerSessionId: row.provider_session_id,
    parentProcessId: row.parent_process_id,
    authorityRole: row.authority_role,
    claimEpoch: row.claim_epoch,
    claimOwnerId: row.claim_owner_id,
    claimLeaseExpiresAt: row.claim_lease_expires_at,
    processType: row.process_type as ProcessType,
    platform: row.platform,
    status: row.status as ProcessState,
    executableResolved: row.executable_resolved,
    executableFingerprint: row.executable_fingerprint,
    argsRedactedJson: row.args_redacted_json,
    cwdResolved: row.cwd_resolved,
    shell: row.shell as 0 | 1,
    detached: row.detached as 0 | 1,
    stdinMode: row.stdin_mode as 'closed' | 'pipe',
    stdoutMode: row.stdout_mode as 'capture' | 'null',
    stderrMode: row.stderr_mode as 'capture' | 'null',
    timeoutPolicyJson: row.timeout_policy_json,
    securityProfileRef: row.security_profile_ref,
    nativePid: row.native_pid,
    nativeParentPid: row.native_parent_pid,
    nativeStartedAt: row.native_started_at,
    nativeBirthIdentity: row.native_birth_identity,
    processGroupId: row.process_group_id,
    treeOwnershipMode: row.tree_ownership_mode,
    platformHandleId: row.platform_handle_id,
    recoveryTokenHash: row.recovery_token_hash,
    recoveryClassification: row.recovery_classification,
    recoveryEvidenceJson: row.recovery_evidence_json,
    recoveryCheckedAt: row.recovery_checked_at,
    recoveryClassifierVersion: row.recovery_classifier_version,
    startedAt: row.started_at,
    readyAt: row.ready_at,
    lastActivityAt: row.last_activity_at,
    stoppingAt: row.stopping_at,
    exitedAt: row.exited_at,
    exitCode: row.exit_code,
    exitSignal: row.exit_signal,
    terminationReason: row.termination_reason,
    cleanupResult: row.cleanup_result as CleanupResult | null,
    survivorPidsRedactedJson: row.survivor_pids_redacted_json,
    errorCode: row.error_code,
    errorDetailRedacted: row.error_detail_redacted,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

export class RuntimeProcessValidationError extends Error {
  readonly code = 'RUNTIME_PROCESS_VALIDATION_FAILED' as const;

  constructor(message = 'RUNTIME_PROCESS_VALIDATION_FAILED') {
    super(message);
    this.name = 'RuntimeProcessValidationError';
  }
}

export class RuntimeProcessIntegrityError extends Error {
  readonly code = 'RUNTIME_PROCESS_INTEGRITY_FAILED' as const;

  constructor(message = 'RUNTIME_PROCESS_INTEGRITY_FAILED') {
    super(message);
    this.name = 'RuntimeProcessIntegrityError';
  }
}

function assertCanonicalTimestamp(value: string, field: string): void {
  if (!isCanonicalUtcTimestamp(value)) {
    throw new RuntimeProcessValidationError(
      `RUNTIME_PROCESS_VALIDATION_FAILED: ${field} must be canonical UTC ISO 8601 milliseconds`,
    );
  }
}

function canonicalBoundedJson(value: unknown, field: string, maxBytes: number): string {
  let canonical: string;
  try {
    canonical = canonicalizeJson(value);
  } catch (error) {
    throw new RuntimeProcessValidationError(
      `RUNTIME_PROCESS_VALIDATION_FAILED: ${field} must be canonical JSON (${error instanceof Error ? error.message : 'invalid'})`,
    );
  }
  const byteLength = new TextEncoder().encode(canonical).length;
  if (byteLength > maxBytes) {
    throw new RuntimeProcessValidationError(
      `RUNTIME_PROCESS_VALIDATION_FAILED: ${field} exceeds ${maxBytes} canonical bytes`,
    );
  }
  return canonical;
}

function assertOptionalCanonicalJson(
  value: unknown,
  field: string,
  maxBytes: number,
): string | null {
  if (value === undefined || value === null) return null;
  return canonicalBoundedJson(value, field, maxBytes);
}

function assertSafeDetail(value: string | null | undefined, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RuntimeProcessValidationError(
      `RUNTIME_PROCESS_VALIDATION_FAILED: ${field} must be a non-empty string`,
    );
  }
  const byteLength = new TextEncoder().encode(value).length;
  if (byteLength > PROCESS_ERROR_DETAIL_MAX_BYTES) {
    throw new RuntimeProcessValidationError(
      `RUNTIME_PROCESS_VALIDATION_FAILED: ${field} exceeds ${PROCESS_ERROR_DETAIL_MAX_BYTES} bytes`,
    );
  }
  return value;
}

function assertSafeCode(value: string | null | undefined, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 128) {
    throw new RuntimeProcessValidationError(
      `RUNTIME_PROCESS_VALIDATION_FAILED: ${field} must be a bounded stable code`,
    );
  }
  return value;
}

function assertFence(fence: ProcessClaimFence): void {
  if (!Number.isSafeInteger(fence.expectedClaimEpoch) || fence.expectedClaimEpoch < 1) {
    throw new RuntimeProcessValidationError(
      'RUNTIME_PROCESS_VALIDATION_FAILED: expectedClaimEpoch must be a positive safe integer',
    );
  }
  if (fence.expectedClaimOwner !== null && typeof fence.expectedClaimOwner !== 'string') {
    throw new RuntimeProcessValidationError(
      'RUNTIME_PROCESS_VALIDATION_FAILED: expectedClaimOwner must be a string or null',
    );
  }
}

function assertExpectedVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new RuntimeProcessValidationError(
      'RUNTIME_PROCESS_VALIDATION_FAILED: expectedVersion must be a positive safe integer',
    );
  }
}

function assertOptionalExitCode(value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value)) {
    throw new RuntimeProcessValidationError(
      'RUNTIME_PROCESS_VALIDATION_FAILED: exitCode must be an integer or null',
    );
  }
  return value;
}

function assertOptionalCleanupResult(value: CleanupResult | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (!CLEANUP_RESULTS.includes(value)) {
    throw new RuntimeProcessValidationError(
      'RUNTIME_PROCESS_VALIDATION_FAILED: cleanupResult is not in the frozen vocabulary',
    );
  }
  return value;
}

export class ProcessRepository {
  constructor(
    private readonly db: TransactionDatabase,
    private readonly factWriter?: DurableRuntimeFactWriter,
  ) {}

  /**
   * Create the `created` reservation BEFORE any spawn. A duplicate root
   * claim per Stage attempt joins the existing Process (exactly-one winner).
   * Parent cycles / self-parent and missing parents fail closed at this
   * repository layer; the single-statement INSERT is atomic and the cycle
   * check runs inside a transaction when one is not already active.
   */
  createProcess(input: CreateProcessInput): CreateProcessResult {
    const insert = () => this.#insertProcess(input);
    if (isTransactionActive(this.db)) return insert();
    return inTransaction(this.db, insert);
  }

  findById(workspaceId: string, processId: string): RuntimeProcess | undefined {
    const row = this.db.prepare(`
      SELECT * FROM runtime_processes WHERE workspace_id = ? AND id = ?
    `).get(workspaceId, processId) as RuntimeProcessRow | undefined;
    return row === undefined ? undefined : mapProcess(row);
  }

  findByRootClaim(
    workspaceId: string,
    runId: string,
    stageId: string,
    stageAttempt: number,
    authorityRole: typeof PROCESS_AUTHORITY_ROLE,
  ): RuntimeProcess | undefined {
    const row = this.db.prepare(`
      SELECT * FROM runtime_processes
      WHERE workspace_id = ? AND run_id = ? AND stage_id = ? AND stage_attempt = ?
        AND authority_role = ? AND parent_process_id IS NULL
    `).get(workspaceId, runId, stageId, stageAttempt, authorityRole) as
      RuntimeProcessRow | undefined;
    return row === undefined ? undefined : mapProcess(row);
  }

  /**
   * The winning fenced CAS `created -> starting` consumes the one spawn
   * right before any Driver call. Losers observe the current state and never
   * spawn; a `starting`/later Process with a null PID is never retried.
   */
  casStartProcess(input: CasStartProcessInput): ProcessMutationOutcome {
    if (this.factWriter && !isTransactionActive(this.db)) {
      return inTransaction(this.db, () => this.casStartProcess(input));
    }
    assertNonEmptyString(input.workspaceId, 'workspaceId');
    assertProcessId(input.processId, 'processId');
    assertExpectedVersion(input.expectedVersion);
    assertFence(input);
    assertCanonicalTimestamp(input.timestamp, 'timestamp');

    const result = this.db.prepare(`
      UPDATE runtime_processes
      SET status = 'starting', updated_at = ?, version = version + 1
      WHERE workspace_id = ? AND id = ?
        AND status = 'created'
        AND version = ?
        AND claim_epoch = ?
        AND claim_owner_id IS ?
    `).run(
      input.timestamp,
      input.workspaceId,
      input.processId,
      input.expectedVersion,
      input.expectedClaimEpoch,
      input.expectedClaimOwner,
    ) as { changes: number };

    if (result.changes === 1) {
      const process = this.findById(input.workspaceId, input.processId)!;
      const eventId = this.#appendProcessFact('process.starting', process, input.timestamp, {
        from: 'created',
        to: 'starting',
        spawnRightConsumed: true,
      }, input.eventContext);
      return { kind: 'applied', process, ...(eventId === undefined ? {} : { eventId }) };
    }
    return this.#classifyProcessMutationFailure(
      input.workspaceId,
      input.processId,
      input.expectedVersion,
      input.expectedClaimEpoch,
      input.expectedClaimOwner,
      (process) => {
        if (TERMINAL_PROCESS_STATES.includes(process.status as TerminalProcessState)) {
          return 'terminal';
        }
        if (process.status !== 'created') return 'state-mismatch';
        return null;
      },
      { expectedFrom: 'created' },
    );
  }

  /**
   * Bind the returned native identity to this same AgentOS Process only.
   * `starting` moves to `running` (with started_at); a late success during
   * `stopping` binds identity/start evidence and stays `stopping` — never
   * running, never a replacement Process. PID is a transient native attribute
   * and never identity.
   */
  casBindNativeIdentity(input: BindNativeIdentityInput): ProcessMutationOutcome {
    if (this.factWriter && !isTransactionActive(this.db)) {
      return inTransaction(this.db, () => this.casBindNativeIdentity(input));
    }
    assertNonEmptyString(input.workspaceId, 'workspaceId');
    assertProcessId(input.processId, 'processId');
    assertExpectedVersion(input.expectedVersion);
    assertFence(input);
    assertCanonicalTimestamp(input.timestamp, 'timestamp');
    if (!Number.isSafeInteger(input.nativePid) || input.nativePid <= 0) {
      throw new RuntimeProcessValidationError(
        'RUNTIME_PROCESS_VALIDATION_FAILED: nativePid must be a positive integer',
      );
    }
    assertCanonicalTimestamp(input.nativeStartedAt, 'nativeStartedAt');
    const nativeParentPid = input.nativeParentPid === undefined ? null : input.nativeParentPid;
    if (nativeParentPid !== null && (!Number.isSafeInteger(nativeParentPid) || nativeParentPid <= 0)) {
      throw new RuntimeProcessValidationError(
        'RUNTIME_PROCESS_VALIDATION_FAILED: nativeParentPid must be a positive integer or null',
      );
    }
    const processGroupId = input.processGroupId === undefined ? null : input.processGroupId;
    const platformHandleId = input.platformHandleId === undefined ? null : input.platformHandleId;

    // P6-M3b: lossless native birth identity (canonical column value). Never
    // fabricated from the wall clock; null when capture was unavailable. A
    // non-null value MUST already be the exact canonical durable form
    // ('win32:filetime:<unsigned-decimal>'); arbitrary strings are rejected
    // before any write.
    const inputBirthIdentity = input.nativeBirthIdentity === undefined ? null : input.nativeBirthIdentity;
    if (inputBirthIdentity !== null && !isValidNativeBirthIdentity(inputBirthIdentity)) {
      throw new RuntimeProcessValidationError(
        'RUNTIME_PROCESS_VALIDATION_FAILED: nativeBirthIdentity must be canonical win32:filetime:<unsigned-decimal> or null',
      );
    }
    // Resolve the effective value together with the already-bound column so the
    // canonical column and the v2 JSON mirror are written atomically with
    // exactly the same value and can never diverge: null input keeps an
    // already-bound value; the same value is an idempotent duplicate; a
    // DIFFERENT non-null value fails closed because identity binds once. (A
    // missing row is left to the CAS below to classify.)
    const existingRow = this.db.prepare(
      'SELECT native_birth_identity AS birth FROM runtime_processes WHERE workspace_id = ? AND id = ?',
    ).get(input.workspaceId, input.processId) as { birth: string | null } | undefined;
    const existingBirth = existingRow === undefined || existingRow === null ? null : existingRow.birth ?? null;
    if (inputBirthIdentity !== null && existingBirth !== null && inputBirthIdentity !== existingBirth) {
      throw new RuntimeProcessValidationError(
        'RUNTIME_PROCESS_VALIDATION_FAILED: nativeBirthIdentity is already bound to a different value',
      );
    }
    const nativeBirthIdentity = inputBirthIdentity ?? existingBirth;
    // P6-M2a: derive recovery metadata. Only the token HASH is persisted; the
    // raw one-time token never reaches the database. recovery_evidence_json
    // carries the classifier inputs (pid, native start time, token hash,
    // platform); recovery_checked_at marks when this evidence was bound.
    const recoveryTokenHash = input.recoveryToken === undefined
      ? null
      : this.#sha256(input.recoveryToken);
    // Platform recorded in the process row at reservation time comes from the
    // host runtime platform; capture it explicitly to avoid ambiguity with the
    // persisted row read below.
    const recoveryPlatform = process.platform;
    const recoveryEvidenceJson = input.recoveryToken === undefined
      ? null
      : canonicalizeJson({
          schemaVersion: 2,
          nativePid: input.nativePid,
          nativeStartedAt: input.nativeStartedAt,
          nativeBirthIdentity,
          recoveryTokenHash,
          platform: recoveryPlatform,
        });
    const recoveryCheckedAt = input.recoveryToken === undefined ? null : input.timestamp;

    const result = this.db.prepare(`
      UPDATE runtime_processes
      SET status = CASE WHEN status = 'starting' THEN 'running' ELSE status END,
        native_pid = ?,
        native_parent_pid = ?,
        native_started_at = ?,
        native_birth_identity = ?,
        process_group_id = ?,
        platform_handle_id = ?,
        recovery_token_hash = COALESCE(?, recovery_token_hash),
        recovery_evidence_json = COALESCE(?, recovery_evidence_json),
        recovery_checked_at = COALESCE(?, recovery_checked_at),
        started_at = CASE WHEN status = 'starting' AND started_at IS NULL THEN ? ELSE started_at END,
        last_activity_at = ?,
        updated_at = ?,
        version = version + 1
      WHERE workspace_id = ? AND id = ?
        AND status IN ('starting','stopping')
        AND version = ?
        AND claim_epoch = ?
        AND claim_owner_id IS ?
    `).run(
      input.nativePid,
      nativeParentPid,
      input.nativeStartedAt,
      nativeBirthIdentity,
      processGroupId,
      platformHandleId,
      recoveryTokenHash,
      recoveryEvidenceJson,
      recoveryCheckedAt,
      input.timestamp,
      input.timestamp,
      input.timestamp,
      input.workspaceId,
      input.processId,
      input.expectedVersion,
      input.expectedClaimEpoch,
      input.expectedClaimOwner,
    ) as { changes: number };

    if (result.changes === 1) {
      const process = this.findById(input.workspaceId, input.processId)!;
      const eventId = this.#appendProcessFact('process.started', process, input.timestamp, {
        nativePid: process.nativePid!,
        nativeStartedAt: process.nativeStartedAt!,
        platform: process.platform,
        ...(process.treeOwnershipMode === null ? {} : { treeOwnershipMode: process.treeOwnershipMode }),
        startedAt: process.startedAt ?? input.timestamp,
      }, input.eventContext);
      return { kind: 'applied', process, ...(eventId === undefined ? {} : { eventId }) };
    }
    return this.#classifyProcessMutationFailure(
      input.workspaceId,
      input.processId,
      input.expectedVersion,
      input.expectedClaimEpoch,
      input.expectedClaimOwner,
      (process) => {
        if (TERMINAL_PROCESS_STATES.includes(process.status as TerminalProcessState)) {
          return 'terminal';
        }
        if (process.status !== 'starting' && process.status !== 'stopping') {
          return 'state-mismatch';
        }
        return null;
      },
    );
  }

  /**
   * Expected-version + claim-fence CAS status transition using the frozen P0
   * §7 transition table. Terminal targets are immutable once applied;
   * duplicate terminal observation returns the stored fact (never an
   * implicit retry or replacement).
   */
  transitionStatus(input: ProcessStatusTransitionInput): ProcessMutationOutcome {
    if (this.factWriter && !isTransactionActive(this.db)) {
      return inTransaction(this.db, () => this.transitionStatus(input));
    }
    assertNonEmptyString(input.workspaceId, 'workspaceId');
    assertProcessId(input.processId, 'processId');
    assertExpectedVersion(input.expectedVersion);
    assertFence(input);
    assertCanonicalTimestamp(input.timestamp, 'timestamp');
    if (!PROCESS_STATES.includes(input.expectedFrom)) {
      throw new RuntimeProcessValidationError(
        'RUNTIME_PROCESS_VALIDATION_FAILED: expectedFrom is not a valid process state',
      );
    }
    if (!PROCESS_STATES.includes(input.to)) {
      throw new RuntimeProcessValidationError(
        'RUNTIME_PROCESS_VALIDATION_FAILED: to is not a valid process state',
      );
    }
    if (!isProcessTransitionAllowed(input.expectedFrom, input.to)) {
      throw new RuntimeProcessValidationError(
        `RUNTIME_PROCESS_VALIDATION_FAILED: cannot transition process from '${input.expectedFrom}' to '${input.to}'`,
      );
    }
    const exitCode = assertOptionalExitCode(input.exitCode);
    const exitSignal = assertSafeCode(input.exitSignal, 'exitSignal');
    const terminationReason = input.terminationReason === undefined
      ? null
      : (typeof input.terminationReason === 'string' && input.terminationReason.trim().length > 0
        ? input.terminationReason : null);
    const cleanupResult = assertOptionalCleanupResult(input.cleanupResult);
    const survivorPidsJson = assertOptionalCanonicalJson(
      input.survivorPidsRedacted,
      'survivorPidsRedacted',
      PROCESS_SURVIVOR_PIDS_JSON_MAX_BYTES,
    );
    const errorCode = assertSafeCode(input.errorCode, 'errorCode');
    const errorDetailRedacted = assertSafeDetail(input.errorDetailRedacted, 'errorDetailRedacted');

    const result = this.db.prepare(`
      UPDATE runtime_processes
      SET status = ?,
        started_at = CASE WHEN ? = 'running' AND started_at IS NULL THEN ? ELSE started_at END,
        ready_at = CASE WHEN ? = 'running' AND ready_at IS NULL THEN ? ELSE ready_at END,
        stopping_at = CASE WHEN ? = 'stopping' AND stopping_at IS NULL THEN ? ELSE stopping_at END,
        exited_at = CASE WHEN ? IN ('exited','failed') AND exited_at IS NULL THEN ? ELSE exited_at END,
        exit_code = CASE WHEN ? IS NOT NULL THEN ? ELSE exit_code END,
        exit_signal = CASE WHEN ? IS NOT NULL THEN ? ELSE exit_signal END,
        termination_reason = CASE WHEN ? IS NOT NULL THEN ? ELSE termination_reason END,
        cleanup_result = CASE WHEN ? IS NOT NULL THEN ? ELSE cleanup_result END,
        survivor_pids_redacted_json = CASE WHEN ? IS NOT NULL THEN ? ELSE survivor_pids_redacted_json END,
        error_code = CASE WHEN ? IS NOT NULL THEN ? ELSE error_code END,
        error_detail_redacted = CASE WHEN ? IS NOT NULL THEN ? ELSE error_detail_redacted END,
        last_activity_at = ?,
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
      input.to, input.timestamp,
      exitCode, exitCode,
      exitSignal, exitSignal,
      terminationReason, terminationReason,
      cleanupResult, cleanupResult,
      survivorPidsJson, survivorPidsJson,
      errorCode, errorCode,
      errorDetailRedacted, errorDetailRedacted,
      input.timestamp,
      input.timestamp,
      input.workspaceId, input.processId,
      input.expectedFrom, input.expectedVersion,
      input.expectedClaimEpoch, input.expectedClaimOwner,
    ) as { changes: number };

    if (result.changes === 1) {
      const process = this.findById(input.workspaceId, input.processId)!;
      const eventId = this.#appendTransitionFact(input, process);
      return { kind: 'applied', process, ...(eventId === undefined ? {} : { eventId }) };
    }
    return this.#classifyProcessMutationFailure(
      input.workspaceId,
      input.processId,
      input.expectedVersion,
      input.expectedClaimEpoch,
      input.expectedClaimOwner,
      (process) => {
        if (TERMINAL_PROCESS_STATES.includes(process.status as TerminalProcessState)) {
          return 'terminal';
        }
        if (process.status !== input.expectedFrom) return 'state-mismatch';
        return null;
      },
      { expectedFrom: input.expectedFrom },
    );
  }

  /**
   * Ownership transfer of a root Process reservation. Preconditions are
   * fail-closed: status `created`, no native identity, expired lease,
   * expected version/epoch/owner all match; the winner increments the epoch
   * and installs a new owner/lease.
   */
  casTransferClaim(input: ProcessClaimTransferInput): ProcessMutationOutcome {
    if (this.factWriter && !isTransactionActive(this.db)) {
      return inTransaction(this.db, () => this.casTransferClaim(input));
    }
    assertNonEmptyString(input.workspaceId, 'workspaceId');
    assertProcessId(input.processId, 'processId');
    assertExpectedVersion(input.expectedVersion);
    assertFence(input);
    assertCanonicalTimestamp(input.timestamp, 'timestamp');
    if (typeof input.newClaimOwner !== 'string' || input.newClaimOwner.length === 0) {
      throw new RuntimeProcessValidationError(
        'RUNTIME_PROCESS_VALIDATION_FAILED: newClaimOwner is required',
      );
    }
    assertCanonicalTimestamp(input.newClaimLeaseExpiresAt, 'newClaimLeaseExpiresAt');

    const result = this.db.prepare(`
      UPDATE runtime_processes
      SET claim_epoch = claim_epoch + 1,
        claim_owner_id = ?,
        claim_lease_expires_at = ?,
        updated_at = ?,
        version = version + 1
      WHERE workspace_id = ? AND id = ?
        AND status = 'created'
        AND native_pid IS NULL AND native_started_at IS NULL
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
      input.processId,
      input.timestamp,
      input.expectedVersion,
      input.expectedClaimEpoch,
      input.expectedClaimOwner,
    ) as { changes: number };

    if (result.changes === 1) {
      const process = this.findById(input.workspaceId, input.processId)!;
      const eventId = this.#appendProcessFact('process.claim_transferred', process, input.timestamp, {
        claimEpoch: process.claimEpoch,
        authorityRole: process.authorityRole ?? 'primary-provider',
        ownerChanged: true,
      }, input.eventContext);
      return { kind: 'applied', process, ...(eventId === undefined ? {} : { eventId }) };
    }
    return this.#classifyProcessMutationFailure(
      input.workspaceId,
      input.processId,
      input.expectedVersion,
      input.expectedClaimEpoch,
      input.expectedClaimOwner,
      (process) => {
        if (TERMINAL_PROCESS_STATES.includes(process.status as TerminalProcessState)) {
          return 'terminal';
        }
        if (process.status !== 'created') return 'state-mismatch';
        return null; // identity present / lease not expired / epoch / owner mismatch
      },
      { expectedFrom: 'created' },
    );
  }

  #insertProcess(input: CreateProcessInput): CreateProcessResult {
    const workspaceId = assertNonEmptyString(input.workspaceId, 'workspaceId');
    const taskId = assertNonEmptyString(input.taskId, 'taskId');
    const runId = assertNonEmptyString(input.runId, 'runId');
    const processType = assertNonEmptyString(input.processType, 'processType') as ProcessType;
    if (!PROCESS_TYPES.includes(processType)) {
      throw new RuntimeProcessValidationError(
        'RUNTIME_PROCESS_VALIDATION_FAILED: processType is not in the frozen vocabulary',
      );
    }
    const platform = assertNonEmptyString(input.platform, 'platform');
    if (new TextEncoder().encode(platform).length > PROCESS_PLATFORM_MAX_BYTES) {
      throw new RuntimeProcessValidationError(
        `RUNTIME_PROCESS_VALIDATION_FAILED: platform exceeds ${PROCESS_PLATFORM_MAX_BYTES} bytes`,
      );
    }
    const executableResolved = assertNonEmptyString(input.executableResolved, 'executableResolved');
    const cwdResolved = assertNonEmptyString(input.cwdResolved, 'cwdResolved');
    const securityProfileRef = assertNonEmptyString(input.securityProfileRef, 'securityProfileRef');
    if (input.shell !== 0 && input.shell !== 1) {
      throw new RuntimeProcessValidationError(
        'RUNTIME_PROCESS_VALIDATION_FAILED: shell must be 0 or 1',
      );
    }
    if (input.detached !== 0 && input.detached !== 1) {
      throw new RuntimeProcessValidationError(
        'RUNTIME_PROCESS_VALIDATION_FAILED: detached must be 0 or 1',
      );
    }
    if (!PROCESS_STDIN_MODES.includes(input.stdinMode)) {
      throw new RuntimeProcessValidationError(
        'RUNTIME_PROCESS_VALIDATION_FAILED: stdinMode must be closed or pipe',
      );
    }
    if (!PROCESS_CAPTURE_MODES.includes(input.stdoutMode)) {
      throw new RuntimeProcessValidationError(
        'RUNTIME_PROCESS_VALIDATION_FAILED: stdoutMode must be capture or null',
      );
    }
    if (!PROCESS_CAPTURE_MODES.includes(input.stderrMode)) {
      throw new RuntimeProcessValidationError(
        'RUNTIME_PROCESS_VALIDATION_FAILED: stderrMode must be capture or null',
      );
    }
    const argsRedactedJson = canonicalBoundedJson(
      input.argsRedacted,
      'argsRedacted',
      PROCESS_ARGS_REDACTED_JSON_MAX_BYTES,
    );
    const timeoutPolicyJson = canonicalBoundedJson(
      input.timeoutPolicy,
      'timeoutPolicy',
      PROCESS_TIMEOUT_POLICY_JSON_MAX_BYTES,
    );

    const stageId = input.stageId === undefined ? null : input.stageId;
    const stageAttempt = input.stageAttempt === undefined ? null : input.stageAttempt;
    const providerSessionId = input.providerSessionId === undefined ? null : input.providerSessionId;
    const parentProcessId = input.parentProcessId === undefined ? null : input.parentProcessId;
    const authorityRole = input.authorityRole === undefined ? null : input.authorityRole;
    if (parentProcessId !== null && authorityRole !== null) {
      throw new RuntimeProcessValidationError(
        'RUNTIME_PROCESS_VALIDATION_FAILED: a child Process cannot carry an authorityRole root claim',
      );
    }
    if (authorityRole !== null) {
      if (providerSessionId === null || stageId === null || stageAttempt === null || parentProcessId !== null) {
        throw new RuntimeProcessValidationError(
          'RUNTIME_PROCESS_VALIDATION_FAILED: a root Process requires session binding and no parent',
        );
      }
    }
    if (providerSessionId !== null && (stageId === null || stageAttempt === null)) {
      throw new RuntimeProcessValidationError(
        'RUNTIME_PROCESS_VALIDATION_FAILED: a session-linked Process requires stage_id and stage_attempt',
      );
    }
    if (parentProcessId !== null && (providerSessionId !== null || stageId !== null || stageAttempt !== null)) {
      throw new RuntimeProcessValidationError(
        'RUNTIME_PROCESS_VALIDATION_FAILED: a child Process must not carry session/stage binding',
      );
    }
    if (stageId === null && stageAttempt !== null) {
      throw new RuntimeProcessValidationError(
        'RUNTIME_PROCESS_VALIDATION_FAILED: stage_attempt requires stage_id',
      );
    }
    if (stageId !== null && stageAttempt === null) {
      throw new RuntimeProcessValidationError(
        'RUNTIME_PROCESS_VALIDATION_FAILED: stage_id requires stage_attempt',
      );
    }

    const claimEpoch = input.claimEpoch === undefined ? 1 : input.claimEpoch;
    if (!Number.isSafeInteger(claimEpoch) || claimEpoch < 1) {
      throw new RuntimeProcessValidationError(
        'RUNTIME_PROCESS_VALIDATION_FAILED: claimEpoch must be a positive safe integer',
      );
    }
    const claimOwnerId = input.claimOwnerId === undefined ? null : input.claimOwnerId;
    const claimLeaseExpiresAt =
      input.claimLeaseExpiresAt === undefined ? null : input.claimLeaseExpiresAt;
    if ((claimOwnerId === null) !== (claimLeaseExpiresAt === null)) {
      throw new RuntimeProcessValidationError(
        'RUNTIME_PROCESS_VALIDATION_FAILED: claimOwnerId and claimLeaseExpiresAt must be set together',
      );
    }
    if (claimLeaseExpiresAt !== null) {
      assertCanonicalTimestamp(claimLeaseExpiresAt, 'claimLeaseExpiresAt');
    }
    const createdAt = input.createdAt ?? new Date().toISOString();
    assertCanonicalTimestamp(createdAt, 'createdAt');

    const id = createEntityId('process');
    if (parentProcessId !== null) {
      this.#assertParentChainAcyclic(workspaceId, runId, parentProcessId, id);
    }
    const existing = authorityRole === null
      ? undefined
      : this.findByRootClaim(workspaceId, runId, stageId!, stageAttempt!, authorityRole);
    if (existing !== undefined) return { kind: 'joined', process: existing };

    const run = this.db.prepare(`
      INSERT INTO runtime_processes (
        id, workspace_id, task_id, run_id, stage_id, stage_attempt,
        provider_session_id, parent_process_id, authority_role, claim_epoch,
        claim_owner_id, claim_lease_expires_at, process_type, platform, status,
        executable_resolved, executable_fingerprint, args_redacted_json,
        cwd_resolved, shell, detached, stdin_mode, stdout_mode, stderr_mode,
        timeout_policy_json, security_profile_ref, native_pid, native_parent_pid,
        native_started_at, process_group_id, tree_ownership_mode, platform_handle_id,
        recovery_token_hash, recovery_classification, recovery_evidence_json,
        recovery_checked_at, recovery_classifier_version, started_at, ready_at,
        last_activity_at, stopping_at, exited_at, exit_code, exit_signal,
        termination_reason, cleanup_result, survivor_pids_redacted_json,
        error_code, error_detail_redacted, version, created_at, updated_at, archived_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1, ?, ?, NULL)
    `).run(
      id,
      workspaceId,
      taskId,
      runId,
      stageId,
      stageAttempt,
      providerSessionId,
      parentProcessId,
      authorityRole,
      claimEpoch,
      claimOwnerId,
      claimLeaseExpiresAt,
      processType,
      platform,
      executableResolved,
      input.executableFingerprint === undefined ? null : input.executableFingerprint,
      argsRedactedJson,
      cwdResolved,
      input.shell,
      input.detached,
      input.stdinMode,
      input.stdoutMode,
      input.stderrMode,
      timeoutPolicyJson,
      securityProfileRef,
      createdAt,
      createdAt,
    ) as { changes: number };

    if (run.changes !== 1) {
      // A concurrent winner committed the same root claim first.
      const joined = authorityRole === null
        ? undefined
        : this.findByRootClaim(workspaceId, runId, stageId!, stageAttempt!, authorityRole);
      if (joined !== undefined) return { kind: 'joined', process: joined };
      throw new RuntimeProcessValidationError(
        'RUNTIME_PROCESS_VALIDATION_FAILED: process reservation insert failed',
      );
    }

    const process = this.findById(workspaceId, id);
    if (process === undefined) {
      throw new RuntimeProcessValidationError(
        'RUNTIME_PROCESS_VALIDATION_FAILED: inserted process not found',
      );
    }
    const eventId = this.#appendProcessFact('process.launch_requested', process, process.createdAt, {
      processType: process.processType,
      executable: this.#safeProjection('executable', process.executableResolved),
      argsRedacted: this.#redactedArgs(process.argsRedactedJson),
      cwd: this.#safeProjection('cwd', process.cwdResolved),
      shell: process.shell === 1,
      timeoutPolicyDigest: this.#sha256(process.timeoutPolicyJson),
      claimEpoch: process.claimEpoch,
      ...(process.authorityRole === null ? {} : { authorityRole: process.authorityRole }),
    }, input.eventContext);
    return { kind: 'created', process, ...(eventId === undefined ? {} : { eventId }) };
  }

  #appendProcessFact(
    type: string,
    process: RuntimeProcess,
    timestamp: string,
    payload: Record<string, unknown>,
    eventContext?: RuntimeEventContext,
  ): string | undefined {
    if (this.factWriter === undefined) return undefined;
    if (eventContext === undefined) {
      throw new RuntimeProcessValidationError(
        'RUNTIME_PROCESS_VALIDATION_FAILED: eventContext is required for durable process facts',
      );
    }
    const result = this.factWriter.appendWithinTransaction({
      type,
      workspaceId: process.workspaceId,
      taskId: process.taskId,
      runId: process.runId,
      ...(process.stageId === null ? {} : { stageId: process.stageId }),
      ...(process.providerSessionId === null ? {} : { providerSessionId: process.providerSessionId }),
      processId: process.id,
      timestamp,
      eventContext,
      payload,
    });
    return result.event.id;
  }

  #appendTransitionFact(input: ProcessStatusTransitionInput, process: RuntimeProcess): string | undefined {
    if (this.factWriter === undefined) return undefined;
    if (input.to === 'stopping') {
      return this.#appendProcessFact('process.stopping', process, input.timestamp, {
        reason: process.terminationReason ?? 'stop-requested',
        nativeIdentityPending: process.nativePid === null,
        stoppingAt: process.stoppingAt ?? input.timestamp,
        gracefulRequested: this.#requiredBoolean(input.gracefulRequested, 'gracefulRequested'),
        graceDeadline: this.#requiredTimestamp(input.graceDeadline, 'graceDeadline'),
        forceDeadline: this.#requiredTimestamp(input.forceDeadline, 'forceDeadline'),
        idempotencyKeyHash: this.#requiredDigest(input.idempotencyKeyHash, 'idempotencyKeyHash'),
        ...(process.cleanupResult === null ? {} : { cleanupResult: process.cleanupResult }),
      }, input.eventContext);
    }
    if (input.to === 'exited') {
      const exitedAt = process.exitedAt ?? input.timestamp;
      const durationMs = input.durationMs ?? this.#derivedDurationMs(process.startedAt, exitedAt);
      if (input.graceful === undefined || input.force === undefined) {
        throw new RuntimeProcessValidationError(
          'RUNTIME_PROCESS_VALIDATION_FAILED: graceful and force evidence are required for process.exited',
        );
      }
      return this.#appendProcessFact('process.exited', process, input.timestamp, {
        exitCode: process.exitCode,
        exitSignal: process.exitSignal,
        terminationReason: process.terminationReason,
        cleanupResult: process.cleanupResult,
        exitedAt,
        durationMs: this.#requiredDuration(durationMs),
        graceful: input.graceful,
        force: input.force,
        outputReferenceIds: this.#outputReferenceIds(process),
      }, input.eventContext);
    }
    if (input.to === 'failed') {
      if (input.failureOutcome === undefined) {
        throw new RuntimeProcessValidationError(
          'RUNTIME_PROCESS_VALIDATION_FAILED: failureOutcome is required for process.failed',
        );
      }
      if (input.failureOutcome === 'spawn-failure'
        && input.spawnFailureEvidence !== 'PROCESS_SPAWN_FAILED') {
        throw new RuntimeProcessValidationError(
          'RUNTIME_PROCESS_VALIDATION_FAILED: spawn failure requires PROCESS_SPAWN_FAILED evidence',
        );
      }
      if (input.failureOutcome === 'spawn-failure-after-cancel'
        && (input.cancelReason === undefined
          || input.cancelCausationId === undefined
          || input.spawnFailureEvidence !== 'PROCESS_SPAWN_FAILED')) {
        throw new RuntimeProcessValidationError(
          'RUNTIME_PROCESS_VALIDATION_FAILED: after-cancel failure requires cancel reason/causation and spawn evidence',
        );
      }
      return this.#appendProcessFact('process.failed', process, input.timestamp, {
        errorCode: process.errorCode ?? 'PROCESS_UNKNOWN_ERROR',
        failedAt: process.exitedAt ?? input.timestamp,
        outcome: input.failureOutcome,
        ...(process.cleanupResult === null ? {} : { cleanupResult: process.cleanupResult }),
        ...(input.cancelReason === undefined ? {} : { cancelReason: input.cancelReason }),
        ...(input.cancelCausationId === undefined ? {} : { cancelCausationId: input.cancelCausationId }),
        ...(input.spawnFailureEvidence === undefined ? {} : { spawnFailureEvidence: input.spawnFailureEvidence }),
      }, input.eventContext);
    }
    if (input.to === 'orphaned') {
      const classification = process.recoveryClassification === 'mismatch'
        ? 'mismatch'
        : process.cleanupResult === 'SURVIVORS' ? 'survivors' : 'unknown';
      return this.#appendProcessFact('process.orphaned', process, input.timestamp, {
        classification,
        cleanupRequired: true,
        reason: process.errorCode ?? process.cleanupResult ?? 'process-control-uncertain',
      }, input.eventContext);
    }
    if (input.to === 'unknown') {
      return this.#appendProcessFact('process.cleanup_required', process, input.timestamp, {
        cleanupResult: process.cleanupResult ?? 'UNKNOWN_PLATFORM_UNAVAILABLE',
        survivorCount: this.#survivorCount(process.survivorPidsRedactedJson),
        reason: process.errorCode ?? 'process-control-uncertain',
        checkedAt: process.recoveryCheckedAt ?? input.timestamp,
      }, input.eventContext);
    }
    return this.#appendProcessFact('process.state_changed', process, input.timestamp, {
      from: input.expectedFrom,
      to: input.to,
      updatedAt: input.timestamp,
      ...(process.cleanupResult === null ? {} : { cleanupResult: process.cleanupResult }),
    }, input.eventContext);
  }

  #redactedArgs(json: string): string[] {
    try {
      const parsed = JSON.parse(json) as unknown;
      if (!Array.isArray(parsed)) return ['<redacted>'];
      return parsed.slice(0, 64).map(value => {
        if (typeof value !== 'string' || value === '<redacted>' || value === '[REDACTED]') {
          return '<redacted>';
        }
        return this.#safeProjection('arg', value);
      });
    } catch {
      return ['<redacted>'];
    }
  }

  #sha256(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }

  #safeProjection(kind: string, value: string): string {
    return `${kind}:sha256:${this.#sha256(value).slice(0, 32)}`;
  }

  #requiredBoolean(value: boolean | undefined, field: string): boolean {
    if (typeof value !== 'boolean') {
      throw new RuntimeProcessValidationError(
        `RUNTIME_PROCESS_VALIDATION_FAILED: ${field} is required for process.stopping`,
      );
    }
    return value;
  }

  #requiredTimestamp(value: string | undefined, field: string): string {
    if (value === undefined || !isCanonicalUtcTimestamp(value)) {
      throw new RuntimeProcessValidationError(
        `RUNTIME_PROCESS_VALIDATION_FAILED: ${field} is required and must be canonical`,
      );
    }
    return value;
  }

  #requiredDigest(value: string | undefined, field: string): string {
    if (value === undefined || !/^[0-9a-f]{64}$/u.test(value)) {
      throw new RuntimeProcessValidationError(
        `RUNTIME_PROCESS_VALIDATION_FAILED: ${field} must be a 64-character lowercase digest`,
      );
    }
    return value;
  }

  #requiredDuration(value: number): number {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RuntimeProcessValidationError(
        'RUNTIME_PROCESS_VALIDATION_FAILED: durationMs must be a non-negative safe integer',
      );
    }
    return value;
  }

  #derivedDurationMs(startedAt: string | null, exitedAt: string): number {
    if (startedAt === null) {
      throw new RuntimeProcessValidationError(
        'RUNTIME_PROCESS_VALIDATION_FAILED: process.exited requires native startedAt evidence',
      );
    }
    const duration = Date.parse(exitedAt) - Date.parse(startedAt);
    return this.#requiredDuration(duration);
  }

  #outputReferenceIds(process: RuntimeProcess): string[] {
    const rows = this.db.prepare(`
      SELECT artifact_id FROM process_output_references
      WHERE workspace_id = ? AND process_id = ?
      ORDER BY stream ASC
    `).all(process.workspaceId, process.id) as Array<{ artifact_id: string }>;
    return rows.map(row => row.artifact_id);
  }

  #survivorCount(json: string | null): number {
    if (json === null) return 0;
    try {
      const parsed = JSON.parse(json) as unknown;
      return Array.isArray(parsed) ? parsed.length : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Fail closed on self-parent, missing parent and parent cycles. Runs inside
   * the same transaction as the INSERT when the caller is not already inside
   * one, so the read + insert pair stays atomic.
   */
  #assertParentChainAcyclic(
    workspaceId: string,
    runId: string,
    parentProcessId: string,
    newProcessId: string,
  ): void {
    if (parentProcessId === newProcessId) {
      throw new RuntimeProcessValidationError(
        'RUNTIME_PROCESS_VALIDATION_FAILED: a process cannot be its own parent',
      );
    }
    const seen = new Set<string>([newProcessId]);
    let current: string | null = parentProcessId;
    while (current !== null) {
      if (seen.has(current)) {
        throw new RuntimeProcessValidationError(
          'RUNTIME_PROCESS_VALIDATION_FAILED: parent cycle detected',
        );
      }
      seen.add(current);
      const row = this.db.prepare(`
        SELECT id, parent_process_id FROM runtime_processes
        WHERE workspace_id = ? AND run_id = ? AND id = ?
      `).get(workspaceId, runId, current) as
        { id: string; parent_process_id: string | null } | undefined;
      if (row === undefined) {
        throw new RuntimeProcessValidationError(
          'RUNTIME_PROCESS_VALIDATION_FAILED: parent process not found',
        );
      }
      current = row.parent_process_id;
    }
  }

  #classifyProcessMutationFailure(
    workspaceId: string,
    processId: string,
    expectedVersion: number,
    expectedClaimEpoch: number,
    expectedClaimOwner: string | null,
    extra: (process: RuntimeProcess) => ProcessMutationOutcome['kind'] | null,
    options: { expectedFrom?: ProcessState } = {},
  ): ProcessMutationOutcome {
    const row = this.db.prepare(`
      SELECT id FROM runtime_processes WHERE id = ?
    `).get(processId) as { id: string } | undefined;
    if (row === undefined) return { kind: 'not-found' };
    const process = this.findById(workspaceId, processId);
    if (process === undefined) return { kind: 'workspace-mismatch' };
    const specific = extra(process);
    if (specific !== null) {
      return { kind: specific, process };
    }
    if (process.version !== expectedVersion) {
      return { kind: 'version-conflict', process };
    }
    if (
      process.claimEpoch !== expectedClaimEpoch
      || process.claimOwnerId !== expectedClaimOwner
    ) {
      return { kind: 'fence-conflict', process };
    }
    if (options.expectedFrom !== undefined && process.status === options.expectedFrom) {
      return { kind: 'fence-conflict', process };
    }
    return { kind: 'state-mismatch', process };
  }
}
