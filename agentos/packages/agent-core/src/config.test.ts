import { afterEach, describe, expect, it, vi } from 'vitest';

describe('AGENT_CONFIGS', () => {
  afterEach(() => {
    delete process.env.AGENTOS_KIMI_CLI;
    delete process.env.AGENTOS_CODEX_CLI;
    delete process.env.AGENTOS_OPENCODE_CLI;
    vi.resetModules();
  });

  it('uses kimi CLI for the kimi worker by default', async () => {
    const { AGENT_CONFIGS } = await import('./config.js');

    expect(AGENT_CONFIGS.kimi_worker.cliCommand).toBe('kimi');
    expect(AGENT_CONFIGS.kimi_worker.cliArgs).toEqual(['-m', 'kimi-code/kimi-for-coding', '-p']);
  });

  it('allows overriding the kimi CLI command via env var', async () => {
    process.env.AGENTOS_KIMI_CLI = 'kimi-custom';

    const { AGENT_CONFIGS } = await import('./config.js');

    expect(AGENT_CONFIGS.kimi_worker.cliCommand).toBe('kimi-custom');
  });

  it('uses OpenCode for the reviewer by default', async () => {
    const { AGENT_CONFIGS } = await import('./config.js');

    expect(AGENT_CONFIGS.opencode_reviewer.cliCommand).toBe('opencode');
    expect(AGENT_CONFIGS.opencode_reviewer.cliArgs).toEqual([
      '--pure', 'run', '--model', 'deepseek/deepseek-v4-flash',
    ]);
  });

  it('allows an explicit Codex reviewer override', async () => {
    process.env.AGENTOS_OPENCODE_CLI = 'codex';
    const { AGENT_CONFIGS } = await import('./config.js');

    expect(AGENT_CONFIGS.opencode_reviewer.cliCommand).toBe('codex');
    expect(AGENT_CONFIGS.opencode_reviewer.cliArgs[0]).toBe('exec');
  });

  it('provides one stage-role map and workspace defaults from the core config', async () => {
    const {
      AGENT_CONFIGS,
      DEFAULT_WORKSPACE_AGENTS,
      STAGE_ROLE_MAP,
    } = await import('./config.js');

    expect(STAGE_ROLE_MAP.kimi_worker).toBe('kimi');
    expect(DEFAULT_WORKSPACE_AGENTS.find((agent) => agent.role === 'kimi')).toMatchObject({
      cliCommand: AGENT_CONFIGS.kimi_worker.cliCommand,
      cliArgs: AGENT_CONFIGS.kimi_worker.cliArgs,
      model: AGENT_CONFIGS.kimi_worker.model,
    });
  });

  it('recognizes Codex command names and executable paths', async () => {
    const { isCodexCli, isOpenCodeCli } = await import('./config.js');

    expect(isCodexCli('codex')).toBe(true);
    expect(isCodexCli('C:\\tools\\codex.exe')).toBe(true);
    expect(isCodexCli('opencode')).toBe(false);
    expect(isOpenCodeCli('opencode')).toBe(true);
    expect(isOpenCodeCli('E:\\software\\opencode\\node_modules\\opencode-ai\\bin\\opencode.exe')).toBe(true);
    expect(isOpenCodeCli('codex')).toBe(false);
  });

  it('keeps an explicit custom provider separate from the collaboration role', async () => {
    const { resolveConfiguredProvider } = await import('./config.js');
    expect(resolveConfiguredProvider({ role: 'codex_manager', cliCommand: 'node', provider: 'custom' })).toBe('custom');
    expect(resolveConfiguredProvider({ role: 'opencode_reviewer', cliCommand: 'codex' })).toBe('codex');
  });
});

describe('CLI capabilities', () => {
  it('classifies commands by executable rather than Agent role', async () => {
    const { getCliCapability } = await import('./capabilities.js');

    expect(getCliCapability('kimi')).toMatchObject({ cliKind: 'kimi', modelFlag: '-m' });
    expect(getCliCapability('opencode')).toMatchObject({ cliKind: 'opencode', modelFlag: '--model' });
    expect(getCliCapability('C:\\tools\\codex.exe').cliKind).toBe('codex');
  });

  it('only exposes verified thinking effort values', async () => {
    const { getCliCapability } = await import('./capabilities.js');

    expect(getCliCapability('kimi').thinkingEffortValues).toEqual(['auto']);
    expect(getCliCapability('unknown-agent').thinkingEffortValues).toEqual(['auto']);
    expect(getCliCapability('codex').thinkingEffortValues).toEqual(['auto', 'low', 'medium', 'high']);
  });

  it('keeps a Codex fallback on the Codex capability mapping', async () => {
    const { getAgentCapability } = await import('./capabilities.js');

    expect(getAgentCapability('opencode', 'codex', 'fallback-model')).toMatchObject({
      cliKind: 'codex',
      models: ['fallback-model'],
      thinkingEfforts: ['auto', 'low', 'medium', 'high'],
      defaultThinkingEffort: 'auto',
    });
  });

  it('exposes the configured Kimi default model when no custom value is saved', async () => {
    const { getAgentCapability } = await import('./capabilities.js');

    expect(getAgentCapability('kimi', 'kimi').models).toContain('kimi-code/kimi-for-coding');
  });
});
