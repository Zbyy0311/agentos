import type { IdempotencyRepository } from '../store/IdempotencyRepository.js';
import { createEntityId } from '../store/Identity.js';
import {
  IDEMPOTENCY_HTTP_STATUS,
  IdempotencyRecordInvalidError,
  type FingerprintInput,
  type IdempotencyHttpStatus,
  type IdempotencyOperation,
  type IdempotencyRecord,
  type IdempotencyResultEnvelopeV1,
  parseIdempotencyResultEnvelopeV1,
} from '../idempotency/types.js';
import {
  hashIdempotencyRequest,
  hashNormalizedIdempotencyKey,
} from '../idempotency/fingerprint.js';

export type LegacyIdempotencyOperation = Exclude<IdempotencyOperation, 'run.start' | 'run.retry'>;

export interface PreparedIdempotency<TOperation extends IdempotencyOperation = LegacyIdempotencyOperation> {
  readonly operation: TOperation;
  readonly workspaceId: string;
  readonly keyHash: string;
  readonly requestHash: string;
}

export type IdempotencyResolution<TOperation extends IdempotencyOperation = LegacyIdempotencyOperation> =
  | { kind: 'miss' }
  | {
      kind: 'replay';
      httpStatus: TOperation extends 'run.start' ? 202 : TOperation extends 'run.retry' ? 201 : 200 | 201;
      envelope: TOperation extends 'run.start'
        ? Extract<IdempotencyResultEnvelopeV1, { operation: 'run.start' }>
        : TOperation extends 'run.retry'
          ? Extract<IdempotencyResultEnvelopeV1, { operation: 'run.retry' }>
          : Exclude<IdempotencyResultEnvelopeV1, { operation: 'run.start' | 'run.retry' }>;
    };

export interface PrepareIdempotencyInput {
  operation: IdempotencyOperation;
  workspaceId: string;
  normalizedKey: string | undefined;
  fingerprintInput: FingerprintInput;
}

export interface StoreSuccessInput {
  prepared: PreparedIdempotency<IdempotencyOperation>;
  httpStatus: IdempotencyHttpStatus;
  envelope: IdempotencyResultEnvelopeV1;
}

export class IdempotencyKeyReusedError extends Error {
  readonly code = 'IDEMPOTENCY_KEY_REUSED' as const;

  constructor() {
    super('Idempotency key was already used with a different request');
    this.name = 'IdempotencyKeyReusedError';
  }
}

/**
 * Transactionless idempotency orchestration (M2.6 P2).
 * Never begins, commits, rolls back, or calls runInTransaction — the caller
 * (TaskRunService in P3) owns the transaction and the repository shares its handle.
 */
export class IdempotencyService {
  constructor(private readonly repository: IdempotencyRepository) {}

  prepare(
    input: PrepareIdempotencyInput & {
      operation: 'run.start';
      fingerprintInput: FingerprintInput & { operation: 'run.start' };
    },
  ): PreparedIdempotency<'run.start'> | undefined;

  prepare(
    input: PrepareIdempotencyInput & {
      operation: 'run.retry';
      fingerprintInput: FingerprintInput & { operation: 'run.retry' };
    },
  ): PreparedIdempotency<'run.retry'> | undefined;

  prepare(
    input: PrepareIdempotencyInput & {
      operation: 'run.start' | 'run.retry';
      fingerprintInput: FingerprintInput & { operation: 'run.start' | 'run.retry' };
    },
  ): PreparedIdempotency<'run.start' | 'run.retry'> | undefined;

  prepare(input: PrepareIdempotencyInput): PreparedIdempotency | undefined;

  prepare(input: PrepareIdempotencyInput): PreparedIdempotency<IdempotencyOperation> | undefined {
    if (input.normalizedKey === undefined) return undefined;
    if (
      input.operation !== input.fingerprintInput.operation
      || input.workspaceId !== input.fingerprintInput.workspaceId
    ) {
      throw new IdempotencyRecordInvalidError();
    }
    const keyHash = hashNormalizedIdempotencyKey(input.normalizedKey);
    const requestHash = hashIdempotencyRequest(input.fingerprintInput);
    return {
      operation: input.operation,
      workspaceId: input.workspaceId,
      keyHash,
      requestHash,
    };
  }

  resolve(prepared: PreparedIdempotency<'run.start'>): IdempotencyResolution<'run.start'>;
  resolve(prepared: PreparedIdempotency<'run.retry'>): IdempotencyResolution<'run.retry'>;
  resolve(prepared: PreparedIdempotency<'run.start' | 'run.retry'>): IdempotencyResolution<'run.start' | 'run.retry'>;
  resolve(prepared: PreparedIdempotency): IdempotencyResolution;
  resolve(prepared: PreparedIdempotency<IdempotencyOperation>): IdempotencyResolution<IdempotencyOperation> {
    const record = this.repository.findVerifiedByScope(
      prepared.workspaceId,
      prepared.operation,
      prepared.keyHash,
    );
    if (!record) return { kind: 'miss' };
    if (
      record.workspaceId !== prepared.workspaceId
      || record.operation !== prepared.operation
      || record.keyHash !== prepared.keyHash
    ) {
      throw new IdempotencyRecordInvalidError();
    }
    if (record.requestHash !== prepared.requestHash) {
      throw new IdempotencyKeyReusedError();
    }
    return {
      kind: 'replay',
      httpStatus: record.httpStatus,
      envelope: record.envelope,
    };
  }

  storeSuccess(input: StoreSuccessInput): IdempotencyRecord {
    if (input.httpStatus !== IDEMPOTENCY_HTTP_STATUS[input.prepared.operation]) {
      throw new IdempotencyRecordInvalidError();
    }
    const envelope = parseIdempotencyResultEnvelopeV1(input.envelope);
    if (envelope.operation !== input.prepared.operation) {
      throw new IdempotencyRecordInvalidError();
    }
    if (envelope.operation === 'run.retry') {
      const { run, operation } = envelope.body;
      if (
        run.workspaceId !== operation.workspaceId
        || operation.workspaceId !== input.prepared.workspaceId
      ) {
        throw new IdempotencyRecordInvalidError();
      }
    }
    const envelopeWorkspaceId = 'task' in envelope.body
      ? envelope.body.task.workspaceId
      : 'run' in envelope.body
        ? envelope.body.run.workspaceId
        : envelope.body.operation.workspaceId;
    if (envelopeWorkspaceId !== input.prepared.workspaceId) {
      throw new IdempotencyRecordInvalidError();
    }
    return this.repository.insertCompleted({
      id: createEntityId('idempotency'),
      workspaceId: input.prepared.workspaceId,
      operation: input.prepared.operation,
      keyHash: input.prepared.keyHash,
      requestHash: input.prepared.requestHash,
      envelope,
      httpStatus: input.httpStatus,
      createdAt: new Date().toISOString(),
    });
  }
}
