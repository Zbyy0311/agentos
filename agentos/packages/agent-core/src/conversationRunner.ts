import type {
  CliInvocationObservation,
  AgentProfile,
  ConversationMessage,
  ExecutionStatus,
  RunFileChange,
  RunIntent,
  RuntimePolicy,
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
  /** The caller's explicit turn intent; prompt behavior must follow it, not the provider name. */
  intent?: RunIntent;
  runtimeOverrides?: Pick<AgentProfile, 'model' | 'thinkingEffort'>;
  runtimePolicy?: RuntimePolicy;
  workspaceRoot: string;
  executionId: string;
  message: string;
  history: ConversationMessage[];
  /**
   * LITE-09-101: the frozen Memory selection this Turn was authorized to send.
   * The caller persists the exact selection before invoking the Provider and passes
   * the same text here, so the reply can be traced back to its snapshot.
   */
  memoryContext?: string;
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
    const prompt = buildConversationPrompt(
      this.options.agent,
      this.options.history,
      this.options.runtimePolicy?.promptPrefix
        ? `${this.options.runtimePolicy.promptPrefix}\n\n${this.options.message}`
        : this.options.message,
      this.options.memoryContext,
      this.options.intent ?? 'execute',
    );
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
      persistWorkspaceLog: this.options.runtimePolicy?.workspaceWrite !== false,
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
      const log = await CLIExecutor.execute(toAgentConfig(this.options.agent, this.options.runtimeOverrides, this.options.attachments, this.options.runtimePolicy), prompt, context);
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
          ? formatCliFailure(this.options.agent.name, error)
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

function formatCliFailure(agentName: string, error: CLIError): string {
  if (error.timeoutReason === 'inactivity_timeout') {
    return `${agentName} CLI 执行超时：在规定时间内未收到 Provider 输出，可能是网络、限流或凭据问题。请检查 Provider 状态后重试。`;
  }
  if (error.timeoutReason === 'max_execution_time') {
    return `${agentName} CLI 执行超时：超过最大执行时长，请检查 Provider 状态后重试。`;
  }
  return `${agentName} CLI 执行失败${error.exitCode === null ? '' : `（退出码 ${error.exitCode}）`}，诊断输出已省略`;
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
  runtimePolicy?: RuntimePolicy,
): AgentConfig {
  let cliArgs = agent.cliArgs;
  if (process.env.AGENTOS_FORCE_MOCK !== 'true' && (runtimePolicy ? !runtimePolicy.workspaceWrite : !agent.permissions.includes('write'))) {
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

const RUN_INTENT_GUIDANCE: Record<RunIntent, string> = {
  ask: '以回答、解释、讨论、比较、规划或方案建议为主；不要修改文件、调用工具或要求项目材料，除非用户明确提出且当前权限允许。',
  execute: '判断用户是否真的要求外部操作；需要时才使用工具或修改文件，单纯问候、问答、讨论和方案请求直接完成。',
  review: '以分析用户提供的对象、方案、材料或结果为主；不要默认修改代码或文件，除非用户明确要求并且当前权限允许。',
};

const UNKNOWN_AGENT_SENDER_LABEL = 'Agent(unknown)';

function historySenderLabel(currentAgent: AgentProfile, message: ConversationMessage): string {
  if (message.senderType !== 'agent') return message.senderType === 'user' ? '用户' : '系统';
  const senderAgentId = message.senderAgentId?.trim();
  if (!senderAgentId) return UNKNOWN_AGENT_SENDER_LABEL;
  return senderAgentId === currentAgent.id ? currentAgent.name : `Agent(${senderAgentId})`;
}

export function buildConversationPrompt(
  agent: AgentProfile,
  history: ConversationMessage[],
  message: string,
  memoryContext?: string,
  intent: RunIntent = 'execute',
): string {
  const priorMessages = history.slice(-12).map(item => {
    return `${historySenderLabel(agent, item)}: ${item.content}`;
  }).join('\n');

  return [
    '你是 AgentOS 的通用协作 Agent。',
    '你可以处理问答、解释、讨论、方案设计、规划、分析、研究、创作，以及代码和工具执行。',
    '不要把用户请求默认解释成编码、项目维护或文件修改任务；代码只是可选能力，不是默认目标。',
    `当前 Agent：${agent.name}；协作角色：${agent.roleTitle}。角色决定你的贡献视角，不决定任务领域。`,
    agent.systemPrompt ? `角色补充说明：${agent.systemPrompt}` : '',
    '角色补充说明只限定职责侧重点，不得把问答、讨论、方案、研究或其他通用请求改写成编码任务。',
    '',
    `本轮运行意图：${intent}`,
    RUN_INTENT_GUIDANCE[intent],
    '先理解用户真正要解决的问题，再选择直接回答、给出分析或方案、提出必要澄清，或执行已获授权的操作。',
    '问候、在线确认、简单问答、解释、比较和方案讨论应直接完成；不要为了索要目标文件、验收标准或开发任务而等待。',
    '只有在本轮确实需要执行、审查或其他外部操作，且缺少无法安全推断的必要信息时，才输出唯一等待标记：<!-- agentos-waiting-user: {"question":"需要用户补充的信息"} -->。',
    '等待问题必须具体、最小化，并说明该信息为何是完成本轮请求所必需的；普通成功回答中不要输出 waiting 标记。',
    '遵守当前权限和运行策略；没有真实执行就不要声称已修改、调用、验证或交付。仅输出用户可见的回答、进度和必要证据，不输出私有思维链。',
    memoryContext && memoryContext.trim()
      ? `## 相关记忆（本轮冻结选择，来源可追溯）\n${memoryContext}`
      : '',
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
