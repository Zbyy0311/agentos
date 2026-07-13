import type {
  AgentProfile,
  ConversationMessage,
  ExecutionStatus,
} from '@agentos/shared';
import { CLIExecutor, type ExecuteContext } from './executor.js';
import { isCodexCli, isOpenCodeCli } from './config.js';
import type { AgentConfig } from './types.js';
import type { AgentImageAttachment } from './imageInput.js';

export interface ConversationExecutionEvent {
  status: ExecutionStatus;
  activity: string;
  content?: string;
}

export interface ConversationRunResult {
  status: Extract<ExecutionStatus, 'completed' | 'failed' | 'cancelled'>;
  content: string;
  error?: string;
  mode: 'real' | 'mock';
  startedAt: string;
  completedAt: string;
}

export interface ConversationAgentRunnerOptions {
  agent: AgentProfile;
  runtimeOverrides?: Pick<AgentProfile, 'model' | 'thinkingEffort'>;
  workspaceRoot: string;
  executionId: string;
  message: string;
  history: ConversationMessage[];
  attachments?: AgentImageAttachment[];
  signal?: AbortSignal;
  onEvent?: (event: ConversationExecutionEvent) => void;
}

export class ConversationAgentRunner {
  constructor(private readonly options: ConversationAgentRunnerOptions) {}

  async run(): Promise<ConversationRunResult> {
    const startedAt = new Date().toISOString();
    this.emit('preparing_context', '正在准备会话上下文');
    const prompt = buildConversationPrompt(this.options.agent, this.options.history, this.options.message);
    this.emit('running_cli', '正在调用 Agent CLI');

    let emittedContent = false;
    const context: ExecuteContext = {
      workspaceRoot: this.options.workspaceRoot,
      taskId: this.options.executionId,
      signal: this.options.signal,
      onChunk: (content) => {
        if (!content) return;
        emittedContent = true;
        this.emit('streaming_response', '正在生成回复', content);
      },
    };

    try {
      const log = await CLIExecutor.execute(toAgentConfig(this.options.agent, this.options.runtimeOverrides, this.options.attachments), prompt, context);
      if (log.exitCode !== 0) {
        const detail = log.stderr || log.stdout || 'no CLI output';
        throw new Error(`${this.options.agent.name} CLI failed with exit code ${log.exitCode}: ${detail}`);
      }
      const content = log.stdout || log.stderr;
      if (!emittedContent && content) this.emit('streaming_response', '正在生成回复', content);
      this.emit('completed', '执行完成');
      return {
        status: 'completed',
        content,
        mode: log.mode ?? 'real',
        startedAt,
        completedAt: new Date().toISOString(),
      };
    } catch (error) {
      const cancelled = this.options.signal?.aborted === true;
      const message = error instanceof Error ? error.message : String(error);
      this.emit(cancelled ? 'cancelled' : 'failed', cancelled ? '执行已取消' : '执行失败', message);
      return {
        status: cancelled ? 'cancelled' : 'failed',
        content: '',
        error: message,
        mode: 'real',
        startedAt,
        completedAt: new Date().toISOString(),
      };
    }
  }

  private emit(status: ExecutionStatus, activity: string, content?: string): void {
    this.options.onEvent?.({ status, activity, ...(content ? { content } : {}) });
  }
}

function toAgentConfig(
  agent: AgentProfile,
  runtimeOverrides?: Pick<AgentProfile, 'model' | 'thinkingEffort'>,
  attachments?: AgentImageAttachment[],
): AgentConfig {
  let cliArgs = agent.cliArgs;
  if (process.env.AGENTOS_FORCE_MOCK !== 'true' && !agent.permissions.includes('write')) {
    if (!isCodexCli(agent.cliCommand) && !isOpenCodeCli(agent.cliCommand)) {
      throw new Error(
        `${agent.name} 的 CLI 不支持只读沙箱模式，无法限制执行权限。` +
        `如需使用 ${agent.name}，请为其赋予 'write' 权限，或设置 AGENTOS_FORCE_MOCK=true。`,
      );
    }
    if (isCodexCli(agent.cliCommand)) {
      const argsWithoutSandbox = agent.cliArgs.filter((arg, index) =>
        arg !== '--dangerously-bypass-approvals-and-sandbox'
        && arg !== '--sandbox'
        && agent.cliArgs[index - 1] !== '--sandbox');
      cliArgs = ['--sandbox', 'read-only', ...argsWithoutSandbox];
    }
  }
  return {
    name: agent.name,
    role: agent.role === 'kimi'
      ? 'kimi_worker'
      : agent.role === 'opencode' || agent.role === 'mimo'
        ? 'opencode_reviewer'
        : 'codex_manager',
    cliCommand: agent.cliCommand,
    cliArgs,
    model: runtimeOverrides?.model ?? agent.model,
    thinkingEffort: runtimeOverrides?.thinkingEffort ?? agent.thinkingEffort ?? 'auto',
    ...(attachments?.length ? { imageAttachments: attachments } : {}),
  };
}

function buildConversationPrompt(
  agent: AgentProfile,
  history: ConversationMessage[],
  message: string,
): string {
  const priorMessages = history.slice(-12).map(item => {
    const sender = item.senderType === 'user' ? '用户' : item.senderType === 'agent' ? agent.name : '系统';
    return `${sender}: ${item.content}`;
  }).join('\n');

  return [
    `你是 ${agent.name}，身份是${agent.roleTitle}。`,
    agent.systemPrompt,
    '',
    '请依据你的职责和权限完成用户请求。仅输出用户可见的结论、执行进度和必要证据；不要输出私有思维链。',
    '这是一次单轮 CLI 调用，不要等待进一步确认。',
    priorMessages ? `## 最近会话\n${priorMessages}` : '',
    '## 当前用户消息',
    message,
  ].filter(Boolean).join('\n');
}
