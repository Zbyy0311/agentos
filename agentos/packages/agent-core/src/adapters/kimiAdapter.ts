import { EMPTY_ADAPTER_CAPABILITIES, runProbeCommand, type ProbeCommand } from './capabilityProbe.js';
import { createKimiJsonParser } from './kimiParser.js';
import type { AgentCliAdapter, AdapterCapabilities, CliEventParser, ProviderInvocation, ProviderInvocationInput, ProviderProbeResult } from './types.js';

export interface KimiProbeOptions {
  timeoutMs?: number;
  run?: ProbeCommand;
}

const KIMI_CAPABILITIES: AdapterCapabilities = {
  structuredOutput: true,
  jsonSchemaOutput: false,
  assistantDelta: true,
  toolEvents: true,
  usage: true,
  workspaceReadOnly: true,
  approvalEvents: false,
};

export class KimiAdapter implements AgentCliAdapter {
  readonly provider = 'kimi' as const;

  constructor(private readonly probeOptions: KimiProbeOptions = {}) {}

  probe(commandPath: string): Promise<ProviderProbeResult> {
    return probeKimiCli(commandPath, this.probeOptions);
  }

  buildInvocation(input: ProviderInvocationInput): ProviderInvocation {
    const args = [...input.baseArgs, ...input.imageArgs];
    const outputIndex = args.indexOf('--output-format');
    if (outputIndex >= 0) {
      args.splice(outputIndex, 2);
    }
    const promptIndex = args.findIndex(arg => arg === '-p' || arg === '--prompt');
    args.splice(promptIndex >= 0 ? promptIndex : args.length, 0, '--output-format', 'stream-json');
    return { args, promptTransport: 'argument', env: {} };
  }

  createParser(): CliEventParser {
    return createKimiJsonParser();
  }
}

export async function probeKimiCli(commandPath: string, options: KimiProbeOptions = {}): Promise<ProviderProbeResult> {
  const run = options.run ?? runProbeCommand;
  const timeoutMs = options.timeoutMs ?? 5000;
  try {
    const version = await run(commandPath, ['--version'], timeoutMs);
    const helpText = await run(commandPath, ['--help'], timeoutMs);
    const structured = /--output-format[\s\S]*stream-json|stream-json[\s\S]*--output-format/i.test(helpText);
    if (!structured) {
      return {
        status: 'UNAVAILABLE', configuredProvider: 'kimi', detectedProvider: 'kimi', version: version.trim(), helpText: helpText.trim(),
        capabilities: EMPTY_ADAPTER_CAPABILITIES, reason: 'Kimi help does not advertise --output-format stream-json',
      };
    }
    return {
      status: 'AVAILABLE', configuredProvider: 'kimi', detectedProvider: 'kimi', version: version.trim(), helpText: helpText.trim(), capabilities: KIMI_CAPABILITIES,
    };
  } catch (error) {
    return {
      status: 'UNAVAILABLE', configuredProvider: 'kimi', capabilities: EMPTY_ADAPTER_CAPABILITIES,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
