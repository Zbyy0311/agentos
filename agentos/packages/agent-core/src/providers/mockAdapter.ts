import { normalizedProviderError } from './errors.js';
import type { CliEventParser, NormalizedCliEvent } from '../adapters/types.js';
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
  MOCK_ADAPTER_ID,
  MOCK_ADAPTER_VERSION,
  MOCK_PROVIDER_TYPE,
  PROVIDER_ERROR_CODES,
  resolveFrozenProviderIdentity,
} from './types.js';

export {
  MOCK_ADAPTER_ID,
  MOCK_ADAPTER_VERSION,
  MOCK_PROVIDER_TYPE,
} from './types.js';

/**
 * P57 §57.3 Mock Provider scenarios. Each scenario scripts a deterministic
 * transcript (fixed event order, fixed delays, fixed errors) used for Runtime
 * development, E2E, CI, Event Model, Approval, Failure and Recovery testing.
 */
export const MOCK_PROVIDER_SCENARIOS = [
  'success',
  'slow-stream',
  'tool-calls',
  'file-changes',
  'subagents',
  'approval',
  'auth-required',
  'rate-limit',
  'non-zero-exit',
  'idle-timeout',
  'parse-error',
  'cancel',
  'resume',
  'process-crash',
] as const;

export type MockProviderScenario = (typeof MOCK_PROVIDER_SCENARIOS)[number];

export function isMockProviderScenario(value: string): value is MockProviderScenario {
  return (MOCK_PROVIDER_SCENARIOS as readonly string[]).includes(value);
}

/** Environment variable selecting the scripted scenario for a mock run. */
export const MOCK_SCENARIO_ENV_KEY = 'AGENTOS_MOCK_SCENARIO';
/** Environment variable overriding the per-line stream delay in milliseconds. */
export const MOCK_DELAY_ENV_KEY = 'AGENTOS_MOCK_DELAY_MS';
/** Environment variable fixing the deterministic seed recorded in launch metadata. */
export const MOCK_SEED_ENV_KEY = 'AGENTOS_MOCK_SEED';

export const MOCK_DEFAULT_DELAY_MS = 5;
export const MOCK_SLOW_STREAM_DELAY_MS = 250;
/** Number of deterministic lines emitted by the large-output payload scenario. */
export const MOCK_LARGE_OUTPUT_LINES = 256;

const MOCK_CAPABILITIES: ProviderCapabilities = {
  sessionResume: true,
  structuredEvents: true,
  nativeApprovals: true,
  subagents: true,
  toolEvents: true,
  fileEvents: true,
  usageEvents: true,
  reasoningStream: false,
  interactiveInput: false,
  pause: false,
  cancellation: true,
  modelSelection: false,
  workspaceAwareness: false,
  nativeSandbox: false,
  outputContracts: true,
};

const MOCK_EXECUTABLE_MARKER = 'mock://internal/emitter';
const SIMULATED_PROCESS_NOTE =
  'Mock provider never spawns a real provider CLI; output is scripted and deterministic';
const MAX_PROMPT_CHARACTERS = 128 * 1024;

/** One scripted stdout line of a mock transcript. */
export type MockTranscriptLine =
  | { readonly kind: 'event'; readonly event: ProviderNormalizedEvent }
  | { readonly kind: 'text'; readonly text: string };

type MockTranscriptInput = MockTranscriptLine | ProviderNormalizedEvent;

function normalizeLines(lines: readonly MockTranscriptInput[]): MockTranscriptLine[] {
  return lines.map(line => ('kind' in line ? line : eventLine(line)));
}

export interface MockTranscript {
  readonly lines: readonly MockTranscriptLine[];
  readonly delayMs: number;
  /** True when the emitter stalls until an external actor cancels it. */
  readonly stall: boolean;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stderr: string;
}

export interface MockTranscriptOptions {
  readonly delayMs?: number;
  readonly seed?: number;
  /** Include the deterministic large-output payload (used by large-output tests). */
  readonly largeOutput?: boolean;
}

function eventLine(event: ProviderNormalizedEvent): MockTranscriptLine {
  return { kind: 'event', event };
}

function textLine(text: string): MockTranscriptLine {
  return { kind: 'text', text };
}

function usageEvent(seed: number): ProviderNormalizedEvent {
  return {
    type: 'usage',
    source: 'structured',
    provider: 'mock',
    model: 'mock-model',
    estimated: false,
    inputTokens: 100 + seed,
    outputTokens: 50 + seed,
  };
}

/**
 * Builds the deterministic §57.3 scenario transcript. The same transcript is
 * embedded into the simulated launch plan and replayed by parseChunk in tests,
 * which keeps engine-driven E2E runs and unit tests on identical event order.
 */
export function buildMockTranscript(
  scenario: MockProviderScenario,
  options: MockTranscriptOptions = {},
): MockTranscript {
  const seed = options.seed ?? 0;
  switch (scenario) {
    case 'success':
      return finishedTranscript([
        { type: 'status', phase: 'starting', label: 'mock session started' },
        textLine('Mock provider received the prompt.'),
        textLine('Mock provider completed the request successfully.'),
        eventLine(usageEvent(seed)),
        { type: 'status', phase: 'finalizing', label: 'mock session complete' },
      ], options);
    case 'slow-stream':
      return finishedTranscript([
        { type: 'status', phase: 'starting', label: 'mock session started' },
        textLine('Mock streaming first delta.'),
        textLine('Mock streaming second delta.'),
        eventLine(usageEvent(seed)),
      ], { ...options, delayMs: options.delayMs ?? MOCK_SLOW_STREAM_DELAY_MS });
    case 'tool-calls':
      return finishedTranscript([
        { type: 'status', phase: 'working', label: 'mock tool execution' },
        {
          type: 'tool.started', callId: 'mock-call-1', toolName: 'read_file',
          summary: 'Read the target source file', inputPreview: '{"path":"src/index.ts"}',
        },
        {
          type: 'tool.completed', callId: 'mock-call-1', toolName: 'read_file', success: true,
          summary: 'File read completed', outputPreview: 'export {};', durationMs: 12,
        },
        {
          type: 'tool.started', callId: 'mock-call-2', toolName: 'run_command',
          summary: 'Run the test suite', inputPreview: '{"command":"pnpm test"}',
        },
        {
          type: 'tool.completed', callId: 'mock-call-2', toolName: 'run_command', success: true,
          summary: 'Tests passed', outputPreview: 'ok 14 tests',
          commandResult: { command: 'pnpm test', exitCode: 0 },
        },
        textLine('Tool calls finished; answering.'),
        eventLine(usageEvent(seed)),
      ], options);
    case 'file-changes':
      return finishedTranscript([
        {
          type: 'tool.started', callId: 'mock-call-file-1', toolName: 'write_file',
          summary: 'Write src/answer.ts', inputPreview: '{"path":"src/answer.ts"}',
        },
        {
          type: 'tool.completed', callId: 'mock-call-file-1', toolName: 'write_file', success: true,
          summary: 'File written', outputPreview: 'export const answer = 42;',
        },
        textLine('File changes applied.'),
      ], options);
    case 'subagents':
      return finishedTranscript([
        { type: 'status', phase: 'working', label: 'mock subagent delegation' },
        {
          type: 'diagnostic', level: 'warning', code: 'mock.subagent_spawned',
          message: 'Subagent mock-sub-1 spawned for exploration',
        },
        textLine('Exploring the repository layout.'),
        {
          type: 'diagnostic', level: 'warning', code: 'mock.subagent_completed',
          message: 'Subagent mock-sub-1 completed with findings',
        },
        textLine('Delegating follow-up work to subagents.'),
      ], options);
    case 'approval':
      return finishedTranscript([
        { type: 'status', phase: 'working', label: 'mock approval gate' },
        {
          type: 'approval.requested', requestId: 'mock-approval-1', toolName: 'run_command',
          riskLevel: 'high', summary: 'Run destructive cleanup command', affectedPaths: ['build/'],
        },
        {
          type: 'approval.resolved', requestId: 'mock-approval-1',
          decision: 'allow_once',
        },
        textLine('Approval granted; continuing.'),
      ], options);
    case 'auth-required':
      return failedTranscript('mock provider authentication required: run login', 1, options);
    case 'rate-limit':
      return failedTranscript('mock provider rate limit exceeded (HTTP 429)', 1, options);
    case 'non-zero-exit':
      return {
        ...finishedTranscript([textLine('Partial output before failure.')], options),
        exitCode: 3,
        stderr: 'mock provider failed deliberately with exit code 3',
      };
    case 'idle-timeout':
      // Emit one line, then stall: the run engine's idle timeout or an external
      // cancel terminates the simulated process.
      return {
        lines: normalizeLines([
          { type: 'status', phase: 'thinking', label: 'mock thinking forever' },
          textLine('Mock provider emitted one line and stalled.'),
        ]),
        delayMs: options.delayMs ?? MOCK_DEFAULT_DELAY_MS,
        stall: true,
        exitCode: null,
        signal: null,
        stderr: 'mock provider idle timeout exceeded',
      };
    case 'parse-error':
      // A malformed MOCK-EVENT line drives the adapter's parse-error path.
      return finishedTranscript([
        textLine('Mock output before the malformed event.'),
        { kind: 'text', text: `${MOCK_EVENT_PREFIX}{not-json` },
        textLine('Mock output after the malformed event.'),
      ], options);
    case 'cancel':
      // Stalls until the run engine requests graceful cancellation.
      return {
        lines: normalizeLines([
          { type: 'status', phase: 'working', label: 'mock long-running operation' },
        ]),
        delayMs: options.delayMs ?? MOCK_DEFAULT_DELAY_MS,
        stall: true,
        exitCode: null,
        signal: null,
        stderr: '',
      };
    case 'resume':
      return finishedTranscript([
        { type: 'status', phase: 'starting', label: 'mock session resumed' },
        textLine('Resumed prior session context.'),
        textLine('Mock provider continued the resumed request.'),
        eventLine(usageEvent(seed)),
      ], options);
    case 'process-crash':
      return {
        lines: normalizeLines([textLine('Mock output before the crash.')]),
        delayMs: options.delayMs ?? MOCK_DEFAULT_DELAY_MS,
        stall: false,
        exitCode: null,
        signal: 'SIGSEGV',
        stderr: 'mock provider crashed mid-stream',
      };
  }
}

function finishedTranscript(
  lines: readonly MockTranscriptInput[],
  options: MockTranscriptOptions,
): MockTranscript {
  const transcriptLines: MockTranscriptLine[] = normalizeLines(lines);
  if (options.largeOutput === true) {
    for (let index = 0; index < MOCK_LARGE_OUTPUT_LINES; index += 1) {
      transcriptLines.push(textLine(`mock bulk output line ${index} (${options.seed ?? 0})`));
    }
  }
  return {
    lines: transcriptLines,
    delayMs: options.delayMs ?? MOCK_DEFAULT_DELAY_MS,
    stall: false,
    exitCode: 0,
    signal: null,
    stderr: '',
  };
}

function failedTranscript(
  stderr: string,
  exitCode: number,
  options: MockTranscriptOptions,
): MockTranscript {
  return {
    lines: normalizeLines([{ type: 'status', phase: 'starting', label: 'mock session started' }]),
    delayMs: options.delayMs ?? MOCK_DEFAULT_DELAY_MS,
    stall: false,
    exitCode,
    signal: null,
    stderr,
  };
}

/** Wire format: one stdout line, either `MOCK-EVENT <json>` or plain assistant text. */
export const MOCK_EVENT_PREFIX = 'MOCK-EVENT ';

export function encodeMockTranscriptLine(line: MockTranscriptLine): string {
  return line.kind === 'event' ? `${MOCK_EVENT_PREFIX}${JSON.stringify(line.event)}` : line.text;
}

/**
 * Inline emitter executed by the current Node runtime (never by a provider
 * CLI). It replays the scripted transcript with fixed delays and then exits
 * with the scripted exit code, kills itself with the scripted signal, or
 * stalls until the run engine cancels it.
 */
export function buildMockEmitterScript(transcript: MockTranscript): string {
  const payload = JSON.stringify({
    lines: transcript.lines.map(line => encodeMockTranscriptLine(line)),
    delayMs: transcript.delayMs,
    stall: transcript.stall,
    exitCode: transcript.exitCode,
    signal: transcript.signal,
  });
  return [
    `'use strict';`,
    `const t = ${payload};`,
    `(async () => {`,
    `  for (const line of t.lines) {`,
    `    process.stdout.write(line + '\\n');`,
    `    await new Promise(resolve => setTimeout(resolve, t.delayMs));`,
    `  }`,
    `  process.stdout.write('', () => {});`,
    `  if (t.stall) { setInterval(() => {}, 2147483647); return; }`,
    `  if (typeof t.signal === 'string' && t.signal) { process.kill(process.pid, t.signal); return; }`,
    `  process.exit(typeof t.exitCode === 'number' ? t.exitCode : 0);`,
    `})();`,
  ].join('\n');
}

function resolveScenarioFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> | undefined,
): MockProviderScenario {
  const value = environment?.[MOCK_SCENARIO_ENV_KEY]?.trim();
  return value !== undefined && value !== '' && isMockProviderScenario(value) ? value : 'success';
}

function resolveDelayFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> | undefined,
): number | undefined {
  const raw = environment?.[MOCK_DELAY_ENV_KEY]?.trim();
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function resolveSeedFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> | undefined,
): number | undefined {
  const raw = environment?.[MOCK_SEED_ENV_KEY]?.trim();
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

class MockEventParser implements CliEventParser {
  private buffer = '';

  push(chunk: string): NormalizedCliEvent[] {
    if (!chunk) return [];
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? '';
    return lines.flatMap(line => this.parseLine(line));
  }

  finish(): NormalizedCliEvent[] {
    const line = this.buffer;
    this.buffer = '';
    return line ? this.parseLine(line) : [];
  }

  private parseLine(line: string): NormalizedCliEvent[] {
    if (!line) return [];
    if (!line.startsWith(MOCK_EVENT_PREFIX)) {
      return [{ type: 'assistant.message', text: line }];
    }
    try {
      const event = JSON.parse(line.slice(MOCK_EVENT_PREFIX.length)) as NormalizedCliEvent;
      if (typeof event !== 'object' || event === null || typeof event.type !== 'string') {
        throw new Error('missing event type');
      }
      return [event];
    } catch {
      return [{
        type: 'diagnostic',
        level: 'error',
        code: 'adapter.mock.malformed_event',
        message: 'Mock provider emitted a malformed MOCK-EVENT line',
      }];
    }
  }
}

export interface MockProviderAdapterOptions {
  /** Pin the scenario (used by tests); overrides AGENTOS_MOCK_SCENARIO. */
  readonly scenario?: MockProviderScenario;
  /** Pin the deterministic seed; overrides AGENTOS_MOCK_SEED. */
  readonly seed?: number;
}

/**
 * P57 §57 Mock Provider Adapter.
 *
 * This adapter exists for Runtime development, E2E, CI, Event Model, Approval,
 * Failure and Recovery testing. It never spawns a real provider process:
 * discover/validate always succeed, and buildLaunchPlan produces an internal
 * simulated plan whose executable is the current Node runtime replaying a
 * deterministic scripted transcript (§57.4: fixed event order, fixed delay,
 * fixed error, seed, controllable process and artifact).
 *
 * The mock never enters production paths: it is only selected when a provider
 * configuration explicitly uses providerType 'mock' with adapterId
 * 'builtin.mock'.
 */
export class MockProviderAdapter implements RuntimeProviderAdapter {
  readonly manifest: ProviderAdapterManifest = {
    id: MOCK_ADAPTER_ID,
    name: 'Mock Provider',
    version: MOCK_ADAPTER_VERSION,
    providerTypes: [MOCK_PROVIDER_TYPE],
    runtimeModes: ['cli'],
    capabilities: MOCK_CAPABILITIES,
    builtIn: true,
    configSchemaVersion: 1,
    description: 'Internal scripted mock provider for Runtime development, E2E, CI and failure injection (P57 §57)',
  };

  private readonly pinnedScenario?: MockProviderScenario;
  private readonly pinnedSeed?: number;
  /**
   * finalize() receives no configuration, so the scenario of the most recent
   * launch plan is retained on the instance, matching CustomCliAdapter's
   * success-exit-code retention across the buildLaunchPlan/finalize boundary.
   */
  private lastScenario: MockProviderScenario = 'success';

  constructor(options: MockProviderAdapterOptions = {}) {
    this.pinnedScenario = options.scenario;
    this.pinnedSeed = options.seed;
  }

  private resolveScenario(
    environment: Readonly<Record<string, string | undefined>> | undefined,
  ): MockProviderScenario {
    return this.pinnedScenario ?? resolveScenarioFromEnvironment(environment);
  }

  getDefaultCapabilities(_configuration: Partial<ProviderConfigurationInput>): ProviderCapabilities {
    return { ...MOCK_CAPABILITIES };
  }

  normalizeConfiguration(configuration: ProviderConfigurationInput): ProviderConfigurationInput {
    const normalized: ProviderConfigurationInput = {
      ...configuration,
      capabilities: { ...configuration.capabilities },
      timeoutPolicy: { ...configuration.timeoutPolicy },
    };
    const frozenIdentity = resolveFrozenProviderIdentity(normalized);
    return frozenIdentity === undefined ? normalized : { ...normalized, adapterVersion: frozenIdentity.adapterVersion };
  }

  async discover(input: ProviderDiscoveryInput): Promise<ProviderDiscoveryResult> {
    if (input.providerType !== MOCK_PROVIDER_TYPE) {
      return {
        found: false,
        candidates: [],
        warnings: ['Mock provider adapter only supports canonical provider type mock'],
      };
    }
    // Simulated discovery: no filesystem or PATH probing is ever performed.
    const candidates: ProviderDiscoveryCandidate[] = [{
      executable: MOCK_EXECUTABLE_MARKER,
      source: 'registry',
      confidence: 1,
    }];
    return { found: true, selected: MOCK_EXECUTABLE_MARKER, candidates, warnings: [SIMULATED_PROCESS_NOTE] };
  }

  async validate(input: ProviderValidationInput): Promise<ProviderValidationResult> {
    const configuration = this.normalizeConfiguration(input.configuration);
    const checkedAt = input.now ?? new Date().toISOString();
    const warnings: ProviderValidationWarning[] = [{ code: 'PROVIDER_MOCK_SIMULATED', message: SIMULATED_PROCESS_NOTE }];
    const errors: ProviderValidationError[] = [];

    if (!configuration.enabled || configuration.archivedAt) {
      errors.push({
        code: 'PROVIDER_CONFIG_INVALID',
        phase: 'configuration',
        message: 'Mock provider configuration is disabled or archived',
        retryable: false,
      });
    }
    if (configuration.providerType !== MOCK_PROVIDER_TYPE) {
      errors.push({
        code: 'PROVIDER_CONFIG_INVALID',
        phase: 'configuration',
        message: 'Mock provider configuration must use providerType mock',
        retryable: false,
      });
    }
    if (configuration.adapterId !== MOCK_ADAPTER_ID || configuration.runtimeMode !== 'cli') {
      errors.push({
        code: 'PROVIDER_CONFIG_INVALID',
        phase: 'configuration',
        message: 'Mock provider requires builtin.mock CLI configuration',
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
        message: 'Mock provider requires the exact builtin.mock adapter version 1.0.0',
        retryable: false,
      });
    }
    for (const [capability, requested] of Object.entries(configuration.capabilities)) {
      if (requested === true && MOCK_CAPABILITIES[capability as keyof ProviderCapabilities] !== true) {
        errors.push({
          code: 'PROVIDER_CAPABILITY_UNAVAILABLE',
          phase: 'validation',
          message: `Mock provider capability ${capability} is not supported`,
          retryable: false,
        });
      }
    }

    const authentication: ProviderAuthenticationState = 'not-required';
    if (errors.length > 0) {
      return {
        valid: false,
        capabilities: { ...MOCK_CAPABILITIES },
        outputMode: configuration.outputMode,
        warnings,
        errors,
        checkedAt,
      };
    }

    const scenario = this.resolveScenario(input.environment ?? process.env);
    return {
      valid: true,
      executableResolved: MOCK_EXECUTABLE_MARKER,
      cliVersion: MOCK_ADAPTER_VERSION,
      authentication,
      capabilities: { ...MOCK_CAPABILITIES },
      outputMode: configuration.outputMode,
      warnings: [...warnings, { code: 'PROVIDER_MOCK_SCENARIO', message: `Mock provider scenario: ${scenario}` }],
      errors: [],
      checkedAt,
    };
  }

  async buildLaunchPlan(input: ProviderStartInput): Promise<ProviderLaunchPlan> {
    const configuration = this.normalizeConfiguration(input.configuration);
    if (
      !configuration.enabled
      || configuration.archivedAt
      || configuration.providerType !== MOCK_PROVIDER_TYPE
      || configuration.adapterId !== MOCK_ADAPTER_ID
      || configuration.runtimeMode !== 'cli'
      || resolveFrozenProviderIdentity(configuration)?.adapterVersion !== MOCK_ADAPTER_VERSION
    ) {
      throw new Error('PROVIDER_CONFIG_INVALID');
    }

    const prompt = input.prompt;
    if (!prompt.trim() || prompt.length > MAX_PROMPT_CHARACTERS || prompt.includes(' ')) {
      throw new Error('PROVIDER_CONFIG_INVALID');
    }

    const environment = input.environment ?? process.env;
    const scenario = this.resolveScenario(environment);
    this.lastScenario = scenario;
    const seed = this.pinnedSeed ?? resolveSeedFromEnvironment(environment) ?? 0;
    const transcript = buildMockTranscript(scenario, {
      delayMs: resolveDelayFromEnvironment(environment),
      seed,
    });

    const cwd = configuration.workingDirectoryMode === 'worktree'
      ? input.worktreePath ?? input.workspaceRoot
      : configuration.workingDirectoryMode === 'custom'
        ? configuration.customWorkingDirectory
        : input.workspaceRoot;
    if (!cwd || cwd.includes(' ')) throw new Error('PROVIDER_CONFIG_INVALID');

    return {
      runtimeMode: 'cli',
      // The simulated plan re-enters the current Node runtime with an inline
      // scripted emitter. No provider executable, PATH lookup or probe ever
      // runs, which keeps the mock usable in hermetic CI environments.
      executable: process.execPath,
      args: ['-e', buildMockEmitterScript(transcript)],
      cwd,
      environment: {},
      redactedEnvironmentKeys: [],
      secretRefs: [...new Set(input.secretRefs ?? (configuration.secretProfileId ? [configuration.secretProfileId] : []))],
      stdinMode: 'none',
      promptDelivery: 'argument',
      structuredOutput: 'text',
      cleanupFiles: [],
      shell: false,
      metadata: {
        simulated: true,
        providerType: MOCK_PROVIDER_TYPE,
        adapterId: this.manifest.id,
        adapterVersion: this.manifest.version,
        providerConfigId: configuration.id,
        providerConfigVersion: configuration.version,
        configSchemaVersion: this.manifest.configSchemaVersion,
        mockScenario: scenario,
        mockSeed: seed,
        mockDelayMs: transcript.delayMs,
        mockStall: transcript.stall,
      },
    };
  }

  createParseContext(): ProviderParseContext {
    return { parser: new MockEventParser() };
  }

  parseChunk(chunk: string, context: ProviderParseContext = this.createParseContext()): ProviderParseResult {
    const parser = context.parser ?? new MockEventParser();
    const events = parser.push(chunk).map(event => event as ProviderNormalizedEvent);
    return { context: { parser }, events, diagnostics: events.filter(event => event.type === 'diagnostic') };
  }

  finishParse(context: ProviderParseContext = this.createParseContext()): ProviderParseResult {
    const parser = context.parser ?? new MockEventParser();
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

    if (input.parsedEvents.some(event => event.type === 'diagnostic' && event.code === 'adapter.mock.malformed_event')) {
      return {
        status: 'failed',
        events: input.parsedEvents,
        error: normalizedProviderError('PROVIDER_OUTPUT_PARSE_FAILED', 'output-parse', 'Mock provider emitted a malformed event line'),
      };
    }

    const scenario = this.lastScenario;
    if (scenario === 'process-crash' || (input.exitCode !== 0 && scenario !== 'idle-timeout' && scenario !== 'cancel')) {
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
            `Mock provider session exited unsuccessfully (exit code ${input.exitCode ?? 'null'})`,
          ),
      };
    }
    if (scenario === 'idle-timeout' || (input.exitCode === null && input.signal !== null)) {
      return {
        status: 'failed',
        events: input.parsedEvents,
        error: this.normalizeError(input.stderr || 'idle timeout', { phase: 'runtime' }),
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
        error: normalizedProviderError('PROVIDER_OUTPUT_INVALID', 'finalize', 'Mock provider produced no assistant output'),
      };
    }
    return { status: 'completed', events: input.parsedEvents, output };
  }

  async cancel(input: ProviderCancelInput): Promise<ProviderCancelResult> {
    // Mirrors CustomCliAdapter: acceptance requests an owned process stop;
    // terminal completion remains the Process Runtime's responsibility.
    if (!input.stopTicketAccepted) {
      return { accepted: false, error: normalizedProviderError('PROVIDER_CANCEL_FAILED', 'cancel', 'Process stop ticket was not accepted') };
    }
    try {
      const result = await input.processPort.requestGraceful({
        processId: input.processId, sessionId: input.sessionId, reason: input.reason,
      });
      return result.accepted
        ? { accepted: true }
        : { accepted: false, error: normalizedProviderError('PROVIDER_CANCEL_FAILED', 'cancel', 'Mock provider process stop was not accepted') };
    } catch {
      return { accepted: false, error: normalizedProviderError('PROVIDER_CANCEL_FAILED', 'cancel', 'Mock provider process stop failed') };
    }
  }

  normalizeError(error: unknown, context: { readonly phase?: ProviderErrorPhase } = {}): ProviderNormalizedError {
    const phase = context.phase ?? 'internal';
    if (isProviderNormalizedError(error)) {
      return normalizedProviderError(
        error.code,
        phase === 'internal' ? error.phase : phase,
        stableErrorMessage(error.code),
        error.retryable,
      );
    }

    const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
    if (/PROVIDER_CONFIG_INVALID|invalid (?:provider )?configuration/i.test(text)) {
      return normalizedProviderError('PROVIDER_CONFIG_INVALID', 'configuration', 'Mock provider configuration is invalid');
    }
    if (/PROVIDER_VERSION_UNSUPPORTED|version|unsupported/i.test(text)) {
      return normalizedProviderError('PROVIDER_VERSION_UNSUPPORTED', 'validation', 'Mock provider version support is unavailable');
    }
    if (/cancel|stop/i.test(text) || phase === 'cancel') {
      return normalizedProviderError('PROVIDER_CANCEL_FAILED', 'cancel', 'Mock provider cancellation failed');
    }
    if (/expired/i.test(text)) {
      return normalizedProviderError('PROVIDER_AUTH_EXPIRED', 'authentication', 'Mock provider authentication has expired');
    }
    if (/auth|login|credential|token|api[_-]?key/i.test(text)) {
      return normalizedProviderError('PROVIDER_AUTH_REQUIRED', 'authentication', 'Mock provider authentication is required');
    }
    if (/rate[ -]?limit|too many requests|429/i.test(text)) {
      return normalizedProviderError('PROVIDER_RATE_LIMITED', 'runtime', 'Mock provider rate limit reached', true);
    }
    if (/quota/i.test(text)) {
      return normalizedProviderError('PROVIDER_QUOTA_EXCEEDED', 'runtime', 'Mock provider quota was exceeded');
    }
    if (/crash|segfault|sigsegv/i.test(text)) {
      return normalizedProviderError('PROVIDER_SESSION_FAILED', 'runtime', 'Mock provider process crashed mid-stream', true);
    }
    if (/network|connect/i.test(text)) {
      return normalizedProviderError('PROVIDER_NETWORK_ERROR', 'runtime', 'Mock provider network operation failed', true);
    }
    if (/idle timeout|timed out|timeout/i.test(text)) {
      return normalizedProviderError('PROVIDER_NETWORK_ERROR', 'runtime', 'Mock provider idle timeout exceeded', true);
    }
    return normalizedProviderError('PROVIDER_SESSION_FAILED', 'finalize', 'Mock provider session failed');
  }
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
    case 'PROVIDER_CONFIG_INVALID': return 'Mock provider configuration is invalid';
    case 'PROVIDER_NOT_FOUND': return 'Mock provider executable was not found';
    case 'PROVIDER_EXECUTABLE_NOT_ACCESSIBLE': return 'Mock provider executable is not accessible';
    case 'PROVIDER_VERSION_UNSUPPORTED': return 'Mock provider version support is unavailable';
    case 'PROVIDER_AUTH_REQUIRED': return 'Mock provider authentication is required';
    case 'PROVIDER_AUTH_EXPIRED': return 'Mock provider authentication has expired';
    case 'PROVIDER_RATE_LIMITED': return 'Mock provider rate limit reached';
    case 'PROVIDER_QUOTA_EXCEEDED': return 'Mock provider quota was exceeded';
    case 'PROVIDER_MODEL_UNAVAILABLE': return 'Mock provider model is unavailable';
    case 'PROVIDER_CAPABILITY_UNAVAILABLE': return 'Mock provider capability is unavailable';
    case 'PROVIDER_START_FAILED': return 'Mock provider failed to start';
    case 'PROVIDER_SESSION_FAILED': return 'Mock provider session failed';
    case 'PROVIDER_SESSION_NOT_RESUMABLE': return 'Mock provider session resume is unavailable';
    case 'PROVIDER_OUTPUT_PARSE_FAILED': return 'Mock provider output could not be parsed';
    case 'PROVIDER_OUTPUT_INVALID': return 'Mock provider output is invalid';
    case 'PROVIDER_APPROVAL_FAILED': return 'Mock provider approval is unavailable';
    case 'PROVIDER_CANCEL_FAILED': return 'Mock provider cancellation failed';
    case 'PROVIDER_PAUSE_UNSUPPORTED': return 'Mock provider pause is unavailable';
    case 'PROVIDER_RESUME_FAILED': return 'Mock provider resume failed';
    case 'PROVIDER_NETWORK_ERROR': return 'Mock provider network operation failed';
    case 'PROVIDER_ADAPTER_NOT_FOUND': return 'Mock provider adapter was not found';
    case 'PROVIDER_INTERNAL_ERROR': return 'Mock provider operation failed';
    case 'PROVIDER_UNKNOWN_ERROR': return 'Mock provider operation failed';
  }
}
