export type TaskStatus = 'pending' | 'running' | 'reviewing' | 'completed' | 'failed' | 'cancelled';

export type AgentRole = 'codex' | 'kimi' | 'opencode' | 'mimo';

export type AgentPermission = 'read' | 'write' | 'review';

export type ThinkingEffort = 'auto' | 'low' | 'medium' | 'high';

export type ModelDiscoverySource = 'live' | 'cache' | 'config' | 'fallback';

export type ConversationType = 'direct' | 'group';

export type MessageSenderType = 'user' | 'agent' | 'system';

export type ExecutionStatus = 'queued' | 'preparing_context' | 'running_cli' | 'streaming_response' | 'completed' | 'failed' | 'cancelled';

export type AgentStage =
  | 'codex_manager'
  | 'kimi_worker'
  | 'opencode_reviewer'
  | 'codex_final_review';

export interface WorkspaceAgent {
  id: string;
  name: string;
  role: AgentRole;
  enabled: boolean;
  cliCommand: string;
  cliArgs: string[];
  model?: string;
  thinkingEffort?: ThinkingEffort;
}

export interface AgentCapability {
  role: AgentRole;
  cliKind: 'kimi' | 'opencode' | 'codex' | 'unknown';
  models: string[];
  modelOptions?: AgentModelOption[];
  modelSource?: ModelDiscoverySource;
  modelSourceStale?: boolean;
  modelSourceWarning?: string;
  thinkingEfforts: ThinkingEffort[];
  defaultModel?: string;
  defaultThinkingEffort: ThinkingEffort;
}

export interface AgentModelOption {
  id: string;
  label: string;
  thinkingEfforts: ThinkingEffort[];
  defaultThinkingEffort: ThinkingEffort;
}

export interface ModelDiscoveryResult {
  cliKind: AgentCapability['cliKind'];
  models: AgentModelOption[];
  source: ModelDiscoverySource;
  stale: boolean;
  discoveredAt: string;
  warning?: string;
}

export interface AgentProfile extends WorkspaceAgent {
  capability?: AgentCapability;
  workspaceId: string;
  roleTitle: string;
  systemPrompt: string;
  permissions: AgentPermission[];
  createdAt: string;
  updatedAt: string;
}

export interface Conversation {
  id: string;
  workspaceId: string;
  type: ConversationType;
  title: string;
  agentId?: string;
  model?: string;
  thinkingEffort?: ThinkingEffort;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationMember {
  conversationId: string;
  agentId: string;
  roleTitle: string;
  isLeader: boolean;
  createdAt: string;
}

export interface ConversationAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  url: string;
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  workspaceId: string;
  senderType: MessageSenderType;
  senderAgentId?: string;
  content: string;
  attachments?: ConversationAttachment[];
  createdAt: string;
}

export interface AgentExecution {
  id: string;
  conversationId: string;
  workspaceId: string;
  sourceMessageId: string;
  agentId: string;
  status: ExecutionStatus;
  mode: 'real' | 'mock';
  error?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionEvent {
  id: string;
  executionId: string;
  status: ExecutionStatus;
  activity: string;
  content?: string;
  createdAt: string;
}

export interface Workspace {
  id: string;
  name: string;
  rootPath: string;
  gitEnabled: boolean;
  memoryEnabled: boolean;
  agents: WorkspaceAgent[];
  lastOpenedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskItem {
  id: string;
  workspaceId: string;
  title: string;
  status: TaskStatus;
  currentAgent: AgentStage | null;
  outputs: TaskLog[];
  lastActivityAt?: string;
  error?: string;
  reviewDecision?: 'approve' | 'reject' | 'modify' | 'unknown';
  reviewBlocked?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TaskLog {
  stage: AgentStage;
  agentName: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timestamp: string;
  duration: number;
  mode?: 'real' | 'mock';
}

export interface AgentResult {
  stage: AgentStage;
  agentName: string;
  success: boolean;
  message: string;
  log: TaskLog;
}

export interface TaskStatusResponse {
  task: TaskItem;
  logs: TaskLog[];
}

export interface ThinkingChunk {
  stage: AgentStage;
  agentName: string;
  text: string;
  done: boolean;
}
