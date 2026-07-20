import { describe, expect, it } from 'vitest';
import { AgentCliAdapterRegistry } from './registry.js';

describe('AgentCliAdapterRegistry', () => {
  it('uses Codex only for a matching command with structured help', async () => {
    const registry = new AgentCliAdapterRegistry({ probe: async () => ({ status: 'AVAILABLE', supportsStructuredOutput: true, version: '1.0.0' }) });
    await expect(registry.resolve('C:/tools/codex.exe')).resolves.toMatchObject({ adapter: { provider: 'codex' }, probe: { status: 'AVAILABLE' } });
  });

  it('falls back to plain with a diagnostic when structured probing is unavailable', async () => {
    const registry = new AgentCliAdapterRegistry({ probe: async () => ({ status: 'UNAVAILABLE', supportsStructuredOutput: false, reason: 'Access is denied' }) });
    await expect(registry.resolve('C:/WindowsApps/codex.exe')).resolves.toMatchObject({ adapter: { provider: 'plain' }, diagnostic: { code: 'adapter.plain_fallback' } });
  });

  it('does not treat non-Codex commands as structured providers', async () => {
    const registry = new AgentCliAdapterRegistry({ probe: async () => ({ status: 'AVAILABLE', supportsStructuredOutput: true, version: '1.0.0' }) });
    await expect(registry.resolve('kimi')).resolves.toMatchObject({ adapter: { provider: 'plain' } });
  });

  it('reports a configured OpenCode command that probes as Codex', async () => {
    const registry = new AgentCliAdapterRegistry({
      probe: async () => ({
        status: 'AVAILABLE',
        configuredProvider: 'opencode',
        detectedProvider: 'codex',
        version: 'codex 1.2.3',
        capabilities: {
          structuredOutput: true,
          jsonSchemaOutput: false,
          assistantDelta: true,
          toolEvents: true,
          usage: true,
          workspaceReadOnly: true,
          approvalEvents: true,
        },
      }),
    });
    const result = await registry.resolve({ configuredProvider: 'opencode', commandPath: 'wrapper.cmd' });
    expect(result.runtime).toMatchObject({ configuredProvider: 'opencode', detectedProvider: 'codex', mismatch: true });
    expect(result.adapter.provider).toBe('codex');
    expect(result.diagnostic?.code).toBe('provider.mismatch');
  });
});
