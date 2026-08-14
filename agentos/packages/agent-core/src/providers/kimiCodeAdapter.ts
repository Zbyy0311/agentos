import { access } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import type { ProcessProbeResult } from '@agentos/process-runtime';
import { createKimiJsonParser } from '../adapters/kimiParser.js';
import { normalizedProviderError } from './errors.js';
import type {
  ProviderAdapterManifest,
  ProviderAuthenticationState,
  ProviderCapabilities,
  ProviderCancelInput,
  ProviderCancelResult,
  ProviderConfigurationInput,
  ProviderDiscoveryInput,
  ProviderDiscoveryResult,
  ProviderFinalizeInput,
  ProviderFinalResult,
  ProviderLaunchPlan,
  ProviderNormalizedError,
  ProviderNormalizedEvent,
  ProviderParseContext,
  ProviderParseResult,
  ProcessProbePort,
  ProviderStartInput,
  ProviderValidationError,
  ProviderValidationInput,
  ProviderValidationResult,
  ProviderValidationWarning,
  RuntimeProviderAdapter,
} from './types.js';
import {
  KIMICODE_ADAPTER_ID,
  KIMICODE_ADAPTER_VERSION,
  KIMICODE_DEFAULT_EXECUTABLE,
  KIMICODE_PROVIDER_TYPE,
  canonicalProviderType,
  resolveFrozenProviderIdentity,
} from './types.js';

export interface KimiCodeProviderAdapterOptions {
  readonly probe?: ProcessProbePort;
  readonly discover?: (input: ProviderDiscoveryInput) => Promise<ProviderDiscoveryResult>;
  readonly minSupportedVersion?: string;
  readonly maxSupportedVersionExclusive?: string;
}

const KIMICODE_CAPABILITIES: ProviderCapabilities = {
  sessionResume: false,
  structuredEvents: true,
  nativeApprovals: false,
  subagents: false,
  toolEvents: true,
  fileEvents: false,
  usageEvents: true,
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

export class KimiCodeProviderAdapter implements RuntimeProviderAdapter {
  readonly manifest: ProviderAdapterManifest = {
    id: KIMICODE_ADAPTER_ID,
    name: 'KimiCode',
    version: KIMICODE_ADAPTER_VERSION,
    providerTypes: [KIMICODE_PROVIDER_TYPE],
    runtimeModes: ['cli'],
    capabilities: KIMICODE_CAPABILITIES,
    builtIn: true,
    configSchemaVersion: 1,
    description: 'Direct KimiCode CLI provider adapter',
  };

  private readonly probe?: ProcessProbePort;
  private readonly discoverOverride?: (input: ProviderDiscoveryInput) => Promise<ProviderDiscoveryResult>;
  private readonly minSupportedVersion: string;
  private readonly maxSupportedVersionExclusive: string;

  constructor(options: KimiCodeProviderAdapterOptions = {}) {
    this.probe = options.probe;
    this.discoverOverride = options.discover;
    this.minSupportedVersion = options.minSupportedVersion ?? '0.23.0';
    this.maxSupportedVersionExclusive = options.maxSupportedVersionExclusive ?? '1.0.0';
  }

  getDefaultCapabilities(_configuration: Partial<ProviderConfigurationInput>): ProviderCapabilities {
    return { ...KIMICODE_CAPABILITIES };
  }

  /** Normalize legacy agent-core input at the provider boundary only. */
  normalizeConfiguration(configuration: ProviderConfigurationInput): ProviderConfigurationInput {
    const normalized = {
      ...configuration,
      providerType: canonicalProviderType(configuration.providerType),
      ...(configuration.argsTemplate === undefined ? {} : { argsTemplate: [...configuration.argsTemplate] }),
      capabilities: { ...configuration.capabilities },
      timeoutPolicy: { ...configuration.timeoutPolicy },
    };
    const frozenIdentity = resolveFrozenProviderIdentity(normalized);
    return {
      ...normalized,
      ...(configuration.adapterVersion === undefined && frozenIdentity === undefined ? {} : frozenIdentity ? { adapterVersion: frozenIdentity.adapterVersion } : {}),
    };
  }

  async discover(input: ProviderDiscoveryInput): Promise<ProviderDiscoveryResult> {
    if (input.providerType !== KIMICODE_PROVIDER_TYPE) {
      return { found: false, candidates: [], warnings: ['KimiCode adapter only supports canonical provider type kimicode'] };
    }
    if (this.discoverOverride) return this.discoverOverride(input);

    const candidates: Array<{ executable: string; source: 'configuration' | 'environment' | 'path' | 'default-location' | 'registry'; confidence: number }> = [];
    if (input.configuredExecutable) candidates.push({ executable: input.configuredExecutable, source: 'configuration', confidence: 1 });
    const canonicalOverride = input.environment.AGENTOS_KIMICODE_CLI;
    const legacyOverride = input.environment.AGENTOS_KIMI_CLI;
    if (canonicalOverride) candidates.push({ executable: canonicalOverride, source: 'environment', confidence: 0.95 });
    if (legacyOverride && legacyOverride !== canonicalOverride) candidates.push({ executable: legacyOverride, source: 'environment', confidence: 0.9 });

    const platform = input.platform ?? process.platform;
    const pathCandidate = await findOnPath(KIMICODE_DEFAULT_EXECUTABLE, input.environment, platform);
    if (pathCandidate) candidates.push({ executable: pathCandidate, source: 'path', confidence: 0.8 });
    const home = input.homeDirectory ?? input.environment.USERPROFILE ?? input.environment.HOME;
    if (home) {
      const defaultCandidate = join(home, '.kimi-code', 'bin', platform === 'win32' ? 'kimi.exe' : 'kimi');
      if (await exists(defaultCandidate)) candidates.push({ executable: defaultCandidate, source: 'default-location', confidence: 0.7 });
    }

    const deduped = dedupeCandidates(candidates);
    // An explicitly configured executable or override is authoritative. Never silently
    // fall back to a different binary when that preferred candidate is inaccessible.
    const preferredExecutable = input.configuredExecutable
      ?? canonicalOverride
      ?? legacyOverride;
    const preferred = preferredExecutable === undefined
      ? undefined
      : deduped.find(candidate => candidate.executable === preferredExecutable);
    const selected = preferred
      ? await firstUsableCandidate([preferred])
      : await firstUsableCandidate(deduped);
    return {
      found: selected !== undefined,
      ...(selected === undefined ? {} : { selected }),
      candidates: deduped,
      warnings: canonicalOverride && legacyOverride && canonicalOverride !== legacyOverride
        ? ['canonical AGENTOS_KIMICODE_CLI override takes precedence over legacy AGENTOS_KIMI_CLI']
        : [],
    };
  }

  async validate(input: ProviderValidationInput): Promise<ProviderValidationResult> {
    const configuration = this.normalizeConfiguration(input.configuration);
    const checkedAt = input.now ?? new Date().toISOString();
    const errors: ProviderValidationError[] = [];
    const warnings: ProviderValidationWarning[] = [];
    const environment = input.environment ?? process.env;

    if (!configuration.enabled || configuration.archivedAt) {
      errors.push({ code: 'PROVIDER_CONFIG_INVALID', phase: 'configuration', message: 'Provider configuration is disabled or archived', retryable: false });
    }
    if (canonicalProviderType(configuration.providerType) !== KIMICODE_PROVIDER_TYPE) {
      errors.push({ code: 'PROVIDER_CONFIG_INVALID', phase: 'configuration', message: 'KimiCode configuration must use providerType kimicode', retryable: false });
    }
    if (configuration.adapterId !== KIMICODE_ADAPTER_ID || configuration.runtimeMode !== 'cli') {
      errors.push({ code: 'PROVIDER_CONFIG_INVALID', phase: 'configuration', message: 'KimiCode requires builtin.kimicode CLI configuration', retryable: false });
    }
    if (configuration.outputMode !== 'structured') {
      errors.push({ code: 'PROVIDER_CONFIG_INVALID', phase: 'configuration', message: 'KimiCode requires structured output mode', retryable: false });
    }
    const frozenIdentity = resolveFrozenProviderIdentity(configuration);
    if (frozenIdentity === undefined) {
      errors.push({ code: 'PROVIDER_VERSION_UNSUPPORTED', phase: 'validation', message: 'An exact KimiCode adapter version is required', retryable: false });
    } else if (frozenIdentity.adapterId !== this.manifest.id || frozenIdentity.adapterVersion !== this.manifest.version) {
      errors.push({ code: 'PROVIDER_VERSION_UNSUPPORTED', phase: 'validation', message: 'The configured KimiCode adapter version is not available', retryable: false });
    }
    const fatalConfigurationError = errors.some(error =>
      error.phase === 'configuration' && error.message !== 'KimiCode requires structured output mode',
    );
    if (fatalConfigurationError || errors.some(error => error.code === 'PROVIDER_VERSION_UNSUPPORTED')) {
      return { valid: false, capabilities: this.getDefaultCapabilities(configuration), outputMode: configuration.outputMode, warnings, errors, checkedAt };
    }

    const discovered = await (input.discover ?? (value => this.discover(value)))({
      providerType: KIMICODE_PROVIDER_TYPE,
      configuredExecutable: configuration.executable,
      environment,
      platform: process.platform,
      homeDirectory: environment.USERPROFILE ?? environment.HOME,
    });
    warnings.push(...discovered.warnings.map(message => ({
      code: 'PROVIDER_DISCOVERY_WARNING',
      message: sanitizeWarning(message),
    })));
    if (!discovered.found || !discovered.selected) {
      const explicitlyConfigured = Boolean(
        configuration.executable
        ?? environment.AGENTOS_KIMICODE_CLI
        ?? environment.AGENTOS_KIMI_CLI,
      );
      errors.push({
        code: explicitlyConfigured ? 'PROVIDER_EXECUTABLE_NOT_ACCESSIBLE' : 'PROVIDER_NOT_FOUND',
        phase: 'discovery',
        message: explicitlyConfigured ? 'KimiCode executable is not accessible' : 'KimiCode executable was not found',
        retryable: false,
      });
      return { valid: false, capabilities: this.getDefaultCapabilities(configuration), outputMode: configuration.outputMode, warnings, errors, checkedAt };
    }

    const probe = input.probe ?? this.probe;
    if (!probe) {
      errors.push({ code: 'PROVIDER_INTERNAL_ERROR', phase: 'validation', message: 'Provider validation probe port is unavailable', retryable: false });
      return { valid: false, executableResolved: discovered.selected, capabilities: this.getDefaultCapabilities(configuration), outputMode: configuration.outputMode, warnings, errors, checkedAt };
    }

    let versionOutput: string;
    let helpOutput: string;
    try {
      const probeEnvironment = safeProbeEnvironment(environment);
      const version = await probe.probe({
        executable: discovered.selected,
        args: ['--version'],
        environment: probeEnvironment,
        timeoutMs: configuration.timeoutPolicy.validationTimeoutMs,
      });
      const versionFailure = providerProbeError(version, 'discovery');
      if (versionFailure && !probeOutput(version).trim()) throw versionFailure;
      versionOutput = probeOutput(version);

      const help = await probe.probe({
        executable: discovered.selected,
        args: ['--help'],
        environment: probeEnvironment,
        timeoutMs: configuration.timeoutPolicy.validationTimeoutMs,
      });
      const helpFailure = providerProbeError(help, 'validation');
      if (helpFailure && !probeOutput(help).trim()) throw helpFailure;
      helpOutput = probeOutput(help);
    } catch (error) {
      const normalized = isProviderNormalizedError(error)
        ? error
        : this.normalizeError(error, { phase: 'discovery' });
      errors.push({ code: normalized.code, phase: normalized.phase, message: normalized.message, retryable: normalized.retryable });
      return { valid: false, executableResolved: discovered.selected, capabilities: this.getDefaultCapabilities(configuration), outputMode: configuration.outputMode, warnings, errors, checkedAt };
    }

    const cliVersion = parseVersion(versionOutput);
    if (!cliVersion || compareVersions(cliVersion, this.minSupportedVersion) < 0 || compareVersions(cliVersion, this.maxSupportedVersionExclusive) >= 0) {
      errors.push({ code: 'PROVIDER_VERSION_UNSUPPORTED', phase: 'validation', message: `KimiCode version is outside the supported range ${this.minSupportedVersion} <= version < ${this.maxSupportedVersionExclusive}`, retryable: false });
    }
    if (!/--output-format[\s\S]*(?:stream-json|jsonl)|(?:stream-json|jsonl)[\s\S]*--output-format/i.test(helpOutput)) {
      errors.push({ code: 'PROVIDER_CAPABILITY_UNAVAILABLE', phase: 'validation', message: 'KimiCode does not advertise structured stream output', retryable: false });
    }

    const authentication = await this.resolveAuth(probe, discovered.selected, environment, configuration.timeoutPolicy.validationTimeoutMs, warnings);
    if (authentication === 'unknown' && !warnings.some(warning => warning.code === 'PROVIDER_AUTH_UNKNOWN')) {
      warnings.push({ code: 'PROVIDER_AUTH_UNKNOWN', message: 'KimiCode authentication state could not be determined' });
    }
    if (authentication === 'required') {
      errors.push({ code: 'PROVIDER_AUTH_REQUIRED', phase: 'authentication', message: 'KimiCode authentication is required', retryable: false });
    } else if (authentication === 'expired') {
      errors.push({ code: 'PROVIDER_AUTH_EXPIRED', phase: 'authentication', message: 'KimiCode authentication has expired', retryable: false });
    }

    for (const [capability, requested] of Object.entries(configuration.capabilities)) {
      if (requested === true && this.manifest.capabilities[capability as keyof ProviderCapabilities] !== true) {
        errors.push({ code: 'PROVIDER_CAPABILITY_UNAVAILABLE', phase: 'validation', message: `KimiCode capability ${capability} is unavailable`, retryable: false });
      }
    }

    return {
      valid: errors.length === 0,
      executableResolved: discovered.selected,
      ...(cliVersion ? { cliVersion } : {}),
      ...(authentication ? { authentication } : {}),
      capabilities: this.getDefaultCapabilities(configuration),
      outputMode: configuration.outputMode,
      warnings,
      errors,
      checkedAt,
    };
  }

  async buildLaunchPlan(input: ProviderStartInput): Promise<ProviderLaunchPlan> {
    const configuration = this.normalizeConfiguration(input.configuration);
    if (!configuration.enabled || configuration.archivedAt || canonicalProviderType(configuration.providerType) !== KIMICODE_PROVIDER_TYPE) {
      throw new Error('PROVIDER_CONFIG_INVALID');
    }
    const frozenIdentity = resolveFrozenProviderIdentity(configuration);
    if (frozenIdentity === undefined || frozenIdentity.adapterId !== this.manifest.id) {
      throw new Error('PROVIDER_ADAPTER_NOT_FOUND');
    }
    if (frozenIdentity.adapterVersion !== this.manifest.version) {
      throw new Error('PROVIDER_VERSION_UNSUPPORTED');
    }
    if (configuration.runtimeMode !== 'cli' || configuration.outputMode !== 'structured') {
      throw new Error('PROVIDER_CONFIG_INVALID');
    }
    const environment = input.environment ?? process.env;
    const executable = configuration.executable ?? environment.AGENTOS_KIMICODE_CLI ?? environment.AGENTOS_KIMI_CLI ?? KIMICODE_DEFAULT_EXECUTABLE;
    const args = buildKimiArgs(configuration.argsTemplate ?? [], configuration.model, input.prompt);
    const cwd = resolveWorkingDirectory(configuration, input.workspaceRoot, input.worktreePath);
    const safeEnvironment: Record<string, string> = { KIMI_MODEL_PROVIDER_TYPE: KIMICODE_PROVIDER_TYPE };
    const redactedEnvironmentKeys: string[] = [];
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) continue;
      if (SECRET_KEY_PATTERN.test(key)) {
        redactedEnvironmentKeys.push(key);
        continue;
      }
      if (!SAFE_ENVIRONMENT_KEYS.has(key)) continue;
      safeEnvironment[key] = value;
    }
    for (const [key, value] of Object.entries(input.environmentOverrides ?? {})) {
      if (!ENV_KEY_PATTERN.test(key) || SECRET_KEY_PATTERN.test(key)) throw new Error('PROVIDER_CONFIG_INVALID');
      if (value.includes('\u0000')) throw new Error('PROVIDER_CONFIG_INVALID');
      safeEnvironment[key] = value;
    }
    const secretRefs = [...new Set(input.secretRefs ?? (configuration.secretProfileId ? [configuration.secretProfileId] : []))];
    return {
      runtimeMode: configuration.runtimeMode,
      executable,
      args,
      cwd,
      environment: safeEnvironment,
      redactedEnvironmentKeys: redactedEnvironmentKeys.sort(),
      secretRefs,
      stdinMode: 'none',
      promptDelivery: 'argument',
      structuredOutput: 'jsonl',
      cleanupFiles: [],
      shell: false,
      metadata: {
        providerType: KIMICODE_PROVIDER_TYPE,
        adapterId: this.manifest.id,
        adapterVersion: frozenIdentity.adapterVersion,
        providerConfigId: configuration.id,
        providerConfigVersion: configuration.version,
        configSchemaVersion: this.manifest.configSchemaVersion,
      },
    };
  }

  createParseContext(): ProviderParseContext {
    return { parser: createKimiJsonParser() };
  }

  parseChunk(chunk: string, context: ProviderParseContext = this.createParseContext()): ProviderParseResult {
    const parser = context.parser ?? createKimiJsonParser();
    const events = parser.push(chunk).map(canonicalizeEvent);
    return { context: { parser }, events, diagnostics: events.filter(event => event.type === 'diagnostic') };
  }

  finishParse(context: ProviderParseContext): ProviderParseResult {
    const parser = context.parser ?? createKimiJsonParser();
    const events = parser.finish().map(canonicalizeEvent);
    return { context: { parser }, events, diagnostics: events.filter(event => event.type === 'diagnostic') };
  }

  async finalize(input: ProviderFinalizeInput): Promise<ProviderFinalResult> {
    if (input.cancelled) return { status: 'cancelled', events: input.parsedEvents };
    if (input.providerError) return { status: 'failed', events: input.parsedEvents, error: input.providerError };
    const parseFailure = input.parsedEvents.some(event => event.type === 'diagnostic' && (event.code === 'adapter.invalid_json' || event.code === 'adapter.oversized_json'));
    if (parseFailure) {
      return { status: 'failed', events: input.parsedEvents, error: normalizedProviderError('PROVIDER_OUTPUT_PARSE_FAILED', 'output-parse', 'KimiCode output could not be parsed') };
    }
    if (input.exitCode !== 0 || input.signal !== null) {
      const error = this.normalizeError(input.stderr, { phase: 'finalize' });
      const precise = error.code !== 'PROVIDER_INTERNAL_ERROR' && error.code !== 'PROVIDER_UNKNOWN_ERROR';
      return { status: 'failed', events: input.parsedEvents, error: precise ? error : normalizedProviderError('PROVIDER_SESSION_FAILED', 'finalize', 'KimiCode session exited unsuccessfully') };
    }
    const output = input.parsedEvents
      .filter((event): event is Extract<typeof event, { type: 'assistant.message' }> => event.type === 'assistant.message')
      .map(event => event.text)
      .join('');
    if (!output) {
      return { status: 'failed', events: input.parsedEvents, error: normalizedProviderError('PROVIDER_OUTPUT_INVALID', 'finalize', 'KimiCode produced no valid assistant output') };
    }
    return { status: 'completed', events: input.parsedEvents, ...(output ? { output } : {}) };
  }

  async cancel(input: ProviderCancelInput): Promise<ProviderCancelResult> {
    if (!input.stopTicketAccepted) {
      return { accepted: false, error: normalizedProviderError('PROVIDER_CANCEL_FAILED', 'cancel', 'Process stop ticket was not accepted') };
    }
    try {
      const result = await input.processPort.requestGraceful({ processId: input.processId, sessionId: input.sessionId, reason: input.reason });
      return result.accepted
        ? { accepted: true }
        : { accepted: false, error: normalizedProviderError('PROVIDER_CANCEL_FAILED', 'cancel', 'Provider graceful cancellation was not accepted') };
    } catch {
      return { accepted: false, error: normalizedProviderError('PROVIDER_CANCEL_FAILED', 'cancel', 'Provider graceful cancellation failed') };
    }
  }

  normalizeError(error: unknown, context: { readonly phase?: import('./types.js').ProviderErrorPhase } = {}): ProviderNormalizedError {
    const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
    const phase = context.phase ?? 'internal';
    if (/expired/i.test(text)) return normalizedProviderError('PROVIDER_AUTH_EXPIRED', 'authentication', 'KimiCode authentication has expired');
    if (/auth|login|unauthenticated|credential/i.test(text)) return normalizedProviderError('PROVIDER_AUTH_REQUIRED', 'authentication', 'KimiCode authentication is required');
    if (/rate[ -]?limit|too many requests/i.test(text)) return normalizedProviderError('PROVIDER_RATE_LIMITED', 'runtime', 'KimiCode rate limit reached', true);
    if (/quota/i.test(text)) return normalizedProviderError('PROVIDER_QUOTA_EXCEEDED', 'runtime', 'KimiCode quota was exceeded');
    if (/model.*unavailable|unknown model/i.test(text)) return normalizedProviderError('PROVIDER_MODEL_UNAVAILABLE', 'validation', 'KimiCode model is unavailable');
    if (/network|connect|timed out|timeout/i.test(text)) return normalizedProviderError('PROVIDER_NETWORK_ERROR', 'runtime', 'KimiCode network operation failed', true);
    if (/version|unsupported/i.test(text)) return normalizedProviderError('PROVIDER_VERSION_UNSUPPORTED', 'validation', 'KimiCode version is unsupported');
    if (/ENOENT|not found|access denied|EACCES|EPERM/i.test(text)) return normalizedProviderError('PROVIDER_EXECUTABLE_NOT_ACCESSIBLE', 'discovery', 'KimiCode executable is not accessible');
    if (/output-format|stream-json|structured/i.test(text)) return normalizedProviderError('PROVIDER_CAPABILITY_UNAVAILABLE', 'validation', 'KimiCode structured output is unavailable');
    if (phase === 'cancel') return normalizedProviderError('PROVIDER_CANCEL_FAILED', 'cancel', 'Provider cancellation failed');
    return normalizedProviderError('PROVIDER_INTERNAL_ERROR', phase, 'KimiCode provider operation failed');
  }

  private async resolveAuth(probe: ProcessProbePort, executable: string, environment: Readonly<Record<string, string | undefined>>, timeoutMs: number, warnings: ProviderValidationWarning[]): Promise<ProviderAuthenticationState> {
    try {
      const result = await probe.probe({
        executable,
        args: ['auth', 'status'],
        environment: safeProbeEnvironment(environment),
        timeoutMs,
      });
      const output = probeOutput(result);
      const normalized = output.trim().toLowerCase();
      if (/not[ -]?required|anonymous|none/.test(normalized)) return 'not-required';
      if (/expired/.test(normalized)) return 'expired';
      if (/authenticated|logged[ -]?in|signed[ -]?in/.test(normalized)) return 'authenticated';
      if (/required|login|unauthenticated|not authenticated/.test(normalized)) return 'required';
    } catch {
      // Auth status is optional for some Kimi builds; retain unknown without leaking native output.
    }
    warnings.push({ code: 'PROVIDER_AUTH_UNKNOWN', message: 'KimiCode authentication state could not be determined' });
    return 'unknown';
  }
}

function buildKimiArgs(template: readonly string[], model: string | undefined, prompt: string): string[] {
  const args = removeFlagPair([...template], '--output-format');
  const promptIndex = args.findIndex(arg => arg === '-p' || arg === '--prompt');
  if (promptIndex >= 0) {
    if (args[promptIndex + 1] === undefined || args[promptIndex + 1]!.startsWith('-')) args.splice(promptIndex + 1, 0, prompt);
    else args[promptIndex + 1] = prompt;
  } else {
    args.push('--prompt', prompt);
  }
  if (model && !hasFlagPair(args, '-m') && !hasFlagPair(args, '--model')) args.unshift('--model', model);
  const outputIndex = args.indexOf('--output-format');
  if (outputIndex >= 0) args.splice(outputIndex, 2);
  const insertionIndex = args.findIndex(arg => arg === '-p' || arg === '--prompt');
  args.splice(insertionIndex >= 0 ? insertionIndex : args.length, 0, '--output-format', 'stream-json');
  return args;
}

function removeFlagPair(args: string[], flag: string): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag) { index += 1; continue; }
    result.push(args[index]!);
  }
  return result;
}

function hasFlagPair(args: readonly string[], flag: string): boolean {
  return args.some(arg => arg === flag);
}

function resolveWorkingDirectory(configuration: ProviderConfigurationInput, workspaceRoot: string, worktreePath?: string): string {
  if (configuration.workingDirectoryMode === 'worktree') return worktreePath ?? workspaceRoot;
  if (configuration.workingDirectoryMode === 'custom') {
    if (!configuration.customWorkingDirectory) throw new Error('PROVIDER_CONFIG_INVALID');
    return configuration.customWorkingDirectory;
  }
  return workspaceRoot;
}

function parseVersion(value: string): string | undefined {
  return value.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/)?.[1];
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string): number[] => value.split(/[.+-]/).slice(0, 3).map(part => Number.parseInt(part, 10));
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
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

async function firstUsableCandidate(candidates: readonly { executable: string }[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await exists(candidate.executable)) return candidate.executable;
  }
  return undefined;
}

function dedupeCandidates<T extends { executable: string }>(candidates: readonly T[]): T[] {
  const seen = new Set<string>();
  return candidates.filter(candidate => {
    if (seen.has(candidate.executable)) return false;
    seen.add(candidate.executable);
    return true;
  });
}

function sanitizeWarning(value: string): string {
  const message = value.trim();
  if (!message || SENSITIVE_WARNING_PATTERN.test(message)) return 'Provider discovery warning';
  /*
  return message.length > 256 ? `${message.slice(0, 256)}…` : message;
  */
  return message.length > 256 ? `${message.slice(0, 256)}...` : message;
}

function probeOutput(result: ProcessProbeResult): string {
  return `${result.stdout}${result.stderr}`;
}

function providerProbeError(result: ProcessProbeResult, phase: 'discovery' | 'validation'): ProviderNormalizedError | undefined {
  switch (result.errorCode) {
    case 'PROCESS_EXECUTABLE_NOT_FOUND':
      return normalizedProviderError('PROVIDER_NOT_FOUND', 'discovery', 'KimiCode executable was not found');
    case 'PROCESS_EXECUTABLE_NOT_ACCESSIBLE':
      return normalizedProviderError('PROVIDER_EXECUTABLE_NOT_ACCESSIBLE', 'discovery', 'KimiCode executable is not accessible');
    case 'PROCESS_STARTUP_TIMEOUT':
      return normalizedProviderError('PROVIDER_INTERNAL_ERROR', phase, 'KimiCode validation probe timed out', true);
    case 'PROCESS_REQUEST_INVALID':
    case 'PROCESS_UNKNOWN_ERROR':
      return normalizedProviderError('PROVIDER_INTERNAL_ERROR', phase, 'KimiCode validation probe failed');
    default:
      return undefined;
  }
}

function safeProbeEnvironment(environment: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    const value = environment[key];
    if (value !== undefined && !SECRET_KEY_PATTERN.test(key)) result[key] = value;
  }
  return result;
}

function isProviderNormalizedError(value: unknown): value is ProviderNormalizedError {
  return typeof value === 'object' && value !== null && 'code' in value && 'phase' in value && 'message' in value;
}

function canonicalizeEvent(event: import('../adapters/types.js').NormalizedCliEvent): ProviderNormalizedEvent {
  if (event.type === 'usage' && event.provider === 'kimi') {
    return { ...event, provider: KIMICODE_PROVIDER_TYPE } as ProviderNormalizedEvent;
  }
  return event as ProviderNormalizedEvent;
}
