import { describe, expect, it } from 'vitest';
import { NodeProcessProbePort, type ProcessProbePort } from './probe.js';

describe('Process Runtime probe port', () => {
  it('owns the separated-argument one-shot probe boundary', async () => {
    const port: ProcessProbePort = new NodeProcessProbePort();
    const result = await port.probe({
      executable: process.execPath,
      args: ['-e', 'process.stdout.write("probe-ok")'],
      timeoutMs: 5_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout).toBe('probe-ok');
    expect(result.stderr).toBe('');
  });

  it('returns a stable executable error without throwing native detail', async () => {
    const result = await new NodeProcessProbePort().probe({
      executable: 'agentos-missing-provider-probe',
      args: ['--version'],
      timeoutMs: 5_000,
    });
    expect(result.errorCode).toBe('PROCESS_EXECUTABLE_NOT_FOUND');
    expect(result.stderr).not.toContain('agentos-missing-provider-probe');
  });
});
