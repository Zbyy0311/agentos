/** Authoritative 23-member ProviderErrorCode union from Runtime Specification §31. */
export const PROVIDER_ERROR_CODES = Object.freeze([
  'PROVIDER_ADAPTER_NOT_FOUND',
  'PROVIDER_CONFIG_INVALID',
  'PROVIDER_NOT_FOUND',
  'PROVIDER_EXECUTABLE_NOT_ACCESSIBLE',
  'PROVIDER_VERSION_UNSUPPORTED',
  'PROVIDER_AUTH_REQUIRED',
  'PROVIDER_AUTH_EXPIRED',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_QUOTA_EXCEEDED',
  'PROVIDER_MODEL_UNAVAILABLE',
  'PROVIDER_CAPABILITY_UNAVAILABLE',
  'PROVIDER_START_FAILED',
  'PROVIDER_SESSION_FAILED',
  'PROVIDER_SESSION_NOT_RESUMABLE',
  'PROVIDER_OUTPUT_PARSE_FAILED',
  'PROVIDER_OUTPUT_INVALID',
  'PROVIDER_APPROVAL_FAILED',
  'PROVIDER_CANCEL_FAILED',
  'PROVIDER_PAUSE_UNSUPPORTED',
  'PROVIDER_RESUME_FAILED',
  'PROVIDER_NETWORK_ERROR',
  'PROVIDER_INTERNAL_ERROR',
  'PROVIDER_UNKNOWN_ERROR',
] as const);

export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

export type ProviderAuthenticationState =
  | 'authenticated'
  | 'required'
  | 'expired'
  | 'unknown'
  | 'not-required';

export interface ProviderErrorDto {
  readonly code: ProviderErrorCode;
  readonly phase: string;
  readonly retryable: boolean;
  readonly message: string;
}
