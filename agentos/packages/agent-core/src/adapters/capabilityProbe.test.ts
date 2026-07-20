import { describe, expect, it } from 'vitest';
import { probeCodexCli, type ProbeCommand } from './capabilityProbe.js';

describe('probeCodexCli', () => {
  it('selects structured output only when version and help both succeed', async () => {
    const calls: string[][] = [];
    const run: ProbeCommand = async (_command, args) => {
      calls.push([...args]);
      return args[0] === '--version' ? 'codex 1.2.3' : 'Usage: codex exec --json';
    };
    await expect(probeCodexCli('C:/tools/codex.exe', { run })).resolves.toMatchObject({ status: 'AVAILABLE', supportsStructuredOutput: true, configuredProvider: 'codex', detectedProvider: 'codex', version: 'codex 1.2.3', capabilities: { structuredOutput: true, jsonSchemaOutput: false } });
    expect(calls).toEqual([['--version'], ['exec', '--help']]);
  });

  it('reports access denied or other launch failures as unavailable', async () => {
    const run: ProbeCommand = async () => { throw new Error('Access is denied'); };
    await expect(probeCodexCli('C:/WindowsApps/codex.exe', { run })).resolves.toMatchObject({ status: 'UNAVAILABLE', reason: 'Access is denied' });
  });
});
