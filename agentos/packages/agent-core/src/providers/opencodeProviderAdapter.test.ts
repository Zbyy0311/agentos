import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProcessProbePort, ProviderConfigurationInput, ProviderDiscoveryResult, ProviderProcessPort } from './types.js';
import {
  OPENCODE_ADAPTER_ID,
  OPENCODE_ADAPTER_VERSION,
  OPENCODE_DEFAULT_EXECUTABLE,
  OPENCODE_PLAIN_TEXT_MAX_CHARACTERS,
  OPENCODE_PROVIDER_TYPE,
  OpenCodeProviderAdapter,
  safeEnvironmentForOpenCode,
} from './opencodeProviderAdapter.js';

function config(overrides: Partial<ProviderConfigurationInput> = {}): ProviderConfigurationInput {
  return {
    id: 'provider-opencode',
    workspaceId: 'ws-1',
    name: 'OpenCode Local',
    providerType: 'opencode',
    adapterId: OPENCODE_ADAPTER_ID,
    adapterVersion: OPENCODE_ADAPTER_VERSION,
    runtimeMode: 'cli',
    executable: 'C:/tools/opencode.exe',
    argsTemplate: ['--pure', 'run', '--model', 'old/provider'],
    model: 'provider/model',
    secretProfileId: 'secret-profile-1',
    workingDirectoryMode: 'worktree',
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
      cancellation: false,
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
  const executable = input.configuredExecutable ?? 'C:/tools/opencode.exe';
  return {
    found: true,
    selected: executable,
    candidates: [{ executable, source: 'configuration', confidence: 1 }],
    warnings: [],
  };
}

function probeFor(requests: string[][]): ProcessProbePort {
  return {
    probe: async request => {
      requests.push([...request.args]);
      if (request.args[0] === '--version') {
        return { stdout: '1.17.11', stderr: '', exitCode: 0, signal: null };
      }
      return {
        stdout: 'Usage: opencode run [message..] --format default --dir <directory> --model <provider/model> --pure',
        stderr: '',
        exitCode: 0,
        signal: null,
      };
    },
  };
}

describe('OpenCodeProviderAdapter', () => {
  it('keeps a fixed manifest and only advertises documented low-level capabilities', () => {
    const manifest = new OpenCodeProviderAdapter().manifest;
    expect(manifest).toMatchObject({
      id: 'builtin.opencode',
      version: '1.0.0',
      providerTypes: ['opencode'],
      runtimeModes: ['cli'],
      builtIn: true,
    });
    expect(manifest.capabilities).toMatchObject({
      structuredEvents: false,
      toolEvents: false,
      usageEvents: false,
      cancellation: true,
      modelSelection: true,
      workspaceAwareness: true,
    });
  });

  it('discovers an executable without treating discovery as compatibility evidence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentos-opencode-adapter-'));
    const executable = join(root, OPENCODE_DEFAULT_EXECUTABLE);
    writeFileSync(executable, 'fixture', 'utf8');
    try {
      const result = await new OpenCodeProviderAdapter().discover({
        providerType: OPENCODE_PROVIDER_TYPE,
        configuredExecutable: executable,
        environment: {},
        platform: process.platform,
      });
      expect(result).toMatchObject({ found: true, selected: executable });
      expect(result.warnings).toContain('OpenCode executable discovery does not prove CLI compatibility or cancellation support');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('LITE-04-101: admits the qualified version using run help and constructs a bounded launch', async () => {
    const requests: string[][] = [];
    const adapter = new OpenCodeProviderAdapter({ probe: probeFor(requests) });
    const result = await adapter.validate({
      configuration: config(),
      environment: { PATH: 'C:/safe', API_KEY: 'must-not-appear' },
      workspaceRoot: 'C:/workspace',
      now: '2026-09-12T00:00:00.000Z',
      discover: async input => discovered(input),
    });

    expect(result).toMatchObject({
      valid: true,
      executableResolved: 'C:/tools/opencode.exe',
      cliVersion: '1.17.11',
      authentication: 'unknown',
      checkedAt: '2026-09-12T00:00:00.000Z',
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual(expect.arrayContaining([{ code: 'PROVIDER_AUTH_UNKNOWN', message: expect.any(String) }]));
    expect(requests).toEqual([['--version'], ['run', '--help']]);
    const plan = await adapter.buildLaunchPlan({ configuration: config(), workspaceRoot: 'C:/workspace', prompt: '--share', environment: {} });
    expect(plan.args).toEqual(['--pure', 'run', '--format', 'default', '--dir', 'C:/workspace', '--model', 'provider/model', '--', '--share']);
    expect(plan.shell).toBe(false);
    expect(JSON.stringify(result)).not.toContain('must-not-appear');
    expect(JSON.stringify(result)).not.toContain('PROVIDER_VALIDATION_FAILED');
  });

  it('fails closed when validation support is absent, so no launch plan is constructed', async () => {
    const adapter = new OpenCodeProviderAdapter();
    const result = await adapter.validate({
      configuration: config(),
      environment: {},
      now: '2026-09-12T00:00:00.000Z',
      discover: async input => discovered(input),
    });
    expect(result.valid).toBe(false);
    await expect(adapter.buildLaunchPlan({
      configuration: config(),
      workspaceRoot: 'C:/workspace',
      worktreePath: 'C:/workspace/.agentos/worktree',
      prompt: 'Review safely',
      environment: { API_KEY: 'must-not-appear' },
    })).rejects.toThrow('PROVIDER_CAPABILITY_UNAVAILABLE');
  });

  it('parses only bounded redacted assistant text and reports truncation', () => {
    const adapter = new OpenCodeProviderAdapter();
    const context = adapter.createParseContext();
    const first = adapter.parseChunk('review ', context);
    const second = adapter.parseChunk(`${'x'.repeat(OPENCODE_PLAIN_TEXT_MAX_CHARACTERS)} SECRET=hidden`, first.context);
    const events = [...first.events, ...second.events];
    const output = events
      .filter((event): event is Extract<typeof event, { type: 'assistant.message' }> => event.type === 'assistant.message')
      .map(event => event.text)
      .join('');
    expect(output.length).toBeLessThanOrEqual(OPENCODE_PLAIN_TEXT_MAX_CHARACTERS);
    expect(output).not.toContain('hidden');
    expect(events).toEqual(expect.arrayContaining([
      { type: 'diagnostic', level: 'warning', code: 'adapter.output_truncated', message: expect.any(String) },
    ]));
  });

  it('LITE-04-101: cancellation requires an accepted stop ticket and delegates owned process stopping', async () => {
    const adapter = new OpenCodeProviderAdapter();
    const parsed = adapter.parseChunk('done', adapter.createParseContext());
    await expect(adapter.finalize({ exitCode: 0, signal: null, parsedEvents: parsed.events })).resolves.toMatchObject({
      status: 'completed',
      output: 'done',
    });

    let calls = 0;
    const processPort: ProviderProcessPort = {
      requestGraceful: async () => { calls += 1; return { accepted: true }; },
    };
    const cancelled = await adapter.cancel({
      sessionId: 'session-1',
      processId: 'process-1',
      reason: 'user',
      stopTicketAccepted: true,
      processPort,
    });
    expect(cancelled).toEqual({ accepted: true });
    expect(calls).toBe(1);
    const rejected = await adapter.cancel({ sessionId: 'session-1', processId: 'process-1', reason: 'user', stopTicketAccepted: false, processPort });
    expect(rejected).toMatchObject({ accepted: false, error: { code: 'PROVIDER_CANCEL_FAILED' } });
    expect(calls).toBe(1);
  });

  it('keeps provider environment values out of the launch environment and adapter free of native spawn', () => {
    expect(safeEnvironmentForOpenCode({ PATH: 'C:/safe', API_KEY: 'must-not-appear' })).toEqual({ PATH: 'C:/safe' });
    const source = readFileSync(new URL('./opencodeProviderAdapter.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/node:child_process|\bspawn\s*\(|\bexec(?:File)?\s*\(/u);
  });
});
