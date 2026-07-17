import { afterEach, describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { CLIExecutor, CLIError, createCommandInvocation, getInactivityTimeoutMs, getMaxExecutionTimeoutMs, prepareKimiCodeHome, resolveAgentEnvironment, resolveAgentRuntimeConfig, resolveKimiCliArgs, safeCleanup } from './executor.js';
import type { AgentConfig } from './types.js';
import type { RunFileChange } from '@agentos/shared';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Ensure FORCE_MOCK is off for these tests unless explicitly toggled
process.env.AGENTOS_FORCE_MOCK = 'false';
const originalAgentTimeout = process.env.AGENTOS_AGENT_TIMEOUT;
const originalMaxExecutionTimeout = process.env.AGENTOS_MAX_EXECUTION_MS;

describe('resolveAgentRuntimeConfig', () => {
  it('replaces the Kimi model without mutating the source args', () => {
    const sourceArgs = ['-m', 'old-model', '-p'];
    const resolved = resolveAgentRuntimeConfig({
      role: 'kimi_worker', cliCommand: 'kimi', cliArgs: sourceArgs, model: 'new-model', thinkingEffort: 'auto',
    }, {});

    expect(resolved.cliArgs).toEqual(['-m', 'new-model', '-p']);
    expect(sourceArgs).toEqual(['-m', 'old-model', '-p']);
  });

  it('uses KIMI_MODEL_NAME and removes the model flag in API Key mode', () => {
    const resolved = resolveAgentRuntimeConfig({
      role: 'kimi_worker', cliCommand: 'kimi', cliArgs: ['-m', 'old-model', '-p'], model: 'api-model', thinkingEffort: 'auto',
    }, { AGENTOS_KIMI_API_KEY: 'test-key' });

    expect(resolved.cliArgs).toEqual(['-p']);
    expect(resolved.env.KIMI_MODEL_NAME).toBe('api-model');
    expect(resolved.env.AGENTOS_KIMI_API_KEY).toBe('test-key');
  });

  it('replaces the OpenCode model flag when the command is OpenCode', () => {
    const resolved = resolveAgentRuntimeConfig({
      role: 'opencode_reviewer', cliCommand: 'opencode', cliArgs: ['--pure', 'run', '--model', 'old-model'], model: 'new-model', thinkingEffort: 'auto',
    }, {});

    expect(resolved.cliArgs).toEqual(['--pure', 'run', '--model', 'new-model']);
  });

  it('uses Codex flags when the reviewer falls back to Codex', () => {
    const resolved = resolveAgentRuntimeConfig({
      role: 'opencode_reviewer', cliCommand: 'codex', cliArgs: ['exec'], model: 'new-model', thinkingEffort: 'auto',
    }, {});

    expect(resolved.cliKind).toBe('codex');
    expect(resolved.cliArgs).toEqual(['exec', '-m', 'new-model']);
  });

  it('maps Codex thinking effort to its config override', () => {
    const resolved = resolveAgentRuntimeConfig({
      role: 'codex_manager', cliCommand: 'codex', cliArgs: ['exec'], model: 'gpt-5.3-codex', thinkingEffort: 'high',
    }, {});

    expect(resolved.cliArgs).toEqual([
      'exec', '-m', 'gpt-5.3-codex', '-c', 'model_reasoning_effort=high',
    ]);
  });

  it('rejects unsupported thinking effort values', () => {
    expect(() => resolveAgentRuntimeConfig({
      role: 'kimi_worker', cliCommand: 'kimi', cliArgs: ['-p'], model: 'new-model', thinkingEffort: 'high',
    }, {})).toThrow('does not support thinking effort "high"');
  });
});

describe('CLIExecutor', () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'agentos-test-'));
  });

  afterEach(() => {
    delete process.env.KIMI_CODE_HOME;
    delete process.env.AGENTOS_KIMI_CODE_HOME;
    if (originalAgentTimeout === undefined) delete process.env.AGENTOS_AGENT_TIMEOUT;
    else process.env.AGENTOS_AGENT_TIMEOUT = originalAgentTimeout;
    if (originalMaxExecutionTimeout === undefined) delete process.env.AGENTOS_MAX_EXECUTION_MS;
    else process.env.AGENTOS_MAX_EXECUTION_MS = originalMaxExecutionTimeout;
    try { rmSync(workspaceRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows Git reparse-point cleanup is best effort. */ }
  });

  const ctx = (taskId = 'test-task') => ({
    workspaceRoot,
    taskId,
  });

  const okConfig: AgentConfig = {
    name: 'TestAgent',
    role: 'codex_manager',
    cliCommand: 'node',
    cliArgs: ['-e', 'console.log("ok")'],
  };

  const failConfig: AgentConfig = {
    name: 'TestAgent',
    role: 'codex_manager',
    cliCommand: 'node',
    cliArgs: ['-e', 'process.exit(1)'],
  };

  const missingConfig: AgentConfig = {
    name: 'TestAgent',
    role: 'codex_manager',
    cliCommand: 'definitely-fake-command-12345',
    cliArgs: [],
  };

  it('returns real mode for successful command', async () => {
    const log = await CLIExecutor.execute(okConfig, 'ignored', ctx());
    expect(log.exitCode).toBe(0);
    expect(log.mode).toBe('real');
    expect(log.stdout).toContain('ok');
  });

  it('decodes a structured Codex spawn stream without persisting raw JSONL', async () => {
    const commandRoot = mkdtempSync(join(tmpdir(), 'agentos-structured-codex-'));
    const commandPath = join(commandRoot, 'codex.cmd');
    const scriptPath = join(commandRoot, 'fake-codex.mjs');
    writeFileSync(commandPath, '@echo off\r\nnode "%~dp0fake-codex.mjs" %*\r\nexit /b %ERRORLEVEL%\r\n', 'utf8');
    writeFileSync(scriptPath, [
      "const args = process.argv.slice(2);",
      "if (args.includes('--version')) { console.log('codex 0.0.0'); }",
      "else if (args.includes('--help')) { console.log('Usage: codex exec --json'); }",
      "else {",
      "  const lines = [JSON.stringify({type:'thread.started'}), JSON.stringify({type:'item.started',item:{id:'cmd-1',type:'command_execution',command:'echo evidence'}}), JSON.stringify({type:'item.completed',item:{id:'cmd-1',type:'command_execution',status:'completed',exit_code:0}}), JSON.stringify({type:'item.completed',item:{id:'msg-1',type:'agent_message',text:'结构化回复'}}), JSON.stringify({type:'turn.completed',usage:{output_tokens:2}})];",
      "  process.stdout.write(lines[0] + '\\n'); setTimeout(() => process.stdout.write(lines[1] + '\\n' + lines[2] + '\\n'), 10); setTimeout(() => { process.stdout.write(lines[3] + '\\n' + lines[4] + '\\n'); }, 20);",
      "}",
    ].join('\n'), 'utf8');

    try {
      const runtimeEvents: string[] = [];
      const chunks: Array<{ text: string; done: boolean }> = [];
      const log = await CLIExecutor.execute({
        name: 'Fake Codex', role: 'codex_manager', cliCommand: commandPath, cliArgs: ['exec'],
      }, 'structured prompt', {
        ...ctx('structured-codex'),
        onRuntimeEvent: event => runtimeEvents.push(event.type),
        onChunk: (text, done) => chunks.push({ text, done }),
      });

      expect(log.stdout).toBe('结构化回复');
      expect(log.stdout).not.toContain('item.completed');
      expect(runtimeEvents).toEqual(['status', 'tool.started', 'tool.completed', 'assistant.message', 'status', 'usage']);
      expect(chunks.filter(chunk => !chunk.done).map(chunk => chunk.text)).toEqual(['结构化回复']);
      expect(chunks.filter(chunk => chunk.done)).toHaveLength(1);
    } finally {
      rmSync(commandRoot, { recursive: true, force: true });
    }
  });

  it('reports a redacted CLI lifecycle and Git file changes', async () => {
    execFileSync('git', ['init', workspaceRoot], { stdio: 'ignore' });
    writeFileSync(join(workspaceRoot, 'tracked.txt'), 'before', 'utf8');
    execFileSync('git', ['-C', workspaceRoot, 'add', 'tracked.txt'], { stdio: 'ignore' });
    execFileSync('git', ['-C', workspaceRoot, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'initial'], { stdio: 'ignore' });
    const started: string[] = [];
    const completed: Array<{ label: string; exitCode: number | null }> = [];
    const changes: Array<Omit<RunFileChange, 'runId'>> = [];
    const log = await CLIExecutor.execute({
      ...okConfig,
      cliArgs: ['-e', "require('node:fs').writeFileSync('created.txt','new');require('node:fs').writeFileSync('tracked.txt','after');console.log('evidence')"],
    }, 'ignored', {
      ...ctx('evidence-task'),
      onInvocationStarted: observation => started.push(`${observation.cliKind}:${observation.commandLabel}`),
      onInvocationCompleted: observation => completed.push({ label: observation.commandLabel, exitCode: observation.exitCode }),
      onFileChanges: observed => changes.push(...observed),
    });

    expect(log.exitCode).toBe(0);
    expect(started).toEqual(['unknown:agent cli']);
    expect(completed).toEqual([{ label: 'agent cli', exitCode: 0 }]);
    expect(changes.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: 'created.txt', changeType: 'created' },
      { path: 'tracked.txt', changeType: 'modified' },
    ]);
  });

  it('passes resolved model and thinking effort to a Codex-shaped fake CLI', async () => {
    const commandRoot = mkdtempSync(join(tmpdir(), 'agentos-fake-codex-'));
    const commandPath = join(commandRoot, 'codex.exe');
    const capturePath = join(commandRoot, 'capture.json');
    copyFileSync(process.execPath, commandPath);
    chmodSync(commandPath, 0o755);

    try {
      const log = await CLIExecutor.execute({
        name: 'Fake Codex',
        role: 'codex_manager',
        cliCommand: commandPath,
        cliArgs: [
          '-e',
          "const fs=require('node:fs');fs.writeFileSync(process.env.AGENTOS_FAKE_CAPTURE,JSON.stringify({ argv: process.argv.slice(1) }));console.log('fake codex ok');",
          '--',
        ],
        model: 'integration-model',
        thinkingEffort: 'high',
        env: { AGENTOS_FAKE_CAPTURE: capturePath },
      }, 'integration prompt', ctx('fake-codex'));

      expect(log.exitCode).toBe(0);
      expect(log.stdout).toContain('fake codex ok');
      const captured = JSON.parse(readFileSync(capturePath, 'utf-8')) as { argv: string[] };
      expect(captured.argv.slice(0, 4)).toEqual([
        '-m', 'integration-model', '-c', 'model_reasoning_effort=high',
      ]);
      expect(captured.argv.at(-1)).toBe('integration prompt');
    } finally {
      rmSync(commandRoot, { recursive: true, force: true });
    }
  });

  it('passes image attachments as separate Codex arguments before the prompt', async () => {
    const commandRoot = mkdtempSync(join(tmpdir(), 'agentos-fake-codex-image-'));
    const commandPath = join(commandRoot, 'codex.exe');
    const capturePath = join(commandRoot, 'capture.json');
    copyFileSync(process.execPath, commandPath);
    chmodSync(commandPath, 0o755);

    try {
      await CLIExecutor.execute({
        name: 'Fake Codex', role: 'codex_manager', cliCommand: commandPath,
        cliArgs: ['-e', "const fs=require('node:fs');fs.writeFileSync(process.env.AGENTOS_FAKE_CAPTURE,JSON.stringify({ argv: process.argv.slice(1) }));console.log('fake codex image ok');", '--'],
        env: { AGENTOS_FAKE_CAPTURE: capturePath },
        imageAttachments: [{ name: 'screen.png', mimeType: 'image/png', absolutePath: 'C:\\workspace with spaces\\screen.png' }],
      }, 'image prompt', ctx('fake-codex-image'));

      const captured = JSON.parse(readFileSync(capturePath, 'utf-8')) as { argv: string[] };
      expect(captured.argv).toContain('--image');
      expect(captured.argv).toContain('C:\\workspace with spaces\\screen.png');
      expect(captured.argv).not.toContain('image prompt');
    } finally {
      rmSync(commandRoot, { recursive: true, force: true });
    }
  });

  it('pipes a Codex image prompt instead of relying on a positional prompt argument', async () => {
    const invocation = await createCommandInvocation(
      'codex.exe',
      ['exec', '--image', 'C:\\workspace\\screen.png'],
      'image prompt',
      process.platform,
      { promptViaStdin: true },
    );

    expect(invocation.args).toEqual(['exec', '--image', 'C:\\workspace\\screen.png']);
    expect(invocation.stdin).toBe('image prompt');
    await invocation.cleanup();
  });

  it('does not propagate a temporary invocation cleanup failure', async () => {
    await expect(safeCleanup(async () => {
      throw new Error('temporary file is busy');
    })).resolves.toBeUndefined();
  });

  it('throws CLIError with original exit code on failure', async () => {
    let captured: CLIError | undefined;
    await expect(CLIExecutor.execute(failConfig, 'ignored', ctx())).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(CLIError);
      captured = err as CLIError;
      expect(captured.exitCode).toBe(1);
      expect(captured.stage).toBe('codex_manager');
      expect(captured.log?.stage).toBe('codex_manager');
      expect(captured.log?.exitCode).toBe(1);
      return true;
    });
    expect(captured).toBeDefined();
  });

  it('omits prompt and CLI output from persisted task logs', async () => {
    const prompt = 'PROMPT_SECRET_SHOULD_NOT_BE_PERSISTED';
    await expect(CLIExecutor.execute({
      ...okConfig,
      cliArgs: ['-e', "console.log('OUTPUT_SECRET'); console.error('ERROR_SECRET'); process.exit(1)"],
    }, prompt, ctx('privacy-task'))).rejects.toBeInstanceOf(CLIError);
    const taskLog = readFileSync(join(workspaceRoot, '.agentos', 'logs', 'privacy-task', 'codex_manager.log'), 'utf8');
    expect(taskLog).not.toContain(prompt);
    expect(taskLog).not.toContain('OUTPUT_SECRET');
    expect(taskLog).not.toContain('ERROR_SECRET');
    expect(taskLog).toContain('content omitted');
  });

  it('throws CLIError when command is not found', async () => {
    let captured: CLIError | undefined;
    await expect(CLIExecutor.execute(missingConfig, 'ignored', ctx())).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(CLIError);
      captured = err as CLIError;
      expect(captured.exitCode).toBeNull();
      expect(captured.message).toContain('command not found');
      return true;
    });
    expect(captured).toBeDefined();
  });

  it('treats empty, zero, and null inactivity timeout values as disabled', () => {
    expect(getInactivityTimeoutMs(undefined)).toBeNull();
    expect(getInactivityTimeoutMs('0')).toBeNull();
    expect(getInactivityTimeoutMs('null')).toBeNull();
  });

  it('reads the maximum execution timeout from the environment at execution time', () => {
    expect(getMaxExecutionTimeoutMs('100')).toBe(100);
  });

  it('fails a command that exceeds the maximum execution timeout', async () => {
    process.env.AGENTOS_AGENT_TIMEOUT = '0';
    process.env.AGENTOS_MAX_EXECUTION_MS = '100';

    await expect(CLIExecutor.execute({
      ...okConfig,
      cliArgs: ['-e', 'setTimeout(() => process.exit(0), 1000);'],
    }, 'ignored', ctx('max-timeout-command'))).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(CLIError);
      expect((err as Error).message).toContain('Max execution time exceeded');
      return true;
    });
  });

  it('allows a no-output command to finish when inactivity timeout is disabled', async () => {
    process.env.AGENTOS_AGENT_TIMEOUT = '0';
    const log = await CLIExecutor.execute({
      ...okConfig,
      cliArgs: ['-e', 'setTimeout(() => process.exit(0), 300);'],
    }, 'ignored', ctx('disabled-timeout-command'));

    expect(log.exitCode).toBe(0);
  });

  it('does not kill a long-running command that keeps producing output', async () => {
    process.env.AGENTOS_AGENT_TIMEOUT = '200';
    const log = await CLIExecutor.execute({
      ...okConfig,
      cliArgs: ['-e', 'let count = 0; const timer = setInterval(() => { console.log(`tick-${++count}`); if (count === 6) clearInterval(timer); }, 50);'],
    }, 'ignored', ctx('active-command'));

    expect(log.exitCode).toBe(0);
    expect(log.stdout).toContain('tick-6');
  });

  it('fails a command that exceeds the configured inactivity timeout without output', async () => {
    process.env.AGENTOS_AGENT_TIMEOUT = '50';
    await expect(CLIExecutor.execute({
      ...okConfig,
      cliArgs: ['-e', 'setTimeout(() => process.exit(0), 500);'],
    }, 'ignored', ctx('inactive-command'))).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(CLIError);
      expect((err as Error).message).toContain('inactive');
      return true;
    });
  });

  it('still terminates an agent when its AbortSignal is cancelled', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);

    await expect(CLIExecutor.execute({
      ...okConfig,
      cliArgs: ['-e', 'setInterval(() => {}, 1000);'],
    }, 'ignored', { ...ctx('cancelled-command'), signal: controller.signal })).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(CLIError);
      expect((err as Error).message).toContain('Pipeline cancelled');
      return true;
    });
  });

  it('uses mock mode when AGENTOS_FORCE_MOCK is true', async () => {
    process.env.AGENTOS_FORCE_MOCK = 'true';
    try {
      // Even with missing command, mock mode should succeed
      const log = await CLIExecutor.execute(missingConfig, 'test prompt', ctx());
      expect(log.exitCode).toBe(0);
      expect(log.mode).toBe('mock');
      expect(log.stdout.length).toBeGreaterThan(0);
    } finally {
      process.env.AGENTOS_FORCE_MOCK = 'false';
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('creates an Agent log with its header on first execution', async () => {
    await CLIExecutor.execute(okConfig, 'ignored', ctx());

    const log = readFileSync(join(workspaceRoot, 'agent-memory', 'LOG.md'), 'utf-8');
    expect(log).toContain('# Agent Execution Log');
    expect(log).toContain('| TestAgent | codex_manager | test-task |');
  });

  it('keeps batch prompts out of the Windows command line', async () => {
    const prompt = 'audit this & do not execute anything';
    const invocation = await createCommandInvocation(
      'C:\\tools\\agent.cmd',
      ['-p'],
      prompt,
      'win32',
    );

    try {
      expect(invocation.command).toBe('powershell.exe');
      expect(invocation.args.join('\n')).not.toContain(prompt);
      expect(invocation.args).toContain('-PromptFile');
    } finally {
      await invocation.cleanup();
    }
  });

  it('cleans the Windows invocation temp directory when Kimi setup fails', async () => {
    const commandRoot = mkdtempSync(join(tmpdir(), 'agentos-kimi-command-'));
    const commandPath = join(commandRoot, 'agent.cmd');
    const invalidHome = join(commandRoot, 'kimi-home-file');
    writeFileSync(commandPath, '@echo off\r\nexit /b 0\r\n', 'utf-8');
    writeFileSync(invalidHome, 'not a directory', 'utf-8');
    const before = new Set(readdirSync(tmpdir()).filter(name => name.startsWith('agentos-cli-')));
    process.env.AGENTOS_KIMI_CODE_HOME = invalidHome;

    try {
      await expect(CLIExecutor.execute({
        name: 'KimiCode', role: 'kimi_worker', cliCommand: commandPath, cliArgs: ['-p'],
      }, 'ignored', ctx('kimi-setup-failure'))).rejects.toThrow('Kimi runtime setup failed');

      const leaked = readdirSync(tmpdir()).filter(name => name.startsWith('agentos-cli-') && !before.has(name));
      expect(leaked).toHaveLength(0);
    } finally {
      for (const name of readdirSync(tmpdir()).filter(name => name.startsWith('agentos-cli-') && !before.has(name))) {
        rmSync(join(tmpdir(), name), { recursive: true, force: true });
      }
      rmSync(commandRoot, { recursive: true, force: true });
    }
  });

  it('derives CODEX_HOME from USERPROFILE for a Codex CLI child process', () => {
    const env = resolveAgentEnvironment({
      ...okConfig,
      cliCommand: 'C:\\Users\\TestUser\\.codex\\.sandbox-bin\\codex.exe',
    }, { USERPROFILE: 'C:\\Users\\TestUser' });

    expect(env.CODEX_HOME).toBe('C:\\Users\\TestUser\\.codex');
  });

  it('derives HOME from USERPROFILE for external CLI child processes', () => {
    const env = resolveAgentEnvironment({
      ...okConfig,
      cliCommand: 'C:\\Users\\TestUser\\.codex\\.sandbox-bin\\codex.exe',
    }, { USERPROFILE: 'C:\\Users\\TestUser' });

    expect(env.HOME).toBe('C:\\Users\\TestUser');
  });

  it('preserves an explicitly inherited HOME', () => {
    const env = resolveAgentEnvironment({
      ...okConfig,
      cliCommand: 'C:\\Users\\TestUser\\.codex\\.sandbox-bin\\codex.exe',
    }, {
      HOME: 'D:\\agent-home',
      USERPROFILE: 'C:\\Users\\TestUser',
    });

    expect(env.HOME).toBe('D:\\agent-home');
  });

  it('preserves agent CODEX_HOME over inherited and derived values', () => {
    const env = resolveAgentEnvironment({
      ...okConfig,
      cliCommand: 'codex',
      env: { CODEX_HOME: 'D:\\agent-auth' },
    }, {
      CODEX_HOME: 'C:\\Users\\ProcessUser\\.codex',
      USERPROFILE: 'C:\\Users\\ProcessUser',
    });

    expect(env.CODEX_HOME).toBe('D:\\agent-auth');
  });

  it('does not add CODEX_HOME for a non-Codex CLI', () => {
    const env = resolveAgentEnvironment({
      ...okConfig,
      role: 'kimi_worker',
      cliCommand: 'kimi',
    }, { USERPROFILE: 'C:\\Users\\TestUser' });

    expect(env.CODEX_HOME).toBeUndefined();
  });

  it('isolates OpenCode config and denies write-capable tools by default', () => {
    const env = resolveAgentEnvironment({
      ...okConfig,
      role: 'opencode_reviewer',
      cliCommand: 'E:\\software\\opencode\\node_modules\\opencode-ai\\bin\\opencode.exe',
    }, {
      AGENTOS_WORKSPACE_ROOT: 'C:\\workspace\\agentos',
      USERPROFILE: 'C:\\Users\\TestUser',
    });

    expect(env.XDG_CONFIG_HOME).toBe('C:\\workspace\\agentos\\.agentos\\opencode');
    expect(JSON.parse(env.OPENCODE_PERMISSION ?? '{}')).toMatchObject({
      edit: 'deny',
      bash: 'deny',
      task: 'deny',
      external_directory: 'deny',
    });
  });

  it('uses API Key runtime settings instead of the Kimi OAuth model alias', () => {
    const env = resolveAgentEnvironment({
      role: 'kimi_worker',
      cliCommand: 'kimi',
    }, {
      AGENTOS_KIMI_API_KEY: 'test-api-key',
    });

    expect(env.KIMI_MODEL_NAME).toBe('kimi-for-coding');
    expect(env.KIMI_MODEL_API_KEY).toBe('test-api-key');
    expect(env.KIMI_MODEL_PROVIDER_TYPE).toBe('kimi');
    expect(env.KIMI_MODEL_BASE_URL).toBe('https://api.kimi.com/coding/v1');
    expect(resolveKimiCliArgs(['-m', 'kimi-code/kimi-for-coding', '-p'], env)).toEqual(['-p']);
  });

  it('passes the resolved CODEX_HOME to a spawned Codex stage child process', async () => {
    const log = await CLIExecutor.execute({
      ...okConfig,
      cliArgs: ['-e', 'console.log(process.env.CODEX_HOME)'],
      env: { USERPROFILE: 'C:\\Users\\SpawnUser' },
    }, 'ignored', ctx('codex-environment'));

    expect(log.stdout).toContain('C:\\Users\\SpawnUser\\.codex');
  });

  it('copies Kimi configuration and credentials into a writable runtime home', async () => {
    const sourceHome = mkdtempSync(join(tmpdir(), 'agentos-kimi-source-'));
    const targetHome = mkdtempSync(join(tmpdir(), 'agentos-kimi-target-'));
    try {
      writeFileSync(join(sourceHome, 'config.toml'), '[providers.kimi]\n', 'utf-8');
      writeFileSync(join(sourceHome, 'device_id'), 'device-id', 'utf-8');
      mkdirSync(join(sourceHome, 'credentials'));
      writeFileSync(join(sourceHome, 'credentials', 'kimi-code.json'), '{"token":"test"}', 'utf-8');

      await prepareKimiCodeHome(sourceHome, targetHome);

      expect(readFileSync(join(targetHome, 'config.toml'), 'utf-8')).toContain('[providers.kimi]');
      expect(readFileSync(join(targetHome, 'credentials', 'kimi-code.json'), 'utf-8')).toContain('token');
      expect(existsSync(join(targetHome, 'device_id'))).toBe(true);
    } finally {
      rmSync(sourceHome, { recursive: true, force: true });
      rmSync(targetHome, { recursive: true, force: true });
    }
  });

  it('persists a Kimi startup failure as a CLIError log', async () => {
    const sourceHome = mkdtempSync(join(tmpdir(), 'agentos-kimi-source-'));
    const blockedHome = join(workspaceRoot, 'blocked-kimi-home');
    try {
      writeFileSync(join(sourceHome, 'config.toml'), '[providers.kimi]\n', 'utf-8');
      writeFileSync(blockedHome, 'not a directory', 'utf-8');
      process.env.KIMI_CODE_HOME = sourceHome;
      process.env.AGENTOS_KIMI_CODE_HOME = blockedHome;

      await expect(CLIExecutor.execute({
        name: 'KimiCode',
        role: 'kimi_worker',
        cliCommand: 'node',
        cliArgs: ['-e', 'console.log("should not run")'],
      }, 'ignored', ctx('kimi-startup-failure'))).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(CLIError);
        const cliError = err as CLIError;
        expect(cliError.log?.stage).toBe('kimi_worker');
        expect(cliError.stderr).toContain('Kimi runtime setup failed');
        return true;
      });

      const log = readFileSync(join(workspaceRoot, '.agentos', 'logs', 'kimi-startup-failure', 'kimi_worker.log'), 'utf-8');
      expect(log).toContain('content omitted');
    } finally {
      rmSync(sourceHome, { recursive: true, force: true });
    }
  });
});
