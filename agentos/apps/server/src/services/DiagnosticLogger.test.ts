import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDiagnosticLogger } from './DiagnosticLogger.js';
import { MAX_DIAGNOSTIC_LINE_CHARS } from '../../../../scripts/agentos-diagnostic-redaction.mjs';

test('production diagnostic logger redacts persisted errors and keeps line and rotation bounds', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentos-diagnostic-logger-'));
  const token = 'production-path-canary-token';
  try {
    const logger = createDiagnosticLogger({
      directory,
      instanceId: 'logger-fixture',
      environment: {
        API_TOKEN: token,
        AGENTOS_SHORT_TOKEN: 'x9Q',
        DATABASE_URL: 'postgres://unit:db-canary-secret@localhost/agentos',
      },
      now: () => new Date('2026-10-03T00:00:00.000Z'),
      maxBytes: 1024 * 1024,
      rotations: 4,
    });

    logger(`UNHANDLED_EXCEPTION error=${token}\nAuthorization: Bearer header-canary-value\n-----BEGIN RSA PRIVATE KEY-----\nunit-private-key-material\n-----END RSA PRIVATE KEY-----`);
    logger('UNHANDLED_REJECTION reason=DATABASE_URL postgres://unit:db-canary-secret@localhost/agentos');
    logger('x9Q');
    logger('short credential api_token=x9Q');
    logger(`long-line=${'z'.repeat(MAX_DIAGNOSTIC_LINE_CHARS + 1)}`);
    const files = readdirSync(directory).filter(name => name.startsWith('server-logger-fixture.log'));
    assert.ok(files.length > 0);

    const persisted = files.map(name => readFileSync(join(directory, name), 'utf8')).join('\n');
    for (const secret of [token, 'header-canary-value', 'db-canary-secret', 'x9Q', 'z'.repeat(500)]) {
      assert.equal(persisted.includes(secret), false, 'persisted diagnostics must not contain sensitive fixture material');
    }
    assert.equal(persisted.includes('unit-private-key-material'), false);
    assert.ok(persisted.includes('[REDACTED]'));
    assert.ok(persisted.includes('[long diagnostic line omitted]'));

    const rotatingLogger = createDiagnosticLogger({
      directory,
      instanceId: 'rotation-fixture',
      environment: {},
      maxBytes: 360,
      rotations: 2,
    });
    for (let index = 0; index < 8; index += 1) rotatingLogger(`bounded-entry-${index}-${'a'.repeat(90)}`);
    const rotatedFiles = readdirSync(directory).filter(name => name.startsWith('server-rotation-fixture.log'));
    assert.ok(rotatedFiles.length <= 3, 'rotation count must remain bounded');
    assert.ok(rotatedFiles.length > 0);
    for (const name of rotatedFiles) assert.ok(statSync(join(directory, name)).size <= 360, 'each diagnostic file must respect its size cap');

    const unrotatedLogger = createDiagnosticLogger({
      directory,
      instanceId: 'zero-rotation-fixture',
      environment: {},
      maxBytes: 180,
      rotations: 0,
    });
    for (let index = 0; index < 8; index += 1) unrotatedLogger(`latest-entry-${index}-${'b'.repeat(70)}`);
    const unrotatedFiles = readdirSync(directory).filter(name => name.startsWith('server-zero-rotation-fixture.log'));
    assert.deepEqual(unrotatedFiles, ['server-zero-rotation-fixture.log'], 'zero rotations must keep exactly one bounded file');
    const unrotatedPath = join(directory, unrotatedFiles[0]!);
    assert.ok(statSync(unrotatedPath).size <= 180, 'zero-rotation log must not grow past its size cap');
    const newestOnly = readFileSync(unrotatedPath, 'utf8');
    assert.match(newestOnly, /latest-entry-7/);
    assert.doesNotMatch(newestOnly, /latest-entry-6/, 'a full zero-rotation file must be replaced before the next append');
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10 });
  }
});
