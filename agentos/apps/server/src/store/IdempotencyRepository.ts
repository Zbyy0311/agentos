import type { TransactionDatabase } from './Transaction.js';
import { isValidEntityId } from './Identity.js';
import { canonicalizeJson, hashCanonicalJson } from '../snapshots/canonicalJson.js';
import {
  IDEMPOTENCY_OPERATIONS,
  IdempotencyRecordInvalidError,
  parseIdempotencyResultEnvelopeV1,
  type IdempotencyOperation,
  type IdempotencyRecord,
  type IdempotencyResultEnvelopeV1,
  type InsertCompletedIdempotencyRecord,
} from '../idempotency/types.js';

const OPERATION_HTTP_STATUS: Readonly<Record<IdempotencyOperation, 200 | 201>> = {
  'task.create': 201,
  'run.create': 201,
  'run.cancel': 200,
  'task.accept': 200,
  'task.cancel': 200,
  'task.reopen': 200,
};

const HASH_HEX_64 = /^[0-9a-f]{64}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

const ROW_KEYS = Object.freeze([
  'id',
  'workspace_id',
  'operation',
  'key_hash',
  'request_hash',
  'result_schema_version',
  'result_json',
  'result_hash',
  'http_status',
  'created_at',
] as const);

interface IdempotencyRow {
  id: string;
  workspace_id: string;
  operation: string;
  key_hash: string;
  request_hash: string;
  result_schema_version: number;
  result_json: string;
  result_hash: string;
  http_status: number;
  created_at: string;
}

function invalid(): never {
  throw new IdempotencyRecordInvalidError();
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertOperation(value: unknown): IdempotencyOperation {
  if (typeof value !== 'string' || !(IDEMPOTENCY_OPERATIONS as readonly string[]).includes(value)) {
    invalid();
  }
  return value as IdempotencyOperation;
}

function assertHash64(value: unknown): string {
  if (typeof value !== 'string' || !HASH_HEX_64.test(value)) invalid();
  return value;
}

function assertIsoTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !ISO_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) {
    invalid();
  }
  return value;
}

function assertOperationStatusPair(operation: IdempotencyOperation, httpStatus: unknown): 200 | 201 {
  if (httpStatus !== OPERATION_HTTP_STATUS[operation]) invalid();
  return httpStatus as 200 | 201;
}

function assertExactRowShape(row: unknown): IdempotencyRow {
  if (!isPlainRecord(row)) invalid();
  const keys = Object.keys(row);
  if (keys.length !== ROW_KEYS.length) invalid();
  for (const key of keys) {
    if (!(ROW_KEYS as readonly string[]).includes(key)) invalid();
  }
  const candidate = row as Record<string, unknown>;
  if (
    typeof candidate.id !== 'string'
    || typeof candidate.workspace_id !== 'string'
    || typeof candidate.operation !== 'string'
    || typeof candidate.key_hash !== 'string'
    || typeof candidate.request_hash !== 'string'
    || typeof candidate.result_schema_version !== 'number'
    || typeof candidate.result_json !== 'string'
    || typeof candidate.result_hash !== 'string'
    || typeof candidate.http_status !== 'number'
    || typeof candidate.created_at !== 'string'
  ) {
    invalid();
  }
  return row as unknown as IdempotencyRow;
}

export class IdempotencyRepository {
  constructor(private readonly db: TransactionDatabase) {}

  findVerifiedByScope(
    workspaceId: string,
    operation: IdempotencyOperation,
    keyHash: string,
  ): IdempotencyRecord | undefined {
    const raw = this.db.prepare(`
      SELECT id, workspace_id, operation, key_hash, request_hash,
        result_schema_version, result_json, result_hash, http_status, created_at
      FROM idempotency_records
      WHERE workspace_id = ? AND operation = ? AND key_hash = ?
    `).get(workspaceId, operation, keyHash);
    if (raw === undefined || raw === null) return undefined;

    const row = assertExactRowShape(raw);
    if (!isValidEntityId(row.id, 'idempotency')) invalid();
    const rowOperation = assertOperation(row.operation);
    assertHash64(row.key_hash);
    assertHash64(row.request_hash);
    assertHash64(row.result_hash);
    if (row.result_schema_version !== 1) invalid();
    const httpStatus = assertOperationStatusPair(rowOperation, row.http_status);

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(row.result_json);
    } catch {
      invalid();
    }
    let canonical: string;
    let recomputedHash: string;
    try {
      canonical = canonicalizeJson(parsedJson);
      recomputedHash = hashCanonicalJson(parsedJson);
    } catch {
      invalid();
    }
    if (row.result_json !== canonical) invalid();
    const envelope: IdempotencyResultEnvelopeV1 = parseIdempotencyResultEnvelopeV1(parsedJson);
    if (envelope.operation !== rowOperation) invalid();
    if (row.result_hash !== recomputedHash) invalid();
    const createdAt = assertIsoTimestamp(row.created_at);

    return {
      id: row.id,
      workspaceId: row.workspace_id,
      operation: rowOperation,
      keyHash: row.key_hash,
      requestHash: row.request_hash,
      resultSchemaVersion: 1,
      envelope,
      resultHash: row.result_hash,
      httpStatus,
      createdAt,
    };
  }

  insertCompleted(input: InsertCompletedIdempotencyRecord): IdempotencyRecord {
    if (!isPlainRecord(input)) invalid();
    if (!isValidEntityId(input.id, 'idempotency')) invalid();
    if (typeof input.workspaceId !== 'string' || input.workspaceId.length === 0) invalid();
    const operation = assertOperation(input.operation);
    const keyHash = assertHash64(input.keyHash);
    const requestHash = assertHash64(input.requestHash);
    const httpStatus = assertOperationStatusPair(operation, input.httpStatus);
    const createdAt = assertIsoTimestamp(input.createdAt);

    let resultJson: string;
    let resultHash: string;
    try {
      resultJson = canonicalizeJson(input.envelope);
      resultHash = hashCanonicalJson(input.envelope);
    } catch {
      invalid();
    }
    let parsed: IdempotencyResultEnvelopeV1;
    try {
      parsed = parseIdempotencyResultEnvelopeV1(JSON.parse(resultJson));
    } catch {
      invalid();
    }
    if (parsed.operation !== operation) invalid();

    this.db.prepare(`
      INSERT INTO idempotency_records (
        id, workspace_id, operation, key_hash, request_hash,
        result_schema_version, result_json, result_hash, http_status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.workspaceId,
      operation,
      keyHash,
      requestHash,
      1,
      resultJson,
      resultHash,
      httpStatus,
      createdAt,
    );

    const record = this.findVerifiedByScope(input.workspaceId, operation, keyHash);
    if (!record) invalid();
    return record;
  }
}
