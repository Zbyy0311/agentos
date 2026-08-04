import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createEntityId,
  decodeUlidTimestamp,
  isValidEntityId,
  EntityIdGenerator,
  ENTITY_ID_PREFIXES,
  type EntityIdKind,
} from './Identity.js';

const kinds = Object.keys(ENTITY_ID_PREFIXES) as EntityIdKind[];

const EXPECTED_PREFIXES: Record<EntityIdKind, string> = {
  workspace: 'ws',
  agent: 'agent',
  provider: 'provider',
  providerSession: 'psess',
  workflow: 'workflow',
  workflowStage: 'wstage',
  task: 'task',
  run: 'run',
  stage: 'stage',
  snapshot: 'snapshot',
  event: 'evt',
  process: 'proc',
  worktree: 'wt',
  memory: 'mem',
  memoryCandidate: 'mcand',
  memoryContext: 'mctx',
  policy: 'policy',
  policyRule: 'prule',
  policyDecision: 'pdec',
  approval: 'approval',
  grant: 'grant',
  conversation: 'conv',
  message: 'msg',
  turn: 'turn',
  artifact: 'artifact',
  extension: 'ext',
  idempotency: 'idem',
  operation: 'op',
};

const MAX_TS = 2 ** 48 - 1; // 281474976710655

describe('Identity — canonical entity IDs', () => {
  // ---- production singleton tests ----

  it('all prefix constants map to valid EntityIdKind', () => {
    assert.equal(kinds.length, 28);
    for (const kind of kinds) {
      assert.ok(ENTITY_ID_PREFIXES[kind].length >= 2);
    }
  });

  it('createEntityId produces prefix_ulid format', () => {
    for (const kind of kinds) {
      const id = createEntityId(kind);
      assert.ok(id.startsWith(`${ENTITY_ID_PREFIXES[kind]}_`));
    }
  });

  it('ULID body is 26 Crockford Base32 characters, no ILOU', () => {
    for (const kind of kinds) {
      const id = createEntityId(kind);
      const body = id.slice(ENTITY_ID_PREFIXES[kind].length + 1);
      assert.equal(body.length, 26);
      assert.ok(/^[0-9A-HJKM-NP-TV-Z]{26}$/.test(body));
    }
  });

  it('same kind produces unique IDs', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) ids.add(createEntityId('task'));
    assert.equal(ids.size, 100);
  });

  it('same kind produces unique IDs under heavy load', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) ids.add(createEntityId('run'));
    assert.equal(ids.size, 1000);
  });

  it('different kinds have different prefixes', () => {
    assert.ok(createEntityId('workspace').startsWith('ws_'));
    assert.ok(createEntityId('task').startsWith('task_'));
  });

  it('isValidEntityId validates prefix and body', () => {
    const id = createEntityId('conversation');
    assert.ok(isValidEntityId(id, 'conversation'));
    assert.ok(!isValidEntityId(id, 'task'));
    assert.ok(!isValidEntityId('conv_ZZZ', 'conversation'));
    assert.ok(!isValidEntityId('conv_0123456789ABCDEFGHJKMNPQRSXXX', 'conversation'));
  });

  it('no database dependency', () => {
    assert.ok(createEntityId('workspace').startsWith('ws_'));
  });

  // ----  deterministic tests using EntityIdGenerator ----

  it('ULID matches known reference (timestamp=0, random=0)', () => {
    const g = new EntityIdGenerator({
      clock: () => 0,
      randomSource: () => new Uint8Array(10).fill(0),
    });
    assert.equal(g.createEntityId('run'), 'run_00000000000000000000000000');
  });

  it('first character always in 0–7 range', () => {
    const g = new EntityIdGenerator({
      clock: () => 0,
      randomSource: () => new Uint8Array(10).fill(0),
    });
    const body = g.createEntityId('run').slice('run_'.length);
    assert.equal(body[0], '0');
    assert.equal(body.slice(0, 10), '0000000000');
  });

  it('real 13-digit Unix-ms timestamp round-trips', () => {
    const testTs = 1_784_615_426_638;
    const g = new EntityIdGenerator({
      clock: () => testTs,
      randomSource: () => new Uint8Array(10).fill(0),
    });
    const body = g.createEntityId('task').slice('task_'.length);
    assert.equal(decodeUlidTimestamp(body), testTs);
  });

  it('maximum timestamp 2^48-1 round-trips and first char is 7', () => {
    const g = new EntityIdGenerator({
      clock: () => MAX_TS,
      randomSource: () => new Uint8Array(10).fill(0),
    });
    const body = g.createEntityId('task').slice('task_'.length);
    assert.equal(decodeUlidTimestamp(body), MAX_TS);
    assert.equal(body[0], '7');
  });

  it('timestamp = 2^48 is rejected', () => {
    assert.throws(
      () => new EntityIdGenerator({ clock: () => 2 ** 48, randomSource: () => new Uint8Array(10) }).createEntityId('task'),
      RangeError,
    );
  });

  it('negative timestamp is rejected', () => {
    assert.throws(
      () => new EntityIdGenerator({ clock: () => -1, randomSource: () => new Uint8Array(10) }).createEntityId('task'),
      RangeError,
    );
  });

  it('NaN timestamp is rejected', () => {
    assert.throws(
      () => new EntityIdGenerator({ clock: () => NaN, randomSource: () => new Uint8Array(10) }).createEntityId('task'),
      RangeError,
    );
  });

  it('Infinity timestamp is rejected', () => {
    assert.throws(
      () => new EntityIdGenerator({ clock: () => Infinity, randomSource: () => new Uint8Array(10) }).createEntityId('task'),
      RangeError,
    );
  });

  it('non-integer timestamp is rejected', () => {
    assert.throws(
      () => new EntityIdGenerator({ clock: () => 1.5, randomSource: () => new Uint8Array(10) }).createEntityId('task'),
      RangeError,
    );
  });

  it('randomness not exactly 10 bytes is rejected', () => {
    assert.throws(
      () => new EntityIdGenerator({ clock: () => 1, randomSource: () => new Uint8Array(9) }).createEntityId('task'),
      RangeError,
    );
    assert.throws(
      () => new EntityIdGenerator({ clock: () => 1, randomSource: () => new Uint8Array(11) }).createEntityId('task'),
      RangeError,
    );
  });

  it('time increase: same random, larger timestamp → strictly larger ID', () => {
    const g = new EntityIdGenerator({
      clock: () => 100,
      randomSource: () => new Uint8Array(10).fill(0),
    });
    const id1 = g.createEntityId('task');
    const g2 = new EntityIdGenerator({
      clock: () => 200,
      randomSource: () => new Uint8Array(10).fill(0),
    });
    const id2 = g2.createEntityId('task');
    assert.ok(id1 < id2, `${id1} < ${id2}`);
  });

  it('same ms: 200 IDs within single generator are strictly increasing', () => {
    const g = new EntityIdGenerator({
      clock: () => 100,
      randomSource: () => new Uint8Array(10).fill(0),
    });
    const ids: string[] = [];
    for (let i = 0; i < 200; i++) ids.push(g.createEntityId('run'));
    assert.equal(new Set(ids).size, 200);
    for (let i = 1; i < ids.length; i++) {
      assert.ok(ids[i - 1] < ids[i], `id[${i - 1}] < id[${i}]`);
    }
  });

  it('clock regression: same generator with clock [100, 50] produces id1 < id2', () => {
    let calls = 0;
    const g = new EntityIdGenerator({
      clock: () => (calls++ === 0 ? 100 : 50),
      randomSource: () => new Uint8Array(10).fill(0),
    });
    const id1 = g.createEntityId('run');
    const id2 = g.createEntityId('run');
    assert.ok(id1 < id2, `clock regression: ${id1} < ${id2}`);
  });

  it('two generators do not share state', () => {
    const ga = new EntityIdGenerator({
      clock: () => 100,
      randomSource: () => new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    });
    const gb = new EntityIdGenerator({
      clock: () => 50,
      randomSource: () => new Uint8Array([2, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    });
    const a1 = ga.createEntityId('run');
    const a2 = ga.createEntityId('run');
    const b1 = gb.createEntityId('run');
    const b2 = gb.createEntityId('run');
    assert.ok(a1 < a2);
    assert.ok(b1 < b2);
    assert.ok(b1 < a1);
    assert.ok(b2 < a1);
  });
});

describe('Identity — M2.5 snapshot kind', () => {
  it('snapshot kind exists with snapshot prefix', () => {
    assert.equal(ENTITY_ID_PREFIXES.snapshot, 'snapshot');
  });

  it('createEntityId snapshot starts with snapshot_ and validates', () => {
    const id = createEntityId('snapshot');
    assert.ok(id.startsWith('snapshot_'));
    assert.ok(isValidEntityId(id, 'snapshot'));
  });

  it('snapshot ULID body is 26 Crockford Base32 characters', () => {
    const id = createEntityId('snapshot');
    const body = id.slice('snapshot_'.length);
    assert.equal(body.length, 26);
    assert.ok(/^[0-9A-HJKM-NP-TV-Z]{26}$/.test(body));
  });

  it('snapshot prefix is not confused with other kinds', () => {
    const snapshotId = createEntityId('snapshot');
    assert.ok(!isValidEntityId(snapshotId, 'stage'));
    assert.ok(!isValidEntityId(snapshotId, 'run'));
    const stageId = createEntityId('stage');
    assert.ok(!isValidEntityId(stageId, 'snapshot'));
    const runId = createEntityId('run');
    assert.ok(!isValidEntityId(runId, 'snapshot'));
  });
});

describe('Identity — M2.6 idempotency kind', () => {
  it('idempotency kind exists with idem prefix', () => {
    assert.equal(ENTITY_ID_PREFIXES.idempotency, 'idem');
  });

  it('createEntityId idempotency starts with idem_ and validates', () => {
    const id = createEntityId('idempotency');
    assert.ok(id.startsWith('idem_'));
    assert.ok(isValidEntityId(id, 'idempotency'));
  });

  it('idempotency ULID body is 26 Crockford Base32 characters', () => {
    const id = createEntityId('idempotency');
    const body = id.slice('idem_'.length);
    assert.equal(body.length, 26);
    assert.ok(/^[0-9A-HJKM-NP-TV-Z]{26}$/.test(body));
  });

  it('idempotency ID is not recognized as snapshot/run/task', () => {
    const idemId = createEntityId('idempotency');
    assert.ok(!isValidEntityId(idemId, 'snapshot'));
    assert.ok(!isValidEntityId(idemId, 'run'));
    assert.ok(!isValidEntityId(idemId, 'task'));
    const snapshotId = createEntityId('snapshot');
    assert.ok(!isValidEntityId(snapshotId, 'idempotency'));
    const runId = createEntityId('run');
    assert.ok(!isValidEntityId(runId, 'idempotency'));
    const taskId = createEntityId('task');
    assert.ok(!isValidEntityId(taskId, 'idempotency'));
  });

  it('all 27 pre-operation kinds remain unchanged', () => {
    const priorKinds = kinds.filter((kind) => kind !== 'operation');
    assert.equal(priorKinds.length, 27);
    assert.ok(priorKinds.includes('idempotency'));
    assert.deepEqual(ENTITY_ID_PREFIXES, EXPECTED_PREFIXES);
    const operationId = createEntityId('operation');
    for (const kind of priorKinds) {
      const id = createEntityId(kind);
      assert.ok(isValidEntityId(id, kind));
      assert.ok(!isValidEntityId(id, 'operation'));
      assert.ok(!isValidEntityId(operationId, kind));
    }
  });
});

describe('Identity — M3 P3A operation kind', () => {
  it('operation kind exists with op prefix', () => {
    assert.equal(ENTITY_ID_PREFIXES.operation, 'op');
  });

  it('createEntityId operation starts with op_ and validates', () => {
    const id = createEntityId('operation');
    assert.ok(id.startsWith('op_'));
    assert.ok(isValidEntityId(id, 'operation'));
    assert.equal(id.slice('op_'.length).length, 26);
    assert.ok(/^[0-9A-HJKM-NP-TV-Z]{26}$/.test(id.slice('op_'.length)));
  });

  it('operation IDs remain distinct from all existing kinds', () => {
    const operationId = createEntityId('operation');
    assert.ok(!isValidEntityId(operationId, 'run'));
    assert.ok(!isValidEntityId(operationId, 'idempotency'));
    const runId = createEntityId('run');
    assert.ok(!isValidEntityId(runId, 'operation'));
  });
});
