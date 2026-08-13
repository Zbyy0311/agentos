import { describe, expect, it } from 'vitest';
import { ProcessError } from './errors.js';
import {
  buildSafeEnvironment,
  DEFAULT_BASE_ALLOWLIST,
  MAX_ENV_TOTAL_BYTES,
} from './environment.js';

describe('buildSafeEnvironment', () => {
  it('starts from an explicit safe base and records plain diagnostics', () => {
    const { env, diagnostics } = buildSafeEnvironment({ base: { SAFE_BASE: '1' } });
    expect(env.SAFE_BASE).toBe('1');
    expect(diagnostics).toEqual([
      { key: 'SAFE_BASE', source: 'base', classification: 'plain' },
    ]);
  });

  it('picks only allowlisted keys from the host environment by default', () => {
    const { env } = buildSafeEnvironment();
    for (const key of Object.keys(env)) {
      expect(DEFAULT_BASE_ALLOWLIST).toContain(key);
    }
  });

  it('applies profile then run overrides, with override diagnostics winning', () => {
    const { env, diagnostics } = buildSafeEnvironment({
      base: { MODE: 'base', KEEP: 'k' },
      profile: { MODE: 'profile' },
      overrides: { MODE: 'run' },
    });
    expect(env.MODE).toBe('run');
    expect(env.KEEP).toBe('k');
    const mode = diagnostics.find((d) => d.key === 'MODE');
    expect(mode?.source).toBe('override');
  });

  it('rejects secret-looking keys in profile and overrides', () => {
    expect(() =>
      buildSafeEnvironment({ base: {}, profile: { API_TOKEN: 'x' } }),
    ).toThrowError(ProcessError);
    try {
      buildSafeEnvironment({ base: {}, overrides: { DB_PASSWORD: 'x' } });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ProcessError);
      expect((err as ProcessError).code).toBe('PROCESS_ENVIRONMENT_INVALID');
    }
  });

  it('accepts ephemeral secret references without exposing values in diagnostics', () => {
    const secret = 'supersecret-value-12345';
    const { env, diagnostics } = buildSafeEnvironment({
      base: {},
      secretRefs: { RUNTIME_API_KEY: secret },
    });
    expect(env.RUNTIME_API_KEY).toBe(secret);
    expect(diagnostics).toEqual([
      { key: 'RUNTIME_API_KEY', source: 'secret-ref', classification: 'secret-ephemeral' },
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain(secret);
  });

  it('rejects malformed keys and NUL values', () => {
    expect(() => buildSafeEnvironment({ base: { 'BAD-KEY': 'x' } })).toThrowError(ProcessError);
    expect(() => buildSafeEnvironment({ base: { OK: 'a\u0000b' } })).toThrowError(ProcessError);
  });

  it('enforces the total environment size limit', () => {
    const big = 'x'.repeat(MAX_ENV_TOTAL_BYTES);
    expect(() => buildSafeEnvironment({ base: {}, overrides: { BIG: big } })).toThrowError(
      ProcessError,
    );
  });
});
