import { PROVIDER_ERROR_CODES as SHARED_PROVIDER_ERROR_CODES } from '@agentos/shared';
import type {
  ApprovalModeV1,
  OutputModeV1,
  ProviderCapabilitiesV1,
  ProviderConfigurationSnapshotV1,
  ProviderTypeV1,
  RuntimeModeV1,
  WorkingDirectoryModeV1,
} from '@agentos/shared';
import type { ProviderErrorCode as SharedProviderErrorCode } from '@agentos/shared';
import type { ProcessProbePort } from '@agentos/process-runtime';
import type { CliEventParser, NormalizedCliEvent } from '../adapters/types.js';

export type { ProcessProbePort } from '@agentos/process-runtime';

export const KIMICODE_PROVIDER_TYPE = 'kimicode' as const;
export const LEGACY_KIMI_PROVIDER_TYPE = 'kimi' as const;
export const KIMICODE_ADAPTER_ID = 'builtin.kimicode' as const;
export const KIMICODE_ADAPTER_VERSION = '1.0.0' as const;
export const KIMICODE_DEFAULT_EXECUTABLE = 'kimi' as const;

export type ProviderType = ProviderTypeV1 | typeof LEGACY_KIMI_PROVIDER_TYPE;
export type CanonicalProviderType = ProviderTypeV1;
export type RuntimeMode = RuntimeModeV1;
export type WorkingDirectoryMode = WorkingDirectoryModeV1;
export type ApprovalMode = ApprovalModeV1;
export type OutputMode = OutputModeV1;
export type ProviderCapabilities = ProviderCapabilitiesV1;

/** Structural input shared by the server repository and provider package. */
export interface ProviderConfigurationInput {
  readonly id: string;
  readonly workspaceId?: string;
  readonly name: string;
  readonly providerType: ProviderType;
  readonly adapterId: string;
  /** Optional execution-time freeze; omitted by legacy configuration rows. */
  readonly adapterVersion?: string;
  readonly runtimeMode: RuntimeMode;
  readonly executable?: string;
  readonly argsTemplate?: readonly string[];
  readonly model?: string;
  readonly environmentProfileId?: string;
  readonly secretProfileId?: string;
  readonly workingDirectoryMode: WorkingDirectoryMode;
  readonly customWorkingDirectory?: string;
  readonly capabilities: ProviderCapabilities;
  readonly timeoutPolicy: ProviderConfigurationSnapshotV1['timeoutPolicy'];
  readonly approvalMode: ApprovalMode;
  readonly outputMode: OutputMode;
  readonly enabled: boolean;
  readonly version: number;
  readonly archivedAt?: string;
}

export interface FrozenProviderIdentity {
  readonly adapterId: string;
  readonly adapterVersion: string;
}

/**
 * Resolve the only compatibility identity permitted for an absent persisted
 * adapterVersion. Every other missing-version configuration fails closed.
 */
export function resolveFrozenProviderIdentity(
  configuration: Pick<ProviderConfigurationInput, 'providerType' | 'adapterId' | 'adapterVersion'>,
): FrozenProviderIdentity | undefined {
  if (configuration.adapterVersion !== undefined) {
    return { adapterId: configuration.adapterId, adapterVersion: configuration.adapterVersion };
  }
  if (
    canonicalProviderType(configuration.providerType) === KIMICODE_PROVIDER_TYPE
    && configuration.adapterId === KIMICODE_ADAPTER_ID
  ) {
    return { adapterId: KIMICODE_ADAPTER_ID, adapterVersion: KIMICODE_ADAPTER_VERSION };
  }
  return undefined;
}

export interface ProviderAdapterManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly providerTypes: readonly CanonicalProviderType[];
  readonly runtimeModes: readonly RuntimeMode[];
  readonly capabilities: ProviderCapabilities;
  readonly builtIn: boolean;
  readonly configSchemaVersion: number;
  readonly description?: string;
}

export interface ProviderDiscoveryInput {
  readonly providerType: CanonicalProviderType;
  readonly configuredExecutable?: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly homeDirectory?: string;
}

export interface ProviderDiscoveryCandidate {
  readonly executable: string;
  readonly source: 'configuration' | 'environment' | 'path' | 'default-location' | 'registry';
  readonly confidence: number;
}

export interface ProviderDiscoveryResult {
  readonly found: boolean;
  readonly candidates: readonly ProviderDiscoveryCandidate[];
  readonly selected?: string;
  readonly warnings: readonly string[];
}

export type ProviderAuthenticationState =
  | 'authenticated'
  | 'required'
  | 'expired'
  | 'unknown'
  | 'not-required';

export interface ProviderValidationError {
  readonly code: ProviderErrorCode;
  readonly phase: ProviderErrorPhase;
  readonly message: string;
  readonly retryable: boolean;
}

export interface ProviderValidationWarning {
  readonly code: string;
  readonly message: string;
}

export interface ProviderValidationResult {
  readonly valid: boolean;
  readonly executableResolved?: string;
  readonly cliVersion?: string;
  readonly authentication?: ProviderAuthenticationState;
  readonly capabilities: ProviderCapabilities;
  readonly outputMode: OutputMode;
  readonly warnings: readonly ProviderValidationWarning[];
  readonly errors: readonly ProviderValidationError[];
  readonly checkedAt: string;
}

export interface ProviderValidationInput {
  readonly configuration: ProviderConfigurationInput;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly workspaceRoot?: string;
  readonly forceRefresh?: boolean;
  readonly now?: string;
  readonly discover?: (input: ProviderDiscoveryInput) => Promise<ProviderDiscoveryResult>;
  readonly probe?: ProcessProbePort;
}

export interface ProviderStartInput {
  readonly configuration: ProviderConfigurationInput;
  readonly workspaceRoot: string;
  readonly worktreePath?: string;
  readonly prompt: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly environmentOverrides?: Readonly<Record<string, string>>;
  readonly secretRefs?: readonly string[];
}

export interface ProviderLaunchPlan {
  readonly runtimeMode: RuntimeMode;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly redactedEnvironmentKeys: readonly string[];
  readonly secretRefs: readonly string[];
  readonly stdinMode: 'none' | 'prompt' | 'interactive';
  readonly promptDelivery: 'argument' | 'stdin' | 'file' | 'api-body' | 'provider-native';
  readonly structuredOutput: 'jsonl' | 'json' | 'text' | 'provider-native';
  readonly cleanupFiles: readonly string[];
  readonly shell: false;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

export interface ProviderParseContext {
  readonly parser?: CliEventParser;
}

/** Provider-facing events use canonical M4 provider vocabulary. */
export type ProviderNormalizedEvent =
  | Exclude<NormalizedCliEvent, { type: 'usage' }>
  | (Omit<Extract<NormalizedCliEvent, { type: 'usage' }>, 'provider'> & {
      readonly provider?: CanonicalProviderType;
    });

export interface ProviderParseResult {
  readonly context: ProviderParseContext;
  readonly events: readonly ProviderNormalizedEvent[];
  readonly diagnostics: readonly ProviderNormalizedEvent[];
}

export interface ProviderFinalizeInput {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly parsedEvents: readonly ProviderNormalizedEvent[];
  readonly stderr?: string;
  readonly cancelled?: boolean;
  readonly providerError?: ProviderNormalizedError;
}

export interface ProviderFinalResult {
  readonly status: 'completed' | 'failed' | 'cancelled';
  readonly events?: readonly ProviderNormalizedEvent[];
  readonly error?: ProviderNormalizedError;
  readonly output?: string;
}

export interface ProviderProcessPort {
  requestGraceful(input: {
    readonly processId: string;
    readonly sessionId: string;
    readonly reason: string;
  }): Promise<{ readonly accepted: boolean }>;
}

export interface ProviderCancelInput {
  readonly sessionId: string;
  readonly processId: string;
  readonly reason: string;
  readonly stopTicketAccepted: boolean;
  readonly processPort: ProviderProcessPort;
}

export interface ProviderCancelResult {
  readonly accepted: boolean;
  readonly error?: ProviderNormalizedError;
}

export type ProviderErrorPhase =
  | 'configuration'
  | 'discovery'
  | 'validation'
  | 'authentication'
  | 'startup'
  | 'runtime'
  | 'output-parse'
  | 'finalize'
  | 'cancel'
  | 'internal';

export const PROVIDER_ERROR_CODES = SHARED_PROVIDER_ERROR_CODES;

export type ProviderErrorCode = SharedProviderErrorCode;

export interface ProviderNormalizedError {
  readonly code: ProviderErrorCode;
  readonly phase: ProviderErrorPhase;
  readonly retryable: boolean;
  readonly message: string;
}

export interface RuntimeProviderAdapter {
  readonly manifest: ProviderAdapterManifest;
  normalizeConfiguration?(configuration: ProviderConfigurationInput): ProviderConfigurationInput;
  getDefaultCapabilities(configuration: Partial<ProviderConfigurationInput>): ProviderCapabilities;
  discover(input: ProviderDiscoveryInput): Promise<ProviderDiscoveryResult>;
  validate(input: ProviderValidationInput): Promise<ProviderValidationResult>;
  buildLaunchPlan(input: ProviderStartInput): Promise<ProviderLaunchPlan>;
  parseChunk(chunk: string, context?: ProviderParseContext): ProviderParseResult;
  finishParse(context: ProviderParseContext): ProviderParseResult;
  finalize(input: ProviderFinalizeInput): Promise<ProviderFinalResult>;
  cancel(input: ProviderCancelInput): Promise<ProviderCancelResult>;
  normalizeError(error: unknown, context?: { readonly phase?: ProviderErrorPhase }): ProviderNormalizedError;
}

export function canonicalProviderType(value: ProviderType): CanonicalProviderType {
  return value === LEGACY_KIMI_PROVIDER_TYPE ? KIMICODE_PROVIDER_TYPE : value;
}
