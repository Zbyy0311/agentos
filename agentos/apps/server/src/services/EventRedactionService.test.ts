import test from 'node:test';
import assert from 'node:assert/strict';
import { REDACTION_MARKER } from '@agentos/process-runtime';
import { EventRedactionService } from './EventRedactionService.js';

test('redactPayload replaces registered known secret values exactly in nested strings', () => {
  const service = new EventRedactionService();
  service.registerSecrets('ws_1', ['super-secret-value-123']);
  const payload = {
    note: 'token is super-secret-value-123 here',
    nested: {
      list: ['prefix super-secret-value-123 suffix', 'plain'],
      count: 42,
      flag: true,
      missing: null,
    },
  };
  const result = service.redactPayload('ws_1', payload);
  assert.equal(
    (result.value as typeof payload).note,
    `token is ${REDACTION_MARKER} here`,
  );
  assert.equal(
    (result.value as typeof payload).nested.list[0],
    `prefix ${REDACTION_MARKER} suffix`,
  );
  assert.equal((result.value as typeof payload).nested.list[1], 'plain');
  assert.equal((result.value as typeof payload).nested.count, 42);
  assert.equal(result.redactedFields, 2);
  // Original object is never mutated.
  assert.equal(payload.note, 'token is super-secret-value-123 here');
  assert.equal(payload.nested.list[0], 'prefix super-secret-value-123 suffix');
});

test('redactPayload replaces all occurrences of a known secret in one string', () => {
  const service = new EventRedactionService();
  service.registerSecrets('ws_1', ['abcdefgh-secret']);
  const result = service.redactPayload('ws_1', 'a abcdefgh-secret b abcdefgh-secret c');
  assert.equal(result.value, `a ${REDACTION_MARKER} b ${REDACTION_MARKER} c`);
  assert.equal(result.redactedFields, 1);
});

test('redactPayload applies generic patterns when no known secret matches', () => {
  const service = new EventRedactionService();
  const payload = {
    key: 'sk-abcdefghijklmnopqrstuvwx',
    aws: 'prefix AKIAIOSFODNN7EXAMPLE suffix',
    token: 'Authorization: Bearer abcdef1234567890XYZW==',
    pem: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA',
    github: 'ghp_abcdefghijklmnopqrstuvwxyz1234',
    google: 'key AIzaSyD4iE7xn0sMRl3d1c2fghjklzxcvbnmqw',
    slack: 'xoxb-123456789012-abcdefghijkl',
    plain: 'nothing secret here',
  };
  const result = service.redactPayload('ws_1', payload);
  const value = result.value as Record<string, string>;
  for (const field of ['key', 'aws', 'token', 'pem', 'github', 'google', 'slack'] as const) {
    assert.ok(!value[field].includes(payload[field].replace(/^(prefix |Authorization: )/, '').slice(0, 8))
      || value[field].includes(REDACTION_MARKER), field);
    assert.ok(value[field].includes(REDACTION_MARKER), `${field} was not redacted`);
  }
  assert.equal(value.plain, 'nothing secret here');
  assert.equal(result.redactedFields, 7);
});

test('redactPayload is a no-op for an empty secret registry', () => {
  const service = new EventRedactionService();
  const payload = { note: 'sk-abcdefghijklmnopqrstuvwx', nested: [{ a: 1 }] };
  const result = service.redactPayload('ws_1', payload);
  // Generic patterns still apply; known-value replacement does not exist.
  assert.equal((result.value as typeof payload).note, REDACTION_MARKER);
  assert.deepEqual(result.value === payload, false);
  const service2 = new EventRedactionService();
  const benign = { note: 'totally benign text' };
  const benignResult = service2.redactPayload('ws_1', benign);
  assert.equal(benignResult.redactedFields, 0);
  assert.deepEqual(benignResult.value, benign);
});

test('redactPayload isolates secrets per workspace', () => {
  const service = new EventRedactionService();
  service.registerSecrets('ws_1', ['ws-one-secret-value']);
  service.registerSecrets('ws_2', ['ws-two-secret-value']);
  const payload = 'ws-one-secret-value and ws-two-secret-value';
  assert.equal(
    service.redactPayload('ws_1', payload).value,
    `${REDACTION_MARKER} and ws-two-secret-value`,
  );
  assert.equal(
    service.redactPayload('ws_2', payload).value,
    `ws-one-secret-value and ${REDACTION_MARKER}`,
  );
  assert.equal(
    service.redactPayload('ws_3', payload).value,
    payload,
  );
});

test('registerSecrets ignores empty and short values', () => {
  const service = new EventRedactionService();
  service.registerSecrets('ws_1', ['', 'short', 'seven77', '8chars!']);
  const payload = 'short seven77 8chars!';
  const result = service.redactPayload('ws_1', payload);
  assert.equal(result.value, payload);
  assert.equal(result.redactedFields, 0);
});

test('registerSecrets tolerates non-string values and clearWorkspace forgets secrets', () => {
  const service = new EventRedactionService();
  service.registerSecrets('ws_1', ['a-very-secret-value', undefined as unknown as string]);
  service.clearWorkspace('ws_1');
  const payload = 'a-very-secret-value';
  assert.equal(service.redactPayload('ws_1', payload).value, payload);
});

test('redactPayload handles non-object roots', () => {
  const service = new EventRedactionService();
  service.registerSecrets('ws_1', ['root-secret-0001']);
  assert.equal(service.redactPayload('ws_1', 'x root-secret-0001').value, `x ${REDACTION_MARKER}`);
  assert.equal(service.redactPayload('ws_1', 7).value, 7);
  assert.equal(service.redactPayload('ws_1', null).value, null);
  assert.equal(service.redactPayload('ws_1', undefined).value, undefined);
  assert.deepEqual(service.redactPayload('ws_1', ['root-secret-0001']).value, [REDACTION_MARKER]);
});
