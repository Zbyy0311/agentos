import { isCanonicalUtcTimestamp } from './CanonicalTimestamp.js';
import { createEntityId, isValidEntityId } from './Identity.js';
import { inTransaction, isTransactionActive, type TransactionDatabase } from './Transaction.js';
import type { DurableRuntimeFactWriter } from './RuntimeEventRepository.js';

/**
 * M4-P2B durable per-stream output reference repository (Migration 014
 * `process_output_references`). Raw stdout/stderr bytes NEVER enter the
 * relational database: the row carries only canonical artifact identity
 * (`artifact_`), an opaque managed-sink key, bounded monotonic counters
 * (source_bytes_seen / retained_bytes / next_source_offset / segment_count)
 * and a lowercase sha256 over the retained-byte concatenation.
 *
 * Checkpoint is an expected-version CAS; counters are monotonic (DB trigger
 * plus repository guards); duplicate checkpoints at the same offsets are
 * idempotent and return the stored fact; finalized rows reject further
 * append and duplicate finalize returns the stored sha256.
 */

export const OUTPUT_STREAM_NAMES = ['stdout', 'stderr'] as const;
export type OutputStreamName = (typeof OUTPUT_STREAM_NAMES)[number];

export const OUTPUT_REDACTION_MODES = ['scan', 'strict'] as const;
export type OutputRedactionMode = (typeof OUTPUT_REDACTION_MODES)[number];

export const OUTPUT_ACCESS_CLASSIFICATION = 'restricted' as const;

/** Frozen event/error contract retained technical cap (64 MiB per stream). */
export const OUTPUT_RETAINED_CAP_BYTES = 64 * 1024 * 1024;
/** Opaque managed-sink key bound; never a client path. */
export const OUTPUT_STORAGE_KEY_MAX_BYTES = 512;
export const OUTPUT_CONTENT_TYPE_MAX_BYTES = 128;
export const OUTPUT_ENCODING_MAX_BYTES = 64;
export const OUTPUT_TRUNCATION_REASON_MAX_BYTES = 256;

interface OutputReferenceRow {
  process_id: string;
  stream: string;
  workspace_id: string;
  run_id: string;
  artifact_id: string;
  storage_key: string;
  content_type: string;
  encoding: string;
  access_classification: string;
  redaction_mode: string;
  source_bytes_seen: number;
  retained_bytes: number;
  next_source_offset: number;
  segment_count: number;
  truncated: number;
  truncation_reason: string | null;
  finalized: number;
  sha256: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  finalized_at: string | null;
  archived_at: string | null;
}

export interface ProcessOutputReference {
  readonly processId: string;
  readonly stream: OutputStreamName;
  readonly workspaceId: string;
  readonly runId: string;
  readonly artifactId: string;
  /** Opaque managed-sink key; restricted, never a client path. */
  readonly storageKey: string;
  readonly contentType: string;
  readonly encoding: string;
  readonly accessClassification: typeof OUTPUT_ACCESS_CLASSIFICATION;
  readonly redactionMode: OutputRedactionMode;
  readonly sourceBytesSeen: number;
  readonly retainedBytes: number;
  readonly nextSourceOffset: number;
  readonly segmentCount: number;
  readonly truncated: boolean;
  readonly truncationReason: string | null;
  readonly finalized: boolean;
  readonly sha256: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly finalizedAt: string | null;
  readonly archivedAt: string | null;
}

export interface CreateOutputReferenceInput {
  readonly workspaceId: string;
  readonly runId: string;
  readonly processId: string;
  readonly stream: OutputStreamName;
  readonly artifactId?: string;
  readonly storageKey: string;
  readonly contentType: string;
  readonly encoding: string;
  readonly redactionMode: OutputRedactionMode;
  readonly sourceBytesSeen?: number;
  readonly retainedBytes?: number;
  readonly nextSourceOffset?: number;
  readonly segmentCount?: number;
  readonly truncated?: boolean;
  readonly truncationReason?: string | null;
  readonly createdAt?: string;
}

export type CreateOutputReferenceResult =
  | { readonly kind: 'created'; readonly reference: ProcessOutputReference }
  | { readonly kind: 'joined'; readonly reference: ProcessOutputReference };

export type OutputReferenceMutationOutcome =
  | { readonly kind: 'applied'; readonly reference: ProcessOutputReference }
  | { readonly kind: 'duplicate'; readonly reference: ProcessOutputReference }
  | { readonly kind: 'finalized'; readonly reference: ProcessOutputReference }
  | { readonly kind: 'non-monotonic'; readonly reference: ProcessOutputReference }
  | { readonly kind: 'version-conflict'; readonly reference: ProcessOutputReference }
  | { readonly kind: 'workspace-mismatch' }
  | { readonly kind: 'not-found' };

export interface OutputReferenceCheckpointInput {
  readonly workspaceId: string;
  readonly processId: string;
  readonly stream: OutputStreamName;
  readonly expectedVersion: number;
  readonly sourceBytesSeen: number;
  readonly retainedBytes: number;
  readonly nextSourceOffset: number;
  readonly segmentCount: number;
  readonly truncated: boolean;
  readonly truncationReason?: string | null;
  readonly updatedAt?: string;
}

export interface FinalizeOutputReferenceInput {
  readonly workspaceId: string;
  readonly processId: string;
  readonly stream: OutputStreamName;
  readonly expectedVersion: number;
  /** Lowercase 64-char hex SHA-256 of the retained-byte concatenation. */
  readonly sha256: string;
  readonly finalizedAt?: string;
}

function integrityFailure(reason: string): OutputReferenceIntegrityError {
  return new OutputReferenceIntegrityError(
    `PROCESS_OUTPUT_REFERENCE_INTEGRITY_FAILED: ${reason}`,
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

function assertOptionalTimestamp(value: unknown, field: string): void {
  if (value !== null && !isCanonicalUtcTimestamp(value)) {
    throw integrityFailure(`${field} is invalid`);
  }
}

function validateReferenceRow(row: unknown): asserts row is OutputReferenceRow {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) {
    throw integrityFailure('row is invalid');
  }
  const value = row as Record<string, unknown>;
  assertNonEmptyString(value.process_id, 'process_id');
  if (!isValidEntityId(value.process_id as string, 'process')) {
    throw integrityFailure('process_id is not a canonical proc_ identity');
  }
  if (!OUTPUT_STREAM_NAMES.includes(value.stream as OutputStreamName)) {
    throw integrityFailure('stream is invalid');
  }
  assertNonEmptyString(value.workspace_id, 'workspace_id');
  assertNonEmptyString(value.run_id, 'run_id');
  assertNonEmptyString(value.artifact_id, 'artifact_id');
  if (!isValidEntityId(value.artifact_id as string, 'artifact')) {
    throw integrityFailure('artifact_id is not a canonical artifact_ identity');
  }
  assertNonEmptyString(value.storage_key, 'storage_key');
  assertNonEmptyString(value.content_type, 'content_type');
  assertNonEmptyString(value.encoding, 'encoding');
  if (value.access_classification !== OUTPUT_ACCESS_CLASSIFICATION) {
    throw integrityFailure('access_classification is invalid');
  }
  if (!OUTPUT_REDACTION_MODES.includes(value.redaction_mode as OutputRedactionMode)) {
    throw integrityFailure('redaction_mode is invalid');
  }
  for (const field of ['source_bytes_seen', 'retained_bytes', 'next_source_offset', 'segment_count']) {
    if (typeof value[field] !== 'number' || !Number.isInteger(value[field]) || (value[field] as number) < 0) {
      throw integrityFailure(`${field} is invalid`);
    }
  }
  if ((value.retained_bytes as number) > OUTPUT_RETAINED_CAP_BYTES) {
    throw integrityFailure('retained_bytes exceeds the frozen retained cap');
  }
  if ((value.retained_bytes as number) > (value.source_bytes_seen as number)) {
    throw integrityFailure('retained_bytes exceeds source_bytes_seen');
  }
  if ((value.next_source_offset as number) > (value.source_bytes_seen as number)) {
    throw integrityFailure('next_source_offset exceeds source_bytes_seen');
  }
  if (value.truncated !== 0 && value.truncated !== 1) throw integrityFailure('truncated is invalid');
  if (value.truncated === 1 && (typeof value.truncation_reason !== 'string' || value.truncation_reason.length === 0)) {
    throw integrityFailure('truncated requires truncation_reason');
  }
  if (value.truncated === 0 && value.truncation_reason !== null) {
    throw integrityFailure('truncation_reason requires truncated');
  }
  if (value.finalized !== 0 && value.finalized !== 1) throw integrityFailure('finalized is invalid');
  if (value.sha256 !== null && (typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256))) {
    throw integrityFailure('sha256 is invalid');
  }
  if (typeof value.version !== 'number' || !Number.isInteger(value.version) || value.version < 1) {
    throw integrityFailure('version is invalid');
  }
  if (!isCanonicalUtcTimestamp(value.created_at)) throw integrityFailure('created_at is invalid');
  if (!isCanonicalUtcTimestamp(value.updated_at)) throw integrityFailure('updated_at is invalid');
  assertOptionalTimestamp(value.finalized_at, 'finalized_at');
  assertOptionalTimestamp(value.archived_at, 'archived_at');
  if (value.finalized === 1 && (value.finalized_at === null || value.sha256 === null)) {
    throw integrityFailure('finalized reference requires finalized_at and sha256');
  }
  if (value.finalized === 0 && value.finalized_at !== null) {
    throw integrityFailure('finalized_at requires finalized');
  }
}

function mapReference(row: OutputReferenceRow): ProcessOutputReference {
  validateReferenceRow(row);
  return {
    processId: row.process_id,
    stream: row.stream as OutputStreamName,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    artifactId: row.artifact_id,
    storageKey: row.storage_key,
    contentType: row.content_type,
    encoding: row.encoding,
    accessClassification: row.access_classification as typeof OUTPUT_ACCESS_CLASSIFICATION,
    redactionMode: row.redaction_mode as OutputRedactionMode,
    sourceBytesSeen: row.source_bytes_seen,
    retainedBytes: row.retained_bytes,
    nextSourceOffset: row.next_source_offset,
    segmentCount: row.segment_count,
    truncated: row.truncated === 1,
    truncationReason: row.truncation_reason,
    finalized: row.finalized === 1,
    sha256: row.sha256,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finalizedAt: row.finalized_at,
    archivedAt: row.archived_at,
  };
}

export class OutputReferenceValidationError extends Error {
  readonly code = 'PROCESS_OUTPUT_REFERENCE_VALIDATION_FAILED' as const;

  constructor(message = 'PROCESS_OUTPUT_REFERENCE_VALIDATION_FAILED') {
    super(message);
    this.name = 'OutputReferenceValidationError';
  }
}

export class OutputReferenceIntegrityError extends Error {
  readonly code = 'PROCESS_OUTPUT_REFERENCE_INTEGRITY_FAILED' as const;

  constructor(message = 'PROCESS_OUTPUT_REFERENCE_INTEGRITY_FAILED') {
    super(message);
    this.name = 'OutputReferenceIntegrityError';
  }
}

function assertCanonicalTimestamp(value: string, field: string): void {
  if (!isCanonicalUtcTimestamp(value)) {
    throw new OutputReferenceValidationError(
      `PROCESS_OUTPUT_REFERENCE_VALIDATION_FAILED: ${field} must be canonical UTC ISO 8601 milliseconds`,
    );
  }
}

function assertBoundedString(value: string, field: string, maxBytes: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new OutputReferenceValidationError(
      `PROCESS_OUTPUT_REFERENCE_VALIDATION_FAILED: ${field} must be a non-empty string`,
    );
  }
  const byteLength = new TextEncoder().encode(value).length;
  if (byteLength > maxBytes) {
    throw new OutputReferenceValidationError(
      `PROCESS_OUTPUT_REFERENCE_VALIDATION_FAILED: ${field} exceeds ${maxBytes} bytes`,
    );
  }
  return value;
}

function assertCount(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new OutputReferenceValidationError(
      `PROCESS_OUTPUT_REFERENCE_VALIDATION_FAILED: ${field} must be a non-negative safe integer`,
    );
  }
  return value;
}

function assertExpectedVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new OutputReferenceValidationError(
      'PROCESS_OUTPUT_REFERENCE_VALIDATION_FAILED: expectedVersion must be a positive safe integer',
    );
  }
}

function assertTruncationReason(
  truncated: boolean,
  truncationReason: string | null | undefined,
): string | null {
  if (!truncated) {
    if (truncationReason !== undefined && truncationReason !== null) {
      throw new OutputReferenceValidationError(
        'PROCESS_OUTPUT_REFERENCE_VALIDATION_FAILED: truncationReason requires truncated',
      );
    }
    return null;
  }
  return assertBoundedString(
    truncationReason ?? '',
    'truncationReason',
    OUTPUT_TRUNCATION_REASON_MAX_BYTES,
  );
}

function assertSha256(value: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new OutputReferenceValidationError(
      'PROCESS_OUTPUT_REFERENCE_VALIDATION_FAILED: sha256 must be 64 lowercase hex characters',
    );
  }
  return value;
}

export class ProcessOutputReferenceRepository {
  constructor(
    private readonly db: TransactionDatabase,
    private readonly factWriter?: DurableRuntimeFactWriter,
  ) {}

  /**
   * Create the per-stream reference with zero counts and no raw bytes. A
   * duplicate (process_id, stream) key joins the existing reference.
   */
  createReference(input: CreateOutputReferenceInput): CreateOutputReferenceResult {
    if (this.factWriter && !isTransactionActive(this.db)) {
      return inTransaction(this.db, () => this.createReference(input));
    }
    const workspaceId = assertNonEmptyString(input.workspaceId, 'workspaceId');
    const runId = assertNonEmptyString(input.runId, 'runId');
    const processId = assertNonEmptyString(input.processId, 'processId');
    if (!isValidEntityId(processId, 'process')) {
      throw new OutputReferenceValidationError(
        'PROCESS_OUTPUT_REFERENCE_VALIDATION_FAILED: processId is not a canonical proc_ identity',
      );
    }
    if (!OUTPUT_STREAM_NAMES.includes(input.stream)) {
      throw new OutputReferenceValidationError(
        'PROCESS_OUTPUT_REFERENCE_VALIDATION_FAILED: stream must be stdout or stderr',
      );
    }
    const storageKey = assertBoundedString(
      input.storageKey,
      'storageKey',
      OUTPUT_STORAGE_KEY_MAX_BYTES,
    );
    if (storageKey.includes('\u0000')) {
      throw new OutputReferenceValidationError(
        'PROCESS_OUTPUT_REFERENCE_VALIDATION_FAILED: storageKey must not contain NUL',
      );
    }
    const contentType = assertBoundedString(
      input.contentType,
      'contentType',
      OUTPUT_CONTENT_TYPE_MAX_BYTES,
    );
    const encoding = assertBoundedString(input.encoding, 'encoding', OUTPUT_ENCODING_MAX_BYTES);
    if (!OUTPUT_REDACTION_MODES.includes(input.redactionMode)) {
      throw new OutputReferenceValidationError(
        'PROCESS_OUTPUT_REFERENCE_VALIDATION_FAILED: redactionMode must be scan or strict',
      );
    }
    const sourceBytesSeen = assertCount(input.sourceBytesSeen ?? 0, 'sourceBytesSeen');
    const retainedBytes = assertCount(input.retainedBytes ?? 0, 'retainedBytes');
    const nextSourceOffset = assertCount(input.nextSourceOffset ?? 0, 'nextSourceOffset');
    const segmentCount = assertCount(input.segmentCount ?? 0, 'segmentCount');
    if (retainedBytes > OUTPUT_RETAINED_CAP_BYTES) {
      throw new OutputReferenceValidationError(
        `PROCESS_OUTPUT_REFERENCE_VALIDATION_FAILED: retainedBytes exceeds the frozen ${OUTPUT_RETAINED_CAP_BYTES}-byte retained cap`,
      );
    }
    if (retainedBytes > sourceBytesSeen) {
      throw new OutputReferenceValidationError(
        'PROCESS_OUTPUT_REFERENCE_VALIDATION_FAILED: retainedBytes must not exceed sourceBytesSeen',
      );
    }
    if (nextSourceOffset > sourceBytesSeen) {
      throw new OutputReferenceValidationError(
        'PROCESS_OUTPUT_REFERENCE_VALIDATION_FAILED: nextSourceOffset must not exceed sourceBytesSeen',
      );
    }
    const truncated = input.truncated === true;
    const truncationReason = assertTruncationReason(truncated, input.truncationReason);
    const artifactId = input.artifactId ?? createEntityId('artifact');
    if (!isValidEntityId(artifactId, 'artifact')) {
      throw new OutputReferenceValidationError(
        'PROCESS_OUTPUT_REFERENCE_VALIDATION_FAILED: artifactId is not a canonical artifact_ identity',
      );
    }
    const createdAt = input.createdAt ?? new Date().toISOString();
    assertCanonicalTimestamp(createdAt, 'createdAt');

    const existing = this.findReference(workspaceId, processId, input.stream);
    if (existing !== undefined) return { kind: 'joined', reference: existing };

    const run = this.db.prepare(`
      INSERT INTO process_output_references (
        process_id, stream, workspace_id, run_id, artifact_id, storage_key,
        content_type, encoding, access_classification, redaction_mode,
        source_bytes_seen, retained_bytes, next_source_offset, segment_count,
        truncated, truncation_reason, finalized, sha256, version, created_at,
        updated_at, finalized_at, archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'restricted', ?, ?, ?, ?, ?, ?, ?, 0, NULL, 1, ?, ?, NULL, NULL)
    `).run(
      processId,
      input.stream,
      workspaceId,
      runId,
      artifactId,
      storageKey,
      contentType,
      encoding,
      input.redactionMode,
      sourceBytesSeen,
      retainedBytes,
      nextSourceOffset,
      segmentCount,
      truncated ? 1 : 0,
      truncationReason,
      createdAt,
      createdAt,
    ) as { changes: number };

    if (run.changes !== 1) {
      const joined = this.findReference(workspaceId, processId, input.stream);
      if (joined !== undefined) return { kind: 'joined', reference: joined };
      throw new OutputReferenceValidationError(
        'PROCESS_OUTPUT_REFERENCE_VALIDATION_FAILED: output reference insert failed',
      );
    }

    const reference = this.findReference(workspaceId, processId, input.stream);
    if (reference === undefined) {
      throw new OutputReferenceValidationError(
        'PROCESS_OUTPUT_REFERENCE_VALIDATION_FAILED: inserted output reference not found',
      );
    }
    this.#appendAdvance(reference, 0, reference.updatedAt, false);
    return { kind: 'created', reference };
  }

  findReference(
    workspaceId: string,
    processId: string,
    stream: OutputStreamName,
  ): ProcessOutputReference | undefined {
    const row = this.db.prepare(`
      SELECT * FROM process_output_references
      WHERE workspace_id = ? AND process_id = ? AND stream = ?
    `).get(workspaceId, processId, stream) as OutputReferenceRow | undefined;
    return row === undefined ? undefined : mapReference(row);
  }

  listByProcess(workspaceId: string, processId: string): ProcessOutputReference[] {
    const rows = this.db.prepare(`
      SELECT * FROM process_output_references
      WHERE workspace_id = ? AND process_id = ?
      ORDER BY stream ASC
    `).all(workspaceId, processId) as OutputReferenceRow[];
    return rows.map(mapReference);
  }

  /**
   * Monotonic checkpoint CAS. Duplicate checkpoints at the same offsets are
   * idempotent (the stored fact is returned, version untouched). A counter
   * regression, append after finalize, or stale version is classified —
   * never an implicit retry.
   */
  checkpoint(input: OutputReferenceCheckpointInput): OutputReferenceMutationOutcome {
    if (this.factWriter && !isTransactionActive(this.db)) {
      return inTransaction(this.db, () => this.checkpoint(input));
    }
    const workspaceId = assertNonEmptyString(input.workspaceId, 'workspaceId');
    const processId = assertNonEmptyString(input.processId, 'processId');
    if (!OUTPUT_STREAM_NAMES.includes(input.stream)) {
      throw new OutputReferenceValidationError(
        'PROCESS_OUTPUT_REFERENCE_VALIDATION_FAILED: stream must be stdout or stderr',
      );
    }
    assertExpectedVersion(input.expectedVersion);
    const sourceBytesSeen = assertCount(input.sourceBytesSeen, 'sourceBytesSeen');
    const retainedBytes = assertCount(input.retainedBytes, 'retainedBytes');
    const nextSourceOffset = assertCount(input.nextSourceOffset, 'nextSourceOffset');
    const segmentCount = assertCount(input.segmentCount, 'segmentCount');
    if (retainedBytes > OUTPUT_RETAINED_CAP_BYTES) {
      throw new OutputReferenceValidationError(
        `PROCESS_OUTPUT_REFERENCE_VALIDATION_FAILED: retainedBytes exceeds the frozen ${OUTPUT_RETAINED_CAP_BYTES}-byte retained cap`,
      );
    }
    if (retainedBytes > sourceBytesSeen) {
      throw new OutputReferenceValidationError(
        'PROCESS_OUTPUT_REFERENCE_VALIDATION_FAILED: retainedBytes must not exceed sourceBytesSeen',
      );
    }
    if (nextSourceOffset > sourceBytesSeen) {
      throw new OutputReferenceValidationError(
        'PROCESS_OUTPUT_REFERENCE_VALIDATION_FAILED: nextSourceOffset must not exceed sourceBytesSeen',
      );
    }
    const truncated = input.truncated === true;
    const truncationReason = assertTruncationReason(truncated, input.truncationReason);
    const updatedAt = input.updatedAt ?? new Date().toISOString();
    assertCanonicalTimestamp(updatedAt, 'updatedAt');

    const current = this.findReference(workspaceId, processId, input.stream);
    if (current === undefined) {
      const row = this.db.prepare(`
        SELECT process_id FROM process_output_references WHERE process_id = ? AND stream = ?
      `).get(processId, input.stream) as { process_id: string } | undefined;
      return row === undefined ? { kind: 'not-found' } : { kind: 'workspace-mismatch' };
    }
    if (current.finalized) return { kind: 'finalized', reference: current };
    const sameValues =
      current.sourceBytesSeen === sourceBytesSeen
      && current.retainedBytes === retainedBytes
      && current.nextSourceOffset === nextSourceOffset
      && current.segmentCount === segmentCount
      && current.truncated === truncated
      && current.truncationReason === truncationReason;
    if (sameValues) return { kind: 'duplicate', reference: current };
    if (current.version !== input.expectedVersion) {
      return { kind: 'version-conflict', reference: current };
    }

    const result = this.db.prepare(`
      UPDATE process_output_references
      SET source_bytes_seen = ?,
        retained_bytes = ?,
        next_source_offset = ?,
        segment_count = ?,
        truncated = ?,
        truncation_reason = ?,
        updated_at = ?,
        version = version + 1
      WHERE workspace_id = ? AND process_id = ? AND stream = ?
        AND finalized = 0 AND version = ?
        AND ? >= source_bytes_seen
        AND ? >= retained_bytes
        AND ? >= next_source_offset
        AND ? >= segment_count
        AND ? <= ?
        AND ? <= ?
    `).run(
      sourceBytesSeen,
      retainedBytes,
      nextSourceOffset,
      segmentCount,
      truncated ? 1 : 0,
      truncationReason,
      updatedAt,
      workspaceId,
      processId,
      input.stream,
      input.expectedVersion,
      sourceBytesSeen,
      retainedBytes,
      nextSourceOffset,
      segmentCount,
      retainedBytes,
      sourceBytesSeen,
      nextSourceOffset,
      sourceBytesSeen,
    ) as { changes: number };

    if (result.changes === 1) {
      const reference = this.findReference(workspaceId, processId, input.stream)!;
      this.#appendAdvance(reference, current.nextSourceOffset, input.updatedAt ?? reference.updatedAt, false);
      return {
        kind: 'applied',
        reference,
      };
    }
    const after = this.findReference(workspaceId, processId, input.stream)!;
    if (after.finalized) return { kind: 'finalized', reference: after };
    if (after.version !== input.expectedVersion) {
      return { kind: 'version-conflict', reference: after };
    }
    return { kind: 'non-monotonic', reference: after };
  }

  /**
   * Finalize the reference: sets finalized, finalized_at and the lowercase
   * sha256 over the retained bytes. A duplicate finalize returns the stored
   * fact; finalized rows reject further mutation (repository + trigger).
   */
  finalizeReference(input: FinalizeOutputReferenceInput): OutputReferenceMutationOutcome {
    if (this.factWriter && !isTransactionActive(this.db)) {
      return inTransaction(this.db, () => this.finalizeReference(input));
    }
    const workspaceId = assertNonEmptyString(input.workspaceId, 'workspaceId');
    const processId = assertNonEmptyString(input.processId, 'processId');
    if (!OUTPUT_STREAM_NAMES.includes(input.stream)) {
      throw new OutputReferenceValidationError(
        'PROCESS_OUTPUT_REFERENCE_VALIDATION_FAILED: stream must be stdout or stderr',
      );
    }
    assertExpectedVersion(input.expectedVersion);
    const sha256 = assertSha256(input.sha256);
    const finalizedAt = input.finalizedAt ?? new Date().toISOString();
    assertCanonicalTimestamp(finalizedAt, 'finalizedAt');

    const current = this.findReference(workspaceId, processId, input.stream);
    if (current === undefined) {
      const row = this.db.prepare(`
        SELECT process_id FROM process_output_references WHERE process_id = ? AND stream = ?
      `).get(processId, input.stream) as { process_id: string } | undefined;
      return row === undefined ? { kind: 'not-found' } : { kind: 'workspace-mismatch' };
    }
    if (current.finalized) return { kind: 'duplicate', reference: current };
    if (current.version !== input.expectedVersion) {
      return { kind: 'version-conflict', reference: current };
    }

    const result = this.db.prepare(`
      UPDATE process_output_references
      SET finalized = 1,
        finalized_at = ?,
        sha256 = ?,
        updated_at = ?,
        version = version + 1
      WHERE workspace_id = ? AND process_id = ? AND stream = ?
        AND finalized = 0 AND version = ?
    `).run(
      finalizedAt,
      sha256,
      finalizedAt,
      workspaceId,
      processId,
      input.stream,
      input.expectedVersion,
    ) as { changes: number };

    if (result.changes === 1) {
      const reference = this.findReference(workspaceId, processId, input.stream)!;
      this.#appendAdvance(reference, current.nextSourceOffset, input.finalizedAt ?? reference.updatedAt, true);
      return {
        kind: 'applied',
        reference,
      };
    }
    const after = this.findReference(workspaceId, processId, input.stream)!;
    if (after.finalized) return { kind: 'duplicate', reference: after };
    return { kind: 'version-conflict', reference: after };
  }

  #appendAdvance(
    reference: ProcessOutputReference,
    priorSourceOffset: number,
    timestamp: string,
    finalizedMutation: boolean,
  ): void {
    const binding = this.db.prepare(`
      SELECT task_id, stage_id, provider_session_id
      FROM runtime_processes
      WHERE workspace_id = ? AND id = ?
    `).get(reference.workspaceId, reference.processId) as {
      task_id: string | null;
      stage_id: string | null;
      provider_session_id: string | null;
    } | undefined;
    this.factWriter?.appendWithinTransaction({
      type: 'process.output_reference_advanced',
      workspaceId: reference.workspaceId,
      ...(binding?.task_id === null || binding?.task_id === undefined ? {} : { taskId: binding.task_id }),
      runId: reference.runId,
      ...(binding?.stage_id === null || binding?.stage_id === undefined ? {} : { stageId: binding.stage_id }),
      ...(binding?.provider_session_id === null || binding?.provider_session_id === undefined
        ? {}
        : { providerSessionId: binding.provider_session_id }),
      processId: reference.processId,
      artifactId: reference.artifactId,
      timestamp,
      correlationId: `m4-p2b:output:${reference.processId}:${reference.stream}`,
      payload: {
        stream: reference.stream,
        artifactId: reference.artifactId,
        priorSourceOffset,
        nextSourceOffset: reference.nextSourceOffset,
        retainedBytes: reference.retainedBytes,
        segmentCount: reference.segmentCount,
        truncated: reference.truncated,
        finalized: finalizedMutation || reference.finalized,
        ...(reference.truncationReason === null ? {} : { truncationReason: reference.truncationReason }),
        ...(reference.finalizedAt === null ? {} : { finalizedAt: reference.finalizedAt }),
      },
    });
  }
}
