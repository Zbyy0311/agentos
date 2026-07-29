import { test } from 'node:test';
import assert from 'node:assert/strict';

async function loadParser() {
  return await import('./LegacySourceParser.js') as {
    parseLegacyJsonSource(bytes: Uint8Array): {
      sourceHash: string;
      value: unknown;
      canonicalJson: string;
      payloadHash: string;
      sourceSchemaVersion: number;
      entityCount: number;
    };
    LegacySourceParseError: new (...args: any[]) => Error & { code: string };
  };
}

test('[M27-P1-T004] valid source produces exact-byte hash, semantic value, canonical JSON and entity evidence', async () => {
  const { parseLegacyJsonSource } = await loadParser();
  const source = Buffer.from('[{"b":2,"a":1},{"unknown":{"z":[3,2],"a":true}}]', 'utf8');
  const parsed = parseLegacyJsonSource(source);
  assert.match(parsed.sourceHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(parsed.value, [
    { b: 2, a: 1 },
    { unknown: { z: [3, 2], a: true } },
  ]);
  assert.equal(parsed.canonicalJson, '[{"a":1,"b":2},{"unknown":{"a":true,"z":[3,2]}}]');
  assert.match(parsed.payloadHash, /^[0-9a-f]{64}$/);
  assert.notEqual(parsed.payloadHash, parsed.sourceHash);
  assert.equal(parsed.sourceSchemaVersion, 1);
  assert.equal(parsed.entityCount, 2);
});

test('[M27-P1-T007] strict Parser rejects duplicate keys, malformed grammar, surrogates and unsafe numbers', async () => {
  const { parseLegacyJsonSource, LegacySourceParseError } = await loadParser();
  const invalidSources: Array<[string, Uint8Array]> = [
    ['duplicate key', Buffer.from('{"a":1,"a":2}', 'utf8')],
    ['trailing token', Buffer.from('{"a":1} trailing', 'utf8')],
    ['trailing object comma', Buffer.from('{"a":1,}', 'utf8')],
    ['trailing array comma', Buffer.from('[1,]', 'utf8')],
    ['invalid escape', Buffer.from(String.raw`{"a":"\x"}`, 'utf8')],
    ['unpaired high surrogate', Buffer.from(String.raw`{"a":"\uD800"}`, 'utf8')],
    ['unpaired low surrogate', Buffer.from(String.raw`{"a":"\uDC00"}`, 'utf8')],
    ['NaN', Buffer.from('NaN', 'utf8')],
    ['Infinity', Buffer.from('Infinity', 'utf8')],
    ['negative Infinity', Buffer.from('-Infinity', 'utf8')],
    ['unsafe integer', Buffer.from('9007199254740993', 'utf8')],
    ['numeric overflow', Buffer.from('1e309', 'utf8')],
    ['negative zero', Buffer.from('-0', 'utf8')],
    ['UTF-8 BOM', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('[]', 'utf8')])],
    ['invalid UTF-8', Buffer.from([0xff])],
  ];
  for (const [name, source] of invalidSources) {
    assert.throws(
      () => parseLegacyJsonSource(source),
      (error: unknown) => error instanceof LegacySourceParseError
        && (error as { code?: string }).code === 'LEGACY_SOURCE_PARSE_FAILED',
      `${name} must fail closed`,
    );
  }
});
