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
  // The historical MODIFYING representation carries no server-derived fields.
  assert.deepEqual(Object.keys(startRequestDomainInput('MODIFYING')), []);
});

// ---------------------------------------------------------------------------
// L1A-R01..R06 — backward compatibility with pre-L1A {} fingerprints
// ---------------------------------------------------------------------------

const HISTORICAL_DOMAIN_INPUT: Readonly<Record<string, unknown>> = {};

// L1A-R01 — historical pre-L1A fingerprint (domainInput = {}) equals the new
// omitted requestedMutationClass fingerprint.
test('L1A-R01 historical {} == omitted requestedMutationClass fingerprint', () => {
  assert.equal(
    fp(HISTORICAL_DOMAIN_INPUT),
    fp(startRequestDomainInput(normalizeRequestedMutationClass(undefined))),
  );
});

// L1A-R02 — historical pre-L1A fingerprint equals the new explicit MODIFYING
// fingerprint.
test('L1A-R02 historical {} == explicit MODIFYING fingerprint', () => {
  assert.equal(
    fp(HISTORICAL_DOMAIN_INPUT),
    fp(startRequestDomainInput(normalizeRequestedMutationClass('MODIFYING'))),
  );
});

// L1A-R03 — historical MODIFYING fingerprint differs from READ_ONLY.
test('L1A-R03 historical MODIFYING != READ_ONLY fingerprint', () => {
  assert.notEqual(
    fp(HISTORICAL_DOMAIN_INPUT),
    fp(startRequestDomainInput(normalizeRequestedMutationClass('READ_ONLY'))),
  );
});
