import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RequestedMutationClassValidationError,
  normalizeRequestedMutationClass,
  startRequestDomainInput,
} from '@agentos/shared';
import { hashIdempotencyRequest } from '../idempotency/fingerprint.js';

function fp(domainInput: Readonly<Record<string, unknown>>): string {
  return hashIdempotencyRequest({
    operation: 'run.start',
    workspaceId: 'ws_00000000000000000000000001',
    pathParams: { runId: 'run_00000000000000000000000001' },
    domainInput,
    expectedVersion: null,
  });
}

// L1A-18 — omitted requestedMutationClass normalizes to MODIFYING.
test('L1A-18 omitted requestedMutationClass normalizes to MODIFYING', () => {
  assert.equal(normalizeRequestedMutationClass(undefined), 'MODIFYING');
});

// L1A-19 — explicit MODIFYING normalizes to MODIFYING.
test('L1A-19 explicit MODIFYING normalizes to MODIFYING', () => {
  assert.equal(normalizeRequestedMutationClass('MODIFYING'), 'MODIFYING');
});

// L1A-20 — READ_ONLY normalizes correctly.
test('L1A-20 READ_ONLY normalizes correctly', () => {
  assert.equal(normalizeRequestedMutationClass('READ_ONLY'), 'READ_ONLY');
});

// L1A-21 — invalid requestedMutationClass -> VALIDATION_FAILED.
test('L1A-21 invalid requestedMutationClass -> VALIDATION_FAILED', () => {
  for (const bad of ['read_only', 'SIDEWAYS', '', 1, null, {}, []]) {
    assert.throws(
      () => normalizeRequestedMutationClass(bad),
      (e: unknown) =>
        e instanceof RequestedMutationClassValidationError && e.code === 'VALIDATION_FAILED',
    );
  }
});

// L1A-22 — omitted vs explicit MODIFYING produce the same request fingerprint.
test('L1A-22 omitted vs explicit MODIFYING same fingerprint', () => {
  const omitted = fp(startRequestDomainInput(normalizeRequestedMutationClass(undefined)));
  const explicit = fp(startRequestDomainInput(normalizeRequestedMutationClass('MODIFYING')));
  assert.equal(omitted, explicit);
});

// L1A-23 — READ_ONLY vs MODIFYING under the same key are different identities
// (which the idempotency layer surfaces as IDEMPOTENCY_KEY_REUSED).
test('L1A-23 READ_ONLY vs MODIFYING differ in request identity', () => {
  const ro = fp(startRequestDomainInput(normalizeRequestedMutationClass('READ_ONLY')));
  const mo = fp(startRequestDomainInput(normalizeRequestedMutationClass('MODIFYING')));
  assert.notEqual(ro, mo);
});

// The fingerprint must not include server-derived values.
test('L1A fingerprint excludes server-derived effective/evidence fields', () => {
  const canonical = startRequestDomainInput('READ_ONLY');
  assert.deepEqual(Object.keys(canonical), ['requestedMutationClass']);
});
