import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import type { ApiOperation, Run, Task } from '@agentos/shared';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): {
      all(...params: unknown[]): unknown[];
      get(...params: unknown[]): unknown;
      run(...params: unknown[]): unknown;
    };
    close(): void;
  };
};

type Db = InstanceType<typeof DatabaseSync>;

import { MigrationRegistry } from '../migrations/registry.js';
import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import { canonicalizeJson, hashCanonicalJson } from '../snapshots/canonicalJson.js';
import { createEntityId } from './Identity.js';
import { SqliteStore } from './SqliteStore.js';
import {
  buildOperationResultEnvelopeV1,
  buildRetryResultEnvelopeV1,
  buildTaskResultEnvelopeV1,
  IdempotencyRecordInvalidError,
  type FingerprintInput,
  type IdempotencyOperation,
  type IdempotencyResultEnvelopeV1,
  type InsertCompletedIdempotencyRecord,
  type OperationResultEnvelopeV1,
  type RetryResultEnvelopeV1,
  type TaskResultEnvelopeV1,
} from '../idempotency/types.js';
import { hashIdempotencyRequest, hashNormalizedIdempotencyKey } from '../idempotency/fingerprint.js';
import { IdempotencyRepository } from './IdempotencyRepository.js';
import { IdempotencyService } from '../services/IdempotencyService.js';

const NOW = '2026-01-01T00:00:00.000Z';
const HASH64 = 'c'.repeat(64);
const RAW_KEY = 'raw-key-should-never-persist';
const START_NORMALIZED_KEY = 'run-start-repository-key';
const RETRY_NORMALIZED_KEY = 'run-retry-repository-key';

function migratedDb(databasePath = ':memory:'): Db {
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner(db, new MigrationRegistry([...DEFAULT_REGISTRY_MIGRATIONS])).run();
  return db;
}

function rawDb(): Db {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_path TEXT NOT NULL,
      canonical_root_path TEXT NOT NULL,
      last_opened_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE idempotency_records (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      result_schema_version INTEGER NOT NULL,
      result_json TEXT NOT NULL,
      result_hash TEXT NOT NULL,
      http_status INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  return db;
}

function insertWorkspace(db: Db, id: string): void {
  db.prepare(`
    INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, `ws-${id}`, `/r/${id}`, `/r/${id}`, NOW, NOW, NOW);
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task_00000000000000000000000001',
    workspaceId: 'ws-1',
    title: 'task title',
    status: 'open',
    priority: 'normal',
    createdBy: 'tester',
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
    ...overrides,
  };
}

function makeEnvelope(): TaskResultEnvelopeV1 {
  return buildTaskResultEnvelopeV1('task.create', makeTask());
}

function makeStartOperation(overrides: Partial<ApiOperation> = {}): ApiOperation {
  return {
    id: 'operation_00000000000000000000000001',
    type: 'run.start',
    status: 'queued',
    workspaceId: 'ws-1',
    aggregateType: 'run',
    aggregateId: 'run_00000000000000000000000001',
    runId: 'run_00000000000000000000000001',
    correlationId: 'operation_00000000000000000000000001',
    createdAt: NOW,
    version: 1,
    ...overrides,
  };
}

function makeStartEnvelope() {
  return buildOperationResultEnvelopeV1('run.start', makeStartOperation());
}

function makeRetryChildRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run_00000000000000000000000002',
    workspaceId: 'ws-1',
    taskId: 'task_00000000000000000000000001',
    parentRunId: 'run_00000000000000000000000001',
    rootRunId: 'run_00000000000000000000000001',
    status: 'queued',
    reason: 'retry',
    origin: 'v2_api',
    nextEventSequence: 1,
    createdBy: 'tester',
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
    ...overrides,
  };
}

function makeRetryOperation(overrides: Partial<ApiOperation> = {}): ApiOperation {
  return {
    id: 'operation_00000000000000000000000002',
    type: 'run.retry',
    status: 'completed',
    workspaceId: 'ws-1',
    aggregateType: 'run',
    aggregateId: 'run_00000000000000000000000001',
    runId: 'run_00000000000000000000000001',
    correlationId: 'operation_00000000000000000000000002',
    result: {
      resourceType: 'run',
      resourceId: 'run_00000000000000000000000002',
    },
    createdAt: NOW,
    startedAt: '2026-01-01T00:00:00.001Z',
    completedAt: '2026-01-01T00:00:00.002Z',
    version: 3,
    ...overrides,
  };
}

function makeRetryEnvelope(): RetryResultEnvelopeV1 {
  return buildRetryResultEnvelopeV1('run.retry', makeRetryChildRun(), makeRetryOperation());
}

function makeStartFingerprintInput(): FingerprintInput & { operation: 'run.start' } {
  return {
    operation: 'run.start',
    workspaceId: 'ws-1',
    pathParams: { runId: 'run_00000000000000000000000001' },
    domainInput: {},
    expectedVersion: 1,
  };
}

function makeStartInput(): InsertCompletedIdempotencyRecord {
  return {
    id: createEntityId('idempotency'),
    workspaceId: 'ws-1',
    operation: 'run.start',
    keyHash: hashNormalizedIdempotencyKey(START_NORMALIZED_KEY),
    requestHash: hashIdempotencyRequest(makeStartFingerprintInput()),
    envelope: makeStartEnvelope(),
    httpStatus: 202,
    createdAt: NOW,
  };
}

function makeRetryFingerprintInput(): FingerprintInput & { operation: 'run.retry' } {
  return {
    operation: 'run.retry',
    workspaceId: 'ws-1',
    pathParams: { runId: 'run_00000000000000000000000001' },
    domainInput: { reason: 'retry' },
    expectedVersion: 1,
  };
}

function makeRetryInput(overrides: Partial<InsertCompletedIdempotencyRecord> = {}): InsertCompletedIdempotencyRecord {
  return makeInput({
    operation: 'run.retry',
    keyHash: hashNormalizedIdempotencyKey(RETRY_NORMALIZED_KEY),
    requestHash: hashIdempotencyRequest(makeRetryFingerprintInput()),
    envelope: makeRetryEnvelope(),
    httpStatus: 201,
    ...overrides,
  });
}

function makeInput(overrides: Partial<InsertCompletedIdempotencyRecord> = {}): InsertCompletedIdempotencyRecord {
  return {
    id: createEntityId('idempotency'),
    workspaceId: 'ws-1',
    operation: 'task.create',
    keyHash: hashNormalizedIdempotencyKey(RAW_KEY),
    requestHash: hashIdempotencyRequest({
      operation: 'task.create',
      workspaceId: 'ws-1',
      pathParams: {},
      domainInput: { title: 'task title' },
      expectedVersion: null,
    }),
    envelope: makeEnvelope(),
    httpStatus: 201,
    createdAt: NOW,
    ...overrides,
  };
}

function insertRawRow(
  db: Db,
  overrides: {
    id?: string;
    workspaceId?: string;
    operation?: string;
    keyHash?: string;
    requestHash?: string;
    resultSchemaVersion?: number;
    resultJson?: string;
    resultHash?: string;
    httpStatus?: number;
    createdAt?: string;
  } = {},
): void {
  const envelope = makeEnvelope();
  db.prepare(`
    INSERT INTO idempotency_records (
      id, workspace_id, operation, key_hash, request_hash,
      result_schema_version, result_json, result_hash, http_status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    overrides.id ?? createEntityId('idempotency'),
    overrides.workspaceId ?? 'ws-1',
    overrides.operation ?? 'task.create',
    overrides.keyHash ?? HASH64,
    overrides.requestHash ?? HASH64,
    overrides.resultSchemaVersion ?? 1,
    overrides.resultJson ?? canonicalizeJson(envelope),
    overrides.resultHash ?? hashCanonicalJson(envelope),
    overrides.httpStatus ?? 201,
    overrides.createdAt ?? NOW,
  );
}

interface IdempotencyRaceWorkerData {
  readonly mode: 'run-start-race' | 'run-retry-race';
  readonly dbPath: string;
  readonly workspaceId: string;
  readonly normalizedKey: string;
  readonly fingerprintInput: FingerprintInput & { operation: 'run.start' | 'run.retry' };
  readonly keyHash: string;
  readonly requestHash: string;
  readonly envelope: OperationResultEnvelopeV1 | RetryResultEnvelopeV1;
  readonly gate: SharedArrayBuffer;
}

interface IdempotencyRaceWorkerMessage {
  readonly outcome: 'winner' | 'loser';
  readonly preparedWorkspaceId: string;
  readonly preparedOperation: 'run.start' | 'run.retry';
  readonly preparedKeyHash: string;
  readonly preparedRequestHash: string;
  readonly recordHttpStatus?: number;
  readonly recordEnvelope?: IdempotencyResultEnvelopeV1;
  readonly resultHash?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly replayHttpStatus?: number;
  readonly replayEnvelope?: IdempotencyResultEnvelopeV1;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function runIdempotencyRaceWorker(data: IdempotencyRaceWorkerData): void {
  const db = new DatabaseSync(data.dbPath);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000');
  try {
    const repository = new IdempotencyRepository(db);
    const service = new IdempotencyService(repository);
    const expectedHttpStatus = data.mode === 'run-start-race' ? 202 : 201;
    const prepared = service.prepare({
      operation: data.fingerprintInput.operation,
      workspaceId: data.workspaceId,
      normalizedKey: data.normalizedKey,
      fingerprintInput: data.fingerprintInput,
    });
    assert.ok(prepared);
    assert.equal(prepared.workspaceId, data.workspaceId);
    assert.equal(prepared.operation, data.fingerprintInput.operation);
    assert.equal(prepared.keyHash, data.keyHash);
    assert.equal(prepared.requestHash, data.requestHash);

    const gate = new Int32Array(data.gate);
    const arrived = Atomics.add(gate, 0, 1) + 1;
    if (arrived === 2) {
      Atomics.store(gate, 1, 1);
      Atomics.notify(gate, 1);
    }
    while (Atomics.load(gate, 1) === 0) Atomics.wait(gate, 1, 0);

    try {
      const record = service.storeSuccess({
        prepared,
        httpStatus: expectedHttpStatus,
        envelope: data.envelope,
      });
      if (record.envelope.operation !== data.fingerprintInput.operation) throw new Error('unexpected winner envelope');
      parentPort!.postMessage({
        outcome: 'winner',
        preparedWorkspaceId: prepared.workspaceId,
        preparedOperation: prepared.operation,
        preparedKeyHash: prepared.keyHash,
        preparedRequestHash: prepared.requestHash,
        recordHttpStatus: record.httpStatus,
        recordEnvelope: record.envelope,
        resultHash: record.resultHash,
      } satisfies IdempotencyRaceWorkerMessage);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = errorCode(error);
      assert.equal(code, 'ERR_SQLITE_ERROR');
      assert.equal(message, 'UNIQUE constraint failed: idempotency_records.workspace_id, idempotency_records.operation, idempotency_records.key_hash');
      const resolution = service.resolve(prepared);
      assert.equal(resolution.kind, 'replay');
      if (resolution.kind !== 'replay') throw new Error('expected replay after unique-scope loss');
      parentPort!.postMessage({
        outcome: 'loser',
        preparedWorkspaceId: prepared.workspaceId,
        preparedOperation: prepared.operation,
        preparedKeyHash: prepared.keyHash,
        preparedRequestHash: prepared.requestHash,
        errorCode: code,
        errorMessage: message,
        replayHttpStatus: resolution.httpStatus,
        replayEnvelope: resolution.envelope,
      } satisfies IdempotencyRaceWorkerMessage);
    }
  } finally {
    db.close();
    parentPort!.close();
  }
}

function spawnIdempotencyRaceWorker(data: IdempotencyRaceWorkerData): Promise<IdempotencyRaceWorkerMessage> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./IdempotencyRepository.test.ts', import.meta.url), {
      workerData: data,
      execArgv: ['--import', 'tsx'],
    });
    let received = false;
    worker.once('message', message => {
      received = true;
      resolve(message as IdempotencyRaceWorkerMessage);
    });
    worker.once('error', reject);
    worker.once('exit', code => {
      if (!received && code !== 0) reject(new Error(`idempotency race worker exited with ${code}`));
    });
  });
}

const currentWorkerData = workerData as IdempotencyRaceWorkerData | undefined;

if (
  !isMainThread
  && (currentWorkerData?.mode === 'run-start-race' || currentWorkerData?.mode === 'run-retry-race')
  && parentPort
) {
  runIdempotencyRaceWorker(currentWorkerData);
} else {

describe('M2.6 — IdempotencyRepository insert and read', () => {
  it('R01 insert/read round trip returns the stored record', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const repo = new IdempotencyRepository(db);
      const input = makeInput();
      const record = repo.insertCompleted(input);
      assert.equal(record.id, input.id);
      assert.equal(record.workspaceId, 'ws-1');
      assert.equal(record.operation, 'task.create');
      assert.equal(record.keyHash, input.keyHash);
      assert.equal(record.requestHash, input.requestHash);
      assert.equal(record.resultSchemaVersion, 1);
      assert.deepEqual(record.envelope, input.envelope);
      assert.equal(record.httpStatus, 201);
      assert.equal(record.createdAt, NOW);
      const found = repo.findVerifiedByScope('ws-1', 'task.create', input.keyHash);
      assert.deepEqual(found, record);
    } finally {
      db.close();
    }
  });

  it('R02 stored result_json is the canonical envelope JSON', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const repo = new IdempotencyRepository(db);
      const input = makeInput();
      repo.insertCompleted(input);
      const row = db.prepare('SELECT result_json FROM idempotency_records WHERE id = ?').get(input.id) as { result_json: string };
      assert.equal(row.result_json, canonicalizeJson(input.envelope));
    } finally {
      db.close();
    }
  });

  it('R03 result_hash is computed internally from the canonical envelope', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const repo = new IdempotencyRepository(db);
      const input = makeInput();
      const record = repo.insertCompleted(input);
      assert.equal(record.resultHash, hashCanonicalJson(input.envelope));
      const row = db.prepare('SELECT result_hash FROM idempotency_records WHERE id = ?').get(input.id) as { result_hash: string };
      assert.equal(row.result_hash, record.resultHash);
    } finally {
      db.close();
    }
  });

  it('R04 raw key never appears in the stored row', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const repo = new IdempotencyRepository(db);
      const input = makeInput();
      repo.insertCompleted(input);
      const row = db.prepare('SELECT * FROM idempotency_records WHERE id = ?').get(input.id) as Record<string, unknown>;
      for (const value of Object.values(row)) {
        assert.ok(!String(value).includes(RAW_KEY), `raw key leaked into row value: ${String(value)}`);
      }
    } finally {
      db.close();
    }
  });

  it('R05 normalized key never appears in the stored row', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const repo = new IdempotencyRepository(db);
      const normalizedKey = 'normalized-key-123';
      const input = makeInput({ keyHash: hashNormalizedIdempotencyKey(normalizedKey) });
      repo.insertCompleted(input);
      const row = db.prepare('SELECT * FROM idempotency_records WHERE id = ?').get(input.id) as Record<string, unknown>;
      for (const value of Object.values(row)) {
        assert.ok(!String(value).includes(normalizedKey));
      }
    } finally {
      db.close();
    }
  });

  it('R06 lookup is scoped to the exact workspace', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      insertWorkspace(db, 'ws-2');
      const repo = new IdempotencyRepository(db);
      const input = makeInput();
      repo.insertCompleted(input);
      assert.ok(repo.findVerifiedByScope('ws-1', 'task.create', input.keyHash));
      const other = repo.insertCompleted(makeInput({
        workspaceId: 'ws-2',
        envelope: buildTaskResultEnvelopeV1('task.create', makeTask({ workspaceId: 'ws-2' })),
      }));
      assert.ok(other.id !== input.id);
    } finally {
      db.close();
    }
  });

  it('R07 cross-workspace lookup returns undefined', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      insertWorkspace(db, 'ws-2');
      const repo = new IdempotencyRepository(db);
      const input = makeInput();
      repo.insertCompleted(input);
      assert.equal(repo.findVerifiedByScope('ws-2', 'task.create', input.keyHash), undefined);
    } finally {
      db.close();
    }
  });

  it('R08 different operation returns undefined', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const repo = new IdempotencyRepository(db);
      const input = makeInput();
      repo.insertCompleted(input);
      assert.equal(repo.findVerifiedByScope('ws-1', 'run.create', input.keyHash), undefined);
    } finally {
      db.close();
    }
  });

  it('R09 insert with invalid id is rejected', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const repo = new IdempotencyRepository(db);
      assert.throws(() => repo.insertCompleted(makeInput({ id: 'task_00000000000000000000000001' })), IdempotencyRecordInvalidError);
      assert.throws(() => repo.insertCompleted(makeInput({ id: 'idem_short' })), IdempotencyRecordInvalidError);
    } finally {
      db.close();
    }
  });

  it('R10 insert with an extra envelope field is rejected', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const repo = new IdempotencyRepository(db);
      const envelope = { ...makeEnvelope(), extra: 1 } as TaskResultEnvelopeV1;
      assert.throws(() => repo.insertCompleted(makeInput({ envelope })), IdempotencyRecordInvalidError);
    } finally {
      db.close();
    }
  });

  it('R11 insert with a missing envelope field is rejected', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const repo = new IdempotencyRepository(db);
      const broken = JSON.parse(JSON.stringify(makeEnvelope()));
      delete broken.body.task.title;
      assert.throws(() => repo.insertCompleted(makeInput({ envelope: broken })), IdempotencyRecordInvalidError);
    } finally {
      db.close();
    }
  });

  it('R12 insert with envelope operation mismatch is rejected', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const repo = new IdempotencyRepository(db);
      const envelope = buildTaskResultEnvelopeV1('task.accept', makeTask());
      assert.throws(
        () => repo.insertCompleted(makeInput({ envelope, httpStatus: 200, operation: 'task.create' as IdempotencyOperation })),
        IdempotencyRecordInvalidError,
      );
    } finally {
      db.close();
    }
  });

  it('R13 insert with invalid keyHash is rejected', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const repo = new IdempotencyRepository(db);
      assert.throws(() => repo.insertCompleted(makeInput({ keyHash: 'not-a-hash' })), IdempotencyRecordInvalidError);
      assert.throws(() => repo.insertCompleted(makeInput({ keyHash: 'A'.repeat(64) })), IdempotencyRecordInvalidError);
    } finally {
      db.close();
    }
  });

  it('R14 insert with invalid requestHash is rejected', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const repo = new IdempotencyRepository(db);
      assert.throws(() => repo.insertCompleted(makeInput({ requestHash: 'z'.repeat(64) })), IdempotencyRecordInvalidError);
      assert.throws(() => repo.insertCompleted(makeInput({ requestHash: 'a'.repeat(63) })), IdempotencyRecordInvalidError);
    } finally {
      db.close();
    }
  });

  it('R15 stored malformed result_hash fails closed on read', () => {
    const db = rawDb();
    try {
      insertWorkspace(db, 'ws-1');
      insertRawRow(db, { resultHash: 'not-a-hash' });
      const repo = new IdempotencyRepository(db);
      assert.throws(() => repo.findVerifiedByScope('ws-1', 'task.create', HASH64), IdempotencyRecordInvalidError);
    } finally {
      db.close();
    }
  });

  it('R16 stored invalid result_schema_version fails closed on read', () => {
    const db = rawDb();
    try {
      insertWorkspace(db, 'ws-1');
      insertRawRow(db, { resultSchemaVersion: 2 });
      const repo = new IdempotencyRepository(db);
      assert.throws(() => repo.findVerifiedByScope('ws-1', 'task.create', HASH64), IdempotencyRecordInvalidError);
    } finally {
      db.close();
    }
  });

  it('R17 stored non-2xx http_status fails closed on read', () => {
    const db = rawDb();
    try {
      insertWorkspace(db, 'ws-1');
      insertRawRow(db, { httpStatus: 500 });
      const repo = new IdempotencyRepository(db);
      assert.throws(() => repo.findVerifiedByScope('ws-1', 'task.create', HASH64), IdempotencyRecordInvalidError);
    } finally {
      db.close();
    }
  });

  it('R18 operation/http status pair mismatch is rejected on insert and read', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const repo = new IdempotencyRepository(db);
      assert.throws(() => repo.insertCompleted(makeInput({ httpStatus: 200 })), IdempotencyRecordInvalidError);
      const runCancel = buildTaskResultEnvelopeV1('task.cancel', makeTask());
      assert.throws(
        () => repo.insertCompleted(makeInput({ operation: 'task.cancel', envelope: runCancel, httpStatus: 201 })),
        IdempotencyRecordInvalidError,
      );
    } finally {
      db.close();
    }
    const raw = rawDb();
    try {
      insertWorkspace(raw, 'ws-1');
      insertRawRow(raw, { httpStatus: 200 });
      const repo = new IdempotencyRepository(raw);
      assert.throws(() => repo.findVerifiedByScope('ws-1', 'task.create', HASH64), IdempotencyRecordInvalidError);
    } finally {
      raw.close();
    }
  });

  it('R19 stored invalid JSON fails closed on read', () => {
    const db = rawDb();
    try {
      insertWorkspace(db, 'ws-1');
      insertRawRow(db, { resultJson: 'not-json' });
      const repo = new IdempotencyRepository(db);
      assert.throws(() => repo.findVerifiedByScope('ws-1', 'task.create', HASH64), IdempotencyRecordInvalidError);
    } finally {
      db.close();
    }
  });

  it('R20 stored non-canonical JSON fails closed on read', () => {
    const db = rawDb();
    try {
      insertWorkspace(db, 'ws-1');
      insertRawRow(db, { resultJson: `{ "schemaVersion": 1, "operation": "task.create", "body": { "task": {} } }` });
      const repo = new IdempotencyRepository(db);
      assert.throws(() => repo.findVerifiedByScope('ws-1', 'task.create', HASH64), IdempotencyRecordInvalidError);
    } finally {
      db.close();
    }
  });

  it('R21 result hash tampering fails closed on read', () => {
    const db = rawDb();
    try {
      insertWorkspace(db, 'ws-1');
      insertRawRow(db, { resultHash: 'e'.repeat(64) });
      const repo = new IdempotencyRepository(db);
      assert.throws(() => repo.findVerifiedByScope('ws-1', 'task.create', HASH64), IdempotencyRecordInvalidError);
    } finally {
      db.close();
    }
  });

  it('R22 invalid createdAt is rejected on insert and read', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const repo = new IdempotencyRepository(db);
      assert.throws(() => repo.insertCompleted(makeInput({ createdAt: 'not-a-date' })), IdempotencyRecordInvalidError);
      assert.throws(() => repo.insertCompleted(makeInput({ createdAt: '2026-13-99T99:99:99Z' })), IdempotencyRecordInvalidError);
    } finally {
      db.close();
    }
    const raw = rawDb();
    try {
      insertWorkspace(raw, 'ws-1');
      insertRawRow(raw, { createdAt: 'not-a-date' });
      const repo = new IdempotencyRepository(raw);
      assert.throws(() => repo.findVerifiedByScope('ws-1', 'task.create', HASH64), IdempotencyRecordInvalidError);
    } finally {
      raw.close();
    }
  });

  it('R23 returned record is deep detached', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const repo = new IdempotencyRepository(db);
      const input = makeInput();
      const record = repo.insertCompleted(input);
      (record.envelope as TaskResultEnvelopeV1).body.task.title = 'mutated';
      const found = repo.findVerifiedByScope('ws-1', 'task.create', input.keyHash);
      assert.equal((found!.envelope as TaskResultEnvelopeV1).body.task.title, 'task title');
    } finally {
      db.close();
    }
  });

  it('R24 duplicate scope is rejected by SQLite', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const repo = new IdempotencyRepository(db);
      const input = makeInput();
      repo.insertCompleted(input);
      assert.throws(() => repo.insertCompleted(makeInput({ keyHash: input.keyHash })));
    } finally {
      db.close();
    }
  });

  it('R25 UPDATE is rejected by the immutability trigger', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const repo = new IdempotencyRepository(db);
      const input = makeInput();
      repo.insertCompleted(input);
      assert.throws(
        () => db.prepare('UPDATE idempotency_records SET http_status = 200 WHERE id = ?').run(input.id),
        /IDEMPOTENCY_RECORD_IMMUTABLE/,
      );
    } finally {
      db.close();
    }
  });

  it('R26 direct DELETE is permitted at the database level', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const repo = new IdempotencyRepository(db);
      const input = makeInput();
      repo.insertCompleted(input);
      db.prepare('DELETE FROM idempotency_records WHERE id = ?').run(input.id);
      assert.equal(repo.findVerifiedByScope('ws-1', 'task.create', input.keyHash), undefined);
    } finally {
      db.close();
    }
  });

  it('R27 workspace cascade delete removes records', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const repo = new IdempotencyRepository(db);
      const input = makeInput();
      repo.insertCompleted(input);
      db.prepare("DELETE FROM workspaces WHERE id = 'ws-1'").run();
      assert.equal(repo.findVerifiedByScope('ws-1', 'task.create', input.keyHash), undefined);
    } finally {
      db.close();
    }
  });

  it('R28 well-formed request hash mismatch is not judged by the repository', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const repo = new IdempotencyRepository(db);
      const requestHashA = hashIdempotencyRequest({
        operation: 'task.create',
        workspaceId: 'ws-1',
        pathParams: {},
        domainInput: { title: 'A' },
        expectedVersion: null,
      });
      const input = makeInput({ requestHash: requestHashA });
      repo.insertCompleted(input);
      const found = repo.findVerifiedByScope('ws-1', 'task.create', input.keyHash);
      assert.equal(found!.requestHash, requestHashA);
    } finally {
      db.close();
    }
  });

  it('R29 error message never contains sensitive row values', () => {
    const db = rawDb();
    try {
      insertWorkspace(db, 'ws-1');
      insertRawRow(db, {
        resultJson: '{"schemaVersion":1,"secret":"SENSITIVE-ROW-VALUE"}',
        resultHash: 'd'.repeat(64),
      });
      const repo = new IdempotencyRepository(db);
      try {
        repo.findVerifiedByScope('ws-1', 'task.create', HASH64);
        assert.fail('expected rejection');
      } catch (error) {
        assert.ok(error instanceof IdempotencyRecordInvalidError);
        const message = (error as Error).message;
        assert.equal(message, 'Idempotency record is invalid');
        assert.ok(!message.includes('SENSITIVE-ROW-VALUE'));
        assert.ok(!message.includes(HASH64));
        assert.ok(!message.includes('ws-1'));
      }
    } finally {
      db.close();
    }
  });

  it('R30 public surface exposes only findVerifiedByScope and insertCompleted', () => {
    const db = migratedDb();
    try {
      const repo = new IdempotencyRepository(db);
      const publicNames = Object.getOwnPropertyNames(IdempotencyRepository.prototype)
        .filter((name) => name !== 'constructor' && !name.startsWith('_'));
      assert.deepEqual(publicNames.sort(), ['findVerifiedByScope', 'insertCompleted']);
      const instance = repo as unknown as Record<string, unknown>;
      assert.equal(instance.update, undefined);
      assert.equal(instance.delete, undefined);
      assert.equal(instance.findAll, undefined);
      assert.equal(instance.list, undefined);
      assert.equal(instance.verifyIntegrity, undefined);
      assert.equal(instance.getDatabase, undefined);
    } finally {
      db.close();
    }
  });

  it('R32 insert-side envelope operation mismatch is rejected in isolation (same-status operations)', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const repo = new IdempotencyRepository(db);
      // task.accept and task.cancel both map to HTTP 200, so the operation/status
      // pair check passes and the envelope-operation-mismatch branch itself must fire.
      const envelope = buildTaskResultEnvelopeV1('task.cancel', makeTask());
      assert.throws(
        () => repo.insertCompleted(makeInput({ operation: 'task.accept', envelope, httpStatus: 200 })),
        IdempotencyRecordInvalidError,
      );
      const count = db.prepare('SELECT COUNT(*) AS c FROM idempotency_records').get() as { c: number };
      assert.equal(count.c, 0);
    } finally {
      db.close();
    }
  });

  it('R33 read-side row/envelope operation mismatch fails closed in isolation', () => {
    const db = rawDb();
    try {
      insertWorkspace(db, 'ws-1');
      // Row operation is task.accept while the stored envelope says task.cancel;
      // every other field (hashes, status pair, JSON, canonical form) is valid,
      // so only the operation-mismatch integrity branch can reject the read.
      const mismatchedEnvelope = buildTaskResultEnvelopeV1('task.cancel', makeTask());
      insertRawRow(db, {
        operation: 'task.accept',
        resultJson: canonicalizeJson(mismatchedEnvelope),
        resultHash: hashCanonicalJson(mismatchedEnvelope),
        httpStatus: 200,
      });
      const repo = new IdempotencyRepository(db);
      assert.throws(
        () => repo.findVerifiedByScope('ws-1', 'task.accept', HASH64),
        IdempotencyRecordInvalidError,
      );
    } finally {
      db.close();
    }
  });

  it('R34 run.start 202 round trip preserves canonical Operation envelope and hash', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const repo = new IdempotencyRepository(db);
      const envelope = makeStartEnvelope();
      const input = makeInput({
        operation: 'run.start',
        keyHash: hashNormalizedIdempotencyKey('run-start-key'),
        requestHash: hashIdempotencyRequest({
          operation: 'run.start',
          workspaceId: 'ws-1',
          pathParams: { runId: 'run_00000000000000000000000001' },
          domainInput: {},
          expectedVersion: 1,
        }),
        envelope,
        httpStatus: 202,
      });
      const record = repo.insertCompleted(input);
      assert.equal(record.operation, 'run.start');
      assert.equal(record.httpStatus, 202);
      assert.deepEqual(record.envelope, envelope);
      assert.equal(record.resultHash, hashCanonicalJson(envelope));
      const row = db.prepare('SELECT result_json, result_hash, result_schema_version, http_status FROM idempotency_records WHERE id = ?').get(input.id) as {
        result_json: string;
        result_hash: string;
        result_schema_version: number;
        http_status: number;
      };
      assert.equal(row.result_json, canonicalizeJson(envelope));
      assert.equal(row.result_hash, hashCanonicalJson(envelope));
      assert.equal(row.result_schema_version, 1);
      assert.equal(row.http_status, 202);
      assert.deepEqual(repo.findVerifiedByScope('ws-1', 'run.start', input.keyHash), record);
    } finally {
      db.close();
    }
  });

  it('R35 run.start accepts only 202 and Legacy operations reject 202', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const repo = new IdempotencyRepository(db);
      assert.throws(
        () => repo.insertCompleted(makeInput({ operation: 'run.start', envelope: makeStartEnvelope(), httpStatus: 200 })),
        IdempotencyRecordInvalidError,
      );
      assert.throws(
        () => repo.insertCompleted(makeInput({ operation: 'run.start', envelope: makeStartEnvelope(), httpStatus: 201 })),
        IdempotencyRecordInvalidError,
      );
      assert.throws(
        () => repo.insertCompleted(makeInput({ httpStatus: 202 })),
        IdempotencyRecordInvalidError,
      );
    } finally {
      db.close();
    }
  });

  it('R36 tampered run.start result JSON or hash fails closed', () => {
    const db = rawDb();
    try {
      insertWorkspace(db, 'ws-1');
      const envelope = makeStartEnvelope();
      insertRawRow(db, {
        operation: 'run.start',
        httpStatus: 202,
        resultJson: canonicalizeJson(envelope),
        resultHash: 'd'.repeat(64),
      });
      const repo = new IdempotencyRepository(db);
      assert.throws(() => repo.findVerifiedByScope('ws-1', 'run.start', HASH64), IdempotencyRecordInvalidError);
    } finally {
      db.close();
    }

    const jsonDb = rawDb();
    try {
      insertWorkspace(jsonDb, 'ws-1');
      const envelope = makeStartEnvelope();
      const tamperedJson = canonicalizeJson({
        ...envelope,
        body: { operation: { ...envelope.body.operation, status: 'running' } },
      });
      insertRawRow(jsonDb, {
        operation: 'run.start',
        httpStatus: 202,
        resultJson: tamperedJson,
        resultHash: hashCanonicalJson(JSON.parse(tamperedJson)),
      });
      const repo = new IdempotencyRepository(jsonDb);
      assert.throws(() => repo.findVerifiedByScope('ws-1', 'run.start', HASH64), IdempotencyRecordInvalidError);
    } finally {
      jsonDb.close();
    }
  });

  it('R39 read-side run.start and Legacy HTTP status pair tampering fails closed', () => {
    const db = rawDb();
    try {
      insertWorkspace(db, 'ws-1');
      const startEnvelope = makeStartEnvelope();
      insertRawRow(db, {
        operation: 'run.start',
        httpStatus: 200,
        resultJson: canonicalizeJson(startEnvelope),
        resultHash: hashCanonicalJson(startEnvelope),
      });
      const repo = new IdempotencyRepository(db);
      assert.throws(() => repo.findVerifiedByScope('ws-1', 'run.start', HASH64), IdempotencyRecordInvalidError);
    } finally {
      db.close();
    }

    const legacyDb = rawDb();
    try {
      insertWorkspace(legacyDb, 'ws-1');
      const legacyEnvelope = makeEnvelope();
      insertRawRow(legacyDb, {
        operation: 'task.create',
        httpStatus: 202,
        resultJson: canonicalizeJson(legacyEnvelope),
        resultHash: hashCanonicalJson(legacyEnvelope),
      });
      const repo = new IdempotencyRepository(legacyDb);
      assert.throws(() => repo.findVerifiedByScope('ws-1', 'task.create', HASH64), IdempotencyRecordInvalidError);
    } finally {
      legacyDb.close();
    }
  });

  it('R40 run.retry 201 round trip preserves the dedicated canonical envelope and hash', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const repo = new IdempotencyRepository(db);
      const input = makeRetryInput();
      const record = repo.insertCompleted(input);
      assert.equal(record.operation, 'run.retry');
      assert.equal(record.httpStatus, 201);
      assert.equal(record.resultSchemaVersion, 1);
      assert.deepEqual(record.envelope, input.envelope);
      assert.equal(record.resultHash, hashCanonicalJson(input.envelope));
      const row = db.prepare('SELECT result_json, result_hash, result_schema_version, http_status FROM idempotency_records WHERE id = ?').get(input.id) as {
        result_json: string;
        result_hash: string;
        result_schema_version: number;
        http_status: number;
      };
      assert.equal(row.result_json, canonicalizeJson(input.envelope));
      assert.equal(row.result_hash, hashCanonicalJson(input.envelope));
      assert.equal(row.result_schema_version, 1);
      assert.equal(row.http_status, 201);
      assert.deepEqual(repo.findVerifiedByScope('ws-1', 'run.retry', input.keyHash), record);
    } finally {
      db.close();
    }
  });

  it('R41 run.retry accepts only 201 and rejects wrong envelope/status pairs', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const repo = new IdempotencyRepository(db);
      assert.throws(() => repo.insertCompleted(makeRetryInput({ httpStatus: 200 })), IdempotencyRecordInvalidError);
      assert.throws(() => repo.insertCompleted(makeRetryInput({ httpStatus: 202 })), IdempotencyRecordInvalidError);
      assert.throws(
        () => repo.insertCompleted(makeRetryInput({ envelope: makeStartEnvelope(), httpStatus: 201 })),
        IdempotencyRecordInvalidError,
      );
      const mismatched = JSON.parse(JSON.stringify(makeRetryEnvelope()));
      mismatched.body.run.workspaceId = 'ws-2';
      assert.throws(
        () => repo.insertCompleted(makeRetryInput({ envelope: mismatched })),
        IdempotencyRecordInvalidError,
      );
      const raw = rawDb();
      try {
        insertWorkspace(raw, 'ws-1');
        const envelope = makeRetryEnvelope();
        insertRawRow(raw, {
          operation: 'run.retry',
          httpStatus: 202,
          resultJson: canonicalizeJson(envelope),
          resultHash: hashCanonicalJson(envelope),
        });
        assert.throws(() => new IdempotencyRepository(raw).findVerifiedByScope('ws-1', 'run.retry', HASH64), IdempotencyRecordInvalidError);
      } finally {
        raw.close();
      }
    } finally {
      db.close();
    }
  });

  it('R42 tampered Retry JSON or hash fails closed without leaking values', () => {
    const db = rawDb();
    try {
      insertWorkspace(db, 'ws-1');
      const envelope = makeRetryEnvelope();
      insertRawRow(db, {
        operation: 'run.retry',
        httpStatus: 201,
        resultJson: canonicalizeJson(envelope),
        resultHash: 'd'.repeat(64),
      });
      assert.throws(() => new IdempotencyRepository(db).findVerifiedByScope('ws-1', 'run.retry', HASH64), IdempotencyRecordInvalidError);
    } finally {
      db.close();
    }

    const jsonDb = rawDb();
    try {
      insertWorkspace(jsonDb, 'ws-1');
      const envelope = makeRetryEnvelope();
      const tamperedJson = canonicalizeJson({
        ...envelope,
        body: { ...envelope.body, operation: { ...envelope.body.operation, result: { resourceType: 'run', resourceId: 'run_other' } } },
      });
      insertRawRow(jsonDb, {
        operation: 'run.retry',
        httpStatus: 201,
        resultJson: tamperedJson,
        resultHash: hashCanonicalJson(JSON.parse(tamperedJson)),
      });
      assert.throws(() => new IdempotencyRepository(jsonDb).findVerifiedByScope('ws-1', 'run.retry', HASH64), IdempotencyRecordInvalidError);
    } finally {
      jsonDb.close();
    }

    const workspaceDb = rawDb();
    try {
      insertWorkspace(workspaceDb, 'ws-1');
      const envelope = makeRetryEnvelope();
      const tamperedWorkspace = JSON.parse(JSON.stringify(envelope));
      tamperedWorkspace.body.operation.workspaceId = 'ws-2';
      const resultJson = canonicalizeJson(tamperedWorkspace);
      insertRawRow(workspaceDb, {
        operation: 'run.retry',
        httpStatus: 201,
        resultJson,
        resultHash: hashCanonicalJson(tamperedWorkspace),
      });
      assert.throws(() => new IdempotencyRepository(workspaceDb).findVerifiedByScope('ws-1', 'run.retry', HASH64), IdempotencyRecordInvalidError);
    } finally {
      workspaceDb.close();
    }
  });

  it('R38 two independent connections produce one run.start unique-scope winner', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p3c0a-idem-race-'));
    const databasePath = path.join(root, 'idempotency-race.sqlite');
    let db: Db | undefined;
    try {
      db = migratedDb(databasePath);
      insertWorkspace(db, 'ws-1');
      const input = makeStartInput();
      const fingerprintInput = makeStartFingerprintInput();
      assert.equal(input.keyHash, hashNormalizedIdempotencyKey(START_NORMALIZED_KEY));
      assert.equal(input.requestHash, hashIdempotencyRequest(fingerprintInput));
      db.close();
      db = undefined;
      const gate = new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT);
      const workerData: Omit<IdempotencyRaceWorkerData, 'mode'> = {
        dbPath: databasePath,
        workspaceId: 'ws-1',
        normalizedKey: START_NORMALIZED_KEY,
        fingerprintInput,
        keyHash: input.keyHash,
        requestHash: input.requestHash,
        envelope: makeStartEnvelope(),
        gate,
      };
      const results = await Promise.all([
        spawnIdempotencyRaceWorker({ mode: 'run-start-race', ...workerData }),
        spawnIdempotencyRaceWorker({ mode: 'run-start-race', ...workerData }),
      ]);
      for (const result of results) {
        assert.equal(result.preparedWorkspaceId, input.workspaceId);
        assert.equal(result.preparedOperation, input.operation);
        assert.equal(result.preparedKeyHash, input.keyHash);
        assert.equal(result.preparedRequestHash, input.requestHash);
      }
      assert.equal(results.filter(result => result.outcome === 'winner').length, 1);
      assert.equal(results.filter(result => result.outcome === 'loser').length, 1);
      const winner = results.find(result => result.outcome === 'winner');
      assert.ok(winner);
      assert.equal(winner.recordHttpStatus, 202);
      assert.deepEqual(winner.recordEnvelope, input.envelope);
      assert.equal(winner.resultHash, hashCanonicalJson(input.envelope));
      const loser = results.find(result => result.outcome === 'loser');
      assert.ok(loser);
      assert.equal(loser.errorCode, 'ERR_SQLITE_ERROR');
      assert.equal(
        loser.errorMessage,
        'UNIQUE constraint failed: idempotency_records.workspace_id, idempotency_records.operation, idempotency_records.key_hash',
      );
      assert.equal(loser.replayHttpStatus, 202);
      assert.deepEqual(loser.replayEnvelope, input.envelope);

      const verify = migratedDb(databasePath);
      try {
        const repo = new IdempotencyRepository(verify);
        const found = repo.findVerifiedByScope('ws-1', 'run.start', input.keyHash);
        assert.ok(found);
        assert.equal(found.httpStatus, 202);
        assert.equal(found.resultSchemaVersion, 1);
        if (found.envelope.operation !== 'run.start') throw new Error('expected run.start stored envelope');
        assert.deepEqual(found.envelope, input.envelope);
        assert.equal(found.resultHash, hashCanonicalJson(input.envelope));
        assert.equal((verify.prepare('SELECT COUNT(*) AS count FROM idempotency_records').get() as { count: number }).count, 1);
        const persisted = verify.prepare('SELECT * FROM idempotency_records WHERE id = ?').get(found.id) as Record<string, unknown>;
        assert.equal(persisted.result_json, canonicalizeJson(input.envelope));
        assert.equal(JSON.stringify(persisted).includes(START_NORMALIZED_KEY), false);
        assert.equal(JSON.stringify(persisted).includes(RAW_KEY), false);
        const operation = found.envelope.body.operation;
        assert.equal(operation.type, 'run.start');
        assert.equal(operation.status, 'queued');
        assert.equal(operation.version, 1);
        assert.equal(operation.aggregateType, 'run');
        assert.equal(operation.aggregateId, operation.runId);
        assert.equal(operation.correlationId, operation.id);
        for (const field of ['progress', 'result', 'error', 'startedAt', 'completedAt', 'updatedAt']) {
          assert.equal(field in operation, false);
        }
        assert.equal((verify.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
        assert.deepEqual(verify.prepare('PRAGMA foreign_key_check').all(), []);
      } finally {
        verify.close();
      }
    } finally {
      db?.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('R43 two independent connections produce one run.retry unique-scope winner and immutable replay', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p3c0b-idem-race-'));
    const databasePath = path.join(root, 'idempotency-retry-race.sqlite');
    let db: Db | undefined;
    try {
      db = migratedDb(databasePath);
      insertWorkspace(db, 'ws-1');
      const input = makeRetryInput();
      const fingerprintInput = makeRetryFingerprintInput();
      assert.equal(input.keyHash, hashNormalizedIdempotencyKey(RETRY_NORMALIZED_KEY));
      assert.equal(input.requestHash, hashIdempotencyRequest(fingerprintInput));
      db.close();
      db = undefined;
      const gate = new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT);
      const workerData: Omit<IdempotencyRaceWorkerData, 'mode'> = {
        dbPath: databasePath,
        workspaceId: 'ws-1',
        normalizedKey: RETRY_NORMALIZED_KEY,
        fingerprintInput,
        keyHash: input.keyHash,
        requestHash: input.requestHash,
        envelope: makeRetryEnvelope(),
        gate,
      };
      const results = await Promise.all([
        spawnIdempotencyRaceWorker({ mode: 'run-retry-race', ...workerData }),
        spawnIdempotencyRaceWorker({ mode: 'run-retry-race', ...workerData }),
      ]);
      for (const result of results) {
        assert.equal(result.preparedWorkspaceId, input.workspaceId);
        assert.equal(result.preparedOperation, input.operation);
        assert.equal(result.preparedKeyHash, input.keyHash);
        assert.equal(result.preparedRequestHash, input.requestHash);
      }
      assert.equal(results.filter(result => result.outcome === 'winner').length, 1);
      assert.equal(results.filter(result => result.outcome === 'loser').length, 1);
      const winner = results.find(result => result.outcome === 'winner');
      assert.ok(winner);
      assert.equal(winner.recordHttpStatus, 201);
      assert.deepEqual(winner.recordEnvelope, input.envelope);
      assert.equal(winner.resultHash, hashCanonicalJson(input.envelope));
      const loser = results.find(result => result.outcome === 'loser');
      assert.ok(loser);
      assert.equal(loser.errorCode, 'ERR_SQLITE_ERROR');
      assert.equal(
        loser.errorMessage,
        'UNIQUE constraint failed: idempotency_records.workspace_id, idempotency_records.operation, idempotency_records.key_hash',
      );
      assert.equal(loser.replayHttpStatus, 201);
      assert.deepEqual(loser.replayEnvelope, input.envelope);

      const verify = migratedDb(databasePath);
      try {
        const repo = new IdempotencyRepository(verify);
        const found = repo.findVerifiedByScope('ws-1', 'run.retry', input.keyHash);
        assert.ok(found);
        assert.equal(found.httpStatus, 201);
        assert.equal(found.resultSchemaVersion, 1);
        assert.deepEqual(found.envelope, input.envelope);
        assert.equal(found.resultHash, hashCanonicalJson(input.envelope));
        assert.equal((verify.prepare('SELECT COUNT(*) AS count FROM idempotency_records').get() as { count: number }).count, 1);
        if (found.envelope.operation !== 'run.retry') throw new Error('expected run.retry stored envelope');
        assert.equal(found.envelope.body.run.status, 'queued');
        assert.equal(found.envelope.body.run.version, 1);
        assert.equal(found.envelope.body.operation.status, 'completed');
        assert.equal(found.envelope.body.operation.version, 3);
        assert.equal(found.envelope.body.operation.result.resourceId, found.envelope.body.run.id);
        assert.equal((verify.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
        assert.deepEqual(verify.prepare('PRAGMA foreign_key_check').all(), []);
      } finally {
        verify.close();
      }
    } finally {
      db?.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('M2.6 — SqliteStore idempotency wiring', () => {
  it('R31 accessor uses the same DB handle as runInTransaction (rollback removes the insert)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm26-idem-store-'));
    let store: SqliteStore | undefined;
    const expectedRollback = new Error('expected-rollback');
    try {
      store = new SqliteStore(root);
      store.getDatabase().prepare(`
        INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at)
        VALUES ('ws-1', 'ws-1', '/r/ws-1', '/r/ws-1', ?, ?, ?)
      `).run(NOW, NOW, NOW);
      const input = makeInput();
      assert.throws(() => {
        store!.runInTransaction(() => {
          store!.idempotencyRepository().insertCompleted(input);
          throw expectedRollback;
        });
      }, /expected-rollback/);
      assert.equal(
        store.idempotencyRepository().findVerifiedByScope('ws-1', 'task.create', input.keyHash),
        undefined,
      );
      store.runInTransaction(() => {
        store!.idempotencyRepository().insertCompleted(input);
      });
      assert.ok(store.idempotencyRepository().findVerifiedByScope('ws-1', 'task.create', input.keyHash));
    } finally {
      store?.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('R37 caller-owned transaction rollback and commit preserve run.start 202 replay', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p3c0a-idem-transaction-'));
    let store: SqliteStore | undefined;
    try {
      store = new SqliteStore(root);
      store.getDatabase().prepare(`
        INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at)
        VALUES ('ws-1', 'ws-1', '/r/ws-1', '/r/ws-1', ?, ?, ?)
      `).run(NOW, NOW, NOW);
      const input = makeStartInput();
      assert.throws(() => {
        store!.runInTransaction(() => {
          store!.idempotencyRepository().insertCompleted(input);
          throw new Error('expected-run-start-rollback');
        });
      }, /expected-run-start-rollback/);
      assert.equal(
        store.idempotencyRepository().findVerifiedByScope('ws-1', 'run.start', input.keyHash),
        undefined,
      );
      store.runInTransaction(() => {
        store!.idempotencyRepository().insertCompleted(input);
      });
      const replay = store.idempotencyRepository().findVerifiedByScope('ws-1', 'run.start', input.keyHash);
      assert.ok(replay);
      assert.equal(replay.httpStatus, 202);
      assert.deepEqual(replay.envelope, input.envelope);
      assert.equal((store.getDatabase().prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
      assert.deepEqual(store.getDatabase().prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      store?.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
}
