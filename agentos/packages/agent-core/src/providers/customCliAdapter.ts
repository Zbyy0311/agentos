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
import {
  CUSTOM_CLI_ADAPTER_ID,
  CUSTOM_CLI_ADAPTER_VERSION,
  CUSTOM_CLI_PROVIDER_TYPE,
  PROVIDER_ERROR_CODES,
  resolveFrozenProviderIdentity,
} from './types.js';

export {
  CUSTOM_CLI_ADAPTER_ID,
  CUSTOM_CLI_ADAPTER_VERSION,
  CUSTOM_CLI_PROVIDER_TYPE,
} from './types.js';

/** The parser never retains more than this many characters of assistant text. */
export const CUSTOM_CLI_PLAIN_TEXT_MAX_CHARACTERS = 64 * 1024;

const CUSTOM_CLI_CAPABILITIES: ProviderCapabilities = {
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

const DISCOVERY_LIMITATION_WARNING = 'Custom CLI executable discovery does not prove CLI compatibility';
const AUTH_UNKNOWN_WARNING = 'Custom CLI authentication state could not be determined without a dedicated safe probe';

/** Template variables this adapter can expand; anything else is preserved verbatim. */
const KNOWN_TEMPLATE_VARIABLES = /\{\{(prompt|model|workingDirectory)\}\}/g;
const ANY_TEMPLATE_VARIABLE = /\{\{[^}]+\}\}/;

export interface CustomCliAdapterOptions {
  readonly probe?: ProcessProbePort;
  readonly discover?: (input: ProviderDiscoveryInput) => Promise<ProviderDiscoveryResult>;
}

/**
 * Line-delimited passthrough parser for generic CLIs: every complete output
 * line becomes one assistant.message event. Partial lines are buffered until
 * the next chunk or finish(); credentials are redacted before bounding.
 */
class LineDelimitedTextParser implements CliEventParser {
  private buffer = '';
  private remaining = CUSTOM_CLI_PLAIN_TEXT_MAX_CHARACTERS;
  private truncated = false;

  push(chunk: string): NormalizedCliEvent[] {
    if (!chunk || this.remaining <= 0) return [];
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? '';
    const events: NormalizedCliEvent[] = [];
    for (const line of lines) this.emitLine(line, events);
    return events;
  }

  finish(): NormalizedCliEvent[] {
    const events: NormalizedCliEvent[] = [];
    if (this.buffer) {
      this.emitLine(this.buffer, events);
      this.buffer = '';
    }
    return events;
  }

  private emitLine(line: string, events: NormalizedCliEvent[]): void {
    if (this.remaining <= 0) {
      this.markTruncated(events);
      return;
    }
    const safeText = redactRuntimeText(line, Number.MAX_SAFE_INTEGER);
    const text = safeText.slice(0, this.remaining);
    this.remaining -= text.length;
    if (text) events.push({ type: 'assistant.message', text });
    if (safeText.length > text.length) this.markTruncated(events);
  }

  private markTruncated(events: NormalizedCliEvent[]): void {
    if (this.truncated) return;
    this.truncated = true;
    events.push({
      type: 'diagnostic',
      level: 'warning',
      code: 'adapter.output_truncated',
      message: 'Custom CLI plain-text output exceeded the adapter bound',
    });
  }
}

export class CustomCliAdapter implements RuntimeProviderAdapter {
  readonly manifest: ProviderAdapterManifest = {
    id: CUSTOM_CLI_ADAPTER_ID,
    name: 'Custom CLI',
    version: CUSTOM_CLI_ADAPTER_VERSION,
    providerTypes: [CUSTOM_CLI_PROVIDER_TYPE],
    runtimeModes: ['cli'],
    capabilities: CUSTOM_CLI_CAPABILITIES,
    builtIn: true,
    configSchemaVersion: 1,
    description: 'Generic custom CLI adapter; line-delimited parsed-text passthrough',
  };

  private readonly probe?: ProcessProbePort;
  private readonly discoverOverride?: (input: ProviderDiscoveryInput) => Promise<ProviderDiscoveryResult>;
  /**
   * finalize() receives no configuration, so the success set of the most recent
   * launch plan is retained on the instance, the same way OpenCode retains its
   * validated executables across the validate/buildLaunchPlan boundary.
   */
  private lastSuccessExitCodes: readonly number[] = [0];

  constructor(options: CustomCliAdapterOptions = {}) {
    this.probe = options.probe;
    this.discoverOverride = options.discover;
  }

  getDefaultCapabilities(_configuration: Partial<ProviderConfigurationInput>): ProviderCapabilities {
    return { ...CUSTOM_CLI_CAPABILITIES };
  }

  normalizeConfiguration(configuration: ProviderConfigurationInput): ProviderConfigurationInput {
    const normalized: ProviderConfigurationInput = {
      ...configuration,
      ...(configuration.argsTemplate === undefined ? {} : { argsTemplate: [...configuration.argsTemplate] }),
      capabilities: { ...configuration.capabilities },
      timeoutPolicy: { ...configuration.timeoutPolicy },
    };
    const frozenIdentity = resolveFrozenProviderIdentity(normalized);
    return frozenIdentity === undefined ? normalized : { ...normalized, adapterVersion: frozenIdentity.adapterVersion };
  }

  async discover(input: ProviderDiscoveryInput): Promise<ProviderDiscoveryResult> {
    if (input.providerType !== CUSTOM_CLI_PROVIDER_TYPE) {
      return {
        found: false,
        candidates: [],
        warnings: ['Custom CLI adapter only supports canonical provider type custom-cli'],
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
    const environmentExecutable = input.environment.AGENTOS_CUSTOM_CLI?.trim();
    if (environmentExecutable && environmentExecutable !== configuredExecutable) {
      candidates.push({ executable: environmentExecutable, source: 'environment', confidence: 0.95 });
    }

    const platform = input.platform ?? process.platform;
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

    if (!configuration.enabled || configuration.archivedAt) {
      errors.push({
        code: 'PROVIDER_CONFIG_INVALID',
        phase: 'configuration',
        message: 'Custom CLI provider configuration is disabled or archived',
        retryable: false,
      });
    }
    if (configuration.providerType !== CUSTOM_CLI_PROVIDER_TYPE) {
      errors.push({
        code: 'PROVIDER_CONFIG_INVALID',
        phase: 'configuration',
        message: 'Custom CLI configuration must use providerType custom-cli',
        retryable: false,
      });
    }
    if (configuration.adapterId !== CUSTOM_CLI_ADAPTER_ID || configuration.runtimeMode !== 'cli') {
      errors.push({
        code: 'PROVIDER_CONFIG_INVALID',
        phase: 'configuration',
        message: 'Custom CLI requires builtin.custom-cli CLI configuration',
        retryable: false,
      });
    }
    const frozenIdentity = resolveFrozenProviderIdentity(configuration);
    if (frozenIdentity === undefined
      || frozenIdentity.adapterId !== this.manifest.id
      || frozenIdentity.adapterVersion !== this.manifest.version) {
      errors.push({
        code: 'PROVIDER_VERSION_UNSUPPORTED',
        phase: 'validation',
        message: 'Custom CLI requires the exact builtin.custom-cli adapter version 1.0.0',
        retryable: false,
      });
    }
    if (!configuration.executable?.trim()) {
      errors.push({
        code: 'PROVIDER_CONFIG_INVALID',
        phase: 'configuration',
        message: 'Custom CLI requires an explicit executable',
        retryable: false,
      });
    }
    if (configuration.outputMode === 'structured') {
      errors.push({
        code: 'PROVIDER_CAPABILITY_UNAVAILABLE',
        phase: 'configuration',
        message: 'Custom CLI has no verified structured event schema; use parsed-text or raw-stream',
        retryable: false,
      });
    }
    if (configuration.promptDelivery !== undefined
      && configuration.promptDelivery !== 'argument'
      && configuration.promptDelivery !== 'stdin') {
      errors.push({
        code: 'PROVIDER_CAPABILITY_UNAVAILABLE',
        phase: 'configuration',
        message: `Custom CLI promptDelivery '${configuration.promptDelivery}' is not supported; use 'argument' or 'stdin'`,
        retryable: false,
      });
    }
    if (configuration.promptDelivery === 'stdin' && (configuration.argsTemplate ?? []).some(arg => arg.includes('{{prompt}}'))) {
      errors.push({
        code: 'PROVIDER_CONFIG_INVALID',
        phase: 'configuration',
        message: "Custom CLI stdin promptDelivery cannot also expand '{{prompt}}' in argsTemplate",
        retryable: false,
      });
    }
    if (configuration.successExitCodes !== undefined
      && (!Array.isArray(configuration.successExitCodes)
        || configuration.successExitCodes.length === 0
        || !configuration.successExitCodes.every(code => Number.isInteger(code)))) {
      errors.push({
        code: 'PROVIDER_CONFIG_INVALID',
        phase: 'configuration',
        message: 'Custom CLI successExitCodes must be a non-empty array of integers',
        retryable: false,
      });
    }
    for (const [capability, requested] of Object.entries(configuration.capabilities)) {
      if (requested === true && CUSTOM_CLI_CAPABILITIES[capability as keyof ProviderCapabilities] !== true) {
        errors.push({
          code: 'PROVIDER_CAPABILITY_UNAVAILABLE',
          phase: 'validation',
          message: `Custom CLI capability ${capability} is not verified`,
          retryable: false,
        });
      }
    }
    try {
      assertSafeArgsTemplate(configuration.argsTemplate ?? []);
    } catch (error) {
      errors.push({
        code: error instanceof Error && error.message === 'PROVIDER_CAPABILITY_UNAVAILABLE'
          ? 'PROVIDER_CAPABILITY_UNAVAILABLE'
          : 'PROVIDER_CONFIG_INVALID',
        phase: 'configuration',
        message: 'Custom CLI argsTemplate contains an unsafe argument',
        retryable: false,
      });
    }
    for (const unresolved of listUnresolvedTemplateVariables(configuration.argsTemplate ?? [], configuration)) {
      warnings.push({
        code: 'PROVIDER_TEMPLATE_VARIABLE_UNRESOLVED',
        message: `Custom CLI argsTemplate variable ${unresolved} has no provided value and is preserved verbatim`,
      });
    }

    if (errors.length > 0) {
      return validationResult({ configuration, checkedAt, warnings, errors });
    }

    let discovered: ProviderDiscoveryResult;
    try {
      discovered = await (input.discover ?? (value => this.discover(value)))({
        providerType: CUSTOM_CLI_PROVIDER_TYPE,
        configuredExecutable: configuration.executable,
        environment,
        platform: process.platform,
        homeDirectory: environment.USERPROFILE ?? environment.HOME,
      });
    } catch {
      errors.push({
        code: 'PROVIDER_INTERNAL_ERROR',
        phase: 'discovery',
        message: 'Custom CLI executable discovery could not be completed',
        retryable: false,
      });
      return validationResult({ configuration, checkedAt, warnings, errors });
    }

    warnings.push(...discovered.warnings.map(message => ({
      code: 'PROVIDER_DISCOVERY_WARNING',
      message: sanitizeWarning(message),
    })));
    if (!discovered.found || !discovered.selected) {
      errors.push({
        code: configuration.executable?.trim() ? 'PROVIDER_EXECUTABLE_NOT_ACCESSIBLE' : 'PROVIDER_NOT_FOUND',
        phase: 'discovery',
        message: configuration.executable?.trim()
          ? 'Custom CLI executable is not accessible'
          : 'Custom CLI executable was not found',
        retryable: false,
      });
      return validationResult({ configuration, checkedAt, warnings, errors });
    }

    const authentication: ProviderAuthenticationState = 'unknown';
    warnings.push({ code: 'PROVIDER_AUTH_UNKNOWN', message: AUTH_UNKNOWN_WARNING });

    // Generic CLIs have no unified --version/--help contract: probe failures
    // degrade to warnings instead of hard validation errors.
    const probe = input.probe ?? this.probe;
    let cliVersion: string | undefined;
    if (!probe) {
      warnings.push({
        code: 'PROVIDER_VERSION_UNKNOWN',
        message: 'Custom CLI version was not probed because no Process Runtime probe is configured',
      });
    } else {
      const probeEnvironment = safeEnvironmentForCustomCli(environment);
      const versionResult = await probeSafely(probe, {
        executable: discovered.selected,
        args: ['--version'],
        environment: probeEnvironment,
        timeoutMs: configuration.timeoutPolicy.validationTimeoutMs,
      });
      const versionFailure = providerProbeError(versionResult, 'discovery');
      if (versionFailure) {
        warnings.push({ code: versionFailure.code, message: sanitizeWarning(versionFailure.message) });
      } else {
        cliVersion = parseVersion(probeOutput(versionResult));
        if (!cliVersion) {
          warnings.push({
            code: 'PROVIDER_VERSION_UNKNOWN',
            message: 'Custom CLI --version output did not contain a recognizable version',
          });
        }
      }

      const helpResult = await probeSafely(probe, {
        executable: discovered.selected,
        args: ['--help'],
        environment: probeEnvironment,
        timeoutMs: configuration.timeoutPolicy.validationTimeoutMs,
      });
      const helpFailure = providerProbeError(helpResult, 'validation');
      if (helpFailure) {
        warnings.push({ code: helpFailure.code, message: sanitizeWarning(`${helpFailure.message}; --help probe degraded because generic CLIs have no unified help contract`) });
      }
    }

    return validationResult({
      configuration,
      checkedAt,
      warnings,
      errors,
      executableResolved: discovered.selected,
      ...(cliVersion ? { cliVersion } : {}),
      authentication,
    });
  }

  async buildLaunchPlan(input: ProviderStartInput): Promise<ProviderLaunchPlan> {
    const configuration = this.normalizeConfiguration(input.configuration);
    if (
      !configuration.enabled
      || configuration.archivedAt
      || configuration.providerType !== CUSTOM_CLI_PROVIDER_TYPE
      || configuration.adapterId !== CUSTOM_CLI_ADAPTER_ID
      || configuration.runtimeMode !== 'cli'
      || resolveFrozenProviderIdentity(configuration)?.adapterVersion !== CUSTOM_CLI_ADAPTER_VERSION
    ) {
      throw new Error('PROVIDER_CONFIG_INVALID');
    }

    const promptDelivery = configuration.promptDelivery ?? 'argument';
    if (promptDelivery !== 'argument' && promptDelivery !== 'stdin') {
      throw new Error(`PROMPT_DELIVERY_UNSUPPORTED: Custom CLI supports promptDelivery 'argument' or 'stdin', got '${promptDelivery}'`);
    }

    const prompt = input.prompt;
    if (!prompt.trim() || prompt.length > MAX_PROMPT_CHARACTERS || prompt.includes('\u0000')) {
      throw new Error('PROVIDER_CONFIG_INVALID');
    }
    const model = configuration.model?.trim();
    if (model !== undefined && (model.length > MAX_MODEL_CHARACTERS || model.includes('\u0000'))) {
      throw new Error('PROVIDER_CONFIG_INVALID');
    }

    const executable = configuration.executable?.trim();
    if (!executable) throw new Error('PROVIDER_CONFIG_INVALID');

    const cwd = resolveWorkingDirectory(configuration, input.workspaceRoot, input.worktreePath);
    assertSafeArgsTemplate(configuration.argsTemplate ?? []);
    if (promptDelivery === 'stdin' && (configuration.argsTemplate ?? []).some(arg => arg.includes('{{prompt}}'))) {
      throw new Error('PROVIDER_CONFIG_INVALID');
    }
    const args = expandArgsTemplate(
      configuration.argsTemplate ?? [],
      { prompt, model, workingDirectory: cwd },
      promptDelivery !== 'stdin',
    );
    const successExitCodes = configuration.successExitCodes ?? [0];
    this.lastSuccessExitCodes = [...successExitCodes];

    const environment = input.environment ?? process.env;
    assertNoConflictingEnvironmentAliases(environment, process.platform);
    const safeEnvironment = safeEnvironmentForCustomCli(environment);
    const redactedEnvironmentKeys = Object.entries(environment)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key)
      .filter(key => SECRET_KEY_PATTERN.test(key));

    for (const [key, value] of Object.entries(input.environmentOverrides ?? {})) {
      if (!ENV_KEY_PATTERN.test(key) || SECRET_KEY_PATTERN.test(key)) throw new Error('PROVIDER_CONFIG_INVALID');
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
      stdinMode: promptDelivery === 'stdin' ? 'prompt' : 'none',
      promptDelivery,
      structuredOutput: 'text',
      cleanupFiles: [],
      shell: false,
      metadata: {
        providerType: CUSTOM_CLI_PROVIDER_TYPE,
        adapterId: this.manifest.id,
        adapterVersion: this.manifest.version,
        providerConfigId: configuration.id,
        providerConfigVersion: configuration.version,
        configSchemaVersion: this.manifest.configSchemaVersion,
        successExitCodeCount: successExitCodes.length,
      },
    };
  }

  createParseContext(): ProviderParseContext {
    return { parser: new LineDelimitedTextParser() };
  }

  parseChunk(chunk: string, context: ProviderParseContext = this.createParseContext()): ProviderParseResult {
    const parser = context.parser ?? new LineDelimitedTextParser();
    const events = parser.push(chunk).map(event => event as ProviderNormalizedEvent);
    return { context: { parser }, events, diagnostics: events.filter(event => event.type === 'diagnostic') };
  }

  finishParse(context: ProviderParseContext = this.createParseContext()): ProviderParseResult {
    const parser = context.parser ?? new LineDelimitedTextParser();
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
        error: normalizedProviderError('PROVIDER_OUTPUT_PARSE_FAILED', 'output-parse', 'Custom CLI plain-text output exceeded the safe bound'),
      };
    }
    const successExitCodes = this.lastSuccessExitCodes;
    if (input.exitCode === null || !successExitCodes.includes(input.exitCode) || input.signal !== null) {
      const error = this.normalizeError(input.stderr, { phase: 'finalize' });
      const precise = error.code !== 'PROVIDER_INTERNAL_ERROR' && error.code !== 'PROVIDER_UNKNOWN_ERROR';
      return {
        status: 'failed',
        events: input.parsedEvents,
        error: precise
          ? error
          : normalizedProviderError(
            'PROVIDER_SESSION_FAILED',
            'finalize',
            `Custom CLI session exited unsuccessfully (exit code ${input.exitCode ?? 'null'})`,
          ),
      };
    }

    const output = input.parsedEvents
      .filter((event): event is Extract<ProviderNormalizedEvent, { type: 'assistant.message' }> => event.type === 'assistant.message')
      .map(event => event.text)
      .join('\n');
    if (!output) {
      return {
        status: 'failed',
        events: input.parsedEvents,
        error: normalizedProviderError('PROVIDER_OUTPUT_INVALID', 'finalize', 'Custom CLI produced no valid assistant output'),
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
        : { accepted: false, error: normalizedProviderError('PROVIDER_CANCEL_FAILED', 'cancel', 'Custom CLI process stop was not accepted') };
    } catch {
      return { accepted: false, error: normalizedProviderError('PROVIDER_CANCEL_FAILED', 'cancel', 'Custom CLI process stop failed') };
    }
  }

  normalizeError(error: unknown, context: { readonly phase?: ProviderErrorPhase } = {}): ProviderNormalizedError {
    const phase = context.phase ?? 'internal';
    if (isProviderNormalizedError(error)) {
      // Re-normalization must preserve retryability as well as the code.
      return normalizedProviderError(
        error.code,
        phase === 'internal' ? error.phase : phase,
        stableErrorMessage(error.code),
        error.retryable,
      );
    }

    const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
    if (/PROMPT_DELIVERY_UNSUPPORTED/.test(text)) {
      return normalizedProviderError('PROVIDER_CAPABILITY_UNAVAILABLE', phase === 'internal' ? 'configuration' : phase, 'Custom CLI prompt delivery mode is unsupported');
    }
    if (/PROVIDER_CONFIG_INVALID|invalid (?:provider )?configuration/i.test(text)) {
      return normalizedProviderError('PROVIDER_CONFIG_INVALID', 'configuration', 'Custom CLI provider configuration is invalid');
    }
    if (/PROVIDER_VERSION_UNSUPPORTED|version|unsupported/i.test(text)) {
      return normalizedProviderError('PROVIDER_VERSION_UNSUPPORTED', 'validation', 'Custom CLI version support is unavailable');
    }
    if (/cancel|stop/i.test(text) || phase === 'cancel') {
      return normalizedProviderError('PROVIDER_CANCEL_FAILED', 'cancel', 'Custom CLI cancellation failed');
    }
    if (/expired/i.test(text)) {
      return normalizedProviderError('PROVIDER_AUTH_EXPIRED', 'authentication', 'Custom CLI authentication has expired');
    }
    if (/auth|login|credential|token|api[_-]?key/i.test(text)) {
      return normalizedProviderError('PROVIDER_AUTH_REQUIRED', 'authentication', 'Custom CLI authentication is required');
    }
    if (/rate[ -]?limit|too many requests/i.test(text)) {
      return normalizedProviderError('PROVIDER_RATE_LIMITED', 'runtime', 'Custom CLI rate limit reached', true);
    }
    if (/quota/i.test(text)) {
      return normalizedProviderError('PROVIDER_QUOTA_EXCEEDED', 'runtime', 'Custom CLI quota was exceeded');
    }
    if (/model.*unavailable|unknown model/i.test(text)) {
      return normalizedProviderError('PROVIDER_MODEL_UNAVAILABLE', 'validation', 'Custom CLI model is unavailable');
    }
    if (/ENOENT|not found|access denied|EACCES|EPERM/i.test(text)) {
      return normalizedProviderError('PROVIDER_EXECUTABLE_NOT_ACCESSIBLE', 'discovery', 'Custom CLI executable is not accessible');
    }
    if (/network|connect|timed out|timeout/i.test(text)) {
      return normalizedProviderError('PROVIDER_NETWORK_ERROR', 'runtime', 'Custom CLI network operation failed', true);
    }
    return normalizedProviderError('PROVIDER_INTERNAL_ERROR', phase, 'Custom CLI provider operation failed');
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
    capabilities: { ...CUSTOM_CLI_CAPABILITIES },
    outputMode: options.configuration.outputMode,
    warnings: [...options.warnings],
    errors: [...options.errors],
    checkedAt: options.checkedAt,
  };
}

/** Expands {{prompt}}, {{model}} and {{workingDirectory}}; unknown or unprovided variables stay verbatim. */
export function expandArgsTemplate(
  template: readonly string[],
  values: { readonly prompt: string; readonly model?: string; readonly workingDirectory: string },
  appendPrompt = true,
): string[] {
  let sawPrompt = false;
  const args = template.map(arg => arg.replace(KNOWN_TEMPLATE_VARIABLES, (_match, name: string) => {
    if (name === 'prompt') {
      sawPrompt = true;
      return values.prompt;
    }
    if (name === 'model') return values.model ?? '{{model}}';
    return values.workingDirectory;
  }));
  if (!sawPrompt && appendPrompt) args.push(values.prompt);
  return args;
}

function listUnresolvedTemplateVariables(template: readonly string[], configuration: ProviderConfigurationInput): string[] {
  const unresolved = new Set<string>();
  for (const arg of template) {
    const expanded = expandArgsTemplate([arg], {
      prompt: 'probe-prompt',
      model: configuration.model?.trim() || undefined,
      workingDirectory: 'probe-directory',
    })[0] ?? '';
    for (const match of expanded.matchAll(/\{\{([^}]+)\}\}/g)) unresolved.add(`{{${match[1]}}}`);
  }
  return [...unresolved].sort();
}

function assertSafeArgsTemplate(template: readonly string[]): void {
  for (const arg of template) {
    if (typeof arg !== 'string' || arg.includes('\u0000')) throw new Error('PROVIDER_CONFIG_INVALID');
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

function parseVersion(value: string): string | undefined {
  return value.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/)?.[1];
}

async function probeSafely(probe: ProcessProbePort, request: Parameters<ProcessProbePort['probe']>[0]): Promise<ProcessProbeResult | undefined> {
  try {
    return await probe.probe(request);
  } catch {
    return undefined;
  }
}

function providerProbeError(result: ProcessProbeResult | undefined, phase: 'discovery' | 'validation'): ProviderNormalizedError | undefined {
  if (!result) return normalizedProviderError('PROVIDER_INTERNAL_ERROR', phase, 'Custom CLI validation probe did not return a result');
  switch (result.errorCode) {
    case 'PROCESS_EXECUTABLE_NOT_FOUND':
      return normalizedProviderError('PROVIDER_NOT_FOUND', 'discovery', 'Custom CLI executable was not found');
    case 'PROCESS_EXECUTABLE_NOT_ACCESSIBLE':
      return normalizedProviderError('PROVIDER_EXECUTABLE_NOT_ACCESSIBLE', 'discovery', 'Custom CLI executable is not accessible');
    case 'PROCESS_STARTUP_TIMEOUT':
      return normalizedProviderError('PROVIDER_INTERNAL_ERROR', phase, 'Custom CLI validation probe timed out', true);
    case 'PROCESS_REQUEST_INVALID':
    case 'PROCESS_UNKNOWN_ERROR':
      return normalizedProviderError('PROVIDER_INTERNAL_ERROR', phase, 'Custom CLI validation probe failed');
    default:
      return result.exitCode !== 0 && !probeOutput(result).trim()
        ? normalizedProviderError('PROVIDER_INTERNAL_ERROR', phase, 'Custom CLI validation probe failed')
        : undefined;
  }
}

function probeOutput(result: ProcessProbeResult | undefined): string {
  return result ? `${result.stdout}${result.stderr}` : '';
}

export function safeEnvironmentForCustomCli(
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

function isProviderNormalizedError(value: unknown): value is ProviderNormalizedError {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ProviderNormalizedError>;
  return typeof candidate.code === 'string'
    && (PROVIDER_ERROR_CODES as readonly string[]).includes(candidate.code)
    && typeof candidate.phase === 'string'
    && typeof candidate.message === 'string';
}

function stableErrorMessage(code: ProviderNormalizedError['code']): string {
  switch (code) {
    case 'PROVIDER_CONFIG_INVALID': return 'Custom CLI provider configuration is invalid';
    case 'PROVIDER_NOT_FOUND': return 'Custom CLI executable was not found';
    case 'PROVIDER_EXECUTABLE_NOT_ACCESSIBLE': return 'Custom CLI executable is not accessible';
    case 'PROVIDER_VERSION_UNSUPPORTED': return 'Custom CLI version support is unavailable';
    case 'PROVIDER_AUTH_REQUIRED': return 'Custom CLI authentication is required';
    case 'PROVIDER_AUTH_EXPIRED': return 'Custom CLI authentication has expired';
    case 'PROVIDER_RATE_LIMITED': return 'Custom CLI rate limit reached';
    case 'PROVIDER_QUOTA_EXCEEDED': return 'Custom CLI quota was exceeded';
    case 'PROVIDER_MODEL_UNAVAILABLE': return 'Custom CLI model is unavailable';
    case 'PROVIDER_CAPABILITY_UNAVAILABLE': return 'Custom CLI capability is unavailable';
    case 'PROVIDER_START_FAILED': return 'Custom CLI provider failed to start';
    case 'PROVIDER_SESSION_FAILED': return 'Custom CLI session failed';
    case 'PROVIDER_SESSION_NOT_RESUMABLE': return 'Custom CLI session resume is unavailable';
    case 'PROVIDER_OUTPUT_PARSE_FAILED': return 'Custom CLI output could not be parsed';
    case 'PROVIDER_OUTPUT_INVALID': return 'Custom CLI output is invalid';
    case 'PROVIDER_APPROVAL_FAILED': return 'Custom CLI approval is unavailable';
    case 'PROVIDER_CANCEL_FAILED': return 'Custom CLI cancellation failed';
    case 'PROVIDER_PAUSE_UNSUPPORTED': return 'Custom CLI pause is unavailable';
    case 'PROVIDER_RESUME_FAILED': return 'Custom CLI resume failed';
    case 'PROVIDER_NETWORK_ERROR': return 'Custom CLI network operation failed';
    case 'PROVIDER_ADAPTER_NOT_FOUND': return 'Custom CLI provider adapter was not found';
    case 'PROVIDER_INTERNAL_ERROR': return 'Custom CLI provider operation failed';
    case 'PROVIDER_UNKNOWN_ERROR': return 'Custom CLI provider operation failed';
  }
}
