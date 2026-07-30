import { test } from 'node:test';
import assert from 'node:assert/strict';

async function loadParser() {
  return await import('./LegacySourceParser.js') as {
    parseLegacyJsonSource(bytes: Uint8Array, sourceKey: 'workspaces.json' | 'tasks.json'): {
      sourceHash: string;
      value: unknown[];
      canonicalJson: string;
      payloadHash: string;
      sourceSchemaVersion: number;
      entityCount: number;
    };
    canonicalizeLegacyJson(value: unknown): string;
    LegacySourceParseError: new (...args: any[]) => Error & { code: string };
  };
}

function isParseError(error: unknown): boolean {
  return error instanceof Error && (error as { code?: string }).code === 'LEGACY_SOURCE_PARSE_FAILED';
}

test('[M27-P1-T004] valid envelopes produce exact-byte hash, ordered entities, canonical JSON and entity evidence', async () => {
  const { parseLegacyJsonSource, canonicalizeLegacyJson, LegacySourceParseError } = await loadParser();

  const workspaceSource = Buffer.from('{"workspaces":[{"b":2,"a":1},{"unknown":{"z":[3,2],"a":true}}]}', 'utf8');
  const workspace = parseLegacyJsonSource(workspaceSource, 'workspaces.json');
  assert.match(workspace.sourceHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(workspace.value, [
    { b: 2, a: 1 },
    { unknown: { z: [3, 2], a: true } },
  ]);
  assert.equal(workspace.canonicalJson, '[{"a":1,"b":2},{"unknown":{"a":true,"z":[3,2]}}]');
  assert.match(workspace.payloadHash, /^[0-9a-f]{64}$/);
  assert.notEqual(workspace.payloadHash, workspace.sourceHash);
  assert.equal(workspace.sourceSchemaVersion, 1);
  assert.equal(workspace.entityCount, 2);

  const taskSource = Buffer.from('{"tasks":[{"id":"task-1","outputs":["x"],"extra":{"keep":true}}]}', 'utf8');
  const tasks = parseLegacyJsonSource(taskSource, 'tasks.json');
  assert.deepEqual(tasks.value, [{ id: 'task-1', outputs: ['x'], extra: { keep: true } }]);
  assert.equal(tasks.canonicalJson, '[{"extra":{"keep":true},"id":"task-1","outputs":["x"]}]');
  assert.equal(tasks.entityCount, 1);

  const empty = parseLegacyJsonSource(Buffer.from('{"tasks":[]}', 'utf8'), 'tasks.json');
  assert.equal(empty.entityCount, 0);
  assert.equal(empty.canonicalJson, '[]');

  // Exact decimals that survive canonicalization unchanged.
  const decimals = parseLegacyJsonSource(Buffer.from('{"tasks":[1.0,1e0,0.10,1.2300e2]}', 'utf8'), 'tasks.json');
  assert.equal(decimals.canonicalJson, '[1,1,0.1,123]');

  // `__proto__` is preserved as an own enumerable data property without
  // changing the parsed object's Prototype or polluting Object.prototype.
  const protoParsed = parseLegacyJsonSource(
    Buffer.from('{"tasks":[{"id":"t","__proto__":{"legacy":true}}]}', 'utf8'),
    'tasks.json',
  );
  const protoItem = protoParsed.value[0] as Record<string, unknown>;
  assert.equal(Object.prototype.hasOwnProperty.call(protoItem, '__proto__'), true);
  assert.deepEqual(protoItem.__proto__, { legacy: true });
  assert.equal(Object.getPrototypeOf(protoItem), Object.prototype);
  assert.equal(protoParsed.canonicalJson, '[{"__proto__":{"legacy":true},"id":"t"}]');
  assert.equal(({} as Record<string, unknown>).legacy, undefined);

  // canonicalizeLegacyJson rejects non-JSON values on its own.
  const invalidValues: Array<[string, unknown]> = [
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['-0', -0],
    ['unsafe integer', 9007199254740993],
    ['Date', new Date(0)],
    ['Map', new Map()],
    ['Set', new Set()],
    ['custom prototype', Object.create({ custom: true })],
  ];
  for (const [name, value] of invalidValues) {
    assert.throws(
      () => canonicalizeLegacyJson(value),
      (error: unknown) => error instanceof LegacySourceParseError && isParseError(error),
      `${name} must fail closed in canonicalizeLegacyJson`,
    );
  }
});

test('[M27-P1-T007] strict Parser rejects wrong envelopes, malformed grammar, surrogates, precision loss and unsafe numbers', async () => {
  const { parseLegacyJsonSource, LegacySourceParseError } = await loadParser();
  const reject = (name: string, source: Uint8Array, sourceKey: 'workspaces.json' | 'tasks.json' = 'tasks.json'): void => {
    assert.throws(
      () => parseLegacyJsonSource(source, sourceKey),
      (error: unknown) => error instanceof LegacySourceParseError && isParseError(error),
      `${name} must fail closed`,
    );
  };

  // Envelope contract.
  reject('naked top-level array', Buffer.from('[{"a":1}]', 'utf8'));
  reject('tasks envelope under workspaces sourceKey', Buffer.from('{"tasks":[]}', 'utf8'), 'workspaces.json');
  reject('workspaces envelope under tasks sourceKey', Buffer.from('{"workspaces":[]}', 'utf8'), 'tasks.json');
  reject('missing envelope property', Buffer.from('{"other":[]}', 'utf8'));
  reject('null envelope property', Buffer.from('{"tasks":null}', 'utf8'));
  reject('non-array envelope property', Buffer.from('{"tasks":{}}', 'utf8'));
  reject('string envelope property', Buffer.from('{"tasks":"x"}', 'utf8'));

  // Grammar and string strictness inside a valid envelope.
  reject('duplicate key', Buffer.from('{"tasks":[{"a":1,"a":2}]}', 'utf8'));
  reject('duplicate __proto__', Buffer.from('{"tasks":[{"__proto__":1,"__proto__":2}]}', 'utf8'));
  reject('trailing token', Buffer.from('{"tasks":[]} trailing', 'utf8'));
  reject('trailing object comma', Buffer.from('{"tasks":[{"a":1,}]}', 'utf8'));
  reject('trailing array comma', Buffer.from('{"tasks":[1,]}', 'utf8'));
  reject('invalid escape', Buffer.from(String.raw`{"tasks":[{"a":"\x"}]}`, 'utf8'));
  reject('unpaired high surrogate', Buffer.from(String.raw`{"tasks":[{"a":"\uD800"}]}`, 'utf8'));
  reject('unpaired low surrogate', Buffer.from(String.raw`{"tasks":[{"a":"\uDC00"}]}`, 'utf8'));

  // Non-JSON and unsafe numbers inside a valid envelope Array.
  reject('NaN', Buffer.from('{"tasks":[NaN]}', 'utf8'));
  reject('Infinity', Buffer.from('{"tasks":[Infinity]}', 'utf8'));
  reject('negative Infinity', Buffer.from('{"tasks":[-Infinity]}', 'utf8'));
  reject('unsafe integer', Buffer.from('{"tasks":[9007199254740993]}', 'utf8'));
  reject('numeric overflow', Buffer.from('{"tasks":[1e309]}', 'utf8'));
  reject('negative zero', Buffer.from('{"tasks":[-0]}', 'utf8'));
  reject('negative zero with fraction', Buffer.from('{"tasks":[-0.0]}', 'utf8'));
  reject('precision-loss decimal', Buffer.from('{"tasks":[1.0000000000000001]}', 'utf8'));
  reject('precision-loss long fraction', Buffer.from('{"tasks":[0.100000000000000005]}', 'utf8'));
  reject('underflow to zero', Buffer.from('{"tasks":[1e-324]}', 'utf8'));
  reject('safe-boundary fraction', Buffer.from('{"tasks":[9007199254740991.1]}', 'utf8'));
  reject('malformed exponent', Buffer.from('{"tasks":[1e]}', 'utf8'));

  // Byte-level strictness.
  reject('UTF-8 BOM', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"tasks":[]}', 'utf8')]));
  reject('invalid UTF-8', Buffer.from([0xff]));
});
