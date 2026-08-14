import { describe, expect, it } from 'vitest';
import { KimiCodeProviderAdapter } from './kimiCodeAdapter.js';
import { ProviderRegistry } from './registry.js';
import { ProviderValidationService } from './validation.js';
import type { ProcessProbePort, ProviderConfigurationInput } from './types.js';

function config(overrides: Partial<ProviderConfigurationInput> = {}): ProviderConfigurationInput {
  return {
    id: 'provider-kimi',
    workspaceId: 'ws-1',
    name: 'KimiCode Local',
    providerType: 'kimicode',
    adapterId: 'builtin.kimicode',
    adapterVersion: '1.0.0',
    runtimeMode: 'cli',
    executable: 'kimi',
    argsTemplate: [],
    secretProfileId: 'secret-ref',
    workingDirectoryMode: 'workspace',
    capabilities: {
      sessionResume: false, structuredEvents: true, nativeApprovals: false, subagents: false,
      toolEvents: true, fileEvents: false, usageEvents: true, reasoningStream: false,
      interactiveInput: false, pause: false, cancellation: true, modelSelection: true,
      workspaceAwareness: true, nativeSandbox: false, outputContracts: false,
    },
    timeoutPolicy: {
      discoveryTimeoutMs: 10_000, validationTimeoutMs: 30_000, startupTimeoutMs: 60_000,
      idleTimeoutMs: 600_000, totalTimeoutMs: null, cancelGracePeriodMs: 5_000, approvalTimeoutMs: null,
    },
    approvalMode: 'agentos', outputMode: 'structured', enabled: true, version: 1,
    ...overrides,
  };
}

function probeFor(version = '0.23.5', help = '--output-format stream-json', auth = 'authenticated'): ProcessProbePort {
  return {
    probe: async request => ({
      stdout: request.args[0] === '--version' ? version : request.args[0] === '--help' ? help : auth,
      stderr: '',
      exitCode: 0,
      signal: null,
    }),
  };
}

function service(options: ConstructorParameters<typeof ProviderValidationService>[1] = {}): ProviderValidationService {
  return new ProviderValidationService(new ProviderRegistry([new KimiCodeProviderAdapter({
    probe: probeFor(),
  })]), {
    discover: async input => ({
      found: true,
      selected: input.configuredExecutable ?? 'C:/kimi.exe',
      candidates: [{ executable: input.configuredExecutable ?? 'C:/kimi.exe', source: 'configuration', confidence: 1 }],
      warnings: [],
    }),
    ...options,
  });
}

describe('ProviderValidationService', () => {
  it('fails closed for disabled and archived configurations without probing', async () => {
    let calls = 0;
    const validator = service({ probe: { probe: async () => { calls += 1; return { stdout: '', stderr: '', exitCode: 0, signal: null }; } } });
    const disabled = await validator.validate(config({ enabled: false }));
    const archived = await validator.validate(config({ archivedAt: '2026-08-15T00:00:00.000Z' }));
    expect(disabled.errors[0]?.code).toBe('PROVIDER_CONFIG_INVALID');
    expect(archived.errors[0]?.code).toBe('PROVIDER_CONFIG_INVALID');
    expect(calls).toBe(0);
  });

  it('reports executable discovery and version failures with stable codes', async () => {
    const missing = service({ discover: async () => ({ found: false, candidates: [], warnings: [] }) });
    const missingResult = await missing.validate(config({ executable: undefined }));
    expect(missingResult.errors.map(error => error.code)).toContain('PROVIDER_NOT_FOUND');

    const unsupported = service({
      discover: async () => ({ found: true, selected: 'C:/kimi.exe', candidates: [{ executable: 'C:/kimi.exe', source: 'configuration', confidence: 1 }], warnings: [] }),
      probe: probeFor('0.10.0'),
    });
    const unsupportedResult = await unsupported.validate(config());
    expect(unsupportedResult.errors.map(error => error.code)).toContain('PROVIDER_VERSION_UNSUPPORTED');
  });

  it('rejects an unregistered frozen adapter version instead of silently selecting another version', async () => {
    const result = await service().validate(config({ adapterVersion: '9.9.9' }));
    expect(result.errors).toEqual([expect.objectContaining({ code: 'PROVIDER_ADAPTER_NOT_FOUND' })]);
  });

  it('freezes a persisted Kimi configuration without adapterVersion to builtin.kimicode@1.0.0', async () => {
    const result = await service().validate(config({ adapterVersion: undefined }));
    expect(result.valid).toBe(true);
    expect(result.cliVersion).toBe('0.23.5');
  });

  it('keeps persisted Kimi compatibility on 1.0.0 when Registry also contains 1.1.0', async () => {
    const stable = new KimiCodeProviderAdapter({ probe: probeFor('0.23.5') });
    const newer = new KimiCodeProviderAdapter({ probe: probeFor('0.10.0') });
    (newer.manifest as { version: string; builtIn: boolean }).version = '1.1.0';
    (newer.manifest as { version: string; builtIn: boolean }).builtIn = false;
    const validator = new ProviderValidationService(new ProviderRegistry([stable, newer]), {
      discover: async input => ({
        found: true,
        selected: input.configuredExecutable ?? 'C:/kimi.exe',
        candidates: [{ executable: input.configuredExecutable ?? 'C:/kimi.exe', source: 'configuration', confidence: 1 }],
        warnings: [],
      }),
    });
    const result = await validator.validate(config({ adapterVersion: undefined }));
    expect(result.valid).toBe(true);
    expect(result.cliVersion).toBe('0.23.5');
  });

  it('fails closed for missing-version adapters without an explicit compatibility freeze', async () => {
    const result = await service().validate(config({ providerType: 'custom-cli', adapterId: 'builtin.custom-cli', adapterVersion: undefined }));
    expect(result.errors).toEqual([expect.objectContaining({ code: 'PROVIDER_VERSION_UNSUPPORTED' })]);
  });

  it('preserves auth states, reports capability/output mismatches, and never emits generic validation failed', async () => {
    const authRequired = service({ probe: probeFor('0.23.5', '--output-format stream-json', 'required') });
    const authResult = await authRequired.validate(config());
    expect(authResult.errors.map(error => error.code)).toContain('PROVIDER_AUTH_REQUIRED');
    expect(authResult.authentication).toBe('required');

    const mismatch = service({ probe: probeFor('0.23.5', '--output-format stream-json', 'unknown') });
    const mismatchResult = await mismatch.validate(config({ outputMode: 'raw-stream', capabilities: { ...config().capabilities, nativeApprovals: true } }));
    expect(mismatchResult.errors.map(error => error.code)).toEqual(expect.arrayContaining([
      'PROVIDER_CAPABILITY_UNAVAILABLE',
      'PROVIDER_CONFIG_INVALID',
    ]));
    expect(JSON.stringify(mismatchResult)).not.toContain('PROVIDER_VALIDATION_FAILED');
    expect(mismatchResult.warnings.some(warning => warning.code === 'PROVIDER_AUTH_UNKNOWN')).toBe(true);
  });

  it('normalizes adapter exceptions into a stable internal provider error', async () => {
    const adapter = new KimiCodeProviderAdapter();
    adapter.validate = async () => { throw new Error('raw token should not escape'); };
    const validator = new ProviderValidationService(new ProviderRegistry([adapter]));
    const result = await validator.validate(config());
    expect(result.errors).toEqual([expect.objectContaining({
      code: 'PROVIDER_INTERNAL_ERROR',
      message: 'Provider validation could not be completed',
    })]);
    expect(JSON.stringify(result)).not.toContain('raw token');
  });
});
