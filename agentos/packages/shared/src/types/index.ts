export type TaskStatus = 'pending' | 'running' | 'reviewing' | 'completed' | 'failed' | 'cancelled';

export type AgentRole = 'codex' | 'kimi' | 'opencode' | 'mimo';

export type AgentPermission = 'read' | 'write' | 'review';

export type ThinkingEffort = 'auto' | 'low' | 'medium' | 'high';

export type ModelDiscoverySource = 'live' | 'cache' | 'config' | 'fallback';

export type ConversationType = 'direct' | 'group';

export type MessageSenderType = 'user' | 'agent' | 'system';

export type ExecutionStatus = 'queued' | 'preparing_context' | 'running_cli' | 'streaming_response' | 'waiting_user' | 'completed' | 'failed' | 'cancelled';

export type AgentRunStatus = 'queued' | 'running' | 'waiting_user' | 'completed' | 'failed' | 'cancelled';

export type AgentEventType =
  | 'conversation.message.created'
  | 'run.created'
  | 'run.started'
  | 'run.waiting_user'
  | 'execution.status.changed'
  | 'execution.cli.started'
  | 'execution.cli.completed'
  | 'execution.files.changed'
  | 'execution.output.appended'
  | 'execution.tool.started'
  | 'execution.tool.completed'
  | 'execution.usage.recorded'
  | 'execution.diagnostic'
  | 'execution.artifact.created'
  | 'memory.used'
  | 'memory.candidate.created'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled';

export interface AgentEvent<TPayload = Record<string, unknown>> {
  eventId: string;
  schemaVersion: 1;
  type: AgentEventType;
  workspaceId: string;
  conversationId: string;
  runId: string;
  executionId?: string;
  agentId?: string;
  timestamp: string;
  payload: TPayload;
}

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

export interface AgentRun {
  id: string;
  workspaceId: string;
  conversationId: string;
  sourceMessageId: string;
  objective: string;
  status: AgentRunStatus;
  resultSummary?: string;
  failureReason?: string;
  startedAt?: string;
  completedAt?: string;
  waitingQuestion?: string;
  waitingExecutionId?: string;
  waitingAgentId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentExecution {
  id: string;
  runId: string;
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

export interface RunCliInvocation {
  id: string;
  runId: string;
  executionId: string;
  agentId: string;
  cliKind: string;
  commandLabel: string;
  model?: string;
  thinkingEffort?: ThinkingEffort;
  exitCode: number | null;
  durationMs: number;
  startedAt: string;
  completedAt: string;
}

export interface RunFileChange {
  runId: string;
  path: string;
  changeType: 'created' | 'modified' | 'deleted' | 'renamed';
}

export type RuntimeArtifactType = 'file' | 'diff' | 'report' | 'image' | 'log';

export interface RuntimeArtifact {
  id: string;
  workspaceId: string;
  runId: string;
  sourceExecutionId: string;
  agentId: string;
  type: RuntimeArtifactType;
  title: string;
  summary?: string;
  originalPath?: string;
  mimeType?: string;
  sizeBytes: number;
  sha256?: string;
  contentAvailable: boolean;
  createdAt: string;
}

export interface MemoryUsage {
  runId: string;
  memoryId: string;
  rank: number;
  injectedCharacters: number;
  usedAt: string;
}

export type PreferenceScope = 'global' | 'workspace';
export type PreferenceContextKind = 'coding' | 'debugging' | 'planning' | 'review' | 'explanation' | 'general';
export type PreferenceDimension =
  | 'response_language'
  | 'response_detail'
  | 'execution_style'
  | 'clarification_style'
  | 'change_scope'
  | 'verification_depth'
  | 'progress_update_style'
  | 'delivery_format'
  | 'tooling_habit';
export type PreferenceProjectionStatus = 'observed' | 'provisional' | 'stable' | 'dormant';
export type PreferenceEvidenceStatus = 'active' | 'retracted';
export type PreferenceSignalType = 'direct_correction' | 'repeated_instruction' | 'workflow_choice' | 'successful_application' | 'rework' | 'conflict';
export type PreferenceEvidencePolarity = 'positive' | 'negative';

export interface UserProfile {
  id: string;
  displayName: string;
  learningEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PreferenceEvidence {
  id: string;
  profileId: string;
  workspaceId?: string;
  conversationId: string;
  runId: string;
  sourceEventId: string;
  dimension: PreferenceDimension;
  contextKind: PreferenceContextKind;
  candidateValue: string;
  signalType: PreferenceSignalType;
  polarity: PreferenceEvidencePolarity;
  weight: number;
  summary: string;
  status: PreferenceEvidenceStatus;
  observedAt: string;
  createdAt: string;
}

export interface PreferenceProjection {
  id: string;
  profileId: string;
  scope: PreferenceScope;
  workspaceId?: string;
  dimension: PreferenceDimension;
  contextKind: PreferenceContextKind;
  preferredValue: string;
  confidence: number;
  score: number;
  evidenceCount: number;
  independentRunCount: number;
  status: PreferenceProjectionStatus;
  lastSupportedAt: string;
  lastConflictedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PreferenceProjectionEvidence {
  projectionId: string;
  evidenceId: string;
  contribution: number;
}

export interface PreferenceApplication {
  runId: string;
  projectionId: string;
  resolvedValue: string;
  rank: number;
  injectedCharacters: number;
  appliedAt: string;
}

export interface PreferenceContext {
  contextKind: PreferenceContextKind;
  text: string;
  applications: PreferenceApplication[];
}

export interface MemorySearchInput {
  workspaceId: string;
  query: string;
  relatedFiles?: string[];
  types?: MemoryType[];
  limit: number;
  maxCharacters: number;
}

export type MemoryType = 'overview' | 'convention' | 'decision' | 'experience';
export type MemoryStatus = 'active' | 'archived';

export interface MemoryRecord {
  id: string;
  workspaceId: string;
  type: MemoryType;
  status: MemoryStatus;
  title: string;
  summary: string;
  contentPath: string;
  tags: string[];
  relatedFiles: string[];
  sourceRunIds: string[];
  importance: number;
  confidence: number;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt?: string;
}

export type MemoryCandidateStatus = 'pending' | 'accepted' | 'rejected';
export type MemoryCandidateOperation = 'create' | 'update' | 'merge' | 'ignore';

export interface MemoryCandidate {
  id: string;
  workspaceId: string;
  runId: string;
  type: MemoryType;
  title: string;
  summary: string;
  content: string;
  confidence: number;
  operation: MemoryCandidateOperation;
  conflictingMemoryIds: string[];
  status: MemoryCandidateStatus;
  createdAt: string;
  reviewedAt?: string;
}

export interface AgentRunDetails {
  run: AgentRun;
  sourceMessage: ConversationMessage;
  executions: AgentExecution[];
  events: AgentEvent[];
  cliInvocations: RunCliInvocation[];
  fileChanges: RunFileChange[];
  artifacts: RuntimeArtifact[];
  usedMemories: MemoryUsage[];
  preferenceApplications: PreferenceApplication[];
}

export interface CliInvocationObservation {
  invocationId: string;
  cliKind: string;
  commandLabel: string;
  model?: string;
  thinkingEffort?: ThinkingEffort;
  exitCode?: number | null;
  durationMs?: number;
  startedAt: string;
  completedAt?: string;
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
