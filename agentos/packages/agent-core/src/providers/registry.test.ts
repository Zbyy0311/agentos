import { describe, expect, it } from 'vitest';
import { KimiCodeProviderAdapter } from './kimiCodeAdapter.js';
import { ProviderRegistry, ProviderRegistryError } from './registry.js';
import type { ProviderAdapterManifest, RuntimeProviderAdapter } from './types.js';

function extension(manifest: ProviderAdapterManifest): RuntimeProviderAdapter {
  return {
    manifest,
    getDefaultCapabilities: () => ({
      sessionResume: false,
      structuredEvents: false,
      nativeApprovals: false,
      subagents: false,
      toolEvents: false,
      fileEvents: false,
      usageEvents: false,
      reasoningStream: false,
      interactiveInput: false,
      pause: false,
      cancellation: false,
      modelSelection: false,
      workspaceAwareness: false,
      nativeSandbox: false,
      outputContracts: false,
    }),
    discover: async () => ({ found: false, candidates: [], warnings: [] }),
    validate: async () => ({
      valid: false,
      capabilities: extension(manifest).getDefaultCapabilities({} as never),
      outputMode: 'parsed-text',
      warnings: [],
      errors: [],
      checkedAt: new Date(0).toISOString(),
    }),
    buildLaunchPlan: async () => { throw new Error('not used'); },
    parseChunk: () => ({ context: {}, events: [], diagnostics: [] }),
    finishParse: () => ({ context: {}, events: [], diagnostics: [] }),
    finalize: async () => ({ status: 'failed', error: { code: 'PROVIDER_INTERNAL_ERROR', phase: 'finalize', retryable: false, message: 'not used' } }),
    cancel: async () => ({ accepted: false, reason: 'not used' }),
    normalizeError: () => ({ code: 'PROVIDER_INTERNAL_ERROR', phase: 'internal', retryable: false, message: 'not used' }),
  };
}

describe('ProviderRegistry', () => {
  it('resolves an exact versioned kimicode adapter and maps legacy kimi only at the boundary', () => {
    const adapter = new KimiCodeProviderAdapter();
    const registry = new ProviderRegistry([adapter]);

    expect(registry.resolve({ adapterId: 'builtin.kimicode', adapterVersion: adapter.manifest.version }).manifest).toEqual(adapter.manifest);
    expect(registry.resolve({ providerType: 'kimicode', adapterId: 'builtin.kimicode', adapterVersion: adapter.manifest.version })).toBe(adapter);
    expect(registry.resolve({ providerType: 'kimi', adapterId: 'builtin.kimicode', adapterVersion: adapter.manifest.version })).toBe(adapter);
    expect(registry.findByType('kimicode')).toEqual([adapter]);
    expect(registry.list()).toEqual([adapter.manifest]);
  });

  it('rejects duplicate exact keys and replacement of a built-in adapter', () => {
    const adapter = new KimiCodeProviderAdapter();
    const registry = new ProviderRegistry([adapter]);
    expect(() => registry.register(adapter)).toThrowError(ProviderRegistryError);
    expect(() => registry.register(extension({ ...adapter.manifest, builtIn: false }))).toThrowError(ProviderRegistryError);
  });

  it('allows distinct versions but never silently substitutes a missing exact version', () => {
    const adapter = new KimiCodeProviderAdapter();
    const newer = extension({ ...adapter.manifest, version: '1.1.0', builtIn: false });
    const registry = new ProviderRegistry([adapter, newer]);

    expect(registry.get('builtin.kimicode', '1.1.0')).toBe(newer);
    expect(() => registry.get('builtin.kimicode', '9.9.9')).toThrowError(
      expect.objectContaining({ code: 'PROVIDER_ADAPTER_NOT_FOUND' }),
    );
  });
});
