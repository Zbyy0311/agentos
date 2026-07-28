import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { Run, Task } from '@agentos/shared';
import {
  buildRunResultEnvelopeV1,
  buildTaskResultEnvelopeV1,
  parseIdempotencyResultEnvelopeV1,
  IdempotencyRecordInvalidError,
  type IdempotencyRunDtoV1,
  type IdempotencyTaskDtoV1,
  type TaskResultEnvelopeV1,
} from './types.js';
import {
  hashIdempotencyRequest,
  hashNormalizedIdempotencyKey,
  IdempotencyKeyValidationError,
  type FingerprintInput,
} from './fingerprint.js';

const VALID_KEY = 'abc12345-XYZ_09:rest.of.key';
const HASH_HEX = /^[0-9a-f]{64}$/;

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task_00000000000000000000000001',
    workspaceId: 'ws_00000000000000000000000001',
    title: 'task title',
    status: 'open',
    priority: 'normal',
    createdBy: 'tester',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run_00000000000000000000000001',
    workspaceId: 'ws_00000000000000000000000001',
    taskId: 'task_00000000000000000000000001',
    rootRunId: 'run_00000000000000000000000001',
    status: 'queued',
    reason: 'initial',
    origin: 'v2_api',
    nextEventSequence: 1,
    createdBy: 'tester',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

function makeFingerprintInput(overrides: Partial<FingerprintInput> = {}): FingerprintInput {
  return {
    operation: 'task.create',
    workspaceId: 'ws_00000000000000000000000001',
    pathParams: {},
    domainInput: { title: 'task title' },
    expectedVersion: null,
    ...overrides,
  };
}

describe('M2.6 — normalized idempotency key hash', () => {
  it('hashes a valid normalized key to lowercase 64 hex', () => {
    const hash = hashNormalizedIdempotencyKey(VALID_KEY);
    assert.ok(HASH_HEX.test(hash));
  });

  it('matches SHA-256 over the UTF-8 bytes of the normalized key', () => {
    const expected = createHash('sha256').update(VALID_KEY, 'utf8').digest('hex');
    assert.equal(hashNormalizedIdempotencyKey(VALID_KEY), expected);
  });

  it('is deterministic for the same normalized key', () => {
    assert.equal(hashNormalizedIdempotencyKey(VALID_KEY), hashNormalizedIdempotencyKey(VALID_KEY));
  });

  it('rejects a key that is not fully trimmed', () => {
    assert.throws(() => hashNormalizedIdempotencyKey(` ${VALID_KEY}`), IdempotencyKeyValidationError);
    assert.throws(() => hashNormalizedIdempotencyKey(`${VALID_KEY} `), IdempotencyKeyValidationError);
    assert.throws(() => hashNormalizedIdempotencyKey(`\t${VALID_KEY}\n`), IdempotencyKeyValidationError);
  });

  it('rejects keys outside the 8-128 length range', () => {
    assert.throws(() => hashNormalizedIdempotencyKey('a'.repeat(7)), IdempotencyKeyValidationError);
    assert.throws(() => hashNormalizedIdempotencyKey('a'.repeat(129)), IdempotencyKeyValidationError);
    assert.ok(HASH_HEX.test(hashNormalizedIdempotencyKey('a'.repeat(8))));
    assert.ok(HASH_HEX.test(hashNormalizedIdempotencyKey('a'.repeat(128))));
  });

  it('rejects keys outside the allowed pattern', () => {
    assert.throws(() => hashNormalizedIdempotencyKey('.eadingdot1'), IdempotencyKeyValidationError);
    assert.throws(() => hashNormalizedIdempotencyKey('has space1'), IdempotencyKeyValidationError);
    assert.throws(() => hashNormalizedIdempotencyKey('has,comma1'), IdempotencyKeyValidationError);
    assert.throws(() => hashNormalizedIdempotencyKey('has/slash1'), IdempotencyKeyValidationError);
    assert.throws(() => hashNormalizedIdempotencyKey('unicodé-key'), IdempotencyKeyValidationError);
    assert.throws(() => hashNormalizedIdempotencyKey(''), IdempotencyKeyValidationError);
  });

  it('rejects non-string input', () => {
    assert.throws(() => hashNormalizedIdempotencyKey(undefined as unknown as string), IdempotencyKeyValidationError);
    assert.throws(() => hashNormalizedIdempotencyKey(123 as unknown as string), IdempotencyKeyValidationError);
  });

  it('error message never contains the key', () => {
    const secretish = 's3cr3t-key-value';
    try {
      hashNormalizedIdempotencyKey(` ${secretish}`);
      assert.fail('expected rejection');
    } catch (error) {
      assert.ok(error instanceof IdempotencyKeyValidationError);
      assert.ok(!String(error.message).includes(secretish));
      assert.ok(!String(error.message).includes('s3cr3t'));
    }
  });
});

describe('M2.6 — canonical request fingerprint', () => {
  it('produces a lowercase 64 hex hash', () => {
    assert.ok(HASH_HEX.test(hashIdempotencyRequest(makeFingerprintInput())));
  });

  it('object key order does not affect the hash', () => {
    const a = hashIdempotencyRequest(makeFingerprintInput({
      domainInput: { title: 't', priority: 'high' },
    }));
    const b = hashIdempotencyRequest(makeFingerprintInput({
      domainInput: { priority: 'high', title: 't' },
    }));
    assert.equal(a, b);
  });

  it('path param insertion order does not affect the hash', () => {
    const a = hashIdempotencyRequest(makeFingerprintInput({
      pathParams: { taskId: 'task_1', runId: 'run_1' },
    }));
    const b = hashIdempotencyRequest(makeFingerprintInput({
      pathParams: { runId: 'run_1', taskId: 'task_1' },
    }));
    assert.equal(a, b);
  });

  it('array order affects the hash', () => {
    const a = hashIdempotencyRequest(makeFingerprintInput({
      domainInput: { steps: ['a', 'b'] },
    }));
    const b = hashIdempotencyRequest(makeFingerprintInput({
      domainInput: { steps: ['b', 'a'] },
    }));
    assert.notEqual(a, b);
  });

  it('expectedVersion null and integer produce different hashes', () => {
    const without = hashIdempotencyRequest(makeFingerprintInput({ expectedVersion: null }));
    const withVersion = hashIdempotencyRequest(makeFingerprintInput({ expectedVersion: 1 }));
    assert.notEqual(without, withVersion);
  });

  it('operation and workspace participate in the hash', () => {
    const base = hashIdempotencyRequest(makeFingerprintInput());
    assert.notEqual(base, hashIdempotencyRequest(makeFingerprintInput({ operation: 'run.create' })));
    assert.notEqual(base, hashIdempotencyRequest(makeFingerprintInput({ workspaceId: 'ws_00000000000000000000000002' })));
  });

  it('rejects unsupported domain input values', () => {
    const date = new Date(0);
    const withAccessor = Object.defineProperty({}, 'x', { get: () => 1, enumerable: true });
    const sparse = new Array(2);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const badInputs: unknown[] = [
      undefined,
      date,
      new Map(),
      new Set(),
      new (class Foo {})(),
      withAccessor,
      Symbol('s'),
      sparse,
      circular,
      Number.POSITIVE_INFINITY,
      Number.NaN,
      10n,
      () => 1,
    ];
    for (const bad of badInputs) {
      assert.throws(
        () => hashIdempotencyRequest(makeFingerprintInput({ domainInput: { value: bad } })),
        /fingerprint/i,
        `expected rejection for ${String(bad)}`,
      );
    }
  });

  it('rejects invalid operation', () => {
    assert.throws(
      () => hashIdempotencyRequest(makeFingerprintInput({ operation: 'task.delete' as never })),
      /fingerprint/i,
    );
  });

  it('rejects invalid expectedVersion', () => {
    for (const expectedVersion of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(
        () => hashIdempotencyRequest(makeFingerprintInput({ expectedVersion })),
        /fingerprint/i,
      );
    }
  });

  it('rejects non-string path param values', () => {
    assert.throws(
      () => hashIdempotencyRequest(makeFingerprintInput({
        pathParams: { taskId: 123 as unknown as string },
      })),
      /fingerprint/i,
    );
  });
});

describe('M2.6 — typed result envelope builders', () => {
  it('buildTaskResultEnvelopeV1 emits the frozen task fields', () => {
    const envelope = buildTaskResultEnvelopeV1('task.create', makeTask({
      legacyTaskId: 'legacy-1',
      description: 'desc',
      sourceConversationId: 'conv-1',
      sourceMessageId: 'msg-1',
      acceptedRunId: 'run_1',
      pendingResultRunId: 'run_2',
      completedAt: '2026-01-02T00:00:00.000Z',
      archivedAt: '2026-01-03T00:00:00.000Z',
    }));
    assert.equal(envelope.schemaVersion, 1);
    assert.equal(envelope.operation, 'task.create');
    assert.deepEqual(envelope.body.task, {
      id: 'task_00000000000000000000000001',
      workspaceId: 'ws_00000000000000000000000001',
      legacyTaskId: 'legacy-1',
      title: 'task title',
      description: 'desc',
      status: 'open',
      priority: 'normal',
      sourceConversationId: 'conv-1',
      sourceMessageId: 'msg-1',
      acceptedRunId: 'run_1',
      pendingResultRunId: 'run_2',
      createdBy: 'tester',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-02T00:00:00.000Z',
      archivedAt: '2026-01-03T00:00:00.000Z',
      version: 1,
    });
  });

  it('undefined optional task fields are omitted, never null', () => {
    const envelope = buildTaskResultEnvelopeV1('task.create', makeTask());
    assert.deepEqual(Object.keys(envelope.body.task).sort(), [
      'createdAt', 'createdBy', 'id', 'priority', 'status', 'title', 'updatedAt', 'version', 'workspaceId',
    ]);
    for (const value of Object.values(envelope.body.task)) {
      assert.notEqual(value, null);
      assert.notEqual(value, undefined);
    }
  });

  it('buildRunResultEnvelopeV1 emits the frozen run fields', () => {
    const envelope = buildRunResultEnvelopeV1('run.create', makeRun({
      parentRunId: 'run_00000000000000000000000000',
      objective: 'objective',
      failureCode: 'X',
      failureMessage: 'Y',
      cancellationRequestedAt: '2026-01-02T00:00:00.000Z',
      startedAt: '2026-01-02T01:00:00.000Z',
      completedAt: '2026-01-02T02:00:00.000Z',
    }));
    assert.equal(envelope.schemaVersion, 1);
    assert.equal(envelope.operation, 'run.create');
    assert.equal(envelope.body.run.parentRunId, 'run_00000000000000000000000000');
    assert.equal(envelope.body.run.objective, 'objective');
    assert.equal(envelope.body.run.failureCode, 'X');
    assert.equal(envelope.body.run.failureMessage, 'Y');
    assert.equal(envelope.body.run.cancellationRequestedAt, '2026-01-02T00:00:00.000Z');
    assert.equal(envelope.body.run.startedAt, '2026-01-02T01:00:00.000Z');
    assert.equal(envelope.body.run.completedAt, '2026-01-02T02:00:00.000Z');
  });

  it('undefined optional run fields are omitted, never null', () => {
    const envelope = buildRunResultEnvelopeV1('run.cancel', makeRun());
    assert.deepEqual(Object.keys(envelope.body.run).sort(), [
      'createdAt', 'createdBy', 'id', 'nextEventSequence', 'origin', 'reason',
      'rootRunId', 'status', 'taskId', 'updatedAt', 'version', 'workspaceId',
    ]);
  });

  it('builder output is deep detached from the source entity', () => {
    const task = makeTask({ description: 'before' });
    const envelope = buildTaskResultEnvelopeV1('task.create', task);
    task.title = 'mutated';
    task.description = 'after';
    assert.equal(envelope.body.task.title, 'task title');
    assert.equal(envelope.body.task.description, 'before');
  });
});

describe('M2.6 — untrusted boundary envelope parser', () => {
  it('round-trips a built task envelope', () => {
    const envelope = buildTaskResultEnvelopeV1('task.accept', makeTask());
    const parsed = parseIdempotencyResultEnvelopeV1(
      JSON.parse(JSON.stringify(envelope)),
    ) as TaskResultEnvelopeV1;
    assert.deepEqual(parsed, envelope);
  });

  it('round-trips a built run envelope', () => {
    const envelope = buildRunResultEnvelopeV1('run.cancel', makeRun());
    const parsed = parseIdempotencyResultEnvelopeV1(JSON.parse(JSON.stringify(envelope)));
    assert.deepEqual(parsed, envelope);
  });

  it('rejects extra fields at every level', () => {
    const envelope = JSON.parse(JSON.stringify(buildTaskResultEnvelopeV1('task.create', makeTask())));
    const withRootExtra = { ...envelope, extra: 1 };
    assert.throws(() => parseIdempotencyResultEnvelopeV1(withRootExtra), IdempotencyRecordInvalidError);
    const withBodyExtra = { ...envelope, body: { ...envelope.body, extra: 1 } };
    assert.throws(() => parseIdempotencyResultEnvelopeV1(withBodyExtra), IdempotencyRecordInvalidError);
    const withDtoExtra = { ...envelope, body: { task: { ...envelope.body.task, extra: 1 } } };
    assert.throws(() => parseIdempotencyResultEnvelopeV1(withDtoExtra), IdempotencyRecordInvalidError);
  });

  it('rejects missing required fields', () => {
    const envelope = JSON.parse(JSON.stringify(buildTaskResultEnvelopeV1('task.create', makeTask())));
    delete envelope.body.task.title;
    assert.throws(() => parseIdempotencyResultEnvelopeV1(envelope), IdempotencyRecordInvalidError);
    const envelope2 = JSON.parse(JSON.stringify(buildRunResultEnvelopeV1('run.create', makeRun())));
    delete envelope2.body.run.rootRunId;
    assert.throws(() => parseIdempotencyResultEnvelopeV1(envelope2), IdempotencyRecordInvalidError);
  });

  it('rejects operation/body type mismatch', () => {
    const taskEnvelope = JSON.parse(JSON.stringify(buildTaskResultEnvelopeV1('task.create', makeTask())));
    const mismatched = { ...taskEnvelope, operation: 'run.create' };
    assert.throws(() => parseIdempotencyResultEnvelopeV1(mismatched), IdempotencyRecordInvalidError);
    const runEnvelope = JSON.parse(JSON.stringify(buildRunResultEnvelopeV1('run.create', makeRun())));
    const mismatched2 = { ...runEnvelope, operation: 'task.cancel' };
    assert.throws(() => parseIdempotencyResultEnvelopeV1(mismatched2), IdempotencyRecordInvalidError);
  });

  it('rejects invalid schemaVersion, enums and field types', () => {
    const envelope = JSON.parse(JSON.stringify(buildTaskResultEnvelopeV1('task.create', makeTask())));
    assert.throws(() => parseIdempotencyResultEnvelopeV1({ ...envelope, schemaVersion: 2 }), IdempotencyRecordInvalidError);
    const badStatus = JSON.parse(JSON.stringify(buildTaskResultEnvelopeV1('task.create', makeTask())));
    badStatus.body.task.status = 'archived';
    assert.throws(() => parseIdempotencyResultEnvelopeV1(badStatus), IdempotencyRecordInvalidError);
    const badType = JSON.parse(JSON.stringify(buildTaskResultEnvelopeV1('task.create', makeTask())));
    badType.body.task.title = 42;
    assert.throws(() => parseIdempotencyResultEnvelopeV1(badType), IdempotencyRecordInvalidError);
    const badPriority = JSON.parse(JSON.stringify(buildTaskResultEnvelopeV1('task.create', makeTask())));
    badPriority.body.task.priority = 'urgent';
    assert.throws(() => parseIdempotencyResultEnvelopeV1(badPriority), IdempotencyRecordInvalidError);
  });

  it('rejects non-positive or unsafe version numbers', () => {
    for (const version of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1']) {
      const envelope = JSON.parse(JSON.stringify(buildTaskResultEnvelopeV1('task.create', makeTask())));
      envelope.body.task.version = version;
      assert.throws(() => parseIdempotencyResultEnvelopeV1(envelope), IdempotencyRecordInvalidError);
    }
  });

  it('rejects null in place of omitted optional fields', () => {
    const envelope = JSON.parse(JSON.stringify(buildTaskResultEnvelopeV1('task.create', makeTask())));
    envelope.body.task.description = null;
    assert.throws(() => parseIdempotencyResultEnvelopeV1(envelope), IdempotencyRecordInvalidError);
  });

  it('returns a deep detached object', () => {
    const source = JSON.parse(JSON.stringify(buildRunResultEnvelopeV1('run.create', makeRun())));
    const parsed = parseIdempotencyResultEnvelopeV1(source);
    (source.body.run as IdempotencyRunDtoV1).objective = 'mutated';
    assert.notEqual((parsed as { body: { run: IdempotencyRunDtoV1 } }).body.run.objective, 'mutated');
  });

  it('rejects non-object and null input', () => {
    assert.throws(() => parseIdempotencyResultEnvelopeV1(null), IdempotencyRecordInvalidError);
    assert.throws(() => parseIdempotencyResultEnvelopeV1('x'), IdempotencyRecordInvalidError);
    assert.throws(() => parseIdempotencyResultEnvelopeV1([]), IdempotencyRecordInvalidError);
  });

  it('error message stays the fixed safe string', () => {
    try {
      parseIdempotencyResultEnvelopeV1({ schemaVersion: 1, operation: 'task.create', body: { task: { secret: 'value' } } });
      assert.fail('expected rejection');
    } catch (error) {
      assert.ok(error instanceof IdempotencyRecordInvalidError);
      assert.equal((error as Error).message, 'Idempotency record is invalid');
      assert.equal((error as IdempotencyRecordInvalidError).code, 'IDEMPOTENCY_RECORD_INVALID');
    }
  });

  it('task dto typing stays aligned with the builder', () => {
    const dto: IdempotencyTaskDtoV1 = buildTaskResultEnvelopeV1('task.create', makeTask()).body.task;
    assert.equal(dto.id, makeTask().id);
  });
});
