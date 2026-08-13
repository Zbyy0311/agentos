import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProcessError } from './errors.js';
import { FakeFileSystemProbe } from './testing/fake-probe.js';
import type { LaunchRequest } from './types.js';
import { redactArgs, validateLaunch } from './validation.js';

const ROOT = join(sep, 'ws');
const BIN = join(sep, 'bin');

function fixture() {
  const probe = new FakeFileSystemProbe();
  probe.addDirectory(ROOT);
  probe.addExecutable(join(BIN, 'tool'));
  const policy = {
    workspaceRoot: ROOT,
    executablePathDirs: [BIN],
    executableExtensions: [''],
  };
  const launch: LaunchRequest = { executable: 'tool', args: ['--run', 'x'], cwd: ROOT };
  return { probe, policy, launch };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ProcessError);
    return (err as ProcessError).code;
  }
  throw new Error('expected validation to throw');
}

describe('validateLaunch', () => {
  it('accepts a valid launch with separated args and shell disabled', () => {
    const { probe, policy, launch } = fixture();
    const validated = validateLaunch(launch, probe, policy);
    expect(validated.executable).toBe(join(BIN, 'tool'));
    expect(validated.args).toEqual(['--run', 'x']);
    expect(Object.isFrozen(validated.args)).toBe(true);
    expect(validated.shell).toBe(false);
    expect(validated.cwd).toBe(ROOT);
  });

  it('resolves an absolute executable path directly', () => {
    const { probe, policy, launch } = fixture();
    const absolute = join(BIN, 'direct');
    probe.addExecutable(absolute);
    const validated = validateLaunch({ ...launch, executable: absolute }, probe, policy);
    expect(validated.executable).toBe(absolute);
  });

  it('denies shell=true and detached=true by policy', () => {
    const { probe, policy, launch } = fixture();
    expect(codeOf(() => validateLaunch({ ...launch, shell: true }, probe, policy))).toBe(
      'PROCESS_POLICY_DENIED',
    );
    expect(codeOf(() => validateLaunch({ ...launch, detached: true }, probe, policy))).toBe(
      'PROCESS_POLICY_DENIED',
    );
  });

  it('rejects a cwd outside the workspace boundary via realpath', () => {
    const { probe, policy, launch } = fixture();
    const outside = join(sep, 'elsewhere');
    probe.addDirectory(outside);
    expect(codeOf(() => validateLaunch({ ...launch, cwd: outside }, probe, policy))).toBe(
      'PROCESS_CWD_INVALID',
    );
  });

  it('rejects a cwd that does not resolve or is not a directory', () => {
    const { probe, policy, launch } = fixture();
    expect(
      codeOf(() => validateLaunch({ ...launch, cwd: join(ROOT, 'missing') }, probe, policy)),
    ).toBe('PROCESS_CWD_INVALID');
    const file = join(ROOT, 'afile');
    probe.addPlainFile(file);
    expect(codeOf(() => validateLaunch({ ...launch, cwd: file }, probe, policy))).toBe(
      'PROCESS_CWD_INVALID',
    );
  });

  it('accepts a cwd inside a workspace subdirectory', () => {
    const { probe, policy, launch } = fixture();
    const sub = join(ROOT, 'sub');
    probe.addDirectory(sub);
    expect(validateLaunch({ ...launch, cwd: sub }, probe, policy).cwd).toBe(sub);
  });

  it('maps a missing executable and a non-executable file to stable codes', () => {
    const { probe, policy, launch } = fixture();
    expect(codeOf(() => validateLaunch({ ...launch, executable: 'nope' }, probe, policy))).toBe(
      'PROCESS_EXECUTABLE_NOT_FOUND',
    );
    probe.addPlainFile(join(BIN, 'plain'));
    expect(codeOf(() => validateLaunch({ ...launch, executable: 'plain' }, probe, policy))).toBe(
      'PROCESS_EXECUTABLE_NOT_ACCESSIBLE',
    );
  });

  it('rejects malformed requests with PROCESS_REQUEST_INVALID', () => {
    const { probe, policy, launch } = fixture();
    expect(codeOf(() => validateLaunch({ ...launch, executable: '' }, probe, policy))).toBe(
      'PROCESS_REQUEST_INVALID',
    );
    expect(
      codeOf(() =>
        validateLaunch({ ...launch, args: ['ok', 7 as unknown as string] }, probe, policy),
      ),
    ).toBe('PROCESS_REQUEST_INVALID');
    expect(
      codeOf(() => validateLaunch({ ...launch, args: ['has\u0000nul'] }, probe, policy)),
    ).toBe('PROCESS_REQUEST_INVALID');
  });

  it('propagates environment validation failures', () => {
    const { probe, policy, launch } = fixture();
    const withSecret: LaunchRequest = {
      ...launch,
      env: { base: {}, overrides: { API_KEY: 'inline-secret' } },
    };
    expect(codeOf(() => validateLaunch(withSecret, probe, policy))).toBe(
      'PROCESS_ENVIRONMENT_INVALID',
    );
  });

  it('builds a safe environment into the validated launch', () => {
    const { probe, policy, launch } = fixture();
    const validated = validateLaunch(
      { ...launch, env: { base: {}, profile: { MODE: 'test' } } },
      probe,
      policy,
    );
    expect(validated.env.MODE).toBe('test');
    expect(validated.envDiagnostics).toEqual([
      { key: 'MODE', source: 'profile', classification: 'plain' },
    ]);
  });
});

describe('redactArgs', () => {
  it('keeps flag names and redacts their values', () => {
    expect(redactArgs(['--token=abc', '--mode', 'fast'])).toEqual([
      '--token=[REDACTED]',
      '--mode',
      '[REDACTED]',
    ]);
  });

  it('redacts separated flag values while preserving the flag name', () => {
    expect(redactArgs(['--api-key', 'xyz'])).toEqual(['--api-key', '[REDACTED]']);
  });

  it('redacts ordinary positional arguments and preserves empty strings', () => {
    expect(redactArgs(['task', '--', 'positional', ''])).toEqual([
      '[REDACTED]',
      '--',
      '[REDACTED]',
      '',
    ]);
  });
});
