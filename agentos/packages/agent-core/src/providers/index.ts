/** Provider-only entrypoint. It intentionally does not load legacy CLI probes. */
export { KimiCodeProviderAdapter } from './kimiCodeAdapter.js';
export { ProviderRegistry } from './registry.js';
export { ProviderValidationService } from './validation.js';
export { ProviderRegistryError, normalizedProviderError, providerErrorStatus } from './errors.js';
export {
  KIMICODE_ADAPTER_ID,
  KIMICODE_ADAPTER_VERSION,
  KIMICODE_DEFAULT_EXECUTABLE,
  KIMICODE_PROVIDER_TYPE,
  LEGACY_KIMI_PROVIDER_TYPE,
  canonicalProviderType,
  PROVIDER_ERROR_CODES,
  resolveFrozenProviderIdentity,
} from './types.js';
export type {
  ProviderAdapterManifest,
  ProviderAuthenticationState,
  ProviderCapabilities,
  ProviderCancelInput,
  ProviderCancelResult,
  ProviderConfigurationInput,
  ProviderDiscoveryCandidate,
  ProviderDiscoveryInput,
  ProviderDiscoveryResult,
  ProviderErrorCode,
  ProviderFinalizeInput,
  ProviderFinalResult,
  FrozenProviderIdentity,
  ProviderLaunchPlan,
  ProviderNormalizedError,
  ProviderNormalizedEvent,
  ProviderParseContext,
  ProviderParseResult,
  ProcessProbePort,
  ProviderProcessPort,
  ProviderStartInput,
  ProviderType,
  ProviderValidationError,
  ProviderValidationInput,
  ProviderValidationResult,
  ProviderValidationWarning,
  RuntimeProviderAdapter,
} from './types.js';
