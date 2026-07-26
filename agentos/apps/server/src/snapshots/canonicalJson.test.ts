import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeJson, hashCanonicalJson } from './canonicalJson.js';

// Frozen M2.5 built-in workflow definition values (must match Migration 007 seeds).
const FROZEN_LEGACY_CANONICAL_JSON =
  '{"definitionKey":"legacy-pipeline","executionMode":"legacy_pipeline","name":"legacy-pipeline-v1","retryPolicy":null,"schemaVersion":1,"stages":[{"agentRole":"codex","key":"codex_manager","sequence":1},{"agentRole":"kimi","key":"kimi_worker","sequence":2},{"agentRole":"opencode","key":"opencode_reviewer","sequence":3},{"agentRole":"codex","key":"codex_final_review","sequence":4}],"version":1}';
const FROZEN_LEGACY_SHA256 =
  '78da8202a6a751a382567db0a5806a99bd5c0f7cb8763fa2630ff26fdc1d2316';
const FROZEN_UNBOUND_CANONICAL_JSON =
  '{"definitionKey":"unbound-task-run","executionMode":"unbound","name":"unbound-task-run-v1","retryPolicy":null,"schemaVersion":1,"stages":[],"version":1}';
const FROZEN_UNBOUND_SHA256 =
  '015ca32ad5bf123bc720668e4de639f22143bafc883868e2c92b0fe3b87871f3';

describe('canonicalJson — canonicalization', () => {
  it('same semantic object with different insertion order produces identical canonical JSON', () => {
    const a = { b: 1, a: 2, c: { y: 1, x: 2 } };
    const b = { c: { x: 2, y: 1 }, a: 2, b: 1 };
    assert.equal(canonicalizeJson(a), canonicalizeJson(b));
  });

  it('top-level keys are sorted by code point', () => {
    assert.equal(canonicalizeJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  });

  it('nested keys are sorted recursively', () => {
    assert.equal(
      canonicalizeJson({ z: { d: 1, c: 2 }, a: [{ f: 1, e: 2 }] }),
      '{"a":[{"e":2,"f":1}],"z":{"c":2,"d":1}}',
    );
  });

  it('arrays preserve order and are not sorted', () => {
    assert.equal(canonicalizeJson([3, 1, 2]), '[3,1,2]');
    assert.equal(canonicalizeJson({ arr: ['b', 'a'] }), '{"arr":["b","a"]}');
  });

  it('null, boolean, string and finite numbers use standard JSON forms', () => {
    assert.equal(canonicalizeJson(null), 'null');
    assert.equal(canonicalizeJson(true), 'true');
    assert.equal(canonicalizeJson(false), 'false');
    assert.equal(canonicalizeJson('a"b'), JSON.stringify('a"b'));
    assert.equal(canonicalizeJson(0), '0');
    assert.equal(canonicalizeJson(-12.5), '-12.5');
    assert.equal(canonicalizeJson(1e21), JSON.stringify(1e21));
  });

  it('output has no insignificant whitespace or newlines', () => {
    const out = canonicalizeJson({ a: [1, 2], b: { c: 'x' } });
    assert.ok(!/[\s]/.test(out.replace(/"([^"\\]|\\.)*"/g, '""')) || out === '{}');
    assert.equal(out, '{"a":[1,2],"b":{"c":"x"}}');
  });

  it('changed value changes the canonical JSON and the hash', () => {
    const a = { v: 1 };
    const b = { v: 2 };
    assert.notEqual(canonicalizeJson(a), canonicalizeJson(b));
    assert.notEqual(hashCanonicalJson(a), hashCanonicalJson(b));
  });

  it('Unicode keys sort by code point, not UTF-16 code unit', () => {
    // U+FFFD (0xFFFD) sorts BEFORE U+1F600 (0x1F600) by code point.
    // A UTF-16 sort would order U+1F600 first (lead surrogate 0xD83D < 0xFFFD).
    const replacement = '�';
    const grinning = '😀';
    assert.equal(replacement.codePointAt(0), 0xfffd);
    assert.equal(grinning.codePointAt(0), 0x1f600);
    const out = canonicalizeJson({ [grinning]: 1, [replacement]: 2 });
    assert.ok(
      out.indexOf(replacement) < out.indexOf(grinning),
      `code-point order violated: ${out}`,
    );
    assert.equal(out, `{"${replacement}":2,"${grinning}":1}`);
  });

  it('rejects NaN and Infinity numbers', () => {
    assert.throws(() => canonicalizeJson(NaN));
    assert.throws(() => canonicalizeJson(Infinity));
    assert.throws(() => canonicalizeJson(-Infinity));
    assert.throws(() => canonicalizeJson({ v: NaN }));
  });

  it('rejects undefined, function, symbol and bigint anywhere', () => {
    assert.throws(() => canonicalizeJson(undefined));
    assert.throws(() => canonicalizeJson(() => 1));
    assert.throws(() => canonicalizeJson(Symbol('s')));
    assert.throws(() => canonicalizeJson(10n));
    assert.throws(() => canonicalizeJson({ v: undefined }));
    assert.throws(() => canonicalizeJson([undefined]));
    assert.throws(() => canonicalizeJson([() => 1]));
  });

  it('rejects circular references', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    assert.throws(() => canonicalizeJson(a));
    const arr: unknown[] = [];
    arr.push(arr);
    assert.throws(() => canonicalizeJson(arr));
  });

  it('rejects sparse array holes instead of coercing to null', () => {
    const sparse = [1];
    sparse[2] = 3;
    assert.throws(() => canonicalizeJson(sparse));
    assert.throws(() => canonicalizeJson(new Array(3)));
  });

  it('rejects non-plain objects', () => {
    class Foo { x = 1; }
    assert.throws(() => canonicalizeJson(new Date()));
    assert.throws(() => canonicalizeJson(new Map()));
    assert.throws(() => canonicalizeJson(new Set()));
    assert.throws(() => canonicalizeJson(new Foo()));
  });

  it('rejects symbol-keyed properties and accessor properties', () => {
    const withSymbol = { [Symbol('k')]: 1, a: 2 };
    assert.throws(() => canonicalizeJson(withSymbol));
    const withGetter = {
      get value() { return 1; },
    };
    assert.throws(() => canonicalizeJson(withGetter));
  });
});

describe('canonicalJson — hashing', () => {
  it('hash is lowercase 64-char hex', () => {
    const hash = hashCanonicalJson({ a: 1 });
    assert.ok(/^[0-9a-f]{64}$/.test(hash));
  });

  it('same semantic object produces the same hash', () => {
    assert.equal(hashCanonicalJson({ b: 1, a: 2 }), hashCanonicalJson({ a: 2, b: 1 }));
  });

  it('frozen Legacy built-in: parse + re-canonicalize reproduces the frozen string and hash', () => {
    const parsed = JSON.parse(FROZEN_LEGACY_CANONICAL_JSON);
    assert.equal(canonicalizeJson(parsed), FROZEN_LEGACY_CANONICAL_JSON);
    assert.equal(hashCanonicalJson(parsed), FROZEN_LEGACY_SHA256);
  });

  it('frozen Unbound built-in: parse + re-canonicalize reproduces the frozen string and hash', () => {
    const parsed = JSON.parse(FROZEN_UNBOUND_CANONICAL_JSON);
    assert.equal(canonicalizeJson(parsed), FROZEN_UNBOUND_CANONICAL_JSON);
    assert.equal(hashCanonicalJson(parsed), FROZEN_UNBOUND_SHA256);
  });
});
