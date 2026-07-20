import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Workspace } from '@agentos/shared';

// Smoke tests run the full AgentRunner pipeline end-to-end. They must work
// without real CLI tools installed, so mock mode is forced for all stages.
process.env.AGENTOS_FORCE_MOCK = 'true';

const { AgentRunner } = await import('./index.js');

describe('AgentRunner smoke test', () => {
  let workspaceRoot: string;
  let workspace: Workspace;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'agentos-smoke-'));

    // Bootstrap the minimal workspace structure that the runner expects.
    mkdirSync(join(workspaceRoot, 'agent-memory'), { recursive: true });
    mkdirSync(join(workspaceRoot, 'docs'), { recursive: true });
    writeFileSync(
      join(workspaceRoot, 'agent-memory', 'LOG.md'),
      '# Agent Execution Log\n\n| Time | Agent | Action | Task ID | Mode | Result |\n|------|-------|--------|---------|------|--------|\n',
    );
    writeFileSync(
      join(workspaceRoot, 'docs', 'AGENT_RULE.md'),
      '# Agent Rules\n\n1. **No memory deletion** — Agents must never delete or overwrite memory files\n',
    );

    workspace = {
      id: 'smoke-ws',
      name: 'Smoke Workspace',
      rootPath: workspaceRoot,
      gitEnabled: false,
      memoryEnabled: true,
      agents: [],
      lastOpenedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  });

  afterEach(() => {
    process.env.AGENTOS_FORCE_MOCK = 'true';
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it('runs the full pipeline in mock mode and persists logs', async () => {
    const runner = new AgentRunner(workspace, 'smoke-task', 'smoke test');
    const result = await runner.runFullPipeline();

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.logs).toHaveLength(4);

    const expectedStages = [
      'codex_manager',
      'kimi_worker',
      'opencode_reviewer',
      'codex_final_review',
    ] as const;

    for (let i = 0; i < expectedStages.length; i++) {
      const log = result.logs[i];
      expect(log.stage).toBe(expectedStages[i]);
      expect(log.exitCode).toBe(0);
      expect(log.mode).toBe('mock');
      expect(log.stdout.length).toBeGreaterThan(0);
      expect(log.duration).toBeGreaterThanOrEqual(0);
    }

    // Verify per-stage log files were written under .agentos/logs/{taskId}.
    const logsDir = join(workspaceRoot, '.agentos', 'logs', 'smoke-task');
    expect(existsSync(logsDir)).toBe(true);
    for (const stage of expectedStages) {
      const logFile = join(logsDir, `${stage}.log`);
      expect(existsSync(logFile)).toBe(true);
      const content = readFileSync(logFile, 'utf-8');
      expect(content).toContain(`Mode: mock`);
      expect(content).toContain(`Exit Code: 0`);
    }

    // Verify the in-memory LOG.md was appended.
    const memoryLog = readFileSync(join(workspaceRoot, 'agent-memory', 'LOG.md'), 'utf-8');
    expect(memoryLog).toContain('| smoke-task | mock | OK |');
  });

  it('exposes intermediate logs via getLogs()', async () => {
    const runner = new AgentRunner(workspace, 'smoke-task', 'smoke test');
    await runner.runCodexManager();
    await runner.runKimiWorker();

    expect(runner.getLogs()).toHaveLength(2);
    expect(runner.getLogs()[0].stage).toBe('codex_manager');
    expect(runner.getLogs()[1].stage).toBe('kimi_worker');
  });
});
