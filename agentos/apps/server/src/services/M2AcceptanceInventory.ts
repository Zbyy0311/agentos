export type AcceptanceDomainId =
  | 'workspace_aggregate'
  | 'agent_profile'
  | 'provider_configuration'
  | 'legacy_task_item'
  | 'task_domain_task_run'
  | 'conversation_runtime'
  | 'legacy_migration_evidence'
  | 'operational_json_exclusions';

export type M2AcceptanceAggregate =
  | 'task-domain'
  | 'conversation'
  | 'workspace'
  | 'agent-profile'
  | 'provider-configuration'
  | 'legacy-task-item'
  | 'migration-evidence'
  | 'operational';

export interface M2ParityFieldMap {
  readonly expectedAggregate: M2AcceptanceAggregate;
  readonly requiredLogicalFields: readonly string[];
  readonly requiresBehaviorParity: boolean;
  readonly behaviorContracts: readonly string[];
  readonly allowedOptionalFields: readonly string[];
}

export interface AcceptanceDomain {
  readonly domainId: AcceptanceDomainId;
  readonly currentStorage: readonly string[];
  readonly authoritativeReadSource: readonly string[];
  readonly authoritativeWriteSource: readonly string[];
  readonly legacyFallbackSource: readonly string[];
  readonly productionReaders: readonly string[];
  readonly productionWriters: readonly string[];
  readonly repositoryServiceRouteSymbols: readonly string[];
  readonly routeServiceEntrypoints: readonly string[];
  readonly startupEntrypoints: readonly string[];
  readonly storageOwners: readonly string[];
  readonly crossDomainWriters: readonly string[];
  readonly productionCapableUnmounted: readonly string[];
  readonly testOnlySymbols: readonly string[];
  readonly aggregateBoundary: string;
  readonly currentRetirementStatus: string;
  readonly p1ComparisonResponsibility: readonly string[];
  readonly p2P3P4OwningGate: readonly string[];
}

export interface M2AcceptanceInventory {
  readonly version: 1;
  readonly domains: readonly AcceptanceDomain[];
}

const DOMAIN_DEFINITIONS: readonly AcceptanceDomain[] = [
  {
    domainId: 'workspace_aggregate',
    currentStorage: [
      'SQLite tables workspaces, agent_profiles, provider_configurations',
      'workspace/workspaces.json',
    ],
    authoritativeReadSource: [
      'apps/server/src/store/SqliteStore.ts:SqliteStore.loadWorkspaces',
      'apps/server/src/managers/WorkspaceManager.ts:WorkspaceManager.list/get',
    ],
    authoritativeWriteSource: [
      'apps/server/src/store/SqliteStore.ts:SqliteStore.saveWorkspaces',
      'apps/server/src/managers/WorkspaceManager.ts:WorkspaceManager.create/importExisting/touch',
      'apps/server/src/routes/workspaces.ts:createWorkspaceRoutes DELETE /:id',
      'apps/server/src/managers/WorkspaceManager.ts:WorkspaceManager.remove',
      'apps/server/src/store/SqliteStore.ts:SqliteStore.deleteWorkspace',
      'SqliteStore._workspace_tombstones tombstone write',
    ],
    legacyFallbackSource: [
      'apps/server/src/store/JsonFileStore.ts:JsonFileStore.loadWorkspaces',
      'workspace/workspaces.json',
    ],
    productionReaders: [
      'apps/server/src/store/SqliteStore.ts:SqliteStore.loadWorkspaces',
      'apps/server/src/managers/WorkspaceManager.ts:WorkspaceManager.list',
      'apps/server/src/managers/WorkspaceManager.ts:WorkspaceManager.get',
      'apps/server/src/routes/workspaces.ts:createWorkspaceRoutes',
    ],
    productionWriters: [
      'apps/server/src/store/SqliteStore.ts:SqliteStore.saveWorkspaces',
      'apps/server/src/managers/WorkspaceManager.ts:WorkspaceManager.create',
      'apps/server/src/managers/WorkspaceManager.ts:WorkspaceManager.importExisting',
      'apps/server/src/managers/WorkspaceManager.ts:WorkspaceManager.touch',
      'apps/server/src/routes/workspaces.ts:createWorkspaceRoutes DELETE /:id',
      'apps/server/src/managers/WorkspaceManager.ts:WorkspaceManager.remove',
      'apps/server/src/store/SqliteStore.ts:SqliteStore.deleteWorkspace',
    ],
    repositoryServiceRouteSymbols: [
      'SqliteStore.loadWorkspaces',
      'SqliteStore.saveWorkspaces',
      'WorkspaceManager.list',
      'WorkspaceManager.get',
      'WorkspaceManager.create',
      'createWorkspaceRoutes',
    ],
    routeServiceEntrypoints: [
      'apps/server/src/routes/workspaces.ts:createWorkspaceRoutes GET /',
      'apps/server/src/routes/workspaces.ts:createWorkspaceRoutes GET /:id',
      'apps/server/src/routes/workspaces.ts:createWorkspaceRoutes POST /',
      'apps/server/src/routes/workspaces.ts:createWorkspaceRoutes DELETE /:id',
    ],
    startupEntrypoints: [],
    storageOwners: [
      'apps/server/src/store/SqliteStore.ts:SqliteStore.loadWorkspaces',
      'apps/server/src/store/SqliteStore.ts:SqliteStore.deleteWorkspace',
      'SqliteStore._workspace_tombstones',
    ],
    crossDomainWriters: [
      'WorkspaceManager.create: agent_profiles + provider_configurations initial write',
      'SqliteStore.deleteWorkspace: workspace tombstone write',
      'SqliteStore.deleteWorkspace: conversations cleanup',
      'SqliteStore.deleteWorkspace: executions cleanup',
      'SqliteStore.deleteWorkspace: execution_events cleanup',
      'SqliteStore.deleteWorkspace: agent_events cleanup',
      'SqliteStore.deleteWorkspace: memory_fts cleanup',
      'SqliteStore.deleteWorkspace: memories cleanup',
      'SqliteStore.deleteWorkspace: run_event_sequences cleanup',
      'SqliteStore.deleteWorkspace: agent_runs cleanup',
      'SqliteStore.deleteWorkspace: messages cleanup',
      'SqliteStore.deleteWorkspace: conversation_members cleanup',
      'SqliteStore.deleteWorkspace: conversations cleanup',
      'SqliteStore.deleteWorkspace: agent_profiles cleanup',
      'SqliteStore.deleteWorkspace: provider_configurations cleanup',
      'SqliteStore.deleteWorkspace: workspaces cleanup',
      'SqliteStore.deleteWorkspace: _workspace_tombstones write',
      'SqliteStore.deleteWorkspace: tasks/runs cascade verified by migration FK',
    ],
    productionCapableUnmounted: [],
    testOnlySymbols: ['apps/server/src/store/__tests__/WorkspaceRepository.test.ts:WorkspaceRepository'],
    aggregateBoundary: 'Workspace aggregate with Agent Profile and Provider Configuration child rows; excludes Legacy TaskItem, Task-domain Run, and Conversation runtime.',
    currentRetirementStatus: 'SQLite is the production write authority; workspace/workspaces.json remains a JSON fallback read and evidence source.',
    p1ComparisonResponsibility: [
      'Compare SQLite Workspace rows with exact workspace/workspaces.json source bytes.',
      'Inventory every Workspace reader and writer and report fallback visibility without changing it.',
    ],
    p2P3P4OwningGate: [
      'P2 Core M2 Acceptance Verification: Workspace CRUD and references.',
      'P3 Migration and Restore Rehearsal: source preservation and no-op adoption.',
      'P4 Runtime and API Compatibility: Legacy Workspace API behavior.',
    ],
  },
  {
    domainId: 'agent_profile',
    currentStorage: [
      'SQLite table agent_profiles',
      'Nested agents in workspace/workspaces.json',
    ],
    authoritativeReadSource: [
      'apps/server/src/store/SqliteStore.ts:SqliteStore.listAgentProfiles',
      'apps/server/src/store/WorkspaceCompatibilityRepository.ts:WorkspaceCompatibilityRepository',
    ],
    authoritativeWriteSource: [
      'apps/server/src/store/SqliteStore.ts:SqliteStore.saveWorkspaces',
      'apps/server/src/managers/WorkspaceManager.ts:WorkspaceManager.create',
      'apps/server/src/store/SqliteStore.ts:SqliteStore.updateAgentProfile',
      'apps/server/src/routes/conversations.ts:createConversationRoutes PATCH /agents/:agentId',
      'SqliteStore.updateAgentProfile: provider_configurations binding update',
    ],
    legacyFallbackSource: [
      'workspace/workspaces.json nested agents',
      'apps/server/src/store/JsonFileStore.ts:JsonFileStore.loadWorkspaces',
    ],
    productionReaders: [
      'apps/server/src/store/SqliteStore.ts:SqliteStore.listAgentProfiles',
      'apps/server/src/store/WorkspaceCompatibilityRepository.ts:WorkspaceCompatibilityRepository',
      'apps/server/src/routes/agents.ts',
    ],
    productionWriters: [
      'apps/server/src/store/SqliteStore.ts:SqliteStore.saveWorkspaces',
      'apps/server/src/managers/WorkspaceManager.ts:WorkspaceManager.create',
      'apps/server/src/store/SqliteStore.ts:SqliteStore.updateAgentProfile',
      'apps/server/src/routes/conversations.ts:createConversationRoutes PATCH /agents/:agentId',
    ],
    repositoryServiceRouteSymbols: [
      'SqliteStore.listAgentProfiles',
      'WorkspaceCompatibilityRepository',
      'WorkspaceManager.create',
      'createAgentRoutes',
    ],
    routeServiceEntrypoints: [
      'apps/server/src/routes/conversations.ts:createConversationRoutes GET /agents',
      'apps/server/src/routes/conversations.ts:createConversationRoutes PATCH /agents/:agentId',
      'apps/server/src/routes/agents.ts:createAgentRoutes',
    ],
    startupEntrypoints: [],
    storageOwners: [
      'apps/server/src/store/SqliteStore.ts:agent_profiles',
      'apps/server/src/store/SqliteStore.ts:SqliteStore.listAgentProfiles',
      'apps/server/src/store/SqliteStore.ts:SqliteStore.updateAgentProfile',
    ],
    crossDomainWriters: [
      'SqliteStore.updateAgentProfile: provider_configurations binding update',
    ],
    productionCapableUnmounted: [],
    testOnlySymbols: [],
    aggregateBoundary: 'Agent Profile child aggregate bound to a Workspace; excludes Provider execution authority and Task/Conversation runtime history.',
    currentRetirementStatus: 'SQLite is current authority; nested JSON is compatibility source and evidence only.',
    p1ComparisonResponsibility: [
      'Compare profile identity, role, enabled state, command metadata, and provider binding by digest.',
      'Verify fixtures and test data are not classified as production readers or writers.',
    ],
    p2P3P4OwningGate: [
      'P2 Core M2 Acceptance Verification: Agent Profile and Provider references.',
      'P3 Migration and Restore Rehearsal: lossless adoption and source preservation.',
      'P4 Runtime and API Compatibility: agent route compatibility.',
    ],
  },
  {
    domainId: 'provider_configuration',
    currentStorage: [
      'SQLite table provider_configurations',
      'Nested provider configuration in workspace/workspaces.json legacy source',
    ],
    authoritativeReadSource: [
      'apps/server/src/store/ProviderConfigurationRepository.ts:ProviderConfigurationRepository.findByWorkspace',
      'apps/server/src/store/ProviderConfigurationRepository.ts:ProviderConfigurationRepository.findById',
      'apps/server/src/store/ProviderConfigurationRepository.ts:ProviderConfigurationRepository.findByWorkspaceAndName',
      'apps/server/src/store/WorkspaceCompatibilityRepository.ts:WorkspaceCompatibilityRepository',
    ],
    authoritativeWriteSource: [
      'apps/server/src/store/ProviderConfigurationRepository.ts:ProviderConfigurationRepository.insert/update/archive',
      'apps/server/src/managers/WorkspaceManager.ts:WorkspaceManager.create',
      'apps/server/src/store/SqliteStore.ts:SqliteStore.updateAgentProfile',
      'apps/server/src/routes/providerConfigs.ts:createProviderConfigRoutes POST/PUT/DELETE',
    ],
    legacyFallbackSource: [
      'workspace/workspaces.json nested provider data',
      'apps/server/src/store/JsonFileStore.ts:JsonFileStore.loadWorkspaces',
    ],
    productionReaders: [
      'apps/server/src/store/ProviderConfigurationRepository.ts:ProviderConfigurationRepository.findByWorkspace',
      'apps/server/src/store/ProviderConfigurationRepository.ts:ProviderConfigurationRepository.findById',
      'apps/server/src/store/ProviderConfigurationRepository.ts:ProviderConfigurationRepository.findByWorkspaceAndName',
      'apps/server/src/store/WorkspaceCompatibilityRepository.ts:WorkspaceCompatibilityRepository',
      'apps/server/src/routes/providerConfigs.ts:createProviderConfigRoutes GET',
    ],
    productionWriters: [
      'apps/server/src/store/ProviderConfigurationRepository.ts:ProviderConfigurationRepository.insert/update/archive',
      'apps/server/src/managers/WorkspaceManager.ts:WorkspaceManager.create',
      'apps/server/src/store/SqliteStore.ts:SqliteStore.updateAgentProfile',
      'apps/server/src/routes/providerConfigs.ts:createProviderConfigRoutes POST/PUT/DELETE',
    ],
    repositoryServiceRouteSymbols: [
      'ProviderConfigurationRepository.findByWorkspace',
      'ProviderConfigurationRepository.findById',
      'ProviderConfigurationRepository.findByWorkspaceAndName',
      'ProviderConfigurationRepository.insert',
      'ProviderConfigurationRepository.update',
      'ProviderConfigurationRepository.archive',
      'createProviderConfigRoutes',
    ],
    routeServiceEntrypoints: [
      'apps/server/src/routes/providerConfigs.ts:createProviderConfigRoutes GET',
      'apps/server/src/routes/providerConfigs.ts:createProviderConfigRoutes POST',
      'apps/server/src/routes/providerConfigs.ts:createProviderConfigRoutes PUT',
      'apps/server/src/routes/providerConfigs.ts:createProviderConfigRoutes DELETE',
    ],
    startupEntrypoints: [],
    storageOwners: [
      'apps/server/src/store/ProviderConfigurationRepository.ts:provider_configurations',
      'apps/server/src/store/ProviderConfigurationRepository.ts:ProviderConfigurationRepository',
    ],
    crossDomainWriters: [
      'WorkspaceManager.create: agent_profiles + provider_configurations initial write',
      'SqliteStore.updateAgentProfile: provider_configurations binding update',
    ],
    productionCapableUnmounted: [],
    testOnlySymbols: [],
    aggregateBoundary: 'Provider Configuration execution binding owned by a Workspace; excludes Legacy Task state and Conversation AgentRun history.',
    currentRetirementStatus: 'SQLite is execution authority; old JSON is comparison and adoption source only.',
    p1ComparisonResponsibility: [
      'Compare executable, args template, model, capabilities, timeout, approval, output, and version by digest.',
      'Prove credentials and command args never enter evidence output.',
    ],
    p2P3P4OwningGate: [
      'P2 Core M2 Acceptance Verification: Provider references and optimistic versions.',
      'P3 Migration and Restore Rehearsal: provider adoption and backup preservation.',
      'P4 Runtime and API Compatibility: provider configuration route contract.',
    ],
  },
  {
    domainId: 'legacy_task_item',
    currentStorage: [
      'workspace/<workspaceId>/.agentos/tasks.json',
    ],
    authoritativeReadSource: [
      'apps/server/src/store/JsonFileStore.ts:JsonFileStore.loadTasks',
      'apps/server/src/routes/tasks.ts:createTaskRoutes',
      'apps/server/src/taskRecovery.ts:recoverInterruptedRunningTasks',
      'apps/server/src/taskRecovery.ts:recoverInterruptedTaskRuntime',
    ],
    authoritativeWriteSource: [
      'apps/server/src/store/JsonFileStore.ts:JsonFileStore.saveTask/saveTasks',
      'apps/server/src/routes/tasks.ts:createTaskRoutes',
      'apps/server/src/taskRecovery.ts:recoverInterruptedRunningTasks',
      'apps/server/src/taskRecovery.ts:recoverInterruptedTaskRuntime',
    ],
    legacyFallbackSource: [
      'None; tasks.json is the current Legacy TaskItem authority in M2.8.',
    ],
    productionReaders: [
      'apps/server/src/store/JsonFileStore.ts:JsonFileStore.loadTasks',
      'apps/server/src/routes/tasks.ts:createTaskRoutes',
      'apps/server/src/taskRecovery.ts:recoverInterruptedRunningTasks',
      'apps/server/src/index.ts:recoverInterruptedTaskRuntime',
      'apps/server/src/taskRecovery.ts:recoverInterruptedTaskRuntime',
    ],
    productionWriters: [
      'apps/server/src/store/JsonFileStore.ts:JsonFileStore.saveTask',
      'apps/server/src/store/JsonFileStore.ts:JsonFileStore.saveTasks',
      'apps/server/src/routes/tasks.ts:createTaskRoutes',
      'apps/server/src/taskRecovery.ts:recoverInterruptedRunningTasks',
      'apps/server/src/taskRecovery.ts:recoverInterruptedTaskRuntime',
    ],
    repositoryServiceRouteSymbols: [
      'JsonFileStore.loadTasks',
      'JsonFileStore.saveTask',
      'JsonFileStore.saveTasks',
      'createTaskRoutes',
      'recoverInterruptedRunningTasks',
    ],
    routeServiceEntrypoints: [
      'apps/server/src/routes/tasks.ts:createTaskRoutes',
      'apps/server/src/taskRecovery.ts:recoverInterruptedRunningTasks',
    ],
    startupEntrypoints: [
      'apps/server/src/index.ts:recoverInterruptedTaskRuntime',
      'apps/server/src/taskRecovery.ts:recoverInterruptedTaskRuntime',
      'apps/server/src/taskRecovery.ts:recoverInterruptedRunningTasks',
    ],
    storageOwners: [
      'apps/server/src/store/JsonFileStore.ts:workspace/<workspaceId>/.agentos/tasks.json',
      'apps/server/src/store/JsonFileStore.ts:JsonFileStore.loadTasks/saveTasks',
    ],
    crossDomainWriters: [
      'createTaskRoutes Legacy Bridge: tasks.json + TaskRunService per execution',
      'TaskRunService.recoverInterruptedLegacyQueuedRuns: tasks.json recovery + queued Bridge Run failure',
    ],
    productionCapableUnmounted: [],
    testOnlySymbols: ['apps/server/src/services/LegacyTaskItemImportService.test.ts:LegacyTaskItemImportService'],
    aggregateBoundary: 'Legacy TaskItem JSON aggregate; excludes canonical Task-domain Run history and Conversation AgentRun history.',
    currentRetirementStatus: 'tasks.json read/write authority remains active in M2.8; bulk conversion and physical retirement are prohibited.',
    p1ComparisonResponsibility: [
      'Compare task item fields and behavior contract without writing tasks.json or canonical rows.',
      'Preserve per-execution Bridge semantics and reject synthetic history.',
    ],
    p2P3P4OwningGate: [
      'P2 Core M2 Acceptance Verification: Task/Run separation and bridge ownership.',
      'P3 Migration and Restore Rehearsal: tasks.json backup, preservation, and quarantine.',
      'P4 Runtime and API Compatibility: Legacy list/create/run/recovery and SSE.',
    ],
  },
  {
    domainId: 'task_domain_task_run',
    currentStorage: [
      'SQLite table tasks',
      'SQLite table runs',
      'SQLite supporting tables run_snapshots and run_stages',
    ],
    authoritativeReadSource: [
      'apps/server/src/store/TaskRepository.ts:TaskRepository',
      'apps/server/src/store/RunRepository.ts:RunRepository',
      'apps/server/src/services/TaskRunService.ts:TaskRunService',
    ],
    authoritativeWriteSource: [
      'apps/server/src/services/TaskRunService.ts:TaskRunService',
      'apps/server/src/routes/v2Tasks.ts',
      'apps/server/src/routes/v2Runs.ts',
      'apps/server/src/routes/tasks.ts:createTaskRoutes (Legacy Bridge)',
    ],
    legacyFallbackSource: [
      'workspace/<workspaceId>/.agentos/tasks.json through Legacy Bridge only',
    ],
    productionReaders: [
      'apps/server/src/store/TaskRepository.ts:TaskRepository',
      'apps/server/src/store/RunRepository.ts:RunRepository',
      'apps/server/src/services/TaskRunService.ts:TaskRunService',
      'apps/server/src/routes/v2Tasks.ts',
      'apps/server/src/routes/v2Runs.ts',
      'apps/server/src/taskRecovery.ts:recoverInterruptedTaskRuntime',
      'apps/server/src/services/TaskRunService.ts:TaskRunService.recoverInterruptedLegacyQueuedRuns',
      'apps/server/src/store/RunRepository.ts:RunRepository.listByWorkspace',
    ],
    productionWriters: [
      'apps/server/src/services/TaskRunService.ts:TaskRunService',
      'apps/server/src/routes/v2Tasks.ts',
      'apps/server/src/routes/v2Runs.ts',
      'apps/server/src/routes/tasks.ts:createTaskRoutes (Legacy Bridge)',
      'apps/server/src/taskRecovery.ts:recoverInterruptedTaskRuntime',
      'apps/server/src/services/TaskRunService.ts:TaskRunService.recoverInterruptedLegacyQueuedRuns',
      'apps/server/src/store/RunRepository.ts:RunRepository.failQueuedBridgeRestart',
      'apps/server/src/services/TaskRunService.ts:TaskRunService.resolveTaskAfterRunTerminal',
    ],
    repositoryServiceRouteSymbols: [
      'TaskRepository',
      'RunRepository',
      'TaskRunService',
      'createV2TaskRoutes',
      'createV2RunRoutes',
      'createTaskRoutes',
    ],
    routeServiceEntrypoints: [
      'apps/server/src/routes/v2Tasks.ts:createV2TaskRoutes',
      'apps/server/src/routes/v2Runs.ts:createV2RunRoutes',
      'apps/server/src/routes/tasks.ts:createTaskRoutes Legacy Bridge',
    ],
    startupEntrypoints: [
      'apps/server/src/index.ts:recoverInterruptedTaskRuntime',
      'apps/server/src/taskRecovery.ts:recoverInterruptedTaskRuntime',
      'apps/server/src/services/TaskRunService.ts:TaskRunService.recoverInterruptedLegacyQueuedRuns',
      'apps/server/src/store/RunRepository.ts:RunRepository.listByWorkspace',
      'apps/server/src/store/RunRepository.ts:RunRepository.failQueuedBridgeRestart',
    ],
    storageOwners: [
      'apps/server/src/store/TaskRepository.ts:tasks',
      'apps/server/src/store/RunRepository.ts:runs',
      'apps/server/src/store/SqliteStore.ts:run_snapshots + run_stages',
    ],
    crossDomainWriters: [
      'createTaskRoutes Legacy Bridge: tasks.json + TaskRunService',
      'taskRecovery.recoverInterruptedTaskRuntime: Legacy TaskItem + Task-domain startup orchestration',
      'TaskRunService.recoverInterruptedLegacyQueuedRuns: tasks.json recovery + queued Bridge Run failure',
    ],
    productionCapableUnmounted: [],
    testOnlySymbols: ['apps/server/src/store/__tests__/TaskRepository.test.ts:TaskRepository', 'apps/server/src/store/__tests__/RunRepository.test.ts:RunRepository'],
    aggregateBoundary: 'Task-domain canonical Task and Run aggregate: runs != agent_runs; bound to canonical task_id; Legacy bridge Run is not a Conversation AgentRun.',
    currentRetirementStatus: 'SQLite canonical for v2 and Bridge participation; Legacy Task JSON remains separate and is not bulk-converted.',
    p1ComparisonResponsibility: [
      'Compare Task-domain tasks/runs/run_snapshots/run_stages independently from Conversation runtime.',
      'Never place run_steps or agent_events in the Task-domain record set.',
    ],
    p2P3P4OwningGate: [
      'P2 Core M2 Acceptance Verification: Task/Run separation, snapshots, idempotency, and concurrency.',
      'P3 Migration and Restore Rehearsal: canonical database preservation and restore.',
      'P4 Runtime and API Compatibility: v2 Task/Run and Legacy Bridge behavior.',
    ],
  },
  {
    domainId: 'conversation_runtime',
    currentStorage: [
      'SQLite tables agent_runs, run_steps, executions, execution_events, agent_events, run_event_sequences',
    ],
    authoritativeReadSource: [
      'apps/server/src/services/ConversationService.ts:ConversationService',
      'apps/server/src/routes/conversations.ts',
      'apps/server/src/runRecovery.ts:recoverInterruptedRuns',
      'apps/server/src/services/RunStepService.ts:RunStepService.reconcileInterruptedRun',
    ],
    authoritativeWriteSource: [
      'apps/server/src/services/ConversationService.ts:ConversationService.sendDirectMessage/sendGroupMessage',
      'apps/server/src/routes/conversations.ts',
      'apps/server/src/runRecovery.ts:recoverInterruptedRuns',
      'apps/server/src/services/RunStepService.ts:RunStepService.reconcileInterruptedRun',
    ],
    legacyFallbackSource: [
      'None; Conversation runtime is not a Legacy Task JSON fallback.',
    ],
    productionReaders: [
      'apps/server/src/services/ConversationService.ts:ConversationService',
      'apps/server/src/routes/conversations.ts',
      'apps/server/src/routes/sse.ts',
      'apps/server/src/index.ts:recoverInterruptedRuns',
      'apps/server/src/runRecovery.ts:recoverInterruptedRuns',
      'apps/server/src/services/RunStepService.ts:RunStepService.reconcileInterruptedRun',
      'apps/server/src/store/SqliteStore.ts:SqliteStore.listRunsForRecovery',
      'apps/server/src/store/SqliteStore.ts:SqliteStore.listExecutions',
      'apps/server/src/store/SqliteStore.ts:SqliteStore.listRunSteps',
    ],
    productionWriters: [
      'apps/server/src/services/ConversationService.ts:ConversationService',
      'apps/server/src/routes/conversations.ts',
      'apps/server/src/runRecovery.ts:recoverInterruptedRuns',
      'apps/server/src/services/RunStepService.ts:RunStepService.reconcileInterruptedRun',
      'apps/server/src/store/SqliteStore.ts:SqliteStore.updateExecution',
      'apps/server/src/store/SqliteStore.ts:SqliteStore.updateRun',
      'apps/server/src/store/SqliteStore.ts:SqliteStore.persistRunStepMutation',
      'apps/server/src/store/SqliteStore.ts:SqliteStore.appendAgentEvent',
    ],
    repositoryServiceRouteSymbols: [
      'ConversationService',
      'createConversationRoutes',
      'createSseWriter',
      'SqliteStore.createConversation',
      'SqliteStore.createGroupConversation',
      'SqliteStore.updateConversationTitle',
      'SqliteStore.updateConversationSettings',
      'SqliteStore.updateGroupConversation',
      'SqliteStore.deleteConversation',
      'SqliteStore.getRun',
      'SqliteStore.listRuns',
      'SqliteStore.listExecutions',
      'SqliteStore.listExecutionEvents',
      'SqliteStore.listMessages',
      'SqliteStore.updateRun',
      'SqliteStore.listConversationMembers',
      'SqliteStore.listConversationAttachments',
      'SqliteStore.getAttachment',
    ],
    routeServiceEntrypoints: [
      'apps/server/src/routes/conversations.ts:createConversationRoutes',
      'apps/server/src/routes/sse.ts:createSseWriter',
    ],
    startupEntrypoints: [
      'apps/server/src/index.ts:recoverInterruptedRuns',
      'apps/server/src/runRecovery.ts:recoverInterruptedRuns',
      'apps/server/src/services/RunStepService.ts:RunStepService.reconcileInterruptedRun',
      'apps/server/src/store/SqliteStore.ts:SqliteStore.listRunsForRecovery',
      'apps/server/src/store/SqliteStore.ts:SqliteStore.listExecutions',
      'apps/server/src/store/SqliteStore.ts:SqliteStore.updateExecution',
      'apps/server/src/store/SqliteStore.ts:SqliteStore.updateRun',
      'apps/server/src/store/SqliteStore.ts:SqliteStore.listRunSteps',
      'apps/server/src/store/SqliteStore.ts:SqliteStore.persistRunStepMutation',
      'apps/server/src/store/SqliteStore.ts:SqliteStore.appendAgentEvent',
    ],
    storageOwners: [
      'apps/server/src/store/SqliteStore.ts:agent_runs + executions + events',
      'apps/server/src/services/ConversationService.ts:ConversationService',
      'apps/server/src/store/SqliteStore.ts:run_steps + run_event_sequences',
    ],
    crossDomainWriters: ['RunStepService: agent_events + run_steps persistence'],
    productionCapableUnmounted: ['apps/server/src/store/SqliteStore.ts:SqliteStore.listRunsForWorkspace'],
    testOnlySymbols: ['apps/server/src/routes/conversations.test.ts:createConversationRoutes'],
    aggregateBoundary: 'Conversation/message/execution lifecycle aggregate using agent_runs; independent from Task-domain runs.',
    currentRetirementStatus: 'Separate SQLite runtime retained; no Task/Conversation aggregate unification in M2.8.',
    p1ComparisonResponsibility: [
      'Compare Conversation runtime records separately from Task-domain runs.',
      'Reject task-domain records and never classify run_steps or agent_events as Task-domain evidence.',
    ],
    p2P3P4OwningGate: [
      'P2 Core M2 Acceptance Verification: aggregate isolation.',
      'P3 Migration and Restore Rehearsal: SQLite preservation and restore.',
      'P4 Runtime and API Compatibility: direct/group execution and Conversation Stream.',
    ],
  },
  {
    domainId: 'legacy_migration_evidence',
    currentStorage: [
      'SQLite tables legacy_data_migrations and legacy_task_items',
      'Exact-byte source and backup evidence',
    ],
    authoritativeReadSource: [
      'apps/server/src/store/LegacyDataMigrationRepository.ts:LegacyDataMigrationRepository',
      'apps/server/src/store/LegacyTaskItemRepository.ts:LegacyTaskItemRepository',
    ],
    authoritativeWriteSource: [
      'apps/server/src/services/WorkspaceCompatibilityMigrationService.ts:WorkspaceCompatibilityMigrationService',
      'apps/server/src/services/LegacyTaskItemImportService.ts:LegacyTaskItemImportService',
    ],
    legacyFallbackSource: [
      'workspace/workspaces.json',
      'workspace/<workspaceId>/.agentos/tasks.json',
    ],
    productionReaders: [
      'apps/server/src/store/LegacyDataMigrationRepository.ts:LegacyDataMigrationRepository',
      'apps/server/src/store/LegacyTaskItemRepository.ts:LegacyTaskItemRepository',
      'apps/server/src/services/WorkspaceCompatibilityMigrationService.ts:WorkspaceCompatibilityMigrationService',
      'apps/server/src/services/LegacyTaskItemImportService.ts:LegacyTaskItemImportService',
    ],
    productionWriters: [
      'apps/server/src/services/WorkspaceCompatibilityMigrationService.ts:WorkspaceCompatibilityMigrationService',
      'apps/server/src/services/LegacyTaskItemImportService.ts:LegacyTaskItemImportService',
      'apps/server/src/store/LegacyDataMigrationRepository.ts:LegacyDataMigrationRepository',
      'apps/server/src/store/LegacyTaskItemRepository.ts:LegacyTaskItemRepository',
    ],
    repositoryServiceRouteSymbols: [
      'LegacyDataMigrationRepository',
      'LegacyTaskItemRepository',
      'WorkspaceCompatibilityMigrationService',
      'LegacyTaskItemImportService',
      'LegacyBackupVerifier',
    ],
    routeServiceEntrypoints: [
      'apps/server/src/services/WorkspaceCompatibilityMigrationService.ts:WorkspaceCompatibilityMigrationService',
      'apps/server/src/services/LegacyTaskItemImportService.ts:LegacyTaskItemImportService',
      'apps/server/src/services/LegacyBackupVerifier.ts:LegacyBackupVerifier',
    ],
    startupEntrypoints: [],
    storageOwners: [
      'apps/server/src/store/LegacyDataMigrationRepository.ts:legacy_data_migrations',
      'apps/server/src/store/LegacyTaskItemRepository.ts:legacy_task_items',
      'exact-byte source and backup evidence',
    ],
    crossDomainWriters: [
      'WorkspaceCompatibilityMigrationService: Workspace/Agent/Provider compatibility rows',
      'LegacyTaskItemImportService: Legacy TaskItem evidence rows',
    ],
    productionCapableUnmounted: [],
    testOnlySymbols: ['apps/server/src/services/WorkspaceCompatibilityMigrationService.test.ts:WorkspaceCompatibilityMigrationService'],
    aggregateBoundary: 'Append-only compatibility and audit evidence; not an authoritative Task, Run, Agent Profile, Provider, or Conversation aggregate.',
    currentRetirementStatus: 'Long-term evidence retained; no Migration 012 or physical Legacy JSON retirement in M2.8.',
    p1ComparisonResponsibility: [
      'Compare evidence identities, source hashes, classifications, and accepted snapshots without creating or updating evidence rows.',
      'Recommend quarantine classifications without creating quarantine records.',
    ],
    p2P3P4OwningGate: [
      'P2 Core M2 Acceptance Verification: registry and evidence ownership.',
      'P3 Migration and Restore Rehearsal: preservation, repeat/no-op, backup, and restore.',
      'P4 Runtime and API Compatibility: evidence remains isolated from runtime behavior.',
    ],
  },
  {
    domainId: 'operational_json_exclusions',
    currentStorage: [
      '.agentos/worktrees/leases.json',
      'agent-memory/records/**/*.md',
      '.agentos/artifacts/* plus SQLite artifact metadata',
    ],
    authoritativeReadSource: [
      'apps/server/src/services/WorktreeManager.ts:WorktreeManager',
      'apps/server/src/services/MemoryService.ts:MemoryService',
      'apps/server/src/services/RuntimeArtifactService.ts:RuntimeArtifactService',
    ],
    authoritativeWriteSource: [
      'apps/server/src/services/WorktreeManager.ts:WorktreeManager',
      'apps/server/src/services/MemoryService.ts:MemoryService',
      'apps/server/src/services/RuntimeArtifactService.ts:RuntimeArtifactService',
    ],
    legacyFallbackSource: [
      'None; operational leases, Memory Markdown, and artifact files are excluded from Legacy Product JSON retirement.',
    ],
    productionReaders: [
      'apps/server/src/services/WorktreeManager.ts:WorktreeManager',
      'apps/server/src/services/MemoryService.ts:MemoryService',
      'apps/server/src/services/RuntimeArtifactService.ts:RuntimeArtifactService',
    ],
    productionWriters: [
      'apps/server/src/services/WorktreeManager.ts:WorktreeManager',
      'apps/server/src/services/MemoryService.ts:MemoryService',
      'apps/server/src/services/RuntimeArtifactService.ts:RuntimeArtifactService',
    ],
    repositoryServiceRouteSymbols: [
      'WorktreeManager',
      'MemoryService',
      'RuntimeArtifactService',
    ],
    routeServiceEntrypoints: [
      'apps/server/src/services/WorktreeManager.ts:WorktreeManager',
      'apps/server/src/services/MemoryService.ts:MemoryService',
      'apps/server/src/services/RuntimeArtifactService.ts:RuntimeArtifactService',
    ],
    startupEntrypoints: [],
    storageOwners: [
      'WorktreeManager:.agentos/worktrees/leases.json',
      'MemoryService:agent-memory/records/**/*.md',
      'RuntimeArtifactService:.agentos/artifacts/*',
    ],
    crossDomainWriters: [],
    productionCapableUnmounted: ['apps/server/src/services/RuntimeArtifactCollector.ts:RuntimeArtifactCollector'],
    testOnlySymbols: ['apps/server/src/services/RuntimeArtifactService.test.ts:RuntimeArtifactService', 'apps/server/src/services/WorktreeManager.test.ts:WorktreeManager'],
    aggregateBoundary: 'Operational state and file-backed subsystems; not part of Legacy Product JSON retirement or Task/Conversation runtime aggregates.',
    currentRetirementStatus: 'Explicitly excluded from Legacy Product JSON retirement; retained under their own contracts.',
    p1ComparisonResponsibility: [
      'Exclude leases.json, Memory Markdown, artifacts, and test fixtures from product JSON parity and retirement.',
      'Do not classify test fixtures as production readers or writers.',
    ],
    p2P3P4OwningGate: [
      'P2 Core M2 Acceptance Verification: operational ownership boundaries.',
      'P3 Migration and Restore Rehearsal: ensure exclusions are not copied as product records.',
      'P4 Runtime and API Compatibility: preserve operational services independently.',
    ],
  },
];

const FIELD_MAP_DEFINITIONS: Record<AcceptanceDomainId, M2ParityFieldMap> = {
  workspace_aggregate: {
    expectedAggregate: 'workspace',
    requiredLogicalFields: ['identity', 'name', 'canonical_root_path', 'git_enabled', 'memory_enabled', 'tombstone_visibility_state', 'version'],
    requiresBehaviorParity: true,
    behaviorContracts: ['workspace CRUD, fallback visibility, deletion tombstone, and version/concurrency behavior'],
    allowedOptionalFields: ['last_opened_at', 'created_at', 'updated_at', 'agent_bindings', 'provider_bindings'],
  },
  agent_profile: {
    expectedAggregate: 'agent-profile',
    requiredLogicalFields: ['identity', 'workspace_binding', 'role', 'enabled', 'provider_binding', 'model', 'thinking_effort', 'version'],
    requiresBehaviorParity: true,
    behaviorContracts: ['profile update, provider binding, enabled state, and version/concurrency behavior'],
    allowedOptionalFields: ['name', 'role_title', 'system_prompt_digest', 'permissions_digest', 'runtime_capability_digest'],
  },
  provider_configuration: {
    expectedAggregate: 'provider-configuration',
    requiredLogicalFields: [
      'identity', 'workspace_binding', 'provider_type', 'adapter_runtime_mode', 'executable_digest',
      'args_template_digest', 'model', 'capabilities', 'timeout_policy', 'approval_output_mode', 'enabled', 'version',
    ],
    requiresBehaviorParity: true,
    behaviorContracts: ['provider route GET/POST/PUT/DELETE, optimistic versioning, archive protection, and secret rejection'],
    allowedOptionalFields: ['name', 'environment_profile_binding', 'secret_profile_binding', 'working_directory_mode'],
  },
  legacy_task_item: {
    expectedAggregate: 'legacy-task-item',
    requiredLogicalFields: ['identity', 'workspace_binding', 'status', 'current_agent', 'review_state', 'terminal_error_state', 'bridge_relevant_state'],
    requiresBehaviorParity: true,
    behaviorContracts: ['Legacy TaskItem read/write, recovery, per-execution bridge, and SSE behavior'],
    allowedOptionalFields: ['title', 'description_digest', 'created_at', 'updated_at'],
  },
  task_domain_task_run: {
    expectedAggregate: 'task-domain',
    requiredLogicalFields: [
      'task_identity', 'task_status', 'task_version', 'run_identity', 'run_status', 'run_origin',
      'run_task_binding', 'snapshot_identity', 'snapshot_immutability', 'stage_identity', 'stage_status_sequence',
    ],
    requiresBehaviorParity: true,
    behaviorContracts: ['Task/Run lifecycle, snapshots, stages, idempotency, concurrency, and Legacy bridge separation'],
    allowedOptionalFields: ['description_digest', 'task_metadata_digest', 'run_error_digest', 'created_at', 'updated_at'],
  },
  conversation_runtime: {
    expectedAggregate: 'conversation',
    requiredLogicalFields: [
      'conversation_identity', 'message_identity', 'run_identity', 'execution_identity',
      'lifecycle_status', 'sequence_cursor_ownership', 'event_step_ownership',
    ],
    requiresBehaviorParity: true,
    behaviorContracts: ['direct/group Conversation execution, agent_runs lifecycle, sequence/cursor, and SSE/event behavior'],
    allowedOptionalFields: ['title', 'message_content_digest', 'agent_binding', 'created_at', 'updated_at'],
  },
  legacy_migration_evidence: {
    expectedAggregate: 'migration-evidence',
    requiredLogicalFields: ['source_identity_hash', 'scope', 'classification', 'terminal_outcome', 'accepted_snapshot_identity', 'evidence_immutability'],
    requiresBehaviorParity: true,
    behaviorContracts: ['migration registry ownership, repeat/no-op behavior, backup evidence, and append-only retention'],
    allowedOptionalFields: ['migration_id', 'record_count', 'created_at', 'updated_at'],
  },
  operational_json_exclusions: {
    expectedAggregate: 'operational',
    requiredLogicalFields: ['opaque_identity', 'subsystem_kind', 'source_digest', 'exclusion_contract'],
    requiresBehaviorParity: true,
    behaviorContracts: ['independent leases, Memory Markdown, and artifact file contracts outside product JSON retirement'],
    allowedOptionalFields: ['workspace_binding', 'metadata_digest', 'created_at', 'updated_at'],
  },
};

export const M2_PARITY_FIELD_MAPS: Readonly<Record<AcceptanceDomainId, M2ParityFieldMap>> = deepFreeze(FIELD_MAP_DEFINITIONS);

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Reflect.ownKeys(value as object)) {
      deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    }
  }
  return value;
}

function cloneDomain(domain: AcceptanceDomain): AcceptanceDomain {
  return {
    ...domain,
    currentStorage: [...domain.currentStorage],
    authoritativeReadSource: [...domain.authoritativeReadSource],
    authoritativeWriteSource: [...domain.authoritativeWriteSource],
    legacyFallbackSource: [...domain.legacyFallbackSource],
    productionReaders: [...domain.productionReaders],
    productionWriters: [...domain.productionWriters],
    repositoryServiceRouteSymbols: [...domain.repositoryServiceRouteSymbols],
    routeServiceEntrypoints: [...domain.routeServiceEntrypoints],
    startupEntrypoints: [...domain.startupEntrypoints],
    storageOwners: [...domain.storageOwners],
    crossDomainWriters: [...domain.crossDomainWriters],
    productionCapableUnmounted: [...domain.productionCapableUnmounted],
    testOnlySymbols: [...domain.testOnlySymbols],
    p1ComparisonResponsibility: [...domain.p1ComparisonResponsibility],
    p2P3P4OwningGate: [...domain.p2P3P4OwningGate],
  };
}

export function createM2AcceptanceInventory(): M2AcceptanceInventory {
  return deepFreeze({
    version: 1 as const,
    domains: DOMAIN_DEFINITIONS.map(cloneDomain),
  });
}

export const M2_ACCEPTANCE_INVENTORY = createM2AcceptanceInventory();
