import { spawn, type ChildProcess } from 'node:child_process';
import { cp, writeFile, mkdir, mkdtemp, open, rm, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { TextDecoder } from 'node:util';
import { randomUUID } from 'node:crypto';
import { MockCLI } from './mock.js';
import { resolveCommand } from './resolveCommand.js';
import { isCodexCli } from './config.js';
import { getCliCapability } from './capabilities.js';
import { resolveImageInput } from './imageInput.js';
import type { AgentConfig, ChunkCallback, ActivityCallback, RuntimeEventCallback } from './types.js';
import type { NormalizedCliEvent } from './adapters/types.js';
import { AgentCliAdapterRegistry } from './adapters/registry.js';
import { PlainTextAdapter } from './adapters/plainTextAdapter.js';
import type { CliInvocationObservation, TaskLog, AgentStage, ThinkingEffort, RunFileChange } from '@agentos/shared';
import { captureWorkspaceSnapshot, diffWorkspaceSnapshots } from './workspaceChanges.js';

const DIAG_LOG_DIR = process.env.AGENTOS_DIAG_LOG_DIR
  ?? join(process.env.AGENTOS_WORKSPACE_ROOT ?? process.cwd(), '.agentos', 'logs', 'diagnostics');
const DEFAULT_MAX_EXECUTION_MS = 30 * 60 * 1000;

export function getInactivityTimeoutMs(value = process.env.AGENTOS_AGENT_TIMEOUT): number | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === '0' || normalized === 'null') return null;

  const timeoutMs = Number.parseInt(normalized, 10);
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : null;
}

export function getMaxExecutionTimeoutMs(value = process.env.AGENTOS_MAX_EXECUTION_MS): number {
  if (value === undefined) return DEFAULT_MAX_EXECUTION_MS;
  const timeoutMs = Number.parseInt(value.trim(), 10);
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_MAX_EXECUTION_MS;
}

export function resolveAgentEnvironment(
  config: Pick<AgentConfig, 'role' | 'cliCommand' | 'env'>,
  inheritedEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...inheritedEnv, ...config.env };
  if (!env.HOME && env.USERPROFILE) env.HOME = env.USERPROFILE;
  if (!env.USERPROFILE && env.HOME) env.USERPROFILE = env.HOME;
  const usesCodexCli = config.role === 'codex_manager'
    || config.role === 'codex_final_review'
    || isCodexCli(config.cliCommand);

  if (usesCodexCli && !env.CODEX_HOME && env.USERPROFILE) {
    env.CODEX_HOME = join(env.USERPROFILE, '.codex');
  }

  if (usesCodexCli && env.CODEX_HOME) {
    const sandboxBin = join(env.CODEX_HOME, '.sandbox-bin');
    const pathKey = env.PATH !== undefined ? 'PATH' : 'Path';
    const currentPath = env[pathKey] ?? '';
    const pathEntries = currentPath.split(delimiter).filter(Boolean);
    if (!pathEntries.some(entry => entry.toLowerCase() === sandboxBin.toLowerCase())) {
      env[pathKey] = [sandboxBin, ...pathEntries].join(delimiter);
    }
  }

  if (config.role === 'kimi_worker' && env.AGENTOS_KIMI_API_KEY) {
    env.KIMI_MODEL_NAME = 'kimi-for-coding';
    env.KIMI_MODEL_API_KEY = env.AGENTOS_KIMI_API_KEY;
    env.KIMI_MODEL_PROVIDER_TYPE = 'kimi';
    env.KIMI_MODEL_BASE_URL = env.AGENTOS_KIMI_BASE_URL ?? 'https://api.kimi.com/coding/v1';
  }

  if (config.role === 'opencode_reviewer') {
    if (!env.XDG_CONFIG_HOME && env.AGENTOS_WORKSPACE_ROOT) {
      env.XDG_CONFIG_HOME = join(env.AGENTOS_WORKSPACE_ROOT, '.agentos', 'opencode');
    }
    if (!env.OPENCODE_PERMISSION) {
      env.OPENCODE_PERMISSION = JSON.stringify({
        edit: 'deny',
        bash: 'deny',
        task: 'deny',
        external_directory: 'deny',
      });
    }
  }

  return env;
}

export function resolveKimiCliArgs(cliArgs: string[], env: NodeJS.ProcessEnv): string[] {
  if (!env.KIMI_MODEL_NAME || !env.KIMI_MODEL_API_KEY) return cliArgs;

  return cliArgs.filter((arg, index) => arg !== '-m' && cliArgs[index - 1] !== '-m');
}

export interface RuntimeResolvedConfig {
  cliArgs: string[];
  env: NodeJS.ProcessEnv;
  cliKind: 'kimi' | 'opencode' | 'codex' | 'unknown';
}

function replaceOrAppendArg(args: string[], flag: string, value: string): string[] {
  const result: string[] = [];
  let replaced = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== flag) {
      result.push(args[index]);
      continue;
    }
    if (!replaced) {
      result.push(flag, value);
      replaced = true;
    }
    if (index + 1 < args.length) index += 1;
  }
  if (!replaced) result.push(flag, value);
  return result;
}

function removeArgPair(args: string[], flag: string): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag) {
      if (index + 1 < args.length) index += 1;
      continue;
    }
    result.push(args[index]);
  }
  return result;
}

function replaceConfigArg(args: string[], key: string, value: string): string[] {
  const assignment = `${key}=${value}`;
  const result: string[] = [];
  let replaced = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '-c') {
      result.push(args[index]);
      continue;
    }
    const configValue = args[index + 1];
    if (typeof configValue !== 'string' || !configValue.startsWith(`${key}=`)) {
      result.push(args[index]);
      continue;
    }
    if (!replaced) {
      result.push('-c', assignment);
      replaced = true;
    }
    index += 1;
  }
  if (!replaced) result.push('-c', assignment);
  return result;
}

export function resolveAgentRuntimeConfig(
  config: Pick<AgentConfig, 'role' | 'cliCommand' | 'cliArgs' | 'model' | 'thinkingEffort' | 'env'>,
  inheritedEnv: NodeJS.ProcessEnv = process.env,
): RuntimeResolvedConfig {
  const capability = getCliCapability(config.cliCommand);
  const thinkingEffort: ThinkingEffort = config.thinkingEffort ?? 'auto';
  if (!capability.thinkingEffortValues.includes(thinkingEffort)) {
    throw new Error(`${config.cliCommand} does not support thinking effort "${thinkingEffort}"`);
  }

  const env = resolveAgentEnvironment(config, inheritedEnv);
  const model = config.model?.trim();
  let cliArgs = [...config.cliArgs];

  if (capability.cliKind === 'kimi') {
    const apiKeyMode = Boolean(env.KIMI_MODEL_API_KEY);
    if (apiKeyMode) {
      if (model) env.KIMI_MODEL_NAME = model;
      cliArgs = removeArgPair(cliArgs, '-m');
    } else if (model) {
      cliArgs = replaceOrAppendArg(cliArgs, '-m', model);
    }
  } else if (capability.modelFlag && model) {
    cliArgs = replaceOrAppendArg(cliArgs, capability.modelFlag, model);
  }

  if (capability.cliKind === 'codex' && thinkingEffort !== 'auto') {
    cliArgs = replaceConfigArg(cliArgs, 'model_reasoning_effort', thinkingEffort);
  }

  return { cliArgs, env, cliKind: capability.cliKind };
}

async function diagLog(entry: string): Promise<void> {
  const timestamp = new Date().toISOString();
  const line = `${timestamp} ${entry}\n`;
  try {
    await mkdir(DIAG_LOG_DIR, { recursive: true });
    await appendFile(join(DIAG_LOG_DIR, 'executor.log'), line, 'utf-8');
  } catch {
    // best-effort
  }
}

export interface ExecuteContext {
  workspaceRoot: string;
  taskId: string;
  onChunk?: ChunkCallback;
  onActivity?: ActivityCallback;
  signal?: AbortSignal;
  onInvocationStarted?: (observation: CliInvocationObservation) => void;
  onInvocationCompleted?: (observation: Required<Pick<CliInvocationObservation, 'invocationId' | 'cliKind' | 'commandLabel' | 'startedAt' | 'completedAt' | 'exitCode' | 'durationMs'>> & Pick<CliInvocationObservation, 'model' | 'thinkingEffort'>) => void;
  onFileChanges?: (changes: Array<Omit<RunFileChange, 'runId'>>) => void;
  onRuntimeEvent?: RuntimeEventCallback;
}

export interface CommandInvocation {
  command: string;
  args: string[];
  stdin?: string;
  cleanup: () => Promise<void>;
}

export interface CommandInvocationOptions {
  promptViaStdin?: boolean;
}

export async function safeCleanup(cleanup: () => Promise<void>): Promise<void> {
  try {
    await cleanup();
  } catch {
    // Temporary-file cleanup must not overwrite the original execution result.
  }
}

const WINDOWS_BATCH_RUNNER = `param(
  [Parameter(Mandatory = $true)][string]$CommandPath,
  [Parameter(Mandatory = $true)][string]$PromptFile,
  [Parameter(Mandatory = $true)][string]$CliArgsJson,
  [switch]$PromptViaStdin
)
$ErrorActionPreference = 'Stop'
$prompt = [System.IO.File]::ReadAllText($PromptFile)
$cliArgs = @($CliArgsJson | ConvertFrom-Json)
if ($PromptViaStdin) {
  $prompt | & $CommandPath @cliArgs
} else {
  & $CommandPath @cliArgs $prompt
}
exit $LASTEXITCODE
`;

export async function createCommandInvocation(
  resolved: string,
  cliArgs: string[],
  prompt: string,
  platform = process.platform,
  options: CommandInvocationOptions = {},
): Promise<CommandInvocation> {
  const isWindowsBatch = platform === 'win32' && /\.(cmd|bat)$/i.test(resolved);
  if (!isWindowsBatch) {
    return {
      command: resolved,
      args: options.promptViaStdin ? [...cliArgs] : [...cliArgs, prompt],
      ...(options.promptViaStdin ? { stdin: prompt } : {}),
      cleanup: async () => {},
    };
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'agentos-cli-'));
  const promptFile = join(tempDir, 'prompt.txt');
  const scriptFile = join(tempDir, 'invoke-agent.ps1');
  try {
    await Promise.all([
      writeFile(promptFile, prompt, 'utf-8'),
      writeFile(scriptFile, WINDOWS_BATCH_RUNNER, 'utf-8'),
    ]);
  } catch (err) {
    await rm(tempDir, { recursive: true, force: true });
    throw err;
  }

  return {
    command: 'powershell.exe',
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptFile,
      '-CommandPath', resolved,
      '-PromptFile', promptFile,
      '-CliArgsJson', JSON.stringify(cliArgs),
      ...(options.promptViaStdin ? ['-PromptViaStdin'] : []),
    ],
    ...(options.promptViaStdin ? { stdin: prompt } : {}),
    cleanup: () => rm(tempDir, { recursive: true, force: true }),
  };
}

export async function prepareKimiCodeHome(sourceHome: string, targetHome: string): Promise<void> {
  await mkdir(targetHome, { recursive: true });

  for (const file of ['config.toml', 'tui.toml', 'device_id']) {
    const source = join(sourceHome, file);
    if (existsSync(source)) {
      await cp(source, join(targetHome, file), { force: true });
    }
  }

  const credentials = join(sourceHome, 'credentials');
  if (existsSync(credentials)) {
    await cp(credentials, join(targetHome, 'credentials'), { recursive: true, force: true });
  }
}

export class CLIError extends Error {
  constructor(
    message: string,
    public stage: AgentStage,
    public exitCode: number | null,
    public stderr: string,
    public log?: TaskLog,
  ) {
    super(message);
    this.name = 'CLIError';
  }
}

export class CLIExecutor {
  static async execute(
    config: AgentConfig,
    prompt: string,
    ctx: ExecuteContext,
  ): Promise<TaskLog> {
    const { workspaceRoot, taskId, onChunk, onActivity, signal } = ctx;
    const startTime = Date.now();
    const stage = config.role;
    const agentName = config.name;
    const executionId = randomUUID().slice(0, 12);
    const serverInstanceId = process.env.AGENTOS_SERVER_INSTANCE_ID ?? 'unknown';
    const inactivityTimeoutMs = getInactivityTimeoutMs();
    const maxExecutionTimeoutMs = getMaxExecutionTimeoutMs();
    const imagePlan = resolveImageInput(config, config.imageAttachments ?? []);
    if (imagePlan.transport === 'unsupported') {
      const message = imagePlan.error ?? '当前 CLI 不支持图片输入';
      const log = this.buildLog(stage, agentName, '', message, null, startTime, 'real');
      throw new CLIError(`${agentName} (${stage}): ${message}`, stage, null, message, log);
    }
    const preparedPrompt = imagePlan.promptSuffix ? `${prompt}\n\n${imagePlan.promptSuffix}` : prompt;
    const cliKind = getCliCapability(config.cliCommand).cliKind;
    const commandLabel = toCommandLabel(cliKind);
    const invocationId = randomUUID();
    const invocationStartedAt = new Date().toISOString();
    const workspaceBefore = await captureWorkspaceSnapshot(workspaceRoot);
    let lastActivityAt = Date.now();
    const recordActivity = (source: 'stdout' | 'stderr') => {
      lastActivityAt = Date.now();
      onActivity?.(source);
    };

    diagLog(`EXECUTION_START executionId=${executionId} taskId=${taskId} stage=${stage} agent=${agentName} serverInstanceId=${serverInstanceId}`);
    diagLog(`TIMEOUT_CONFIG executionId=${executionId} taskId=${taskId} inactivityTimeoutMs=${inactivityTimeoutMs ?? 'disabled'} maxExecutionTimeoutMs=${maxExecutionTimeoutMs} lastActivityAt=${new Date(lastActivityAt).toISOString()}`);

    if (process.env.AGENTOS_FORCE_MOCK === 'true') {
      ctx.onInvocationStarted?.({
        invocationId, cliKind, commandLabel,
        ...(config.model ? { model: config.model } : {}),
        thinkingEffort: config.thinkingEffort ?? 'auto',
        startedAt: invocationStartedAt,
      });
      const result = MockCLI.run(agentName, preparedPrompt);
      const log = this.buildLog(stage, agentName, result.stdout, result.stderr, 0, startTime, 'mock');
      recordActivity('stdout');
      await this.persistLog(log, workspaceRoot, taskId);
      for (const event of new PlainTextAdapter().createParser().push(result.stdout)) ctx.onRuntimeEvent?.(event);
      if (onChunk) {
        onChunk(result.stdout, false);
        onChunk('', true);
      }
      const completedAt = new Date().toISOString();
      ctx.onInvocationCompleted?.({
        invocationId, cliKind, commandLabel, exitCode: 0, durationMs: Date.now() - startTime,
        startedAt: invocationStartedAt, completedAt,
        model: config.model,
        thinkingEffort: config.thinkingEffort ?? 'auto',
      });
      const workspaceAfter = await captureWorkspaceSnapshot(workspaceRoot);
      ctx.onFileChanges?.(diffWorkspaceSnapshots(workspaceBefore, workspaceAfter));
      diagLog(`EXECUTION_END executionId=${executionId} taskId=${taskId} mode=mock exitCode=0`);
      return log;
    }

    const resolvedRuntime = resolveAgentRuntimeConfig(config, {
      ...process.env,
      AGENTOS_WORKSPACE_ROOT: workspaceRoot,
    });
    const childEnv = resolvedRuntime.env;
    const resolved = await resolveCommand(config.cliCommand, childEnv);
    if (!resolved) {
      diagLog(`EXECUTION_FAIL executionId=${executionId} taskId=${taskId} reason=command_not_found cmd=${config.cliCommand}`);
      const log = this.buildLog(stage, agentName, '', '', null, startTime, 'real');
      throw new CLIError(
        `${agentName} (${stage}): command not found: ${config.cliCommand}`,
        stage,
        null,
        '',
        log,
      );
    }

    const adapterResolution = await new AgentCliAdapterRegistry().resolve(resolved);
    const adapter = adapterResolution.adapter;
    const runtimeParser = adapter.createParser();
    if (adapterResolution.diagnostic) ctx.onRuntimeEvent?.(adapterResolution.diagnostic);

    let stdout = '';
    let stderr = '';

    const emitRuntimeEvents = (events: NormalizedCliEvent[]) => {
      for (const event of events) {
        ctx.onRuntimeEvent?.(event);
        if (event.type === 'assistant.message') {
          stdout += event.text;
          onChunk?.(event.text, false);
        }
      }
    };

    let invocation: CommandInvocation;
    const kimiCodeHome = config.role === 'kimi_worker'
      ? (process.env.AGENTOS_KIMI_CODE_HOME ?? join(workspaceRoot, '.agentos', 'kimi-code'))
      : undefined;
    try {
      const cliArgs = [
        ...adapter.decorateArgs(resolvedRuntime.cliArgs),
        ...imagePlan.cliArgs,
      ];
      if (kimiCodeHome) {
        const sourceKimiHome = process.env.KIMI_CODE_HOME ?? join(homedir(), '.kimi-code');
        await prepareKimiCodeHome(sourceKimiHome, kimiCodeHome);
      }
      invocation = await createCommandInvocation(resolved, cliArgs, preparedPrompt, process.platform, {
        promptViaStdin: imagePlan.transport === 'cli-flag',
      });
      diagLog(`CLI_RUNTIME_RESOLUTION executionId=${executionId} taskId=${taskId} stage=${stage} cliKind=${resolvedRuntime.cliKind} commandLabel=${commandLabel} model=${config.model?.trim() || 'default'} thinkingEffort=${config.thinkingEffort ?? 'auto'} argCount=${cliArgs.length} promptTransport=${imagePlan.transport}`);
    } catch (err) {
      const message = `${kimiCodeHome ? 'Kimi runtime setup failed' : 'Agent startup preparation failed'}: ${err instanceof Error ? err.message : String(err)}`;
      diagLog(`EXECUTION_FAIL executionId=${executionId} taskId=${taskId} reason=setup_error message=${message}`);
      throw await this.createStartupError(stage, agentName, workspaceRoot, taskId, startTime, message);
    }

    let child: ChildProcess;
    try {
      ctx.onInvocationStarted?.({
        invocationId, cliKind: resolvedRuntime.cliKind, commandLabel: toCommandLabel(resolvedRuntime.cliKind),
        ...(config.model ? { model: config.model } : {}),
        thinkingEffort: config.thinkingEffort ?? 'auto',
        startedAt: invocationStartedAt,
      });
      childEnv.AGENTOS_TASK_ID = taskId;
      childEnv.AGENTOS_DIAG_LOG_DIR = DIAG_LOG_DIR;
      childEnv.AGENTOS_SERVER_INSTANCE_ID = process.env.AGENTOS_SERVER_INSTANCE_ID ?? 'unknown';
      if (kimiCodeHome) childEnv.KIMI_CODE_HOME = kimiCodeHome;
      const kimiAuth = config.role === 'kimi_worker'
        ? (childEnv.KIMI_MODEL_API_KEY ? 'api_key' : 'oauth')
        : 'n/a';
      diagLog(`CLI_ENV_RESOLUTION executionId=${executionId} taskId=${taskId} agent=${config.role} command=${config.cliCommand} kimiAuth=${kimiAuth} CODEX_HOME=${childEnv.CODEX_HOME ?? 'undefined'} HOME=${childEnv.HOME ?? 'undefined'} USERPROFILE=${childEnv.USERPROFILE ?? 'undefined'}`);
      child = spawn(invocation.command, invocation.args, {
        shell: false,
        cwd: workspaceRoot,
        env: childEnv,
        windowsHide: true,
        stdio: [invocation.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
      if (invocation.stdin !== undefined) child.stdin?.end(invocation.stdin);
      diagLog(`CHILD_SPAWN executionId=${executionId} taskId=${taskId} childPid=${child.pid} parentPid=${process.pid} command=${invocation.command} cwd=${workspaceRoot}`);
    } catch (err) {
      await safeCleanup(invocation.cleanup);
      const message = `Agent process failed to start: ${err instanceof Error ? err.message : String(err)}`;
      diagLog(`CHILD_SPAWN_FAIL executionId=${executionId} taskId=${taskId} reason=${message}`);
      throw await this.createStartupError(stage, agentName, workspaceRoot, taskId, startTime, message);
    }

    const stdoutDecoder = new TextDecoder('utf-8');
    const stderrDecoder = new TextDecoder('utf-8');

    child.stdout!.on('data', (chunk: Buffer) => {
      const text = stdoutDecoder.decode(chunk, { stream: true });
      recordActivity('stdout');
      emitRuntimeEvents(runtimeParser.push(text));
    });

    child.stderr!.on('data', (chunk: Buffer) => {
      stderr += stderrDecoder.decode(chunk, { stream: true });
      recordActivity('stderr');
    });

    const exitCode = await new Promise<number | null>((resolve) => {
      let abortTriggered = false;
      let inactivityTimedOut = false;
      let maxExecutionTimedOut = false;
      let settled = false;
      let inactivityTimer: ReturnType<typeof setInterval> | undefined;
      let maxExecutionTimer: ReturnType<typeof setTimeout> | undefined;

      const clearExecutionTimers = () => {
        if (inactivityTimer) clearInterval(inactivityTimer);
        if (maxExecutionTimer) clearTimeout(maxExecutionTimer);
      };

      const settle = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearExecutionTimers();
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve(code);
      };

      const killChild = (reason: 'cancelled' | 'inactivity_timeout' | 'max_execution_time') => {
        diagLog(`CHILD_KILL executionId=${executionId} taskId=${taskId} childPid=${child.pid} reason=${reason} lastActivityAt=${new Date(lastActivityAt).toISOString()}`);
        if (process.platform === 'win32') {
          child.kill();
        } else {
          child.kill('SIGTERM');
          setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000);
        }
      };

      const onAbort = () => {
        if (abortTriggered) return;
        abortTriggered = true;
        const killReason = signal?.aborted ? 'AbortSignal triggered' : 'unknown';
        stderr += `\n[AgentOS] Pipeline cancelled, killing process.`;
        diagLog(`ABORT_TRIGGERED executionId=${executionId} taskId=${taskId} reason=${killReason} childPid=${child.pid} parentPid=${process.pid}`);
        killChild('cancelled');
        settle(null);
      };

      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      if (inactivityTimeoutMs !== null) {
        inactivityTimer = setInterval(() => {
          const inactiveForMs = Date.now() - lastActivityAt;
          if (inactivityTimedOut || inactiveForMs < inactivityTimeoutMs) return;

          inactivityTimedOut = true;
          stderr += `\n[AgentOS] Agent inactive for ${inactiveForMs}ms (threshold ${inactivityTimeoutMs}ms), killing process.`;
          diagLog(`TIMEOUT_TRIGGERED executionId=${executionId} taskId=${taskId} reason=inactivity_timeout inactivityTimeoutMs=${inactivityTimeoutMs} inactiveForMs=${inactiveForMs} lastActivityAt=${new Date(lastActivityAt).toISOString()} childPid=${child.pid}`);
          killChild('inactivity_timeout');
          settle(null);
        }, Math.max(25, Math.min(inactivityTimeoutMs, 1000)));
      }

      maxExecutionTimer = setTimeout(() => {
        if (settled) return;
        maxExecutionTimedOut = true;
        stderr += `\n[AgentOS] Max execution time exceeded (${maxExecutionTimeoutMs}ms).`;
        diagLog(`TIMEOUT_TRIGGERED executionId=${executionId} taskId=${taskId} reason=max_execution_time maxExecutionTimeoutMs=${maxExecutionTimeoutMs} childPid=${child.pid}`);
        killChild('max_execution_time');
        settle(null);
      }, maxExecutionTimeoutMs);

      child.on('close', (code, closeSignal) => {
        diagLog(`CHILD_CLOSE executionId=${executionId} taskId=${taskId} childPid=${child.pid} code=${code} signal=${closeSignal ?? 'none'} hadAbort=${abortTriggered} inactivityTimedOut=${inactivityTimedOut} maxExecutionTimedOut=${maxExecutionTimedOut} lastActivityAt=${new Date(lastActivityAt).toISOString()}`);
        settle(code);
      });

      child.on('error', (err) => {
        stderr += `\n[AgentOS] Spawn error: ${err.message}`;
        diagLog(`CHILD_ERROR executionId=${executionId} taskId=${taskId} childPid=${child.pid} error=${err.message}`);
        settle(null);
      });
    });

    const finalStdout = stdoutDecoder.decode();
    if (finalStdout) emitRuntimeEvents(runtimeParser.push(finalStdout));
    emitRuntimeEvents(runtimeParser.finish());
    stderr += stderrDecoder.decode();
    const invocationCompletedAt = new Date().toISOString();
    ctx.onInvocationCompleted?.({
      invocationId, cliKind: resolvedRuntime.cliKind, commandLabel: toCommandLabel(resolvedRuntime.cliKind),
      exitCode, durationMs: Date.now() - startTime, startedAt: invocationStartedAt, completedAt: invocationCompletedAt,
      model: config.model,
      thinkingEffort: config.thinkingEffort ?? 'auto',
    });
    const workspaceAfter = await captureWorkspaceSnapshot(workspaceRoot);
    ctx.onFileChanges?.(diffWorkspaceSnapshots(workspaceBefore, workspaceAfter));
    await safeCleanup(invocation.cleanup);

    const log = this.buildLog(stage, agentName, stdout, stderr, exitCode, startTime, 'real');
    await this.persistLog(log, workspaceRoot, taskId);

    if (onChunk) onChunk('', true);

    if (exitCode !== 0) {
      const safeDetail = publicFailureDetail(stderr, stdout);
      diagLog(`EXECUTION_FAIL executionId=${executionId} taskId=${taskId} exitCode=${exitCode} stdoutLength=${stdout.length} stderrLength=${stderr.length}`);
      throw new CLIError(
        `${agentName} (${stage}) failed with exit code ${exitCode}${safeDetail ? `: ${safeDetail}` : ''}`,
        stage,
        exitCode,
        '',
        log,
      );
    }

    diagLog(`EXECUTION_END executionId=${executionId} taskId=${taskId} exitCode=${exitCode} duration=${Date.now() - startTime}ms`);
    return log;
  }

  private static buildLog(
    stage: AgentStage,
    agentName: string,
    stdout: string,
    stderr: string,
    exitCode: number | null,
    startTime: number,
    mode: 'real' | 'mock',
  ): TaskLog {
    return {
      stage,
      agentName,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exitCode,
      timestamp: new Date().toISOString(),
      duration: Date.now() - startTime,
      mode,
    };
  }

  private static async createStartupError(
    stage: AgentStage,
    agentName: string,
    workspaceRoot: string,
    taskId: string,
    startTime: number,
    message: string,
  ): Promise<CLIError> {
    const log = this.buildLog(stage, agentName, '', message, null, startTime, 'real');
    try {
      await this.persistLog(log, workspaceRoot, taskId);
    } catch (err) {
      log.stderr += `\n[AgentOS] Failed to persist startup log: ${err instanceof Error ? err.message : String(err)}`;
    }
    return new CLIError(`${agentName} (${stage}): ${message}`, stage, null, log.stderr, log);
  }

  private static async persistLog(log: TaskLog, workspaceRoot: string, taskId: string): Promise<void> {
    await this.appendToAgentLog(log, workspaceRoot, taskId);
    await this.writeTaskLog(log, workspaceRoot, taskId);
  }

  private static agentMemoryDir(workspaceRoot: string): string {
    return join(workspaceRoot, 'agent-memory');
  }

  private static logsDir(workspaceRoot: string): string {
    return join(workspaceRoot, '.agentos', 'logs');
  }

  private static async appendToAgentLog(log: TaskLog, workspaceRoot: string, taskId: string): Promise<void> {
    const dir = this.agentMemoryDir(workspaceRoot);
    await mkdir(dir, { recursive: true });
    const line = `| ${new Date().toISOString()} | ${log.agentName} | ${log.stage} | ${taskId} | ${log.mode ?? 'real'} | ${log.exitCode === 0 ? 'OK' : 'FAIL'} |\n`;
    const filePath = join(dir, 'LOG.md');
    const file = await open(filePath, 'a+');
    try {
      if ((await file.stat()).size === 0) {
        await file.writeFile('# Agent Execution Log\n\n| Time | Agent | Action | Task ID | Mode | Result |\n|------|-------|--------|---------|------|--------|\n', 'utf-8');
      }
      await file.appendFile(line, 'utf-8');
    } finally {
      await file.close();
    }
  }

  private static async writeTaskLog(log: TaskLog, workspaceRoot: string, taskId: string): Promise<void> {
    const logDir = join(this.logsDir(workspaceRoot), taskId);
    await mkdir(logDir, { recursive: true });
    const filePath = join(logDir, `${log.stage}.log`);
    const content = [
      `=== ${log.agentName} (${log.stage}) ===`,
      `Timestamp: ${log.timestamp}`,
      `Duration: ${log.duration}ms`,
      `Exit Code: ${log.exitCode}`,
      `Mode: ${log.mode ?? 'real'}`,
      `Stdout: ${log.stdout.length} chars (content omitted)`,
      `Stderr: ${log.stderr.length} chars (content omitted)`,
      '',
      'CLI output is intentionally omitted from persisted logs.',
      '',
    ].join('\n');
    await writeFile(filePath, content, 'utf-8');
  }
}

function toCommandLabel(cliKind: string): string {
  if (cliKind === 'codex') return 'codex exec';
  if (cliKind === 'kimi') return 'kimi -p';
  if (cliKind === 'opencode') return 'opencode run';
  return 'agent cli';
}

function publicFailureDetail(stderr: string, stdout: string): string {
  const agentOsLines = stderr.split(/\r?\n/).map(line => line.trim()).filter(line => line.startsWith('[AgentOS]'));
  if (agentOsLines.length > 0) return agentOsLines.join(' ');
  return stdout.length > 0 || stderr.length > 0 ? 'CLI 输出已省略' : '';
}
