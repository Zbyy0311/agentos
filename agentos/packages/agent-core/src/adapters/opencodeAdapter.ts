import { runProbeCommand, type ProbeCommand } from './capabilityProbe.js';
import type { AgentCliAdapter, AdapterCapabilities, CliEventParser, ProviderInvocation, ProviderInvocationInput, ProviderProbeResult } from './types.js';

export interface OpenCodeProbeOptions {
  timeoutMs?: number;
  run?: ProbeCommand;
}

const OPENCODE_CAPABILITIES: AdapterCapabilities = {
  structuredOutput: false,
  jsonSchemaOutput: false,
  assistantDelta: true,
  toolEvents: false,
  usage: false,
  workspaceReadOnly: true,
  approvalEvents: false,
};

class OpenCodePlainTextParser implements CliEventParser {
  push(chunk: string) {
    return chunk ? [{ type: 'assistant.message' as const, text: chunk }] : [];
  }

  finish() {
    return [];
  }
}

/**
 * Legacy Conversation adapter for OpenCode's default text output.
 *
 * OpenCode is not a Codex-compatible JSONL CLI.  Keeping a provider-specific
 * probe here prevents the legacy adapter registry from running the Codex
 * probe against `opencode`, which previously produced a false provider
 * mismatch and could select the wrong parser.
 */
export class OpenCodeAdapter implements AgentCliAdapter {
  readonly provider = 'opencode' as const;

  constructor(private readonly probeOptions: OpenCodeProbeOptions = {}) {}

  probe(commandPath: string): Promise<ProviderProbeResult> {
    return probeOpenCodeCli(commandPath, this.probeOptions);
  }

  buildInvocation(input: ProviderInvocationInput): ProviderInvocation {
    return { args: [...input.baseArgs, ...input.imageArgs], promptTransport: 'argument', env: {} };
  }

  createParser(): CliEventParser {
    return new OpenCodePlainTextParser();
  }
}

export async function probeOpenCodeCli(commandPath: string, options: OpenCodeProbeOptions = {}): Promise<ProviderProbeResult> {
  const run = options.run ?? runProbeCommand;
  const timeoutMs = options.timeoutMs ?? 5000;
  try {
    const version = await run(commandPath, ['--version'], timeoutMs);
    const helpText = await run(commandPath, ['run', '--help'], timeoutMs);
    if (!/(?:^|\s)(?:opencode\s+)?run(?:\s|$|\[)/im.test(helpText)) {
      return {
        status: 'UNAVAILABLE', configuredProvider: 'opencode', detectedProvider: 'opencode',
        version: version.trim(), helpText: helpText.trim(), capabilities: OPENCODE_CAPABILITIES,
        reason: 'OpenCode help does not advertise the run command',
      };
    }
    return {
      status: 'AVAILABLE', configuredProvider: 'opencode', detectedProvider: 'opencode',
      version: version.trim(), helpText: helpText.trim(), capabilities: OPENCODE_CAPABILITIES,
    };
  } catch (error) {
    return {
      status: 'UNAVAILABLE', configuredProvider: 'opencode', capabilities: OPENCODE_CAPABILITIES,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
