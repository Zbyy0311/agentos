import type { AgentProvider } from '@agentos/shared';
import { probeCodexCli, codexCapabilities, EMPTY_ADAPTER_CAPABILITIES, type CodexProbeResult } from './capabilityProbe.js';
import { CodexAdapter } from './codexAdapter.js';
import { PlainTextAdapter } from './plainTextAdapter.js';
import type { AgentCliAdapter, NormalizedCliEvent, ProviderProbeResult, ResolvedRuntime } from './types.js';

export interface ResolveRuntimeInput {
  configuredProvider: AgentProvider;
  commandPath: string;
}

export interface AdapterResolution {
  adapter: AgentCliAdapter;
  probe?: ProviderProbeResult;
  runtime: ResolvedRuntime;
  diagnostic?: Extract<NormalizedCliEvent, { type: 'diagnostic' }>;
}

type LegacyCodexProbeResult = Pick<CodexProbeResult, 'status' | 'version' | 'reason' | 'supportsStructuredOutput'>;

interface RegistryOptions {
  /** Legacy injection point retained for deterministic Codex probe tests. */
  probe?: (command: string) => Promise<CodexProbeResult | LegacyCodexProbeResult>;
  adapters?: AgentCliAdapter[];
}

export class AgentCliAdapterRegistry {
  private readonly codex = new CodexAdapter();
  private readonly plain = new PlainTextAdapter();
  private readonly adapters: AgentCliAdapter[];
  private readonly probe?: (command: string) => Promise<CodexProbeResult | LegacyCodexProbeResult>;

  constructor(options: RegistryOptions = {}) {
    this.adapters = [this.codex, ...(options.adapters ?? [])];
    this.probe = options.probe;
  }

  async resolve(input: string | ResolveRuntimeInput): Promise<AdapterResolution> {
    const request: ResolveRuntimeInput = typeof input === 'string'
      ? { configuredProvider: providerFromCommand(input), commandPath: input }
      : input;
    const configuredAdapter = this.findAdapter(request.configuredProvider);
    const rawProbe = this.probe
      ? await this.probe(request.commandPath)
      : configuredAdapter
        ? await configuredAdapter.probe(request.commandPath)
        : await probeCodexCli(request.commandPath);
    const probe = normalizeProbe(rawProbe, request.configuredProvider);
    const detectedProvider = probe.detectedProvider;
    const mismatch = Boolean(detectedProvider && detectedProvider !== request.configuredProvider);
    const detectedAdapter = detectedProvider ? this.findAdapter(detectedProvider) : undefined;
    const structuredAvailable = probe.status === 'AVAILABLE' && probe.capabilities.structuredOutput;
    const adapter = structuredAvailable
      ? (mismatch ? detectedAdapter : configuredAdapter) ?? this.plain
      : this.plain;
    const runtime: ResolvedRuntime = {
      configuredProvider: request.configuredProvider,
      ...(detectedProvider ? { detectedProvider } : {}),
      commandPath: request.commandPath,
      ...(probe.version ? { version: probe.version } : {}),
      capabilities: probe.capabilities,
      mismatch,
    };

    if (mismatch) {
      return {
        adapter,
        probe,
        runtime,
        diagnostic: {
          type: 'diagnostic',
          level: 'warning',
          code: 'provider.mismatch',
          message: `Provider mismatch: configured ${request.configuredProvider}, detected ${detectedProvider}`,
        },
      };
    }
    if (adapter === this.plain) {
      return {
        adapter,
        probe,
        runtime,
        diagnostic: {
          type: 'diagnostic',
          level: 'warning',
          code: 'adapter.plain_fallback',
          message: `${request.configuredProvider} structured output is unavailable; using plain text fallback`,
        },
      };
    }
    return { adapter, probe, runtime };
  }

  private findAdapter(provider: AgentProvider): AgentCliAdapter | undefined {
    return this.adapters.find(adapter => adapter.provider === provider);
  }
}

function normalizeProbe(probe: ProviderProbeResult | LegacyCodexProbeResult, configuredProvider: AgentProvider): ProviderProbeResult {
  const structuredOutput = 'capabilities' in probe ? probe.capabilities.structuredOutput : probe.supportsStructuredOutput ?? false;
  return {
    ...probe,
    configuredProvider,
    capabilities: 'capabilities' in probe ? probe.capabilities : probe.supportsStructuredOutput !== undefined ? codexCapabilities(probe.supportsStructuredOutput) : EMPTY_ADAPTER_CAPABILITIES,
    ...(probe.supportsStructuredOutput === undefined ? { supportsStructuredOutput: structuredOutput } : {}),
  };
}

function providerFromCommand(command: string): AgentProvider {
  const normalized = command.trim().toLowerCase().replace(/\\/g, '/').split('/').at(-1) ?? '';
  if (/^codex(?:\.(?:exe|cmd|bat))?$/.test(normalized)) return 'codex';
  if (/^kimi(?:\.(?:exe|cmd|bat))?$/.test(normalized)) return 'kimi';
  if (/^opencode(?:\.(?:exe|cmd|bat))?$/.test(normalized)) return 'opencode';
  if (/^mimo(?:\.(?:exe|cmd|bat))?$/.test(normalized)) return 'mimo';
  return 'custom';
}
