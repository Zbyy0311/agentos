import type { IdempotencyRepository } from '../store/IdempotencyRepository.js';
import { createEntityId } from '../store/Identity.js';
import {
  IdempotencyRecordInvalidError,
  type FingerprintInput,
  type IdempotencyOperation,
  type IdempotencyRecord,
  type IdempotencyResultEnvelopeV1,
} from '../idempotency/types.js';
import {
  hashIdempotencyRequest,
  hashNormalizedIdempotencyKey,
} from '../idempotency/fingerprint.js';

export interface PreparedIdempotency {
  readonly operation: IdempotencyOperation;
  readonly workspaceId: string;
  readonly keyHash: string;
  readonly requestHash: string;
}

export type IdempotencyResolution =
  | { kind: 'miss' }
  | {
      kind: 'replay';
      httpStatus: 200 | 201;
      envelope: IdempotencyResultEnvelopeV1;
    };

export interface PrepareIdempotencyInput {
  operation: IdempotencyOperation;
  workspaceId: string;
  normalizedKey: string | undefined;
  fingerprintInput: FingerprintInput;
}

export interface StoreSuccessInput {
  prepared: PreparedIdempotency;
  httpStatus: 200 | 201;
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

  prepare(input: PrepareIdempotencyInput): PreparedIdempotency | undefined {
    if (input.normalizedKey === undefined) return undefined;
    const keyHash = hashNormalizedIdempotencyKey(input.normalizedKey);
    const requestHash = hashIdempotencyRequest(input.fingerprintInput);
    return {
      operation: input.operation,
      workspaceId: input.workspaceId,
      keyHash,
      requestHash,
    };
  }

  resolve(prepared: PreparedIdempotency): IdempotencyResolution {
    const record = this.repository.findVerifiedByScope(
      prepared.workspaceId,
      prepared.operation,
      prepared.keyHash,
    );
    if (!record) return { kind: 'miss' };
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
    if (input.httpStatus !== 200 && input.httpStatus !== 201) {
      throw new IdempotencyRecordInvalidError();
    }
    if (input.envelope.operation !== input.prepared.operation) {
      throw new IdempotencyRecordInvalidError();
    }
    return this.repository.insertCompleted({
      id: createEntityId('idempotency'),
      workspaceId: input.prepared.workspaceId,
      operation: input.prepared.operation,
      keyHash: input.prepared.keyHash,
      requestHash: input.prepared.requestHash,
      envelope: input.envelope,
      httpStatus: input.httpStatus,
      createdAt: new Date().toISOString(),
    });
  }
}
