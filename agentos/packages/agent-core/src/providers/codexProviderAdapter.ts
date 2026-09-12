import { access } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import type { ProcessProbeResult } from '@agentos/process-runtime';
import { CodexJsonParser } from '../adapters/codexParser.js';
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
import { resolveFrozenProviderIdentity } from './types.js';

export const CODEX_PROVIDER_TYPE = 'codex' as const;
export const CODEX_ADAPTER_ID = 'builtin.codex' as const;
export const CODEX_ADAPTER_VERSION = '1.0.0' as const;
export const CODEX_DEFAULT_EXECUTABLE = 'codex' as const;

export interface CodexProviderAdapterOptions {
  readonly probe?: ProcessProbePort;
  readonly discover?: (input: ProviderDiscoveryInput) => Promise<ProviderDiscoveryResult>;
  /** Optional bounds are useful for a deployment policy; legacy Codex has no repo-proven default range. */
  readonly minSupportedVersion?: string;
  readonly maxSupportedVersionExclusive?: string;
}

/**
 * Capabilities proven by the legacy Codex adapter and this Process-port seam.
 * Provider-native sessions, approvals, sandboxing and output contracts are not
 * inferred from the presence of a Codex executable or a CLI flag.
 */
const CODEX_CAPABILITIES: ProviderCapabilities = {
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

const CODEX_AUTH_UNKNOWN_WARNING: ProviderValidationWarning = {
  code: 'PROVIDER_AUTH_UNKNOWN',
  message: 'Codex authentication state could not be determined',
};

const SAFE_ENVIRONMENT_KEYS = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP',
  'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'USERNAME', 'USERDOMAIN', 'OS',
  'LANG', 'LC_ALL', 'NODE_ENV', 'CODEX_HOME', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'OPENAI_BASE_URL',
]);
const SECRET_KEY_PATTERN = /(SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL|COOKIE|AUTH)/i;
const SENSITIVE_WARNING_PATTERN = /(?:bearer\s+|oauth|(?:token|api[_-]?key|password|secret|credential)\s*[:=]|-----begin)/i;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CODEX_JSON_FLAG_PATTERN = /(?:^|\s)--json(?:\s|$)/m;

// The parser is intentionally obtained from the child-process-free JSONL
// module so this Provider-only entrypoint never pulls a native probe graph.
function createCodexParser(): CliEventParser {
  return new CodexJsonParser();
}

export class CodexProviderAdapter implements RuntimeProviderAdapter {
  readonly manifest: ProviderAdapterManifest = {
    id: CODEX_ADAPTER_ID,
    name: 'Codex',
    version: CODEX_ADAPTER_VERSION,
    providerTypes: [CODEX_PROVIDER_TYPE],
    runtimeModes: ['cli'],
    capabilities: CODEX_CAPABILITIES,
    builtIn: true,
    configSchemaVersion: 1,
    description: 'Direct Codex CLI provider adapter',
  };

  private readonly probe?: ProcessProbePort;
  private readonly discoverOverride?: (input: ProviderDiscoveryInput) => Promise<ProviderDiscoveryResult>;
  private readonly minSupportedVersion?: string;
  private readonly maxSupportedVersionExclusive?: string;

  constructor(options: CodexProviderAdapterOptions = {}) {
    this.probe = options.probe;
    this.discoverOverride = options.discover;
    this.minSupportedVersion = options.minSupportedVersion;
    this.maxSupportedVersionExclusive = options.maxSupportedVersionExclusive;
  }

  getDefaultCapabilities(_configuration: Partial<ProviderConfigurationInput>): ProviderCapabilities {
    return { ...CODEX_CAPABILITIES };
  }

  normalizeConfiguration(configuration: ProviderConfigurationInput): ProviderConfigurationInput {
    return {
      ...configuration,
      ...(configuration.argsTemplate === undefined ? {} : { argsTemplate: [...configuration.argsTemplate] }),
      capabilities: { ...configuration.capabilities },
      timeoutPolicy: { ...configuration.timeoutPolicy },
    };
  }

  async discover(input: ProviderDiscoveryInput): Promise<ProviderDiscoveryResult> {
    if (input.providerType !== CODEX_PROVIDER_TYPE) {
      return { found: false, candidates: [], warnings: ['Codex adapter only supports canonical provider type codex'] };
    }
    if (this.discoverOverride) return this.discoverOverride(input);

    const candidates: ProviderDiscoveryCandidate[] = [];
    if (input.configuredExecutable) {
      candidates.push({ executable: input.configuredExecutable, source: 'configuration', confidence: 1 });
    }
    const environmentOverride = input.environment.AGENTOS_CODEX_CLI;
    if (environmentOverride) {
      candidates.push({ executable: environmentOverride, source: 'environment', confidence: 0.95 });
    }

    const platform = input.platform ?? process.platform;
    const pathCandidate = await findOnPath(CODEX_DEFAULT_EXECUTABLE, input.environment, platform);
    if (pathCandidate) candidates.push({ executable: pathCandidate, source: 'path', confidence: 0.8 });

    const deduped = dedupeCandidates(candidates);
    // Configuration and the explicit environment override are authoritative;
    // an inaccessible preferred binary must not silently select another one.
    const preferredExecutable = input.configuredExecutable ?? environmentOverride;
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
      warnings: [],
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
    if (configuration.providerType !== CODEX_PROVIDER_TYPE) {
      errors.push({ code: 'PROVIDER_CONFIG_INVALID', phase: 'configuration', message: 'Codex configuration must use providerType codex', retryable: false });
    }
    if (configuration.adapterId !== CODEX_ADAPTER_ID || configuration.runtimeMode !== 'cli') {
      errors.push({ code: 'PROVIDER_CONFIG_INVALID', phase: 'configuration', message: 'Codex requires builtin.codex CLI configuration', retryable: false });
    }
    if (configuration.outputMode !== 'structured') {
      errors.push({ code: 'PROVIDER_CONFIG_INVALID', phase: 'configuration', message: 'Codex requires structured output mode', retryable: false });
    }

    const frozenIdentity = resolveFrozenProviderIdentity(configuration);
    if (frozenIdentity === undefined) {
      errors.push({ code: 'PROVIDER_VERSION_UNSUPPORTED', phase: 'validation', message: 'An exact Codex adapter version is required', retryable: false });
    } else if (frozenIdentity.adapterId !== this.manifest.id || frozenIdentity.adapterVersion !== this.manifest.version) {
      errors.push({ code: 'PROVIDER_VERSION_UNSUPPORTED', phase: 'validation', message: 'The configured Codex adapter version is not available', retryable: false });
    }
    if (errors.length > 0) {
      return {
        valid: false,
        capabilities: this.getDefaultCapabilities(configuration),
        outputMode: configuration.outputMode,
        warnings,
        errors,
        checkedAt,
      };
    }

    let discovered: ProviderDiscoveryResult;
    try {
      discovered = await (input.discover ?? (value => this.discover(value)))({
        providerType: CODEX_PROVIDER_TYPE,
        configuredExecutable: configuration.executable,
        environment,
        platform: process.platform,
        homeDirectory: environment.USERPROFILE ?? environment.HOME,
      });
    } catch (error) {
      const normalized = this.normalizeError(error, { phase: 'discovery' });
      errors.push(toValidationError(normalized));
      return {
        valid: false,
        capabilities: capabilitiesForStructuredOutput(false),
        outputMode: configuration.outputMode,
        warnings,
        errors,
        checkedAt,
      };
    }

    warnings.push(...discovered.warnings.map(message => ({
      code: 'PROVIDER_DISCOVERY_WARNING',
      message: sanitizeWarning(message),
    })));
    if (!discovered.found || !discovered.selected) {
      const explicitlyConfigured = Boolean(configuration.executable ?? environment.AGENTOS_CODEX_CLI);
      errors.push({
        code: explicitlyConfigured ? 'PROVIDER_EXECUTABLE_NOT_ACCESSIBLE' : 'PROVIDER_NOT_FOUND',
        phase: 'discovery',
        message: explicitlyConfigured ? 'Codex executable is not accessible' : 'Codex executable was not found',
        retryable: false,
      });
      return {
        valid: false,
        capabilities: capabilitiesForStructuredOutput(false),
        outputMode: configuration.outputMode,
        warnings,
        errors,
        checkedAt,
      };
    }

    const probe = input.probe ?? this.probe;
    if (!probe) {
      errors.push({ code: 'PROVIDER_INTERNAL_ERROR', phase: 'validation', message: 'Provider validation probe port is unavailable', retryable: false });
      return {
        valid: false,
        executableResolved: discovered.selected,
        capabilities: capabilitiesForStructuredOutput(false),
        outputMode: configuration.outputMode,
        warnings,
        errors,
        checkedAt,
      };
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

      // This is the exact legacy Codex probe command. Its output is the only
      // evidence used here for structured JSONL capability.
      const help = await probe.probe({
        executable: discovered.selected,
        args: ['exec', '--help'],
        environment: probeEnvironment,
        timeoutMs: configuration.timeoutPolicy.validationTimeoutMs,
      });
      const helpFailure = providerProbeError(help, 'validation');
      if (helpFailure && !probeOutput(help).trim()) throw helpFailure;
      helpOutput = probeOutput(help);
    } catch (error) {
      const normalized = isProviderNormalizedError(error)
        ? error
        : this.normalizeError(error, { phase: 'validation' });
      errors.push(toValidationError(normalized));
      return {
        valid: false,
        executableResolved: discovered.selected,
        capabilities: capabilitiesForStructuredOutput(false),
        outputMode: configuration.outputMode,
        warnings,
        errors,
        checkedAt,
      };
    }

    const cliVersion = parseVersion(versionOutput);
    if (!cliVersion) {
      errors.push({ code: 'PROVIDER_VERSION_UNSUPPORTED', phase: 'validation', message: 'Codex CLI version could not be determined', retryable: false });
    } else if (
      (this.minSupportedVersion !== undefined && compareVersions(cliVersion, this.minSupportedVersion) < 0)
      || (this.maxSupportedVersionExclusive !== undefined && compareVersions(cliVersion, this.maxSupportedVersionExclusive) >= 0)
    ) {
      const lower = this.minSupportedVersion ?? '*';
      const upper = this.maxSupportedVersionExclusive ?? '*';
      errors.push({ code: 'PROVIDER_VERSION_UNSUPPORTED', phase: 'validation', message: `Codex CLI version is outside the supported range ${lower} <= version < ${upper}`, retryable: false });
    }

    const structuredOutput = CODEX_JSON_FLAG_PATTERN.test(helpOutput);
    if (!structuredOutput) {
      errors.push({ code: 'PROVIDER_CAPABILITY_UNAVAILABLE', phase: 'validation', message: 'Codex CLI does not advertise exec --json structured output', retryable: false });
    }

    const capabilities = capabilitiesForStructuredOutput(structuredOutput);
    warnings.push(CODEX_AUTH_UNKNOWN_WARNING);
    const authentication: ProviderAuthenticationState = 'unknown';
    for (const [key, requested] of Object.entries(configuration.capabilities)) {
      if (requested !== true) continue;
      const capability = key as keyof ProviderCapabilities;
      if (capabilities[capability] !== true) {
        errors.push({ code: 'PROVIDER_CAPABILITY_UNAVAILABLE', phase: 'validation', message: `Codex capability ${key} is unavailable`, retryable: false });
      }
    }

    return {
      valid: errors.length === 0,
      executableResolved: discovered.selected,
      ...(cliVersion ? { cliVersion } : {}),
      authentication,
      capabilities,
      outputMode: configuration.outputMode,
      warnings,
      errors,
      checkedAt,
    };
  }

  async buildLaunchPlan(input: ProviderStartInput): Promise<ProviderLaunchPlan> {
    const configuration = this.normalizeConfiguration(input.configuration);
    if (!configuration.enabled || configuration.archivedAt || configuration.providerType !== CODEX_PROVIDER_TYPE) {
      throw new Error('PROVIDER_CONFIG_INVALID');
    }
    if (configuration.adapterId !== this.manifest.id) throw new Error('PROVIDER_ADAPTER_NOT_FOUND');
    const frozenIdentity = resolveFrozenProviderIdentity(configuration);
    if (frozenIdentity === undefined || frozenIdentity.adapterId !== this.manifest.id ||
        frozenIdentity.adapterVersion !== this.manifest.version) {
      throw new Error('PROVIDER_VERSION_UNSUPPORTED');
    }
    if (configuration.runtimeMode !== 'cli' || configuration.outputMode !== 'structured') {
      throw new Error('PROVIDER_CONFIG_INVALID');
    }

    const environment = input.environment ?? process.env;
    const executable = configuration.executable ?? environment.AGENTOS_CODEX_CLI ?? CODEX_DEFAULT_EXECUTABLE;
    if (!executable.trim()) throw new Error('PROVIDER_CONFIG_INVALID');
    const args = buildCodexArgs(configuration.argsTemplate ?? [], input.prompt, configuration.model);
    const cwd = resolveWorkingDirectory(configuration, input.workspaceRoot, input.worktreePath);
    const safeEnvironment: Record<string, string> = safeEnvironmentForCodex(environment);
    const redactedEnvironmentKeys = Object.entries(environment)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key)
      .filter(key => SECRET_KEY_PATTERN.test(key))
      .sort();

    for (const [key, value] of Object.entries(input.environmentOverrides ?? {})) {
      if (!ENV_KEY_PATTERN.test(key) || SECRET_KEY_PATTERN.test(key) || value.includes('\u0000')) {
        throw new Error('PROVIDER_CONFIG_INVALID');
      }
      safeEnvironment[key] = value;
    }
    assertNoConflictingEnvironmentAliases(safeEnvironment, process.platform);

    const secretRefs = [...new Set(input.secretRefs ?? (configuration.secretProfileId ? [configuration.secretProfileId] : []))];
    return {
      runtimeMode: configuration.runtimeMode,
      executable,
      args,
      cwd,
      environment: safeEnvironment,
      redactedEnvironmentKeys,
      secretRefs,
      stdinMode: 'none',
      promptDelivery: 'argument',
      structuredOutput: 'jsonl',
      cleanupFiles: [],
      shell: false,
      metadata: {
        providerType: CODEX_PROVIDER_TYPE,
        adapterId: this.manifest.id,
        adapterVersion: frozenIdentity.adapterVersion,
        providerConfigId: configuration.id,
        providerConfigVersion: configuration.version,
        configSchemaVersion: this.manifest.configSchemaVersion,
      },
    };
  }

  createParseContext(): ProviderParseContext {
    return { parser: createCodexParser() };
  }

  parseChunk(chunk: string, context: ProviderParseContext = this.createParseContext()): ProviderParseResult {
    const parser = context.parser ?? createCodexParser();
    const events = parser.push(chunk).map(canonicalizeEvent);
    return { context: { parser }, events, diagnostics: events.filter(event => event.type === 'diagnostic') };
  }

  finishParse(context: ProviderParseContext): ProviderParseResult {
    const parser = context.parser ?? createCodexParser();
    const events = parser.finish().map(canonicalizeEvent);
    return { context: { parser }, events, diagnostics: events.filter(event => event.type === 'diagnostic') };
  }

  async finalize(input: ProviderFinalizeInput): Promise<ProviderFinalResult> {
    if (input.cancelled) return { status: 'cancelled', events: input.parsedEvents };
    if (input.providerError) return { status: 'failed', events: input.parsedEvents, error: input.providerError };

    const parseFailure = input.parsedEvents.some(event => event.type === 'diagnostic' && (
      event.code === 'adapter.invalid_json' || event.code === 'adapter.oversized_json'
    ));
    if (parseFailure) {
      return {
        status: 'failed',
        events: input.parsedEvents,
        error: normalizedProviderError('PROVIDER_OUTPUT_PARSE_FAILED', 'output-parse', 'Codex output could not be parsed'),
      };
    }
    if (input.exitCode !== 0 || input.signal !== null) {
      const normalized = this.normalizeError(input.stderr, { phase: 'finalize' });
      const precise = normalized.code !== 'PROVIDER_INTERNAL_ERROR' && normalized.code !== 'PROVIDER_UNKNOWN_ERROR';
      return {
        status: 'failed',
        events: input.parsedEvents,
        error: precise
          ? normalized
          : normalizedProviderError('PROVIDER_SESSION_FAILED', 'finalize', 'Codex session exited unsuccessfully'),
      };
    }

    const output = input.parsedEvents
      .filter((event): event is Extract<ProviderNormalizedEvent, { type: 'assistant.message' }> => event.type === 'assistant.message')
      .map(event => event.text)
      .join('');
    if (!output.trim()) {
      return {
        status: 'failed',
        events: input.parsedEvents,
        error: normalizedProviderError('PROVIDER_OUTPUT_INVALID', 'finalize', 'Codex produced no valid assistant output'),
      };
    }
    return { status: 'completed', events: input.parsedEvents, output };
  }

  async cancel(input: ProviderCancelInput): Promise<ProviderCancelResult> {
    if (!input.stopTicketAccepted) {
      return { accepted: false, error: normalizedProviderError('PROVIDER_CANCEL_FAILED', 'cancel', 'Process stop ticket was not accepted') };
    }
    try {
      const result = await input.processPort.requestGraceful({
        processId: input.processId,
        sessionId: input.sessionId,
        reason: input.reason,
      });
      return result.accepted
        ? { accepted: true }
        : { accepted: false, error: normalizedProviderError('PROVIDER_CANCEL_FAILED', 'cancel', 'Provider graceful cancellation was not accepted') };
    } catch {
      return { accepted: false, error: normalizedProviderError('PROVIDER_CANCEL_FAILED', 'cancel', 'Provider graceful cancellation failed') };
    }
  }

  normalizeError(error: unknown, context: { readonly phase?: import('./types.js').ProviderErrorPhase } = {}): ProviderNormalizedError {
    if (isProviderNormalizedError(error)) return error;
    const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
    const phase = context.phase ?? 'internal';
    if (/PROVIDER_CONFIG_INVALID/.test(text)) return normalizedProviderError('PROVIDER_CONFIG_INVALID', 'configuration', 'Codex provider configuration is invalid');
    if (/PROVIDER_ADAPTER_NOT_FOUND/.test(text)) return normalizedProviderError('PROVIDER_ADAPTER_NOT_FOUND', 'validation', 'Codex provider adapter was not found');
    if (/expired/i.test(text)) return normalizedProviderError('PROVIDER_AUTH_EXPIRED', 'authentication', 'Codex authentication has expired');
    if (/auth|login|unauthenticated|credential|not logged in|unauthori[sz]ed/i.test(text)) return normalizedProviderError('PROVIDER_AUTH_REQUIRED', 'authentication', 'Codex authentication is required');
    if (/rate[ -]?limit|too many requests/i.test(text)) return normalizedProviderError('PROVIDER_RATE_LIMITED', 'runtime', 'Codex rate limit reached', true);
    if (/quota/i.test(text)) return normalizedProviderError('PROVIDER_QUOTA_EXCEEDED', 'runtime', 'Codex quota was exceeded');
    if (/model.*(?:unavailable|not found)|unknown model/i.test(text)) return normalizedProviderError('PROVIDER_MODEL_UNAVAILABLE', 'validation', 'Codex model is unavailable');
    if (/network|connect|timed out|timeout/i.test(text)) return normalizedProviderError('PROVIDER_NETWORK_ERROR', 'runtime', 'Codex network operation failed', true);
    if (/version|unsupported/i.test(text)) return normalizedProviderError('PROVIDER_VERSION_UNSUPPORTED', 'validation', 'Codex version is unsupported');
    if (/ENOENT|not found|access denied|EACCES|EPERM/i.test(text)) return normalizedProviderError('PROVIDER_EXECUTABLE_NOT_ACCESSIBLE', 'discovery', 'Codex executable is not accessible');
    if (/output[- ]?format|--json|structured/i.test(text)) return normalizedProviderError('PROVIDER_CAPABILITY_UNAVAILABLE', 'validation', 'Codex structured output is unavailable');
    if (/invalid[_ -]?json|oversized|too large.*json|jsonl/i.test(text)) return normalizedProviderError('PROVIDER_OUTPUT_PARSE_FAILED', 'output-parse', 'Codex output could not be parsed');
    if (/no valid assistant output|output invalid/i.test(text)) return normalizedProviderError('PROVIDER_OUTPUT_INVALID', 'finalize', 'Codex produced no valid assistant output');
    if (/spawn|failed to start/i.test(text)) return normalizedProviderError('PROVIDER_START_FAILED', 'startup', 'Codex process failed to start');
    if (phase === 'cancel') return normalizedProviderError('PROVIDER_CANCEL_FAILED', 'cancel', 'Provider cancellation failed');
    return normalizedProviderError('PROVIDER_INTERNAL_ERROR', phase, 'Codex provider operation failed');
  }
}

function capabilitiesForStructuredOutput(structuredOutput: boolean): ProviderCapabilities {
  return {
    ...CODEX_CAPABILITIES,
    structuredEvents: structuredOutput,
    toolEvents: structuredOutput,
    usageEvents: structuredOutput,
  };
}

function buildCodexArgs(template: readonly string[], prompt: string, model?: string): string[] {
  const args = [...template];
  if (args.some(argument => argument.includes('\u0000')) || prompt.includes('\u0000')
    || (model !== undefined && (model.includes('\u0000') || model.length > 128 || !/^[A-Za-z0-9._\/\-\[\]]+$/u.test(model)))) {
    throw new Error('PROVIDER_CONFIG_INVALID');
  }
  let execIndex = args.indexOf('exec');
  if (execIndex < 0) {
    args.unshift('exec');
    execIndex = 0;
  }
  if (!args.includes('--json')) args.splice(execIndex + 1, 0, '--json');
  if (!args.includes('--skip-git-repo-check')) args.splice(args.indexOf('exec') + 1, 0, '--skip-git-repo-check');
  if (model !== undefined && !args.includes('-m') && !args.includes('--model')) {
    args.splice(args.indexOf('exec') + 1, 0, '--model', model);
  }
  // Legacy Codex invocation marks prompt delivery as an argument; the
  // canonical coordinator therefore receives it as one final separated arg.
  args.push(prompt);
  return args;
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
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function findOnPath(command: string, environment: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform): Promise<string | undefined> {
  const pathValue = environment.PATH ?? environment.Path ?? '';
  const extensions = platform === 'win32'
    ? (environment.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
    : [''];
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
  return message.length > 256 ? `${message.slice(0, 256)}...` : message;
}

function probeOutput(result: ProcessProbeResult): string {
  return `${result.stdout}${result.stderr}`;
}

function providerProbeError(result: ProcessProbeResult, phase: 'discovery' | 'validation'): ProviderNormalizedError | undefined {
  switch (result.errorCode) {
    case 'PROCESS_EXECUTABLE_NOT_FOUND':
      return normalizedProviderError('PROVIDER_NOT_FOUND', 'discovery', 'Codex executable was not found');
    case 'PROCESS_EXECUTABLE_NOT_ACCESSIBLE':
      return normalizedProviderError('PROVIDER_EXECUTABLE_NOT_ACCESSIBLE', 'discovery', 'Codex executable is not accessible');
    case 'PROCESS_STARTUP_TIMEOUT':
      return normalizedProviderError('PROVIDER_INTERNAL_ERROR', phase, 'Codex validation probe timed out', true);
    case 'PROCESS_REQUEST_INVALID':
    case 'PROCESS_UNKNOWN_ERROR':
      return normalizedProviderError('PROVIDER_INTERNAL_ERROR', phase, 'Codex validation probe failed');
    default:
      return undefined;
  }
}

function safeProbeEnvironment(environment: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return safeEnvironmentForCodex(environment);
}

export function safeEnvironmentForCodex(
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  assertNoConflictingEnvironmentAliases(environment, platform);
  const result: Record<string, string> = {};
  const selectedComparisonKeys = new Set<string>();
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined || SECRET_KEY_PATTERN.test(key)) continue;
    const comparisonKey = platform === 'win32' ? key.toUpperCase() : key;
    if (!SAFE_ENVIRONMENT_KEYS.has(comparisonKey) || selectedComparisonKeys.has(comparisonKey)) continue;
    selectedComparisonKeys.add(comparisonKey);
    result[key] = value;
  }
  return result;
}

function assertNoConflictingEnvironmentAliases(
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): void {
  const valuesByComparisonKey = new Map<string, string>();
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) continue;
    const comparisonKey = platform === 'win32' ? key.toUpperCase() : key;
    if (valuesByComparisonKey.has(comparisonKey) && valuesByComparisonKey.get(comparisonKey) !== value) {
      throw new Error('PROVIDER_CONFIG_INVALID');
    }
    valuesByComparisonKey.set(comparisonKey, value);
  }
}

function toValidationError(error: ProviderNormalizedError): ProviderValidationError {
  return { code: error.code, phase: error.phase, message: error.message, retryable: error.retryable };
}

function isProviderNormalizedError(value: unknown): value is ProviderNormalizedError {
  return typeof value === 'object'
    && value !== null
    && 'code' in value
    && 'phase' in value
    && 'message' in value
    && 'retryable' in value;
}

function canonicalizeEvent(event: NormalizedCliEvent): ProviderNormalizedEvent {
  // Codex is already a canonical ProviderType in the legacy usage event.
  return event as ProviderNormalizedEvent;
}
