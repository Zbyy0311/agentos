import { describe, expect, it } from 'vitest';
import { CodexProviderAdapter } from './codexProviderAdapter.js';
import { KimiCodeProviderAdapter } from './kimiCodeAdapter.js';
import { OpenCodeProviderAdapter } from './opencodeProviderAdapter.js';

/**
 * LITE-04-006: provider errors normalize to stable codes WITH retryability.
 *
 * The adapter suites already assert the stable-code half. This asserts the other
 * half as one contract across all three production adapters, because retryability
 * is what a caller acts on: an automatic retry is only safe for a transient
 * transport condition. Authentication, configuration, quota and model problems
 * are not retryable - a retry cannot fix them, and treating them as retryable would
 * turn a permanent provider state into an infinite retry loop.
 */

interface AdapterUnderTest {
  readonly name: string;
  readonly normalizeError: (error: unknown) => { readonly code: string; readonly retryable: boolean };
}

function adapters(): readonly AdapterUnderTest[] {
  return [
    { name: 'codex', normalizeError: error => new CodexProviderAdapter().normalizeError(error) },
    { name: 'kimicode', normalizeError: error => new KimiCodeProviderAdapter().normalizeError(error) },
    { name: 'opencode', normalizeError: error => new OpenCodeProviderAdapter().normalizeError(error) },
  ];
}

/** Every input below is chosen to match exactly one normalization rule per adapter. */
const CASES = [
  { input: 'network unreachable', code: 'PROVIDER_NETWORK_ERROR', retryable: true,
    why: 'a transport failure can succeed on a later attempt' },
  { input: 'rate limit exceeded', code: 'PROVIDER_RATE_LIMITED', retryable: true,
    why: 'a rate limit is transient by definition' },
  { input: 'login required', code: 'PROVIDER_AUTH_REQUIRED', retryable: false,
    why: 'retrying cannot satisfy an authentication requirement' },
  { input: 'quota exceeded', code: 'PROVIDER_QUOTA_EXCEEDED', retryable: false,
    why: 'a quota needs its window to reset, not another attempt' },
  { input: 'unknown model', code: 'PROVIDER_MODEL_UNAVAILABLE', retryable: false,
    why: 'a model availability problem is not fixed by retrying the same request' },
] as const;

describe('LITE-04-006 provider error retryability contract', () => {
  it('LITE-04-002 / LITE-04-006 classifies every production adapter identically for auth, rate-limit, quota, model, and network failures', () => {
    for (const adapter of adapters()) {
      for (const testCase of CASES) {
        const normalized = adapter.normalizeError(new Error(testCase.input));
        expect({ adapter: adapter.name, input: testCase.input, code: normalized.code })
          .toEqual({ adapter: adapter.name, input: testCase.input, code: testCase.code });
        expect({ adapter: adapter.name, input: testCase.input, retryable: normalized.retryable })
          .toEqual({ adapter: adapter.name, input: testCase.input, retryable: testCase.retryable });
      }
    }
  });

  it('always reports retryability as an explicit boolean, never as an absence', () => {
    for (const adapter of adapters()) {
      const normalized = adapter.normalizeError(new Error('something entirely unrecognized'));
      expect(typeof normalized.retryable).toBe('boolean');
      expect(normalized.retryable).toBe(false);
      expect(typeof normalized.code).toBe('string');
    }
  });

  it('keeps a normalized error idempotent through re-normalization', () => {
    // A caller that normalizes twice must not lose or flip the retryability flag.
    for (const adapter of adapters()) {
      const once = adapter.normalizeError(new Error('network unreachable'));
      const twice = adapter.normalizeError(once);
      expect(twice.code).toBe(once.code);
      expect(twice.retryable).toBe(once.retryable);
    }
  });
});
