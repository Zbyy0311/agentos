import { describe, it, expect } from 'vitest';
import { resolveCommand } from './resolveCommand.js';
import { isAbsolute, join } from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

describe('resolveCommand', () => {
  it('resolves node to an absolute path', async () => {
    const result = await resolveCommand('node');
    expect(result).toBeTruthy();
    expect(isAbsolute(result!)).toBe(true);
  });

  it('returns null for a non-existent command', async () => {
    const result = await resolveCommand('definitely-fake-command-12345');
    expect(result).toBeNull();
  });

  it('resolves an absolute path directly', async () => {
    const nodePath = await resolveCommand('node');
    expect(nodePath).toBeTruthy();
    const same = await resolveCommand(nodePath!);
    expect(same).toBe(nodePath);
  });

  it('resolves a command from the supplied child PATH', async () => {
    const binDir = await mkdtemp(join(tmpdir(), 'agentos-command-path-'));
    const command = 'agentos-test-codex';
    const executable = join(binDir, `${command}.cmd`);
    await writeFile(executable, '@echo off\r\necho ok\r\n');

    const result = await resolveCommand(command, {
      PATH: binDir,
      PATHEXT: '.CMD',
    });

    expect(result).toBe(executable);
  });
});
