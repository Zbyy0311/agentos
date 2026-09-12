import { probeCodexCli } from './capabilityProbe.js';
import { CodexJsonParser } from './codexParser.js';
import type { AgentCliAdapter, CliEventParser, ProviderInvocationInput, ProviderInvocation, ProviderProbeResult } from './types.js';

export class CodexAdapter implements AgentCliAdapter {
  readonly provider = 'codex' as const;

  probe(commandPath: string): Promise<ProviderProbeResult> {
    return probeCodexCli(commandPath);
  }

  buildInvocation(input: ProviderInvocationInput): ProviderInvocation {
    const decorated = [...input.baseArgs, ...input.imageArgs];
    if (decorated.includes('--json')) return { args: decorated, promptTransport: 'argument', env: {} };
    const execIndex = decorated.indexOf('exec');
    if (execIndex >= 0) decorated.splice(execIndex + 1, 0, '--json');
    else decorated.push('--json');
    return { args: decorated, promptTransport: 'argument', env: {} };
  }

  createParser(): CliEventParser {
    return new CodexJsonParser();
  }
}
