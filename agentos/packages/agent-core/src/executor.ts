import { spawn } from 'node:child_process';
import { writeFile, appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { MockCLI } from './mock.js';
import type { AgentConfig, ChunkCallback } from './types.js';
import type { TaskLog, AgentStage } from '@agentos/shared';

const AGENT_TIMEOUT_MS = parseInt(process.env.AGENTOS_AGENT_TIMEOUT ?? '300000', 10);

export interface ExecuteContext {
  workspaceRoot: string;
  taskId: string;
  onChunk?: ChunkCallback;
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

    let stdout = '';
    let stderr = '';
    let exitCode: number | null = null;

    const { access } = await import('node:fs/promises');
    let cliExists = false;
    try {
      await access(config.cliCommand);
      cliExists = true;
    } catch {
      cliExists = false;
    }

    if (cliExists && config.cliCommand !== 'echo') {
      // Flatten newlines to prevent Windows cmd.exe from splitting
      // the prompt argument at embedded newlines
      const flatPrompt = prompt.replace(/\r?\n/g, ' ');
      const args = [...config.cliArgs, flatPrompt];
      const child = spawn(config.cliCommand, args, {
        shell: true,
        cwd: workspaceRoot,
        env: { ...process.env, AGENTOS_TASK_ID: taskId },
      });

      child.stdout!.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        if (onChunk) onChunk(text, false);
      });

      child.stderr!.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      exitCode = await new Promise<number | null>((resolve) => {
        const timer = setTimeout(() => {
          stderr += `\n[AgentOS] Agent timed out after ${AGENT_TIMEOUT_MS / 1000}s, killing process.`;
          child.kill('SIGTERM');
          setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000);
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
    } else {
      const mockResult = MockCLI.run(agentName, prompt);
      stdout = mockResult.stdout;
      stderr = mockResult.stderr;
      exitCode = 0;
      if (onChunk) onChunk(stdout, false);
    }

    const duration = Date.now() - startTime;
    if (onChunk) onChunk('', true);

    const log: TaskLog = {
      stage,
      agentName,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exitCode,
      timestamp: new Date().toISOString(),
      duration,
    };

    await this.appendToAgentLog(log, workspaceRoot);
    await this.writeTaskLog(log, workspaceRoot, taskId);

    if (exitCode !== 0) {
      const detail = stderr.trim() || stdout.trim() || 'no output';
      throw new Error(`${agentName} (${stage}) failed with exit code ${exitCode}: ${detail}`);
    }

    return log;
  }

  private static agentMemoryDir(workspaceRoot: string): string {
    return join(workspaceRoot, 'agent-memory');
  }

  private static logsDir(workspaceRoot: string): string {
    return join(workspaceRoot, '.agentos', 'logs');
  }

  private static async appendToAgentLog(log: TaskLog, workspaceRoot: string): Promise<void> {
    const line = `| ${new Date().toISOString()} | ${log.agentName} | ${log.stage} | task | ${log.exitCode === 0 ? 'OK' : 'FAIL'} |\n`;
    const filePath = join(this.agentMemoryDir(workspaceRoot), 'LOG.md');
    try {
      await appendFile(filePath, line, 'utf-8');
    } catch {
      await writeFile(filePath, '# Agent Execution Log\n\n| Time | Agent | Action | Task ID | Result |\n|------|-------|--------|---------|--------|\n' + line, 'utf-8');
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
