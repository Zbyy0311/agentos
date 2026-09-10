import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKFLOW_TEMPLATES_V1 } from '@agentos/shared';
import { SqliteStore } from '../store/SqliteStore.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { WorkflowTemplateService, WorkflowTemplateServiceError } from './WorkflowTemplateService.js';

const NOW = '2026-09-10T00:00:00.000Z';

function createProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentos-wf-template-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({
    workspaces: [{
      id: 'workspace-a', name: 'Workspace A', rootPath: root, gitEnabled: false, memoryEnabled: false,
      agents: [
        { id: 'codex', name: 'Codex', role: 'codex', enabled: true, cliCommand: 'codex', cliArgs: [] },
      ],
      lastOpenedAt: NOW, createdAt: NOW, updatedAt: NOW,
    }],
  }), 'utf-8');
  return root;
}

function fixture() {
  const root = createProjectRoot();
  const store = new SqliteStore(root);
  const workspace = new WorkspaceManager(store).get('workspace-a');
  if (!workspace) throw new Error('fixture workspace missing');
  const service = new WorkflowTemplateService({
    store,
    workflowDefinitionRepository: () => store.workflowDefinitionRepository(),
    taskRepository: () => store.taskRepository(),
    runRepository: () => store.runRepository(),
    runSnapshotRepository: () => store.runSnapshotRepository(),
    runStageRepository: () => store.runStageRepository(),
    providerConfigurationRepository: () => store.providerConfigurationRepository(),
    findAgentSnapshotSource: (workspaceId, agentId) => store.findAgentSnapshotSource(workspaceId, agentId),
  });
  return {
    store, workspace, service,
    close: () => { try { store.close(); } finally { rmSync(root, { recursive: true, force: true }); } },
  };
}

function template(key: string) {
  const found = WORKFLOW_TEMPLATES_V1.find(t => t.key === key);
  if (!found) throw new Error('template missing: ' + key);
  return found;
}

test('WF-01 a compiled template persists a definition and creates Task/Run/Snapshot/Stages', () => {
  const fx = fixture();
  try {
    const result = fx.service.instantiateTemplateRun({
      workspace: fx.workspace,
      template: template('plan-implement-review'),
      roleBindings: { planner: 'codex', implementer: 'codex', reviewer: 'codex' },
      createdBy: 'user',
      objective: 'ship it',
      createdAt: NOW,
    });
    // the definition is durable and re-resolvable
    const persisted = fx.store.workflowDefinitionRepository().findById(result.definition.id);
    assert.ok(persisted !== undefined);
    assert.equal(persisted!.definitionKey, 'plan-implement-review');
    assert.equal(persisted!.payload.schemaVersion, 2);

    // exactly one Task and one Run
    assert.equal(result.run.taskId, result.task.id);
    assert.equal(result.run.status, 'queued');
    assert.equal(result.run.origin, 'v2_api');
    assert.equal(result.run.objective, 'ship it');

    // stages mirror the template keys and dependencies
    assert.deepEqual(result.stages.map(s => s.workflowStageKey), ['plan', 'implement', 'review']);
    assert.equal(result.snapshot.payload.schemaVersion, 2);
    assert.equal(result.snapshot.payload.workflow.definitionKey, 'plan-implement-review');
  } finally { fx.close(); }
});

test('WF-02 an unbound role fails closed before anything is persisted', () => {
  const fx = fixture();
  try {
    assert.throws(
      () => fx.service.instantiateTemplateRun({
        workspace: fx.workspace,
        template: template('plan-implement-review'),
        roleBindings: { planner: 'codex' },   // implementer/reviewer unbound
        createdBy: 'user',
        createdAt: NOW,
      }),
      (error: unknown) => error instanceof WorkflowTemplateServiceError && error.code === 'TEMPLATE_COMPILE_FAILED',
    );
    assert.equal(fx.store.workflowDefinitionRepository().findLatestAvailableByKey('plan-implement-review'), undefined);
    assert.equal(fx.store.taskRepository().findByLegacyTaskId('workspace-a', 'nope'), undefined);
  } finally { fx.close(); }
});

test('WF-03 a single-agent template produces one Stage and never hard-codes an Agent', () => {
  const fx = fixture();
  try {
    const result = fx.service.instantiateTemplateRun({
      workspace: fx.workspace,
      template: template('single-agent'),
      roleBindings: { 'single-agent': 'codex' },
      createdBy: 'user',
      createdAt: NOW,
    });
    assert.deepEqual(result.stages.map(s => s.workflowStageKey), ['agent']);
    // the Stage binds whatever Agent the caller chose; the template carries no Agent
    assert.equal(result.stages.length, 1);
  } finally { fx.close(); }
});

test('WF-04 the legacy pipeline and unbound definitions still resolve unchanged', () => {
  const fx = fixture();
  try {
    // the instantiation must not disturb the built-in definitions
    const legacy = fx.store.workflowDefinitionRepository().findLatestAvailableByKey('legacy-pipeline');
    const unbound = fx.store.workflowDefinitionRepository().findLatestAvailableByKey('unbound-task-run');
    assert.ok(legacy !== undefined && unbound !== undefined);
    const result = fx.service.instantiateTemplateRun({
      workspace: fx.workspace,
      template: template('single-agent'),
      roleBindings: { 'single-agent': 'codex' },
      createdBy: 'user',
      createdAt: NOW,
    });
    assert.notEqual(result.definition.id, legacy!.id);
    assert.notEqual(result.definition.id, unbound!.id);
    assert.equal(fx.store.workflowDefinitionRepository().findLatestAvailableByKey('legacy-pipeline')!.id, legacy!.id);
  } finally { fx.close(); }
});
