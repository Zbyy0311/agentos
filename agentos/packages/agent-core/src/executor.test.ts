import { describe, it, expect, beforeEach } from 'vitest';
import { CLIExecutor, CLIError } from './executor.js';
import type { AgentConfig } from './types.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Ensure FORCE_MOCK is off for these tests unless explicitly toggled
process.env.AGENTOS_FORCE_MOCK = 'false';

describe('CLIExecutor', () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'agentos-test-'));
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

  it('throws CLIError with original exit code on failure', async () => {
    let captured: CLIError | undefined;
    await expect(CLIExecutor.execute(failConfig, 'ignored', ctx())).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(CLIError);
      captured = err as CLIError;
      expect(captured.exitCode).toBe(1);
      expect(captured.stage).toBe('codex_manager');
      return true;
    });
    expect(captured).toBeDefined();
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
});
