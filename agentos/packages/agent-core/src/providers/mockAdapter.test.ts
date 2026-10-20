import { describe, expect, it } from 'vitest';
import {
  MockProviderAdapter,
  MOCK_PROVIDER_SCENARIOS,
  buildMockTranscript,
  encodeMockTranscriptLine,
  isMockProviderScenario,
} from './mockAdapter.js';
import { ProviderRegistry } from './registry.js';
import type {
  ProviderConfigurationInput,
  ProviderNormalizedEvent,
  ProviderParseContext,
} from './types.js';

function makeConfig(overrides: Partial<ProviderConfigurationInput> = {}): ProviderConfigurationInput {
  return {
    id: 'cfg_mock',
    name: 'Mock provider',
    providerType: 'mock',
    adapterId: 'builtin.mock',
    runtimeMode: 'cli',
    workingDirectoryMode: 'workspace',
    capabilities: new MockProviderAdapter().getDefaultCapabilities({}),
    timeoutPolicy: {
      discoveryTimeoutMs: 10_000,
      validationTimeoutMs: 30_000,
      startupTimeoutMs: 60_000,
      idleTimeoutMs: 600_000,
      totalTimeoutMs: null,
      cancelGracePeriodMs: 5_000,
      approvalTimeoutMs: null,
    },
    approvalMode: 'agentos',
    outputMode: 'structured',
    enabled: true,
    version: 1,
    ...overrides,
  };
}

interface ScenarioRun {
  readonly plan: import('./types.js').ProviderLaunchPlan;
  readonly events: readonly ProviderNormalizedEvent[];
  readonly result: import('./types.js').ProviderFinalResult;
}

async function runScenario(scenario: import('./mockAdapter.js').MockProviderScenario): Promise<ScenarioRun> {
  const adapter = new MockProviderAdapter({ scenario });
  const plan = await adapter.buildLaunchPlan({
    configuration: makeConfig(),
    workspaceRoot: '/workspace',
    prompt: 'mock prompt',
    environment: {},
  });
  const transcript = buildMockTranscript(scenario, {});
  const context: ProviderParseContext = adapter.createParseContext();
  const events: ProviderNormalizedEvent[] = [];
  for (const line of transcript.lines) {
    events.push(...adapter.parseChunk(`${encodeMockTranscriptLine(line)}\n`, context).events);
  }
  events.push(...adapter.finishParse(context).events);
  const result = await adapter.finalize({
    exitCode: transcript.exitCode,
    signal: transcript.signal,
    parsedEvents: events,
    stderr: transcript.stderr,
  });
  return { plan, events, result };
}

describe('MockProviderAdapter manifest and registry contract', () => {
  it('declares the builtin.mock manifest with mock provider type and cli runtime mode', () => {
    const adapter = new MockProviderAdapter();
    expect(adapter.manifest.id).toBe('builtin.mock');
    expect(adapter.manifest.version).toBe('1.0.0');
    expect(adapter.manifest.builtIn).toBe(true);
    expect(adapter.manifest.providerTypes).toEqual(['mock']);
    expect(adapter.manifest.runtimeModes).toEqual(['cli']);
    expect(adapter.manifest.configSchemaVersion).toBe(1);
  });

  it('resolves through ProviderRegistry by exact identity and by provider type', () => {
    const adapter = new MockProviderAdapter();
    const registry = new ProviderRegistry([adapter]);
    expect(registry.resolve({ adapterId: 'builtin.mock', adapterVersion: '1.0.0' })).toBe(adapter);
    expect(registry.resolve({ providerType: 'mock', adapterId: 'builtin.mock', adapterVersion: '1.0.0' })).toBe(adapter);
    expect(registry.findByType('mock')).toEqual([adapter]);
    expect(() => registry.resolve({ providerType: 'kimicode', adapterId: 'builtin.mock', adapterVersion: '1.0.0' }))
      .toThrowError(expect.objectContaining({ code: 'PROVIDER_ADAPTER_NOT_FOUND' }));
  });

  it('exposes all fourteen P57 §57.3 scenarios', () => {
    expect(MOCK_PROVIDER_SCENARIOS).toHaveLength(14);
    expect(MOCK_PROVIDER_SCENARIOS).toEqual([
      'success', 'slow-stream', 'tool-calls', 'file-changes', 'subagents', 'approval',
      'auth-required', 'rate-limit', 'non-zero-exit', 'idle-timeout', 'parse-error',
      'cancel', 'resume', 'process-crash',
    ]);
    for (const scenario of MOCK_PROVIDER_SCENARIOS) {
      expect(isMockProviderScenario(scenario)).toBe(true);
    }
    expect(isMockProviderScenario('not-a-scenario')).toBe(false);
  });
});

describe('MockProviderAdapter discover and validate', () => {
  it('discovers a simulated candidate without any filesystem probing', async () => {
    const adapter = new MockProviderAdapter();
    const result = await adapter.discover({
      providerType: 'mock',
      environment: {},
    });
    expect(result.found).toBe(true);
    expect(result.selected).toBe('mock://internal/emitter');
    expect(result.candidates).toHaveLength(1);
    expect(result.warnings.join(' ')).toMatch(/scripted/);
  });

  it('rejects discovery for non-mock provider types', async () => {
    const adapter = new MockProviderAdapter();
    const result = await adapter.discover({ providerType: 'codex', environment: {} });
    expect(result.found).toBe(false);
    expect(result.candidates).toEqual([]);
  });

  it('validates a mock configuration as authenticated without probes', async () => {
    const adapter = new MockProviderAdapter();
    const result = await adapter.validate({
      configuration: makeConfig(),
      environment: { AGENTOS_MOCK_SCENARIO: 'tool-calls' },
    });
    expect(result.valid).toBe(true);
    expect(result.authentication).toBe('not-required');
    expect(result.cliVersion).toBe('1.0.0');
    expect(result.errors).toEqual([]);
    expect(result.warnings.map(warning => warning.message).join(' ')).toMatch(/scenario: tool-calls/);
  });

  it('fills the frozen adapter version during normalization', () => {
    const adapter = new MockProviderAdapter();
    const normalized = adapter.normalizeConfiguration(makeConfig());
    expect(normalized.adapterVersion).toBe('1.0.0');
  });

  it('fails closed for wrong provider type, adapter id or disabled configuration', async () => {
    const adapter = new MockProviderAdapter();
    for (const configuration of [
      makeConfig({ providerType: 'custom-cli' }),
      makeConfig({ adapterId: 'builtin.custom-cli' }),
      makeConfig({ enabled: false }),
    ]) {
      const result = await adapter.validate({ configuration, environment: {} });
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });
});

describe('MockProviderAdapter launch plan', () => {
  it('produces an internal simulated plan that never invokes a provider executable', async () => {
    const adapter = new MockProviderAdapter({ scenario: 'tool-calls' });
    const plan = await adapter.buildLaunchPlan({
      configuration: makeConfig(),
      workspaceRoot: '/workspace',
      prompt: 'hello mock',
      environment: {},
    });
    expect(plan.executable).toBe(process.execPath);
    expect(plan.args[0]).toBe('-e');
    expect(plan.metadata.simulated).toBe(true);
    expect(plan.metadata.providerType).toBe('mock');
    expect(plan.metadata.adapterId).toBe('builtin.mock');
    expect(plan.metadata.mockScenario).toBe('tool-calls');
    expect(plan.shell).toBe(false);
    expect(plan.stdinMode).toBe('none');
  });

  it('selects the scenario from AGENTOS_MOCK_SCENARIO when not pinned', async () => {
    const adapter = new MockProviderAdapter();
    const plan = await adapter.buildLaunchPlan({
      configuration: makeConfig(),
      workspaceRoot: '/workspace',
      prompt: 'hello mock',
      environment: { AGENTOS_MOCK_SCENARIO: 'rate-limit' },
    });
    expect(plan.metadata.mockScenario).toBe('rate-limit');
  });

  it('marks cancel and idle-timeout scenarios as stalling', async () => {
    for (const scenario of ['cancel', 'idle-timeout'] as const) {
      const { plan } = await runScenario(scenario);
      expect(plan.metadata.mockStall).toBe(true);
    }
  });

  it('rejects invalid prompt or provider identity', async () => {
    const adapter = new MockProviderAdapter();
    await expect(adapter.buildLaunchPlan({
      configuration: makeConfig(),
      workspaceRoot: '/workspace',
      prompt: '   ',
      environment: {},
    })).rejects.toThrow('PROVIDER_CONFIG_INVALID');
    await expect(adapter.buildLaunchPlan({
      configuration: makeConfig({ providerType: 'codex' }),
      workspaceRoot: '/workspace',
      prompt: 'hello',
      environment: {},
    })).rejects.toThrow('PROVIDER_CONFIG_INVALID');
  });
});

describe('MockProviderAdapter §57.3 scenarios', () => {
  it('success: streams assistant text and usage, then completes', async () => {
    const { events, result } = await runScenario('success');
    expect(events.map(event => event.type)).toEqual([
      'status', 'assistant.message', 'assistant.message', 'usage', 'status',
    ]);
    expect(result.status).toBe('completed');
    expect(result.output).toContain('completed the request successfully');
  });

  it('slow-stream: uses the fixed slow delay between lines', async () => {
    const { plan, result } = await runScenario('slow-stream');
    expect(plan.metadata.mockScenario).toBe('slow-stream');
    expect(result.status).toBe('completed');
  });

  it('tool-calls: emits tool.started/tool.completed pairs with command results', async () => {
    const { events, result } = await runScenario('tool-calls');
    const toolEvents = events.filter(event => event.type.startsWith('tool.'));
    expect(toolEvents.map(event => event.type)).toEqual([
      'tool.started', 'tool.completed', 'tool.started', 'tool.completed',
    ]);
    const command = events.find(event => event.type === 'tool.completed' && event.toolName === 'run_command');
    expect(command && 'commandResult' in command ? command.commandResult : undefined)
      .toEqual({ command: 'pnpm test', exitCode: 0 });
    expect(result.status).toBe('completed');
  });

  it('file-changes: models file edits as write_file tool events', async () => {
    const { events } = await runScenario('file-changes');
    expect(events.some(event => event.type === 'tool.started' && event.toolName === 'write_file')).toBe(true);
  });

  it('subagents: reports subagent lifecycle through diagnostics', async () => {
    const { events } = await runScenario('subagents');
    const codes = events
      .filter(event => event.type === 'diagnostic')
      .map(event => (event as { code: string }).code);
    expect(codes).toContain('mock.subagent_spawned');
    expect(codes).toContain('mock.subagent_completed');
  });

  it('approval: requests and resolves an approval gate', async () => {
    const { events } = await runScenario('approval');
    const requested = events.find(event => event.type === 'approval.requested');
    const resolved = events.find(event => event.type === 'approval.resolved');
    expect(requested && 'riskLevel' in requested ? requested.riskLevel : undefined).toBe('high');
    expect(resolved && 'decision' in resolved ? resolved.decision : undefined).toBe('allow_once');
  });

  it('auth-required: fails with PROVIDER_AUTH_REQUIRED', async () => {
    const { result } = await runScenario('auth-required');
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('PROVIDER_AUTH_REQUIRED');
    expect(result.error?.phase).toBe('authentication');
    expect(result.error?.retryable).toBe(false);
  });

  it('rate-limit: fails with retryable PROVIDER_RATE_LIMITED', async () => {
    const { result } = await runScenario('rate-limit');
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('PROVIDER_RATE_LIMITED');
    expect(result.error?.retryable).toBe(true);
  });

  it('non-zero-exit: keeps partial events and fails with PROVIDER_SESSION_FAILED', async () => {
    const { events, result } = await runScenario('non-zero-exit');
    expect(events.some(event => event.type === 'assistant.message')).toBe(true);
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('PROVIDER_SESSION_FAILED');
  });

  it('idle-timeout: a killed stalled process maps to a retryable timeout error', async () => {
    const { result } = await runScenario('idle-timeout');
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('PROVIDER_NETWORK_ERROR');
    expect(result.error?.retryable).toBe(true);
  });

  it('parse-error: malformed MOCK-EVENT lines become diagnostics and fail finalize', async () => {
    const { events, result } = await runScenario('parse-error');
    expect(events.some(event => event.type === 'diagnostic' && event.code === 'adapter.mock.malformed_event')).toBe(true);
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('PROVIDER_OUTPUT_PARSE_FAILED');
    expect(result.error?.phase).toBe('output-parse');
  });

  it('cancel: a cancelled finalize stays cancelled', async () => {
    const adapter = new MockProviderAdapter({ scenario: 'cancel' });
    await adapter.buildLaunchPlan({
      configuration: makeConfig(),
      workspaceRoot: '/workspace',
      prompt: 'hello',
      environment: {},
    });
    const result = await adapter.finalize({
      exitCode: null,
      signal: 'SIGTERM',
      parsedEvents: [],
      cancelled: true,
    });
    expect(result.status).toBe('cancelled');
  });

  it('resume: resumes a prior session and completes', async () => {
    const { events, result } = await runScenario('resume');
    const starting = events.find(event => event.type === 'status');
    expect(starting && 'label' in starting ? starting.label : undefined).toBe('mock session resumed');
    expect(result.status).toBe('completed');
  });

  it('process-crash: a mid-stream signal fails with a crash error', async () => {
    const { result } = await runScenario('process-crash');
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('PROVIDER_SESSION_FAILED');
    expect(result.error?.retryable).toBe(true);
  });

  it('large-output: parses the deterministic bulk payload', async () => {
    const adapter = new MockProviderAdapter({ scenario: 'success' });
    const transcript = buildMockTranscript('success', { seed: 7, largeOutput: true });
    expect(transcript.lines.length).toBeGreaterThanOrEqual(256);
    const context = adapter.createParseContext();
    const events: ProviderNormalizedEvent[] = [];
    for (const line of transcript.lines) {
      events.push(...adapter.parseChunk(`${encodeMockTranscriptLine(line)}\n`, context).events);
    }
    const result = await adapter.finalize({
      exitCode: 0, signal: null, parsedEvents: events, stderr: '',
    });
    expect(result.status).toBe('completed');
    expect(events.filter(event => event.type === 'assistant.message').length).toBeGreaterThanOrEqual(256);
  });
});

describe('MockProviderAdapter cancel and normalizeError', () => {
  it('cancel requests a graceful stop through the process port', async () => {
    const adapter = new MockProviderAdapter({ scenario: 'cancel' });
    const accepted = await adapter.cancel({
      sessionId: 'session-1',
      processId: 'process-1',
      reason: 'user requested stop',
      stopTicketAccepted: true,
      processPort: {
        requestGraceful: async () => ({ accepted: true }),
      },
    });
    expect(accepted).toEqual({ accepted: true });
  });

  it('cancel fails closed when the stop ticket was not accepted', async () => {
    const adapter = new MockProviderAdapter({ scenario: 'cancel' });
    const rejected = await adapter.cancel({
      sessionId: 'session-1',
      processId: 'process-1',
      reason: 'user requested stop',
      stopTicketAccepted: false,
      processPort: {
        requestGraceful: async () => ({ accepted: true }),
      },
    });
    expect(rejected.accepted).toBe(false);
    expect(rejected.error?.code).toBe('PROVIDER_CANCEL_FAILED');
  });

  it('cancel reports failure when the process port rejects the stop', async () => {
    const adapter = new MockProviderAdapter({ scenario: 'cancel' });
    const rejected = await adapter.cancel({
      sessionId: 'session-1',
      processId: 'process-1',
      reason: 'user requested stop',
      stopTicketAccepted: true,
      processPort: {
        requestGraceful: async () => ({ accepted: false }),
      },
    });
    expect(rejected.accepted).toBe(false);
    expect(rejected.error?.code).toBe('PROVIDER_CANCEL_FAILED');
  });

  it('maps error text to canonical provider error codes', () => {
    const adapter = new MockProviderAdapter();
    expect(adapter.normalizeError('authentication required').code).toBe('PROVIDER_AUTH_REQUIRED');
    expect(adapter.normalizeError('token expired').code).toBe('PROVIDER_AUTH_EXPIRED');
    expect(adapter.normalizeError('rate limit 429').code).toBe('PROVIDER_RATE_LIMITED');
    expect(adapter.normalizeError('quota was exceeded').code).toBe('PROVIDER_QUOTA_EXCEEDED');
    expect(adapter.normalizeError('idle timeout exceeded').code).toBe('PROVIDER_NETWORK_ERROR');
    expect(adapter.normalizeError('process crashed').code).toBe('PROVIDER_SESSION_FAILED');
    expect(adapter.normalizeError(new Error('PROVIDER_CONFIG_INVALID')).code).toBe('PROVIDER_CONFIG_INVALID');
    expect(adapter.normalizeError(undefined).code).toBe('PROVIDER_SESSION_FAILED');
  });

  it('re-normalization preserves retryability', () => {
    const adapter = new MockProviderAdapter();
    const retryable = adapter.normalizeError('rate limit 429');
    expect(retryable.retryable).toBe(true);
    const again = adapter.normalizeError(retryable, { phase: 'runtime' });
    expect(again.retryable).toBe(true);
    expect(again.code).toBe('PROVIDER_RATE_LIMITED');
  });
});

describe('MockProviderAdapter determinism (§57.4)', () => {
  it('builds identical transcripts for identical seeds and options', () => {
    const first = buildMockTranscript('success', { seed: 42 });
    const second = buildMockTranscript('success', { seed: 42 });
    expect(first.lines.map(encodeMockTranscriptLine)).toEqual(second.lines.map(encodeMockTranscriptLine));
    expect(first.delayMs).toBe(second.delayMs);
  });

  it('honors fixed delay overrides and env delay overrides', async () => {
    expect(buildMockTranscript('slow-stream', { delayMs: 1 }).delayMs).toBe(1);
    const adapter = new MockProviderAdapter();
    const plan = await adapter.buildLaunchPlan({
      configuration: makeConfig(),
      workspaceRoot: '/workspace',
      prompt: 'hello',
      environment: { AGENTOS_MOCK_SCENARIO: 'success', AGENTOS_MOCK_DELAY_MS: '9' },
    });
    expect(plan.metadata.mockDelayMs).toBe(9);
  });
});
