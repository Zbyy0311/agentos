import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { KimiCodeProviderAdapter } from './kimiCodeAdapter.js';
import type { ProviderConfigurationInput, ProviderProcessPort } from './types.js';

const sessionFixture = readFileSync(new URL('./fixtures/kimi-session-complete.jsonl', import.meta.url), 'utf8');

function config(overrides: Partial<ProviderConfigurationInput> = {}): ProviderConfigurationInput {
  return {
    id: 'provider-kimi',
    workspaceId: 'ws-1',
    name: 'KimiCode Local',
    providerType: 'kimicode',
    adapterId: 'builtin.kimicode',
    runtimeMode: 'cli',
    executable: 'C:/tools/kimi.exe',
    argsTemplate: ['-m', 'kimi-code/kimi-for-coding', '-p'],
    model: 'kimi-code/kimi-for-coding',
    secretProfileId: 'secret-profile-1',
    workingDirectoryMode: 'worktree',
    capabilities: {
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
    },
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
    version: 7,
    ...overrides,
  };
}

function runnerFor(version: string, help = 'Usage: kimi --output-format stream-json'): (command: string, args: readonly string[], timeoutMs: number) => Promise<string> {
  return async (_command, args, _timeoutMs) => {
    if (args[0] === '--version') return version;
    if (args[0] === '--help') return help;
    if (args[0] === 'auth' && args[1] === 'status') return 'authenticated';
    return '';
  };
}

describe('KimiCodeProviderAdapter', () => {
  it('normalizes the legacy kimi input token without changing canonical adapter identity', () => {
    const adapter = new KimiCodeProviderAdapter();
    const normalized = adapter.normalizeConfiguration(config({ providerType: 'kimi' }));
    expect(normalized.providerType).toBe('kimicode');
    expect(normalized.adapterId).toBe('builtin.kimicode');
    expect(normalized.argsTemplate).not.toBe(config().argsTemplate);
  });

  it('validates direct KimiCode fixtures without emitting the forbidden generic validation error', async () => {
    const adapter = new KimiCodeProviderAdapter({ run: runnerFor('0.23.5') });
    const result = await adapter.validate({
      configuration: config(),
      environment: {},
      now: '2026-08-15T00:00:00.000Z',
      discover: async input => ({
        found: true,
        selected: input.configuredExecutable,
        candidates: [{ executable: input.configuredExecutable!, source: 'configuration', confidence: 1 }],
        warnings: [],
      }),
    });

    expect(result.valid).toBe(true);
    expect(result.executableResolved).toBe('C:/tools/kimi.exe');
    expect(result.cliVersion).toBe('0.23.5');
    expect(result.authentication).toBe('authenticated');
    expect(result.errors).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('PROVIDER_VALIDATION_FAILED');
  });

  it('distinguishes an explicitly configured inaccessible executable from no discovery candidate', async () => {
    const adapter = new KimiCodeProviderAdapter();
    const result = await adapter.validate({
      configuration: config({ executable: 'C:/missing/kimi.exe' }),
      environment: {},
      discover: async () => ({ found: false, candidates: [], warnings: [] }),
    });
    expect(result.errors).toEqual([expect.objectContaining({ code: 'PROVIDER_EXECUTABLE_NOT_ACCESSIBLE' })]);
  });

  it('builds a canonical direct launch plan with separated args and secret references only', async () => {
    const adapter = new KimiCodeProviderAdapter();
    const plan = await adapter.buildLaunchPlan({
      configuration: config(),
      workspaceRoot: 'C:/workspace/project',
      worktreePath: 'C:/workspace/project/.agentos/worktrees/run-1',
      prompt: 'Implement feature safely',
      environment: { AGENTOS_KIMICODE_CLI: 'C:/env/kimi.exe', PATH: 'C:/safe', API_KEY: 'token-value' },
    });

    expect(plan).toMatchObject({
      runtimeMode: 'cli',
      executable: 'C:/tools/kimi.exe',
      cwd: 'C:/workspace/project/.agentos/worktrees/run-1',
      shell: false,
      promptDelivery: 'argument',
      structuredOutput: 'jsonl',
      stdinMode: 'none',
      secretRefs: ['secret-profile-1'],
      redactedEnvironmentKeys: ['API_KEY'],
    });
    expect(plan.args.filter(arg => arg === '--output-format')).toHaveLength(1);
    expect(plan.args).toContain('stream-json');
    expect(plan.args).toContain('Implement feature safely');
    expect(JSON.stringify(plan)).not.toContain('token-value');
    expect(JSON.stringify(plan)).not.toContain('api-key');
  });

  it('uses canonical environment override before the legacy Kimi override when config is unset', async () => {
    const adapter = new KimiCodeProviderAdapter();
    const plan = await adapter.buildLaunchPlan({
      configuration: config({ executable: undefined, argsTemplate: [] }),
      workspaceRoot: 'C:/workspace',
      prompt: 'hello',
      environment: { AGENTOS_KIMICODE_CLI: 'C:/canonical.exe', AGENTOS_KIMI_CLI: 'C:/legacy.exe' },
    });
    expect(plan.executable).toBe('C:/canonical.exe');
  });

  it('parses golden, malformed, unknown and usage output without fabricating provider semantics', () => {
    const adapter = new KimiCodeProviderAdapter();
    const context = adapter.createParseContext();
    const first = adapter.parseChunk(sessionFixture, context);
    const done = adapter.finishParse(context);
    const types = [...first.events, ...done.events].map(event => event.type);
    expect(types).toContain('assistant.message');
    expect(types).toContain('tool.started');
    expect(types).toContain('tool.completed');
    expect(types).toContain('usage');
    expect([...first.events, ...done.events].find(event => event.type === 'usage')).toMatchObject({ provider: 'kimicode' });

    const malformed = adapter.parseChunk('{"role":"tool","tool_call_id":"missing"}\nnot-json\n', adapter.createParseContext());
    const malformedDone = adapter.finishParse(malformed.context);
    expect([...malformed.events, ...malformedDone.events]).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'adapter.unmatched_tool_result' }),
      expect.objectContaining({ code: 'adapter.invalid_json' }),
    ]));
  });

  it('maps finalize outcomes and sends cancel only through an accepted Process port ticket', async () => {
    const adapter = new KimiCodeProviderAdapter();
    const parsed = adapter.parseChunk('{"role":"assistant","content":"done"}\n', adapter.createParseContext());
    const completed = await adapter.finalize({ exitCode: 0, signal: null, parsedEvents: parsed.events });
    expect(completed.status).toBe('completed');

    const failed = await adapter.finalize({ exitCode: 1, signal: null, parsedEvents: [], stderr: 'token=secret-value' });
    expect(failed).toMatchObject({ status: 'failed', error: { code: 'PROVIDER_SESSION_FAILED' } });
    expect(JSON.stringify(failed)).not.toContain('secret-value');

    const calls: unknown[] = [];
    const processPort: ProviderProcessPort = {
      requestGraceful: async request => { calls.push(request); return { accepted: true }; },
    };
    const cancelled = await adapter.cancel({
      sessionId: 'psess_1', processId: 'proc_1', reason: 'user', stopTicketAccepted: true, processPort,
    });
    expect(cancelled).toEqual({ accepted: true });
    expect(calls).toEqual([{ processId: 'proc_1', sessionId: 'psess_1', reason: 'user' }]);
  });

  it('has no direct child_process or spawn/exec dependency in the adapter source', async () => {
    const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('./kimiCodeAdapter.ts', import.meta.url), 'utf8'));
    expect(source).not.toMatch(/child_process|\bspawn\s*\(|\bexec(?:File)?\s*\(/);
  });
});
