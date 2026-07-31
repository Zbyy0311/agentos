export type AcceptanceDomainId =
  | 'workspace_aggregate'
  | 'agent_profile'
  | 'provider_configuration'
  | 'legacy_task_item'
  | 'task_domain_task_run'
  | 'conversation_runtime'
  | 'legacy_migration_evidence'
  | 'operational_json_exclusions';

export interface AcceptanceDomain {
  readonly domainId: AcceptanceDomainId;
  readonly currentStorage: readonly string[];
  readonly authoritativeReadSource: readonly string[];
  readonly authoritativeWriteSource: readonly string[];
  readonly legacyFallbackSource: readonly string[];
  readonly productionReaders: readonly string[];
  readonly productionWriters: readonly string[];
  readonly repositoryServiceRouteSymbols: readonly string[];
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
    ],
    repositoryServiceRouteSymbols: [
      'SqliteStore.loadWorkspaces',
      'SqliteStore.saveWorkspaces',
      'WorkspaceManager.list',
      'WorkspaceManager.get',
      'WorkspaceManager.create',
      'createWorkspaceRoutes',
    ],
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
    ],
    repositoryServiceRouteSymbols: [
      'SqliteStore.listAgentProfiles',
      'WorkspaceCompatibilityRepository',
      'WorkspaceManager.create',
      'createAgentRoutes',
    ],
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
      'apps/server/src/store/WorkspaceCompatibilityRepository.ts:WorkspaceCompatibilityRepository',
    ],
    authoritativeWriteSource: [
      'apps/server/src/store/ProviderConfigurationRepository.ts:ProviderConfigurationRepository.insert/update/archive',
      'apps/server/src/managers/WorkspaceManager.ts:WorkspaceManager.create',
    ],
    legacyFallbackSource: [
      'workspace/workspaces.json nested provider data',
      'apps/server/src/store/JsonFileStore.ts:JsonFileStore.loadWorkspaces',
    ],
    productionReaders: [
      'apps/server/src/store/ProviderConfigurationRepository.ts:ProviderConfigurationRepository.findByWorkspace',
      'apps/server/src/store/WorkspaceCompatibilityRepository.ts:WorkspaceCompatibilityRepository',
      'apps/server/src/routes/providerConfigs.ts',
    ],
    productionWriters: [
      'apps/server/src/store/ProviderConfigurationRepository.ts:ProviderConfigurationRepository.insert/update/archive',
      'apps/server/src/managers/WorkspaceManager.ts:WorkspaceManager.create',
    ],
    repositoryServiceRouteSymbols: [
      'ProviderConfigurationRepository.findByWorkspace',
      'ProviderConfigurationRepository.insert',
      'ProviderConfigurationRepository.update',
      'ProviderConfigurationRepository.archive',
      'createProviderConfigRoutes',
    ],
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
    ],
    authoritativeWriteSource: [
      'apps/server/src/store/JsonFileStore.ts:JsonFileStore.saveTask/saveTasks',
      'apps/server/src/routes/tasks.ts:createTaskRoutes',
      'apps/server/src/taskRecovery.ts:recoverInterruptedRunningTasks',
    ],
    legacyFallbackSource: [
      'None; tasks.json is the current Legacy TaskItem authority in M2.8.',
    ],
    productionReaders: [
      'apps/server/src/store/JsonFileStore.ts:JsonFileStore.loadTasks',
      'apps/server/src/routes/tasks.ts:createTaskRoutes',
      'apps/server/src/taskRecovery.ts:recoverInterruptedRunningTasks',
    ],
    productionWriters: [
      'apps/server/src/store/JsonFileStore.ts:JsonFileStore.saveTask',
      'apps/server/src/store/JsonFileStore.ts:JsonFileStore.saveTasks',
      'apps/server/src/routes/tasks.ts:createTaskRoutes',
      'apps/server/src/taskRecovery.ts:recoverInterruptedRunningTasks',
    ],
    repositoryServiceRouteSymbols: [
      'JsonFileStore.loadTasks',
      'JsonFileStore.saveTask',
      'JsonFileStore.saveTasks',
      'createTaskRoutes',
      'recoverInterruptedRunningTasks',
    ],
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
    ],
    productionWriters: [
      'apps/server/src/services/TaskRunService.ts:TaskRunService',
      'apps/server/src/routes/v2Tasks.ts',
      'apps/server/src/routes/v2Runs.ts',
      'apps/server/src/routes/tasks.ts:createTaskRoutes (Legacy Bridge)',
    ],
    repositoryServiceRouteSymbols: [
      'TaskRepository',
      'RunRepository',
      'TaskRunService',
      'createV2TaskRoutes',
      'createV2RunRoutes',
      'createTaskRoutes',
    ],
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
    ],
    authoritativeWriteSource: [
      'apps/server/src/services/ConversationService.ts:ConversationService.sendDirectMessage/sendGroupMessage',
      'apps/server/src/routes/conversations.ts',
    ],
    legacyFallbackSource: [
      'None; Conversation runtime is not a Legacy Task JSON fallback.',
    ],
    productionReaders: [
      'apps/server/src/services/ConversationService.ts:ConversationService',
      'apps/server/src/routes/conversations.ts',
      'apps/server/src/routes/sse.ts',
    ],
    productionWriters: [
      'apps/server/src/services/ConversationService.ts:ConversationService',
      'apps/server/src/routes/conversations.ts',
    ],
    repositoryServiceRouteSymbols: [
      'ConversationService',
      'createConversationRoutes',
      'createSseWriter',
    ],
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
