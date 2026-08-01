import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  M2_ACCEPTANCE_INVENTORY,
  M2_PARITY_FIELD_MAPS,
  createM2AcceptanceInventory,
  type AcceptanceDomainId,
} from './M2AcceptanceInventory.js';
import {
  M2ReadOnlyParityService,
  type M2ParityInput,
  type M2ParityRecord,
} from './M2ReadOnlyParityService.js';

const TASK_DOMAIN: AcceptanceDomainId = 'task_domain_task_run';
const CONVERSATION_DOMAIN: AcceptanceDomainId = 'conversation_runtime';
const SOURCE_BYTES = new Uint8Array([0x7b, 0x22, 0x73, 0x72, 0x63, 0x22, 0x3a, 0x31, 0x7d]);

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function taskRecord(
  recordKey: string,
  fields: Record<string, unknown>,
  aggregate: M2ParityRecord['aggregate'] = 'task-domain',
): M2ParityRecord {
  const requiredFields = M2_PARITY_FIELD_MAPS.task_domain_task_run.requiredLogicalFields;
  const defaults = Object.fromEntries(requiredFields.map(field => [field, `required-${field}`]));
  const normalizedFields = { ...fields };
  if ('status' in normalizedFields && !('task_status' in normalizedFields)) normalizedFields.task_status = normalizedFields.status;
  if ('content' in normalizedFields && !('description_digest' in normalizedFields)) normalizedFields.description_digest = normalizedFields.content;
  if ('providerToken' in normalizedFields && !('run_error_digest' in normalizedFields)) normalizedFields.run_error_digest = normalizedFields.providerToken;
  if ('commandArgs' in normalizedFields && !('task_metadata_digest' in normalizedFields)) normalizedFields.task_metadata_digest = normalizedFields.commandArgs;
  if ('priority' in normalizedFields && !('task_metadata_digest' in normalizedFields)) normalizedFields.task_metadata_digest = normalizedFields.priority;
  delete normalizedFields.status;
  delete normalizedFields.content;
  delete normalizedFields.providerToken;
  delete normalizedFields.commandArgs;
  delete normalizedFields.priority;
  return { recordKey, fields: { ...defaults, ...normalizedFields }, aggregate };
}

function baseInput(overrides: Partial<M2ParityInput> = {}): M2ParityInput {
  const legacyRecord = taskRecord('task-1', {
    status: 'open',
    content: 'private task content',
    providerToken: 'private-provider-token',
    commandArgs: ['--secret', 'private-command-arg'],
  });
  const canonicalRecord = taskRecord('task-1', {
    commandArgs: ['--secret', 'private-command-arg'],
    providerToken: 'private-provider-token',
    content: 'private task content',
    status: 'open',
  });
  return {
    domainId: TASK_DOMAIN,
    aggregate: 'task-domain',
    source: {
      sourceKey: 'workspace/ws-1/tasks.json',
      sourceKind: 'tasks-json',
      scope: 'workspace:ws-1',
      sourceBytes: SOURCE_BYTES,
      canonicalDatabaseOpaqueId: 'db-fixture-1',
    },
    legacyRecords: [legacyRecord],
    canonicalRecords: [canonicalRecord],
    behavior: {
      legacyContractDigest: sha256('behavior-v1'),
      canonicalContractDigest: sha256('behavior-v1'),
    },
    ...overrides,
  };
}

test('Acceptance Inventory contains eight stable, ordered domains', () => {
  const inventory = createM2AcceptanceInventory();
  assert.deepEqual(
    inventory.domains.map(domain => domain.domainId),
    [
      'workspace_aggregate',
      'agent_profile',
      'provider_configuration',
      'legacy_task_item',
      'task_domain_task_run',
      'conversation_runtime',
      'legacy_migration_evidence',
      'operational_json_exclusions',
    ],
  );
  assert.equal(inventory.domains.length, 8);
  assert.deepEqual(inventory, M2_ACCEPTANCE_INVENTORY);
});

test('Acceptance Inventory is deeply immutable and has unique, non-conflicting authority declarations', () => {
  const inventory = createM2AcceptanceInventory();
  assert.equal(Object.isFrozen(inventory), true);
  assert.equal(Object.isFrozen(inventory.domains), true);
  const ids = inventory.domains.map(domain => domain.domainId);
  assert.equal(new Set(ids).size, ids.length);
  for (const domain of inventory.domains) {
    assert.equal(Object.isFrozen(domain), true);
    assert.equal(Object.isFrozen(domain.currentStorage), true);
    assert.equal(Object.isFrozen(domain.productionReaders), true);
    assert.equal(Object.isFrozen(domain.productionWriters), true);
    assert.equal(Object.isFrozen(domain.routeServiceEntrypoints), true);
    assert.equal(Object.isFrozen(domain.storageOwners), true);
    assert.equal(Object.isFrozen(domain.crossDomainWriters), true);
    assert.equal(Object.isFrozen(domain.productionCapableUnmounted), true);
    assert.equal(Object.isFrozen(domain.testOnlySymbols), true);
    assert.ok(domain.authoritativeReadSource.length > 0);
    assert.ok(domain.authoritativeWriteSource.length > 0);
    assert.ok(domain.repositoryServiceRouteSymbols.length > 0);
    assert.ok(domain.p1ComparisonResponsibility.length > 0);
    assert.ok(domain.p2P3P4OwningGate.length > 0);
    assert.equal(
      domain.authoritativeWriteSource.some(source => domain.legacyFallbackSource.includes(source)),
      false,
      'authority overlap for ' + domain.domainId,
    );
  }
});

test('Inventory keeps Task-domain runs and Conversation agent_runs in separate aggregates', () => {
  const inventory = createM2AcceptanceInventory();
  const task = inventory.domains.find(domain => domain.domainId === TASK_DOMAIN);
  const conversation = inventory.domains.find(domain => domain.domainId === CONVERSATION_DOMAIN);
  assert.ok(task);
  assert.ok(conversation);
  assert.match(task.aggregateBoundary, /runs/);
  assert.doesNotMatch(task.aggregateBoundary, /run_steps|agent_events/);
  assert.match(conversation.aggregateBoundary, /agent_runs/);
  assert.doesNotMatch(conversation.aggregateBoundary, /Task-domain Run history/);
});

test('Inventory excludes worktree leases, memory Markdown, artifacts, and test fixtures from Legacy Product JSON retirement', () => {
  const inventory = createM2AcceptanceInventory();
  const exclusions = inventory.domains.find(domain => domain.domainId === 'operational_json_exclusions');
  assert.ok(exclusions);
  assert.match(exclusions.currentRetirementStatus, /excluded/i);
  assert.match(exclusions.currentStorage.join('|'), /leases\.json/);
  assert.match(exclusions.currentStorage.join('|'), /memory/);
  assert.match(exclusions.currentStorage.join('|'), /artifacts/);
  assert.doesNotMatch(exclusions.productionReaders.join('|'), /\.test\.ts/);
  assert.doesNotMatch(exclusions.productionWriters.join('|'), /fixture/i);
});

test('Inventory records Workspace deletion readers, writers, and tombstone ownership', () => {
  const workspace = M2_ACCEPTANCE_INVENTORY.domains.find(domain => domain.domainId === 'workspace_aggregate');
  assert.ok(workspace);
  assert.ok(workspace.productionWriters.includes('apps/server/src/routes/workspaces.ts:createWorkspaceRoutes DELETE /:id'));
  assert.ok(workspace.productionWriters.includes('apps/server/src/managers/WorkspaceManager.ts:WorkspaceManager.remove'));
  assert.ok(workspace.productionWriters.includes('apps/server/src/store/SqliteStore.ts:SqliteStore.deleteWorkspace'));
  assert.ok(workspace.crossDomainWriters.includes('SqliteStore.deleteWorkspace: workspace tombstone write'));
  assert.ok(workspace.storageOwners.includes('SqliteStore._workspace_tombstones'));
});

test('Inventory records Agent/Profile writes and the bound Provider cross-domain write', () => {
  const agent = M2_ACCEPTANCE_INVENTORY.domains.find(domain => domain.domainId === 'agent_profile');
  assert.ok(agent);
  assert.ok(agent.productionWriters.includes('apps/server/src/store/SqliteStore.ts:SqliteStore.updateAgentProfile'));
  assert.ok(agent.productionWriters.includes('apps/server/src/routes/conversations.ts:createConversationRoutes PATCH /agents/:agentId'));
  assert.ok(agent.crossDomainWriters.includes('SqliteStore.updateAgentProfile: provider_configurations binding update'));
  assert.deepEqual(agent.productionCapableUnmounted, []);
});

test('Inventory records Provider repository and route reader/writer entrypoints', () => {
  const provider = M2_ACCEPTANCE_INVENTORY.domains.find(domain => domain.domainId === 'provider_configuration');
  assert.ok(provider);
  for (const method of ['findByWorkspace', 'findById', 'findByWorkspaceAndName', 'insert', 'update', 'archive']) {
    assert.ok(provider.repositoryServiceRouteSymbols.includes(`ProviderConfigurationRepository.${method}`));
  }
  assert.ok(provider.productionReaders.includes('apps/server/src/routes/providerConfigs.ts:createProviderConfigRoutes GET'));
  assert.ok(provider.productionWriters.includes('apps/server/src/routes/providerConfigs.ts:createProviderConfigRoutes POST/PUT/DELETE'));
  assert.ok(provider.crossDomainWriters.includes('WorkspaceManager.create: agent_profiles + provider_configurations initial write'));
  assert.ok(provider.crossDomainWriters.includes('SqliteStore.updateAgentProfile: provider_configurations binding update'));
});

test('Inventory distinguishes mounted entrypoints, storage owners, cross-domain writers, and test-only symbols', () => {
  for (const domain of M2_ACCEPTANCE_INVENTORY.domains) {
    assert.ok(domain.routeServiceEntrypoints.length > 0, domain.domainId);
    assert.ok(domain.storageOwners.length > 0, domain.domainId);
    assert.ok(Array.isArray(domain.crossDomainWriters), domain.domainId);
    assert.ok(Array.isArray(domain.productionCapableUnmounted), domain.domainId);
    assert.ok(Array.isArray(domain.testOnlySymbols), domain.domainId);
    assert.doesNotMatch(domain.productionReaders.join('|'), /\.test\.ts/);
    assert.doesNotMatch(domain.productionWriters.join('|'), /fixture|\.test\.ts/i);
  }
});

test('Inventory performs equal-strength symbol coverage for the remaining domains', () => {
  const inventory = M2_ACCEPTANCE_INVENTORY.domains;
  const legacyTask = inventory.find(domain => domain.domainId === 'legacy_task_item');
  const taskRun = inventory.find(domain => domain.domainId === 'task_domain_task_run');
  const conversation = inventory.find(domain => domain.domainId === 'conversation_runtime');
  const migration = inventory.find(domain => domain.domainId === 'legacy_migration_evidence');
  const operational = inventory.find(domain => domain.domainId === 'operational_json_exclusions');
  assert.ok(legacyTask && taskRun && conversation && migration && operational);
  assert.ok(legacyTask.productionReaders.includes('apps/server/src/store/JsonFileStore.ts:JsonFileStore.loadTasks'));
  assert.ok(legacyTask.productionWriters.includes('apps/server/src/store/JsonFileStore.ts:JsonFileStore.saveTasks'));
  assert.ok(taskRun.repositoryServiceRouteSymbols.includes('TaskRepository'));
  assert.ok(taskRun.repositoryServiceRouteSymbols.includes('RunRepository'));
  assert.ok(taskRun.routeServiceEntrypoints.includes('apps/server/src/routes/v2Runs.ts:createV2RunRoutes'));
  assert.ok(conversation.routeServiceEntrypoints.includes('apps/server/src/routes/conversations.ts:createConversationRoutes'));
  assert.ok(conversation.storageOwners.includes('apps/server/src/store/SqliteStore.ts:agent_runs + executions + events'));
  assert.ok(migration.repositoryServiceRouteSymbols.includes('LegacyDataMigrationRepository'));
  assert.ok(migration.routeServiceEntrypoints.includes('apps/server/src/services/LegacyBackupVerifier.ts:LegacyBackupVerifier'));
  assert.ok(operational.routeServiceEntrypoints.includes('apps/server/src/services/WorktreeManager.ts:WorktreeManager'));
  assert.ok(operational.storageOwners.includes('MemoryService:agent-memory/records/**/*.md'));
});

test('Conversation Inventory includes startup recovery readers, writers, and RunStep persistence', () => {
  const conversation = M2_ACCEPTANCE_INVENTORY.domains.find(domain => domain.domainId === 'conversation_runtime');
  assert.ok(conversation);
  assert.ok(conversation.startupEntrypoints.includes('apps/server/src/index.ts:recoverInterruptedRuns'));
  assert.ok(conversation.startupEntrypoints.includes('apps/server/src/runRecovery.ts:recoverInterruptedRuns'));
  assert.ok(conversation.startupEntrypoints.includes('apps/server/src/services/RunStepService.ts:RunStepService.reconcileInterruptedRun'));
  assert.ok(conversation.productionReaders.includes('apps/server/src/store/SqliteStore.ts:SqliteStore.listRunsForRecovery'));
  assert.ok(conversation.productionReaders.includes('apps/server/src/store/SqliteStore.ts:SqliteStore.listExecutions'));
  assert.ok(conversation.productionReaders.includes('apps/server/src/services/RunStepService.ts:RunStepService.reconcileInterruptedRun'));
  assert.ok(conversation.productionWriters.includes('apps/server/src/runRecovery.ts:recoverInterruptedRuns'));
  assert.ok(conversation.productionWriters.includes('apps/server/src/services/RunStepService.ts:RunStepService.reconcileInterruptedRun'));
  assert.ok(conversation.productionWriters.includes('apps/server/src/store/SqliteStore.ts:SqliteStore.updateExecution'));
  assert.ok(conversation.productionWriters.includes('apps/server/src/store/SqliteStore.ts:SqliteStore.updateRun'));
  assert.ok(conversation.productionWriters.includes('apps/server/src/store/SqliteStore.ts:SqliteStore.persistRunStepMutation'));
  assert.ok(conversation.productionWriters.includes('apps/server/src/store/SqliteStore.ts:SqliteStore.appendAgentEvent'));
});

test('Legacy Task and Task-domain Inventory separates startup recovery ownership', () => {
  const legacy = M2_ACCEPTANCE_INVENTORY.domains.find(domain => domain.domainId === 'legacy_task_item');
  const task = M2_ACCEPTANCE_INVENTORY.domains.find(domain => domain.domainId === 'task_domain_task_run');
  assert.ok(legacy && task);
  assert.ok(legacy.startupEntrypoints.includes('apps/server/src/taskRecovery.ts:recoverInterruptedRunningTasks'));
  assert.ok(legacy.productionWriters.includes('apps/server/src/store/JsonFileStore.ts:JsonFileStore.saveTasks'));
  assert.ok(task.startupEntrypoints.includes('apps/server/src/services/TaskRunService.ts:TaskRunService.recoverInterruptedLegacyQueuedRuns'));
  assert.ok(task.startupEntrypoints.includes('apps/server/src/store/RunRepository.ts:RunRepository.listByWorkspace'));
  assert.ok(task.startupEntrypoints.includes('apps/server/src/store/RunRepository.ts:RunRepository.failQueuedBridgeRestart'));
  assert.ok(task.productionReaders.includes('apps/server/src/taskRecovery.ts:recoverInterruptedTaskRuntime'));
  assert.ok(task.productionReaders.includes('apps/server/src/services/TaskRunService.ts:TaskRunService.recoverInterruptedLegacyQueuedRuns'));
  assert.ok(task.productionWriters.includes('apps/server/src/taskRecovery.ts:recoverInterruptedTaskRuntime'));
  assert.ok(task.productionWriters.includes('apps/server/src/services/TaskRunService.ts:TaskRunService.recoverInterruptedLegacyQueuedRuns'));
  assert.ok(task.productionWriters.includes('apps/server/src/store/RunRepository.ts:RunRepository.failQueuedBridgeRestart'));
  assert.ok(task.productionWriters.includes('apps/server/src/services/TaskRunService.ts:TaskRunService.resolveTaskAfterRunTerminal'));
  assert.ok(task.crossDomainWriters.includes('taskRecovery.recoverInterruptedTaskRuntime: Legacy TaskItem + Task-domain startup orchestration'));
  assert.ok(task.crossDomainWriters.includes('TaskRunService.recoverInterruptedLegacyQueuedRuns: tasks.json recovery + queued Bridge Run failure'));
});

test('Workspace delete Inventory records explicit cross-domain cleanup and verified Task/Run cascade', () => {
  const workspace = M2_ACCEPTANCE_INVENTORY.domains.find(domain => domain.domainId === 'workspace_aggregate');
  assert.ok(workspace);
  for (const table of [
    'agent_events', 'memory_fts', 'memories', 'execution_events', 'executions', 'run_event_sequences',
    'agent_runs', 'messages', 'conversation_members', 'conversations', 'agent_profiles', 'provider_configurations', 'workspaces',
  ]) {
    assert.ok(workspace.crossDomainWriters.includes(`SqliteStore.deleteWorkspace: ${table} cleanup`), table);
  }
  assert.ok(workspace.crossDomainWriters.includes('SqliteStore.deleteWorkspace: _workspace_tombstones write'));
  assert.ok(workspace.crossDomainWriters.includes('SqliteStore.deleteWorkspace: tasks/runs cascade verified by migration FK'));
});

test('Conversation Inventory exposes direct route-to-Store CRUD symbols', () => {
  const conversation = M2_ACCEPTANCE_INVENTORY.domains.find(domain => domain.domainId === 'conversation_runtime');
  assert.ok(conversation);
  for (const symbol of [
    'SqliteStore.createConversation', 'SqliteStore.createGroupConversation', 'SqliteStore.updateConversationTitle',
    'SqliteStore.updateConversationSettings', 'SqliteStore.updateGroupConversation', 'SqliteStore.deleteConversation',
    'SqliteStore.getRun', 'SqliteStore.listRuns', 'SqliteStore.listExecutions', 'SqliteStore.listExecutionEvents',
    'SqliteStore.listMessages', 'SqliteStore.updateRun',
  ]) {
    assert.ok(conversation.repositoryServiceRouteSymbols.includes(symbol), symbol);
  }
});

test('Every domain declares a startupEntrypoints array and recovery-capable domains are populated', () => {
  const domains = M2_ACCEPTANCE_INVENTORY.domains;
  assert.equal(domains.length, 8);
  for (const domain of domains) assert.ok(Array.isArray(domain.startupEntrypoints), domain.domainId);
  assert.ok(domains.find(domain => domain.domainId === 'workspace_aggregate')?.startupEntrypoints.length === 0);
  assert.ok(domains.find(domain => domain.domainId === 'conversation_runtime')!.startupEntrypoints.length > 0);
  assert.ok(domains.find(domain => domain.domainId === 'legacy_task_item')!.startupEntrypoints.length > 0);
  assert.ok(domains.find(domain => domain.domainId === 'task_domain_task_run')!.startupEntrypoints.length > 0);
  const readerCount = domains.reduce((count, domain) => count + domain.productionReaders.length, 0);
  const writerCount = domains.reduce((count, domain) => count + domain.productionWriters.length, 0);
  assert.equal(readerCount, 41);
  assert.equal(writerCount, 43);
  const evidenceDoc = readFileSync(new URL('../../../../docs/implementation/milestones/M2.8-p1-read-only-parity-inventory.md', import.meta.url), 'utf8');
  const counts = evidenceDoc.match(/Totals: 8 domains, (\d+) production reader entries, (\d+) production writer entries/);
  assert.ok(counts, 'evidence document must declare computed reader/writer totals');
  assert.equal(Number(counts[1]), readerCount);
  assert.equal(Number(counts[2]), writerCount);
});

test('plain object non-enumerable values are not accepted or silently ignored by serialization', () => {
  const legacy = taskRecord('task-1', {});
  const canonical = taskRecord('task-1', {});
  Object.defineProperty(legacy.fields, 'description_digest', { value: 'legacy-hidden', enumerable: false });
  Object.defineProperty(canonical.fields, 'description_digest', { value: 'canonical-hidden', enumerable: false });
  const result = new M2ReadOnlyParityService().compare(baseInput({ legacyRecords: [legacy], canonicalRecords: [canonical] }));
  assert.equal(result.classification, 'malformed');
  assert.notEqual(result.classification, 'equal');
});

test('nested object non-enumerable values are malformed rather than omitted', () => {
  const legacyMetadata: Record<string, unknown> = { visible: 'same' };
  const canonicalMetadata: Record<string, unknown> = { visible: 'same' };
  Object.defineProperty(legacyMetadata, 'hidden', { value: 'legacy-hidden', enumerable: false });
  Object.defineProperty(canonicalMetadata, 'hidden', { value: 'canonical-hidden', enumerable: false });
  const result = new M2ReadOnlyParityService().compare(baseInput({
    legacyRecords: [taskRecord('task-1', { task_metadata_digest: legacyMetadata })],
    canonicalRecords: [taskRecord('task-1', { task_metadata_digest: canonicalMetadata })],
  }));
  assert.equal(result.classification, 'malformed');
});

test('array custom properties are malformed rather than omitted', () => {
  const legacyArgs = ['same'] as string[] & { custom?: string };
  const canonicalArgs = ['same'] as string[] & { custom?: string };
  legacyArgs.custom = 'legacy-custom';
  canonicalArgs.custom = 'canonical-custom';
  const result = new M2ReadOnlyParityService().compare(baseInput({
    legacyRecords: [taskRecord('task-1', { task_metadata_digest: legacyArgs })],
    canonicalRecords: [taskRecord('task-1', { task_metadata_digest: canonicalArgs })],
  }));
  assert.equal(result.classification, 'malformed');
});

test('sparse arrays are malformed', () => {
  const legacySparse = new Array<string>(2);
  const canonicalSparse = new Array<string>(2);
  legacySparse[0] = 'same';
  canonicalSparse[0] = 'same';
  const result = new M2ReadOnlyParityService().compare(baseInput({
    legacyRecords: [taskRecord('task-1', { task_metadata_digest: legacySparse })],
    canonicalRecords: [taskRecord('task-1', { task_metadata_digest: canonicalSparse })],
  }));
  assert.equal(result.classification, 'malformed');
});

test('array accessor indexes are malformed without invoking the accessor', () => {
  const legacyAccessor: unknown[] = [];
  const canonicalAccessor: unknown[] = [];
  Object.defineProperty(legacyAccessor, '0', { get: () => 'private', enumerable: true });
  Object.defineProperty(canonicalAccessor, '0', { get: () => 'private', enumerable: true });
  Object.defineProperty(legacyAccessor, 'length', { value: 1 });
  Object.defineProperty(canonicalAccessor, 'length', { value: 1 });
  const result = new M2ReadOnlyParityService().compare(baseInput({
    legacyRecords: [taskRecord('task-1', { task_metadata_digest: legacyAccessor })],
    canonicalRecords: [taskRecord('task-1', { task_metadata_digest: canonicalAccessor })],
  }));
  assert.equal(result.classification, 'malformed');
});

test('every accepted enumerable normalized property changes the comparison when its value changes', () => {
  const result = new M2ReadOnlyParityService().compare(baseInput({
    legacyRecords: [taskRecord('task-1', { task_metadata_digest: { visible: 'legacy' } })],
    canonicalRecords: [taskRecord('task-1', { task_metadata_digest: { visible: 'canonical' } })],
  }));
  assert.equal(result.classification, 'mismatch');
  assert.ok(result.evidence.some(item => item.fieldName === 'task_metadata_digest'));
});

test('different Date values are malformed and never equal', () => {
  const result = new M2ReadOnlyParityService().compare({
    ...baseInput(),
    legacyRecords: [taskRecord('task-1', { priority: new Date('2026-01-01T00:00:00.000Z') })],
    canonicalRecords: [taskRecord('task-1', { priority: new Date('2026-01-02T00:00:00.000Z') })],
  });
  assert.equal(result.classification, 'malformed');
});

test('Map, Set, and class instances are malformed rather than equal', () => {
  class UnsupportedValue {
    constructor(readonly value: string) {}
  }
  for (const [legacyValue, canonicalValue] of [
    [new Map([['a', 1]]), new Map([['b', 2]])],
    [new Set(['a']), new Set(['b'])],
    [new UnsupportedValue('a'), new UnsupportedValue('b')],
  ] as const) {
    const result = new M2ReadOnlyParityService().compare({
      ...baseInput(),
      legacyRecords: [taskRecord('task-1', { priority: legacyValue })],
      canonicalRecords: [taskRecord('task-1', { priority: canonicalValue })],
    });
    assert.equal(result.classification, 'malformed');
  }
});

test('cyclic values return stable malformed evidence instead of throwing', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  let result: ReturnType<M2ReadOnlyParityService['compare']> | undefined;
  assert.doesNotThrow(() => {
    result = new M2ReadOnlyParityService().compare({
      ...baseInput(),
      legacyRecords: [taskRecord('task-1', { priority: cyclic })],
      canonicalRecords: [taskRecord('task-1', { priority: cyclic })],
    });
  });
  assert.equal(result?.classification, 'malformed');
});

test('NaN and infinities return malformed classifications', () => {
  for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const result = new M2ReadOnlyParityService().compare({
      ...baseInput(),
      legacyRecords: [taskRecord('task-1', { priority: invalid })],
      canonicalRecords: [taskRecord('task-1', { priority: invalid })],
    });
    assert.equal(result.classification, 'malformed');
  }
});

test('undefined, function, symbol, RegExp, Error, symbol-keyed, and accessor values are malformed', () => {
  const unsupportedValues: unknown[] = [undefined, () => 'private', Symbol('private'), /private/, new Error('private')];
  for (const invalid of unsupportedValues) {
    const result = new M2ReadOnlyParityService().compare({
      ...baseInput(),
      legacyRecords: [taskRecord('task-1', { priority: invalid })],
      canonicalRecords: [taskRecord('task-1', { priority: invalid })],
    });
    assert.equal(result.classification, 'malformed');
  }

  const symbolKey = Symbol('private-field');
  const symbolFields = taskRecord('task-1', {}).fields as Record<string | symbol, unknown>;
  symbolFields[symbolKey] = 'private';
  const symbolResult = new M2ReadOnlyParityService().compare({
    ...baseInput(),
    legacyRecords: [{ recordKey: 'task-1', fields: symbolFields, aggregate: 'task-domain' }],
    canonicalRecords: [{ recordKey: 'task-1', fields: symbolFields, aggregate: 'task-domain' }],
  });
  assert.equal(symbolResult.classification, 'malformed');

  const accessorFields = { ...taskRecord('task-1', {}).fields } as Record<string, unknown>;
  Object.defineProperty(accessorFields, 'task_metadata_digest', { get: () => 'private', enumerable: true });
  const accessorResult = new M2ReadOnlyParityService().compare({
    ...baseInput(),
    legacyRecords: [{ recordKey: 'task-1', fields: accessorFields, aggregate: 'task-domain' }],
    canonicalRecords: [{ recordKey: 'task-1', fields: accessorFields, aggregate: 'task-domain' }],
  });
  assert.equal(accessorResult.classification, 'malformed');
});

test('unknown field names return safe malformed evidence without the raw name', () => {
  const result = new M2ReadOnlyParityService().compare({
    ...baseInput(),
    legacyRecords: [taskRecord('task-1', { 'C:\\Users\\secret\\task.json': 'private' })],
    canonicalRecords: [taskRecord('task-1', { 'C:\\Users\\secret\\task.json': 'private' })],
  });
  assert.equal(result.classification, 'malformed');
  assert.ok(result.evidence.every(item => item.fieldName !== 'C:\\Users\\secret\\task.json'));
  assert.equal(JSON.stringify(result).includes('C:\\Users\\secret\\task.json'), false);
  assert.ok(result.evidence.some(item => item.fieldName === 'unknown_field'));
});

test('unknown credential field names do not leak into evidence', () => {
  const result = new M2ReadOnlyParityService().compare({
    ...baseInput(),
    legacyRecords: [taskRecord('task-1', { apiKey: 'private-api-key' })],
    canonicalRecords: [taskRecord('task-1', { apiKey: 'private-api-key' })],
  });
  assert.equal(result.classification, 'malformed');
  assert.equal(JSON.stringify(result).includes('apiKey'), false);
  assert.equal(JSON.stringify(result).includes('private-api-key'), false);
});

test('required and allowed optional normalized fields can still produce equal', () => {
  const result = new M2ReadOnlyParityService().compare(baseInput({
    legacyRecords: [taskRecord('task-1', { priority: 'high' })],
    canonicalRecords: [taskRecord('task-1', { priority: 'high' })],
  }));
  assert.equal(result.classification, 'equal');
});

test('empty or invalid behavior digests are malformed', () => {
  for (const behavior of [
    { legacyContractDigest: '', canonicalContractDigest: '' },
    { legacyContractDigest: 'not-a-digest', canonicalContractDigest: 'not-a-digest' },
  ]) {
    const result = new M2ReadOnlyParityService().compare(baseInput({ behavior }));
    assert.equal(result.classification, 'malformed');
  }
});

test('complete normalized input with valid behavior digest remains equal', () => {
  const result = new M2ReadOnlyParityService().compare(baseInput());
  assert.equal(result.classification, 'equal');
});

test('Unicode keys use deterministic ordering independent of input order', () => {
  const first = baseInput({
    legacyRecords: [taskRecord('é', { priority: { 'é': '1', a: '2' } }), taskRecord('a', { priority: { a: '2', 'é': '1' } })],
    canonicalRecords: [taskRecord('a', { priority: { 'é': '1', a: '2' } }), taskRecord('é', { priority: { a: '2', 'é': '1' } })],
  });
  const second = baseInput({
    legacyRecords: [...first.legacyRecords].reverse(),
    canonicalRecords: [...first.canonicalRecords].reverse(),
  });
  assert.deepEqual(new M2ReadOnlyParityService().compare(first), new M2ReadOnlyParityService().compare(second));
});

test('Comparator source contains no localeCompare ordering dependency', () => {
  const source = readFileSync(new URL('./M2ReadOnlyParityService.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\.localeCompare\(/);
});

test('Parity field maps cover all eight domains with frozen, normalized contracts', () => {
  const ids = M2_ACCEPTANCE_INVENTORY.domains.map(domain => domain.domainId);
  assert.deepEqual(Object.keys(M2_PARITY_FIELD_MAPS), ids);
  for (const domainId of ids) {
    const map = M2_PARITY_FIELD_MAPS[domainId];
    assert.equal(Object.isFrozen(map), true);
    assert.equal(Object.isFrozen(map.requiredLogicalFields), true);
    assert.equal(Object.isFrozen(map.allowedOptionalFields), true);
    assert.ok(map.expectedAggregate.length > 0);
    assert.ok(map.requiredLogicalFields.length > 0, domainId);
    assert.ok(map.behaviorContracts.length > 0, domainId);
    assert.equal(new Set(map.requiredLogicalFields).size, map.requiredLogicalFields.length);
    assert.ok(map.requiredLogicalFields.every(field => /^[a-z][a-z0-9_]*$/.test(field)), domainId);
  }
});

test('same record key with empty fields on both sides is not equal', () => {
  const emptyRecord: M2ParityRecord = { recordKey: 'task-1', fields: {}, aggregate: 'task-domain' };
  const result = new M2ReadOnlyParityService().compare(baseInput({
    legacyRecords: [emptyRecord],
    canonicalRecords: [emptyRecord],
  }));
  assert.notEqual(result.classification, 'equal');
  assert.equal(result.classification, 'malformed');
});

test('the same omitted required field on both sides is not equal', () => {
  const fields = taskRecord('task-1', {}).fields as Record<string, unknown>;
  delete fields.task_status;
  const incompleteRecord: M2ParityRecord = { recordKey: 'task-1', fields, aggregate: 'task-domain' };
  const result = new M2ReadOnlyParityService().compare(baseInput({
    legacyRecords: [incompleteRecord],
    canonicalRecords: [incompleteRecord],
  }));
  assert.equal(result.classification, 'malformed');
  assert.ok(result.evidence.some(item => item.fieldName === 'task_status'));
});

test('required behavior digest is mandatory for equal', () => {
  const result = new M2ReadOnlyParityService().compare(baseInput({ behavior: undefined }));
  assert.notEqual(result.classification, 'equal');
  assert.equal(result.classification, 'malformed');
  assert.equal(result.behavior.contractConsistent, false);
});

test('every domain rejects an empty input with the wrong aggregate', () => {
  for (const domainId of M2_ACCEPTANCE_INVENTORY.domains.map(domain => domain.domainId)) {
    const map = M2_PARITY_FIELD_MAPS[domainId];
    const wrongAggregate = map.expectedAggregate === 'task-domain' ? 'conversation' : 'task-domain';
    const result = new M2ReadOnlyParityService().compare({
      ...baseInput(),
      domainId,
      aggregate: wrongAggregate,
      legacyRecords: [],
      canonicalRecords: [],
    });
    assert.equal(result.classification, 'conflict', domainId);
  }
});

test('aggregate conflict evidence uses expected and actual aggregate digests', () => {
  const result = new M2ReadOnlyParityService().compare({
    ...baseInput(),
    legacyRecords: [taskRecord('task-1', {}, 'conversation')],
    canonicalRecords: [],
  });
  assert.equal(result.classification, 'conflict');
  const evidence = result.evidence.find(item => item.fieldName === 'aggregate');
  assert.ok(evidence);
  assert.equal(evidence.expectedValueDigest, sha256(JSON.stringify({ present: true, value: 'task-domain' })));
  assert.equal(evidence.actualValueDigest, sha256(JSON.stringify({ present: true, value: 'conversation' })));
  assert.notEqual(evidence.expectedValueDigest, evidence.actualValueDigest);
});

test('complete required fields and behavior digest are sufficient for equal', () => {
  const result = new M2ReadOnlyParityService().compare(baseInput());
  assert.equal(result.classification, 'equal');
  assert.equal(result.behavior.contractConsistent, true);
  assert.equal(result.counts.equal, 1);
});

test('each domain accepts a complete normalized field map only with its mapped aggregate', () => {
  for (const domainId of M2_ACCEPTANCE_INVENTORY.domains.map(domain => domain.domainId)) {
    const map = M2_PARITY_FIELD_MAPS[domainId];
    const fields = Object.fromEntries(map.requiredLogicalFields.map(field => [field, `value-${field}`]));
    const record: M2ParityRecord = { recordKey: 'record-1', fields, aggregate: map.expectedAggregate };
    const result = new M2ReadOnlyParityService().compare({
      ...baseInput(),
      domainId,
      aggregate: map.expectedAggregate,
      legacyRecords: [record],
      canonicalRecords: [record],
    });
    assert.equal(result.classification, 'equal', domainId);
  }
});

test('exact-byte SHA-256 is reported without exposing source bytes', () => {
  const result = new M2ReadOnlyParityService().compare(baseInput());
  assert.equal(result.source.sourceHash, sha256(SOURCE_BYTES));
  assert.equal(JSON.stringify(result).includes(Buffer.from(SOURCE_BYTES).toString('utf8')), false);
  assert.equal('sourceBytes' in result, false);
});

test('same logical input produces stable result and comparison hash', () => {
  const service = new M2ReadOnlyParityService();
  const first = service.compare(baseInput());
  const second = service.compare(baseInput());
  assert.deepEqual(second, first);
  assert.match(first.comparisonHash, /^[0-9a-f]{64}$/);
});

test('record and field input order does not change the result', () => {
  const first = baseInput({
    legacyRecords: [
      taskRecord('task-2', { status: 'done', priority: 2 }),
      taskRecord('task-1', { status: 'open', priority: 1 }),
    ],
    canonicalRecords: [
      taskRecord('task-2', { priority: 2, status: 'done' }),
      taskRecord('task-1', { priority: 1, status: 'open' }),
    ],
  });
  const second = baseInput({
    legacyRecords: [
      taskRecord('task-1', { priority: 1, status: 'open' }),
      taskRecord('task-2', { priority: 2, status: 'done' }),
    ],
    canonicalRecords: [
      taskRecord('task-1', { status: 'open', priority: 1 }),
      taskRecord('task-2', { status: 'done', priority: 2 }),
    ],
  });
  const service = new M2ReadOnlyParityService();
  assert.deepEqual(service.compare(second), service.compare(first));
});

test('equal classification requires fields and behavior to match', () => {
  const result = new M2ReadOnlyParityService().compare(baseInput());
  assert.equal(result.classification, 'equal');
  assert.equal(result.behavior.fieldConsistent, true);
  assert.equal(result.behavior.contractConsistent, true);
  assert.equal(result.counts.equal, 1);
});

test('missing_legacy and missing_canonical are distinct classifications', () => {
  const service = new M2ReadOnlyParityService();
  const missingLegacy = service.compare(baseInput({
    legacyRecords: [],
    canonicalRecords: [taskRecord('task-1', { status: 'open' })],
  }));
  const missingCanonical = service.compare(baseInput({
    legacyRecords: [taskRecord('task-1', { status: 'open' })],
    canonicalRecords: [],
  }));
  assert.equal(missingLegacy.classification, 'missing_legacy');
  assert.equal(missingCanonical.classification, 'missing_canonical');
});

test('mismatch includes only field names and value digests', () => {
  const result = new M2ReadOnlyParityService().compare(baseInput({
    canonicalRecords: [taskRecord('task-1', {
      status: 'in_progress',
      content: 'different private content',
      providerToken: 'different-private-token',
      commandArgs: ['--different-secret'],
    })],
  }));
  assert.equal(result.classification, 'mismatch');
  assert.equal(result.behavior.fieldConsistent, false);
  assert.ok(result.evidence.some(item => item.fieldName === 'task_status'));
  const serialized = JSON.stringify(result);
  for (const secret of ['private-provider-token', 'different-private-token', 'private task content', 'different private content', '--secret', '--different-secret']) {
    assert.equal(serialized.includes(secret), false, 'raw secret leaked: ' + secret);
  }
  for (const item of result.evidence) {
    assert.match(item.expectedValueDigest, /^[0-9a-f]{64}$/);
    assert.match(item.actualValueDigest, /^[0-9a-f]{64}$/);
  }
});

test('behavior mismatch is non-equal even when fields match', () => {
  const result = new M2ReadOnlyParityService().compare(baseInput({
    behavior: {
      legacyContractDigest: sha256('behavior-v1'),
      canonicalContractDigest: sha256('behavior-v2'),
    },
  }));
  assert.equal(result.classification, 'mismatch');
  assert.equal(result.behavior.fieldConsistent, true);
  assert.equal(result.behavior.contractConsistent, false);
  assert.ok(result.evidence.some(item => item.fieldName === 'behavior_contract'));
});

test('malformed, duplicate, tombstone, and conflict classifications are explicit', () => {
  const service = new M2ReadOnlyParityService();
  assert.equal(service.compare(baseInput({ sourceStatus: 'malformed' })).classification, 'malformed');
  assert.equal(service.compare(baseInput({ duplicateRecordKeys: ['task-1'] })).classification, 'duplicate');
  assert.equal(service.compare(baseInput({ tombstoneRecordKeys: ['task-1'] })).classification, 'tombstone');
  assert.equal(service.compare(baseInput({ conflictRecordKeys: ['task-1'] })).classification, 'conflict');
  for (const result of [
    service.compare(baseInput({ sourceStatus: 'malformed' })),
    service.compare(baseInput({ duplicateRecordKeys: ['task-1'] })),
    service.compare(baseInput({ tombstoneRecordKeys: ['task-1'] })),
    service.compare(baseInput({ conflictRecordKeys: ['task-1'] })),
  ]) {
    assert.equal(result.counts.equal ?? 0, 0);
  }
});

test('changed source hash invalidates the old result', () => {
  const input = baseInput();
  const previousSourceHash = sha256('old-source-bytes');
  const result = new M2ReadOnlyParityService().compare({
    ...input,
    source: {
      ...input.source,
      previousSourceHash,
    },
  });
  assert.equal(result.classification, 'changed_source');
  assert.equal(result.source.previousSourceHash, previousSourceHash);
});

test('invalid previousSourceHash is malformed and never appears in result JSON', () => {
  const invalidPreviousHash = 'C:\\Users\\Administrator\\secrets\\old-source.sha256';
  const result = new M2ReadOnlyParityService().compare(baseInput({
    source: { ...baseInput().source, previousSourceHash: invalidPreviousHash },
  }));
  assert.equal(result.classification, 'malformed');
  assert.equal(JSON.stringify(result).includes(invalidPreviousHash), false);
  assert.equal('previousSourceHash' in result.source, false);
});

test('path-like sourceKind is malformed and only its digest may be exposed', () => {
  const pathLikeSourceKind = 'C:\\Users\\Administrator\\workspace\\tasks.json';
  const result = new M2ReadOnlyParityService().compare(baseInput({
    source: { ...baseInput().source, sourceKind: pathLikeSourceKind },
  }));
  assert.equal(result.classification, 'malformed');
  assert.equal(JSON.stringify(result).includes(pathLikeSourceKind), false);
  assert.equal(result.source.sourceKind, sha256(pathLikeSourceKind));
});

test('valid previousSourceHash is the only source hash accepted for changed_source', () => {
  const previousSourceHash = sha256('previous-source-bytes');
  const result = new M2ReadOnlyParityService().compare(baseInput({
    source: { ...baseInput().source, previousSourceHash },
  }));
  assert.equal(result.classification, 'changed_source');
  assert.equal(result.source.previousSourceHash, previousSourceHash);
});

test('source identity redacts full local paths and database paths', () => {
  const input = baseInput();
  const result = new M2ReadOnlyParityService().compare({
    ...input,
    source: {
      ...input.source,
      sourceKey: 'C:\\Users\\Administrator\\workspace\\workspaces.json',
      scope: 'E:\\workspace\\Multi-Agent\\agentos',
      canonicalDatabaseOpaqueId: 'C:\\Users\\Administrator\\agentos.sqlite',
    },
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('C:\\Users\\Administrator'), false);
  assert.equal(serialized.includes('E:\\workspace\\Multi-Agent'), false);
  assert.match(result.source.sourceKey, /^[0-9a-f]{64}$/);
  assert.match(result.source.scope, /^[0-9a-f]{64}$/);
  assert.match(result.source.canonicalDatabaseOpaqueId, /^[0-9a-f]{64}$/);
});

test('Task content, Conversation content, provider credentials, and command args never appear in evidence', () => {
  const input = baseInput();
  const result = new M2ReadOnlyParityService().compare({
    ...input,
    canonicalRecords: [taskRecord('task-1', {
      message: 'private conversation message',
      providerCredential: 'credential-value',
      commandArgs: ['--api-key', 'api-key-value'],
      content: 'private task body',
    })],
  });
  const serialized = JSON.stringify(result);
  for (const secret of ['private conversation message', 'credential-value', '--api-key', 'api-key-value', 'private task body']) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('comparison does not mutate input objects, arrays, field maps, or source bytes', () => {
  const input = baseInput();
  const beforeInput = structuredClone(input);
  const beforeBytes = Array.from(input.source.sourceBytes);
  new M2ReadOnlyParityService().compare(input);
  assert.deepEqual(input, beforeInput);
  assert.deepEqual(Array.from(input.source.sourceBytes), beforeBytes);
});

test('Comparator exposes no write/save/update/delete/apply interface', () => {
  const methodNames = Object.getOwnPropertyNames(M2ReadOnlyParityService.prototype);
  assert.deepEqual(methodNames, ['constructor', 'compare']);
  assert.equal(methodNames.some(name => /write|save|update|delete|apply/i.test(name)), false);
});

test('Task-domain comparison rejects Conversation aggregate records', () => {
  const result = new M2ReadOnlyParityService().compare({
    ...baseInput(),
    legacyRecords: [taskRecord('conversation-run-1', { event: 'agent' }, 'conversation')],
    canonicalRecords: [taskRecord('conversation-run-1', { event: 'agent' }, 'conversation')],
  });
  assert.equal(result.classification, 'conflict');
  assert.ok(result.evidence.some(item => item.redactedReason === 'aggregate_boundary_mismatch'));
  assert.equal(JSON.stringify(result).includes('agent'), false);
});

test('Conversation comparison rejects Task-domain runs', () => {
  const input = baseInput();
  const result = new M2ReadOnlyParityService().compare({
    ...input,
    domainId: CONVERSATION_DOMAIN,
    aggregate: 'conversation',
    legacyRecords: [taskRecord('task-run-1', { status: 'running' }, 'task-domain')],
    canonicalRecords: [taskRecord('task-run-1', { status: 'running' }, 'task-domain')],
  });
  assert.equal(result.classification, 'conflict');
  assert.ok(result.evidence.some(item => item.redactedReason === 'aggregate_boundary_mismatch'));
});

test('Comparator produces no file or database side effects', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentos-m2-p1-parity-'));
  const sentinel = join(root, 'sentinel.txt');
  writeFileSync(sentinel, 'unchanged', 'utf8');
  const beforeFiles = readdirSync(root);
  const beforeBytes = readFileSync(sentinel);
  try {
    new M2ReadOnlyParityService().compare(baseInput());
    assert.deepEqual(readdirSync(root), beforeFiles);
    assert.deepEqual(readFileSync(sentinel), beforeBytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
