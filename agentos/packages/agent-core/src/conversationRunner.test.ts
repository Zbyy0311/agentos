import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentProfile, ExecutionStatus } from '@agentos/shared';
import { ConversationAgentRunner } from './conversationRunner.js';
import { CLIExecutor } from './executor.js';

const originalForceMock = process.env.AGENTOS_FORCE_MOCK;
let workspaceRoot: string;

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'agentos-conversation-runner-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalForceMock === undefined) delete process.env.AGENTOS_FORCE_MOCK;
  else process.env.AGENTOS_FORCE_MOCK = originalForceMock;
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('ConversationAgentRunner', () => {
  it('emits public execution states around a direct agent reply', async () => {
    process.env.AGENTOS_FORCE_MOCK = 'true';
    const states: ExecutionStatus[] = [];
    const agent: AgentProfile = {
      id: 'codex',
      workspaceId: 'workspace-1',
      name: 'Codex',
      role: 'codex',
      roleTitle: '首席架构师',
      systemPrompt: '先分析，再给出可验证结论。',
      permissions: ['read', 'review'],
      enabled: true,
      cliCommand: 'missing-command-is-safe-in-mock-mode',
      cliArgs: [],
      createdAt: '2026-07-12T00:00:00.000Z',
      updatedAt: '2026-07-12T00:00:00.000Z',
    };

    const runner = new ConversationAgentRunner({
      agent,
      workspaceRoot,
      executionId: 'execution-1',
      message: '请检查当前项目的状态。',
      history: [],
      onEvent: event => states.push(event.status),
    });

    const result = await runner.run();

    expect(result.status).toBe('completed');
    expect(result.content.length).toBeGreaterThan(0);
    expect(states).toEqual([
      'preparing_context',
      'running_cli',
      'streaming_response',
      'completed',
    ]);
  });

  it('passes conversation image attachments to the CLI executor', async () => {
    process.env.AGENTOS_FORCE_MOCK = 'false';
    const agent: AgentProfile = {
      id: 'codex', workspaceId: 'workspace-1', name: 'Codex', role: 'codex', roleTitle: '架构师',
      systemPrompt: '分析任务', permissions: ['read', 'write'], enabled: true, cliCommand: 'codex', cliArgs: [],
      createdAt: '2026-07-13T00:00:00.000Z', updatedAt: '2026-07-13T00:00:00.000Z',
    };
    let capturedAttachments: unknown;
    vi.spyOn(CLIExecutor, 'execute').mockImplementation(async (config, prompt) => {
      capturedAttachments = config.imageAttachments;
      expect(prompt).toContain('描述这张图片');
      return { stage: config.role, agentName: config.name, stdout: 'ok', stderr: '', exitCode: 0, timestamp: new Date().toISOString(), duration: 1, mode: 'real' };
    });

    const result = await new ConversationAgentRunner({
      agent, workspaceRoot, executionId: 'execution-image', message: '描述这张图片', history: [],
      attachments: [{ name: 'screen.png', mimeType: 'image/png', absolutePath: 'C:\\workspace\\screen.png' }],
    }).run();

    expect(result.status).toBe('completed');
    expect(capturedAttachments).toEqual([{ name: 'screen.png', mimeType: 'image/png', absolutePath: 'C:\\workspace\\screen.png' }]);
  });

  it('rejects a non-Codex CLI when a profile does not grant write permission', async () => {
    process.env.AGENTOS_FORCE_MOCK = 'false';
    const agent: AgentProfile = {
      id: 'reviewer', workspaceId: 'workspace-1', name: 'Reviewer', role: 'opencode', roleTitle: '审查工程师',
      systemPrompt: '只读审查。', permissions: ['read', 'review'], enabled: true,
      cliCommand: 'node', cliArgs: ['-e', 'console.log("should not run")'],
      createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z',
    };
    const result = await new ConversationAgentRunner({
      agent, workspaceRoot, executionId: 'execution-read-only', message: '检查项目', history: [],
    }).run();

    expect(result.status).toBe('failed');
    expect(result.error).toContain('CLI 不支持只读沙箱模式');
  });

  it('allows a read-only OpenCode reviewer with OpenCode permission flags', async () => {
    process.env.AGENTOS_FORCE_MOCK = 'false';
    vi.spyOn(CLIExecutor, 'execute').mockResolvedValue({
      stage: 'opencode_reviewer', agentName: 'OpenCode', stdout: 'reviewed', stderr: '', exitCode: 0,
      timestamp: '2026-07-12T00:00:00.000Z', duration: 1, mode: 'real',
    });
    const agent: AgentProfile = {
      id: 'opencode', workspaceId: 'workspace-1', name: 'OpenCode', role: 'opencode', roleTitle: 'Reviewer',
      systemPrompt: 'Read-only review.', permissions: ['read', 'review'], enabled: true,
      cliCommand: 'E:\\software\\opencode\\node_modules\\opencode-ai\\bin\\opencode.exe',
      cliArgs: ['--pure', 'run', '--model', 'deepseek/deepseek-v4-flash'],
      model: 'selected-model',
      thinkingEffort: 'auto',
      createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z',
    };

    const result = await new ConversationAgentRunner({
      agent, workspaceRoot, executionId: 'execution-opencode-read-only', message: 'Review the project.', history: [],
    }).run();

    expect(result.status).toBe('completed');
    expect(CLIExecutor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        cliCommand: 'E:\\software\\opencode\\node_modules\\opencode-ai\\bin\\opencode.exe',
        cliArgs: ['--pure', 'run', '--model', 'deepseek/deepseek-v4-flash'],
        model: 'selected-model',
        thinkingEffort: 'auto',
      }),
      expect.any(String),
      expect.any(Object),
    );
  });

  it('places Codex read-only sandbox flags before the exec subcommand', async () => {
    process.env.AGENTOS_FORCE_MOCK = 'false';
    vi.spyOn(CLIExecutor, 'execute').mockResolvedValue({
      stage: 'codex_manager', agentName: 'Codex', stdout: 'ok', stderr: '', exitCode: 0,
      timestamp: '2026-07-12T00:00:00.000Z', duration: 1, mode: 'real',
    });
    const agent: AgentProfile = {
      id: 'codex', workspaceId: 'workspace-1', name: 'Codex', role: 'codex', roleTitle: '架构师',
      systemPrompt: '只读分析。', permissions: ['read', 'review'], enabled: true,
      cliCommand: 'codex', cliArgs: ['exec', '--dangerously-bypass-approvals-and-sandbox', '--sandbox', 'read-only'],
      createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z',
    };

    await new ConversationAgentRunner({
      agent, workspaceRoot, executionId: 'execution-codex-read-only', message: '检查项目', history: [],
    }).run();

    expect(CLIExecutor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        cliArgs: ['--sandbox', 'read-only', 'exec'],
      }),
      expect.any(String),
      expect.any(Object),
    );
  });

  it('uses per-message model and thinking effort overrides without changing the profile', async () => {
    process.env.AGENTOS_FORCE_MOCK = 'false';
    vi.spyOn(CLIExecutor, 'execute').mockResolvedValue({
      stage: 'codex_manager', agentName: 'Codex', stdout: 'ok', stderr: '', exitCode: 0,
      timestamp: '2026-07-12T00:00:00.000Z', duration: 1, mode: 'real',
    });
    const agent: AgentProfile = {
      id: 'codex', workspaceId: 'workspace-1', name: 'Codex', role: 'codex', roleTitle: '架构师',
      systemPrompt: '完成任务。', permissions: ['read', 'write'], enabled: true,
      cliCommand: 'codex', cliArgs: ['exec'], model: 'profile-model', thinkingEffort: 'low',
      createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z',
    };

    await new ConversationAgentRunner({
      agent, workspaceRoot, executionId: 'execution-runtime-override', message: '检查项目', history: [],
      runtimeOverrides: { model: 'turn-model', thinkingEffort: 'high' },
    }).run();

    expect(CLIExecutor.execute).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'turn-model', thinkingEffort: 'high' }),
      expect.any(String),
      expect.any(Object),
    );
    expect(agent.model).toBe('profile-model');
    expect(agent.thinkingEffort).toBe('low');
  });

  it('marks the conversation as failed when the CLI returns a non-zero exit code', async () => {
    process.env.AGENTOS_FORCE_MOCK = 'false';
    vi.spyOn(CLIExecutor, 'execute').mockResolvedValue({
      stage: 'codex_manager', agentName: 'Codex', stdout: 'partial output', stderr: 'fatal error', exitCode: 1,
      timestamp: '2026-07-12T00:00:00.000Z', duration: 1, mode: 'real',
    });
    const agent: AgentProfile = {
      id: 'codex', workspaceId: 'workspace-1', name: 'Codex', role: 'codex', roleTitle: '架构师',
      systemPrompt: '完成任务。', permissions: ['read', 'write'], enabled: true,
      cliCommand: 'codex', cliArgs: [], createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z',
    };

    const result = await new ConversationAgentRunner({
      agent, workspaceRoot, executionId: 'execution-non-zero', message: '执行任务', history: [],
    }).run();

    expect(result.status).toBe('failed');
    expect(result.error).toContain('exit code 1');
  });

  it('pauses on a waiting-user marker without exposing the marker text', async () => {
    process.env.AGENTOS_FORCE_MOCK = 'false';
    vi.spyOn(CLIExecutor, 'execute').mockResolvedValue({
      stage: 'codex_manager',
      agentName: 'Codex',
      stdout: '<!-- agentos-waiting-user: {"question":"请提供部署环境"} -->',
      stderr: '',
      exitCode: 0,
      timestamp: '2026-07-12T00:00:00.000Z',
      duration: 1,
      mode: 'real',
    });
    const states: Array<{ status: ExecutionStatus; content?: string }> = [];
    const agent: AgentProfile = {
      id: 'codex', workspaceId: 'workspace-1', name: 'Codex', role: 'codex', roleTitle: '架构师',
      systemPrompt: '完成任务。', permissions: ['read', 'write'], enabled: true, cliCommand: 'codex', cliArgs: [],
      createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z',
    };

    const result = await new ConversationAgentRunner({
      agent, workspaceRoot, executionId: 'execution-waiting', message: '部署项目', history: [],
      onEvent: event => states.push(event),
    }).run();

    expect(result.status).toBe('waiting_user');
    expect(result.waitingQuestion).toBe('请提供部署环境');
    expect(result.content).toBe('');
    expect(states.map(event => event.status)).toEqual(['preparing_context', 'running_cli', 'waiting_user']);
    expect(states.some(event => event.content?.includes('agentos-waiting-user'))).toBe(false);
  });
});
