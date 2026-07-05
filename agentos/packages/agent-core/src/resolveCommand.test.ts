import { describe, it, expect } from 'vitest';
import { resolveCommand } from './resolveCommand.js';
import { isAbsolute } from 'node:path';

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
});
