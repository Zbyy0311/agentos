import type { V2RunStatus } from './m3-run-status.js';
import type { V2RunReason, WorktreeMode } from './m3-runtime-contracts.js';
import type { M3StageStatus } from './m3-runtime.js';

export type TaskStatus = 'pending' | 'running' | 'reviewing' | 'completed' | 'failed' | 'cancelled';

export type AgentRole = 'codex' | 'kimi' | 'opencode' | 'mimo';

export type AgentProvider = 'codex' | 'kimi' | 'opencode' | 'mimo' | 'custom';

export type AgentPermission = 'read' | 'write' | 'review';

export type ThinkingEffort = 'auto' | 'low' | 'medium' | 'high';

export type ModelDiscoverySource = 'live' | 'cache' | 'config' | 'fallback';

export type ConversationType = 'direct' | 'group';

export type CollaborationRole = 'leader' | 'worker' | 'reviewer' | 'specialist';

export type GroupDispatchMode = 'leader_route' | 'full_pipeline' | 'mentioned_only';

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
  | 'execution.approval.requested'
  | 'execution.approval.resolved'
  | 'execution.artifact.created'
  | 'run.step.created'
  | 'run.step.updated'
  | 'memory.used'
  | 'memory.candidate.created'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled';

export interface AgentEventDraft<TPayload = Record<string, unknown>> {
  eventId: string;
  schemaVersion: 2;
  type: AgentEventType;
  workspaceId: string;
  conversationId: string;
  runId: string;
  executionId?: string;
  agentId?: string;
  timestamp: string;
  payload: TPayload;
}

export interface AgentEvent<TPayload = Record<string, unknown>> extends AgentEventDraft<TPayload> {
  /** SQLite-assigned public ordering for this Run. */
  sequence: number;
}

export interface PersistEventResult {
  event: AgentEvent;
  inserted: boolean;
}

export interface EventBusContract {
  publish(draft: AgentEventDraft): Promise<AgentEvent>;
  broadcastPersisted(event: AgentEvent): Promise<void>;
}

export type AgentStage =
  | 'codex_manager'
  | 'kimi_worker'
  | 'opencode_reviewer'
  | 'codex_final_review';

export interface WorkspaceAgent {
  id: string;
  name: string;
  /** Runtime provider identity. Legacy JSON may omit this and is normalized from role on load. */
  provider?: AgentProvider;
  role: AgentRole;
  enabled: boolean;
  cliCommand: string;
  cliArgs: string[];
  model?: string;
  thinkingEffort?: ThinkingEffort;
  /** Reference to a ProviderConfiguration in the provider_configurations table. */
  providerConfigId?: string;
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

export interface AgentRuntimeStatus {
  configuredProvider: AgentProvider;
  detectedProvider?: AgentProvider;
  mismatch: boolean;
  version?: string;
}

export type AgentPresenceState = 'disabled' | 'idle' | 'queued' | 'working' | 'waiting' | 'failed';

export interface AgentPresence {
  agentId: string;
  state: AgentPresenceState;
  activity?: string;
  runId?: string;
  conversationId?: string;
  updatedAt: string;
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
  runtime?: AgentRuntimeStatus;
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
  /** Group dispatch policy. Direct conversations leave this undefined. */
  dispatchMode?: GroupDispatchMode;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationMember {
  conversationId: string;
  agentId: string;
  roleTitle: string;
  /** Deprecated compatibility projection for old clients. */
  isLeader?: boolean;
  roleKind: CollaborationRole;
  sequence: number;
  createdAt: string;
}

export interface LegacyConversationMember extends Omit<ConversationMember, 'roleKind' | 'sequence'> {
  isLeader: boolean;
}

export interface GroupMemberInput {
  agentId: string;
  roleKind: CollaborationRole;
  roleTitle: string;
  sequence: number;
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
  runId?: string;
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
  /** User-selected execution intent. Legacy runs are treated as execute. */
  intent?: RunIntent;
  /** Immutable policy snapshot resolved when the run was created. */
  runtimePolicy?: RuntimePolicy;
  createdAt: string;
  updatedAt: string;
}

export type WorktreeLeaseStatus = 'creating' | 'active' | 'completed' | 'cleanup_pending' | 'cleaned' | 'failed';

export interface WorktreeLease {
  id: string;
  workspaceId: string;
  runId: string;
  executionId: string;
  agentId: string;
  branchName: string;
  pathLabel: string;
  baseCommit: string;
  status: WorktreeLeaseStatus;
  createdAt: string;
  updatedAt: string;
}

export type RunIntent = 'ask' | 'execute' | 'review';

export interface RuntimePolicy {
  workspaceWrite: boolean;
  networkPolicy: 'provider-default' | 'blocked' | 'allowed';
  toolPolicy: 'read-only' | 'configured' | 'approval';
  extraArgs: string[];
  promptPrefix: string;
  enforcement: 'sandbox' | 'cli-flag' | 'unsupported';
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
  configuredProvider?: AgentProvider;
  detectedProvider?: AgentProvider;
  providerMismatch?: boolean;
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

export type PartialWriteDecision = 'keep_and_continue' | 'retry_current' | 'abort';

export type ApprovalDecision = 'allow_once' | 'allow_run' | 'allow_conversation' | 'deny';

export interface ToolApprovalRequest {
  id: string;
  workspaceId: string;
  runId: string;
  executionId: string;
  agentId: string;
  provider: AgentProvider;
  providerVersion?: string;
  sanitizedConfigHash: string;
  toolName: string;
  actionFingerprint: string;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  commandSummary?: string;
  affectedPaths: string[];
  createdAt: string;
}

export interface ApprovalGrant {
  id: string;
  workspaceId: string;
  conversationId: string;
  provider: AgentProvider;
  providerVersion?: string;
  sanitizedConfigHash: string;
  toolPattern: string;
  actionFingerprint: string;
  maximumRisk: 'low' | 'medium' | 'high';
  expiresAt: string;
  createdAt: string;
  revokedAt?: string;
}

export interface PendingRunDecision {
  id: string;
  workspaceId: string;
  runId: string;
  executionId: string;
  kind: 'partial_write_failure';
  fileChanges: RunFileChange[];
  allowedDecisions: PartialWriteDecision[];
  resolvedDecision?: PartialWriteDecision;
  createdAt: string;
  resolvedAt?: string;
}

export type RuntimeArtifactType = 'file' | 'diff' | 'report' | 'image' | 'log' | 'archive' | 'manifest';

export interface UntrackedManifestEntry { path: string; sizeBytes: number; sha256: string; }
export interface WorktreeRecoveryBundle { trackedPatchArtifactId: string; untrackedArchiveArtifactId: string; manifestArtifactId: string; entryCount: number; }

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
  steps: RunStep[];
}

export type RunStepKind = 'context' | 'agent' | 'review' | 'artifact' | 'summary';
export type RunStepStatus = 'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'skipped';

export interface RunStep {
  id: string;
  stableStepKey: string;
  workspaceId: string;
  runId: string;
  parentStepId?: string;
  executionId?: string;
  agentId?: string;
  kind: RunStepKind;
  title: string;
  status: RunStepStatus;
  sequence: number;
  attempt: number;
  createdEventSequence: number;
  updatedEventSequence: number;
  startedAt?: string;
  completedAt?: string;
  summary?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRunStepInput {
  stableStepKey: string;
  workspaceId: string;
  runId: string;
  parentStepId?: string;
  agentId?: string;
  kind: RunStepKind;
  title: string;
  sequence: number;
}

export interface UpdateRunStepInput {
  workspaceId: string;
  runId: string;
  stableStepKey: string;
  status: RunStepStatus;
  executionId?: string;
  summary?: string;
}

export interface RunStepMutation {
  eventId: string;
  operation: 'create' | 'update';
  input: CreateRunStepInput | UpdateRunStepInput;
}

export interface PersistRunStepMutationResult {
  step: RunStep;
  event: AgentEvent;
  inserted: boolean;
}

export interface RunStepStore {
  persistRunStepMutation(mutation: RunStepMutation, eventDraft: AgentEventDraft): PersistRunStepMutationResult;
}

export interface CliInvocationObservation {
  invocationId: string;
  cliKind: string;
  commandLabel: string;
  configuredProvider?: AgentProvider;
  detectedProvider?: AgentProvider;
  providerMismatch?: boolean;
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

// ---- M2.4 canonical Task / Run types (OD-1..OD-5; pure append, legacy types untouched) ----

export type V2TaskStatus = 'open' | 'in_progress' | 'blocked' | 'done' | 'cancelled';
export type V2TaskPriority = 'low' | 'normal' | 'high' | 'critical';
export { V2_RUN_STATUSES } from './m3-run-status.js';
export type { V2RunStatus } from './m3-run-status.js';
export { V2_RUN_REASONS } from './m3-runtime-contracts.js';
export type { V2RunReason } from './m3-runtime-contracts.js';
export type V2RunOrigin = 'v2_api' | 'legacy_pipeline';

export interface Task {
  id: string;                            // task_<ulid>
  workspaceId: string;
  legacyTaskId?: string;
  title: string;
  description?: string;
  status: V2TaskStatus;
  priority: V2TaskPriority;
  sourceConversationId?: string;
  sourceMessageId?: string;
  acceptedRunId?: string;
  pendingResultRunId?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  archivedAt?: string;
  version: number;
}

export interface Run {
  id: string;                            // run_<ulid>
  workspaceId: string;
  taskId: string;
  parentRunId?: string;
  rootRunId: string;
  status: V2RunStatus;
  reason: V2RunReason;
  origin: V2RunOrigin;
  objective?: string;
  failureCode?: string;
  failureMessage?: string;
  cancellationRequestedAt?: string;
  recoveryRequired?: boolean;
  nextEventSequence: number;
  startedAt?: string;
  completedAt?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface CreateV2TaskInput {
  title: string;
  description?: string;
  priority?: V2TaskPriority;
  sourceConversationId?: string;
  sourceMessageId?: string;
  createdBy: string;
}

export interface CreateV2RunInput {
  taskId: string;
  reason?: V2RunReason;
  parentRunId?: string;
  objective?: string;
  createdBy: string;
}

// ---------------------------------------------------------------------------
// M2.5 — Workflow Definition / Run Snapshot / RunStage shared types (V1)
// Append-only: no existing Run, RunStep, AgentRun, Task, CreateV2RunInput,
// V2RunReason or Conversation types are modified. Nullable snapshot fields use
// explicit null (never undefined). No secret values, no resolved tokens, no
// custom absolute working directories are representable here.
// ---------------------------------------------------------------------------

export type WorkflowExecutionModeV1 = 'legacy_pipeline' | 'unbound';

export interface WorkflowStageDefinitionV1 {
  key: string;
  sequence: number;
  agentRole: AgentRole | null;
}

export interface WorkflowStageDefinitionV2 extends WorkflowStageDefinitionV1 {
  dependsOn: string[];
}

export interface WorkflowDefinitionPayloadV1 {
  schemaVersion: 1;
  definitionKey: string;
  version: number;
  name: string;
  executionMode: WorkflowExecutionModeV1;
  retryPolicy: null;
  stages: WorkflowStageDefinitionV1[];
}

export interface WorkflowDefinitionPayloadV2
  extends Omit<WorkflowDefinitionPayloadV1, 'schemaVersion' | 'stages'> {
  schemaVersion: 2;
  worktreeMode: WorktreeMode;
  stages: WorkflowStageDefinitionV2[];
}

export type WorkflowDefinitionPayload = WorkflowDefinitionPayloadV1 | WorkflowDefinitionPayloadV2;

export interface WorkflowDefinition {
  id: string;
  definitionKey: string;
  version: number;
  name: string;
  payload: WorkflowDefinitionPayload;
  definitionHash: string;
  enabled: boolean;
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentSnapshotV1 {
  agentId: string;
  name: string;
  role: AgentRole;
  roleTitle: string;
  systemPrompt: string;
  permissions: AgentPermission[];
  providerConfigId: string;
  enabled: boolean;
  version: number;
}

// Provider snapshot supporting types mirror the current ProviderConfiguration
// structure (apps/server/src/store/ProviderConfigurationRepository.ts).
export type ProviderTypeV1 =
  | 'codex'
  | 'claude-code'
  | 'kimicode'
  | 'opencode'
  | 'gemini-cli'
  | 'custom-cli'
  | 'remote';

export type RuntimeModeV1 = 'cli' | 'api' | 'ssh' | 'container';

export type WorkingDirectoryModeV1 = 'workspace' | 'worktree' | 'custom';

export type ApprovalModeV1 = 'agentos' | 'native' | 'hybrid' | 'disabled';

export type OutputModeV1 = 'structured' | 'parsed-text' | 'raw-stream';

export interface ProviderCapabilitiesV1 {
  sessionResume: boolean;
  structuredEvents: boolean;
  nativeApprovals: boolean;
  subagents: boolean;
  toolEvents: boolean;
  fileEvents: boolean;
  usageEvents: boolean;
  reasoningStream: boolean;
  interactiveInput: boolean;
  pause: boolean;
  cancellation: boolean;
  modelSelection: boolean;
  workspaceAwareness: boolean;
  nativeSandbox: boolean;
  outputContracts: boolean;
}

export interface ProviderTimeoutPolicyV1 {
  discoveryTimeoutMs: number;
  validationTimeoutMs: number;
  startupTimeoutMs: number;
  idleTimeoutMs: number | null;
  totalTimeoutMs: number | null;
  cancelGracePeriodMs: number;
  approvalTimeoutMs: number | null;
}

export interface ProviderConfigurationSnapshotV1 {
  providerConfigId: string;
  name: string;
  providerType: ProviderTypeV1;
  adapterId: string;
  runtimeMode: RuntimeModeV1;
  executable: string | null;
  argsTemplate: string[];
  model: string | null;
  environmentProfileId: string | null;
  secretProfileId: string | null;
  workingDirectoryMode: WorkingDirectoryModeV1;
  workspaceRelativeWorkingDirectory: string | null;
  capabilities: ProviderCapabilitiesV1;
  timeoutPolicy: ProviderTimeoutPolicyV1;
  approvalMode: ApprovalModeV1;
  outputMode: OutputModeV1;
  enabled: boolean;
  version: number;
}

export interface WorkflowStageSnapshotV1 {
  workflowStageKey: string;
  /** Must equal workflowStageKey (M2.5 V1 has no separate display name). */
  name: string;
  sequence: number;
  agent: AgentSnapshotV1 | null;
  provider: ProviderConfigurationSnapshotV1 | null;
}

export interface RunSnapshotPayloadV1 {
  schemaVersion: 1;
  capturedAt: string;
  run: {
    workspaceId: string;
    taskId: string;
    origin: V2RunOrigin;
    reason: V2RunReason;
    parentRunId: string | null;
    rootRunId: string;
  };
  workflow: {
    definitionId: string;
    definitionKey: string;
    definitionVersion: number;
    name: string;
    definitionHash: string;
    stages: WorkflowStageSnapshotV1[];
  };
  security: {
    redactionApplied: boolean;
  };
}

export interface WorkflowStageSnapshotV2 extends WorkflowStageSnapshotV1 {
  dependsOn: string[];
}

export interface RunSnapshotPayloadV2
  extends Omit<RunSnapshotPayloadV1, 'schemaVersion' | 'workflow'> {
  schemaVersion: 2;
  workflow: Omit<RunSnapshotPayloadV1['workflow'], 'stages'> & {
    worktreeMode: WorktreeMode;
    stages: WorkflowStageSnapshotV2[];
  };
}

export type RunSnapshotPayload = RunSnapshotPayloadV1 | RunSnapshotPayloadV2;

export interface RunSnapshot<TPayload extends RunSnapshotPayload = RunSnapshotPayloadV1> {
  id: string;
  workspaceId: string;
  runId: string;
  workflowDefinitionId: string;
  snapshotSchemaVersion: number;
  payload: TPayload;
  contentHash: string;
  redactionApplied: boolean;
  capturedAt: string;
}

export interface RunStage {
  id: string;
  workspaceId: string;
  runId: string;
  runSnapshotId: string;
  workflowStageKey: string;
  /** Must equal workflowStageKey (M2.5 V1 has no separate display name). */
  name: string;
  sequence: number;
  attempt: number;
  status: M3StageStatus;
  failureCode?: string;
  failureMessage?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export * from './m3-runtime.js';
export * from './m3-runtime-registry.js';
export * from './m3-lifecycle-transition-contracts.js';
