import { ProviderRegistry } from './registry.js';
import type {
  ProviderConfigurationInput,
  ProviderDiscoveryResult,
  ProcessProbePort,
  ProviderValidationResult,
  ProviderType,
} from './types.js';
import { canonicalProviderType, resolveFrozenProviderIdentity } from './types.js';

export interface ProviderValidationServiceOptions {
  readonly discover?: (input: Parameters<NonNullable<import('./types.js').RuntimeProviderAdapter['discover']>>[0]) => Promise<ProviderDiscoveryResult>;
  readonly probe?: ProcessProbePort;
  readonly now?: () => string;
}

/** Coordinates exact Registry selection and adapter-owned side-effect-light validation. */
export class ProviderValidationService {
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly options: ProviderValidationServiceOptions = {},
  ) {}

  async validate(
    configuration: ProviderConfigurationInput,
    overrides: Partial<Pick<import('./types.js').ProviderValidationInput, 'environment' | 'workspaceRoot' | 'forceRefresh' | 'now' | 'discover' | 'probe'>> = {},
  ): Promise<ProviderValidationResult> {
    const checkedAt = overrides.now ?? this.options.now?.() ?? new Date().toISOString();
    const canonicalType = canonicalProviderType(configuration.providerType as ProviderType);
    const frozenIdentity = resolveFrozenProviderIdentity(configuration);
    if (frozenIdentity === undefined) {
      return {
        valid: false,
        capabilities: configuration.capabilities,
        outputMode: configuration.outputMode,
        warnings: [],
        errors: [{ code: 'PROVIDER_VERSION_UNSUPPORTED', phase: 'validation', message: 'An exact Provider adapter version is required', retryable: false }],
        checkedAt,
      };
    }

    let adapter;
    try {
      adapter = this.registry.get(frozenIdentity.adapterId, frozenIdentity.adapterVersion);
    } catch {
      return {
        valid: false,
        capabilities: configuration.capabilities,
        outputMode: configuration.outputMode,
        warnings: [],
        errors: [{ code: 'PROVIDER_ADAPTER_NOT_FOUND', phase: 'validation', message: 'The configured Provider adapter version is not registered', retryable: false }],
        checkedAt,
      };
    }
    if (!adapter.manifest.providerTypes.includes(canonicalType)) adapter = undefined;
    if (adapter === undefined) {
      return {
        valid: false,
        capabilities: configuration.capabilities,
        outputMode: configuration.outputMode,
        warnings: [],
        errors: [{ code: 'PROVIDER_ADAPTER_NOT_FOUND', phase: 'validation', message: 'The configured Provider adapter is not registered', retryable: false }],
        checkedAt,
      };
    }
    try {
      return await adapter.validate({
        configuration,
        environment: overrides.environment,
        workspaceRoot: overrides.workspaceRoot,
        forceRefresh: overrides.forceRefresh,
        now: checkedAt,
        discover: overrides.discover ?? this.options.discover,
        probe: overrides.probe ?? this.options.probe,
      });
    } catch {
      return {
        valid: false,
        capabilities: configuration.capabilities,
        outputMode: configuration.outputMode,
        warnings: [],
        errors: [{
          code: 'PROVIDER_INTERNAL_ERROR',
          phase: 'internal',
          message: 'Provider validation could not be completed',
          retryable: false,
        }],
        checkedAt,
      };
    }
  }
}
