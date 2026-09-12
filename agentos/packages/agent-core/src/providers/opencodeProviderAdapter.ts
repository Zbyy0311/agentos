import { access } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import type { ProcessProbeResult, ProcessProbePort } from '@agentos/process-runtime';
import { redactRuntimeText } from '../adapters/redaction.js';
import type { CliEventParser, NormalizedCliEvent } from '../adapters/types.js';
import { normalizedProviderError } from './errors.js';
import type {
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
  ProviderErrorPhase,
  ProviderFinalizeInput,
  ProviderFinalResult,
  ProviderLaunchPlan,
  ProviderNormalizedError,
  ProviderNormalizedEvent,
  ProviderParseContext,
  ProviderParseResult,
  ProviderStartInput,
  ProviderValidationError,
  ProviderValidationInput,
  ProviderValidationResult,
  ProviderValidationWarning,
  RuntimeProviderAdapter,
} from './types.js';
import { PROVIDER_ERROR_CODES, resolveFrozenProviderIdentity } from './types.js';

export const OPENCODE_PROVIDER_TYPE = 'opencode' as const;
export const OPENCODE_ADAPTER_ID = 'builtin.opencode' as const;
export const OPENCODE_ADAPTER_VERSION = '1.0.0' as const;
export const OPENCODE_DEFAULT_EXECUTABLE = 'opencode' as const;

/**
 * The exact CLI build this adapter is qualified against. The real LITE-04-101
 * gate exercised this build end to end; any other build is refused until it is
 * separately qualified, so a silent CLI upgrade cannot change launch semantics.
 */
export const OPENCODE_SUPPORTED_CLI_VERSION = '1.17.11' as const;

/** The parser never retains more than this many characters of assistant text. */
export const OPENCODE_PLAIN_TEXT_MAX_CHARACTERS = 64 * 1024;

/**
 * Evidence boundary for this narrow adapter:
 *
 * - The official CLI documentation establishes `opencode run [message..]`,
 *   `--dir`, `--model`, and the existence of `--format json` raw JSON events.
 * - The repository has no OpenCode event schema/parser, authentication probe,
 *   supported CLI-version range, or provider cancellation protocol.
 *
 * Consequently this adapter exposes only a bounded parsed-text surface. It
 * does not turn the documented JSON flag into a fabricated canonical event
 * contract, and validation remains unavailable until the missing evidence is
 * supplied by a future, separately authorized slice.
 */
const OPENCODE_CAPABILITIES: ProviderCapabilities = {
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
  cancellation: true,
  modelSelection: true,
  workspaceAwareness: true,
  nativeSandbox: false,
  outputContracts: false,
};

const SAFE_ENVIRONMENT_KEYS = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP',
  'USERPROFILE', 'HOME', 'LANG', 'LC_ALL', 'NODE_ENV',
]);
const SECRET_KEY_PATTERN = /(SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL|COOKIE|AUTH)/i;
const SENSITIVE_WARNING_PATTERN = /(?:bearer\s+|oauth|(?:token|api[_-]?key|password|secret|credential)\s*[:=]|-----begin)/i;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_PROMPT_CHARACTERS = 128 * 1024;
const MAX_MODEL_CHARACTERS = 512;

const DISCOVERY_LIMITATION_WARNING = 'OpenCode executable discovery does not prove CLI compatibility or cancellation support';
const AUTH_UNKNOWN_WARNING = 'OpenCode authentication state could not be determined without a dedicated safe probe';

export interface OpenCodeProviderAdapterOptions {
  readonly probe?: ProcessProbePort;
  readonly discover?: (input: ProviderDiscoveryInput) => Promise<ProviderDiscoveryResult>;
}

class BoundedPlainTextParser implements CliEventParser {
  private remaining = OPENCODE_PLAIN_TEXT_MAX_CHARACTERS;
  private truncated = false;

  push(chunk: string): NormalizedCliEvent[] {
    if (!chunk || this.remaining <= 0) return [];

    // Redact common credential-shaped output before applying the output bound.
    // The large limit disables the helper's own truncation marker; this parser
    // owns the single deterministic bound and diagnostic below.
    const safeText = redactRuntimeText(chunk, Number.MAX_SAFE_INTEGER);
    const text = safeText.slice(0, this.remaining);
    this.remaining -= text.length;

    const events: NormalizedCliEvent[] = text
      ? [{ type: 'assistant.message', text }]
      : [];
    if (safeText.length > text.length && !this.truncated) {
      this.truncated = true;
      events.push({
        type: 'diagnostic',
        level: 'warning',
        code: 'adapter.output_truncated',
        message: 'OpenCode plain-text output exceeded the adapter bound',
      });
    }
    return events;
  }

  finish(): NormalizedCliEvent[] {
    return [];
  }
}

export class OpenCodeProviderAdapter implements RuntimeProviderAdapter {
  readonly manifest: ProviderAdapterManifest = {
    id: OPENCODE_ADAPTER_ID,
    name: 'OpenCode',
    version: OPENCODE_ADAPTER_VERSION,
    providerTypes: [OPENCODE_PROVIDER_TYPE],
    runtimeModes: ['cli'],
    capabilities: OPENCODE_CAPABILITIES,
    builtIn: true,
    configSchemaVersion: 1,
    description: 'Conservative OpenCode CLI adapter; parsed-text only pending protocol evidence',
  };

  private readonly probe?: ProcessProbePort;
  private readonly discoverOverride?: (input: ProviderDiscoveryInput) => Promise<ProviderDiscoveryResult>;
  /** A launch plan is admitted only after this adapter observed valid evidence. */
  private readonly validatedExecutables = new Map<string, string>();

  constructor(options: OpenCodeProviderAdapterOptions = {}) {
    this.probe = options.probe;
    this.discoverOverride = options.discover;
  }

  getDefaultCapabilities(_configuration: Partial<ProviderConfigurationInput>): ProviderCapabilities {
    return { ...OPENCODE_CAPABILITIES };
  }

  normalizeConfiguration(configuration: ProviderConfigurationInput): ProviderConfigurationInput {
    const normalized: ProviderConfigurationInput = {
      ...configuration,
      ...(configuration.argsTemplate === undefined ? {} : { argsTemplate: [...configuration.argsTemplate] }),
      capabilities: { ...configuration.capabilities },
      timeoutPolicy: { ...configuration.timeoutPolicy },
    };
    // The production snapshot projection carries no adapter version, so the
    // configured identity is resolved the same way the other canonical adapters
    // resolve it. Without this the OpenCode path was unreachable in production.
    const frozenIdentity = resolveFrozenProviderIdentity(normalized);
    return frozenIdentity === undefined ? normalized : { ...normalized, adapterVersion: frozenIdentity.adapterVersion };
  }

  async discover(input: ProviderDiscoveryInput): Promise<ProviderDiscoveryResult> {
    if (input.providerType !== OPENCODE_PROVIDER_TYPE) {
      return {
        found: false,
        candidates: [],
        warnings: ['OpenCode adapter only supports canonical provider type opencode'],
      };
    }

    if (this.discoverOverride) {
      return sanitizeDiscoveryResult(await this.discoverOverride(input));
    }

    const candidates: ProviderDiscoveryCandidate[] = [];
    const configuredExecutable = input.configuredExecutable?.trim();
    if (configuredExecutable) {
      candidates.push({ executable: configuredExecutable, source: 'configuration', confidence: 1 });
    }

    const environmentExecutable = input.environment.AGENTOS_OPENCODE_CLI?.trim();
    if (environmentExecutable && environmentExecutable !== configuredExecutable) {
      candidates.push({ executable: environmentExecutable, source: 'environment', confidence: 0.95 });
    }

    const platform = input.platform ?? process.platform;
    const pathExecutable = await findOnPath(OPENCODE_DEFAULT_EXECUTABLE, input.environment, platform);
    if (pathExecutable) candidates.push({ executable: pathExecutable, source: 'path', confidence: 0.8 });

    const deduped = dedupeCandidates(candidates, platform);
    const preferred = configuredExecutable ?? environmentExecutable;
    const selected = preferred
      ? await firstUsableCandidate(deduped.filter(candidate => sameExecutable(candidate.executable, preferred, platform)), input.environment, platform)
      : await firstUsableCandidate(deduped, input.environment, platform);

    return {
      found: selected !== undefined,
      ...(selected === undefined ? {} : { selected }),
      candidates: deduped,
      warnings: [DISCOVERY_LIMITATION_WARNING],
    };
  }

  async validate(input: ProviderValidationInput): Promise<ProviderValidationResult> {
    const configuration = this.normalizeConfiguration(input.configuration);
    const checkedAt = input.now ?? new Date().toISOString();
    const environment = input.environment ?? process.env;
    const warnings: ProviderValidationWarning[] = [];
    const errors: ProviderValidationError[] = [];

    this.validatedExecutables.delete(validationKey(configuration));

    if (!configuration.enabled || configuration.archivedAt) {
      errors.push({
        code: 'PROVIDER_CONFIG_INVALID',
        phase: 'configuration',
        message: 'OpenCode provider configuration is disabled or archived',
        retryable: false,
      });
    }
    if (configuration.providerType !== OPENCODE_PROVIDER_TYPE) {
      errors.push({
        code: 'PROVIDER_CONFIG_INVALID',
        phase: 'configuration',
        message: 'OpenCode configuration must use providerType opencode',
        retryable: false,
      });
    }
    if (configuration.adapterId !== OPENCODE_ADAPTER_ID || configuration.runtimeMode !== 'cli') {
      errors.push({
        code: 'PROVIDER_CONFIG_INVALID',
        phase: 'configuration',
        message: 'OpenCode requires builtin.opencode CLI configuration',
        retryable: false,
      });
    }
    // Mirror the other canonical adapters: check the resolved frozen identity,
    // not the raw field, because production never populates the raw field.
    const frozenIdentity = resolveFrozenProviderIdentity(configuration);
    if (frozenIdentity === undefined
      || frozenIdentity.adapterId !== this.manifest.id
      || frozenIdentity.adapterVersion !== this.manifest.version) {
      errors.push({
        code: 'PROVIDER_VERSION_UNSUPPORTED',
        phase: 'validation',
        message: 'OpenCode requires the exact builtin.opencode adapter version 1.0.0',
        retryable: false,
      });
    }
    if (configuration.outputMode !== 'parsed-text') {
      errors.push({
        code: 'PROVIDER_CAPABILITY_UNAVAILABLE',
        phase: 'validation',
        message: 'OpenCode structured output is not admitted without a verified event schema; use parsed-text',
        retryable: false,
      });
    }
    for (const [capability, requested] of Object.entries(configuration.capabilities)) {
      if (requested === true && OPENCODE_CAPABILITIES[capability as keyof ProviderCapabilities] !== true) {
        errors.push({
          code: 'PROVIDER_CAPABILITY_UNAVAILABLE',
          phase: 'validation',
          message: `OpenCode capability ${capability} is not verified`,
          retryable: false,
        });
      }
    }
    try {
      assertSafeArgsTemplate(configuration.argsTemplate ?? []);
      assertNoConflictingEnvironmentAliases(environment, process.platform);
    } catch (error) {
      errors.push({
        code: normalizeConfigurationErrorCode(error),
        phase: 'configuration',
        message: 'OpenCode provider configuration contains an unsafe argument or environment alias',
        retryable: false,
      });
    }

    if (errors.length > 0) {
      return validationResult({ configuration, checkedAt, warnings, errors });
    }

    let discovered: ProviderDiscoveryResult;
    try {
      discovered = await (input.discover ?? (value => this.discover(value)))({
        providerType: OPENCODE_PROVIDER_TYPE,
        configuredExecutable: configuration.executable,
        environment,
        platform: process.platform,
        homeDirectory: environment.USERPROFILE ?? environment.HOME,
      });
    } catch {
      errors.push({
        code: 'PROVIDER_INTERNAL_ERROR',
        phase: 'discovery',
        message: 'OpenCode executable discovery could not be completed',
        retryable: false,
      });
      return validationResult({ configuration, checkedAt, warnings, errors });
    }

    warnings.push(...discovered.warnings.map(message => ({
      code: 'PROVIDER_DISCOVERY_WARNING',
      message: sanitizeWarning(message),
    })));
    if (!discovered.found || !discovered.selected) {
      const explicitlyConfigured = Boolean(configuration.executable?.trim() || environment.AGENTOS_OPENCODE_CLI?.trim());
      errors.push({
        code: explicitlyConfigured ? 'PROVIDER_EXECUTABLE_NOT_ACCESSIBLE' : 'PROVIDER_NOT_FOUND',
        phase: 'discovery',
        message: explicitlyConfigured ? 'OpenCode executable is not accessible' : 'OpenCode executable was not found',
        retryable: false,
      });
      return validationResult({ configuration, checkedAt, warnings, errors });
    }

    const probe = input.probe ?? this.probe;
    warnings.push({ code: 'PROVIDER_AUTH_UNKNOWN', message: AUTH_UNKNOWN_WARNING });

    if (!probe) {
      errors.push({
        code: 'PROVIDER_VERSION_UNSUPPORTED',
        phase: 'validation',
        message: 'OpenCode CLI compatibility range is not established',
        retryable: false,
      });
      errors.push({
        code: 'PROVIDER_CAPABILITY_UNAVAILABLE',
        phase: 'validation',
        message: 'OpenCode safe launch flags cannot be verified without a Process Runtime probe',
        retryable: false,
      });
      return validationResult({
        configuration,
        checkedAt,
        warnings,
        errors,
        executableResolved: discovered.selected,
        authentication: 'unknown',
      });
    }

    const probeEnvironment = safeEnvironmentForOpenCode(environment);
    let versionResult: ProcessProbeResult | undefined;
    let helpResult: ProcessProbeResult | undefined;
    try {
      versionResult = await probe.probe({
        executable: discovered.selected,
        args: ['--version'],
        ...(input.workspaceRoot ? { cwd: input.workspaceRoot } : {}),
        environment: probeEnvironment,
        timeoutMs: configuration.timeoutPolicy.validationTimeoutMs,
      });
      helpResult = await probe.probe({
        executable: discovered.selected,
        args: ['run', '--help'],
        ...(input.workspaceRoot ? { cwd: input.workspaceRoot } : {}),
        environment: probeEnvironment,
        timeoutMs: configuration.timeoutPolicy.validationTimeoutMs,
      });
    } catch {
      errors.push({
        code: 'PROVIDER_INTERNAL_ERROR',
        phase: 'validation',
        message: 'OpenCode validation probe failed',
        retryable: false,
      });
      return validationResult({
        configuration,
        checkedAt,
        warnings,
        errors,
        executableResolved: discovered.selected,
        authentication: 'unknown',
      });
    }

    const versionFailure = providerProbeError(versionResult, 'discovery');
    const cliVersion = versionFailure === undefined ? parseVersion(probeOutput(versionResult)) : undefined;
    if (versionFailure) {
      errors.push({
        code: versionFailure.code,
        phase: versionFailure.phase,
        message: versionFailure.message,
        retryable: versionFailure.retryable,
      });
    } else if (!cliVersion) {
      errors.push({
        code: 'PROVIDER_VERSION_UNSUPPORTED',
        phase: 'validation',
        message: 'OpenCode CLI version could not be verified',
        retryable: false,
      });
    } else if (cliVersion !== OPENCODE_SUPPORTED_CLI_VERSION) {
      // Admit only the version exercised by the real LITE-04-101 gate.
      errors.push({
        code: 'PROVIDER_VERSION_UNSUPPORTED',
        phase: 'validation',
        message: `OpenCode CLI ${cliVersion} is unsupported; this adapter is qualified against ${OPENCODE_SUPPORTED_CLI_VERSION}`,
        retryable: false,
      });
    }

    const helpFailure = providerProbeError(helpResult, 'validation');
    if (helpFailure) {
      errors.push({
        code: helpFailure.code,
        phase: helpFailure.phase,
        message: helpFailure.message,
        retryable: helpFailure.retryable,
      });
    } else if (!hasSafeTextLaunchEvidence(probeOutput(helpResult))) {
      errors.push({
        code: 'PROVIDER_CAPABILITY_UNAVAILABLE',
        phase: 'validation',
        message: 'OpenCode non-interactive safe launch flags are not verified',
        retryable: false,
      });
    }

    const result = validationResult({
      configuration,
      checkedAt,
      warnings,
      errors,
      executableResolved: discovered.selected,
      ...(cliVersion ? { cliVersion } : {}),
      authentication: 'unknown',
    });
    if (result.valid && result.executableResolved) {
      this.validatedExecutables.set(validationKey(configuration), result.executableResolved);
    }
    return result;
  }

  async buildLaunchPlan(input: ProviderStartInput): Promise<ProviderLaunchPlan> {
    const configuration = this.normalizeConfiguration(input.configuration);
    if (
      !configuration.enabled
      || configuration.archivedAt
      || configuration.providerType !== OPENCODE_PROVIDER_TYPE
      || configuration.adapterId !== OPENCODE_ADAPTER_ID
      || configuration.runtimeMode !== 'cli'
      || resolveFrozenProviderIdentity(configuration)?.adapterVersion !== OPENCODE_ADAPTER_VERSION
      || configuration.outputMode !== 'parsed-text'
    ) {
      throw new Error('PROVIDER_CONFIG_INVALID');
    }

    const executable = this.validatedExecutables.get(validationKey(configuration));
    if (!executable) {
      throw new Error('PROVIDER_CAPABILITY_UNAVAILABLE: OpenCode launch requires a successful supported validation');
    }

    const cwd = resolveWorkingDirectory(configuration, input.workspaceRoot, input.worktreePath);
    const prompt = input.prompt;
    if (!prompt.trim() || prompt.length > MAX_PROMPT_CHARACTERS || prompt.includes('\u0000')) {
      throw new Error('PROVIDER_CONFIG_INVALID');
    }

    assertSafeArgsTemplate(configuration.argsTemplate ?? []);
    const args = buildOpenCodeArgs(configuration, cwd, prompt);
    const environment = input.environment ?? process.env;
    const safeEnvironment = safeEnvironmentForOpenCode(environment);
    const redactedEnvironmentKeys = Object.entries(environment)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key)
      .filter(key => SECRET_KEY_PATTERN.test(key));

    for (const [key, value] of Object.entries(input.environmentOverrides ?? {})) {
      if (!ENV_KEY_PATTERN.test(key) || SECRET_KEY_PATTERN.test(key) || !isSafeEnvironmentKey(key, process.platform)) {
        throw new Error('PROVIDER_CONFIG_INVALID');
      }
      if (value.includes('\u0000')) throw new Error('PROVIDER_CONFIG_INVALID');
      assignEnvironmentValue(safeEnvironment, key, value, process.platform);
    }

    const secretRefs = [...new Set(input.secretRefs ?? (configuration.secretProfileId ? [configuration.secretProfileId] : []))];
    return {
      runtimeMode: 'cli',
      executable,
      args,
      cwd,
      environment: safeEnvironment,
      redactedEnvironmentKeys: [...new Set(redactedEnvironmentKeys)].sort(),
      secretRefs,
      stdinMode: 'none',
      promptDelivery: 'argument',
      structuredOutput: 'text',
      cleanupFiles: [],
      shell: false,
      metadata: {
        providerType: OPENCODE_PROVIDER_TYPE,
        adapterId: this.manifest.id,
        adapterVersion: this.manifest.version,
        providerConfigId: configuration.id,
        providerConfigVersion: configuration.version,
        configSchemaVersion: this.manifest.configSchemaVersion,
      },
    };
  }

  createParseContext(): ProviderParseContext {
    return { parser: new BoundedPlainTextParser() };
  }

  parseChunk(chunk: string, context: ProviderParseContext = this.createParseContext()): ProviderParseResult {
    const parser = context.parser ?? new BoundedPlainTextParser();
    const events = parser.push(chunk).map(event => event as ProviderNormalizedEvent);
    return { context: { parser }, events, diagnostics: events.filter(event => event.type === 'diagnostic') };
  }

  finishParse(context: ProviderParseContext): ProviderParseResult {
    const parser = context.parser ?? new BoundedPlainTextParser();
    const events = parser.finish().map(event => event as ProviderNormalizedEvent);
    return { context: { parser }, events, diagnostics: events.filter(event => event.type === 'diagnostic') };
  }

  async finalize(input: ProviderFinalizeInput): Promise<ProviderFinalResult> {
    if (input.cancelled) return { status: 'cancelled', events: input.parsedEvents };
    if (input.providerError) {
      return {
        status: 'failed',
        events: input.parsedEvents,
        error: this.normalizeError(input.providerError, { phase: input.providerError.phase }),
      };
    }

    if (input.parsedEvents.some(event => event.type === 'diagnostic' && event.code === 'adapter.output_truncated')) {
      return {
        status: 'failed',
        events: input.parsedEvents,
        error: normalizedProviderError('PROVIDER_OUTPUT_PARSE_FAILED', 'output-parse', 'OpenCode plain-text output exceeded the safe bound'),
      };
    }
    if (input.exitCode !== 0 || input.signal !== null) {
      const error = this.normalizeError(input.stderr, { phase: 'finalize' });
      const precise = error.code !== 'PROVIDER_INTERNAL_ERROR' && error.code !== 'PROVIDER_UNKNOWN_ERROR';
      return {
        status: 'failed',
        events: input.parsedEvents,
        error: precise ? error : normalizedProviderError('PROVIDER_SESSION_FAILED', 'finalize', 'OpenCode session exited unsuccessfully'),
      };
    }

    const output = input.parsedEvents
      .filter((event): event is Extract<ProviderNormalizedEvent, { type: 'assistant.message' }> => event.type === 'assistant.message')
      .map(event => event.text)
      .join('');
    if (!output) {
      return {
        status: 'failed',
        events: input.parsedEvents,
        error: normalizedProviderError('PROVIDER_OUTPUT_INVALID', 'finalize', 'OpenCode produced no valid assistant output'),
      };
    }
    return { status: 'completed', events: input.parsedEvents, output };
  }

  async cancel(input: ProviderCancelInput): Promise<ProviderCancelResult> {
    // Acceptance requests an owned process stop; terminal completion remains
    // the Process Runtime's responsibility, including escalation and reaping.
    if (!input.stopTicketAccepted) {
      return { accepted: false, error: normalizedProviderError('PROVIDER_CANCEL_FAILED', 'cancel', 'Process stop ticket was not accepted') };
    }
    try {
      const result = await input.processPort.requestGraceful({
        processId: input.processId, sessionId: input.sessionId, reason: input.reason,
      });
      return result.accepted
        ? { accepted: true }
        : { accepted: false, error: normalizedProviderError('PROVIDER_CANCEL_FAILED', 'cancel', 'OpenCode process stop was not accepted') };
    } catch {
      return { accepted: false, error: normalizedProviderError('PROVIDER_CANCEL_FAILED', 'cancel', 'OpenCode process stop failed') };
    }
  }

  normalizeError(error: unknown, context: { readonly phase?: ProviderErrorPhase } = {}): ProviderNormalizedError {
    const phase = context.phase ?? 'internal';
    if (isProviderNormalizedError(error)) {
      return normalizedProviderError(error.code, phase === 'internal' ? error.phase : phase, stableErrorMessage(error.code));
    }

    const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
    if (/PROVIDER_CONFIG_INVALID|invalid (?:provider )?configuration/i.test(text)) {
      return normalizedProviderError('PROVIDER_CONFIG_INVALID', 'configuration', 'OpenCode provider configuration is invalid');
    }
    if (/PROVIDER_VERSION_UNSUPPORTED|version|unsupported/i.test(text)) {
      return normalizedProviderError('PROVIDER_VERSION_UNSUPPORTED', 'validation', 'OpenCode CLI version support is unavailable');
    }
    if (/cancel|stop/i.test(text) || phase === 'cancel') {
      return normalizedProviderError('PROVIDER_CANCEL_FAILED', 'cancel', 'OpenCode cancellation is not verified');
    }
    if (/expired/i.test(text)) {
      return normalizedProviderError('PROVIDER_AUTH_EXPIRED', 'authentication', 'OpenCode authentication has expired');
    }
    if (/auth|login|credential|token|api[_-]?key/i.test(text)) {
      return normalizedProviderError('PROVIDER_AUTH_REQUIRED', 'authentication', 'OpenCode authentication is required');
    }
    if (/rate[ -]?limit|too many requests/i.test(text)) {
      return normalizedProviderError('PROVIDER_RATE_LIMITED', 'runtime', 'OpenCode rate limit reached', true);
    }
    if (/quota/i.test(text)) {
      return normalizedProviderError('PROVIDER_QUOTA_EXCEEDED', 'runtime', 'OpenCode quota was exceeded');
    }
    if (/model.*unavailable|unknown model/i.test(text)) {
      return normalizedProviderError('PROVIDER_MODEL_UNAVAILABLE', 'validation', 'OpenCode model is unavailable');
    }
    if (/ENOENT|not found|access denied|EACCES|EPERM/i.test(text)) {
      return normalizedProviderError('PROVIDER_EXECUTABLE_NOT_ACCESSIBLE', 'discovery', 'OpenCode executable is not accessible');
    }
    if (/format|structured|event schema|safe launch/i.test(text)) {
      return normalizedProviderError('PROVIDER_CAPABILITY_UNAVAILABLE', 'validation', 'OpenCode capability evidence is unavailable');
    }
    if (/network|connect|timed out|timeout/i.test(text)) {
      return normalizedProviderError('PROVIDER_NETWORK_ERROR', 'runtime', 'OpenCode network operation failed', true);
    }
    return normalizedProviderError('PROVIDER_INTERNAL_ERROR', phase, 'OpenCode provider operation failed');
  }
}

interface ValidationResultOptions {
  readonly configuration: ProviderConfigurationInput;
  readonly checkedAt: string;
  readonly warnings: readonly ProviderValidationWarning[];
  readonly errors: readonly ProviderValidationError[];
  readonly executableResolved?: string;
  readonly cliVersion?: string;
  readonly authentication?: ProviderAuthenticationState;
}

function validationResult(options: ValidationResultOptions): ProviderValidationResult {
  return {
    valid: options.errors.length === 0,
    ...(options.executableResolved ? { executableResolved: options.executableResolved } : {}),
    ...(options.cliVersion ? { cliVersion: options.cliVersion } : {}),
    ...(options.authentication ? { authentication: options.authentication } : {}),
    capabilities: { ...OPENCODE_CAPABILITIES },
    outputMode: options.configuration.outputMode,
    warnings: [...options.warnings],
    errors: [...options.errors],
    checkedAt: options.checkedAt,
  };
}

function buildOpenCodeArgs(configuration: ProviderConfigurationInput, cwd: string, prompt: string): string[] {
  const args = ['--pure', 'run', '--format', 'default', '--dir', cwd];
  const model = configuration.model?.trim();
  if (model) {
    if (model.length > MAX_MODEL_CHARACTERS || model.includes('\u0000')) throw new Error('PROVIDER_CONFIG_INVALID');
    args.push('--model', model);
  }
  args.push('--', prompt);
  return args;
}

function assertSafeArgsTemplate(template: readonly string[]): void {
  for (let index = 0; index < template.length; index += 1) {
    const arg = template[index];
    if (arg === undefined || arg.includes('\u0000')) throw new Error('PROVIDER_CONFIG_INVALID');
    if (arg === '--pure' || arg === 'run') continue;
    if (arg === '--format') {
      const format = template[++index];
      if (format !== 'default') throw new Error('PROVIDER_CAPABILITY_UNAVAILABLE');
      continue;
    }
    if (arg === '--dir' || arg === '--model' || arg === '-m') {
      const value = template[++index];
      if (value === undefined || value.startsWith('-') || value.includes('\u0000')) throw new Error('PROVIDER_CONFIG_INVALID');
      continue;
    }
    throw new Error('PROVIDER_CONFIG_INVALID');
  }
}

function resolveWorkingDirectory(configuration: ProviderConfigurationInput, workspaceRoot: string, worktreePath?: string): string {
  const cwd = configuration.workingDirectoryMode === 'worktree'
    ? worktreePath ?? workspaceRoot
    : configuration.workingDirectoryMode === 'custom'
      ? configuration.customWorkingDirectory
      : workspaceRoot;
  if (!cwd || cwd.includes('\u0000')) throw new Error('PROVIDER_CONFIG_INVALID');
  return cwd;
}

function hasSafeTextLaunchEvidence(helpOutput: string): boolean {
  const hasRun = /(?:^|\s)(?:opencode\s+)?run(?:\s|$|\[)/im.test(helpOutput);
  const hasFormat = /(?:^|\s)--format(?:\s|$)/m.test(helpOutput);
  const hasDir = /(?:^|\s)--dir(?:\s|$)/m.test(helpOutput);
  const hasModel = /(?:^|\s)(?:--model|-m)(?:\s|$)/m.test(helpOutput);
  const hasPure = /(?:^|\s)--pure(?:\s|$)/m.test(helpOutput);
  return hasRun && hasFormat && hasDir && hasModel && hasPure;
}

function parseVersion(value: string): string | undefined {
  return value.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/)?.[1];
}

function providerProbeError(result: ProcessProbeResult | undefined, phase: 'discovery' | 'validation'): ProviderNormalizedError | undefined {
  if (!result) return normalizedProviderError('PROVIDER_INTERNAL_ERROR', phase, 'OpenCode validation probe did not return a result');
  switch (result.errorCode) {
    case 'PROCESS_EXECUTABLE_NOT_FOUND':
      return normalizedProviderError('PROVIDER_NOT_FOUND', 'discovery', 'OpenCode executable was not found');
    case 'PROCESS_EXECUTABLE_NOT_ACCESSIBLE':
      return normalizedProviderError('PROVIDER_EXECUTABLE_NOT_ACCESSIBLE', 'discovery', 'OpenCode executable is not accessible');
    case 'PROCESS_STARTUP_TIMEOUT':
      return normalizedProviderError('PROVIDER_INTERNAL_ERROR', phase, 'OpenCode validation probe timed out', true);
    case 'PROCESS_REQUEST_INVALID':
    case 'PROCESS_UNKNOWN_ERROR':
      return normalizedProviderError('PROVIDER_INTERNAL_ERROR', phase, 'OpenCode validation probe failed');
    default:
      return result.exitCode !== 0 && !probeOutput(result).trim()
        ? normalizedProviderError('PROVIDER_INTERNAL_ERROR', phase, 'OpenCode validation probe failed')
        : undefined;
  }
}

function probeOutput(result: ProcessProbeResult | undefined): string {
  return result ? `${result.stdout}${result.stderr}` : '';
}

function safeEnvironmentForOpenCode(
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  assertNoConflictingEnvironmentAliases(environment, platform);
  const result: Record<string, string> = {};
  const selectedComparisonKeys = new Set<string>();
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined || !isSafeEnvironmentKey(key, platform) || SECRET_KEY_PATTERN.test(key)) continue;
    const comparisonKey = comparableEnvironmentKey(key, platform);
    if (selectedComparisonKeys.has(comparisonKey)) continue;
    selectedComparisonKeys.add(comparisonKey);
    result[key] = value;
  }
  return result;
}

export { safeEnvironmentForOpenCode };

function assignEnvironmentValue(environment: Record<string, string>, key: string, value: string, platform: NodeJS.Platform): void {
  const comparisonKey = comparableEnvironmentKey(key, platform);
  const existingKey = Object.keys(environment).find(candidate => comparableEnvironmentKey(candidate, platform) === comparisonKey);
  if (existingKey !== undefined && environment[existingKey] !== value) throw new Error('PROVIDER_CONFIG_INVALID');
  if (existingKey === undefined) environment[key] = value;
}

function assertNoConflictingEnvironmentAliases(
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): void {
  const valuesByComparisonKey = new Map<string, string>();
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) continue;
    const comparisonKey = comparableEnvironmentKey(key, platform);
    const previousValue = valuesByComparisonKey.get(comparisonKey);
    if (previousValue !== undefined && previousValue !== value) throw new Error('PROVIDER_CONFIG_INVALID');
    valuesByComparisonKey.set(comparisonKey, value);
  }
}

function isSafeEnvironmentKey(key: string, platform: NodeJS.Platform): boolean {
  return SAFE_ENVIRONMENT_KEYS.has(platform === 'win32' ? key.toUpperCase() : key);
}

function comparableEnvironmentKey(key: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? key.toUpperCase() : key;
}

async function findOnPath(command: string, environment: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform): Promise<string | undefined> {
  const pathValue = environment.PATH ?? environment.Path ?? '';
  const extensions = platform === 'win32' ? (environment.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension.toLowerCase()}`);
      if (await exists(candidate)) return candidate;
    }
  }
  return undefined;
}

async function firstUsableCandidate(
  candidates: readonly ProviderDiscoveryCandidate[],
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await exists(candidate.executable)) return candidate.executable;
    const command = candidate.executable.trim();
    if (command && !command.includes('\\') && !command.includes('/')) {
      const pathCandidate = await findOnPath(command, environment, platform);
      if (pathCandidate) return pathCandidate;
    }
  }
  return undefined;
}

function sameExecutable(left: string, right: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function dedupeCandidates(candidates: readonly ProviderDiscoveryCandidate[], platform: NodeJS.Platform): ProviderDiscoveryCandidate[] {
  const seen = new Set<string>();
  return candidates.filter(candidate => {
    const key = platform === 'win32' ? candidate.executable.toLowerCase() : candidate.executable;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function sanitizeDiscoveryResult(result: ProviderDiscoveryResult): ProviderDiscoveryResult {
  return {
    ...result,
    warnings: result.warnings.map(sanitizeWarning),
  };
}

function sanitizeWarning(value: string): string {
  const message = value.trim();
  if (!message || SENSITIVE_WARNING_PATTERN.test(message)) return 'Provider discovery warning';
  return message.length > 256 ? `${message.slice(0, 256)}...` : message;
}

function normalizeConfigurationErrorCode(error: unknown): ProviderErrorCode {
  return error instanceof Error && error.message === 'PROVIDER_CAPABILITY_UNAVAILABLE'
    ? 'PROVIDER_CAPABILITY_UNAVAILABLE'
    : 'PROVIDER_CONFIG_INVALID';
}

function validationKey(configuration: ProviderConfigurationInput): string {
  return JSON.stringify([
    configuration.id,
    configuration.providerType,
    configuration.adapterId,
    configuration.adapterVersion,
    configuration.runtimeMode,
    configuration.executable,
    configuration.argsTemplate ?? [],
    configuration.model,
    configuration.workingDirectoryMode,
    configuration.customWorkingDirectory,
    configuration.outputMode,
    configuration.version,
    configuration.secretProfileId,
  ]);
}

function isProviderNormalizedError(value: unknown): value is ProviderNormalizedError {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ProviderNormalizedError>;
  return typeof candidate.code === 'string'
    && (PROVIDER_ERROR_CODES as readonly string[]).includes(candidate.code)
    && typeof candidate.phase === 'string'
    && typeof candidate.message === 'string';
}

function stableErrorMessage(code: ProviderErrorCode): string {
  switch (code) {
    case 'PROVIDER_CONFIG_INVALID': return 'OpenCode provider configuration is invalid';
    case 'PROVIDER_NOT_FOUND': return 'OpenCode executable was not found';
    case 'PROVIDER_EXECUTABLE_NOT_ACCESSIBLE': return 'OpenCode executable is not accessible';
    case 'PROVIDER_VERSION_UNSUPPORTED': return 'OpenCode CLI version support is unavailable';
    case 'PROVIDER_AUTH_REQUIRED': return 'OpenCode authentication is required';
    case 'PROVIDER_AUTH_EXPIRED': return 'OpenCode authentication has expired';
    case 'PROVIDER_RATE_LIMITED': return 'OpenCode rate limit reached';
    case 'PROVIDER_QUOTA_EXCEEDED': return 'OpenCode quota was exceeded';
    case 'PROVIDER_MODEL_UNAVAILABLE': return 'OpenCode model is unavailable';
    case 'PROVIDER_CAPABILITY_UNAVAILABLE': return 'OpenCode capability evidence is unavailable';
    case 'PROVIDER_START_FAILED': return 'OpenCode provider failed to start';
    case 'PROVIDER_SESSION_FAILED': return 'OpenCode session failed';
    case 'PROVIDER_SESSION_NOT_RESUMABLE': return 'OpenCode session resume is unavailable';
    case 'PROVIDER_OUTPUT_PARSE_FAILED': return 'OpenCode output could not be parsed';
    case 'PROVIDER_OUTPUT_INVALID': return 'OpenCode output is invalid';
    case 'PROVIDER_APPROVAL_FAILED': return 'OpenCode approval is unavailable';
    case 'PROVIDER_CANCEL_FAILED': return 'OpenCode cancellation is not verified';
    case 'PROVIDER_PAUSE_UNSUPPORTED': return 'OpenCode pause is unavailable';
    case 'PROVIDER_RESUME_FAILED': return 'OpenCode resume failed';
    case 'PROVIDER_NETWORK_ERROR': return 'OpenCode network operation failed';
    case 'PROVIDER_ADAPTER_NOT_FOUND': return 'OpenCode provider adapter was not found';
    case 'PROVIDER_INTERNAL_ERROR': return 'OpenCode provider operation failed';
    case 'PROVIDER_UNKNOWN_ERROR': return 'OpenCode provider operation failed';
  }
}
