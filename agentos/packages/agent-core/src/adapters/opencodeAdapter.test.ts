import { describe, expect, it } from 'vitest';
import { OpenCodeAdapter, probeOpenCodeCli } from './opencodeAdapter.js';
import type { ProbeCommand } from './capabilityProbe.js';

describe('OpenCodeAdapter', () => {
  it('uses OpenCode run help instead of the Codex exec probe', async () => {
    const calls: string[][] = [];
    const run: ProbeCommand = async (_command, args) => {
      calls.push([...args]);
      return args[0] === '--version' ? '1.17.11' : 'opencode run [message..] --model --variant';
    };

    await expect(probeOpenCodeCli('opencode', { run })).resolves.toMatchObject({
      status: 'AVAILABLE', configuredProvider: 'opencode', detectedProvider: 'opencode', version: '1.17.11',
    });
    expect(calls).toEqual([['--version'], ['run', '--help']]);
  });

  it('preserves the configured text launch and emits assistant text', async () => {
    const adapter = new OpenCodeAdapter({ run: async () => 'opencode run' });
    const invocation = adapter.buildInvocation({
      commandPath: 'opencode', baseArgs: ['--pure', 'run', '--model', 'opencode/mimo-v2.5-free'],
      prompt: 'hello', workspaceRoot: '.', workspaceWrite: false, imageArgs: [],
    });

    expect(invocation.args).toEqual(['--pure', 'run', '--model', 'opencode/mimo-v2.5-free']);
    expect(adapter.createParser().push('reply')).toEqual([{ type: 'assistant.message', text: 'reply' }]);
  });
});
