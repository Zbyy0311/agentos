import test from 'node:test';
import assert from 'node:assert/strict';
import type { Request } from 'express';
import { createOptionalIdempotencyService, parseIdempotencyKey } from './v2Idempotency.js';
import { createV2TaskRoutes } from './v2Tasks.js';
import { createV2RunRoutes } from './v2Runs.js';
import { hashNormalizedIdempotencyKey } from '../idempotency/fingerprint.js';
import type { TaskRunServiceDeps } from '../services/TaskRunService.js';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';

function reqWithRawHeaders(rawHeaders: unknown): Request {
  return { rawHeaders } as unknown as Request;
}

function expectValidationError(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    assert.equal((error as { code?: unknown } | null)?.code, 'VALIDATION_FAILED');
    assert.equal((error as Error).message, 'Idempotency key is invalid');
    return error as Error;
  }
  assert.fail('expected IdempotencyKeyValidationError');
}

test('H01 no Idempotency-Key header returns undefined', () => {
  assert.equal(parseIdempotencyKey(reqWithRawHeaders(['Content-Type', 'application/json'])), undefined);
  assert.equal(parseIdempotencyKey(reqWithRawHeaders([])), undefined);
});

test('H02 a valid header returns the normalized key', () => {
  assert.equal(parseIdempotencyKey(reqWithRawHeaders(['Idempotency-Key', 'request-abc-123'])), 'request-abc-123');
});

test('H03 outer whitespace is trimmed', () => {
  assert.equal(parseIdempotencyKey(reqWithRawHeaders(['Idempotency-Key', '  request-abc-123  '])), 'request-abc-123');
});

test('H04 a trimmed key hashes identically to the unspaced key', () => {
  const parsed = parseIdempotencyKey(reqWithRawHeaders(['Idempotency-Key', '\trequest-abc-123 ']));
  assert.equal(hashNormalizedIdempotencyKey(parsed!), hashNormalizedIdempotencyKey('request-abc-123'));
});

test('H05 keys shorter than 8 characters are rejected', () => {
  expectValidationError(() => parseIdempotencyKey(reqWithRawHeaders(['Idempotency-Key', 'short12'])));
});

test('H06 keys longer than 128 characters are rejected', () => {
  expectValidationError(() => parseIdempotencyKey(reqWithRawHeaders(['Idempotency-Key', `a${'b'.repeat(128)}`])));
});

test('H07 illegal characters are rejected', () => {
  expectValidationError(() => parseIdempotencyKey(reqWithRawHeaders(['Idempotency-Key', 'bad key with spaces!'])));
  expectValidationError(() => parseIdempotencyKey(reqWithRawHeaders(['Idempotency-Key', 'bad/key/slash'])));
  expectValidationError(() => parseIdempotencyKey(reqWithRawHeaders(['Idempotency-Key', '-leading-dash-1'])));
});

test('H08 an empty header value is rejected', () => {
  expectValidationError(() => parseIdempotencyKey(reqWithRawHeaders(['Idempotency-Key', ''])));
  expectValidationError(() => parseIdempotencyKey(reqWithRawHeaders(['Idempotency-Key', '   '])));
});

test('H09 a single header whose value contains a comma is rejected', () => {
  expectValidationError(() => parseIdempotencyKey(reqWithRawHeaders(['Idempotency-Key', 'request-abc-123,request-def-456'])));
});

test('H10 two same-case Idempotency-Key headers are rejected', () => {
  expectValidationError(() => parseIdempotencyKey(reqWithRawHeaders([
    'Idempotency-Key', 'request-abc-123',
    'Idempotency-Key', 'request-abc-123',
  ])));
});

test('H11 duplicate headers with different casing are rejected', () => {
  expectValidationError(() => parseIdempotencyKey(reqWithRawHeaders([
    'Idempotency-Key', 'request-abc-123',
    'idempotency-key', 'request-abc-123',
  ])));
});

test('H12 an array header value is rejected', () => {
  expectValidationError(() => parseIdempotencyKey(reqWithRawHeaders([
    'Idempotency-Key', ['request-abc-123', 'request-def-456'],
  ])));
});

test('H13 the error message never contains the key value', () => {
  const secretKey = 'super-secret-key-value-123';
  const error = expectValidationError(() => parseIdempotencyKey(reqWithRawHeaders([
    'Idempotency-Key', secretKey,
    'Idempotency-Key', secretKey,
  ])));
  assert.ok(!error.message.includes(secretKey));
  assert.ok(!error.message.includes('request-abc-123'));
});

test('H14 header name matching is case-insensitive', () => {
  assert.equal(parseIdempotencyKey(reqWithRawHeaders(['IDEMPOTENCY-KEY', 'request-abc-123'])), 'request-abc-123');
  assert.equal(parseIdempotencyKey(reqWithRawHeaders(['idempotency-key', 'request-abc-123'])), 'request-abc-123');
});

// ---------------------------------------------------------------------------
// M2.6 P3 HIGH-1 remediation — optional router capability injection (C01–C02)
// ---------------------------------------------------------------------------

function capabilityLessStore(): TaskRunServiceDeps {
  return {
    taskRepository: () => ({}) as never,
    runRepository: () => ({}) as never,
    workflowDefinitionRepository: () => ({}) as never,
    runSnapshotRepository: () => ({}) as never,
    runStageRepository: () => ({}) as never,
    providerConfigurationRepository: () => ({}) as never,
    findAgentSnapshotSource: () => undefined,
    runInTransaction: <T>(fn: () => T): T => fn(),
    lifecycleTransactionService: () => ({
      createRunGraphEventsWithinTransaction: () => {
        throw new Error('UNEXPECTED_LIFECYCLE_EVENT_SERVICE_CALL');
      },
    }) as never,
  };
}

test('C01 a TaskRunServiceDeps store without idempotencyRepository constructs createV2TaskRoutes', () => {
  assert.equal(createOptionalIdempotencyService(capabilityLessStore()), undefined);
  assert.doesNotThrow(() => createV2TaskRoutes(capabilityLessStore(), {} as WorkspaceManager));
});

test('C02 a TaskRunServiceDeps store without idempotencyRepository constructs createV2RunRoutes', () => {
  assert.equal(createOptionalIdempotencyService(capabilityLessStore()), undefined);
  assert.doesNotThrow(() => createV2RunRoutes(capabilityLessStore(), {} as WorkspaceManager));
});
