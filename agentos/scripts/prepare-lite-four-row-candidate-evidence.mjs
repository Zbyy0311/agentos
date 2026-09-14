import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

import { WorkspaceManager } from '../apps/server/dist/managers/WorkspaceManager.js';
import { SqliteStore } from '../apps/server/dist/store/SqliteStore.js';
import { SnapshotService } from '../apps/server/dist/services/SnapshotService.js';
import { TaskRunService } from '../apps/server/dist/services/TaskRunService.js';
import { WorkflowDefinitionResolver } from '../apps/server/dist/services/WorkflowDefinitionResolver.js';

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith('--')) continue;
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for --${key}`);
    result[key] = value;
    index += 1;
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));
const acceptanceRoot = resolve(args['acceptance-root'] ?? '');
const setupJson = resolve(args['setup-json'] ?? join(acceptanceRoot, 'candidate-setup.json'));
if (!args['acceptance-root']) throw new Error('--acceptance-root is required');

mkdirSync(join(acceptanceRoot, 'candidate-evidence'), { recursive: true });
const store = new SqliteStore(acceptanceRoot);
try {
  // The JSON compatibility loader can expose a second legacy workspace whose
  // canonical path collides with the SQLite workspace. Task/Run foreign keys
  // require the durable SQLite row, so bind only to a workspace that exists in
  // the same database used by the production server.
  const workspace = new WorkspaceManager(store).list()
    .find(candidate => store.workspaceRepo.findById(candidate.id) !== undefined);
  if (!workspace) throw new Error('no workspace available after server initialization');

  // The production v2 creation path intentionally resolves an unbound workflow
  // with no stages. The candidate harness binds the already persisted legacy
  // workflow only to create a real four-stage Run for the production dispatcher;
  // it does not change production code or acceptance state.
  const snapshotService = new SnapshotService({
    workflowDefinitionResolver: new WorkflowDefinitionResolver(store.workflowDefinitionRepository()),
    runSnapshotRepository: () => store.runSnapshotRepository(),
    runStageRepository: () => store.runStageRepository(),
    providerConfigurationRepository: () => store.providerConfigurationRepository(),
    findAgentSnapshotSource: (workspaceId, agentId) => store.findAgentSnapshotSource(workspaceId, agentId),
  });
  snapshotService.resolveUnbound = () => snapshotService.resolveLegacy(workspace);
  // The canonical Codex/Kimi adapters require structured output. The legacy
  // workspace JSON has no output-mode field, so the compatibility migration
  // defaults those provider rows to parsed-text. Update the temporary evidence
  // workspace's durable provider configuration before freezing the Run
  // snapshot; OpenCode keeps its parsed-text contract.
  store.runInTransaction(() => {
    store.getDatabase().prepare(
      "UPDATE provider_configurations SET output_mode = 'structured', updated_at = ?, version = version + 1 WHERE workspace_id = ? AND provider_type IN ('codex', 'kimicode')",
    ).run(new Date().toISOString(), workspace.id);
  });
  const service = new TaskRunService(store, { snapshotService });
  const task = service.createTask(workspace.id, {
    title: 'S8 four-row candidate disconnect run',
    createdBy: 'candidate-evidence',
  });
  const run = service.createRun(workspace.id, {
    taskId: task.id,
    reason: 'initial',
    objective: '候选证据：请保持运行至少三十秒后返回 AGENTOS_CANDIDATE_HOLD_OK，不要修改文件。',
    createdBy: 'candidate-evidence',
  });
  const stages = store.runStageRepository().listByRun(workspace.id, run.id);
  if (stages.length !== 4) throw new Error(`expected four persisted stages, got ${stages.length}`);

  // Production dispatch is admission-gated. The direct setup creates the same
  // durable GRANTED authority that an admitted canonical caller would have;
  // the start route and dispatcher remain production code paths.
  const now = new Date().toISOString();
  const admissionId = `candidate-admission-${randomUUID()}`;
  let cancelOperation;
  store.runInTransaction(() => {
    const admissions = store.workspaceAdmissionRepository();
    admissions.insertAdmission({
      id: admissionId,
      workspaceId: workspace.id,
      subjectKind: 'CANONICAL_RUN',
      canonicalRunId: run.id,
      legacyRunId: null,
      requestedMutationClass: 'MODIFYING',
      effectiveMutationClass: 'MODIFYING',
      enforcementEvidenceJson: null,
      requestOrder: (admissions.maxRequestOrder(workspace.id) ?? 0) + 1,
      state: 'GRANTED',
      queueReason: null,
      releaseReason: null,
      requestedAt: now,
      grantedAt: now,
      releasedAt: null,
      createdAt: now,
      updatedAt: now,
      version: 1,
    });
    cancelOperation = store.operationService().createWithinTransaction({
      workspaceId: workspace.id,
      runId: run.id,
      type: 'run.cancel',
    });
  });

  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const baselineSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
  const setup = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    baselineSha,
    workspaceId: workspace.id,
    taskId: task.id,
    runId: run.id,
    admissionId,
    cancelOperationId: cancelOperation.id,
    cancelOperationVersion: cancelOperation.version,
    stageIds: stages.map(stage => stage.id),
    stageKeys: stages.map(stage => stage.workflowStageKey),
    providerOutputModes: { codex: 'structured', kimi: 'structured', opencode: 'parsed-text' },
    routeModels: {
      codex: 'deepseek/deepseek-flash',
      kimi: 'opencodex/deepseek/deepseek-flash',
      opencode: 'deepseek/deepseek-v4-flash',
    },
    modelScopeStatement: '此证据验证的是指定路由模型下的 AgentOS Provider/Runtime canonical chain，不证明机器默认模型或额度受限模型可用。',
  };
  writeFileSync(setupJson, `${JSON.stringify(setup, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(setup)}\n`);
} finally {
  store.close();
}
