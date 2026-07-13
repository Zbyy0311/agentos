import { describe, expect, it, vi } from 'vitest';
import { copyFileSync, chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Workspace } from '@agentos/shared';
import { CLIExecutor } from './executor.js';
import { AgentRunner } from './runner.js';

describe('AgentRunner configuration propagation', () => {
  it('passes each workspace agent model and thinking effort through all pipeline stages', async () => {
    const workspace: Workspace = {
      id: 'workspace-a',
      name: 'Workspace A',
      rootPath: 'C:\\agentos-test-workspace',
      gitEnabled: true,
      memoryEnabled: true,
      agents: [
        {
          id: 'codex', name: 'Manager', role: 'codex', enabled: true,
          cliCommand: 'codex', cliArgs: ['exec', '--existing'], model: 'manager-model', thinkingEffort: 'high',
        },
        {
          id: 'kimi', name: 'Worker', role: 'kimi', enabled: true,
          cliCommand: 'kimi', cliArgs: ['-p'], model: 'worker-model', thinkingEffort: 'auto',
        },
        {
          id: 'opencode', name: 'Reviewer', role: 'opencode', enabled: true,
          cliCommand: 'codex', cliArgs: ['exec', '--review'], model: 'reviewer-model', thinkingEffort: 'medium',
        },
      ],
      lastOpenedAt: '2026-07-13T00:00:00.000Z',
      createdAt: '2026-07-13T00:00:00.000Z',
      updatedAt: '2026-07-13T00:00:00.000Z',
    };
    const execute = vi.spyOn(CLIExecutor, 'execute').mockImplementation(async config => ({
      stage: config.role,
      agentName: config.name,
      stdout: `completed ${config.role}`,
      stderr: '',
      exitCode: 0,
      timestamp: '2026-07-13T00:00:00.000Z',
      duration: 1,
      mode: 'real',
    }));

    try {
      const result = await new AgentRunner(workspace, 'task-a', 'pipeline propagation').runFullPipeline();

      expect(result.success).toBe(true);
      expect(execute.mock.calls.map(([config]) => ({
        role: config.role,
        cliCommand: config.cliCommand,
        cliArgs: config.cliArgs,
        model: config.model,
        thinkingEffort: config.thinkingEffort,
      }))).toEqual([
        {
          role: 'codex_manager', cliCommand: 'codex', cliArgs: ['exec', '--existing'],
          model: 'manager-model', thinkingEffort: 'high',
        },
        {
          role: 'kimi_worker', cliCommand: 'kimi', cliArgs: ['-p'],
          model: 'worker-model', thinkingEffort: 'auto',
        },
        {
          role: 'opencode_reviewer', cliCommand: 'codex', cliArgs: ['exec', '--review'],
          model: 'reviewer-model', thinkingEffort: 'medium',
        },
        {
          role: 'codex_final_review', cliCommand: 'codex', cliArgs: ['exec', '--existing'],
          model: 'manager-model', thinkingEffort: 'high',
        },
      ]);
    } finally {
      execute.mockRestore();
    }
  });

  it('executes all pipeline stages with final model and effort arguments', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentos-runner-pipeline-'));
    const capturePath = join(root, 'pipeline-capture.ndjson');
    const codexPath = join(root, 'codex.exe');
    const kimiPath = join(root, 'kimi.exe');
    copyFileSync(process.execPath, codexPath);
    copyFileSync(process.execPath, kimiPath);
    chmodSync(codexPath, 0o755);
    chmodSync(kimiPath, 0o755);
    const previousMock = process.env.AGENTOS_FORCE_MOCK;
    const previousCapture = process.env.AGENTOS_PIPELINE_CAPTURE;
    const previousKimiHome = process.env.AGENTOS_KIMI_CODE_HOME;
    const previousAgentKimiApiKey = process.env.AGENTOS_KIMI_API_KEY;
    const previousKimiApiKey = process.env.KIMI_MODEL_API_KEY;
    const fakeArgs = (label: string) => [
      '-e',
      `const fs=require('node:fs');const label=${JSON.stringify(label)};fs.appendFileSync(process.env.AGENTOS_PIPELINE_CAPTURE,JSON.stringify({label,argv:process.argv.slice(1)})+'\\n');console.log(label+' completed');`,
      '--',
    ];
    const workspace: Workspace = {
      id: 'workspace-pipeline',
      name: 'Pipeline Workspace',
      rootPath: root,
      gitEnabled: true,
      memoryEnabled: true,
      agents: [
        {
          id: 'codex', name: 'Codex Manager', role: 'codex', enabled: true,
          cliCommand: codexPath, cliArgs: fakeArgs('codex-manager'), model: 'manager-model', thinkingEffort: 'high',
        },
        {
          id: 'kimi', name: 'Kimi Worker', role: 'kimi', enabled: true,
          cliCommand: kimiPath, cliArgs: fakeArgs('kimi-worker'), model: 'worker-model', thinkingEffort: 'auto',
        },
        {
          id: 'opencode', name: 'Reviewer Fallback', role: 'opencode', enabled: true,
          cliCommand: codexPath, cliArgs: fakeArgs('opencode-reviewer'), model: 'reviewer-model', thinkingEffort: 'medium',
        },
      ],
      lastOpenedAt: '2026-07-13T00:00:00.000Z',
      createdAt: '2026-07-13T00:00:00.000Z',
      updatedAt: '2026-07-13T00:00:00.000Z',
    };

    try {
      process.env.AGENTOS_FORCE_MOCK = 'false';
      process.env.AGENTOS_PIPELINE_CAPTURE = capturePath;
      process.env.AGENTOS_KIMI_CODE_HOME = join(root, 'kimi-home');
      delete process.env.AGENTOS_KIMI_API_KEY;
      delete process.env.KIMI_MODEL_API_KEY;

      const result = await new AgentRunner(workspace, 'pipeline-task', 'pipeline fake CLI').runFullPipeline();
      expect(result.success).toBe(true);
      expect(result.logs).toHaveLength(4);
      expect(result.logs.every(log => log.mode === 'real' && log.exitCode === 0)).toBe(true);

      const entries = readFileSync(capturePath, 'utf-8').trim().split(/\r?\n/)
        .map(line => JSON.parse(line) as { label: string; argv: string[] });
      expect(entries.map(entry => entry.label)).toEqual([
        'codex-manager', 'kimi-worker', 'opencode-reviewer', 'codex-manager',
      ]);
      expect(entries.filter(entry => entry.label === 'codex-manager').every(entry => entry.argv.includes('-m') && entry.argv.includes('manager-model'))).toBe(true);
      expect(entries.filter(entry => entry.label === 'codex-manager').every(entry => entry.argv.includes('model_reasoning_effort=high'))).toBe(true);
      expect(entries.find(entry => entry.label === 'kimi-worker')?.argv).toEqual(expect.arrayContaining(['-m', 'worker-model']));
      expect(entries.find(entry => entry.label === 'kimi-worker')?.argv).not.toContain('model_reasoning_effort=');
      expect(entries.find(entry => entry.label === 'opencode-reviewer')?.argv).toEqual(expect.arrayContaining(['-m', 'reviewer-model', 'model_reasoning_effort=medium']));
    } finally {
      if (previousMock === undefined) delete process.env.AGENTOS_FORCE_MOCK;
      else process.env.AGENTOS_FORCE_MOCK = previousMock;
      if (previousCapture === undefined) delete process.env.AGENTOS_PIPELINE_CAPTURE;
      else process.env.AGENTOS_PIPELINE_CAPTURE = previousCapture;
      if (previousKimiHome === undefined) delete process.env.AGENTOS_KIMI_CODE_HOME;
      else process.env.AGENTOS_KIMI_CODE_HOME = previousKimiHome;
      if (previousAgentKimiApiKey === undefined) delete process.env.AGENTOS_KIMI_API_KEY;
      else process.env.AGENTOS_KIMI_API_KEY = previousAgentKimiApiKey;
      if (previousKimiApiKey === undefined) delete process.env.KIMI_MODEL_API_KEY;
      else process.env.KIMI_MODEL_API_KEY = previousKimiApiKey;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
