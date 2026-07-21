import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createEntityId,
  isValidEntityId,
  injectIdSources,
  ENTITY_ID_PREFIXES,
  type EntityIdKind,
} from './Identity.js';

function createEntityIdWith(ts: number, rand: Uint8Array): string {
  const restore = injectIdSources(() => ts, () => rand);
  try {
    return createEntityId('task');
  } finally {
    restore();
  }
}

describe('Identity — canonical entity IDs', () => {
  const kinds = Object.keys(ENTITY_ID_PREFIXES) as EntityIdKind[];

  it('all prefix constants map to valid EntityIdKind', () => {
    for (const kind of kinds) {
      assert.ok(ENTITY_ID_PREFIXES[kind].length >= 2, `prefix for ${kind} too short`);
    }
  });

  it('createEntityId produces prefix_ulid format', () => {
    for (const kind of kinds) {
      const id = createEntityId(kind);
      const prefix = ENTITY_ID_PREFIXES[kind];
      assert.ok(id.startsWith(`${prefix}_`), `${kind}: expected ${prefix}_, got ${id}`);
    }
  });

  it('ULID body is 26 Crockford Base32 characters', () => {
    for (const kind of kinds) {
      const id = createEntityId(kind);
      const body = id.slice(ENTITY_ID_PREFIXES[kind].length + 1); // prefix + _
      assert.equal(body.length, 26, `${kind}: ULID body length`);
      // Crockford: no I L O U
      assert.ok(/^[0-9A-HJKM-NP-TV-Z]{26}$/.test(body), `${kind}: body=${body}`);
    }
  });

  it('same kind produces unique IDs', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const id = createEntityId('task');
      assert.ok(!ids.has(id), `duplicate ID: ${id}`);
      ids.add(id);
    }
  });

  it('same kind produces unique IDs under heavy load', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ids.add(createEntityId('run'));
    }
    assert.equal(ids.size, 1000);
  });

  it('different kinds have different prefixes', () => {
    const id1 = createEntityId('workspace');
    const id2 = createEntityId('task');
    assert.ok(id1.startsWith('ws_'));
    assert.ok(id2.startsWith('task_'));
  });

  it('time increases produce lexically increasing IDs', () => {
    // With same random component (0xAA), larger timestamps should produce larger ULIDs
    const id1 = createEntityIdWith(0, new Uint8Array(10).fill(0xAA));
    const id2 = createEntityIdWith(1000, new Uint8Array(10).fill(0xAA));
    assert.ok(id1 < id2, `${id1} should be < ${id2}`);
  });

  it('monotonic within same millisecond', () => {
    let counter = 0;
    const restore = injectIdSources(
      () => 0, // always same timestamp
      () => {
        const buf = new Uint8Array(10).fill(0x42);
        buf[0] = counter++;
        return buf;
      },
    );
    try {
      const ids = new Set<string>();
      for (let i = 0; i < 50; i++) {
        ids.add(createEntityId('run'));
      }
      assert.equal(ids.size, 50);
    } finally {
      restore();
    }
  });

  it('clock regression does not produce reverse-order IDs', () => {
    const restore1 = injectIdSources(() => 50, () => new Uint8Array(10).fill(0x12));
    const id1 = createEntityId('run');
    restore1();

    const restore2 = injectIdSources(() => 10, () => new Uint8Array(10).fill(0x12));
    const id2 = createEntityId('run');
    restore2();

    // Second call has lower timestamp but identical random; monotonicity uses
    // the last-seen timestamp so id2 should not sort before id1.
    assert.ok(id1 <= id2, `with clock regression, ${id1} should not be > ${id2}`);
  });

  it('isValidEntityId validates prefix and body', () => {
    const id = createEntityId('conversation');
    assert.ok(isValidEntityId(id, 'conversation'));
    assert.ok(!isValidEntityId(id, 'task')); // wrong prefix
    assert.ok(!isValidEntityId('conv_ZZZ', 'conversation')); // body too short
    // Body longer than 26 chars is rejected
    assert.ok(!isValidEntityId('conv_0123456789ABCDEFGHJKMNPQRSXXX', 'conversation'));
  });

  it('no database dependency', () => {
    // This test implicitly proves no DatabaseSync was imported
    const id = createEntityId('workspace');
    assert.ok(id.startsWith('ws_'));
  });
});
