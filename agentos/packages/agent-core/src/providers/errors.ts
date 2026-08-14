import type { ProviderErrorCode, ProviderErrorPhase, ProviderNormalizedError } from './types.js';

export type ProviderRegistryErrorCode =
  | 'DUPLICATE_ADAPTER'
  | 'BUILTIN_ADAPTER_IMMUTABLE'
  | 'INVALID_MANIFEST'
  | 'PROVIDER_ADAPTER_NOT_FOUND'
  | 'PROVIDER_VERSION_UNSUPPORTED';

export class ProviderRegistryError extends Error {
  constructor(
    readonly code: ProviderRegistryErrorCode,
    message: string,
    readonly providerCode?: ProviderErrorCode,
  ) {
    super(message);
    this.name = 'ProviderRegistryError';
  }
}
export function normalizedProviderError(
  code: ProviderErrorCode,
  phase: ProviderErrorPhase,
  message: string,
  retryable = false,
): ProviderNormalizedError {
  return { code, phase, retryable, message };
}

export function providerErrorStatus(code: ProviderErrorCode): number {
  switch (code) {
    case 'PROVIDER_NOT_FOUND': return 404;
    case 'PROVIDER_CONFIG_INVALID':
    case 'PROVIDER_EXECUTABLE_NOT_ACCESSIBLE':
    case 'PROVIDER_VERSION_UNSUPPORTED': return 422;
    case 'PROVIDER_AUTH_REQUIRED':
    case 'PROVIDER_AUTH_EXPIRED':
    case 'PROVIDER_CAPABILITY_UNAVAILABLE':
    case 'PROVIDER_MODEL_UNAVAILABLE':
    case 'PROVIDER_SESSION_NOT_RESUMABLE':
    case 'PROVIDER_APPROVAL_FAILED':
    case 'PROVIDER_CANCEL_FAILED': return 409;
    case 'PROVIDER_RATE_LIMITED':
    case 'PROVIDER_QUOTA_EXCEEDED': return 429;
    case 'PROVIDER_START_FAILED': return 503;
    case 'PROVIDER_NETWORK_ERROR': return 503;
    case 'PROVIDER_PAUSE_UNSUPPORTED':
    case 'PROVIDER_RESUME_FAILED': return 409;
    case 'PROVIDER_ADAPTER_NOT_FOUND': return 409;
    default: return 500;
  }
}
