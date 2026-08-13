import { describe, expect, it } from 'vitest';
import { isProcessId, newProcessId } from './process-id.js';

describe('Process identity', () => {
  it('allocates proc_* identities that are never OS PIDs', () => {
    const id = newProcessId();
    expect(id.startsWith('proc_')).toBe(true);
    expect(typeof id).toBe('string');
    // An AgentOS Process ID is never numeric, so it can never equal a PID.
    expect(Number.isNaN(Number(id))).toBe(true);
    expect(id).not.toBe(String(4000));
  });

  it('allocates unique identities', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newProcessId()));
    expect(ids.size).toBe(500);
  });

  it('classifies process id shapes', () => {
    expect(isProcessId(newProcessId())).toBe(true);
    expect(isProcessId('proc_')).toBe(false);
    expect(isProcessId('4000')).toBe(false);
    expect(isProcessId(4000)).toBe(false);
    expect(isProcessId(undefined)).toBe(false);
  });
});
