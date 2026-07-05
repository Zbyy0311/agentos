import { spawn } from 'node:child_process';
import { writeFile, appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { MockCLI } from './mock.js';
import { resolveCommand } from './resolveCommand.js';
import type { AgentConfig, ChunkCallback } from './types.js';
import type { TaskLog, AgentStage } from '@agentos/shared';

const AGENT_TIMEOUT_MS = parseInt(process.env.AGENTOS_AGENT_TIMEOUT ?? '300000', 10);

export interface ExecuteContext {
  workspaceRoot: string;
  taskId: string;
  onChunk?: ChunkCallback;
}

export class CLIError extends Error {
  constructor(
    message: string,
    public stage: AgentStage,
    public exitCode: number | null,
    public stderr: string,
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
    const { workspaceRoot, taskId, onChunk } = ctx;
    const startTime = Date.now();
    const stage = config.role;
    const agentName = config.name;

    // Explicit mock mode — read env at call time so tests can toggle it
    if (process.env.AGENTOS_FORCE_MOCK === 'true') {
      const result = MockCLI.run(agentName, prompt);
      const log = this.buildLog(stage, agentName, result.stdout, result.stderr, 0, startTime, 'mock');
      await this.persistLog(log, workspaceRoot, taskId);
      if (onChunk) {
        onChunk(result.stdout, false);
        onChunk('', true);
      }
      return log;
    }

    const resolved = await resolveCommand(config.cliCommand);
    if (!resolved) {
      throw new CLIError(
        `${agentName} (${stage}): command not found: ${config.cliCommand}`,
        stage,
        null,
        '',
      );
    }

    let stdout = '';
    let stderr = '';

    // Windows .cmd/.bat files cannot be spawned directly in Node 22+; wrap with cmd.exe
    const isWindowsBatch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved);
    const command = isWindowsBatch ? 'cmd.exe' : resolved;
    const args = isWindowsBatch
      ? ['/c', resolved, ...config.cliArgs, prompt]
      : [...config.cliArgs, prompt];

    const child = spawn(command, args, {
      shell: false,
      cwd: workspaceRoot,
      env: { ...process.env, AGENTOS_TASK_ID: taskId },
      windowsHide: true,
    });

    child.stdout!.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      if (onChunk) onChunk(text, false);
    });

    child.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const exitCode = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        stderr += `\n[AgentOS] Agent timed out after ${AGENT_TIMEOUT_MS / 1000}s, killing process.`;
        // On Windows, child.kill() (without signal) sends a proper
        // process termination that triggers the 'close' event.
        // On POSIX, use SIGTERM then SIGKILL as backup.
        if (process.platform === 'win32') {
          child.kill();
        } else {
          child.kill('SIGTERM');
          setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000);
        }
      }, AGENT_TIMEOUT_MS);

      child.on('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        stderr += `\n[AgentOS] Spawn error: ${err.message}`;
        resolve(null);
      });
    });

    const log = this.buildLog(stage, agentName, stdout, stderr, exitCode, startTime, 'real');
    await this.persistLog(log, workspaceRoot, taskId);

    if (onChunk) onChunk('', true);

    if (exitCode !== 0) {
      const detail = stderr.trim() || stdout.trim() || 'no output';
      throw new CLIError(
        `${agentName} (${stage}) failed with exit code ${exitCode}: ${detail}`,
        stage,
        exitCode,
        stderr.trim(),
      );
    }

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
    try {
      await appendFile(filePath, line, 'utf-8');
    } catch {
      await writeFile(filePath, '# Agent Execution Log\n\n| Time | Agent | Action | Task ID | Mode | Result |\n|------|-------|--------|---------|------|--------|\n' + line, 'utf-8');
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
      '',
      '--- STDOUT ---',
      log.stdout,
      '',
      '--- STDERR ---',
      log.stderr,
      '',
    ].join('\n');
    await writeFile(filePath, content, 'utf-8');
  }
}
