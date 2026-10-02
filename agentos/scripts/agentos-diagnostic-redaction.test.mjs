import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDiagnosticRedactor,
  MAX_DIAGNOSTIC_EVENT_CHARS,
  MAX_DIAGNOSTIC_LINE_CHARS,
} from './agentos-diagnostic-redaction.mjs';

test('redacts configured secrets, credential headers, URLs, tokens, and private keys', () => {
  const redact = createDiagnosticRedactor({
    AGENTOS_API_TOKEN: 'unit-canary-token-8c2f',
    DATABASE_URL: 'postgres://agent:unit-db-secret@localhost/agentos',
    AGENTOS_SHORT_TOKEN: 'x9Q',
  });
  const input = [
    'UNHANDLED_REJECTION reason=unit-canary-token-8c2f',
    'Authorization: Bearer header-canary-token',
    '{"authorization":"Bearer json-header-canary","x-api-key":"json-api-canary","cookie":"session-canary"}',
    '{"database_url":"postgres://json-user:json-password-canary@localhost/agentos"}',
    'DATABASE_URL=postgres://agent:unit-db-secret@localhost/agentos',
    'Bearer standalone-canary-token',
    'https://user:unit-url-password@example.test/path',
  ].join('\n');

  const safe = redact(input);
  for (const secret of [
    'unit-canary-token-8c2f', 'header-canary-token', 'json-header-canary', 'json-api-canary',
    'session-canary', 'json-password-canary', 'unit-db-secret', 'x9Q',
    'standalone-canary-token', 'unit-url-password',
  ]) assert.equal(safe.includes(secret), false);
  assert.match(safe, /Authorization: \[REDACTED\]/);
  assert.match(safe, /\[REDACTED\]$/m);
});

test('redacts PEM private-key bodies across newline and worker-style chunk calls', () => {
  const redact = createDiagnosticRedactor({});
  const lines = [
    redact('failure detail -----BEGIN RSA PRIVATE KEY-----\n'),
    redact('unit-private-key-material\n'),
    redact('-----END RSA PRIVATE KEY----- trailing=ok\n'),
  ].join('');
  assert.equal(lines.includes('unit-private-key-material'), false);
  assert.match(lines, /\[REDACTED_PRIVATE_KEY\]/);
  assert.match(lines, /trailing=ok/);
});

test('short configured values redact when logged bare or in a credential field without substring replacement', () => {
  const redact = createDiagnosticRedactor({ AGENTOS_API_TOKEN: 'x9Q' });
  assert.equal(redact('x9Q'), '[REDACTED]');
  assert.equal(redact('"x9Q"'), '"[REDACTED]"');
  assert.equal(redact('api_token=x9Q'), 'api_token=[REDACTED]');
  assert.equal(redact('UNHANDLED_REJECTION reason=x9Q'), 'UNHANDLED_REJECTION reason=[REDACTED]');
  assert.equal(redact('prefixx9Qsuffix'), 'prefixx9Qsuffix');
  assert.equal(redact('the x9QCache is healthy'), 'the x9QCache is healthy');

  const ordinaryWord = createDiagnosticRedactor({ API_TOKEN: 'no' });
  assert.equal(ordinaryWord('reason=no'), 'reason=[REDACTED]');
  assert.equal(ordinaryWord('Error: no runtime is configured'), 'Error: no runtime is configured');
  assert.equal(ordinaryWord('{"cause":"no"}'), '{"cause":"[REDACTED]"}');
});

test('quoted JSON credential keys are redacted without corrupting the JSON structure', () => {
  const redact = createDiagnosticRedactor({});
  const safe = redact('{"authorization":"Bearer json-canary","x-api-key":"json-key-canary","cookie":"session-canary"}');
  const parsed = JSON.parse(safe);
  assert.equal(parsed.authorization, '[REDACTED]');
  assert.equal(parsed['x-api-key'], '[REDACTED]');
  assert.equal(parsed.cookie, '[REDACTED]');
});

test('bounds oversized diagnostics while preserving private-key redaction state', () => {
  const redact = createDiagnosticRedactor({});
  assert.equal(redact('x'.repeat(MAX_DIAGNOSTIC_LINE_CHARS + 1)), '[long diagnostic line omitted]');
  assert.equal(redact('-----BEGIN PRIVATE KEY-----' + 'x'.repeat(MAX_DIAGNOSTIC_LINE_CHARS)), '[REDACTED_PRIVATE_KEY]');
  assert.equal(redact('oversized-event-' + 'x'.repeat(MAX_DIAGNOSTIC_EVENT_CHARS) + '\n-----BEGIN PRIVATE KEY-----'), '[diagnostic event omitted: size limit]');
  assert.equal(redact('private-key-body-canary\n'), '[REDACTED_PRIVATE_KEY]\n');
});
