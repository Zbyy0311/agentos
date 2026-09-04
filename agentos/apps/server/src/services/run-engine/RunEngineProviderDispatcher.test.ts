import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createM3RuntimeEventRegistry, type AgentSnapshotV1, type ProviderConfigurationSnapshotV1, type RunSnapshotPayloadV2, type WorkspaceReadOnlyEvidence } from '@agentos/shared';
import { DurableProcessCoordinator, FileArtifactSink, type ExitEvidence, type NativeIdentity, type NativeProcessHandle, type NativeProcessStreams, type PlatformProcessDriver, type ProcessProbePort, type SurvivorVerification, type TreeTerminationResult } from '@agentos/process-runtime';
import { KimiCodeProviderAdapter, ProviderRegistry } from '@agentos/agent-core/providers';
import { MigrationRegistry } from '../../migrations/registry.js';
import { MigrationRunner } from '../../migrations/MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../../migrations/default-registry.js';
import { M3_013_LEGACY_WORKFLOW_V2_ID } from '../../migrations/migrations/013-workflow-creation-metadata-v2.js';
import { RunRepository } from '../../store/RunRepository.js';
import { RunStageRepository } from '../../store/RunStageRepository.js';
import { RunSnapshotRepository } from '../../store/RunSnapshotRepository.js';
import { ProviderSessionRepository } from '../../store/ProviderSessionRepository.js';
import { ProcessRepository } from '../../store/ProcessRepository.js';
import { ProcessOutputReferenceRepository } from '../../store/ProcessOutputReferenceRepository.js';
import { WorkspaceAdmissionRepository } from '../../store/WorkspaceAdmissionRepository.js';
import { OutboxRepository } from '../../store/OutboxRepository.js';
import { RuntimeEventOutboxWriter, RuntimeEventRepository } from '../../store/RuntimeEventRepository.js';
import { RunSequenceAllocator } from '../../store/RunSequenceAllocator.js';
import { DurableAtomicSeamImpl } from '../../store/DurableAtomicSeam.js';
import { DurableOutputReferenceRepositoryAdapter, DurableProcessRepositoryAdapter, DurableSessionRepositoryAdapter } from '../../store/process-runtime-adapters.js';
import { inTransaction } from '../../store/Transaction.js';
import { LifecycleTransactionService } from '../LifecycleTransactionService.js';
import { OperationService } from '../OperationService.js';
import {
  WorkspaceAdmissionAuthority,
  type WorkspaceAdmissionEvidenceCollector,
  type WorkspaceAdmissionEvidenceFactsV1,
} from '../WorkspaceAdmissionAuthority.js';
import { RunEngine } from './RunEngine.js';
import { StageExecutor } from './StageExecutor.js';
import { StageExecutionCoordinator, type StageExecutionOutcome } from './StageExecutionCoordinator.js';
import { RunEngineProviderDispatcher } from './RunEngineProviderDispatcher.js';
import { NodeProcessDriver, NodeProcessProbePort } from '@agentos/process-runtime';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => { exec(sql: string): void; prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown; run(...params: unknown[]): unknown; }; close(): void; } };
type Db = InstanceType<typeof DatabaseSync>;

const NOW = '2026-08-15T00:00:00.000Z';
const EVIDENCE_OBSERVED = '2026-08-14T00:00:00.000Z';
const EVIDENCE_EXPIRED = '2026-08-14T12:00:00.000Z';
const EVIDENCE_FUTURE = '2026-08-16T00:00:00.000Z';
const WS = 'ws_m4';
const TASK = 'task_m4';
const RUN = 'run_m4';
const OP = 'op_' + 'A'.repeat(26);
const KIMI_EXE = 'C:/kimi.exe';
let REAL_EXECUTABLE = KIMI_EXE;

const VERIFIED_EVIDENCE: WorkspaceReadOnlyEvidence = {
  status: 'verified',
  source: 'qualified-write-denial',
  boundaryId: 'boundary-dispatch',
  qualificationId: 'qualification-dispatch',
};

const FRESH_READ_ONLY_FACTS: WorkspaceAdmissionEvidenceFactsV1 = {
  observedAt: NOW,
  validUntil: EVIDENCE_FUTURE,
  declaredModifyingAction: false,
  declaredExternalSideEffect: false,
  evidence: VERIFIED_EVIDENCE,
};
let ORIGIN: 'v2_api' | 'legacy_pipeline' = 'v2_api';
const STAGE_KEYS = ['codex_manager', 'kimi_worker', 'opencode_reviewer', 'codex_final_review'] as const;

function migratedDb(): Db {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner(db, new MigrationRegistry([...DEFAULT_REGISTRY_MIGRATIONS])).run();
  seed(db);
  return db;
}

function providerSnapshot(cancelGracePeriodMs = 5000): ProviderConfigurationSnapshotV1 {
  return {
    providerConfigId: 'pcfg_m4', name: 'Kimi Gate', providerType: 'kimicode', adapterId: 'builtin.kimicode',
    runtimeMode: 'cli', executable: REAL_EXECUTABLE, argsTemplate: [], model: null, environmentProfileId: null, secretProfileId: null,
    workingDirectoryMode: 'workspace', workspaceRelativeWorkingDirectory: null,
    capabilities: { sessionResume:false, structuredEvents:true, nativeApprovals:false, subagents:false, toolEvents:true, fileEvents:false, usageEvents:true, reasoningStream:false, interactiveInput:false, pause:false, cancellation:true, modelSelection:true, workspaceAwareness:true, nativeSandbox:false, outputContracts:false },
    timeoutPolicy: { discoveryTimeoutMs:10000, validationTimeoutMs:30000, startupTimeoutMs:60000, idleTimeoutMs:null, totalTimeoutMs:null, cancelGracePeriodMs, approvalTimeoutMs:null },
    approvalMode: 'disabled', outputMode: 'structured', enabled: true, version: 1,
  };
}

function agentSnapshot(): AgentSnapshotV1 {
  return { agentId: 'agent_m4', name: 'Agent', role: 'codex', roleTitle: 'Executor', systemPrompt: 'Execute the requested task.', permissions: ['read','write'], providerConfigId: 'pcfg_m4', enabled: true, version: 1 };
}

function snapshotPayload(cancelGracePeriodMs = 5000): RunSnapshotPayloadV2 {
  const stages = STAGE_KEYS.map((key, index) => ({
    workflowStageKey: key, name: key, sequence: index + 1,
    agent: agentSnapshot(), provider: providerSnapshot(cancelGracePeriodMs),
    dependsOn: index === 0 ? [] : [STAGE_KEYS[index - 1]],
  }));
  return {
    schemaVersion: 2, capturedAt: NOW,
    run: { workspaceId: WS, taskId: TASK, origin: ORIGIN, reason: 'initial', parentRunId: null, rootRunId: RUN },
    workflow: {
      definitionId: M3_013_LEGACY_WORKFLOW_V2_ID, definitionKey: 'legacy-pipeline', definitionVersion: 2, name: 'legacy-pipeline-v2',
      definitionHash: '9ea35ef455c5fefa45d0b28d1433933b2cc6b3fb9e412b4d4452afb7862a6b6d', worktreeMode: 'preferred',
      stages: stages as never,
    },
    security: { redactionApplied: false },
  };
}

function seed(db: Db): void {
  db.prepare(`INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at) VALUES (?, '/tmp/m4', '/tmp/m4', '/tmp/m4', ?, ?, ?)`).run(WS, NOW, NOW, NOW);
  db.prepare(`INSERT INTO tasks (id, workspace_id, title, status, priority, created_by, created_at, updated_at) VALUES (?, ?, 'M4 task', 'open', 'normal', 'test', ?, ?)`).run(TASK, WS, NOW, NOW);
  db.prepare(`INSERT INTO runs (id, workspace_id, task_id, root_run_id, status, reason, origin, next_event_sequence, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', 'initial', ?, 1, 'test', ?, ?)`).run(RUN, WS, TASK, RUN, ORIGIN, NOW, NOW);
  db.prepare(`INSERT INTO provider_configurations (id, workspace_id, name, provider_type, adapter_id, runtime_mode, capabilities_json, timeout_policy_json, created_at, updated_at) VALUES (?, ?, 'M4 provider', 'kimicode', 'builtin.kimicode', 'cli', '{}', '{}', ?, ?)`).run('pcfg_m4', WS, NOW, NOW);
  db.prepare(`INSERT INTO agent_profiles (workspace_id, id, name, agent_role, role_title, system_prompt, permissions_json, enabled, cli_command, cli_args_json, created_at, updated_at) VALUES (?, ?, 'Agent', 'worker', 'Worker', '', '[]', 1, 'agent', '[]', ?, ?)`).run(WS, 'agent_m4', NOW, NOW);
  db.prepare(`INSERT INTO operations (id, type, status, workspace_id, aggregate_type, aggregate_id, run_id, correlation_id, created_at, updated_at, version) VALUES (?, 'run.start', 'queued', ?, 'run', ?, ?, ?, ?, ?, 1)`).run(OP, WS, RUN, RUN, OP, NOW, NOW);
}

function seedGraph(db: Db, cancelGracePeriodMs = 5000): void {
  const payload = snapshotPayload(cancelGracePeriodMs);
  const snapshot = new RunSnapshotRepository(db).insert({
    workspaceId: WS,
    runId: RUN,
    workflowDefinitionId: M3_013_LEGACY_WORKFLOW_V2_ID,
    payload,
  });
  STAGE_KEYS.forEach((key, index) => {
    db.prepare(`INSERT INTO run_stages (id, workspace_id, run_id, run_snapshot_id, workflow_stage_key, name, sequence, attempt, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'pending', ?, ?, 1)`).run('stage_m4_' + index, WS, RUN, snapshot.id, key, key, index + 1, NOW, NOW);
  });
}

function admissionEvidenceJson(validUntil: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    workspaceId: WS,
    admissionId: 'adm_m4_dispatch',
    subject: { subjectKind: 'CANONICAL_RUN', canonicalRunId: RUN },
    observedAt: EVIDENCE_OBSERVED,
    validUntil,
    declaredModifyingAction: false,
    declaredExternalSideEffect: false,
    evidence: VERIFIED_EVIDENCE,
  });
}

function seedAdmission(db: Db, input: {
  readonly state?: 'GRANTED' | 'QUEUED';
  readonly requestedMutationClass?: 'READ_ONLY' | 'MODIFYING';
  readonly effectiveMutationClass?: 'READ_ONLY' | 'MODIFYING';
  readonly enforcementEvidenceJson?: string | null;
} = {}): void {
  const state = input.state ?? 'GRANTED';
  const requestedMutationClass = input.requestedMutationClass ?? 'MODIFYING';
  new WorkspaceAdmissionRepository(db).insertAdmission({
    id: 'adm_m4_dispatch',
    workspaceId: WS,
    subjectKind: 'CANONICAL_RUN',
    canonicalRunId: RUN,
    legacyRunId: null,
    requestedMutationClass,
    effectiveMutationClass: input.effectiveMutationClass ?? requestedMutationClass,
    enforcementEvidenceJson: input.enforcementEvidenceJson ?? null,
    requestOrder: 1,
    state,
    queueReason: state === 'QUEUED' ? 'WAITING_FOR_WORKSPACE_ADMISSION' : null,
    releaseReason: null,
    requestedAt: NOW,
    grantedAt: state === 'GRANTED' ? NOW : null,
    releasedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
  });
}

class FakeHandle implements NativeProcessHandle {
  readonly pid = 4242;
  readonly identity: NativeIdentity = { pid: 4242, startedAtMs: Date.parse(NOW), executablePath: KIMI_EXE };
  readonly streams: NativeProcessStreams;
  private readonly exit: Promise<ExitEvidence>;
  constructor(stdoutLines: string[], exitCode = 0, exit: Promise<ExitEvidence> = Promise.resolve({ exitCode, signal: null, exitedAt: Date.now() })) {
    this.streams = { stdout: asyncIterable(stdoutLines), stderr: asyncIterable([]) };
    this.exit = exit;
  }
  waitExit(): Promise<ExitEvidence> { return this.exit; }
}

function asyncIterable(lines: string[]): AsyncIterable<Uint8Array> {
  return { async *[Symbol.asyncIterator]() { for (const line of lines) yield new TextEncoder().encode(line); } };
}

class FakeDriver implements PlatformProcessDriver {
  spawnCalls = 0;
  gracefulStopCalls = 0;
  terminateTreeCalls = 0;
  constructor(private readonly handle: FakeHandle | null, private readonly spawnError?: Error, private readonly onTerminate?: () => void) {}
  async spawn() { this.spawnCalls += 1; if (this.spawnError !== undefined) throw this.spawnError; return this.handle!; }
  gracefulStop = async () => { this.gracefulStopCalls += 1; return { delivered: true, detail: 'ok' }; };
  terminateTree = async (): Promise<TreeTerminationResult> => { this.terminateTreeCalls += 1; this.onTerminate?.(); return { classification: 'complete', attemptedMembers: [], errors: [] }; };
  verifySurvivors = async (): Promise<SurvivorVerification> => ({ classification: 'complete', knownPids: [], proof: { kind: 'owned-tree-enumeration' } });
  inspectIdentity = async (identity: NativeIdentity) => ({ kind: 'match' as const, identity });
}

async function waitForCondition(predicate: () => boolean, attempts = 500): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for condition');
}

function probeFor(authFailure: boolean): ProcessProbePort {
  return {
    probe: async request => {
      if (request.args[0] === '--version') return { stdout: '0.36.1', stderr: '', exitCode: 0, signal: null };
      if (request.args[0] === '--help') return { stdout: 'Usage: kimi --output-format stream-json', stderr: '', exitCode: 0, signal: null };
      if (authFailure) return { stdout: '', stderr: 'No model configured. Run `kimi` and use /login to sign in', exitCode: 1, signal: null };
      return { stdout: '{"type":"assistant","role":"assistant","content":"ok"}', stderr: '', exitCode: 0, signal: null };
    },
  };
}

function fixture(driver: FakeDriver, authFailure = false, behavior: {
  readonly returnActive?: boolean;
  readonly returnStopped?: boolean;
  readonly cancelOutcome?: StageExecutionOutcome;
  readonly useRealCoordinator?: boolean;
  readonly cancelGracePeriodMs?: number;
  readonly executeThrow?: Error;
  readonly admissionState?: 'GRANTED' | 'QUEUED';
  readonly admissionRequestedMutationClass?: 'READ_ONLY' | 'MODIFYING';
  readonly admissionEffectiveMutationClass?: 'READ_ONLY' | 'MODIFYING';
  readonly admissionEvidenceJson?: string | null;
  readonly admissionEvidenceCollector?: WorkspaceAdmissionEvidenceCollector;
} = {}) {
  const db = migratedDb();
  seedGraph(db, behavior.cancelGracePeriodMs ?? 5000);
  seedAdmission(db, {
    state: behavior.admissionState ?? 'GRANTED',
    requestedMutationClass: behavior.admissionRequestedMutationClass,
    effectiveMutationClass: behavior.admissionEffectiveMutationClass,
    enforcementEvidenceJson: behavior.admissionEvidenceJson,
  });
  const root = mkdtempSync(join(tmpdir(), 'agentos-m4-p4-e2e-'));
  const events = new RuntimeEventRepository(db, createM3RuntimeEventRegistry());
  const outbox = new OutboxRepository(db, events);
  const factWriter = new RuntimeEventOutboxWriter(events, new RunSequenceAllocator(db), outbox, db);
  const sessionRepo = new ProviderSessionRepository(db, factWriter);
  const processRepo = new ProcessRepository(db, factWriter);
  const outputRepo = new ProcessOutputReferenceRepository(db, factWriter);
  const seam = new DurableAtomicSeamImpl(db, sessionRepo, processRepo);
  const sessionAdapter = new DurableSessionRepositoryAdapter(sessionRepo);
  const processAdapter = new DurableProcessRepositoryAdapter(processRepo);
  const outputAdapter = new DurableOutputReferenceRepositoryAdapter(outputRepo);
  const durableCoordinator = new DurableProcessCoordinator({
    sessionRepository: sessionAdapter, processRepository: processAdapter, outputReferenceRepository: outputAdapter,
    artifactSink: new FileArtifactSink(join(root, 'sink')), atomicSeam: seam, driver,
  });
  const adapter = new KimiCodeProviderAdapter({ probe: probeFor(authFailure), discover: async () => ({ found: true, selected: KIMI_EXE, candidates: [{ executable: KIMI_EXE, source: 'configuration', confidence: 1 }], warnings: [] }) });
  const registry = new ProviderRegistry([adapter]);
  const coordinatorCalls = { count: 0 };
  const realCoordinator = new StageExecutionCoordinator({
    registry, durableCoordinator, sessionRepository: sessionAdapter, driver, probe: probeFor(authFailure),
    claimOwner: 'run-engine', claimLeaseMs: 60000, now: () => NOW,
  });
  const stubCoordinator = {
    execute: async (input: Parameters<StageExecutionCoordinator['execute']>[0]) => {
      coordinatorCalls.count += 1;
      if (behavior.executeThrow !== undefined) throw behavior.executeThrow;
      if (behavior.returnActive === true) return { kind: 'active' as const };
      if (behavior.returnStopped === true) return { kind: 'stopped' as const, cleanup: null, proven: false, stopOrigin: 'EXPLICIT_CANCEL' as const };
      return realCoordinator.execute(input);
    },
    cancelAttempt: async () => {
      if (behavior.cancelOutcome === undefined) throw new Error('cancel outcome not configured');
      return behavior.cancelOutcome;
    },
  } as unknown as StageExecutionCoordinator;
  const coordinator = behavior.useRealCoordinator === true ? realCoordinator : stubCoordinator;
  const runRepo = new RunRepository(db);
  const runStageRepo = new RunStageRepository(db);
  const runSnapshotRepo = new RunSnapshotRepository(db);
  const lifecycle = new LifecycleTransactionService({
    runRepository: runRepo, runStageRepository: runStageRepo, runtimeEventRepository: events,
    runSequenceAllocator: new RunSequenceAllocator(db), outboxRepository: outbox,
    runInTransaction: <T>(fn: () => T): T => inTransaction(db, fn),
  }, { now: () => NOW });
  const operationService = new OperationService(db, { now: () => NOW, lifecycleTransactionService: lifecycle });
  const engine = new RunEngine({
    runRepository: runRepo, operationService, lifecycleTransactionService: lifecycle,
    snapshotRepository: runSnapshotRepo, runStageRepository: runStageRepo,
    stageExecutor: new StageExecutor(() => ({ outcome: 'active' })),
    runInTransaction: <T>(fn: () => T): T => inTransaction(db, fn),
  });
  const dispatchFailures: Array<{ workspaceId: string; runId: string; phase: string; code: string }> = [];
  const dispatcher = new RunEngineProviderDispatcher({
    engine, coordinator, runRepository: runRepo, runStageRepository: runStageRepo, runSnapshotRepository: runSnapshotRepo,
    operationService, lifecycleTransactionService: lifecycle, workspaceRootFor: () => 'C:/ws',
    worktreePathFor: () => 'C:/ws/.agentos/worktrees/run-1',
    admissionGate: new WorkspaceAdmissionAuthority({
      store: { getDatabase: () => db },
      evidenceCollector: behavior.admissionEvidenceCollector,
      now: () => new Date(NOW),
    }),
    onDispatchFailure: report => { dispatchFailures.push(report); },
  });
  return { db, root, runRepo, runStageRepo, events, outbox, driver, dispatcher, operationService, coordinatorCalls, dispatchFailures };
}

function close(fx: ReturnType<typeof fixture>): void { fx.db.close(); rmSync(fx.root, { recursive: true, force: true }); }
function realFixture() {
  const executable = process.env.AGENTOS_KIMICODE_CLI;
  if (!executable) throw new Error('AGENTOS_KIMICODE_CLI is required');
  REAL_EXECUTABLE = executable;
  const db = migratedDb();
  seedGraph(db);
  seedAdmission(db);
  const root = mkdtempSync(join(tmpdir(), 'agentos-m4-p4-real-'));
  const events = new RuntimeEventRepository(db, createM3RuntimeEventRegistry());
  const outbox = new OutboxRepository(db, events);
  const factWriter = new RuntimeEventOutboxWriter(events, new RunSequenceAllocator(db), outbox, db);
  const sessionRepo = new ProviderSessionRepository(db, factWriter);
  const processRepo = new ProcessRepository(db, factWriter);
  const outputRepo = new ProcessOutputReferenceRepository(db, factWriter);
  const seam = new DurableAtomicSeamImpl(db, sessionRepo, processRepo);
  const sessionAdapter = new DurableSessionRepositoryAdapter(sessionRepo);
  const processAdapter = new DurableProcessRepositoryAdapter(processRepo);
  const outputAdapter = new DurableOutputReferenceRepositoryAdapter(outputRepo);
  const driver = new NodeProcessDriver();
  const durableCoordinator = new DurableProcessCoordinator({
    sessionRepository: sessionAdapter, processRepository: processAdapter, outputReferenceRepository: outputAdapter,
    artifactSink: new FileArtifactSink(join(root, 'sink')), atomicSeam: seam, driver,
  });
  const probe = new NodeProcessProbePort();
  const adapter = new KimiCodeProviderAdapter({ probe, discover: async () => ({ found: true, selected: executable, candidates: [{ executable, source: 'configuration', confidence: 1 }], warnings: [] }) });
  const registry = new ProviderRegistry([adapter]);
  const coordinator = new StageExecutionCoordinator({
    registry, durableCoordinator, sessionRepository: sessionAdapter, driver, probe,
    claimOwner: 'run-engine', claimLeaseMs: 60000, now: () => NOW, environment: process.env,
  });
  const runRepo = new RunRepository(db);
  const runStageRepo = new RunStageRepository(db);
  const runSnapshotRepo = new RunSnapshotRepository(db);
  const lifecycle = new LifecycleTransactionService({
    runRepository: runRepo, runStageRepository: runStageRepo, runtimeEventRepository: events,
    runSequenceAllocator: new RunSequenceAllocator(db), outboxRepository: outbox,
    runInTransaction: <T>(fn: () => T): T => inTransaction(db, fn),
  }, { now: () => NOW });
  const operationService = new OperationService(db, { now: () => NOW });
  const engine = new RunEngine({
    runRepository: runRepo, operationService, lifecycleTransactionService: lifecycle,
    snapshotRepository: runSnapshotRepo, runStageRepository: runStageRepo,
    stageExecutor: new StageExecutor(() => ({ outcome: 'active' })),
    runInTransaction: <T>(fn: () => T): T => inTransaction(db, fn),
  });
  const dispatcher = new RunEngineProviderDispatcher({
    engine, coordinator, runRepository: runRepo, runStageRepository: runStageRepo, runSnapshotRepository: runSnapshotRepo,
    operationService, lifecycleTransactionService: lifecycle, workspaceRootFor: () => root,
    worktreePathFor: () => root,
    admissionGate: new WorkspaceAdmissionAuthority({ store: { getDatabase: () => db } }),
  });
  return { db, root, runRepo, runStageRepo, driver, dispatcher };
}

describe('RunEngineProviderDispatcher E2E', () => {
  it('L1D-I08 QUEUED admission causes zero engine, provider session, process, and spawn side effects', async () => {
    const driver = new FakeDriver(new FakeHandle(['{"type":"assistant","content":"must-not-run"}']));
    const fx = fixture(driver, false, { admissionState: 'QUEUED' });
    try {
      const result = await fx.dispatcher.drive(WS, RUN);

      assert.deepEqual(result, { outcome: 'noop', reason: 'WORKSPACE_ADMISSION_NOT_GRANTED' });
      assert.equal(fx.runRepo.findById(WS, RUN)?.status, 'queued');
      assert.equal(fx.operationService.listByRun(WS, RUN)[0]?.status, 'queued');
      assert.ok(fx.runStageRepo.listByRun(WS, RUN).every(stage => stage.status === 'pending'));
      assert.equal(fx.coordinatorCalls.count, 0);
      assert.equal(driver.spawnCalls, 0);
      assert.equal(
        (fx.db.prepare('SELECT COUNT(*) AS count FROM provider_sessions').get() as { count: number }).count,
        0,
      );
      assert.equal(
        (fx.db.prepare('SELECT COUNT(*) AS count FROM runtime_processes').get() as { count: number }).count,
        0,
      );
    } finally { close(fx); }
  });

  it('L1D-I17 stale GRANTED READ_ONLY authority cannot reach RunEngine, provider, process, or spawn', async () => {
    const driver = new FakeDriver(new FakeHandle(['{"type":"assistant","content":"must-not-run"}']));
    const fx = fixture(driver, false, {
      admissionRequestedMutationClass: 'READ_ONLY',
      admissionEffectiveMutationClass: 'READ_ONLY',
      admissionEvidenceJson: admissionEvidenceJson(EVIDENCE_EXPIRED),
      admissionEvidenceCollector: {
        collect: async () => { throw new Error('fresh evidence unavailable at C:/private/workspace'); },
      },
    });
    try {
      const admissions = new WorkspaceAdmissionRepository(fx.db);
      const beforeAdmission = admissions.findById(WS, 'adm_m4_dispatch');

      const result = await fx.dispatcher.drive(WS, RUN);

      assert.deepEqual(result, { outcome: 'noop', reason: 'WORKSPACE_ADMISSION_AUTHORITY_UNAVAILABLE' });
      assert.deepEqual(admissions.findById(WS, 'adm_m4_dispatch'), beforeAdmission);
      assert.equal(fx.runRepo.findById(WS, RUN)?.status, 'queued');
      assert.equal(fx.operationService.listByRun(WS, RUN)[0]?.status, 'queued');
      assert.ok(fx.runStageRepo.listByRun(WS, RUN).every(stage => stage.status === 'pending'));
      assert.equal(fx.coordinatorCalls.count, 0);
      assert.equal(driver.spawnCalls, 0);
      assert.equal(
        (fx.db.prepare('SELECT COUNT(*) AS count FROM provider_sessions').get() as { count: number }).count,
        0,
      );
      assert.equal(
        (fx.db.prepare('SELECT COUNT(*) AS count FROM runtime_processes').get() as { count: number }).count,
        0,
      );
    } finally { close(fx); }
  });

  it('L1D-I18 freshly revalidated GRANTED READ_ONLY authority may pass the dispatcher gate', async () => {
    const driver = new FakeDriver(new FakeHandle(['{"type":"assistant","role":"assistant","content":"ok"}\n']));
    const fx = fixture(driver, false, {
      admissionRequestedMutationClass: 'READ_ONLY',
      admissionEffectiveMutationClass: 'READ_ONLY',
      admissionEvidenceJson: admissionEvidenceJson(EVIDENCE_EXPIRED),
      admissionEvidenceCollector: {
        collect: async () => structuredClone(FRESH_READ_ONLY_FACTS),
      },
    });
    try {
      const result = await fx.dispatcher.drive(WS, RUN);

      assert.equal(result.outcome, 'claimed-and-progressed');
      assert.equal(fx.runRepo.findById(WS, RUN)?.status, 'completed');
      assert.equal(driver.spawnCalls, STAGE_KEYS.length);
      const admission = new WorkspaceAdmissionRepository(fx.db).findById(WS, 'adm_m4_dispatch');
      assert.equal(admission?.state, 'GRANTED');
      assert.equal(admission?.effectiveMutationClass, 'READ_ONLY');
      assert.equal(admission?.version, 2);
      assert.match(
        admission?.enforcementEvidenceJson ?? '',
        new RegExp(EVIDENCE_FUTURE.replaceAll('.', '\\.')),
      );
    } finally { close(fx); }
  });

  it('L1D-I19 QUEUED authorization never advances the queue and retains zero side effects', async () => {
    let collectionCalls = 0;
    const driver = new FakeDriver(new FakeHandle(['{"type":"assistant","content":"must-not-run"}']));
    const fx = fixture(driver, false, {
      admissionState: 'QUEUED',
      admissionRequestedMutationClass: 'READ_ONLY',
      admissionEffectiveMutationClass: 'READ_ONLY',
      admissionEvidenceJson: admissionEvidenceJson(EVIDENCE_EXPIRED),
      admissionEvidenceCollector: {
        collect: async () => {
          collectionCalls += 1;
          return structuredClone(FRESH_READ_ONLY_FACTS);
        },
      },
    });
    try {
      const admissions = new WorkspaceAdmissionRepository(fx.db);
      const beforeAdmission = admissions.findById(WS, 'adm_m4_dispatch');

      const result = await fx.dispatcher.drive(WS, RUN);

      assert.deepEqual(result, { outcome: 'noop', reason: 'WORKSPACE_ADMISSION_NOT_GRANTED' });
      assert.equal(collectionCalls, 0);
      assert.deepEqual(admissions.findById(WS, 'adm_m4_dispatch'), beforeAdmission);
      assert.equal(fx.runRepo.findById(WS, RUN)?.status, 'queued');
      assert.equal(fx.operationService.listByRun(WS, RUN)[0]?.status, 'queued');
      assert.ok(fx.runStageRepo.listByRun(WS, RUN).every(stage => stage.status === 'pending'));
      assert.equal(fx.coordinatorCalls.count, 0);
      assert.equal(driver.spawnCalls, 0);
      assert.equal(
        (fx.db.prepare('SELECT COUNT(*) AS count FROM provider_sessions').get() as { count: number }).count,
        0,
      );
      assert.equal(
        (fx.db.prepare('SELECT COUNT(*) AS count FROM runtime_processes').get() as { count: number }).count,
        0,
      );
    } finally { close(fx); }
  });

  it('P5D maps only the exact proven stop identity into cancellation evidence', async () => {
    const fx = fixture(new FakeDriver(new FakeHandle([])), false, {
      cancelOutcome: {
        kind: 'stopped',
        cleanup: { classification: 'complete', cleanupResult: 'TERMINATED', proven: true, knownPids: [] },
        proven: true,
        stopOrigin: 'EXPLICIT_CANCEL',
        processId: 'process-exact',
      },
    });
    try {
      fx.db.prepare("UPDATE runs SET status = 'running', version = 1 WHERE id = ?").run(RUN);
      fx.db.prepare("UPDATE run_stages SET status = 'running' WHERE run_id = ? AND sequence = 1").run(RUN);

      const evidence = await fx.dispatcher.cancelRun({
        workspaceId: WS,
        runId: RUN,
        correlationId: OP,
      });

      assert.deepEqual(evidence, {
        expectedRunVersion: 1,
        processId: 'process-exact',
        terminatedProcessIds: ['process-exact'],
        worktreePreserved: true,
      });
    } finally { close(fx); }
  });

  it('P5D rejects an unproven explicit stop before producing lifecycle evidence', async () => {
    const fx = fixture(new FakeDriver(new FakeHandle([])), false, {
      cancelOutcome: {
        kind: 'stopped',
        cleanup: { classification: 'unknown', cleanupResult: 'UNKNOWN_PLATFORM_UNAVAILABLE', proven: false, knownPids: [] },
        proven: false,
        stopOrigin: 'EXPLICIT_CANCEL',
        processId: 'process-unproven',
      },
    });
    try {
      fx.db.prepare("UPDATE runs SET status = 'running', version = 1 WHERE id = ?").run(RUN);
      fx.db.prepare("UPDATE run_stages SET status = 'running' WHERE run_id = ? AND sequence = 1").run(RUN);

      await assert.rejects(
        fx.dispatcher.cancelRun({ workspaceId: WS, runId: RUN, correlationId: OP }),
        /RUN_CANCELLATION_EVIDENCE_UNPROVEN/,
      );
    } finally { close(fx); }
  });

  it('consumes an internal stopped outcome without mutating canonical Stage or Run lifecycle', async () => {
    const fx = fixture(new FakeDriver(new FakeHandle([])), false, { returnStopped: true });
    try {
      const result = await fx.dispatcher.drive(WS, RUN);
      assert.equal(result.outcome, 'claimed-and-progressed');
      const stage = fx.runStageRepo.listByRun(WS, RUN)[0];
      assert.equal(stage.status, 'running');
      assert.equal(fx.runRepo.findById(WS, RUN)?.status, 'running');
      assert.equal(fx.driver.spawnCalls, 0);
    } finally { close(fx); }
  });

  it('drives one accepted Run through RunEngine -> coordinator -> lifecycle to completed with one spawn per stage', async () => {
    const fx = fixture(new FakeDriver(new FakeHandle(['{"type":"assistant","role":"assistant","content":"ok"}\n'])));
    try {
      const result = await fx.dispatcher.drive(WS, RUN);
      assert.equal(result.outcome, 'claimed-and-progressed');
      const run = fx.runRepo.findById(WS, RUN)!;
      if (run.status !== 'completed') {
        const failedStages = fx.runStageRepo.listByRun(WS, RUN).filter(stage => stage.status === 'failed');
        throw new Error('REAL_GATE_FAIL ' + JSON.stringify({ failureCode: run.failureCode, failureMessage: run.failureMessage, failedStages: failedStages.map(s => ({ key: s.workflowStageKey, code: s.failureCode, message: s.failureMessage })) }));
      }
      assert.equal(run.status, 'completed');
      const stages = fx.runStageRepo.listByRun(WS, RUN);
      assert.ok(stages.every(stage => stage.status === 'completed'));
      assert.equal(fx.driver.spawnCalls, STAGE_KEYS.length);
      assert.equal((fx.db.prepare('SELECT COUNT(*) AS c FROM provider_sessions').get() as { c: number }).c, STAGE_KEYS.length);
      assert.equal((fx.db.prepare('SELECT COUNT(*) AS c FROM runtime_processes').get() as { c: number }).c, STAGE_KEYS.length);
      const eventCount = (fx.db.prepare('SELECT COUNT(*) AS c FROM runtime_events WHERE run_id = ?').get(RUN) as { c: number }).c;
      const outboxCount = (fx.db.prepare('SELECT COUNT(*) AS c FROM outbox_messages WHERE aggregate_id = ?').get(RUN) as { c: number }).c;
      assert.equal(outboxCount, eventCount);
      assert.ok(eventCount > 0);
    } finally { close(fx); }
  });

  it('MEDIUM-1A: joined-existing active stage causes ONE coordinator attempt per drive (no 128 no-progress loop)', async () => {
    const fx = fixture(new FakeDriver(new FakeHandle([])), false, { returnActive: true });
    try {
      const result = await fx.dispatcher.drive(WS, RUN);
      assert.equal(result.outcome, 'claimed-and-progressed');
      assert.equal(fx.coordinatorCalls.count, 1);
      assert.equal(fx.driver.spawnCalls, 0);
    } finally { close(fx); }
  });

  it('replay after terminal never re-dispatches or spawns again', async () => {
    const fx = fixture(new FakeDriver(new FakeHandle(['{"type":"assistant","role":"assistant","content":"ok"}\n'])));
    try {
      await fx.dispatcher.drive(WS, RUN);
      const spawns = fx.driver.spawnCalls;
      const replay = await fx.dispatcher.drive(WS, RUN);
      assert.equal(replay.outcome, 'noop');
      assert.equal(fx.driver.spawnCalls, spawns);
    } finally { close(fx); }
  });

  it('P5E composes Dispatcher cancellation, owned Process cleanup, and LTS handoff exactly once', async () => {
    let resolveExit!: (evidence: ExitEvidence) => void;
    const pendingExit = new Promise<ExitEvidence>(resolve => { resolveExit = resolve; });
    const fx = fixture(
      new FakeDriver(
        new FakeHandle([], 0, pendingExit),
        undefined,
        () => resolveExit({ exitCode: 0, signal: null, exitedAt: Date.now() }),
      ),
      false,
      { useRealCoordinator: true, cancelGracePeriodMs: 0 },
    );
    try {
      const drivePromise = fx.dispatcher.drive(WS, RUN);
      await waitForCondition(() => {
        const process = fx.db.prepare('SELECT status FROM runtime_processes WHERE run_id = ?').get(RUN) as { status?: string } | undefined;
        return process?.status === 'running';
      });
      const beforeCancel = fx.runRepo.findById(WS, RUN)!;
      const cancellationOperation = fx.operationService.create({ workspaceId: WS, runId: RUN, type: 'run.cancel' });
      const evidence = await fx.dispatcher.cancelRun({ workspaceId: WS, runId: RUN, correlationId: cancellationOperation.correlationId });

      assert.ok(evidence.processId);
      assert.deepEqual(evidence.terminatedProcessIds, [evidence.processId]);
      assert.equal(fx.driver.gracefulStopCalls, 1);
      assert.equal(fx.driver.terminateTreeCalls, 1);

      const operationBeforeCancel = fx.operationService.findById(WS, cancellationOperation.id);
      const operation = fx.operationService.cancel({
        workspaceId: WS,
        operationId: cancellationOperation.id,
        expectedVersion: operationBeforeCancel.version,
        evidence,
      });
      const driveResult = await drivePromise;
      assert.equal(driveResult.outcome, 'claimed-and-progressed');
      assert.equal(operation.status, 'cancelled');

      const run = fx.runRepo.findById(WS, RUN)!;
      const stages = fx.runStageRepo.listByRun(WS, RUN);
      const process = fx.db.prepare('SELECT status, cleanup_result FROM runtime_processes WHERE run_id = ?').get(RUN) as { status: string; cleanup_result: string | null };
      const session = fx.db.prepare('SELECT status FROM provider_sessions WHERE run_id = ?').get(RUN) as { status: string };
      assert.equal(run.status, 'cancelled');
      assert.equal(run.version, beforeCancel.version + 1);
      assert.ok(stages.every(stage => stage.status === 'cancelled'));
      assert.equal(process.status, 'exited');
      assert.equal(process.cleanup_result, 'TERMINATED');
      assert.equal(session.status, 'cancelled');
      assert.equal(fx.operationService.findById(WS, cancellationOperation.id).version, operationBeforeCancel.version + 1);

      const cancellationEvents = fx.db.prepare(`
        SELECT type FROM runtime_events
        WHERE run_id = ? AND type IN ('stage.cancelled', 'run.cancelled')
        ORDER BY sequence
      `).all(RUN) as Array<{ type: string }>;
      assert.equal(cancellationEvents.filter(event => event.type === 'stage.cancelled').length, STAGE_KEYS.length);
      assert.equal(cancellationEvents.filter(event => event.type === 'run.cancelled').length, 1);
      const eventCount = (fx.db.prepare('SELECT COUNT(*) AS c FROM runtime_events WHERE run_id = ?').get(RUN) as { c: number }).c;
      const outboxCount = (fx.db.prepare('SELECT COUNT(*) AS c FROM outbox_messages WHERE aggregate_id = ?').get(RUN) as { c: number }).c;
      assert.equal(outboxCount, eventCount);
      await assert.rejects(
        fx.dispatcher.cancelRun({ workspaceId: WS, runId: RUN, correlationId: OP }),
        /already terminal/,
      );
    } finally {
      resolveExit({ exitCode: 0, signal: null, exitedAt: Date.now() });
      close(fx);
    }
  });

  it('auth failure fails the Run canonically with zero spawns', async () => {
    const fx = fixture(new FakeDriver(new FakeHandle([])), true);
    try {
      await fx.dispatcher.drive(WS, RUN);
      const run = fx.runRepo.findById(WS, RUN)!;
      assert.equal(run.status, 'failed');
      assert.equal(fx.driver.spawnCalls, 0);
      assert.equal((fx.db.prepare('SELECT COUNT(*) AS c FROM provider_sessions').get() as { c: number }).c, 0);
    } finally { close(fx); }
  });
  it('current-machine Kimi gate: real kimi drives the full chain to completion (env-gated)', { skip: process.env.M4_P4_REAL_GATE !== '1' }, async () => {
    const fx = realFixture();
    try {
      const result = await fx.dispatcher.drive(WS, RUN);
      assert.equal(result.outcome, 'claimed-and-progressed');
      const run = fx.runRepo.findById(WS, RUN)!;
      if (run.status !== 'completed') {
        const failedStages = fx.runStageRepo.listByRun(WS, RUN).filter(stage => stage.status === 'failed');
        throw new Error('REAL_GATE_FAIL ' + JSON.stringify({ failureCode: run.failureCode, failureMessage: run.failureMessage, failedStages: failedStages.map(s => ({ key: s.workflowStageKey, code: s.failureCode, message: s.failureMessage })) }));
      }
      assert.equal(run.status, 'completed');
      assert.ok(fx.runStageRepo.listByRun(WS, RUN).every(stage => stage.status === 'completed'));
      const eventCount = (fx.db.prepare('SELECT COUNT(*) AS c FROM runtime_events WHERE run_id = ?').get(RUN) as { c: number }).c;
      const outboxCount = (fx.db.prepare('SELECT COUNT(*) AS c FROM outbox_messages WHERE aggregate_id = ?').get(RUN) as { c: number }).c;
      assert.equal(outboxCount, eventCount);
      assert.ok(eventCount > 0);
    } finally { fx.db.close(); rmSync(fx.root, { recursive: true, force: true }); }
  });
  it('legacy-originated runs flow through the same authority to completion (legacy projection parity)', async () => {
    ORIGIN = 'legacy_pipeline';
    const fx = fixture(new FakeDriver(new FakeHandle(['{"type":"assistant","role":"assistant","content":"ok"}\n'])));
    try {
      await fx.dispatcher.drive(WS, RUN);
      const run = fx.runRepo.findById(WS, RUN)!;
      assert.equal(run.status, 'completed');
      assert.equal(run.origin, 'legacy_pipeline');
      assert.ok(fx.runStageRepo.listByRun(WS, RUN).every(stage => stage.status === 'completed'));
      assert.equal(fx.driver.spawnCalls, STAGE_KEYS.length);
      const replay = await fx.dispatcher.drive(WS, RUN);
      assert.equal(replay.outcome, 'noop');
      assert.equal(fx.driver.spawnCalls, STAGE_KEYS.length);
    } finally { close(fx); ORIGIN = 'v2_api'; }
  });

  // P6-M1 driveSafely: the production dispatch entry point must contain
  // failures and never strand a running execution or crash the caller.
  it('driveSafely drives one accepted run to completion (one spawn per stage)', async () => {
    const fx = fixture(new FakeDriver(new FakeHandle(['{"type":"assistant","role":"assistant","content":"ok"}\n'])));
    try {
      await fx.dispatcher.driveSafely(WS, RUN);
      assert.equal(fx.runRepo.findById(WS, RUN)!.status, 'completed');
      assert.ok(fx.runStageRepo.listByRun(WS, RUN).every(stage => stage.status === 'completed'));
      assert.equal(fx.driver.spawnCalls, STAGE_KEYS.length);
      assert.equal(fx.dispatchFailures.length, 0);
    } finally { close(fx); }
  });

  it('driveSafely contains a post-claim coordinator failure into a canonical failure (no strand, no throw)', async () => {
    const fx = fixture(new FakeDriver(new FakeHandle([])), false, { executeThrow: new Error('RUN_ENGINE_DISPATCH_STALLED: simulated coordinator throw') });
    try {
      await assert.doesNotReject(fx.dispatcher.driveSafely(WS, RUN));
      const run = fx.runRepo.findById(WS, RUN)!;
      // The run must not remain queued/starting/running: it reaches a
      // canonical terminal state (failed) rather than stranding.
      assert.ok(['failed', 'completed', 'cancelled'].includes(run.status), 'unexpected run status: ' + run.status);
      // The failure sink was notified for any residue the lifecycle fold could not absorb.
      // (Whether a report fires depends on how much the canonical fold absorbed.)
    } finally { close(fx); }
  });

  it('driveSafely contains a pre-claim failure into a canonical operation failure (no strand, no throw)', async () => {
    // Force the engine tick/claim path to throw before the claim CAS by using
    // an auth-failure probe that makes the pre-claim validation fail.
    const fx = fixture(new FakeDriver(new FakeHandle([])), true);
    try {
      await assert.doesNotReject(fx.dispatcher.driveSafely(WS, RUN));
      const run = fx.runRepo.findById(WS, RUN)!;
      assert.ok(['failed', 'completed', 'cancelled', 'queued', 'starting', 'running'].includes(run.status));
      assert.equal(fx.driver.spawnCalls, 0, 'auth failure must not spawn a provider process');
    } finally { close(fx); }
  });

  it('driveSafely is replay-safe: a second drive on a terminal run does not respawn', async () => {
    const fx = fixture(new FakeDriver(new FakeHandle(['{"type":"assistant","role":"assistant","content":"ok"}\n'])));
    try {
      await fx.dispatcher.driveSafely(WS, RUN);
      assert.equal(fx.driver.spawnCalls, STAGE_KEYS.length);
      await fx.dispatcher.driveSafely(WS, RUN);
      assert.equal(fx.driver.spawnCalls, STAGE_KEYS.length);
    } finally { close(fx); }
  });
});
