import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach, describe } from 'node:test';

import type { ApiOperationResult, ApiProblem } from '@agentos/shared';
import { MigrationRegistry } from '../migrations/registry.js';
import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import { inTransaction, type TransactionDatabase } from './Transaction.js';
import { createEntityId } from './Identity.js';
import { VersionConflictError } from './Version.js';
import {
  OperationNotFoundError,
  OperationRepository,
  OperationValidationError,
  type InsertOperationInput,
} from './OperationRepository.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): {
      all(...params: unknown[]): unknown[];
      get(...params: unknown[]): unknown;
      run(...params: unknown[]): { changes: number };
    };
    close(): void;
  };
};

type Db = InstanceType<typeof DatabaseSync>;

const WORKSPACE_ID = 'workspace-operation';
const OTHER_WORKSPACE_ID = 'workspace-other';
const TASK_ID = 'task-operation';
const OTHER_TASK_ID = 'task-other';
const RUN_ID = 'run-operation';
const OTHER_RUN_ID = 'run-other';
const NOW = '2026-08-04T00:00:00.000Z';
const LATER = '2026-08-04T00:00:01.000Z';

const SAMPLE_RESULT: ApiOperationResult = {
  resourceType: 'run',
  resourceId: RUN_ID,
  data: { accepted: true },
};

const SAMPLE_PROBLEM: ApiProblem = {
  type: 'https://agentos.dev/problems/operation-failed',
  title: 'Operation failed',
  status: 500,
  code: 'STARTUP_FAILED',
  detail: 'The startup command failed.',
  instance: '/api/operations/op-test',
  requestId: 'req-operation',
  retryable: false,
  context: { workspaceId: WORKSPACE_ID, runId: RUN_ID },
};

const databases: Db[] = [];

function migratedDb(): Db {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner(db, new MigrationRegistry([...DEFAULT_REGISTRY_MIGRATIONS])).run();
  seedWorkspaceAndRun(db, WORKSPACE_ID, TASK_ID, RUN_ID);
  databases.push(db);
  return db;
}

function seedWorkspaceAndRun(db: Db, workspaceId: string, taskId: string, runId: string): void {
  db.prepare(`
    INSERT INTO workspaces (
      id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(workspaceId, workspaceId, `/${workspaceId}`, `/${workspaceId}`, NOW, NOW, NOW);
  db.prepare(`
    INSERT INTO tasks (
      id, workspace_id, legacy_task_id, title, status, priority, created_by, created_at, updated_at
    ) VALUES (?, ?, NULL, ?, 'open', 'normal', 'test', ?, ?)
  `).run(taskId, workspaceId, 'Operation task', NOW, NOW);
  db.prepare(`
    INSERT INTO runs (
      id, workspace_id, task_id, root_run_id, status, reason, origin, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'queued', 'initial', 'v2_api', 'test', ?, ?)
  `).run(runId, workspaceId, taskId, runId, NOW, NOW);
}

function operationInput(overrides: Partial<InsertOperationInput> = {}): InsertOperationInput {
  const id = overrides.id ?? createEntityId('operation');
  const type = overrides.type ?? 'run.create';
  return {
    id,
    type,
    status: 'queued',
    workspaceId: WORKSPACE_ID,
    aggregateType: 'run',
    aggregateId: RUN_ID,
    runId: RUN_ID,
    correlationId: type === 'run.create' ? RUN_ID : id,
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
    ...overrides,
  };
}

function insertRawOperationRow(
  db: Db,
  input: {
    id: string;
    type: string;
    status: string;
    correlationId: string;
    startedAt: string | null;
    completedAt: string | null;
  },
): void {
  db.prepare(`
    INSERT INTO operations (
      id, type, status, workspace_id, aggregate_type, aggregate_id, run_id,
      correlation_id, result_json, error_json, created_at, started_at,
      completed_at, updated_at, version
    ) VALUES (?, ?, ?, ?, 'run', ?, ?, ?, NULL, NULL, ?, ?, ?, ?, 1)
  `).run(
    input.id,
    input.type,
    input.status,
    WORKSPACE_ID,
    RUN_ID,
    RUN_ID,
    input.correlationId,
    NOW,
    input.startedAt,
    input.completedAt,
    NOW,
  );
}

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

describe('OperationRepository', () => {
  test('insert/read maps an Operation row and finds by id/correlation', () => {
    const db = migratedDb();
    const repository = new OperationRepository(db);
    const input = operationInput();

    const inserted = repository.insert(input);

    assert.deepEqual(inserted, {
      id: input.id,
      type: 'run.create',
      status: 'queued',
      workspaceId: WORKSPACE_ID,
      aggregateType: 'run',
      aggregateId: RUN_ID,
      runId: RUN_ID,
      correlationId: RUN_ID,
      createdAt: NOW,
      version: 1,
    });
    assert.deepEqual(repository.findById(WORKSPACE_ID, input.id), inserted);
    assert.deepEqual(repository.findByCorrelationId(WORKSPACE_ID, RUN_ID), inserted);
    assert.equal(repository.findById('other-workspace', input.id), undefined);
  });

  test('findWorkspaceIdByOpaqueId resolves only the owning workspace', () => {
    const db = migratedDb();
    seedWorkspaceAndRun(db, OTHER_WORKSPACE_ID, OTHER_TASK_ID, OTHER_RUN_ID);
    const repository = new OperationRepository(db);
    const first = repository.insert(operationInput());
    const other = repository.insert(operationInput({
      workspaceId: OTHER_WORKSPACE_ID,
      aggregateId: OTHER_RUN_ID,
      runId: OTHER_RUN_ID,
      correlationId: OTHER_RUN_ID,
    }));

    assert.equal(repository.findWorkspaceIdByOpaqueId(first.id), WORKSPACE_ID);
    assert.equal(repository.findWorkspaceIdByOpaqueId(other.id), OTHER_WORKSPACE_ID);
    assert.equal(repository.findWorkspaceIdByOpaqueId(createEntityId('operation')), undefined);
  });

  test('findWorkspaceIdByOpaqueId is status-independent and does not mutate the Operation row', () => {
    const db = migratedDb();
    const repository = new OperationRepository(db);
    const operations = [
      repository.insert(operationInput({ type: 'run.start', status: 'queued' })),
      repository.insert(operationInput({ type: 'run.start', status: 'running', startedAt: NOW })),
      repository.insert(operationInput({ type: 'run.start', status: 'completed', startedAt: NOW, completedAt: LATER, result: SAMPLE_RESULT })),
      repository.insert(operationInput({ type: 'run.start', status: 'failed', startedAt: NOW, completedAt: LATER, error: SAMPLE_PROBLEM })),
      repository.insert(operationInput({ type: 'run.start', status: 'cancelled', completedAt: LATER })),
    ];

    for (const operation of operations) {
      const before = repository.findById(WORKSPACE_ID, operation.id);
      const countBefore = (db.prepare('SELECT COUNT(*) AS count FROM operations WHERE id = ?').get(operation.id) as { count: number }).count;

      assert.equal(repository.findWorkspaceIdByOpaqueId(operation.id), WORKSPACE_ID);
      assert.equal(repository.findWorkspaceIdByOpaqueId(operation.id), WORKSPACE_ID);

      const after = repository.findById(WORKSPACE_ID, operation.id);
      const countAfter = (db.prepare('SELECT COUNT(*) AS count FROM operations WHERE id = ?').get(operation.id) as { count: number }).count;
      assert.deepEqual(after, before);
      assert.equal(after?.version, before?.version);
      assert.equal(countAfter, countBefore);
    }
  });

  test('enforces M3-TD-26 correlation binding before every insert', () => {
    const db = migratedDb();
    const repository = new OperationRepository(db);
    const create = repository.insert(operationInput({ type: 'run.create' }));
    const start = repository.insert(operationInput({ type: 'run.start' }));
    const cancel = repository.insert(operationInput({ type: 'run.cancel' }));
    const retry = repository.insert(operationInput({ type: 'run.retry' }));

    assert.equal(create.correlationId, RUN_ID);
    assert.equal(start.correlationId, start.id);
    assert.equal(cancel.correlationId, cancel.id);
    assert.equal(retry.correlationId, retry.id);

    const count = (): number => (db.prepare('SELECT COUNT(*) AS count FROM operations').get() as { count: number }).count;
    assert.equal(count(), 4);
    const invalidInputs: InsertOperationInput[] = [
      operationInput({ type: 'run.create', correlationId: createEntityId('operation') }),
      operationInput({ type: 'run.start', correlationId: RUN_ID }),
      operationInput({ type: 'run.cancel', correlationId: RUN_ID }),
      operationInput({ type: 'run.retry', correlationId: RUN_ID }),
    ];

    for (const invalid of invalidInputs) {
      assert.throws(
        () => repository.insert(invalid),
        (error: unknown) => error instanceof OperationValidationError
          && error.code === 'OPERATION_VALIDATION_FAILED',
      );
      assert.equal(count(), 4);
    }
  });

  test('mapper rejects a schema-valid correlation mismatch on every read path', () => {
    const db = migratedDb();
    const repository = new OperationRepository(db);
    const id = createEntityId('operation');
    insertRawOperationRow(db, {
      id,
      type: 'run.start',
      status: 'queued',
      correlationId: RUN_ID,
      startedAt: null,
      completedAt: null,
    });

    const assertClosed = (read: () => unknown): void => {
      assert.throws(
        read,
        (error: unknown) => error instanceof OperationValidationError
          && error.code === 'OPERATION_VALIDATION_FAILED',
      );
    };
    assertClosed(() => repository.findById(WORKSPACE_ID, id));
    assertClosed(() => repository.findByCorrelationId(WORKSPACE_ID, RUN_ID));
    assertClosed(() => repository.listByRun(WORKSPACE_ID, RUN_ID));
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM operations').get() as { count: number }).count, 1);
  });

  test('lists by workspace/run in created_at ASC, id ASC order and filters non-terminal type', () => {
    const db = migratedDb();
    const repository = new OperationRepository(db);
    const first = operationInput({
      type: 'run.start',
      createdAt: NOW,
    });
    const second = operationInput({
      type: 'run.retry',
      createdAt: LATER,
    });
    const terminal = operationInput({
      type: 'run.cancel',
      status: 'cancelled',
      createdAt: LATER,
      completedAt: LATER,
    });
    repository.insert(second);
    repository.insert(first);
    repository.insert(terminal);

    assert.deepEqual(
      repository.listByRun(WORKSPACE_ID, RUN_ID).map(operation => operation.id),
      [first.id, second.id, terminal.id],
    );
    assert.deepEqual(
      repository.listNonTerminalByRunAndType(WORKSPACE_ID, RUN_ID, 'run.start')
        .map(operation => operation.id),
      [first.id],
    );
    assert.deepEqual(
      repository.listNonTerminalByRunAndType(WORKSPACE_ID, RUN_ID, 'run.cancel'),
      [],
    );
  });

  test('all list and find queries enforce workspace isolation', () => {
    const db = migratedDb();
    seedWorkspaceAndRun(db, OTHER_WORKSPACE_ID, OTHER_TASK_ID, OTHER_RUN_ID);
    const repository = new OperationRepository(db);
    const operation = operationInput({
      type: 'run.start',
      aggregateId: OTHER_RUN_ID,
      runId: OTHER_RUN_ID,
      workspaceId: OTHER_WORKSPACE_ID,
    });
    repository.insert(operation);

    assert.equal(repository.findById(WORKSPACE_ID, operation.id), undefined);
    assert.equal(repository.findByCorrelationId(WORKSPACE_ID, operation.correlationId), undefined);
    assert.deepEqual(repository.listByRun(WORKSPACE_ID, OTHER_RUN_ID), []);
    assert.deepEqual(repository.listNonTerminalByRunAndType(WORKSPACE_ID, OTHER_RUN_ID, 'run.start'), []);
  });

  test('expected status/version update increments version and rejects stale writers', () => {
    const db = migratedDb();
    const repository = new OperationRepository(db);
    const operation = repository.insert(operationInput({
      type: 'run.start',
    }));

    const updated = repository.update({
      workspaceId: WORKSPACE_ID,
      operationId: operation.id,
      expectedStatus: 'queued',
      expectedVersion: 1,
      status: 'running',
      startedAt: LATER,
      completedAt: null,
      result: null,
      error: null,
      updatedAt: LATER,
    });
    assert.equal(updated.status, 'running');
    assert.equal(updated.startedAt, LATER);
    assert.equal(updated.version, 2);

    assert.throws(
      () => repository.update({
        workspaceId: WORKSPACE_ID,
        operationId: operation.id,
        expectedStatus: 'queued',
        expectedVersion: 1,
        status: 'failed',
        startedAt: LATER,
        completedAt: LATER,
        result: null,
        error: SAMPLE_PROBLEM,
        updatedAt: LATER,
      }),
      (error: unknown) => error instanceof VersionConflictError && error.code === 'VERSION_CONFLICT',
    );
  });

  test('result_json and error_json round-trip as typed payloads', () => {
    const db = migratedDb();
    const repository = new OperationRepository(db);
    const completed = repository.insert(operationInput({
      type: 'run.start',
      status: 'completed',
      startedAt: NOW,
      completedAt: LATER,
      result: SAMPLE_RESULT,
    }));
    const failed = repository.insert(operationInput({
      type: 'run.retry',
      status: 'failed',
      completedAt: LATER,
      error: SAMPLE_PROBLEM,
    }));

    assert.deepEqual(repository.findById(WORKSPACE_ID, completed.id)?.result, SAMPLE_RESULT);
    assert.deepEqual(repository.findById(WORKSPACE_ID, failed.id)?.error, SAMPLE_PROBLEM);
    assert.equal(repository.findById(WORKSPACE_ID, completed.id)?.error, undefined);
    assert.equal(repository.findById(WORKSPACE_ID, failed.id)?.result, undefined);
  });

  test('rejects every non-JSON Value before writing result_json', () => {
    class PayloadClass {
      readonly value = 'class-instance';
    }
    const sparse: unknown[] = [];
    sparse.length = 1;
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const customPrototype: Record<string, unknown> = Object.create({ inherited: true });
    customPrototype.value = 'custom-prototype';
    const customToJson: Record<string, unknown> = {
      value: 'custom-to-json',
      toJSON: () => ({ value: 'transformed' }),
    };
    const invalidData: Array<[string, unknown]> = [
      ['undefined', undefined],
      ['function', () => 'function'],
      ['symbol', Symbol('operation')],
      ['bigint', 1n],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
      ['sparse array', sparse],
      ['Date', new Date(NOW)],
      ['Map', new Map([['key', 'value']])],
      ['Set', new Set(['value'])],
      ['class instance', new PayloadClass()],
      ['circular object', cyclic],
      ['custom prototype', customPrototype],
      ['custom toJSON', customToJson],
    ];

    for (const [label, data] of invalidData) {
      const db = migratedDb();
      const repository = new OperationRepository(db);
      const result: ApiOperationResult = { resourceType: 'run', resourceId: RUN_ID, data };
      assert.throws(
        () => repository.insert(operationInput({
          type: 'run.start',
          status: 'completed',
          startedAt: NOW,
          completedAt: LATER,
          result,
        })),
        (error: unknown) => error instanceof OperationValidationError
          && error.code === 'OPERATION_VALIDATION_FAILED',
        label,
      );
      assert.equal(
        (db.prepare('SELECT COUNT(*) AS count FROM operations').get() as { count: number }).count,
        0,
        label,
      );
    }
  });

  test('preserves nested JSON Values without loss during result round-trip', () => {
    const db = migratedDb();
    const repository = new OperationRepository(db);
    const nested: ApiOperationResult = {
      resourceType: 'run',
      resourceId: RUN_ID,
      data: {
        nullValue: null,
        booleanValue: true,
        numberValue: 12.5,
        stringValue: 'nested',
        arrayValue: [null, false, { child: ['value', 3] }],
        objectValue: { nested: { key: 'value' } },
      },
    };
    const inserted = repository.insert(operationInput({
      type: 'run.start',
      status: 'completed',
      startedAt: NOW,
      completedAt: LATER,
      result: nested,
    }));
    const raw = db.prepare('SELECT result_json FROM operations WHERE id = ?').get(inserted.id) as {
      result_json: string;
    };

    assert.deepEqual(inserted.result, nested);
    assert.deepEqual(repository.findById(WORKSPACE_ID, inserted.id)?.result, nested);
    assert.deepEqual(JSON.parse(raw.result_json), nested);
  });

  test('enforces ApiProblem exact shape and retryAfterMs range before writing error_json', () => {
    const invalidProblems = [
      { ...SAMPLE_PROBLEM, extra: 'unexpected' },
      {
        ...SAMPLE_PROBLEM,
        errors: [{ field: 'runId', code: 'INVALID', message: 'invalid', extra: 'unexpected' }],
      },
      {
        ...SAMPLE_PROBLEM,
        context: { workspaceId: WORKSPACE_ID, runId: RUN_ID, extra: 'unexpected' },
      },
      { ...SAMPLE_PROBLEM, retryAfterMs: -1 },
    ];

    for (const problem of invalidProblems) {
      const db = migratedDb();
      const repository = new OperationRepository(db);
      assert.throws(
        () => repository.insert(operationInput({
          type: 'run.retry',
          status: 'failed',
          completedAt: LATER,
          error: problem,
        })),
        (error: unknown) => error instanceof OperationValidationError
          && error.code === 'OPERATION_VALIDATION_FAILED',
      );
      assert.equal(
        (db.prepare('SELECT COUNT(*) AS count FROM operations').get() as { count: number }).count,
        0,
      );
    }
  });

  test('accepts the exact state and timestamp combinations', () => {
    const db = migratedDb();
    const repository = new OperationRepository(db);
    const legal: Array<Partial<InsertOperationInput>> = [
      { status: 'queued' },
      { status: 'running', startedAt: NOW },
      { status: 'waiting_approval', startedAt: NOW },
      { status: 'paused', startedAt: NOW },
      { status: 'completed', startedAt: NOW, completedAt: LATER },
      { status: 'failed', completedAt: LATER, error: SAMPLE_PROBLEM },
      { status: 'failed', startedAt: NOW, completedAt: LATER, error: SAMPLE_PROBLEM },
      { status: 'cancelled', completedAt: LATER },
      { status: 'cancelled', startedAt: NOW, completedAt: LATER },
    ];

    for (const input of legal) {
      assert.doesNotThrow(() => repository.insert(operationInput({ type: 'run.start', ...input })));
    }
    assert.equal(repository.listByRun(WORKSPACE_ID, RUN_ID).length, legal.length);
  });

  test('rejects every invalid state and timestamp combination before insert/update SQL', () => {
    const db = migratedDb();
    const repository = new OperationRepository(db);
    const invalid: Array<Partial<InsertOperationInput>> = [
      { status: 'queued', startedAt: NOW },
      { status: 'queued', completedAt: LATER },
      { status: 'running' },
      { status: 'running', startedAt: NOW, completedAt: LATER },
      { status: 'waiting_approval' },
      { status: 'waiting_approval', startedAt: NOW, completedAt: LATER },
      { status: 'paused' },
      { status: 'paused', startedAt: NOW, completedAt: LATER },
      { status: 'completed', completedAt: LATER },
      { status: 'completed', startedAt: NOW },
      { status: 'failed', error: SAMPLE_PROBLEM },
      { status: 'cancelled' },
    ];

    for (const input of invalid) {
      assert.throws(
        () => repository.insert(operationInput({ type: 'run.start', ...input })),
        (error: unknown) => error instanceof OperationValidationError
          && error.code === 'OPERATION_VALIDATION_FAILED',
      );
    }
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM operations').get() as { count: number }).count, 0);

    const operation = repository.insert(operationInput({ type: 'run.start' }));
    assert.throws(
      () => repository.update({
        workspaceId: WORKSPACE_ID,
        operationId: operation.id,
        expectedStatus: 'queued',
        expectedVersion: 1,
        status: 'running',
        startedAt: null,
        completedAt: null,
        result: null,
        error: null,
        updatedAt: LATER,
      }),
      (error: unknown) => error instanceof OperationValidationError
        && error.code === 'OPERATION_VALIDATION_FAILED',
    );
    assert.equal(repository.findById(WORKSPACE_ID, operation.id)?.version, 1);
  });

  test('mapper rejects schema-valid rows with invalid state and timestamp combinations', () => {
    const db = migratedDb();
    const repository = new OperationRepository(db);
    const invalid: Array<{
      status: string;
      startedAt: string | null;
      completedAt: string | null;
    }> = [
      { status: 'queued', startedAt: NOW, completedAt: null },
      { status: 'queued', startedAt: null, completedAt: LATER },
      { status: 'running', startedAt: null, completedAt: null },
      { status: 'running', startedAt: NOW, completedAt: LATER },
      { status: 'waiting_approval', startedAt: null, completedAt: null },
      { status: 'waiting_approval', startedAt: NOW, completedAt: LATER },
      { status: 'paused', startedAt: null, completedAt: null },
      { status: 'paused', startedAt: NOW, completedAt: LATER },
      { status: 'completed', startedAt: null, completedAt: LATER },
      { status: 'completed', startedAt: NOW, completedAt: null },
      { status: 'failed', startedAt: null, completedAt: null },
      { status: 'cancelled', startedAt: null, completedAt: null },
    ];

    for (const row of invalid) {
      const id = createEntityId('operation');
      insertRawOperationRow(db, {
        id,
        type: 'run.start',
        status: row.status,
        correlationId: id,
        startedAt: row.startedAt,
        completedAt: row.completedAt,
      });
      assert.throws(
        () => repository.findById(WORKSPACE_ID, id),
        (error: unknown) => error instanceof OperationValidationError
          && error.code === 'OPERATION_VALIDATION_FAILED',
      );
    }
  });

  test('malformed persisted JSON fails closed with OPERATION_VALIDATION_FAILED', () => {
    const db = migratedDb();
    const repository = new OperationRepository(db);
    const operation = repository.insert(operationInput());
    db.prepare('UPDATE operations SET result_json = ? WHERE id = ?').run('[]', operation.id);

    assert.throws(
      () => repository.findById(WORKSPACE_ID, operation.id),
      (error: unknown) => error instanceof OperationValidationError
        && error.code === 'OPERATION_VALIDATION_FAILED',
    );
  });

  test('missing update target is reported distinctly from a stale version', () => {
    const db = migratedDb();
    const repository = new OperationRepository(db);

    assert.throws(
      () => repository.update({
        workspaceId: WORKSPACE_ID,
        operationId: createEntityId('operation'),
        expectedStatus: 'queued',
        expectedVersion: 1,
        status: 'running',
        startedAt: NOW,
        completedAt: null,
        result: null,
        error: null,
        updatedAt: NOW,
      }),
      (error: unknown) => error instanceof OperationNotFoundError && error.code === 'OPERATION_NOT_FOUND',
    );
  });

  test('repository writes do not begin or end transactions', () => {
    const db = migratedDb();
    const statements: string[] = [];
    const trackedDb: TransactionDatabase = {
      exec(sql: string): void {
        statements.push(sql);
        db.exec(sql);
      },
      prepare(sql: string) {
        return db.prepare(sql);
      },
    };
    const repository = new OperationRepository(trackedDb);

    repository.insert(operationInput());

    assert.deepEqual(statements, []);
  });

  test('caller-owned transaction commits and rolls back repository writes', () => {
    const db = migratedDb();
    const repository = new OperationRepository(db);
    const committed = operationInput();
    const rolledBack = operationInput({
      type: 'run.start',
    });

    inTransaction(db, () => repository.insert(committed));
    assert.ok(repository.findById(WORKSPACE_ID, committed.id));
    assert.throws(() => inTransaction(db, () => {
      repository.insert(rolledBack);
      throw new Error('rollback test');
    }));
    assert.equal(repository.findById(WORKSPACE_ID, rolledBack.id), undefined);
  });

  test('SQLite identity, uniqueness, foreign key, integrity, and CHECK constraints remain active', () => {
    const db = migratedDb();
    const repository = new OperationRepository(db);
    const operation = repository.insert(operationInput());

    assert.throws(() => db.prepare(
      'UPDATE operations SET correlation_id = ? WHERE id = ?',
    ).run(createEntityId('operation'), operation.id));
    assert.throws(() => repository.insert(operationInput({
      type: 'run.start',
      correlationId: operation.correlationId,
    })));
    assert.throws(() => repository.insert(operationInput({
      type: 'run.start',
      aggregateId: 'missing-run',
      runId: 'missing-run',
      correlationId: createEntityId('operation'),
    })));

    assert.equal((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });

  test('invalid repository input fails before SQL writes', () => {
    const db = migratedDb();
    const repository = new OperationRepository(db);
    const invalid = JSON.parse(JSON.stringify({ ...operationInput(), type: 'operation.invalid' }));

    assert.throws(
      () => repository.insert(invalid),
      (error: unknown) => error instanceof OperationValidationError
        && error.code === 'OPERATION_VALIDATION_FAILED',
    );
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS count FROM operations').get() as { count: number }).count,
      0,
    );
  });
});

describe('OperationRepository — file-backed concurrency', () => {
  test('two connections with the same expected version have one winner', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentos-p3a-operation-'));
    const path = join(directory, 'operations.sqlite');
    const setup = new DatabaseSync(path);
    setup.exec('PRAGMA foreign_keys = ON');
    new MigrationRunner(setup, new MigrationRegistry([...DEFAULT_REGISTRY_MIGRATIONS])).run();
    seedWorkspaceAndRun(setup, WORKSPACE_ID, TASK_ID, RUN_ID);
    const seedRepository = new OperationRepository(setup);
    const operation = seedRepository.insert(operationInput({
      type: 'run.start',
    }));
    setup.close();

    const firstDb = new DatabaseSync(path);
    const secondDb = new DatabaseSync(path);
    firstDb.exec('PRAGMA foreign_keys = ON');
    secondDb.exec('PRAGMA foreign_keys = ON');
    const first = new OperationRepository(firstDb);
    const second = new OperationRepository(secondDb);
    const firstRead = first.findById(WORKSPACE_ID, operation.id)!;
    const secondRead = second.findById(WORKSPACE_ID, operation.id)!;
    assert.equal(firstRead.version, 1);
    assert.equal(secondRead.version, 1);

    inTransaction(firstDb, () => first.update({
      workspaceId: WORKSPACE_ID,
      operationId: operation.id,
      expectedStatus: 'queued',
      expectedVersion: firstRead.version,
      status: 'running',
      startedAt: LATER,
      completedAt: null,
      result: null,
      error: null,
      updatedAt: LATER,
    }));
    assert.throws(
      () => inTransaction(secondDb, () => second.update({
        workspaceId: WORKSPACE_ID,
        operationId: operation.id,
        expectedStatus: 'queued',
        expectedVersion: secondRead.version,
        status: 'cancelled',
        startedAt: null,
        completedAt: LATER,
        result: null,
        error: null,
        updatedAt: LATER,
      })),
      (error: unknown) => error instanceof VersionConflictError,
    );
    assert.equal(first.findById(WORKSPACE_ID, operation.id)?.status, 'running');
    assert.equal(first.findById(WORKSPACE_ID, operation.id)?.version, 2);

    firstDb.close();
    secondDb.close();
    rmSync(directory, { recursive: true, force: true });
  });
});
