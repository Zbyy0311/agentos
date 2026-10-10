import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest';
import { ChildProcess, execFileSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { CLIExecutor, CLIError, BoundedOutputBuffer, CLI_OUTPUT_CAPTURE_LIMIT_CHARS, buildOutputTruncationMarker, createCommandInvocation, DEFAULT_OPENCODE_INACTIVITY_TIMEOUT_MS, getInactivityTimeoutMs, getMaxExecutionTimeoutMs, prepareKimiCodeHome, resolveAgentEnvironment, resolveAgentRuntimeConfig, resolveInactivityTimeoutMs, resolveKimiCliArgs, safeCleanup, signalChildTree } from './executor.js';
import type { AgentConfig } from './types.js';
import type { RunFileChange } from '@agentos/shared';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (path: string) => { exec(sql: string): void; prepare(sql: string): { run(...parameters: unknown[]): void }; close(): void } };

// Ensure FORCE_MOCK is off for these tests unless explicitly toggled
process.env.AGENTOS_FORCE_MOCK = 'false';
const originalAgentTimeout = process.env.AGENTOS_AGENT_TIMEOUT;
const originalMaxExecutionTimeout = process.env.AGENTOS_MAX_EXECUTION_MS;
// Keep abort + process-exit observation + bounded cleanup inside each 20s test deadline.
const STRUCTURED_FIXTURE_WATCHDOG_MS = 16_000;
const STRUCTURED_FIXTURE_CANCEL_SETTLE_MS = 1_000;
const STRUCTURED_FIXTURE_CLEANUP_BUDGET_MS = 750;

interface WrapperFixtureEvent {
  phase: 'probe-version' | 'probe-help' | 'execute';
  state: 'start' | 'end';
  at: number;
  pid: number;
}

async function executeWrapperFixture<T>(
  label: string,
  commandRoot: string,
  lifecyclePath: string,
  execute: (signal: AbortSignal) => Promise<T>,
): Promise<{ value: T; events: WrapperFixtureEvent[]; phaseDurationsMs: number[]; elapsedMs: number; cleanupMs: number }> {
  const controller = new AbortController();
  const startedAt = Date.now();
  let watchdogFired = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const execution = Promise.resolve().then(() => execute(controller.signal)).then(
    value => ({ kind: 'completed' as const, value }),
    error => ({ kind: 'failed' as const, error }),
  );
  let cleanupPromise: Promise<{ kind: 'removed' } | { kind: 'failed'; error: string } | { kind: 'timed-out' }> | undefined;
  const cleanup = () => {
    cleanupPromise ??= (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const removal = rm(commandRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 }).then(
        () => ({ kind: 'removed' as const }),
        error => ({ kind: 'failed' as const, error: error instanceof Error ? error.message : String(error) }),
      );
      const outcome = await Promise.race([
        removal,
        new Promise<{ kind: 'timed-out' }>(resolve => {
          timer = setTimeout(() => resolve({ kind: 'timed-out' }), STRUCTURED_FIXTURE_CLEANUP_BUDGET_MS);
        }),
      ]);
      if (timer) clearTimeout(timer);
      return outcome;
    })();
    return cleanupPromise;
  };
  const outcome = await Promise.race([
    execution,
    new Promise<{ kind: 'watchdog' }>(resolve => {
      watchdog = setTimeout(() => {
        watchdogFired = true;
        controller.abort();
        resolve({ kind: 'watchdog' });
      }, STRUCTURED_FIXTURE_WATCHDOG_MS);
    }),
  ]);
  if (watchdog) clearTimeout(watchdog);

  let finalOutcome: Awaited<typeof execution> | { kind: 'watchdog' } | { kind: 'cancel-pending' } = outcome;
  if (outcome.kind === 'watchdog') {
    let cancelSettleTimer: ReturnType<typeof setTimeout> | undefined;
    finalOutcome = await Promise.race([
      execution,
      new Promise<{ kind: 'cancel-pending' }>(resolve => {
        cancelSettleTimer = setTimeout(() => resolve({ kind: 'cancel-pending' }), STRUCTURED_FIXTURE_CANCEL_SETTLE_MS);
      }),
    ]);
    if (cancelSettleTimer) clearTimeout(cancelSettleTimer);
  }

  const readEvents = (): WrapperFixtureEvent[] => {
    try {
      return existsSync(lifecyclePath)
        ? readFileSync(lifecyclePath, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as WrapperFixtureEvent)
        : [];
    } catch { return []; }
  };
  const events = readEvents();
  const pending = new Map<string, WrapperFixtureEvent>();
  const phaseDurationsMs: number[] = [];
  for (const event of events) {
    const key = `${event.phase}:${event.pid}`;
    if (event.state === 'start') pending.set(key, event);
    else {
      const start = pending.get(key);
      if (start) phaseDurationsMs.push(event.at - start.at);
      pending.delete(key);
    }
  }
  const phaseSummary = events.map(event => `${event.phase}:${event.state}+${event.at - startedAt}ms(pid=${event.pid})`).join(',') || 'no fixture markers';
  const isPidActive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
  };
  if (finalOutcome.kind === 'cancel-pending') {
    throw new Error(`${label} execute did not settle within ${STRUCTURED_FIXTURE_CANCEL_SETTLE_MS}ms after cancellation; fixture retained at ${commandRoot}; totalMs=${Date.now() - startedAt}; phases=${phaseSummary}`);
  }

  let activePids = [...new Set(events.map(event => event.pid))].filter(isPidActive);

  if (activePids.length > 0) {
    // Wait briefly for an abort-triggered wrapper exit, but preserve files if it survives.
    const exitDeadline = Date.now() + STRUCTURED_FIXTURE_CANCEL_SETTLE_MS;
    while (activePids.length > 0 && Date.now() < exitDeadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
      activePids = activePids.filter(isPidActive);
    }
    if (activePids.length > 0) {
      throw new Error(`${label} fixture process remained active after execute settled; fixture retained at ${commandRoot}; activePids=${activePids.join(',')}; totalMs=${Date.now() - startedAt}; phases=${phaseSummary}`);
    }
  }

  const cleanupStartedAt = Date.now();
  const cleanupResult = await cleanup();
  const cleanupMs = Date.now() - cleanupStartedAt;
  const elapsedMs = Date.now() - startedAt;
  if (cleanupResult.kind !== 'removed' || existsSync(commandRoot)) {
    throw new Error(`${label} fixture cleanup exceeded its bound: elapsedMs=${cleanupMs}; exists=${existsSync(commandRoot)}; result=${cleanupResult.kind}${cleanupResult.kind === 'failed' ? `:${cleanupResult.error}` : ''}; phases=${phaseSummary}`);
  }
  if (watchdogFired) {
    throw new Error(`${label} fixture execution exceeded ${STRUCTURED_FIXTURE_WATCHDOG_MS}ms; canceled and settled=${finalOutcome.kind} within ${STRUCTURED_FIXTURE_CANCEL_SETTLE_MS}ms; totalMs=${elapsedMs}; cleanupMs=${cleanupMs}; phases=${phaseSummary}`);
  }
  if (finalOutcome.kind === 'failed') {
    const cause = finalOutcome.error instanceof Error ? finalOutcome.error.message : String(finalOutcome.error);
    throw new Error(`${label} fixture execution failed after ${elapsedMs}ms; cleanupMs=${cleanupMs}; phases=${phaseSummary}; cause=${cause}`);
  }
  if (finalOutcome.kind !== 'completed') {
    throw new Error(`${label} fixture did not settle; cleanupMs=${cleanupMs}; phases=${phaseSummary}`);
  }
  return { value: finalOutcome.value, events, phaseDurationsMs, elapsedMs, cleanupMs };
}

function expectCompletedWrapperLifecycle(
  label: string,
  fixture: { events: WrapperFixtureEvent[]; phaseDurationsMs: number[]; elapsedMs: number; cleanupMs: number },
): void {
  const diagnostic = `${label} lifecycle: elapsedMs=${fixture.elapsedMs}; phaseDurationsMs=${fixture.phaseDurationsMs.join(',')}; cleanupMs=${fixture.cleanupMs}; markers=${fixture.events.map(event => `${event.phase}:${event.state}+${event.at - (fixture.events[0]?.at ?? event.at)}ms(pid=${event.pid})`).join(',')}`;
  expect(fixture.events.map(event => `${event.phase}:${event.state}`), diagnostic).toEqual([
    'probe-version:start', 'probe-version:end', 'probe-help:start', 'probe-help:end', 'execute:start', 'execute:end',
  ]);
  expect(fixture.phaseDurationsMs, diagnostic).toHaveLength(3);
  expect(fixture.phaseDurationsMs.every(durationMs => durationMs < 5000), diagnostic).toBe(true);
  expect(fixture.cleanupMs, diagnostic).toBeLessThan(STRUCTURED_FIXTURE_CLEANUP_BUDGET_MS);
}

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

  it('preserves OpenCodex model routing when a Kimi API key is configured', () => {
    const resolved = resolveAgentRuntimeConfig({
      role: 'kimi_worker',
      provider: 'kimi',
      cliCommand: 'kimi',
      cliArgs: ['-m', 'opencodex/gpt-5.6-luna', '-p'],
      model: 'opencodex/gpt-5.6-luna',
      thinkingEffort: 'auto',
    }, {
      AGENTOS_KIMI_API_KEY: 'test-key',
      KIMI_MODEL_NAME: 'kimi-for-coding',
      KIMI_MODEL_API_KEY: 'stale-key',
      KIMI_MODEL_PROVIDER_TYPE: 'kimi',
      KIMI_MODEL_BASE_URL: 'https://api.kimi.com/coding/v1',
    });

    expect(resolved.cliArgs).toEqual(['-m', 'opencodex/gpt-5.6-luna', '-p']);
    expect(resolved.env.KIMI_MODEL_NAME).toBeUndefined();
    expect(resolved.env.KIMI_MODEL_API_KEY).toBeUndefined();
    expect(resolved.env.KIMI_MODEL_PROVIDER_TYPE).toBeUndefined();
    expect(resolved.env.KIMI_MODEL_BASE_URL).toBeUndefined();
    expect(resolved.env.AGENTOS_KIMI_API_KEY).toBe('test-key');
  });

  it('replaces the OpenCode model flag when the command is OpenCode', () => {
    const resolved = resolveAgentRuntimeConfig({
      role: 'opencode_reviewer', cliCommand: 'opencode', cliArgs: ['--pure', 'run', '--model', 'old-model'], model: 'new-model', thinkingEffort: 'auto',
    }, {});

    expect(resolved.cliArgs).toEqual(['--pure', 'run', '--model', 'new-model']);
  });

  it('passes OpenCode thinking effort as the provider variant', () => {
    const resolved = resolveAgentRuntimeConfig({
      role: 'opencode_reviewer', cliCommand: 'opencode', cliArgs: ['--pure', 'run', '--model', 'new-model'], model: 'new-model', thinkingEffort: 'high',
    }, {});

    expect(resolved.cliArgs).toEqual(['--pure', 'run', '--model', 'new-model', '--variant', 'high']);
  });

  it('passes Kimi thinking effort through its supported environment setting', () => {
    const resolved = resolveAgentRuntimeConfig({
      role: 'kimi_worker', cliCommand: 'kimi', cliArgs: ['-p'], model: 'kimi-code/kimi-for-coding', thinkingEffort: 'max',
    }, {});

    expect(resolved.env.KIMI_MODEL_THINKING_EFFORT).toBe('max');
  });

  it('removes stale provider effort overrides when automatic effort is selected', () => {
    const kimi = resolveAgentRuntimeConfig({
      role: 'kimi_worker', cliCommand: 'kimi', cliArgs: ['-p'], model: 'kimi-code/kimi-for-coding', thinkingEffort: 'auto',
    }, { KIMI_MODEL_THINKING_EFFORT: 'max' });
    const opencode = resolveAgentRuntimeConfig({
      role: 'opencode_reviewer', cliCommand: 'opencode', cliArgs: ['run', '--variant', 'high'], model: 'new-model', thinkingEffort: 'auto',
    }, {});

    expect(kimi.env.KIMI_MODEL_THINKING_EFFORT).toBeUndefined();
    expect(opencode.cliArgs).toEqual(['run', '--model', 'new-model']);
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

  it('maps Codex max thinking effort to its config override', () => {
    const resolved = resolveAgentRuntimeConfig({
      role: 'codex_manager', cliCommand: 'codex', cliArgs: ['exec'], model: 'gpt-5.6-luna', thinkingEffort: 'max',
    }, {});

    expect(resolved.cliArgs).toEqual([
      'exec', '-m', 'gpt-5.6-luna', '-c', 'model_reasoning_effort=max',
    ]);
  });

  it('accepts Kimi adjustable thinking effort values', () => {
    expect(() => resolveAgentRuntimeConfig({
      role: 'kimi_worker', cliCommand: 'kimi', cliArgs: ['-p'], model: 'new-model', thinkingEffort: 'high',
    }, {})).not.toThrow();
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
    const lifecyclePath = join(commandRoot, 'lifecycle.jsonl');
    writeFileSync(commandPath, `@echo off\r\n"${process.execPath}" "%~dp0fake-codex.mjs" %*\r\nexit /b %ERRORLEVEL%\r\n`, 'utf8');
    writeFileSync(scriptPath, [
      "import { appendFileSync } from 'node:fs';",
      "const args = process.argv.slice(2);",
      `const lifecyclePath = ${JSON.stringify(lifecyclePath)};`,
      "const phase = args.includes('--version') ? 'probe-version' : args.includes('--help') ? 'probe-help' : 'execute';",
      "const mark = state => appendFileSync(lifecyclePath, JSON.stringify({phase,state,at:Date.now(),pid:process.pid}) + '\\n');",
      "const run = async () => { mark('start'); try {",
      "if (args.includes('--version')) { console.log('codex 0.0.0'); }",
      "else if (args.includes('--help')) { console.log('Usage: codex exec --json'); }",
      "else {",
      "  const lines = [JSON.stringify({type:'thread.started'}), JSON.stringify({type:'item.started',item:{id:'cmd-1',type:'command_execution',command:'echo evidence'}}), JSON.stringify({type:'item.completed',item:{id:'cmd-1',type:'command_execution',status:'completed',exit_code:0}}), JSON.stringify({type:'item.completed',item:{id:'msg-1',type:'agent_message',text:'结构化回复'}}), JSON.stringify({type:'turn.completed',usage:{output_tokens:2}})];",
      "  process.stdout.write(lines[0] + '\\n'); await new Promise(resolve => setTimeout(resolve, 10)); process.stdout.write(lines[1] + '\\n' + lines[2] + '\\n'); await new Promise(resolve => setTimeout(resolve, 10)); process.stdout.write(lines[3] + '\\n' + lines[4] + '\\n');",
      "} } finally { mark('end'); } };",
      "await run();",
    ].join('\n'), 'utf8');

    const runtimeEvents: string[] = [];
    const chunks: Array<{ text: string; done: boolean }> = [];
    const fixture = await executeWrapperFixture('Codex', commandRoot, lifecyclePath, signal => CLIExecutor.execute({
      name: 'Fake Codex', role: 'codex_manager', cliCommand: commandPath, cliArgs: ['exec'],
    }, 'structured prompt', {
      ...ctx('structured-codex'),
      signal,
      onRuntimeEvent: event => runtimeEvents.push(event.type),
      onChunk: (text, done) => chunks.push({ text, done }),
    }));

    const log = fixture.value;
    expectCompletedWrapperLifecycle('Codex', fixture);
    expect(log.stdout).toBe('结构化回复');
    expect(log.stdout).not.toContain('item.completed');
    expect(runtimeEvents).toEqual(['status', 'tool.started', 'tool.completed', 'assistant.message', 'status', 'usage']);
    expect(chunks.filter(chunk => !chunk.done).map(chunk => chunk.text)).toEqual(['结构化回复']);
    expect(chunks.filter(chunk => chunk.done)).toHaveLength(1);
  // Two real capability probes each have a 5s bound before the stream starts.
  // Keep the test deadline above the probes and retain a shorter cancel-and-cleanup watchdog.
  }, 20_000);

  it('emits OpenCode token usage from the per-run SQLite delta', async () => {
    const commandRoot = mkdtempSync(join(tmpdir(), 'agentos-opencode-usage-cli-'));
    const commandPath = join(commandRoot, 'opencode.exe');
    const databasePath = join(commandRoot, 'opencode.db');
    copyFileSync(process.execPath, commandPath);
    const database = new DatabaseSync(databasePath);
    database.exec(`CREATE TABLE session (
      id TEXT PRIMARY KEY,
      directory TEXT NOT NULL,
      tokens_input INTEGER NOT NULL DEFAULT 0,
      tokens_output INTEGER NOT NULL DEFAULT 0,
      tokens_reasoning INTEGER NOT NULL DEFAULT 0,
      tokens_cache_read INTEGER NOT NULL DEFAULT 0,
      tokens_cache_write INTEGER NOT NULL DEFAULT 0
    )`);
    database.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?)').run('session-a', workspaceRoot, 10, 2, 1, 4, 0);
    database.close();

    try {
      const runtimeEvents: Array<{ type: string; inputTokens?: number; outputTokens?: number; cachedInputTokens?: number }> = [];
      const log = await CLIExecutor.execute({
        name: 'OpenCode',
        role: 'opencode_reviewer',
        cliCommand: commandPath,
        cliArgs: ['-e', `const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(${JSON.stringify(databasePath)}); db.prepare('UPDATE session SET tokens_input = 25, tokens_output = 8, tokens_reasoning = 2, tokens_cache_read = 11 WHERE id = ?').run('session-a'); db.close(); console.log('opencode ok');`],
        env: { AGENTOS_OPENCODE_DB: databasePath },
      }, 'opencode prompt', {
        ...ctx('opencode-usage'),
        onRuntimeEvent: event => runtimeEvents.push(event),
      });

      expect(log.stdout).toContain('opencode ok');
      expect(runtimeEvents.find(event => event.type === 'usage')).toMatchObject({
        inputTokens: 15,
        outputTokens: 6,
        cachedInputTokens: 7,
      });
    } finally {
      rmSync(commandRoot, { recursive: true, force: true });
    }
  });

  it('keeps a successful OpenCode execution successful when usage storage is unavailable', async () => {
    const commandRoot = mkdtempSync(join(tmpdir(), 'agentos-opencode-usage-missing-'));
    const commandPath = join(commandRoot, 'opencode.exe');
    const missingDatabasePath = join(commandRoot, 'missing', 'opencode.db');
    copyFileSync(process.execPath, commandPath);

    try {
      const events: Array<{ type: string }> = [];
      const log = await CLIExecutor.execute({
        name: 'OpenCode',
        role: 'opencode_reviewer',
        cliCommand: commandPath,
        cliArgs: ['-e', "console.log('opencode without usage database')"],
        env: { AGENTOS_OPENCODE_DB: missingDatabasePath },
      }, 'opencode prompt', {
        ...ctx('opencode-usage-missing'),
        onRuntimeEvent: event => events.push(event),
      });

      expect(log.exitCode).toBe(0);
      expect(log.stdout).toContain('opencode without usage database');
      expect(events.find(event => event.type === 'usage')).toMatchObject({ source: 'unavailable', provider: 'opencode', estimated: false });
    } finally {
      rmSync(commandRoot, { recursive: true, force: true });
    }
  });

  it('runs a Kimi stream-json wrapper through the configured provider adapter', async () => {
    const commandRoot = mkdtempSync(join(tmpdir(), 'agentos-fake-kimi-'));
    const commandPath = join(commandRoot, 'kimi.cmd');
    const scriptPath = join(commandRoot, 'fake-kimi.cjs');
    const lifecyclePath = join(commandRoot, 'lifecycle.jsonl');
    writeFileSync(commandPath, `@echo off\r\n"${process.execPath}" "%~dp0fake-kimi.cjs" %*\r\nexit /b %ERRORLEVEL%\r\n`, 'utf8');
    writeFileSync(scriptPath, [
      "const { appendFileSync } = require('node:fs');",
      "const args = process.argv.slice(2);",
      `const lifecyclePath = ${JSON.stringify(lifecyclePath)};`,
      "const phase = args.includes('--version') ? 'probe-version' : args.includes('--help') ? 'probe-help' : 'execute';",
      "const mark = state => appendFileSync(lifecyclePath, JSON.stringify({phase,state,at:Date.now(),pid:process.pid}) + '\\n');",
      "mark('start');",
      "try {",
      "  if (args.includes('--version')) { console.log('0.23.5'); }",
      "  else if (args.includes('--help')) { console.log('Usage: kimi --output-format <format> (choices: text, stream-json)'); }",
      "  else {",
      "    console.log(JSON.stringify({role:'assistant',tool_calls:[{type:'function',id:'tool-1',function:{name:'Glob',arguments:'{\\\"pattern\\\":\\\"*.ts\\\"}'}}]}));",
      "    console.log(JSON.stringify({role:'tool',tool_call_id:'tool-1',content:'executor.ts'}));",
      "    console.log(JSON.stringify({role:'assistant',content:'Kimi done'}));",
      "    console.log(JSON.stringify({type:'step.end',id:'step-1',usage:{input_tokens:8,cached_input_tokens:2,output_tokens:3}}));",
      "  }",
      "} finally { mark('end'); }",
    ].join('\n'), 'utf8');
    const events: Array<{ type: string; [key: string]: unknown }> = [];
    const fixture = await executeWrapperFixture('Kimi', commandRoot, lifecyclePath, signal => CLIExecutor.execute({
      name: 'KimiCode', role: 'kimi_worker', provider: 'kimi', cliCommand: commandPath, cliArgs: ['-p'],
    }, 'read files', { ...ctx('kimi-stream-json'), signal, onRuntimeEvent: event => events.push(event) }));
    const log = fixture.value;
    expectCompletedWrapperLifecycle('Kimi', fixture);
    expect(log.exitCode).toBe(0);
    expect(log.stdout).toContain('Kimi done');
    expect(events.some(event => event.type === 'tool.started')).toBe(true);
    expect(events.some(event => event.type === 'tool.completed')).toBe(true);
    expect(events.find(event => event.type === 'usage')).toMatchObject({ inputTokens: 8, cachedInputTokens: 2, outputTokens: 3 });
  }, 20_000);

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

  it('bounds OpenCode no-output executions without changing other CLI defaults', () => {
    expect(resolveInactivityTimeoutMs('opencode', undefined)).toBe(DEFAULT_OPENCODE_INACTIVITY_TIMEOUT_MS);
    expect(resolveInactivityTimeoutMs('codex', undefined)).toBeNull();
    expect(resolveInactivityTimeoutMs('opencode', '0')).toBeNull();
    expect(resolveInactivityTimeoutMs('opencode', '250')).toBe(250);
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
      expect((err as CLIError).timeoutReason).toBe('inactivity_timeout');
      return true;
    });
  });

  it('settles inactivity timeout even when kill does not produce close', async () => {
    process.env.AGENTOS_AGENT_TIMEOUT = '50';
    process.env.AGENTOS_MAX_EXECUTION_MS = '5000';
    const kill = vi.spyOn(ChildProcess.prototype, 'kill').mockReturnValue(true);
    const startedAt = Date.now();
    try {
      await expect(CLIExecutor.execute({
        ...okConfig,
        cliArgs: ['-e', 'setTimeout(() => process.exit(0), 1000);'],
      }, 'ignored', ctx('inactive-without-close'))).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(CLIError);
        expect((error as Error).message).toContain('inactive');
        return true;
      });
      expect(Date.now() - startedAt).toBeLessThan(500);
    } finally {
      kill.mockRestore();
    }
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

  it('preserves the user OpenCode config lookup and denies write-capable tools by default', () => {
    const env = resolveAgentEnvironment({
      ...okConfig,
      role: 'opencode_reviewer',
      cliCommand: 'E:\\software\\opencode\\node_modules\\opencode-ai\\bin\\opencode.exe',
    }, {
      AGENTOS_WORKSPACE_ROOT: 'C:\\workspace\\agentos',
      USERPROFILE: 'C:\\Users\\TestUser',
    });

    expect(env.XDG_CONFIG_HOME).toBeUndefined();
    expect(JSON.parse(env.OPENCODE_PERMISSION ?? '{}')).toMatchObject({
      edit: 'deny',
      bash: 'deny',
      task: 'deny',
      external_directory: 'deny',
    });
  });

  it('preserves an explicitly configured OpenCode config directory', () => {
    const env = resolveAgentEnvironment({
      ...okConfig,
      role: 'opencode_reviewer',
      cliCommand: 'E:\\software\\opencode\\node_modules\\opencode-ai\\bin\\opencode.exe',
      env: { XDG_CONFIG_HOME: 'D:\\agentos\\opencode-config' },
    }, {
      AGENTOS_WORKSPACE_ROOT: 'C:\\workspace\\agentos',
      USERPROFILE: 'C:\\Users\\TestUser',
    });

    expect(env.XDG_CONFIG_HOME).toBe('D:\\agentos\\opencode-config');
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

  it('bounds oversized CLI output while keeping the head and tail', async () => {
    const headMark = 'HEAD_MARK_';
    const tailMark = 'TAIL_MARK';
    const oversized = CLI_OUTPUT_CAPTURE_LIMIT_CHARS * 2;
    const log = await CLIExecutor.execute({
      ...okConfig,
      cliArgs: ['-e', `process.stdout.write(${JSON.stringify(headMark)}); process.stdout.write('x'.repeat(${oversized})); process.stdout.write(${JSON.stringify(tailMark)}); process.stderr.write('e'.repeat(${oversized}));`],
    }, 'ignored', ctx('bounded-output'));

    expect(log.exitCode).toBe(0);
    expect(log.stdout.length).toBeLessThan(CLI_OUTPUT_CAPTURE_LIMIT_CHARS * 1.2);
    expect(log.stdout.startsWith(headMark)).toBe(true);
    expect(log.stdout.endsWith(tailMark)).toBe(true);
    expect(log.stdout).toContain('output truncated');
    expect(log.stderr.length).toBeLessThan(CLI_OUTPUT_CAPTURE_LIMIT_CHARS * 1.2);
    expect(log.stderr.startsWith('e')).toBe(true);
    expect(log.stderr.endsWith('e')).toBe(true);
    expect(log.stderr).toContain('output truncated');
  });

  it('keeps small CLI output fully intact', async () => {
    const log = await CLIExecutor.execute(okConfig, 'ignored', ctx('small-output'));
    expect(log.exitCode).toBe(0);
    expect(log.stdout).toBe('ok');
    expect(log.stdout).not.toContain('output truncated');
  });

  it('signals the POSIX process group instead of only the direct child', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux' as NodeJS.Platform);
    const groupKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const childKill = vi.fn();
    try {
      signalChildTree({ pid: 4321, kill: childKill } as unknown as ChildProcess, 'SIGTERM');
      expect(groupKill).toHaveBeenCalledWith(-4321, 'SIGTERM');
      expect(childKill).not.toHaveBeenCalled();

      groupKill.mockClear();
      signalChildTree({ pid: 4321, kill: childKill } as unknown as ChildProcess, 'SIGKILL');
      expect(groupKill).toHaveBeenCalledWith(-4321, 'SIGKILL');
      expect(childKill).not.toHaveBeenCalled();
    } finally {
      platform.mockRestore();
      groupKill.mockRestore();
    }
  });

  it('falls back to the direct child signal when the POSIX group signal fails', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux' as NodeJS.Platform);
    const groupKill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('no such process group'), { code: 'ESRCH' });
    });
    const childKill = vi.fn();
    try {
      signalChildTree({ pid: 4321, kill: childKill } as unknown as ChildProcess, 'SIGTERM');
      expect(groupKill).toHaveBeenCalledWith(-4321, 'SIGTERM');
      expect(childKill).toHaveBeenCalledWith('SIGTERM');
    } finally {
      platform.mockRestore();
      groupKill.mockRestore();
    }
  });

  it('keeps Windows kill semantics on a single direct child', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32' as NodeJS.Platform);
    const groupKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const childKill = vi.fn();
    try {
      signalChildTree({ pid: 4321, kill: childKill } as unknown as ChildProcess, 'SIGTERM');
      expect(groupKill).not.toHaveBeenCalled();
      expect(childKill).toHaveBeenCalledWith();
    } finally {
      platform.mockRestore();
      groupKill.mockRestore();
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

describe('BoundedOutputBuffer', () => {
  it('keeps content fully intact while under the budget', () => {
    const buffer = new BoundedOutputBuffer(100);
    buffer.append('a'.repeat(60));
    buffer.append('b'.repeat(40));
    expect(buffer.isTruncated).toBe(false);
    expect(buffer.toString()).toBe('a'.repeat(60) + 'b'.repeat(40));
  });

  it('keeps head and tail with a marker once the budget is exceeded', () => {
    const buffer = new BoundedOutputBuffer(100);
    buffer.append('H'.repeat(30));
    buffer.append('M'.repeat(100));
    buffer.append('T'.repeat(30));
    const text = buffer.toString();
    expect(buffer.isTruncated).toBe(true);
    expect(buffer.receivedChars).toBe(160);
    expect(text.startsWith('H'.repeat(30))).toBe(true);
    expect(text).toContain(buildOutputTruncationMarker(160 - 100));
    expect(text.endsWith('T'.repeat(30))).toBe(true);
    // Head 60% + tail 40% exactly fill the budget; only the marker is extra.
    expect(text.length).toBe(100 + buildOutputTruncationMarker(60).length);
  });

  it('keeps the newest content in the tail for later appends after truncation', () => {
    const buffer = new BoundedOutputBuffer(100);
    buffer.append('x'.repeat(200));
    buffer.append('latest');
    const text = buffer.toString();
    expect(text.endsWith('latest')).toBe(true);
    expect(buffer.receivedChars).toBe(206);
  });
});
