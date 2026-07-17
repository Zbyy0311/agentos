import { probeCodexCli, type CodexProbeResult } from './capabilityProbe.js';
import { CodexAdapter } from './codexAdapter.js';
import { PlainTextAdapter } from './plainTextAdapter.js';
import type { AgentCliAdapter, NormalizedCliEvent } from './types.js';

export interface AdapterResolution {
  adapter: AgentCliAdapter;
  probe?: CodexProbeResult;
  diagnostic?: Extract<NormalizedCliEvent, { type: 'diagnostic' }>;
}

interface RegistryOptions {
  probe?: (command: string) => Promise<CodexProbeResult>;
}

export class AgentCliAdapterRegistry {
  private readonly codex = new CodexAdapter();
  private readonly plain = new PlainTextAdapter();
  private readonly probe: (command: string) => Promise<CodexProbeResult>;

  constructor(options: RegistryOptions = {}) {
    this.probe = options.probe ?? (command => probeCodexCli(command));
  }

  async resolve(command: string): Promise<AdapterResolution> {
    if (!this.codex.matches(command)) return { adapter: this.plain };
    const probe = await this.probe(command);
    if (probe.status === 'AVAILABLE' && probe.supportsStructuredOutput) return { adapter: this.codex, probe };
    return {
      adapter: this.plain,
      probe,
      diagnostic: {
        type: 'diagnostic',
        level: 'warning',
        code: 'adapter.plain_fallback',
        message: 'Codex structured output is unavailable; using plain text fallback',
      },
    };
  }
}
