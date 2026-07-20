import { EMPTY_ADAPTER_CAPABILITIES } from './capabilityProbe.js';
import type { AgentCliAdapter, CliEventParser, NormalizedCliEvent, ProviderInvocationInput, ProviderInvocation, ProviderProbeResult } from './types.js';

class PlainTextParser implements CliEventParser {
  push(chunk: string): NormalizedCliEvent[] {
    return chunk ? [{ type: 'assistant.message', text: chunk }] : [];
  }

  finish(): NormalizedCliEvent[] {
    return [];
  }
}

export class PlainTextAdapter implements AgentCliAdapter {
  readonly provider = 'plain' as const;

  async probe(_commandPath: string): Promise<ProviderProbeResult> {
    return { status: 'UNAVAILABLE', configuredProvider: 'custom', capabilities: EMPTY_ADAPTER_CAPABILITIES, reason: 'plain fallback' };
  }

  buildInvocation(input: ProviderInvocationInput): ProviderInvocation {
    return { args: [...input.baseArgs, ...input.imageArgs], promptTransport: 'argument', env: {} };
  }

  createParser(): CliEventParser {
    return new PlainTextParser();
  }
}
