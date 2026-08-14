import { ProviderRegistry } from './registry.js';
import type {
  ProviderAuthProbe,
  ProviderConfigurationInput,
  ProviderDiscoveryResult,
  ProviderProbeRunner,
  ProviderValidationResult,
  ProviderType,
} from './types.js';
import { canonicalProviderType } from './types.js';

export interface ProviderValidationServiceOptions {
  readonly discover?: (input: Parameters<NonNullable<import('./types.js').RuntimeProviderAdapter['discover']>>[0]) => Promise<ProviderDiscoveryResult>;
  readonly run?: ProviderProbeRunner;
  readonly auth?: ProviderAuthProbe;
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
    overrides: Partial<Pick<import('./types.js').ProviderValidationInput, 'environment' | 'workspaceRoot' | 'forceRefresh' | 'now' | 'discover' | 'run' | 'auth'>> = {},
  ): Promise<ProviderValidationResult> {
    const checkedAt = overrides.now ?? this.options.now?.() ?? new Date().toISOString();
    const canonicalType = canonicalProviderType(configuration.providerType as ProviderType);
    let adapter;
    if (configuration.adapterVersion !== undefined) {
      try {
        adapter = this.registry.get(configuration.adapterId, configuration.adapterVersion);
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
    } else {
      adapter = this.registry.findByType(canonicalType).find(candidate => candidate.manifest.id === configuration.adapterId);
    }
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
    return adapter.validate({
      configuration,
      environment: overrides.environment,
      workspaceRoot: overrides.workspaceRoot,
      forceRefresh: overrides.forceRefresh,
      now: checkedAt,
      discover: overrides.discover ?? this.options.discover,
      run: overrides.run ?? this.options.run,
      auth: overrides.auth ?? this.options.auth,
    });
  }
}
