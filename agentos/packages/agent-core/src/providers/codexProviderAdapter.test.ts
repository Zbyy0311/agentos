import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexProviderAdapter } from './codexProviderAdapter.js';
import type { ProcessProbeResult } from '@agentos/process-runtime';
import type { ProcessProbePort, ProviderConfigurationInput, ProviderProcessPort } from './types.js';

const sessionFixture = readFileSync(new URL('../adapters/fixtures/codex-basic.jsonl', import.meta.url), 'utf8');

function config(overrides: Partial<ProviderConfigurationInput> = {}): ProviderConfigurationInput {
  return {
    id: 'provider-codex',
    workspaceId: 'ws-1',
    name: 'Codex Local',
    providerType: 'codex',
    adapterId: 'builtin.codex',
    adapterVersion: '1.0.0',
    runtimeMode: 'cli',
    executable: 'C:/tools/codex.exe',
    argsTemplate: ['exec', '--sandbox', 'workspace-write'],
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
      modelSelection: false,
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
    version: 1,
    ...overrides,
  };
}

function probeFor(version = '0.46.0', help = 'Usage: codex exec --json'): ProcessProbePort {
  return {
    probe: async (request): Promise<ProcessProbeResult> => ({
      stdout: request.args[0] === '--version' ? version : help,
      stderr: '',
      exitCode: 0,
      signal: null,
    }),
  };
}

describe('CodexProviderAdapter', () => {
  it('exposes the fixed canonical manifest and validates through the Process probe port', async () => {
    const requests: string[][] = [];
    const adapter = new CodexProviderAdapter({
      probe: {
        probe: async request => {
          requests.push([...request.args]);
          return request.args[0] === '--version'
            ? { stdout: 'codex 0.46.0', stderr: '', exitCode: 0, signal: null }
            : { stdout: 'codex exec --json', stderr: '', exitCode: 0, signal: null };
        },
      },
    });

    expect(adapter.manifest).toMatchObject({
      id: 'builtin.codex',
      version: '1.0.0',
      providerTypes: ['codex'],
      runtimeModes: ['cli'],
      builtIn: true,
    });
    const result = await adapter.validate({
      configuration: config(),
      environment: {},
      now: '2026-09-12T00:00:00.000Z',
      discover: async input => ({
        found: true,
        selected: input.configuredExecutable,
        candidates: [{ executable: input.configuredExecutable!, source: 'configuration', confidence: 1 }],
        warnings: [],
      }),
    });

    expect(result.valid).toBe(true);
    expect(result.cliVersion).toBe('0.46.0');
    expect(result.authentication).toBe('unknown');
    expect(result.warnings).toEqual([{ code: 'PROVIDER_AUTH_UNKNOWN', message: 'Codex authentication state could not be determined' }]);
    expect(result.errors).toEqual([]);
    expect(requests).toEqual([['--version'], ['exec', '--help']]);
  });

  it('discovers configuration, environment override, and PATH candidates without fallback from an inaccessible preferred binary', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentos-codex-discovery-'));
    const pathExecutable = join(root, process.platform === 'win32' ? 'codex.exe' : 'codex');
    const configuredExecutable = join(root, process.platform === 'win32' ? 'configured.exe' : 'configured');
    writeFileSync(pathExecutable, 'fixture', 'utf8');
    writeFileSync(configuredExecutable, 'fixture', 'utf8');
    try {
      const adapter = new CodexProviderAdapter();
      const base = {
        providerType: 'codex' as const,
        environment: { PATH: root, PATHEXT: process.platform === 'win32' ? '.EXE;.CMD;.BAT' : undefined },
        platform: process.platform,
        homeDirectory: root,
      };
      await expect(adapter.discover({ ...base, configuredExecutable })).resolves.toMatchObject({
        found: true,
        selected: configuredExecutable,
        candidates: expect.arrayContaining([expect.objectContaining({ source: 'configuration' })]),
      });
      await expect(adapter.discover({
        ...base,
        environment: { ...base.environment, AGENTOS_CODEX_CLI: configuredExecutable },
      })).resolves.toMatchObject({ found: true, selected: configuredExecutable });
      await expect(adapter.discover(base)).resolves.toMatchObject({ found: true, selected: pathExecutable });
      await expect(adapter.discover({ ...base, configuredExecutable: join(root, 'missing-codex') })).resolves.toMatchObject({
        found: false,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('builds the legacy exec --json launch shape with separated prompt and secret-free environment', async () => {
    const adapter = new CodexProviderAdapter();
    const plan = await adapter.buildLaunchPlan({
      configuration: config(),
      workspaceRoot: 'C:/workspace/project',
      worktreePath: 'C:/workspace/project/.agentos/worktrees/run-1',
      prompt: 'Implement feature safely',
      environment: { PATH: 'C:/safe', CODEX_HOME: 'C:/profile/.codex', API_KEY: 'secret-value' },
      environmentOverrides: { NODE_ENV: 'test' },
      secretRefs: ['secret-profile-1'],
    });

    expect(plan).toMatchObject({
      executable: 'C:/tools/codex.exe',
      cwd: 'C:/workspace/project/.agentos/worktrees/run-1',
      shell: false,
      stdinMode: 'none',
      promptDelivery: 'argument',
      structuredOutput: 'jsonl',
      secretRefs: ['secret-profile-1'],
      redactedEnvironmentKeys: ['API_KEY'],
    });
    expect(plan.args).toEqual(['exec', '--skip-git-repo-check', '--json', '--sandbox', 'workspace-write', 'Implement feature safely']);
    expect(plan.environment).toMatchObject({ PATH: 'C:/safe', CODEX_HOME: 'C:/profile/.codex', NODE_ENV: 'test' });
    expect(JSON.stringify(plan)).not.toContain('secret-value');

    const barePlan = await adapter.buildLaunchPlan({
      configuration: config({ argsTemplate: [] }),
      workspaceRoot: 'C:/workspace/project',
      prompt: 'Reply with ok',
      environment: {},
    });
    expect(barePlan.args).toEqual(['exec', '--skip-git-repo-check', '--json', 'Reply with ok']);

    const modelPlan = await adapter.buildLaunchPlan({
      configuration: config({ argsTemplate: [], model: 'gpt-5.6-luna' }),
      workspaceRoot: 'C:/workspace/project',
      prompt: 'Reply with ok',
      environment: {},
    });
    expect(modelPlan.args).toEqual(['exec', '--model', 'gpt-5.6-luna', '--skip-git-repo-check', '--json', 'Reply with ok']);
    await expect(adapter.buildLaunchPlan({
      configuration: config({ argsTemplate: [], model: 'bad model; rm -rf' }),
      workspaceRoot: 'C:/workspace/project',
      prompt: 'Reply with ok',
      environment: {},
    })).rejects.toThrow('PROVIDER_CONFIG_INVALID');
  });

  it('reuses the legacy Codex JSON parser, requires assistant output, and finalizes stable failures', async () => {
    const adapter = new CodexProviderAdapter();
    const parsed = adapter.parseChunk(sessionFixture, adapter.createParseContext());
    const types = parsed.events.map(event => event.type);
    expect(types).toEqual([
      'status', 'status', 'tool.started', 'tool.completed', 'tool.completed',
      'assistant.message', 'status', 'status', 'usage',
    ]);
    expect(parsed.events.find(event => event.type === 'assistant.message')).toEqual({
      type: 'assistant.message', text: '已检查 executor.ts', messageId: 'msg-1',
    });
    expect((await adapter.finalize({ exitCode: 0, signal: null, parsedEvents: parsed.events })).output).toBe('已检查 executor.ts');

    const malformed = adapter.parseChunk('not-json\n', adapter.createParseContext());
    const malformedResult = await adapter.finalize({ exitCode: 0, signal: null, parsedEvents: malformed.events });
    expect(malformedResult.error?.code).toBe('PROVIDER_OUTPUT_PARSE_FAILED');

    const emptyResult = await adapter.finalize({ exitCode: 0, signal: null, parsedEvents: [] });
    expect(emptyResult.error?.code).toBe('PROVIDER_OUTPUT_INVALID');
    const failedResult = await adapter.finalize({ exitCode: 1, signal: null, parsedEvents: [], stderr: 'native provider failure' });
    expect(failedResult.error?.code).toBe('PROVIDER_SESSION_FAILED');
  });

  it('cancels only after an accepted stop ticket and normalizes cancellation errors', async () => {
    const calls: unknown[] = [];
    const processPort: ProviderProcessPort = {
      requestGraceful: async request => {
        calls.push(request);
        return { accepted: true };
      },
    };
    const adapter = new CodexProviderAdapter({ probe: probeFor() });
    await expect(adapter.cancel({
      sessionId: 'session-1', processId: 'process-1', reason: 'user', stopTicketAccepted: false, processPort,
    })).resolves.toMatchObject({ accepted: false, error: { code: 'PROVIDER_CANCEL_FAILED' } });
    await expect(adapter.cancel({
      sessionId: 'session-1', processId: 'process-1', reason: 'user', stopTicketAccepted: true, processPort,
    })).resolves.toEqual({ accepted: true });
    expect(calls).toEqual([{ processId: 'process-1', sessionId: 'session-1', reason: 'user' }]);
    expect(adapter.normalizeError(new Error('login required')).code).toBe('PROVIDER_AUTH_REQUIRED');
    expect(adapter.normalizeError(new Error('codex rate limit')).code).toBe('PROVIDER_RATE_LIMITED');
  });
});
