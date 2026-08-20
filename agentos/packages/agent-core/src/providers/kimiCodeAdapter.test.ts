import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KimiCodeProviderAdapter } from './kimiCodeAdapter.js';
import type { ProcessProbeResult } from '@agentos/process-runtime';
import type { ProcessProbePort, ProviderConfigurationInput, ProviderProcessPort } from './types.js';

const sessionFixture = readFileSync(new URL('./fixtures/kimi-session-complete.jsonl', import.meta.url), 'utf8');

function config(overrides: Partial<ProviderConfigurationInput> = {}): ProviderConfigurationInput {
  return {
    id: 'provider-kimi',
    workspaceId: 'ws-1',
    name: 'KimiCode Local',
    providerType: 'kimicode',
    adapterId: 'builtin.kimicode',
    adapterVersion: '1.0.0',
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

interface AuthProbeFixture {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number | null;
  readonly errorCode?: ProcessProbeResult['errorCode'];
}

const AUTH_OK_JSONL = '{"type":"assistant","role":"assistant","content":"ok"}';

function probeFor(version: string, help = 'Usage: kimi --output-format stream-json', auth: AuthProbeFixture = {}): ProcessProbePort {
  return {
    probe: async request => {
      if (request.args[0] === '--version') return { stdout: version, stderr: '', exitCode: 0, signal: null };
      if (request.args[0] === '--help') return { stdout: help, stderr: '', exitCode: 0, signal: null };
      return {
        stdout: auth.stdout ?? AUTH_OK_JSONL,
        stderr: auth.stderr ?? '',
        exitCode: auth.exitCode ?? 0,
        signal: null,
        ...(auth.errorCode === undefined ? {} : { errorCode: auth.errorCode }),
      };
    },
  };
}

describe('KimiCodeProviderAdapter', () => {
  it('normalizes the legacy kimi input token without changing canonical adapter identity', () => {
    const adapter = new KimiCodeProviderAdapter();
    const input = config({ providerType: 'kimi' });
    const originalArgs = input.argsTemplate;
    const normalized = adapter.normalizeConfiguration(input);
    expect(normalized.providerType).toBe('kimicode');
    expect(normalized.adapterId).toBe('builtin.kimicode');
    expect(normalized.argsTemplate).not.toBe(originalArgs);

    const compatibility = adapter.normalizeConfiguration(config({ adapterVersion: undefined }));
    expect(compatibility.adapterVersion).toBe('1.0.0');
  });

  it('validates direct KimiCode fixtures without emitting the forbidden generic validation error', async () => {
    const adapter = new KimiCodeProviderAdapter({ probe: probeFor('0.23.5') });
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

  it('routes version, help, and auth probes through the injected Process Runtime port', async () => {
    const requests: string[][] = [];
    const adapter = new KimiCodeProviderAdapter({
      probe: {
        probe: async request => {
          requests.push([...request.args]);
          return { stdout: request.args[0] === '--version' ? '0.23.5' : request.args[0] === '--help' ? '--output-format stream-json' : AUTH_OK_JSONL, stderr: '', exitCode: 0, signal: null };
        },
      },
    });
    const result = await adapter.validate({
      configuration: config(),
      environment: {},
      discover: async input => ({ found: true, selected: input.configuredExecutable, candidates: [], warnings: [] }),
    });
    expect(result.valid).toBe(true);
    expect(requests).toEqual([
      ['--version'],
      ['--help'],
      ['-p', expect.any(String), '--output-format', 'stream-json'],
    ]);
    expect(String(requests[2]![1]).length).toBeGreaterThan(0);
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

  it('sanitizes discovery warning text before returning validation evidence', async () => {
    const adapter = new KimiCodeProviderAdapter();
    const result = await adapter.validate({
      configuration: config(),
      environment: {},
      discover: async input => ({
        found: false,
        candidates: [],
        warnings: [`token=secret-value for ${input.configuredExecutable}`],
      }),
    });
    expect(result.warnings).toEqual([{ code: 'PROVIDER_DISCOVERY_WARNING', message: 'Provider discovery warning' }]);
    expect(JSON.stringify(result)).not.toContain('secret-value');
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

  it('freezes an absent persisted Kimi version to the manifest compatibility version', async () => {
    const adapter = new KimiCodeProviderAdapter();
    const plan = await adapter.buildLaunchPlan({
      configuration: config({ adapterVersion: undefined }),
      workspaceRoot: 'C:/workspace',
      prompt: 'hello',
    });
    expect(plan.metadata.adapterVersion).toBe('1.0.0');
  });

  it('refuses to build an execution plan for an unfreezable missing-version adapter', async () => {
    const adapter = new KimiCodeProviderAdapter();
    await expect(adapter.buildLaunchPlan({
      configuration: config({ providerType: 'custom-cli', adapterId: 'builtin.custom-cli', adapterVersion: undefined }),
      workspaceRoot: 'C:/workspace',
      prompt: 'hello',
    })).rejects.toThrow('PROVIDER_CONFIG_INVALID');
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

  it('does not fall back to another executable when a configured binary is inaccessible', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentos-kimicode-discovery-'));
    const pathExecutable = join(root, process.platform === 'win32' ? 'kimi.exe' : 'kimi');
    writeFileSync(pathExecutable, 'fixture', 'utf8');
    try {
      const result = await new KimiCodeProviderAdapter().discover({
        providerType: 'kimicode',
        configuredExecutable: join(root, 'missing-kimi'),
        environment: { PATH: root, PATHEXT: process.platform === 'win32' ? '.EXE;.CMD;.BAT' : undefined },
        platform: process.platform,
        homeDirectory: root,
      });
      expect(result.found).toBe(false);
      expect(result.selected).toBeUndefined();
      expect(result.candidates.some(candidate => candidate.executable === pathExecutable)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('marks authentication authenticated from a successful structured assistant response', async () => {
    const adapter = new KimiCodeProviderAdapter({ probe: probeFor('0.23.5') });
    const result = await adapter.validate({
      configuration: config(),
      environment: {},
      discover: async input => ({
        found: true,
        selected: input.configuredExecutable,
        candidates: [{ executable: input.configuredExecutable!, source: 'configuration', confidence: 1 }],
        warnings: [],
      }),
    });
    expect(result.authentication).toBe('authenticated');
    expect(result.errors).toEqual([]);
    expect(result.warnings.some(warning => warning.code === 'PROVIDER_AUTH_UNKNOWN')).toBe(false);
  });

  it('marks authentication unauthenticated on explicit login-required evidence', async () => {
    const adapter = new KimiCodeProviderAdapter({
      probe: probeFor('0.23.5', '--output-format stream-json', {
        stdout: '',
        stderr: 'error: failed to run prompt: No model configured. Run `kimi` and use /login to sign in, then retry.',
        exitCode: 1,
      }),
    });
    const result = await adapter.validate({
      configuration: config(),
      environment: {},
      discover: async input => ({
        found: true,
        selected: input.configuredExecutable,
        candidates: [{ executable: input.configuredExecutable!, source: 'configuration', confidence: 1 }],
        warnings: [],
      }),
    });
    expect(result.authentication).toBe('unauthenticated');
    expect(result.errors.map(error => error.code)).toContain('PROVIDER_AUTH_REQUIRED');
    expect(result.warnings.some(warning => warning.code === 'PROVIDER_AUTH_UNKNOWN')).toBe(false);
  });

  it('fails closed to unknown for timeout, spawn, unrelated and malformed auth evidence', async () => {
    const cases: AuthProbeFixture[] = [
      { errorCode: 'PROCESS_STARTUP_TIMEOUT' },
      { errorCode: 'PROCESS_EXECUTABLE_NOT_ACCESSIBLE' },
      { stderr: 'boom', exitCode: 1 },
      { stdout: 'not-json' },
    ];
    for (const fixture of cases) {
      const adapter = new KimiCodeProviderAdapter({ probe: probeFor('0.23.5', '--output-format stream-json', fixture) });
      const result = await adapter.validate({
        configuration: config(),
        environment: {},
        discover: async input => ({
          found: true,
          selected: input.configuredExecutable,
          candidates: [{ executable: input.configuredExecutable!, source: 'configuration', confidence: 1 }],
          warnings: [],
        }),
      });
      expect(result.authentication).toBe('unknown');
      expect(result.warnings.some(warning => warning.code === 'PROVIDER_AUTH_UNKNOWN')).toBe(true);
    }
  });

  it('no longer probes the stale auth status command', async () => {
    const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('./kimiCodeAdapter.ts', import.meta.url), 'utf8'));
    expect(source).not.toContain("'auth'");
    expect(source).not.toContain('auth status');
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

  it('keeps precise auth-required, auth-expired, and generic session classifications', async () => {
    const adapter = new KimiCodeProviderAdapter();
    const parsedEvents = adapter.parseChunk('{"role":"assistant","content":"done"}\n', adapter.createParseContext()).events;
    const required = await adapter.finalize({ exitCode: 1, signal: null, parsedEvents, stderr: 'login required' });
    const expired = await adapter.finalize({ exitCode: 1, signal: null, parsedEvents, stderr: 'OAuth token expired' });
    const generic = await adapter.finalize({ exitCode: 1, signal: null, parsedEvents, stderr: 'native provider failure' });
    expect(required.error?.code).toBe('PROVIDER_AUTH_REQUIRED');
    expect(expired.error?.code).toBe('PROVIDER_AUTH_EXPIRED');
    expect(generic.error?.code).toBe('PROVIDER_SESSION_FAILED');
  });

  it('has no direct child_process or spawn/exec dependency in the adapter source', async () => {
    const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('./kimiCodeAdapter.ts', import.meta.url), 'utf8'));
    expect(source).not.toMatch(/child_process|\bspawn\s*\(|\bexec(?:File)?\s*\(/);
  });
});
