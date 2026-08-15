import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createM3RuntimeEventRegistry, type AgentSnapshotV1, type ProviderConfigurationSnapshotV1, type RunSnapshotPayloadV2 } from '@agentos/shared';
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
import { OutboxRepository } from '../../store/OutboxRepository.js';
import { RuntimeEventOutboxWriter, RuntimeEventRepository } from '../../store/RuntimeEventRepository.js';
import { RunSequenceAllocator } from '../../store/RunSequenceAllocator.js';
import { DurableAtomicSeamImpl } from '../../store/DurableAtomicSeam.js';
import { DurableOutputReferenceRepositoryAdapter, DurableProcessRepositoryAdapter, DurableSessionRepositoryAdapter } from '../../store/process-runtime-adapters.js';
import { inTransaction } from '../../store/Transaction.js';
import { LifecycleTransactionService } from '../LifecycleTransactionService.js';
import { OperationService } from '../OperationService.js';
import { RunEngine } from './RunEngine.js';
import { StageExecutor } from './StageExecutor.js';
import { StageExecutionCoordinator } from './StageExecutionCoordinator.js';
import { RunEngineProviderDispatcher } from './RunEngineProviderDispatcher.js';
import { NodeProcessDriver, NodeProcessProbePort } from '@agentos/process-runtime';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => { exec(sql: string): void; prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown; run(...params: unknown[]): unknown; }; close(): void; } };
type Db = InstanceType<typeof DatabaseSync>;

const NOW = '2026-08-15T00:00:00.000Z';
const WS = 'ws_m4';
const TASK = 'task_m4';
const RUN = 'run_m4';
const OP = 'op_' + 'A'.repeat(26);
const KIMI_EXE = 'C:/kimi.exe';
let REAL_EXECUTABLE = KIMI_EXE;
let ORIGIN: 'v2_api' | 'legacy_pipeline' = 'v2_api';
const STAGE_KEYS = ['codex_manager', 'kimi_worker', 'opencode_reviewer', 'codex_final_review'] as const;

function migratedDb(): Db {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner(db, new MigrationRegistry([...DEFAULT_REGISTRY_MIGRATIONS])).run();
  seed(db);
  return db;
}

function providerSnapshot(): ProviderConfigurationSnapshotV1 {
  return {
    providerConfigId: 'pcfg_m4', name: 'Kimi Gate', providerType: 'kimicode', adapterId: 'builtin.kimicode',
    runtimeMode: 'cli', executable: REAL_EXECUTABLE, argsTemplate: [], model: null, environmentProfileId: null, secretProfileId: null,
    workingDirectoryMode: 'workspace', workspaceRelativeWorkingDirectory: null,
    capabilities: { sessionResume:false, structuredEvents:true, nativeApprovals:false, subagents:false, toolEvents:true, fileEvents:false, usageEvents:true, reasoningStream:false, interactiveInput:false, pause:false, cancellation:true, modelSelection:true, workspaceAwareness:true, nativeSandbox:false, outputContracts:false },
    timeoutPolicy: { discoveryTimeoutMs:10000, validationTimeoutMs:30000, startupTimeoutMs:60000, idleTimeoutMs:null, totalTimeoutMs:null, cancelGracePeriodMs:5000, approvalTimeoutMs:null },
    approvalMode: 'disabled', outputMode: 'structured', enabled: true, version: 1,
  };
}

function agentSnapshot(): AgentSnapshotV1 {
  return { agentId: 'agent_m4', name: 'Agent', role: 'codex', roleTitle: 'Executor', systemPrompt: 'Execute the requested task.', permissions: ['read','write'], providerConfigId: 'pcfg_m4', enabled: true, version: 1 };
}

function snapshotPayload(): RunSnapshotPayloadV2 {
  const stages = STAGE_KEYS.map((key, index) => ({
    workflowStageKey: key, name: key, sequence: index + 1,
    agent: agentSnapshot(), provider: providerSnapshot(),
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

function seedGraph(db: Db): void {
  const payload = snapshotPayload();
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

class FakeHandle implements NativeProcessHandle {
  readonly pid = 4242;
  readonly identity: NativeIdentity = { pid: 4242, startedAtMs: Date.parse(NOW), executablePath: KIMI_EXE };
  readonly streams: NativeProcessStreams;
  private readonly exit: Promise<ExitEvidence>;
  constructor(stdoutLines: string[], exitCode = 0) {
    this.streams = { stdout: asyncIterable(stdoutLines), stderr: asyncIterable([]) };
    this.exit = Promise.resolve({ exitCode, signal: null, exitedAt: Date.now() });
  }
  waitExit(): Promise<ExitEvidence> { return this.exit; }
}

function asyncIterable(lines: string[]): AsyncIterable<Uint8Array> {
  return { async *[Symbol.asyncIterator]() { for (const line of lines) yield new TextEncoder().encode(line); } };
}

class FakeDriver implements PlatformProcessDriver {
  spawnCalls = 0;
  constructor(private readonly handle: FakeHandle | null, private readonly spawnError?: Error) {}
  async spawn() { this.spawnCalls += 1; if (this.spawnError !== undefined) throw this.spawnError; return this.handle!; }
  gracefulStop = async () => ({ delivered: true, detail: 'ok' });
  terminateTree = async (): Promise<TreeTerminationResult> => ({ classification: 'complete', attemptedMembers: [], errors: [] });
  verifySurvivors = async (): Promise<SurvivorVerification> => ({ classification: 'complete', knownPids: [] });
  inspectIdentity = async (identity: NativeIdentity) => ({ kind: 'match' as const, identity });
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

function fixture(driver: FakeDriver, authFailure = false) {
  const db = migratedDb();
  seedGraph(db);
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
  const coordinator = new StageExecutionCoordinator({
    registry, durableCoordinator, sessionRepository: sessionAdapter, driver, probe: probeFor(authFailure),
    claimOwner: 'run-engine', claimLeaseMs: 60000, now: () => NOW,
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
    operationService, lifecycleTransactionService: lifecycle, workspaceRootFor: () => 'C:/ws',
    worktreePathFor: () => 'C:/ws/.agentos/worktrees/run-1',
  });
  return { db, root, runRepo, runStageRepo, events, outbox, driver, dispatcher };
}

function close(fx: ReturnType<typeof fixture>): void { fx.db.close(); rmSync(fx.root, { recursive: true, force: true }); }
function realFixture() {
  const executable = process.env.AGENTOS_KIMICODE_CLI;
  if (!executable) throw new Error('AGENTOS_KIMICODE_CLI is required');
  REAL_EXECUTABLE = executable;
  const db = migratedDb();
  seedGraph(db);
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
  });
  return { db, root, runRepo, runStageRepo, driver, dispatcher };
}

describe('RunEngineProviderDispatcher E2E', () => {
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
});