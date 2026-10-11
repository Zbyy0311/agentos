import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProviderRegistry } from './registry.js';
import type { ProcessProbePort, ProviderConfigurationInput, ProviderDiscoveryResult, ProviderProcessPort } from './types.js';
import {
  CUSTOM_CLI_ADAPTER_ID,
  CUSTOM_CLI_ADAPTER_VERSION,
  CUSTOM_CLI_PROVIDER_TYPE,
  CustomCliAdapter,
  expandArgsTemplate,
} from './customCliAdapter.js';

function config(overrides: Partial<ProviderConfigurationInput> = {}): ProviderConfigurationInput {
  return {
    id: 'provider-custom-cli',
    workspaceId: 'ws-1',
    name: 'Custom CLI Local',
    providerType: 'custom-cli',
    adapterId: CUSTOM_CLI_ADAPTER_ID,
    runtimeMode: 'cli',
    executable: 'C:/tools/acme.exe',
    argsTemplate: ['run', '{{model}}', '{{prompt}}'],
    model: 'acme/model',
    secretProfileId: 'secret-profile-1',
    workingDirectoryMode: 'workspace',
    capabilities: {
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
    outputMode: 'parsed-text',
    enabled: true,
    version: 1,
    ...overrides,
  };
}

function discovered(input: { configuredExecutable?: string }): ProviderDiscoveryResult {
  const executable = input.configuredExecutable ?? 'C:/tools/acme.exe';
  return {
    found: true,
    selected: executable,
    candidates: [{ executable, source: 'configuration', confidence: 1 }],
    warnings: [],
  };
}

function probeFor(handler: (args: readonly string[]) => { stdout: string; stderr: string; exitCode: number | null; signal: string | null }): ProcessProbePort {
  return { probe: async request => handler(request.args) };
}

describe('CustomCliAdapter', () => {
  it('keeps a fixed manifest and only advertises conservative passthrough capabilities', () => {
    const manifest = new CustomCliAdapter().manifest;
    expect(manifest).toMatchObject({
      id: 'builtin.custom-cli',
      version: '1.0.0',
      providerTypes: ['custom-cli'],
      runtimeModes: ['cli'],
      builtIn: true,
      configSchemaVersion: 1,
    });
    expect(manifest.capabilities).toMatchObject({
      structuredEvents: false,
      nativeApprovals: false,
      subagents: false,
      toolEvents: false,
      fileEvents: false,
      usageEvents: false,
      interactiveInput: false,
      sessionResume: false,
      cancellation: true,
      modelSelection: true,
    });
  });

  it('resolves the exact builtin.custom-cli adapter from a registry', () => {
    const adapter = new CustomCliAdapter();
    const registry = new ProviderRegistry([adapter]);
    expect(registry.resolve({ adapterId: 'builtin.custom-cli', adapterVersion: adapter.manifest.version })).toBe(adapter);
    expect(registry.resolve({ providerType: 'custom-cli', adapterId: 'builtin.custom-cli', adapterVersion: adapter.manifest.version })).toBe(adapter);
    expect(registry.findByType('custom-cli')).toEqual([adapter]);
  });

  it('discovers a configured executable by existence, without compatibility evidence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentos-custom-cli-adapter-'));
    const executable = join(root, process.platform === 'win32' ? 'acme.cmd' : 'acme');
    writeFileSync(executable, 'fixture', 'utf8');
    try {
      const result = await new CustomCliAdapter().discover({
        providerType: CUSTOM_CLI_PROVIDER_TYPE,
        configuredExecutable: executable,
        environment: {},
        platform: process.platform,
      });
      expect(result).toMatchObject({ found: true, selected: executable });
      expect(result.warnings).toContain('Custom CLI executable discovery does not prove CLI compatibility');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('discovers a bare command name through PATH', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentos-custom-cli-path-'));
    const binDir = join(root, 'bin');
    mkdirSync(binDir);
    const name = process.platform === 'win32' ? 'acme.cmd' : 'acme';
    writeFileSync(join(binDir, name), 'fixture', 'utf8');
    try {
      const result = await new CustomCliAdapter().discover({
        providerType: CUSTOM_CLI_PROVIDER_TYPE,
        configuredExecutable: 'acme',
        environment: { PATH: binDir, PATHEXT: '.EXE;.CMD;.BAT' },
        platform: process.platform,
      });
      expect(result.found).toBe(true);
      expect(result.selected).toBe(join(binDir, name));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports not-found when the configured executable does not exist anywhere', async () => {
    const result = await new CustomCliAdapter().discover({
      providerType: CUSTOM_CLI_PROVIDER_TYPE,
      configuredExecutable: 'definitely-not-a-real-agentos-binary-xyz',
      environment: {},
      platform: process.platform,
    });
    expect(result.found).toBe(false);
    expect(result.selected).toBeUndefined();
  });

  it('validates with probe output, and degrades unparseable --version to a warning', async () => {
    const requests: string[][] = [];
    const adapter = new CustomCliAdapter({
      probe: {
        probe: async request => {
          requests.push([...request.args]);
          if (request.args[0] === '--version') return { stdout: 'acme-cli experimental build', stderr: '', exitCode: 0, signal: null };
          return { stdout: 'Usage: acme [options]', stderr: '', exitCode: 0, signal: null };
        },
      },
    });
    const result = await adapter.validate({
      configuration: config(),
      environment: { PATH: 'C:/safe', API_KEY: 'must-not-appear' },
      workspaceRoot: 'C:/workspace',
      now: '2026-10-11T00:00:00.000Z',
      discover: async input => discovered(input),
    });
    expect(result.valid).toBe(true);
    expect(result.cliVersion).toBeUndefined();
    expect(result.errors).toEqual([]);
    expect(result.authentication).toBe('unknown');
    expect(result.checkedAt).toBe('2026-10-11T00:00:00.000Z');
    expect(requests).toEqual([['--version'], ['--help']]);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PROVIDER_VERSION_UNKNOWN' }),
      expect.objectContaining({ code: 'PROVIDER_AUTH_UNKNOWN' }),
    ]));
    expect(JSON.stringify(result)).not.toContain('must-not-appear');
  });

  it('degrades --version/--help probe failures to warnings instead of validation errors', async () => {
    const adapter = new CustomCliAdapter({
      probe: {
        probe: async request => ({
          stdout: '',
          stderr: '',
          exitCode: null,
          signal: null,
          errorCode: request.args[0] === '--version' ? 'PROCESS_STARTUP_TIMEOUT' : 'PROCESS_UNKNOWN_ERROR',
        }),
      },
    });
    const result = await adapter.validate({
      configuration: config(),
      environment: {},
      workspaceRoot: 'C:/workspace',
      discover: async input => discovered(input),
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings.some(warning => warning.code === 'PROVIDER_INTERNAL_ERROR')).toBe(true);
  });

  it('fails validation when the executable is not accessible', async () => {
    const adapter = new CustomCliAdapter({
      probe: { probe: async () => ({ stdout: '', stderr: '', exitCode: 0, signal: null }) },
    });
    const result = await adapter.validate({
      configuration: config({ executable: 'C:/missing/acme.exe' }),
      environment: {},
      workspaceRoot: 'C:/workspace',
      discover: async input => ({
        found: false,
        candidates: input.configuredExecutable ? [{ executable: input.configuredExecutable, source: 'configuration', confidence: 1 }] : [],
        warnings: [],
      }),
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PROVIDER_EXECUTABLE_NOT_ACCESSIBLE', phase: 'discovery' }),
    ]));
  });

  it('rejects capabilities the adapter does not verify', async () => {
    const adapter = new CustomCliAdapter();
    const base = config();
    const result = await adapter.validate({
      configuration: { ...base, capabilities: { ...base.capabilities, structuredEvents: true } },
      environment: {},
      workspaceRoot: 'C:/workspace',
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PROVIDER_CAPABILITY_UNAVAILABLE', message: expect.stringContaining('structuredEvents') }),
    ]));
  });

  it('rejects structured output mode and unsupported promptDelivery at validation time', async () => {
    const adapter = new CustomCliAdapter();
    const structured = await adapter.validate({
      configuration: config({ outputMode: 'structured' }),
      environment: {},
      workspaceRoot: 'C:/workspace',
    });
    expect(structured.valid).toBe(false);
    expect(structured.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PROVIDER_CAPABILITY_UNAVAILABLE' }),
    ]));

    const stdinDelivery = await adapter.validate({
      configuration: config({ promptDelivery: 'stdin' }),
      environment: {},
      workspaceRoot: 'C:/workspace',
    });
    expect(stdinDelivery.valid).toBe(false);
    expect(stdinDelivery.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PROVIDER_CAPABILITY_UNAVAILABLE', message: expect.stringContaining('promptDelivery') }),
    ]));
  });

  it('warns about unresolved template variables while keeping them verbatim', async () => {
    const adapter = new CustomCliAdapter();
    const result = await adapter.validate({
      configuration: config({ argsTemplate: ['run', '{{model}}', '{{taskId}}'] }),
      environment: {},
      workspaceRoot: 'C:/workspace',
      discover: async input => discovered(input),
      probe: probeFor(() => ({ stdout: '1.2.3', stderr: '', exitCode: 0, signal: null })),
    });
    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PROVIDER_TEMPLATE_VARIABLE_UNRESOLVED', message: expect.stringContaining('{{taskId}}') }),
    ]));
  });

  it('expands template variables and defaults successExitCodes to [0]', async () => {
    const adapter = new CustomCliAdapter();
    const plan = await adapter.buildLaunchPlan({
      configuration: config({ argsTemplate: ['run', '--model', '{{model}}', '--cwd', '{{workingDirectory}}', '{{prompt}}'] }),
      workspaceRoot: 'C:/workspace',
      prompt: 'do the thing',
      environment: { PATH: 'C:/safe', API_KEY: 'must-not-appear' },
    });
    expect(plan).toMatchObject({
      runtimeMode: 'cli',
      executable: 'C:/tools/acme.exe',
      cwd: 'C:/workspace',
      stdinMode: 'none',
      promptDelivery: 'argument',
      structuredOutput: 'text',
      shell: false,
    });
    expect(plan.args).toEqual(['run', '--model', 'acme/model', '--cwd', 'C:/workspace', 'do the thing']);
    expect(plan.redactedEnvironmentKeys).toEqual(['API_KEY']);
    expect(plan.secretRefs).toEqual(['secret-profile-1']);
    expect(plan.environment.API_KEY).toBeUndefined();
    expect(JSON.stringify(plan)).not.toContain('must-not-appear');
  });

  it('appends the prompt as a final argument when the template has no {{prompt}} placeholder', async () => {
    const adapter = new CustomCliAdapter();
    const plan = await adapter.buildLaunchPlan({
      configuration: config({ argsTemplate: ['run', '{{model}}'] }),
      workspaceRoot: 'C:/workspace',
      prompt: 'hello',
      environment: {},
    });
    expect(plan.args).toEqual(['run', 'acme/model', 'hello']);
  });

  it('expands known variables and preserves unknown ones verbatim', () => {
    expect(expandArgsTemplate(
      ['--m', '{{model}}', '{{workingDirectory}}', '{{taskId}}'],
      { prompt: 'p', model: 'm1', workingDirectory: 'D:/wd' },
    )).toEqual(['--m', 'm1', 'D:/wd', '{{taskId}}', 'p']);
    expect(expandArgsTemplate(
      ['{{prompt}}'],
      { prompt: 'p', workingDirectory: 'D:/wd' },
    )).toEqual(['p']);
  });

  it('rejects stdin and file prompt delivery at launch plan build time', async () => {
    const adapter = new CustomCliAdapter();
    for (const promptDelivery of ['stdin', 'file'] as const) {
      await expect(adapter.buildLaunchPlan({
        configuration: config({ promptDelivery }),
        workspaceRoot: 'C:/workspace',
        prompt: 'hello',
        environment: {},
      })).rejects.toThrow(/PROMPT_DELIVERY_UNSUPPORTED/);
    }
  });

  it('maps PROMPT_DELIVERY_UNSUPPORTED launch failures to capability errors', () => {
    const adapter = new CustomCliAdapter();
    const error = adapter.normalizeError(new Error("PROMPT_DELIVERY_UNSUPPORTED: got 'stdin'"), { phase: 'startup' });
    expect(error).toEqual(expect.objectContaining({
      code: 'PROVIDER_CAPABILITY_UNAVAILABLE',
      phase: 'startup',
      retryable: false,
    }));
  });

  it('honors configured successExitCodes when finalizing', async () => {
    const adapter = new CustomCliAdapter();
    const events = [{ type: 'assistant.message' as const, text: 'partial' }];
    await adapter.buildLaunchPlan({
      configuration: config({ successExitCodes: [0, 2], argsTemplate: ['{{prompt}}'] }),
      workspaceRoot: 'C:/workspace',
      prompt: 'hello',
      environment: {},
    });
    const success = await adapter.finalize({ exitCode: 2, signal: null, parsedEvents: events });
    expect(success).toEqual({ status: 'completed', events, output: 'partial' });

    const failure = await adapter.finalize({ exitCode: 1, signal: null, parsedEvents: events, stderr: 'boom' });
    expect(failure.status).toBe('failed');
    expect(failure.error?.code).toBe('PROVIDER_SESSION_FAILED');
  });

  it('finalizes default exit code 0 as success and no output as invalid', async () => {
    const adapter = new CustomCliAdapter();
    await adapter.buildLaunchPlan({
      configuration: config({ argsTemplate: ['{{prompt}}'] }),
      workspaceRoot: 'C:/workspace',
      prompt: 'hello',
      environment: {},
    });
    const ok = await adapter.finalize({ exitCode: 0, signal: null, parsedEvents: [{ type: 'assistant.message', text: 'done' }] });
    expect(ok).toEqual({ status: 'completed', events: [{ type: 'assistant.message', text: 'done' }], output: 'done' });

    const empty = await adapter.finalize({ exitCode: 0, signal: null, parsedEvents: [] });
    expect(empty.status).toBe('failed');
    expect(empty.error?.code).toBe('PROVIDER_OUTPUT_INVALID');
  });

  it('parses chunks into line-delimited assistant text events', () => {
    const adapter = new CustomCliAdapter();
    const first = adapter.parseChunk('line one\nline ');
    expect(first.events).toEqual([{ type: 'assistant.message', text: 'line one' }]);
    const second = adapter.parseChunk('two\nline three\n', first.context);
    expect(second.events).toEqual([{ type: 'assistant.message', text: 'line two' }, { type: 'assistant.message', text: 'line three' }]);
    const finished = adapter.finishParse(second.context);
    expect(finished.events).toEqual([]);
  });

  it('flushes a trailing partial line on finishParse', () => {
    const adapter = new CustomCliAdapter();
    const context = adapter.parseChunk('tail', {}).context;
    expect(adapter.finishParse(context).events).toEqual([{ type: 'assistant.message', text: 'tail' }]);
  });

  it('normalizes unknown errors idempotently and maps common patterns', () => {
    const adapter = new CustomCliAdapter();
    const normalized = adapter.normalizeError(new Error('connect ETIMEDOUT'), { phase: 'runtime' });
    expect(normalized).toEqual(expect.objectContaining({ code: 'PROVIDER_NETWORK_ERROR', retryable: true }));
    const again = adapter.normalizeError(normalized, { phase: 'runtime' });
    expect(again).toEqual(expect.objectContaining({ code: 'PROVIDER_NETWORK_ERROR', retryable: true }));
    expect(adapter.normalizeError(new Error('ENOENT: no such file'))).toEqual(expect.objectContaining({
      code: 'PROVIDER_EXECUTABLE_NOT_ACCESSIBLE',
      phase: 'discovery',
    }));
    expect(adapter.normalizeError(new Error('unexpected'))).toEqual(expect.objectContaining({ code: 'PROVIDER_INTERNAL_ERROR' }));
  });

  it('requests graceful cancellation only after a stop ticket is accepted', async () => {
    const adapter = new CustomCliAdapter();
    const rejected = await adapter.cancel({
      sessionId: 's1', processId: 'p1', reason: 'test', stopTicketAccepted: false,
      processPort: {} as ProviderProcessPort,
    });
    expect(rejected).toEqual(expect.objectContaining({ accepted: false }));
    expect(rejected.error?.code).toBe('PROVIDER_CANCEL_FAILED');

    let gracefulRequest: { processId: string; sessionId: string; reason: string } | undefined;
    const accepted = await adapter.cancel({
      sessionId: 's1', processId: 'p1', reason: 'test', stopTicketAccepted: true,
      processPort: { requestGraceful: async input => { gracefulRequest = input; return { accepted: true }; } },
    });
    expect(accepted).toEqual({ accepted: true });
    expect(gracefulRequest).toEqual({ processId: 'p1', sessionId: 's1', reason: 'test' });
  });

  it('freezes the adapter identity for configurations persisted without an adapterVersion', async () => {
    const adapter = new CustomCliAdapter();
    const legacy = config({ adapterVersion: undefined });
    const normalized = adapter.normalizeConfiguration(legacy);
    expect(normalized.adapterVersion).toBe(CUSTOM_CLI_ADAPTER_VERSION);
    const result = await adapter.validate({
      configuration: legacy,
      environment: {},
      workspaceRoot: 'C:/workspace',
      discover: async input => discovered(input),
      probe: probeFor(() => ({ stdout: '1.2.3', stderr: '', exitCode: 0, signal: null })),
    });
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });
});
