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
});
