import type {
  CliInvocationObservation,
  AgentProfile,
  ConversationMessage,
  ExecutionStatus,
  RunFileChange,
} from '@agentos/shared';
import { CLIError, CLIExecutor, type ExecuteContext } from './executor.js';
import { isCodexCli, isOpenCodeCli } from './config.js';
import type { AgentConfig } from './types.js';
import type { AgentImageAttachment } from './imageInput.js';
import type { NormalizedCliEvent } from './adapters/types.js';

export interface ConversationExecutionEvent {
  status: ExecutionStatus;
  activity: string;
  content?: string;
}

export interface ConversationRunResult {
  status: Extract<ExecutionStatus, 'waiting_user' | 'completed' | 'failed' | 'cancelled'>;
  content: string;
  waitingQuestion?: string;
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
  onInvocationStarted?: (observation: CliInvocationObservation) => void;
  onInvocationCompleted?: (observation: Required<Pick<CliInvocationObservation, 'invocationId' | 'cliKind' | 'commandLabel' | 'startedAt' | 'completedAt' | 'exitCode' | 'durationMs'>> & Pick<CliInvocationObservation, 'model' | 'thinkingEffort'>) => void;
  onFileChanges?: (changes: Array<Omit<RunFileChange, 'runId'>>) => void;
  onRuntimeEvent?: (event: NormalizedCliEvent) => void;
}

export class ConversationAgentRunner {
  constructor(private readonly options: ConversationAgentRunnerOptions) {}

  async run(): Promise<ConversationRunResult> {
    const startedAt = new Date().toISOString();
    this.emit('preparing_context', '正在准备会话上下文');
    const prompt = buildConversationPrompt(this.options.agent, this.options.history, this.options.message);
    this.emit('running_cli', '正在调用 Agent CLI');

    let streamedContent = '';
    let pendingStreamContent = '';
    let emittedStreamContent = false;
    const context: ExecuteContext = {
      workspaceRoot: this.options.workspaceRoot,
      taskId: this.options.executionId,
      signal: this.options.signal,
      onInvocationStarted: this.options.onInvocationStarted,
      onInvocationCompleted: this.options.onInvocationCompleted,
      onFileChanges: this.options.onFileChanges,
      onRuntimeEvent: this.options.onRuntimeEvent,
      onChunk: (content) => {
        if (!content) return;
        streamedContent += content;
        pendingStreamContent += content;
        if (isPotentialWaitingUserMarker(pendingStreamContent)) return;
        this.emit('streaming_response', '正在生成回复', pendingStreamContent);
        pendingStreamContent = '';
        emittedStreamContent = true;
      },
    };

    try {
      const log = await CLIExecutor.execute(toAgentConfig(this.options.agent, this.options.runtimeOverrides, this.options.attachments), prompt, context);
      if (log.exitCode !== 0) {
        throw new Error(`${this.options.agent.name} CLI failed with exit code ${log.exitCode}; CLI output omitted`);
      }
      const content = streamedContent || log.stdout || log.stderr;
      const waiting = parseWaitingUserMarker(content);
      if (waiting) {
        this.emit('waiting_user', '等待用户补充信息', waiting.question);
        return {
          status: 'waiting_user',
          content: '',
          waitingQuestion: waiting.question,
          mode: log.mode ?? 'real',
          startedAt,
          completedAt: new Date().toISOString(),
        };
      }
      if (pendingStreamContent) {
        this.emit('streaming_response', '正在生成回复', pendingStreamContent);
        emittedStreamContent = true;
      } else if (!emittedStreamContent && content) {
        this.emit('streaming_response', '正在生成回复', content);
      }
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
      const message = cancelled
        ? `${this.options.agent.name} 执行已取消`
        : error instanceof CLIError
          ? `${this.options.agent.name} CLI 执行失败${error.exitCode === null ? '' : `（退出码 ${error.exitCode}）`}，诊断输出已省略`
          : error instanceof Error ? error.message : String(error);
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

const WAITING_USER_MARKER_START = '<!-- agentos-waiting-user';

function isPotentialWaitingUserMarker(content: string): boolean {
  const trimmed = content.trimStart();
  return WAITING_USER_MARKER_START.startsWith(trimmed) || trimmed.startsWith(WAITING_USER_MARKER_START);
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
    '如果缺少完成任务所必需的用户信息，停止执行并输出唯一的等待标记：<!-- agentos-waiting-user: {"question":"需要用户补充的信息"} -->。不要在普通成功结果中输出该标记。',
    priorMessages ? `## 最近会话\n${priorMessages}` : '',
    '## 当前用户消息',
    message,
  ].filter(Boolean).join('\n');
}

function parseWaitingUserMarker(content: string): { question: string } | undefined {
  const match = content.match(/^\s*<!--\s*agentos-waiting-user\s*:\s*(\{[\s\S]*?\})\s*-->\s*$/im);
  if (!match) return undefined;
  try {
    const value: unknown = JSON.parse(match[1]!);
    const question = value && typeof value === 'object' && typeof (value as { question?: unknown }).question === 'string'
      ? (value as { question: string }).question.trim()
      : '';
    if (!question) throw new Error('Agent waiting question is invalid');
    return { question };
  } catch (error) {
    if (error instanceof Error && error.message === 'Agent waiting question is invalid') throw error;
    throw new Error('Agent waiting question is invalid');
  }
}
