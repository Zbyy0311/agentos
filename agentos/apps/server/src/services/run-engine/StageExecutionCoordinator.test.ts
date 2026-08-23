import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createM3RuntimeEventRegistry,
  type AgentSnapshotV1,
  type ProviderConfigurationSnapshotV1,
  type RuntimeEventRecord,
} from '@agentos/shared';
import {
  DurableProcessCoordinator,
  FileArtifactSink,
  MockNativeProcessHandle,
  NodeProcessDriver,
  type ExitEvidence,
  type NativeIdentity,
  type NativeProcessHandle,
  type NativeProcessStreams,
  type PlatformProcessDriver,
  type ProcessStopResult,
  type SurvivorVerification,
  type TreeTerminationResult,
} from '@agentos/process-runtime';
import { FakeClock } from '@agentos/process-runtime';
import { KimiCodeProviderAdapter, ProviderRegistry } from '@agentos/agent-core/providers';
import type { ProcessProbePort } from '@agentos/process-runtime';
import { MigrationRegistry } from '../../migrations/registry.js';
import { MigrationRunner } from '../../migrations/MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../../migrations/default-registry.js';
import { ProviderSessionRepository } from '../../store/ProviderSessionRepository.js';
import { ProcessRepository } from '../../store/ProcessRepository.js';
import { ProcessOutputReferenceRepository } from '../../store/ProcessOutputReferenceRepository.js';
import { OutboxRepository } from '../../store/OutboxRepository.js';
import { RuntimeEventOutboxWriter, RuntimeEventRepository } from '../../store/RuntimeEventRepository.js';
import { RunSequenceAllocator } from '../../store/RunSequenceAllocator.js';
import { DurableAtomicSeamImpl } from '../../store/DurableAtomicSeam.js';
import {
  DurableOutputReferenceRepositoryAdapter,
  DurableProcessRepositoryAdapter,
  DurableSessionRepositoryAdapter,
} from '../../store/process-runtime-adapters.js';
import { StageExecutionCoordinator, type StageExecutionInput, StageExecutionOutcome } from './StageExecutionCoordinator.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): {
      all(...params: unknown[]): unknown[];
      get(...params: unknown[]): unknown;
      run(...params: unknown[]): unknown;
    };
    close(): void;
  };
};
type Db = InstanceType<typeof DatabaseSync>;

const NOW = '2026-08-15T00:00:00.000Z';
const WS = 'ws_m4';
const TASK = 'task_m4';
const RUN = 'run_m4';
const SNAPSHOT = 'snapshot_m4';
const STAGE = 'stage_m4';
const PCFG = 'pcfg_m4';
const AGENT = 'agent_m4';
const OP = 'op_m4';
const KIMI_EXE = 'C:/kimi.exe';

function migratedDb(): Db {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner(db, new MigrationRegistry([...DEFAULT_REGISTRY_MIGRATIONS])).run();
  seedParents(db);
  return db;
}

function seedParents(db: Db): void {
  db.prepare(`
    INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at)
    VALUES (?, ?, '/tmp/m4', '/tmp/m4', ?, ?, ?)
  `).run(WS, 'M4', NOW, NOW, NOW);
  db.prepare(`
    INSERT INTO tasks (id, workspace_id, title, status, priority, created_by, created_at, updated_at)
    VALUES (?, ?, 'M4 task', 'open', 'normal', 'test', ?, ?)
  `).run(TASK, WS, NOW, NOW);
  db.prepare(`
    INSERT INTO runs (id, workspace_id, task_id, root_run_id, status, reason, origin, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'running', 'initial', 'v2_api', 'test', ?, ?)
  `).run(RUN, WS, TASK, RUN, NOW, NOW);
  db.prepare(`
    INSERT INTO run_snapshots (id, workspace_id, run_id, workflow_definition_id, snapshot_schema_version, snapshot_json, content_hash, captured_at)
    VALUES (?, ?, ?, 'workflow_00000000000000000000000002', 1, '{}', ?, ?)
  `).run(SNAPSHOT, WS, RUN, 'a'.repeat(64), NOW);
  db.prepare(`
    INSERT INTO run_stages (id, workspace_id, run_id, run_snapshot_id, workflow_stage_key, name, sequence, attempt, status, created_at, updated_at, version)
    VALUES (?, ?, ?, ?, 'plan', 'Plan', 1, 1, 'running', ?, ?, 1)
  `).run(STAGE, WS, RUN, SNAPSHOT, NOW, NOW);
  db.prepare(`
    INSERT INTO provider_configurations (id, workspace_id, name, provider_type, adapter_id, runtime_mode, capabilities_json, timeout_policy_json, created_at, updated_at)
    VALUES (?, ?, 'M4 provider', 'kimicode', 'builtin.kimicode', 'cli', '{}', '{}', ?, ?)
  `).run(PCFG, WS, NOW, NOW);
  db.prepare(`
    INSERT INTO agent_profiles (workspace_id, id, name, agent_role, role_title, system_prompt, permissions_json, enabled, cli_command, cli_args_json, created_at, updated_at)
    VALUES (?, ?, 'Agent', 'worker', 'Worker', '', '[]', 1, 'agent', '[]', ?, ?)
  `).run(WS, AGENT, NOW, NOW);
}

function providerSnapshot(): ProviderConfigurationSnapshotV1 {
  return {
    providerConfigId: PCFG,
    name: 'Kimi Gate',
    providerType: 'kimicode',
    adapterId: 'builtin.kimicode',
    runtimeMode: 'cli',
    executable: KIMI_EXE,
    argsTemplate: [],
    model: null,
    environmentProfileId: null,
    secretProfileId: null,
    workingDirectoryMode: 'workspace',
    workspaceRelativeWorkingDirectory: null,
    capabilities: {
      sessionResume: false, structuredEvents: true, nativeApprovals: false, subagents: false,
      toolEvents: true, fileEvents: false, usageEvents: true, reasoningStream: false,
      interactiveInput: false, pause: false, cancellation: true, modelSelection: true,
      workspaceAwareness: true, nativeSandbox: false, outputContracts: false,
    },
    timeoutPolicy: {
      discoveryTimeoutMs: 10000, validationTimeoutMs: 30000, startupTimeoutMs: 60000,
      idleTimeoutMs: null, totalTimeoutMs: null, cancelGracePeriodMs: 5000, approvalTimeoutMs: null,
    },
    approvalMode: 'disabled',
    outputMode: 'structured',
    enabled: true,
    version: 1,
  };
}

function agentSnapshot(): AgentSnapshotV1 {
  return {
    agentId: AGENT,
    name: 'Agent',
    role: 'codex',
    roleTitle: 'Executor',
    systemPrompt: 'Execute the task.',
    permissions: ['read', 'write'],
    providerConfigId: PCFG,
    enabled: true,
    version: 1,
  };
}

function stageInput(overrides: Partial<StageExecutionInput> = {}): StageExecutionInput {
  return {
    workspaceId: WS, taskId: TASK, runId: RUN, stageId: STAGE, stageAttempt: 1,
    workflowStageKey: 'plan', agentSnapshot: agentSnapshot(), providerSnapshot: providerSnapshot(),
    workspaceRoot: 'C:/ws', worktreePath: 'C:/ws/.agentos/worktrees/run-1',
    prompt: 'implement', operationId: OP,
    ...overrides,
  };
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

class FakeHandle implements NativeProcessHandle {
  readonly pid = 4242;
  readonly identity = { pid: 4242, startedAtMs: Date.parse(NOW), executablePath: KIMI_EXE };
  readonly streams: NativeProcessStreams;
  private readonly exit: Promise<ExitEvidence>;
  constructor(stdoutLines: string[], exitCode = 0, signal: string | null = null) {
    this.streams = { stdout: asyncIterable(stdoutLines), stderr: asyncIterable([]) };
    this.exit = Promise.resolve({ exitCode, signal, exitedAt: Date.now() });
  }
  waitExit(): Promise<ExitEvidence> { return this.exit; }
}

function asyncIterable(lines: string[]): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const line of lines) yield new TextEncoder().encode(line);
    },
  };
}

interface FakeObservationInput {
  readonly workspaceId: string;
  readonly runId: string;
  readonly afterSequence: number;
  readonly onEvent: (event: RuntimeEventRecord) => void;
  readonly onFailure: (reason: string, lastSafeSequence: number) => void;
}

class FakeObservationPort {
  input?: FakeObservationInput;
  afterSequence?: number;
  unsubscribeCalls = 0;

  subscribe(input: FakeObservationInput): () => void {
    this.input = input;
    this.afterSequence = input.afterSequence;
    return () => {
      this.unsubscribeCalls += 1;
      this.input = undefined;
    };
  }

  emit(event: RuntimeEventRecord): void {
    this.input?.onEvent(event);
  }

  fail(reason = 'observation-error'): void {
    this.input?.onFailure(reason, this.afterSequence ?? 0);
  }
}

function runtimeEvent(
  type: string,
  sequence: number,
  overrides: Partial<Record<string, unknown>> = {},
): RuntimeEventRecord {
  return {
    id: `evt_${String(sequence).padStart(26, '0')}`,
    schemaVersion: 1,
    type,
    workspaceId: WS,
    taskId: TASK,
    runId: RUN,
    stageId: STAGE,
    sequence,
    timestamp: NOW,
    source: type.startsWith('approval.') ? 'approval-service' : 'stage-executor',
    correlationId: OP,
    severity: 'info',
    visibility: 'public',
    durability: 'durable',
    payload: { attempt: 1 },
    ...overrides,
  } as RuntimeEventRecord;
}

async function flushObservationChain(): Promise<void> {
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
}

function testDeferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

class ControlledExitHandle implements NativeProcessHandle {
  readonly pid = 7373;
  readonly identity: NativeIdentity = { pid: this.pid, startedAtMs: Date.parse(NOW), executablePath: KIMI_EXE };
  readonly streams: NativeProcessStreams;
  readonly waitExitEntered = testDeferred<void>();
  private readonly exit = testDeferred<ExitEvidence>();

  constructor(stdout = '{"role":"assistant","content":"natural"}') {
    this.streams = { stdout: asyncIterable([stdout]), stderr: asyncIterable([]) };
  }

  waitExit(): Promise<ExitEvidence> {
    this.waitExitEntered.resolve(undefined);
    return this.exit.promise;
  }

  releaseExit(exit: ExitEvidence = { exitCode: 0, signal: null, exitedAt: Date.now() }): void {
    this.exit.resolve(exit);
  }
}

class ControlledExitDriver implements PlatformProcessDriver {
  readonly handle: ControlledExitHandle;
  spawnCalls = 0;
  gracefulStopCalls = 0;
  terminateTreeCalls = 0;
  verifySurvivorsCalls = 0;

  constructor(stdout?: string) {
    this.handle = new ControlledExitHandle(stdout);
  }

  async spawn(): Promise<NativeProcessHandle> {
    this.spawnCalls += 1;
    return this.handle;
  }

  async gracefulStop(): Promise<{ readonly delivered: boolean; readonly detail: string }> {
    this.gracefulStopCalls += 1;
    return { delivered: true, detail: 'controlled graceful stop' };
  }

  async terminateTree(): Promise<TreeTerminationResult> {
    this.terminateTreeCalls += 1;
    return { classification: 'complete', attemptedMembers: [this.handle.pid], errors: [] };
  }

  async verifySurvivors(): Promise<SurvivorVerification> {
    this.verifySurvivorsCalls += 1;
    return { classification: 'complete', knownPids: [this.handle.pid], proof: { kind: 'owned-tree-enumeration' } };
  }

  async inspectIdentity(identity: NativeIdentity): Promise<{ readonly kind: 'match'; readonly identity: NativeIdentity }> {
    return { kind: 'match', identity };
  }
}

class SpawnGateDriver extends ControlledExitDriver {
  readonly spawnEntered = testDeferred<void>();
  readonly releaseSpawn = testDeferred<void>();

  override async spawn(): Promise<NativeProcessHandle> {
    this.spawnCalls += 1;
    this.spawnEntered.resolve(undefined);
    await this.releaseSpawn.promise;
    return this.handle;
  }
}

class StaleCreatedProcessAdapter extends DurableProcessRepositoryAdapter {
  staleNextStartingRoot = true;
  blockStaleProcessRead = true;
  blockNextProcessRead = false;
  readonly processReadEntered = testDeferred<void>();
  readonly releaseProcessRead = testDeferred<void>();

  override async getRootProcessByClaim(workspaceId: string, runId: string, stageId: string, stageAttempt: number, authorityRole: string) {
    const process = await super.getRootProcessByClaim(workspaceId, runId, stageId, stageAttempt, authorityRole);
    if (process !== null && this.staleNextStartingRoot && (process.status === 'starting' || process.status === 'running' || process.status === 'exited')) {
      this.staleNextStartingRoot = false;
      this.blockNextProcessRead = this.blockStaleProcessRead;
      return {
        ...process,
        status: 'created' as const,
        nativePid: null,
        nativeStartedAt: null,
        processGroupId: null,
        platformHandleId: null,
        startedAt: null,
        readyAt: null,
        stoppingAt: null,
      };
    }
    return process;
  }

  override async getProcess(workspaceId: string, processId: string) {
    if (this.blockNextProcessRead) {
      this.blockNextProcessRead = false;
      this.processReadEntered.resolve(undefined);
      await this.releaseProcessRead.promise;
    }
    return super.getProcess(workspaceId, processId);
  }
}

class SpawnRightGateProcessAdapter extends DurableProcessRepositoryAdapter {
  readonly spawnRightEntered = testDeferred<void>();
  readonly releaseSpawnRight = testDeferred<void>();

  override async casConsumeSpawnRight(input: Parameters<DurableProcessRepositoryAdapter['casConsumeSpawnRight']>[0]) {
    this.spawnRightEntered.resolve(undefined);
    await this.releaseSpawnRight.promise;
    return super.casConsumeSpawnRight(input);
  }
}

class BlockingStoppingProcessAdapter extends DurableProcessRepositoryAdapter {
  readonly stoppingEntered = testDeferred<void>();
  readonly naturalExitCommitted = testDeferred<void>();
  naturalCasCalls = 0;
  private readonly release = testDeferred<void>();

  releaseStopping(): void {
    this.release.resolve(undefined);
  }

  override async casProcessTransition(input: Parameters<DurableProcessRepositoryAdapter['casProcessTransition']>[0]) {
    if (input.to === 'stopping') {
      this.stoppingEntered.resolve(undefined);
      await this.release.promise;
    }
    const outcome = await super.casProcessTransition(input);
    if (input.to === 'exited') {
      this.naturalCasCalls += 1;
      if (outcome.kind === 'applied') this.naturalExitCommitted.resolve(undefined);
    }
    return outcome;
  }
}

class GatedOutputHandle implements NativeProcessHandle {
  readonly pid = 8383;
  readonly identity: NativeIdentity = { pid: this.pid, startedAtMs: Date.parse(NOW), executablePath: KIMI_EXE };
  readonly stdoutReady = testDeferred<void>();
  readonly stderrReady = testDeferred<void>();
  readonly streams: NativeProcessStreams;
  private readonly releaseChunks = testDeferred<void>();
  private readonly exit = testDeferred<ExitEvidence>();

  constructor(stdout: string, stderr: string) {
    this.streams = {
      stdout: this.gatedStream(stdout, this.stdoutReady),
      stderr: this.gatedStream(stderr, this.stderrReady),
    };
  }

  waitExit(): Promise<ExitEvidence> { return this.exit.promise; }

  releaseOutput(): void { this.releaseChunks.resolve(undefined); }

  releaseExit(): void { this.exit.resolve({ exitCode: 0, signal: null, exitedAt: Date.now() }); }

  private gatedStream(chunk: string, ready: { resolve(value: void): void }): AsyncIterable<Uint8Array> {
    const release = this.releaseChunks.promise;
    return {
      async *[Symbol.asyncIterator]() {
        ready.resolve(undefined);
        await release;
        if (chunk.length > 0) yield new TextEncoder().encode(chunk);
      },
    };
  }
}

class FakeDriver implements PlatformProcessDriver {
  spawnCalls = 0;
  constructor(private readonly handle: NativeProcessHandle | null, private readonly spawnError?: Error) {}
  async spawn() { this.spawnCalls += 1; if (this.spawnError !== undefined) throw this.spawnError; return this.handle!; }
  gracefulStop = async () => ({ delivered: true, detail: 'ok' });
  terminateTree = async (): Promise<TreeTerminationResult> => ({ classification: 'complete', attemptedMembers: [], errors: [] });
  verifySurvivors = async (): Promise<SurvivorVerification> => ({ classification: 'complete', knownPids: [], proof: { kind: 'owned-tree-enumeration' } });
  inspectIdentity = async (identity: NativeIdentity): Promise<{ kind: 'match'; identity: NativeIdentity }> => ({ kind: 'match', identity });
}

class BlockingCancelDriver implements PlatformProcessDriver {
  readonly handle = new MockNativeProcessHandle(5252, KIMI_EXE);
  readonly spawnEntered: Promise<void>;
  spawnCalls = 0;
  gracefulStopCalls = 0;
  terminateTreeCalls = 0;
  verifySurvivorsCalls = 0;

  constructor(private readonly validProof = true) {
    this.spawnEntered = new Promise(resolve => { this.resolveSpawnEntered = resolve; });
  }

  private resolveSpawnEntered: () => void = () => undefined;

  async spawn() {
    this.spawnCalls += 1;
    this.resolveSpawnEntered();
    return this.handle;
  }

  async gracefulStop() {
    this.gracefulStopCalls += 1;
    return { delivered: true, detail: 'blocking mock graceful stop' };
  }

  async terminateTree() {
    this.terminateTreeCalls += 1;
    return { classification: 'complete' as const, attemptedMembers: [this.handle.pid], errors: [] };
  }

  async verifySurvivors() {
    this.verifySurvivorsCalls += 1;
    return {
      classification: 'complete' as const,
      knownPids: [this.handle.pid],
      ...(this.validProof ? { proof: { kind: 'owned-tree-enumeration' as const } } : {}),
    };
  }

  async inspectIdentity(identity: NativeIdentity) {
    return { kind: 'match' as const, identity };
  }
}

class TailCancelHandle implements NativeProcessHandle {
  readonly pid = 6262;
  readonly identity: NativeIdentity = { pid: this.pid, startedAtMs: Date.parse(NOW), executablePath: KIMI_EXE };
  readonly stdoutStarted: Promise<void>;
  readonly streams: NativeProcessStreams;
  private resolveStdoutStarted: () => void = () => undefined;
  private readonly releaseChunkPromise: Promise<void>;
  private releaseChunk: () => void = () => undefined;
  private sent = false;

  constructor(private readonly chunk: string) {
    this.stdoutStarted = new Promise(resolve => { this.resolveStdoutStarted = resolve; });
    this.releaseChunkPromise = new Promise(resolve => { this.releaseChunk = resolve; });
    this.streams = {
      stdout: {
        [Symbol.asyncIterator]: () => ({
          next: async (): Promise<IteratorResult<Uint8Array>> => {
            if (!this.sent) {
              this.resolveStdoutStarted();
              await this.releaseChunkPromise;
              this.sent = true;
              return { done: false, value: new TextEncoder().encode(this.chunk) };
            }
            return new Promise<IteratorResult<Uint8Array>>(() => undefined);
          },
          return: async (): Promise<IteratorResult<Uint8Array>> => ({ done: true, value: undefined }),
        }),
      },
      stderr: {
        [Symbol.asyncIterator]: () => ({
          next: (): Promise<IteratorResult<Uint8Array>> => new Promise(() => undefined),
          return: async (): Promise<IteratorResult<Uint8Array>> => ({ done: true, value: undefined }),
        }),
      },
    };
  }

  waitExit(): Promise<ExitEvidence> {
    return new Promise(() => undefined);
  }

  release(): void {
    this.releaseChunk();
  }
}

class TailCancelDriver implements PlatformProcessDriver {
  readonly handle = new TailCancelHandle('{"role":"assistant","content":"buffered"}');
  spawnCalls = 0;
  gracefulStopCalls = 0;
  terminateTreeCalls = 0;
  verifySurvivorsCalls = 0;

  async spawn(): Promise<NativeProcessHandle> {
    this.spawnCalls += 1;
    return this.handle;
  }

  async gracefulStop(): Promise<{ readonly delivered: boolean; readonly detail: string }> {
    this.gracefulStopCalls += 1;
    return { delivered: true, detail: 'tail test graceful stop' };
  }

  async terminateTree(): Promise<TreeTerminationResult> {
    this.terminateTreeCalls += 1;
    return { classification: 'complete', attemptedMembers: [this.handle.pid], errors: [] };
  }

  async verifySurvivors(): Promise<SurvivorVerification> {
    this.verifySurvivorsCalls += 1;
    return { classification: 'complete', knownPids: [this.handle.pid], proof: { kind: 'owned-tree-enumeration' } };
  }

  async inspectIdentity(identity: NativeIdentity): Promise<{ readonly kind: 'match'; readonly identity: NativeIdentity }> {
    return { kind: 'match', identity };
  }
}

class RecordingKimiAdapter extends KimiCodeProviderAdapter {
  readonly finalizedInputs: Array<Parameters<KimiCodeProviderAdapter['finalize']>[0]> = [];
  readonly cancelInputs: Array<Parameters<KimiCodeProviderAdapter['cancel']>[0]> = [];
  readonly parsed: Promise<void>;
  private resolveParsed: () => void = () => undefined;

  constructor(options: ConstructorParameters<typeof KimiCodeProviderAdapter>[0]) {
    super(options);
    this.parsed = new Promise(resolve => { this.resolveParsed = resolve; });
  }

  override parseChunk(chunk: string, context?: Parameters<KimiCodeProviderAdapter['parseChunk']>[1]) {
    const result = super.parseChunk(chunk, context);
    this.resolveParsed();
    return result;
  }

  override async finalize(input: Parameters<KimiCodeProviderAdapter['finalize']>[0]) {
    this.finalizedInputs.push(input);
    return super.finalize(input);
  }

  override async cancel(input: Parameters<KimiCodeProviderAdapter['cancel']>[0]) {
    this.cancelInputs.push(input);
    return super.cancel(input);
  }
}

class BlockingCancelAdapter extends RecordingKimiAdapter {
  readonly cancelEntered = testDeferred<void>();
  readonly releaseCancel = testDeferred<void>();

  override async cancel(input: Parameters<KimiCodeProviderAdapter['cancel']>[0]) {
    this.cancelInputs.push(input);
    this.cancelEntered.resolve(undefined);
    await this.releaseCancel.promise;
    return { accepted: true } as const;
  }
}

class ThrowingCancelAdapter extends RecordingKimiAdapter {
  override async cancel(input: Parameters<KimiCodeProviderAdapter['cancel']>[0]): Promise<Awaited<ReturnType<KimiCodeProviderAdapter['cancel']>>> {
    this.cancelInputs.push(input);
    throw new Error('provider graceful cancellation failed');
  }
}

class BlockingFinalizeAdapter extends RecordingKimiAdapter {
  readonly finalizeEntered = testDeferred<void>();
  readonly releaseFinalize = testDeferred<void>();

  override async finalize(input: Parameters<KimiCodeProviderAdapter['finalize']>[0]) {
    this.finalizeEntered.resolve(undefined);
    await this.releaseFinalize.promise;
    return super.finalize(input);
  }
}

interface FixtureOptions {
  readonly authFailure?: boolean;
  readonly clock?: FakeClock;
  readonly observation?: FakeObservationPort;
  readonly probe?: ProcessProbePort;
  readonly sessionAdapterFactory?: (repo: ProviderSessionRepository) => DurableSessionRepositoryAdapter;
  readonly processRepoFactory?: (db: Db, factWriter: RuntimeEventOutboxWriter) => ProcessRepository;
  readonly processAdapterFactory?: (repo: ProcessRepository) => DurableProcessRepositoryAdapter;
  readonly outputAdapterFactory?: (repo: ProcessOutputReferenceRepository) => DurableOutputReferenceRepositoryAdapter;
  readonly failStderrOutput?: boolean;
  readonly adapter?: KimiCodeProviderAdapter;
}

function fixture(driver: PlatformProcessDriver, options: FixtureOptions | boolean = false) {
  const opts: FixtureOptions = typeof options === 'boolean' ? { authFailure: options } : options;
  const probe = opts.probe ?? probeFor(opts.authFailure ?? false);
  const db = migratedDb();
  const root = mkdtempSync(join(tmpdir(), 'agentos-m4-p4-coord-'));
  const events = new RuntimeEventRepository(db, createM3RuntimeEventRegistry());
  const outbox = new OutboxRepository(db, events);
  const factWriter = new RuntimeEventOutboxWriter(events, new RunSequenceAllocator(db), outbox, db);
  const sessionRepo = new ProviderSessionRepository(db, factWriter);
  const processRepo = opts.processRepoFactory === undefined
    ? new ProcessRepository(db, factWriter)
    : opts.processRepoFactory(db, factWriter);
  const outputRepo = new ProcessOutputReferenceRepository(db, factWriter);
  const seam = new DurableAtomicSeamImpl(db, sessionRepo, processRepo);
  const sessionAdapter = opts.sessionAdapterFactory === undefined ? new DurableSessionRepositoryAdapter(sessionRepo) : opts.sessionAdapterFactory(sessionRepo);
  const processAdapter = opts.processAdapterFactory === undefined
    ? new DurableProcessRepositoryAdapter(processRepo)
    : opts.processAdapterFactory(processRepo);
  const outputAdapter = opts.outputAdapterFactory === undefined ? new DurableOutputReferenceRepositoryAdapter(outputRepo) : opts.outputAdapterFactory(outputRepo);
  const coordinatorOptions = {
    sessionRepository: sessionAdapter,
    processRepository: processAdapter,
    outputReferenceRepository: outputAdapter,
    artifactSink: new FileArtifactSink(join(root, 'sink')),
    atomicSeam: seam,
    driver,
  } satisfies ConstructorParameters<typeof DurableProcessCoordinator>[0];
  const durableCoordinator = opts.failStderrOutput
    ? new PartialWriterCoordinator(coordinatorOptions)
    : new DurableProcessCoordinator(coordinatorOptions);
  const adapter = opts.adapter ?? new KimiCodeProviderAdapter({
    probe: probe,
    discover: async () => ({ found: true, selected: KIMI_EXE, candidates: [{ executable: KIMI_EXE, source: 'configuration', confidence: 1 }], warnings: [] }),
  });
  const registry = new ProviderRegistry([adapter]);
  const coordinator = new StageExecutionCoordinator({
    registry,
    durableCoordinator,
    sessionRepository: sessionAdapter,
    driver,
    probe: probe,
    claimOwner: 'run-engine',
    claimLeaseMs: 60000,
    now: () => NOW,
    clock: opts.clock,
    runEventObservation: opts.observation,
  });
  return { db, root, events, outbox, sessionRepo, processRepo, outputRepo, coordinator, driver, adapter };
}

function close(fx: ReturnType<typeof fixture>): void {
  fx.db.close();
  rmSync(fx.root, { recursive: true, force: true });
}

async function prepareSyntheticFinalizer() {
  const driver = new ControlledExitDriver();
  const fx = fixture(driver);
  const execution = fx.coordinator.execute(stageInput());
  await driver.handle.waitExitEntered.promise;
  const entry = (fx.coordinator as unknown as { liveAttempts: Map<string, unknown> }).liveAttempts.get(`${WS}|${RUN}|${STAGE}|1`);
  const process = fx.processRepo.findByRootClaim(WS, RUN, STAGE, 1, 'primary-provider');
  assert.ok(entry);
  assert.ok(process);
  const finalizeAttemptOnce = (fx.coordinator as unknown as {
    finalizeAttemptOnce(entry: unknown, disposition: unknown): Promise<StageExecutionOutcome>;
  }).finalizeAttemptOnce.bind(fx.coordinator);
  return { driver, fx, execution, entry, process, finalizeAttemptOnce };
}

class SlowSessionAdapter extends DurableSessionRepositoryAdapter {
  async casSessionTransition(input: Parameters<DurableSessionRepositoryAdapter['casSessionTransition']>[0]) {
    if (input.to === 'active') await new Promise(resolve => setTimeout(resolve, 250));
    return super.casSessionTransition(input);
  }
}

class BlockingActiveSessionAdapter extends DurableSessionRepositoryAdapter {
  readonly activeEntered = testDeferred<void>();
  readonly releaseActive = testDeferred<void>();

  override async casSessionTransition(input: Parameters<DurableSessionRepositoryAdapter['casSessionTransition']>[0]) {
    if (input.to === 'active') {
      this.activeEntered.resolve(undefined);
      await this.releaseActive.promise;
    }
    return super.casSessionTransition(input);
  }
}

class FinalizeFailOutputAdapter extends DurableOutputReferenceRepositoryAdapter {
  async finalizeReference(_input: Parameters<DurableOutputReferenceRepositoryAdapter['finalizeReference']>[0]) {
    return { kind: 'not-found' as const };
  }
}

class PartialWriterCoordinator extends DurableProcessCoordinator {
  async beginOutput(input: Parameters<DurableProcessCoordinator['beginOutput']>[0]) {
    if (input.stream === 'stderr') throw new Error('stderr writer unavailable');
    return super.beginOutput(input);
  }
}

class CheckpointProbeAdapter extends DurableOutputReferenceRepositoryAdapter {
  readonly checkpointed = testDeferred<void>();

  override async checkpoint(input: Parameters<DurableOutputReferenceRepositoryAdapter['checkpoint']>[0]) {
    const outcome = await super.checkpoint(input);
    this.checkpointed.resolve(undefined);
    return outcome;
  }
}

class TerminalFailSessionAdapter extends DurableSessionRepositoryAdapter {
  async casSessionTransition(input: Parameters<DurableSessionRepositoryAdapter['casSessionTransition']>[0]) {
    if (input.to === 'completed') return { kind: 'state-mismatch' as const };
    return super.casSessionTransition(input);
  }
}


class FakeByteHandle implements NativeProcessHandle {
  readonly pid = 4242;
  readonly identity: NativeIdentity = { pid: 4242, startedAtMs: Date.parse(NOW), executablePath: KIMI_EXE };
  readonly streams: NativeProcessStreams;
  private readonly exit: Promise<ExitEvidence>;
  constructor(stdoutChunks: Uint8Array[], exitCode = 0) {
    this.streams = { stdout: asyncIterableBytes(stdoutChunks), stderr: asyncIterableBytes([]) };
    this.exit = Promise.resolve({ exitCode, signal: null, exitedAt: Date.now() });
  }
  waitExit(): Promise<ExitEvidence> { return this.exit; }
}

function asyncIterableBytes(chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  return { async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; } };
}function countingProbe(): { counts: { version: number; help: number; auth: number }; probe: ProcessProbePort } {
  const counts = { version: 0, help: 0, auth: 0 };
  const probe: ProcessProbePort = {
    probe: async request => {
      if (request.args[0] === '--version') { counts.version += 1; return { stdout: '0.36.1', stderr: '', exitCode: 0, signal: null }; }
      if (request.args[0] === '--help') { counts.help += 1; return { stdout: 'Usage: kimi --output-format stream-json', stderr: '', exitCode: 0, signal: null }; }
      counts.auth += 1;
      return { stdout: '{"type":"assistant","role":"assistant","content":"ok"}', stderr: '', exitCode: 0, signal: null };
    },
  };
  return { counts, probe };
}
describe('StageExecutionCoordinator', () => {
  it('EVID-ID-01 proven explicit active cancellation exposes the exact durable root Process identity', async () => {
    const prepared = await prepareSyntheticFinalizer();
    const exactProcessId = prepared.process.id;
    try {
      const stop = {
        process: { ...prepared.process, processId: exactProcessId },
        cleanup: { classification: 'complete', cleanupResult: 'TERMINATED', proven: true, knownPids: [] },
        proven: true,
        reason: 'cancel',
        stopOrigin: 'EXPLICIT_CANCEL',
        stopAccepted: true,
      } as unknown as ProcessStopResult;
      const outcome = await prepared.finalizeAttemptOnce(prepared.entry, {
        kind: 'stop', stop, stopOrigin: 'EXPLICIT_CANCEL',
      });

      assert.equal(outcome.kind, 'stopped');
      if (outcome.kind !== 'stopped') return;
      assert.equal(outcome.stopOrigin, 'EXPLICIT_CANCEL');
      assert.equal(outcome.proven, true);
      assert.equal((outcome as unknown as { processId: string }).processId, exactProcessId);
    } finally {
      prepared.driver.handle.releaseExit();
      await Promise.allSettled([prepared.execution]);
      close(prepared.fx);
    }
  });

  it('EVID-ID-02 unproven explicit cancellation exposes identity without claiming terminatedProcessIds', async () => {
    const prepared = await prepareSyntheticFinalizer();
    const exactProcessId = prepared.process.id;
    try {
      const stop = {
        process: { ...prepared.process, processId: exactProcessId },
        cleanup: { classification: 'unknown', cleanupResult: 'UNKNOWN_PLATFORM_UNAVAILABLE', proven: false, knownPids: [] },
        proven: false,
        reason: 'cancel',
        stopOrigin: 'EXPLICIT_CANCEL',
        stopAccepted: true,
      } as unknown as ProcessStopResult;
      const outcome = await prepared.finalizeAttemptOnce(prepared.entry, {
        kind: 'stop', stop, stopOrigin: 'EXPLICIT_CANCEL',
      });

      assert.equal(outcome.kind, 'stopped');
      if (outcome.kind !== 'stopped') return;
      assert.equal(outcome.proven, false);
      assert.equal((outcome as unknown as { processId: string }).processId, exactProcessId);
      assert.equal('terminatedProcessIds' in outcome, false);
    } finally {
      prepared.driver.handle.releaseExit();
      await Promise.allSettled([prepared.execution]);
      close(prepared.fx);
    }
  });

  it('EVID-ID-03 created-before-spawn cancellation exposes the durable reservation without requiring a native PID', async () => {
    const prepared = await prepareSyntheticFinalizer();
    const exactProcessId = prepared.process.id;
    try {
      const stop = {
        process: { ...prepared.process, processId: exactProcessId, nativePid: null, nativeStartedAt: null, processGroupId: null, platformHandleId: null },
        authority: 'created-before-spawn',
        cleanup: null,
        proven: true,
        reason: 'cancel',
        stopOrigin: 'EXPLICIT_CANCEL',
        stopAccepted: true,
      } as unknown as ProcessStopResult;
      const outcome = await prepared.finalizeAttemptOnce(prepared.entry, {
        kind: 'stop', stop, stopOrigin: 'EXPLICIT_CANCEL',
      });

      assert.equal(outcome.kind, 'stopped');
      if (outcome.kind !== 'stopped') return;
      assert.equal((stop.process as unknown as { nativePid: number | null }).nativePid, null);
      assert.equal((outcome as unknown as { processId: string }).processId, exactProcessId);
    } finally {
      prepared.driver.handle.releaseExit();
      await Promise.allSettled([prepared.execution]);
      close(prepared.fx);
    }
  });

  it('EVID-ID-04 stopped timeout preserves identity and existing unproven timeout semantics', async () => {
    const prepared = await prepareSyntheticFinalizer();
    const exactProcessId = prepared.process.id;
    try {
      const stop = {
        process: { ...prepared.process, processId: exactProcessId },
        cleanup: { classification: 'unknown', cleanupResult: 'UNKNOWN_PLATFORM_UNAVAILABLE', proven: false, knownPids: [] },
        proven: false,
        reason: 'STARTUP_TIMEOUT',
        stopOrigin: 'STARTUP_TIMEOUT',
        stopAccepted: true,
      } as unknown as ProcessStopResult;
      const outcome = await prepared.finalizeAttemptOnce(prepared.entry, {
        kind: 'stop', stop, stopOrigin: 'STARTUP_TIMEOUT',
      });

      assert.equal(outcome.kind, 'stopped');
      if (outcome.kind !== 'stopped') return;
      assert.equal(outcome.stopOrigin, 'STARTUP_TIMEOUT');
      assert.equal(outcome.proven, false);
      assert.equal((outcome as unknown as { processId: string }).processId, exactProcessId);
    } finally {
      prepared.driver.handle.releaseExit();
      await Promise.allSettled([prepared.execution]);
      close(prepared.fx);
    }
  });

  it('EVID-ID-05 duplicate explicit cancellation joins one stop ticket and returns one Process identity', async () => {
    const clock = new FakeClock();
    const driver = new ControlledExitDriver();
    let processAdapter!: BlockingStoppingProcessAdapter;
    const adapter = new RecordingKimiAdapter({
      probe: probeFor(false),
      discover: async () => ({ found: true, selected: KIMI_EXE, candidates: [{ executable: KIMI_EXE, source: 'configuration', confidence: 1 }], warnings: [] }),
    });
    const fx = fixture(driver, {
      clock,
      adapter,
      processAdapterFactory: repo => {
        processAdapter = new BlockingStoppingProcessAdapter(repo);
        return processAdapter;
      },
    });
    const execution = fx.coordinator.execute(stageInput({
      providerSnapshot: { ...providerSnapshot(), timeoutPolicy: { ...providerSnapshot().timeoutPolicy, cancelGracePeriodMs: 0 } },
    }));
    let firstCancel!: Promise<StageExecutionOutcome>;
    let secondCancel!: Promise<StageExecutionOutcome>;
    try {
      await driver.handle.waitExitEntered.promise;
      const process = fx.processRepo.findByRootClaim(WS, RUN, STAGE, 1, 'primary-provider');
      assert.ok(process);
      firstCancel = fx.coordinator.cancelAttempt({
        workspaceId: WS, runId: RUN, stageId: STAGE, stageAttempt: 1,
        correlationId: 'duplicate-cancel-1', causationId: 'duplicate-cancel-1',
      });
      await processAdapter.stoppingEntered.promise;
      secondCancel = fx.coordinator.cancelAttempt({
        workspaceId: WS, runId: RUN, stageId: STAGE, stageAttempt: 1,
        correlationId: 'duplicate-cancel-2', causationId: 'duplicate-cancel-2',
      });
      processAdapter.releaseStopping();
      for (let turn = 0; turn < 20 && driver.gracefulStopCalls === 0; turn += 1) await Promise.resolve();
      clock.advance(5000);
      for (let turn = 0; turn < 20 && driver.terminateTreeCalls === 0; turn += 1) await Promise.resolve();
      driver.handle.releaseExit();

      const [first, second, executed] = await Promise.all([firstCancel, secondCancel, execution]);
      assert.strictEqual(first, second);
      assert.strictEqual(first, executed);
      assert.equal(first.kind, 'stopped');
      if (first.kind !== 'stopped') return;
      assert.equal((first as unknown as { processId: string }).processId, process.id);
      assert.equal(driver.gracefulStopCalls, 1);
      assert.ok(driver.terminateTreeCalls <= 1);
      assert.ok(driver.verifySurvivorsCalls <= 1);
      assert.equal(adapter.finalizedInputs.length, 1);
      assert.equal(adapter.cancelInputs.length, 1);
    } finally {
      processAdapter?.releaseStopping();
      driver.handle.releaseExit();
      await Promise.allSettled([execution, firstCancel, secondCancel]);
      close(fx);
    }
  });

  it('EVID-ID-06 derives processId from ProcessStopResult.process.processId rather than another identity source', async () => {
    const prepared = await prepareSyntheticFinalizer();
    const stopResultProcessId = 'stop-result-process-identity';
    try {
      const stop = {
        process: { ...prepared.process, processId: stopResultProcessId, nativePid: 999999 },
        cleanup: { classification: 'complete', cleanupResult: 'TERMINATED', proven: true, knownPids: [999999] },
        proven: true,
        reason: 'cancel',
        stopOrigin: 'EXPLICIT_CANCEL',
        stopAccepted: true,
      } as unknown as ProcessStopResult;
      const outcome = await prepared.finalizeAttemptOnce(prepared.entry, {
        kind: 'stop', stop, stopOrigin: 'EXPLICIT_CANCEL',
      });

      assert.equal(outcome.kind, 'stopped');
      if (outcome.kind !== 'stopped') return;
      assert.notEqual(stopResultProcessId, prepared.process.id);
      assert.equal((outcome as unknown as { processId: string }).processId, stopResultProcessId);
      assert.equal('terminatedProcessIds' in outcome, false);
    } finally {
      prepared.driver.handle.releaseExit();
      await Promise.allSettled([prepared.execution]);
      close(prepared.fx);
    }
  });

  it('aborts a partial stdout writer when stderr writer creation fails and never spawns', async () => {
    const fx = fixture(new FakeDriver(new FakeHandle([])), { failStderrOutput: true });
    try {
      const outcome = await fx.coordinator.execute(stageInput());
      assert.equal(outcome.kind, 'failed');
      assert.equal((fx.driver as unknown as { spawnCalls: number }).spawnCalls, 0);
      const process = fx.processRepo.findByRootClaim(WS, RUN, STAGE, 1, 'primary-provider');
      assert.equal(process?.status, 'failed');
      const session = fx.sessionRepo.findByClaimKey(WS, RUN, STAGE, 1, 'primary-provider');
      assert.equal(session?.status, 'failed');
    } finally {
      close(fx);
    }
  });

  it('P5A-REMED2-01: stale created read follows the later active-stop ticket', async () => {
    const driver = new SpawnGateDriver();
    const adapter = new RecordingKimiAdapter({
      probe: probeFor(false),
      discover: async () => ({ found: true, selected: KIMI_EXE, candidates: [{ executable: KIMI_EXE, source: 'configuration', confidence: 1 }], warnings: [] }),
    });
    let processAdapter!: StaleCreatedProcessAdapter;
    const fx = fixture(driver, {
      adapter,
      processAdapterFactory: repo => {
        processAdapter = new StaleCreatedProcessAdapter(repo);
        return processAdapter;
      },
    });
    const executePromise = fx.coordinator.execute(stageInput({
      providerSnapshot: { ...providerSnapshot(), timeoutPolicy: { ...providerSnapshot().timeoutPolicy, cancelGracePeriodMs: 0 } },
    }));
    let cancelPromise!: Promise<StageExecutionOutcome>;
    try {
      await driver.spawnEntered.promise;
      cancelPromise = fx.coordinator.cancelAttempt({
        workspaceId: WS,
        runId: RUN,
        stageId: STAGE,
        stageAttempt: 1,
        correlationId: 'stale-created-correlation',
        causationId: 'stale-created-causation',
      });
      await processAdapter.processReadEntered.promise;

      driver.releaseSpawn.resolve(undefined);
      for (let turn = 0; turn < 40; turn += 1) {
        await Promise.resolve();
        if (fx.processRepo.findByRootClaim(WS, RUN, STAGE, 1, 'primary-provider')?.status === 'running') break;
      }
      processAdapter.releaseProcessRead.resolve(undefined);

      const [executeOutcome, cancelOutcome] = await Promise.all([executePromise, cancelPromise]);
      assert.strictEqual(cancelOutcome, executeOutcome);
      assert.equal(cancelOutcome.kind, 'stopped');
      assert.equal(cancelOutcome.proven, true);
      assert.equal(adapter.cancelInputs.length, 1);
      assert.equal(driver.spawnCalls, 1);
    } finally {
      driver.releaseSpawn.resolve(undefined);
      processAdapter.releaseProcessRead.resolve(undefined);
      await Promise.allSettled([executePromise, ...(cancelPromise === undefined ? [] : [cancelPromise])]);
      close(fx);
    }
  });

  it('P5A-REMED2-02: created-before-spawn cancellation with a live entry converges once', async () => {
    const driver = new ControlledExitDriver('');
    const adapter = new RecordingKimiAdapter({
      probe: probeFor(false),
      discover: async () => ({ found: true, selected: KIMI_EXE, candidates: [{ executable: KIMI_EXE, source: 'configuration', confidence: 1 }], warnings: [] }),
    });
    let processAdapter!: SpawnRightGateProcessAdapter;
    const fx = fixture(driver, {
      adapter,
      processAdapterFactory: repo => {
        processAdapter = new SpawnRightGateProcessAdapter(repo);
        return processAdapter;
      },
    });
    const executePromise = fx.coordinator.execute(stageInput());
    let cancelPromise!: Promise<StageExecutionOutcome>;
    try {
      await processAdapter.spawnRightEntered.promise;
      cancelPromise = fx.coordinator.cancelAttempt({
        workspaceId: WS,
        runId: RUN,
        stageId: STAGE,
        stageAttempt: 1,
        correlationId: 'created-entry-correlation',
        causationId: 'created-entry-causation',
      });
      for (let turn = 0; turn < 40; turn += 1) {
        await Promise.resolve();
        if (fx.processRepo.findByRootClaim(WS, RUN, STAGE, 1, 'primary-provider')?.status === 'failed') break;
      }
      assert.equal(fx.processRepo.findByRootClaim(WS, RUN, STAGE, 1, 'primary-provider')?.status, 'failed');
      processAdapter.releaseSpawnRight.resolve(undefined);

      const [executeOutcome, cancelOutcome] = await Promise.all([executePromise, cancelPromise]);
      assert.strictEqual(cancelOutcome, executeOutcome);
      assert.equal(cancelOutcome.kind, 'stopped');
      assert.equal(driver.spawnCalls, 0);
      assert.equal(driver.gracefulStopCalls, 0);
      assert.equal(driver.terminateTreeCalls, 0);
      assert.equal(driver.verifySurvivorsCalls, 0);
      assert.equal(adapter.cancelInputs.length, 0);
    } finally {
      processAdapter.releaseSpawnRight.resolve(undefined);
      await Promise.allSettled([executePromise, ...(cancelPromise === undefined ? [] : [cancelPromise])]);
      close(fx);
    }
  });

  it('P5A-REMED2-03: stale created read joins natural terminal finalization', async () => {
    const driver = new ControlledExitDriver();
    const adapter = new BlockingFinalizeAdapter({
      probe: probeFor(false),
      discover: async () => ({ found: true, selected: KIMI_EXE, candidates: [{ executable: KIMI_EXE, source: 'configuration', confidence: 1 }], warnings: [] }),
    });
    let processAdapter!: StaleCreatedProcessAdapter;
    const fx = fixture(driver, {
      adapter,
      processAdapterFactory: repo => {
        processAdapter = new StaleCreatedProcessAdapter(repo);
        processAdapter.blockStaleProcessRead = false;
        return processAdapter;
      },
    });
    const executePromise = fx.coordinator.execute(stageInput());
    let cancelPromise!: Promise<StageExecutionOutcome>;
    try {
      await driver.handle.waitExitEntered.promise;
      driver.handle.releaseExit();
      await adapter.finalizeEntered.promise;
      cancelPromise = fx.coordinator.cancelAttempt({
        workspaceId: WS,
        runId: RUN,
        stageId: STAGE,
        stageAttempt: 1,
        correlationId: 'natural-after-stale-correlation',
        causationId: 'natural-after-stale-causation',
      });
      adapter.releaseFinalize.resolve(undefined);

      const [natural, joined] = await Promise.all([executePromise, cancelPromise]);
      assert.equal(natural.kind, 'completed');
      assert.strictEqual(joined, natural);
      assert.equal(adapter.cancelInputs.length, 0);
      assert.equal(driver.gracefulStopCalls, 0);
      assert.equal(driver.terminateTreeCalls, 0);
      assert.equal(driver.verifySurvivorsCalls, 0);
    } finally {
      driver.handle.releaseExit();
      adapter.releaseFinalize.resolve(undefined);
      await Promise.allSettled([executePromise, ...(cancelPromise === undefined ? [] : [cancelPromise])]);
      close(fx);
    }
  });

  it('P5A-REMED2-08: missing live rendezvous fails closed after retained-handle cleanup', async () => {
    const driver = new ControlledExitDriver('');
    const fx = fixture(driver, {
      adapter: new RecordingKimiAdapter({
        probe: probeFor(false),
        discover: async () => ({ found: true, selected: KIMI_EXE, candidates: [{ executable: KIMI_EXE, source: 'configuration', confidence: 1 }], warnings: [] }),
      }),
    });
    const executePromise = fx.coordinator.execute(stageInput({
      providerSnapshot: { ...providerSnapshot(), timeoutPolicy: { ...providerSnapshot().timeoutPolicy, cancelGracePeriodMs: 0 } },
    }));
    try {
      await driver.handle.waitExitEntered.promise;
      const liveAttempts = (fx.coordinator as unknown as { liveAttempts: Map<string, unknown> }).liveAttempts;
      assert.ok(liveAttempts.delete(`${WS}|${RUN}|${STAGE}|1`));

      await assert.rejects(
        fx.coordinator.cancelAttempt({
          workspaceId: WS,
          runId: RUN,
          stageId: STAGE,
          stageAttempt: 1,
          correlationId: 'missing-rendezvous-correlation',
          causationId: 'missing-rendezvous-causation',
        }),
        /LIVE_EXECUTION_UNAVAILABLE/,
      );
      assert.equal(driver.gracefulStopCalls, 1);
      assert.equal(driver.terminateTreeCalls, 1);
      assert.equal(driver.verifySurvivorsCalls, 1);
    } finally {
      driver.handle.releaseExit();
      await Promise.allSettled([executePromise]);
      close(fx);
    }
  });

  it('P5A-REMED-01: natural durable CAS wins when cancel acceptance is blocked', async () => {
    const driver = new ControlledExitDriver('');
    const adapter = new RecordingKimiAdapter({
      probe: probeFor(false),
      discover: async () => ({ found: true, selected: KIMI_EXE, candidates: [{ executable: KIMI_EXE, source: 'configuration', confidence: 1 }], warnings: [] }),
    });
    let processAdapter!: BlockingStoppingProcessAdapter;
    const fx = fixture(driver, {
      adapter,
      processAdapterFactory: repo => {
        processAdapter = new BlockingStoppingProcessAdapter(repo);
        return processAdapter;
      },
    });
    const input = stageInput({
      providerSnapshot: { ...providerSnapshot(), timeoutPolicy: { ...providerSnapshot().timeoutPolicy, cancelGracePeriodMs: 0 } },
    });
    const executePromise = fx.coordinator.execute(input);
    let cancelPromise: Promise<StageExecutionOutcome> | undefined;
    try {
      await driver.handle.waitExitEntered.promise;
      cancelPromise = fx.coordinator.cancelAttempt({
        workspaceId: WS,
        runId: RUN,
        stageId: STAGE,
        stageAttempt: 1,
        correlationId: 'natural-race-correlation',
        causationId: 'natural-race-causation',
      });
      await processAdapter.stoppingEntered.promise;

      driver.handle.releaseExit();
      for (let turn = 0; turn < 40; turn += 1) await Promise.resolve();

      assert.equal(processAdapter.naturalCasCalls, 1);
      const natural = await executePromise;
      assert.equal(natural.kind, 'failed');
      assert.equal(fx.sessionRepo.findByClaimKey(WS, RUN, STAGE, 1, 'primary-provider')?.status, 'failed');
      assert.equal(adapter.cancelInputs.length, 0);
      assert.equal(driver.gracefulStopCalls, 0);
      assert.equal(driver.terminateTreeCalls, 0);

      processAdapter.releaseStopping();
      const joined = await cancelPromise;
      assert.strictEqual(joined, natural);
    } finally {
      processAdapter.releaseStopping();
      await Promise.allSettled([executePromise, ...(cancelPromise === undefined ? [] : [cancelPromise])]);
      close(fx);
    }
  });

  it('P5A-REMED-02: durable stop acceptance owns finalization before a later natural exit', async () => {
    const driver = new ControlledExitDriver();
    const adapter = new RecordingKimiAdapter({
      probe: probeFor(false),
      discover: async () => ({ found: true, selected: KIMI_EXE, candidates: [{ executable: KIMI_EXE, source: 'configuration', confidence: 1 }], warnings: [] }),
    });
    const fx = fixture(driver, { adapter });
    const executePromise = fx.coordinator.execute(stageInput({
      providerSnapshot: { ...providerSnapshot(), timeoutPolicy: { ...providerSnapshot().timeoutPolicy, cancelGracePeriodMs: 0 } },
    }));
    try {
      await driver.handle.waitExitEntered.promise;
      const stopped = await fx.coordinator.cancelAttempt({
        workspaceId: WS,
        runId: RUN,
        stageId: STAGE,
        stageAttempt: 1,
        correlationId: 'stop-race-correlation',
        causationId: 'stop-race-causation',
      });

      assert.equal(stopped.kind, 'stopped');
      assert.equal(stopped.proven, true);
      assert.equal(adapter.cancelInputs.length, 1);
      assert.equal(adapter.finalizedInputs.length, 1);
      assert.equal(adapter.finalizedInputs[0]?.cancelled, true);
      assert.equal(fx.sessionRepo.findByClaimKey(WS, RUN, STAGE, 1, 'primary-provider')?.status, 'cancelled');

      driver.handle.releaseExit();
      const joined = await executePromise;
      assert.strictEqual(joined, stopped);
      assert.equal(adapter.finalizedInputs.length, 1);
    } finally {
      driver.handle.releaseExit();
      await Promise.allSettled([executePromise]);
      close(fx);
    }
  });

  it('P5A-REMED-04: Adapter.cancel completes before platform cleanup begins', async () => {
    const driver = new ControlledExitDriver();
    const adapter = new BlockingCancelAdapter({
      probe: probeFor(false),
      discover: async () => ({ found: true, selected: KIMI_EXE, candidates: [{ executable: KIMI_EXE, source: 'configuration', confidence: 1 }], warnings: [] }),
    });
    const fx = fixture(driver, { adapter });
    const executePromise = fx.coordinator.execute(stageInput({
      providerSnapshot: { ...providerSnapshot(), timeoutPolicy: { ...providerSnapshot().timeoutPolicy, cancelGracePeriodMs: 0 } },
    }));
    let cancelPromise!: Promise<StageExecutionOutcome>;
    try {
      await driver.handle.waitExitEntered.promise;
      cancelPromise = fx.coordinator.cancelAttempt({
        workspaceId: WS,
        runId: RUN,
        stageId: STAGE,
        stageAttempt: 1,
        correlationId: 'order-correlation',
        causationId: 'order-causation',
      });
      await adapter.cancelEntered.promise;
      for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
      assert.equal(driver.gracefulStopCalls, 0);
      assert.equal(driver.terminateTreeCalls, 0);

      adapter.releaseCancel.resolve(undefined);
      const stopped = await cancelPromise;
      assert.equal(stopped.kind, 'stopped');
      assert.equal(driver.gracefulStopCalls, 1);
      assert.equal(driver.terminateTreeCalls, 1);
    } finally {
      adapter.releaseCancel.resolve(undefined);
      driver.handle.releaseExit();
      await Promise.allSettled([executePromise, cancelPromise]);
      close(fx);
    }
  });

  it('continues platform cleanup when Adapter.cancel throws', async () => {
    const driver = new ControlledExitDriver();
    const adapter = new ThrowingCancelAdapter({
      probe: probeFor(false),
      discover: async () => ({ found: true, selected: KIMI_EXE, candidates: [{ executable: KIMI_EXE, source: 'configuration', confidence: 1 }], warnings: [] }),
    });
    const fx = fixture(driver, { adapter });
    const executePromise = fx.coordinator.execute(stageInput({
      providerSnapshot: { ...providerSnapshot(), timeoutPolicy: { ...providerSnapshot().timeoutPolicy, cancelGracePeriodMs: 0 } },
    }));
    let cancelPromise!: Promise<StageExecutionOutcome>;
    try {
      await driver.handle.waitExitEntered.promise;
      cancelPromise = fx.coordinator.cancelAttempt({
        workspaceId: WS,
        runId: RUN,
        stageId: STAGE,
        stageAttempt: 1,
        correlationId: 'throwing-cancel-correlation',
        causationId: 'throwing-cancel-causation',
      });
      const stopped = await cancelPromise;
      assert.equal(stopped.kind, 'stopped');
      assert.equal(driver.gracefulStopCalls, 1);
      assert.equal(driver.terminateTreeCalls, 1);
      assert.equal(adapter.cancelInputs.length, 1);
    } finally {
      driver.handle.releaseExit();
      await Promise.allSettled([executePromise, ...(cancelPromise === undefined ? [] : [cancelPromise])]);
      close(fx);
    }
  });

  it('P5A-REMED-10: unproven STARTUP_TIMEOUT is stopped without lifecycle failure', async () => {
    const driver = new ControlledExitDriver();
    const adapter = new RecordingKimiAdapter({
      probe: probeFor(false),
      discover: async () => ({ found: true, selected: KIMI_EXE, candidates: [{ executable: KIMI_EXE, source: 'configuration', confidence: 1 }], warnings: [] }),
    });
    const fx = fixture(driver, { adapter });
    const executePromise = fx.coordinator.execute(stageInput());
    try {
      await driver.handle.waitExitEntered.promise;
      for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
      const entry = (fx.coordinator as unknown as { liveAttempts: Map<string, unknown> }).liveAttempts.get(`${WS}|${RUN}|${STAGE}|1`);
      const process = fx.processRepo.findByRootClaim(WS, RUN, STAGE, 1, 'primary-provider');
      assert.ok(entry);
      assert.ok(process);
      const stop = {
        process,
        cleanup: { classification: 'unknown', cleanupResult: 'UNKNOWN_PLATFORM_UNAVAILABLE', proven: false, knownPids: [] },
        proven: false,
        reason: 'STARTUP_TIMEOUT',
        stopOrigin: 'STARTUP_TIMEOUT',
        stopAccepted: true,
      } as unknown as ProcessStopResult;
      const finalizer = (fx.coordinator as unknown as {
        finalizeAttemptOnce(entry: unknown, disposition: unknown): Promise<StageExecutionOutcome>;
      }).finalizeAttemptOnce.bind(fx.coordinator);
      const outcome = await finalizer(entry, { kind: 'stop', stop, stopOrigin: 'STARTUP_TIMEOUT' });

      assert.equal(outcome.kind, 'stopped');
      assert.equal(outcome.proven, false);
      assert.equal(outcome.stopOrigin, 'STARTUP_TIMEOUT');
      assert.equal(adapter.finalizedInputs.length, 0);
    } finally {
      driver.handle.releaseExit();
      await Promise.allSettled([executePromise]);
      close(fx);
    }
  });

  it('P5A-REMED-11: proven STARTUP_TIMEOUT finalizes as a non-cancelled provider start failure', async () => {
    const driver = new ControlledExitDriver();
    const adapter = new RecordingKimiAdapter({
      probe: probeFor(false),
      discover: async () => ({ found: true, selected: KIMI_EXE, candidates: [{ executable: KIMI_EXE, source: 'configuration', confidence: 1 }], warnings: [] }),
    });
    const fx = fixture(driver, { adapter });
    const executePromise = fx.coordinator.execute(stageInput());
    try {
      await driver.handle.waitExitEntered.promise;
      for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
      const entry = (fx.coordinator as unknown as { liveAttempts: Map<string, unknown> }).liveAttempts.get(`${WS}|${RUN}|${STAGE}|1`);
      const process = fx.processRepo.findByRootClaim(WS, RUN, STAGE, 1, 'primary-provider');
      assert.ok(entry);
      assert.ok(process);
      const stop = {
        process,
        cleanup: { classification: 'complete', cleanupResult: 'TERMINATED', proven: true, knownPids: [] },
        proven: true,
        reason: 'STARTUP_TIMEOUT',
        stopOrigin: 'STARTUP_TIMEOUT',
        stopAccepted: true,
      } as unknown as ProcessStopResult;
      const finalizer = (fx.coordinator as unknown as {
        finalizeAttemptOnce(entry: unknown, disposition: unknown): Promise<StageExecutionOutcome>;
      }).finalizeAttemptOnce.bind(fx.coordinator);
      const outcome = await finalizer(entry, { kind: 'stop', stop, stopOrigin: 'STARTUP_TIMEOUT' });

      assert.equal(outcome.kind, 'failed');
      assert.equal((outcome as Extract<StageExecutionOutcome, { kind: 'failed' }>).problem.code, 'PROVIDER_START_FAILED');
      assert.equal(adapter.finalizedInputs.length, 1);
      assert.equal(adapter.finalizedInputs[0]?.cancelled, false);
      assert.deepEqual((adapter.finalizedInputs[0] as unknown as { providerError: { code: string; phase: string } }).providerError, {
        code: 'PROVIDER_START_FAILED',
        phase: 'startup',
        retryable: false,
        message: 'Provider process could not start before timeout',
      });
    } finally {
      driver.handle.releaseExit();
      await Promise.allSettled([executePromise]);
      close(fx);
    }
  });

  it('P5A-REMED-12: proven IDLE and TOTAL timeout finalization is non-cancelled runtime failure', async () => {
    for (const origin of ['IDLE_TIMEOUT', 'TOTAL_TIMEOUT'] as const) {
      const driver = new ControlledExitDriver();
      const adapter = new RecordingKimiAdapter({
        probe: probeFor(false),
        discover: async () => ({ found: true, selected: KIMI_EXE, candidates: [{ executable: KIMI_EXE, source: 'configuration', confidence: 1 }], warnings: [] }),
      });
      const fx = fixture(driver, { adapter });
      const executePromise = fx.coordinator.execute(stageInput());
      try {
        await driver.handle.waitExitEntered.promise;
        for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
        const entry = (fx.coordinator as unknown as { liveAttempts: Map<string, unknown> }).liveAttempts.get(`${WS}|${RUN}|${STAGE}|1`);
        const process = fx.processRepo.findByRootClaim(WS, RUN, STAGE, 1, 'primary-provider');
        assert.ok(entry);
        assert.ok(process);
        const stop = {
          process,
          cleanup: { classification: 'complete', cleanupResult: 'TERMINATED', proven: true, knownPids: [] },
          proven: true,
          reason: origin,
          stopOrigin: origin,
          stopAccepted: true,
        } as unknown as ProcessStopResult;
        const finalizer = (fx.coordinator as unknown as {
          finalizeAttemptOnce(entry: unknown, disposition: unknown): Promise<StageExecutionOutcome>;
        }).finalizeAttemptOnce.bind(fx.coordinator);
        const outcome = await finalizer(entry, { kind: 'stop', stop, stopOrigin: origin });

        assert.equal(outcome.kind, 'failed');
        assert.equal((outcome as Extract<StageExecutionOutcome, { kind: 'failed' }>).problem.code, 'PROVIDER_SESSION_FAILED');
        assert.equal(adapter.finalizedInputs.length, 1);
        assert.equal(adapter.finalizedInputs[0]?.cancelled, false);
        assert.deepEqual((adapter.finalizedInputs[0] as unknown as { providerError: { code: string; phase: string } }).providerError, {
          code: 'PROVIDER_SESSION_FAILED',
          phase: 'runtime',
          retryable: false,
          message: 'Provider session timed out',
        });
      } finally {
        driver.handle.releaseExit();
        await Promise.allSettled([executePromise]);
        close(fx);
      }
    }
  });

  it('cancels the exact live attempt through one proof-backed internal stop outcome', async () => {
    const driver = new BlockingCancelDriver();
    const fx = fixture(driver);
    try {
      const execution = fx.coordinator.execute(stageInput({
        providerSnapshot: { ...providerSnapshot(), timeoutPolicy: { ...providerSnapshot().timeoutPolicy, cancelGracePeriodMs: 0 } },
      }));
      await driver.spawnEntered;
      assert.equal(driver.spawnCalls, 1);

      const outcome = await fx.coordinator.cancelAttempt({
        workspaceId: WS,
        runId: RUN,
        stageId: STAGE,
        stageAttempt: 1,
        correlationId: 'cancel-correlation',
        causationId: 'cancel-causation',
      });

      assert.equal(outcome.kind, 'stopped');
      assert.equal(outcome.proven, true);
      assert.equal((await execution).kind, 'stopped');
      assert.equal(driver.spawnCalls, 1);
      assert.equal(driver.terminateTreeCalls, 1);
      assert.equal(driver.verifySurvivorsCalls, 1);
    } finally {
      close(fx);
    }
  });

  it('returns stopped but unproven when cancellation receives bare complete', async () => {
    const driver = new BlockingCancelDriver(false);
    const fx = fixture(driver);
    try {
      const execution = fx.coordinator.execute(stageInput({
        providerSnapshot: { ...providerSnapshot(), timeoutPolicy: { ...providerSnapshot().timeoutPolicy, cancelGracePeriodMs: 0 } },
      }));
      await driver.spawnEntered;
      const outcome = await fx.coordinator.cancelAttempt({
        workspaceId: WS,
        runId: RUN,
        stageId: STAGE,
        stageAttempt: 1,
        correlationId: 'cancel-bare-correlation',
        causationId: 'cancel-bare-causation',
      });

      assert.equal(outcome.kind, 'stopped');
      assert.equal(outcome.proven, false);
      assert.equal((await execution).kind, 'stopped');
      const process = fx.processRepo.findByRootClaim(WS, RUN, STAGE, 1, 'primary-provider');
      assert.equal(process?.status, 'orphaned');
      const session = fx.sessionRepo.findByClaimKey(WS, RUN, STAGE, 1, 'primary-provider');
      assert.equal(session?.status, 'failed');
    } finally {
      close(fx);
    }
  });

  it('flushes a buffered parser tail before proven cancellation finalization', async () => {
    const driver = new TailCancelDriver();
    const adapter = new RecordingKimiAdapter({
      probe: probeFor(false),
      discover: async () => ({
        found: true,
        selected: KIMI_EXE,
        candidates: [{ executable: KIMI_EXE, source: 'configuration', confidence: 1 }],
        warnings: [],
      }),
    });
    const fx = fixture(driver, {
      adapter,
    });
    try {
      const execution = fx.coordinator.execute(stageInput({
        providerSnapshot: { ...providerSnapshot(), timeoutPolicy: { ...providerSnapshot().timeoutPolicy, cancelGracePeriodMs: 0 } },
      }));
      await driver.handle.stdoutStarted;
      driver.handle.release();
      await adapter.parsed;

      const outcome = await fx.coordinator.cancelAttempt({
        workspaceId: WS,
        runId: RUN,
        stageId: STAGE,
        stageAttempt: 1,
        correlationId: 'cancel-tail-correlation',
        causationId: 'cancel-tail-causation',
      });

      assert.equal(outcome.kind, 'stopped');
      assert.equal(outcome.proven, true);
      const finalized = adapter.finalizedInputs[0];
      assert.ok(finalized);
      assert.equal(finalized.cancelled, true);
      assert.ok(finalized.parsedEvents.some(event => event.type === 'assistant.message'));
      assert.equal((await execution).kind, 'stopped');
    } finally {
      close(fx);
    }
  });

  it('fails closed when the cancellation claim uses a different Stage attempt', async () => {
    const driver = new BlockingCancelDriver();
    const fx = fixture(driver);
    try {
      const execution = fx.coordinator.execute(stageInput({
        providerSnapshot: { ...providerSnapshot(), timeoutPolicy: { ...providerSnapshot().timeoutPolicy, cancelGracePeriodMs: 0 } },
      }));
      await driver.spawnEntered;
      await assert.rejects(
        fx.coordinator.cancelAttempt({
          workspaceId: WS,
          runId: RUN,
          stageId: STAGE,
          stageAttempt: 2,
          correlationId: 'wrong-attempt-correlation',
          causationId: 'wrong-attempt-causation',
        }),
        /LIVE_EXECUTION_UNAVAILABLE/,
      );
      driver.handle.pushStdout('{"type":"assistant","role":"assistant","content":"ok"}\n');
      driver.handle.emitExit();
      assert.equal((await execution).kind, 'completed');
    } finally {
      close(fx);
    }
  });

  it('runs a successful Kimi vertical slice: one Session, one Process, completed outcome, durable facts', async () => {
    const fx = fixture(new FakeDriver(new FakeHandle(['{"type":"assistant","role":"assistant","content":"ok"}\n'])));
    try {
      const outcome = await fx.coordinator.execute(stageInput());

      assert.equal(outcome.kind, 'completed');
      if (outcome.kind !== 'completed') return;
      assert.equal(outcome.artifactIds.length, 2);
      assert.equal(outcome.outputContractSatisfied, true);
      assert.equal((fx.driver as unknown as { spawnCalls: number }).spawnCalls, 1);
      const sessions = fx.db.prepare('SELECT COUNT(*) AS c FROM provider_sessions').get() as { c: number };
      const processes = fx.db.prepare('SELECT COUNT(*) AS c FROM runtime_processes').get() as { c: number };
      assert.equal(sessions.c, 1);
      assert.equal(processes.c, 1);
      const session = fx.sessionRepo.findById(WS, (fx.db.prepare('SELECT id FROM provider_sessions').get() as { id: string }).id);
      assert.equal(session?.status, 'completed');
      const process = fx.processRepo.findById(WS, (fx.db.prepare('SELECT id FROM runtime_processes').get() as { id: string }).id);
      assert.equal(process?.status, 'exited');
      const eventCount = (fx.db.prepare('SELECT COUNT(*) AS c FROM runtime_events WHERE run_id = ?').get(RUN) as { c: number }).c;
      const outboxCount = (fx.db.prepare('SELECT COUNT(*) AS c FROM outbox_messages WHERE aggregate_id = ?').get(RUN) as { c: number }).c;
      assert.equal(outboxCount, eventCount);
      assert.ok(eventCount > 0);
    } finally {
      close(fx);
    }
  });

  it('fails closed before claim when authentication is required', async () => {
    const fx = fixture(new FakeDriver(new FakeHandle([])), true);
    try {
      const outcome = await fx.coordinator.execute(stageInput());
      assert.equal(outcome.kind, 'failed');
      if (outcome.kind !== 'failed') return;
      assert.equal(outcome.problem.code, 'PROVIDER_AUTH_REQUIRED');
      assert.equal((fx.db.prepare('SELECT COUNT(*) AS c FROM provider_sessions').get() as { c: number }).c, 0);
      assert.equal((fx.db.prepare('SELECT COUNT(*) AS c FROM runtime_processes').get() as { c: number }).c, 0);
      assert.equal((fx.driver as unknown as { spawnCalls: number }).spawnCalls, 0);
    } finally {
      close(fx);
    }
  });

  it('compensates spawn failure durably and never spawns twice', async () => {
    const fx = fixture(new FakeDriver(null, new Error('spawn boom')));
    try {
      const outcome = await fx.coordinator.execute(stageInput());
      assert.equal(outcome.kind, 'failed');
      if (outcome.kind !== 'failed') return;
      assert.equal(outcome.problem.code, 'PROVIDER_START_FAILED');
      assert.equal((fx.driver as unknown as { spawnCalls: number }).spawnCalls, 1);
      const process = fx.processRepo.findById(WS, (fx.db.prepare('SELECT id FROM runtime_processes').get() as { id: string }).id);
      assert.equal(process?.status, 'failed');
      const session = fx.sessionRepo.findById(WS, (fx.db.prepare('SELECT id FROM provider_sessions').get() as { id: string }).id);
      assert.equal(session?.status, 'failed');
    } finally {
      close(fx);
    }
  });

  it('maps non-zero exit to a stable Provider failure with exited Process evidence', async () => {
    const fx = fixture(new FakeDriver(new FakeHandle(['{"type":"assistant","role":"assistant","content":"partial"}\n'], 1)));
    try {
      const outcome = await fx.coordinator.execute(stageInput());
      assert.equal(outcome.kind, 'failed');
      if (outcome.kind !== 'failed') return;
      assert.equal(outcome.problem.code, 'PROVIDER_SESSION_FAILED');
      const process = fx.processRepo.findById(WS, (fx.db.prepare('SELECT id FROM runtime_processes').get() as { id: string }).id);
      assert.equal(process?.status, 'exited');
      assert.equal(process?.terminationReason, 'non-zero-exit');
    } finally {
      close(fx);
    }
  });

  it('fails finalize on malformed structured output', async () => {
    const fx = fixture(new FakeDriver(new FakeHandle(['not-json\n'])));
    try {
      const outcome = await fx.coordinator.execute(stageInput());
      assert.equal(outcome.kind, 'failed');
      if (outcome.kind !== 'failed') return;
      assert.equal(outcome.problem.code, 'PROVIDER_OUTPUT_PARSE_FAILED');
    } finally {
      close(fx);
    }
  });

  it('duplicate concurrent dispatch joins the same claim and never spawns a second Process', async () => {
    const fx = fixture(new FakeDriver(new FakeHandle(['{"type":"assistant","role":"assistant","content":"ok"}\n'])));
    try {
      const [first, second] = await Promise.all([
        fx.coordinator.execute(stageInput()),
        fx.coordinator.execute(stageInput()),
      ]);
      assert.equal(first.kind, 'completed');
      assert.equal(second.kind, 'active');
      assert.equal((fx.driver as unknown as { spawnCalls: number }).spawnCalls, 1);
      assert.equal((fx.db.prepare('SELECT COUNT(*) AS c FROM provider_sessions').get() as { c: number }).c, 1);
      assert.equal((fx.db.prepare('SELECT COUNT(*) AS c FROM runtime_processes').get() as { c: number }).c, 1);
    } finally {
      close(fx);
    }
  });

  it('HIGH-1: real child floods stderr while stdout stays open -> concurrent drain completes', { timeout: 60000 }, async () => {
    const script = "const b = Buffer.alloc(1048576, 120); process.stderr.write(b, () => { process.stdout.end('{\"type\":\"assistant\",\"role\":\"assistant\",\"content\":\"ok\"}\\n', () => process.exit(0)); });";
    const fx = fixture(new NodeProcessDriver());
    try {
      let timeoutHandle: NodeJS.Timeout | undefined;
      const outcome = await Promise.race([
        fx.coordinator.execute(stageInput({ providerSnapshot: { ...providerSnapshot(), executable: process.execPath, argsTemplate: ['-e', script, '--'] }, workspaceRoot: fx.root })),
        new Promise<string>(resolve => { timeoutHandle = setTimeout(() => resolve('TIMEOUT-30s'), 30000); }),
      ]);
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      assert.notEqual(outcome, 'TIMEOUT-30s');
      assert.equal((outcome as StageExecutionOutcome).kind, 'completed');
    } finally { close(fx); }
  });

  it('HIGH-2: split UTF-8 matrix preserves exact assistant text and raw artifact bytes', async () => {
    const { readFileSync } = await import('node:fs');
    const content = '\u4f60\u597d';
    const line = '{"type":"assistant","role":"assistant","content":"' + content + '"}\n';
    const bytes = new TextEncoder().encode(line);
    for (let split = 1; split < bytes.length; split += 1) {
      const fx = fixture(new FakeDriver(new FakeByteHandle([bytes.slice(0, split), bytes.slice(split)])));
      try {
        const outcome = await fx.coordinator.execute(stageInput());
        assert.equal(outcome.kind, 'completed', 'split at ' + split);
        if (outcome.kind !== 'completed') continue;
        assert.equal(outcome.output, content, 'exact text at split ' + split);
        assert.equal((outcome.output ?? '').includes('\uFFFD'), false, 'no replacement at split ' + split);
        const row = fx.db.prepare("SELECT storage_key FROM process_output_references WHERE stream = 'stdout'").get() as { storage_key: string };
        const raw = readFileSync(join(fx.root, 'sink', row.storage_key));
        assert.deepEqual([...raw], [...bytes], 'raw bytes at split ' + split);
      } finally { close(fx); }
    }
  });

  it('MEDIUM-2: output finalize failure fails the stage closed instead of reporting completed', async () => {
    const fx = fixture(new FakeDriver(new FakeHandle(['{"type":"assistant","role":"assistant","content":"ok"}\n'])), { outputAdapterFactory: repo => new FinalizeFailOutputAdapter(repo) });
    try {
      const outcome = await fx.coordinator.execute(stageInput());
      assert.equal(outcome.kind, 'failed');
      if (outcome.kind !== 'failed') return;
      assert.equal(outcome.problem.code, 'PROVIDER_INTERNAL_ERROR');
      assert.equal(outcome.phase, 'runtime');
    } finally { close(fx); }
  });

  it('HIGH-3A: immediate exit cannot race ahead of durable Session active persistence', async () => {
    const fx = fixture(new FakeDriver(new FakeHandle(['{"type":"assistant","role":"assistant","content":"ok"}\n'])), { sessionAdapterFactory: repo => new SlowSessionAdapter(repo) });
    try {
      const outcome = await fx.coordinator.execute(stageInput());
      assert.equal(outcome.kind, 'completed');
      const session = fx.sessionRepo.findById(WS, (fx.db.prepare('SELECT id FROM provider_sessions').get() as { id: string }).id);
      assert.equal(session?.status, 'completed');
    } finally { close(fx); }
  });

  it('HIGH-3D: terminal Session CAS failure fails closed and never reports completed', async () => {
    const fx = fixture(new FakeDriver(new FakeHandle(['{"type":"assistant","role":"assistant","content":"ok"}\n'])), { sessionAdapterFactory: repo => new TerminalFailSessionAdapter(repo) });
    try {
      const outcome = await fx.coordinator.execute(stageInput());
      assert.notEqual(outcome.kind, 'completed');
    } finally { close(fx); }
  });

  it('P5C-01/P5C-02 persists the full frozen timeout policy and omits disabled deadlines', async () => {
    const driver = new ControlledExitDriver();
    const fx = fixture(driver);
    const base = providerSnapshot();
    const execution = fx.coordinator.execute(stageInput({
      providerSnapshot: {
        ...base,
        timeoutPolicy: {
          ...base.timeoutPolicy,
          startupTimeoutMs: 11,
          idleTimeoutMs: 22,
          totalTimeoutMs: 33,
          cancelGracePeriodMs: 44,
        },
      },
    }));
    try {
      await driver.handle.waitExitEntered.promise;
      const process = fx.processRepo.findByRootClaim(WS, RUN, STAGE, 1, 'primary-provider');
      assert.ok(process);
      assert.deepEqual(JSON.parse(process.timeoutPolicyJson), {
        startupMs: 11,
        idleMs: 22,
        totalMs: 33,
        graceMs: 44,
      });
      driver.handle.releaseExit();
      assert.equal((await execution).kind, 'completed');
    } finally {
      driver.handle.releaseExit();
      await Promise.allSettled([execution]);
      close(fx);
    }

    const disabledDriver = new ControlledExitDriver();
    const disabledFx = fixture(disabledDriver);
    const disabledBase = providerSnapshot();
    const disabledExecution = disabledFx.coordinator.execute(stageInput({
      providerSnapshot: {
        ...disabledBase,
        timeoutPolicy: {
          ...disabledBase.timeoutPolicy,
          startupTimeoutMs: 12,
          idleTimeoutMs: null,
          totalTimeoutMs: null,
          cancelGracePeriodMs: 45,
        },
      },
    }));
    try {
      await disabledDriver.handle.waitExitEntered.promise;
      const process = disabledFx.processRepo.findByRootClaim(WS, RUN, STAGE, 1, 'primary-provider');
      assert.ok(process);
      assert.deepEqual(JSON.parse(process.timeoutPolicyJson), {
        startupMs: 12,
        graceMs: 45,
      });
      disabledDriver.handle.releaseExit();
      assert.equal((await disabledExecution).kind, 'completed');
    } finally {
      disabledDriver.handle.releaseExit();
      await Promise.allSettled([disabledExecution]);
      close(disabledFx);
    }
  });

  it('P5C-03/P5C-04 arms after native start and disarms startup at accepted Session active', async () => {
    const clock = new FakeClock();
    const driver = new SpawnGateDriver();
    const fx = fixture(driver, {
      clock,
      adapter: new RecordingKimiAdapter({
        probe: probeFor(false),
        discover: async () => ({ found: true, selected: KIMI_EXE, candidates: [{ executable: KIMI_EXE, source: 'configuration', confidence: 1 }], warnings: [] }),
      }),
    });
    const base = providerSnapshot();
    const execution = fx.coordinator.execute(stageInput({
      providerSnapshot: {
        ...base,
        timeoutPolicy: {
          ...base.timeoutPolicy,
          startupTimeoutMs: 100,
          idleTimeoutMs: 200,
          totalTimeoutMs: 300,
        },
      },
    }));
    try {
      await driver.spawnEntered.promise;
      assert.equal(clock.pendingCount, 0);
      driver.releaseSpawn.resolve(undefined);
      await driver.handle.waitExitEntered.promise;
      assert.equal(clock.pendingCount, 2);
      clock.advance(100);
      assert.equal(fx.processRepo.findByRootClaim(WS, RUN, STAGE, 1, 'primary-provider')?.status, 'running');
      driver.handle.releaseExit();
      assert.equal((await execution).kind, 'completed');
      assert.equal(clock.pendingCount, 0);
      clock.advance(10_000);
      assert.equal(driver.gracefulStopCalls, 0);
    } finally {
      driver.releaseSpawn.resolve(undefined);
      driver.handle.releaseExit();
      await Promise.allSettled([execution]);
      close(fx);
    }
  });

  it('P5C-09 startup timeout fires before Session active and maps to non-cancelled start failure', async () => {
    const clock = new FakeClock();
    const driver = new ControlledExitDriver();
    let sessionAdapter!: BlockingActiveSessionAdapter;
    const adapter = new RecordingKimiAdapter({
      probe: probeFor(false),
      discover: async () => ({ found: true, selected: KIMI_EXE, candidates: [{ executable: KIMI_EXE, source: 'configuration', confidence: 1 }], warnings: [] }),
    });
    const fx = fixture(driver, {
      clock,
      adapter,
      sessionAdapterFactory: repo => {
        sessionAdapter = new BlockingActiveSessionAdapter(repo);
        return sessionAdapter;
      },
    });
    const base = providerSnapshot();
    const execution = fx.coordinator.execute(stageInput({
      providerSnapshot: {
        ...base,
        timeoutPolicy: { ...base.timeoutPolicy, startupTimeoutMs: 100, idleTimeoutMs: null, totalTimeoutMs: null },
      },
    }));
    try {
      await sessionAdapter.activeEntered.promise;
      assert.equal(clock.pendingCount, 1);
      clock.advance(99);
      assert.equal(fx.processRepo.findByRootClaim(WS, RUN, STAGE, 1, 'primary-provider')?.status, 'running');
      clock.advance(1);
      await flushObservationChain();
      assert.equal(fx.processRepo.findByRootClaim(WS, RUN, STAGE, 1, 'primary-provider')?.status, 'stopping');
      sessionAdapter.releaseActive.resolve(undefined);
      driver.handle.releaseExit();
      const outcome = await execution;
      assert.equal(outcome.kind, 'failed');
      if (outcome.kind === 'failed') assert.equal(outcome.problem.code, 'PROVIDER_START_FAILED');
      assert.equal(adapter.finalizedInputs.length, 1);
      assert.equal(adapter.finalizedInputs[0]?.cancelled, false);
      assert.deepEqual((adapter.finalizedInputs[0] as unknown as { providerError: { code: string; phase: string } }).providerError, {
        code: 'PROVIDER_START_FAILED',
        phase: 'startup',
        retryable: false,
        message: 'Provider process could not start before timeout',
      });
      assert.equal(fx.processRepo.findByRootClaim(WS, RUN, STAGE, 1, 'primary-provider')?.terminationReason, 'PROCESS_STARTUP_TIMEOUT');
    } finally {
      sessionAdapter?.releaseActive.resolve(undefined);
      driver.handle.releaseExit();
      await Promise.allSettled([execution]);
      close(fx);
    }
  });

  it('P5C-05/P5C-06/P5C-07 approval observation anchors, pauses, resumes, and times out through the stop authority', async () => {
    const clock = new FakeClock();
    const observation = new FakeObservationPort();
    const driver = new ControlledExitDriver();
    const fx = fixture(driver, { clock, observation });
    const base = providerSnapshot();
    const execution = fx.coordinator.execute(stageInput({
      providerSnapshot: {
        ...base,
        timeoutPolicy: {
          ...base.timeoutPolicy,
          startupTimeoutMs: 1000,
          idleTimeoutMs: 200,
          totalTimeoutMs: 500,
        },
      },
    }));
    try {
      await driver.handle.waitExitEntered.promise;
      assert.equal(observation.afterSequence, 0);
      const preAnchorRequired = runtimeEvent('approval.required', 1, {
        stageId: STAGE,
        approvalRequestId: 'approval_pre_anchor',
        payload: { category: 'network', riskLevel: 'low', title: 'pre', description: 'pre', requestSummary: {} },
      });
      observation.emit(preAnchorRequired);
      await flushObservationChain();
      assert.equal(fx.processRepo.findByRootClaim(WS, RUN, STAGE, 1, 'primary-provider')?.status, 'running');

      observation.emit(runtimeEvent('stage.started', 2, { payload: { attempt: 1 } }));
      observation.emit(runtimeEvent('approval.required', 3, {
        approvalRequestId: 'approval_1',
        payload: { category: 'network', riskLevel: 'low', title: 'request', description: 'request', requestSummary: {} },
      }));
      await flushObservationChain();
      const waiting = fx.processRepo.findByRootClaim(WS, RUN, STAGE, 1, 'primary-provider');
      assert.equal(waiting?.status, 'waiting');
      const waitingVersion = waiting?.version;
      observation.emit(runtimeEvent('approval.required', 4, {
        approvalRequestId: 'approval_1',
        payload: { category: 'network', riskLevel: 'low', title: 'duplicate', description: 'duplicate', requestSummary: {} },
      }));
      await flushObservationChain();
      assert.equal(fx.processRepo.findByRootClaim(WS, RUN, STAGE, 1, 'primary-provider')?.version, waitingVersion);

      clock.advance(50);
      observation.emit(runtimeEvent('approval.resolved', 5, {
        approvalRequestId: 'approval_1',
        payload: { decision: 'approve_once', decidedBy: 'test', decidedAt: NOW },
      }));
      await flushObservationChain();
      assert.equal(fx.processRepo.findByRootClaim(WS, RUN, STAGE, 1, 'primary-provider')?.status, 'running');

      clock.advance(199);
      assert.equal(fx.processRepo.findByRootClaim(WS, RUN, STAGE, 1, 'primary-provider')?.status, 'running');
      clock.advance(1);
      driver.handle.releaseExit();
      const outcome = await execution;
      assert.equal(outcome.kind, 'failed');
      if (outcome.kind === 'failed') assert.equal(outcome.problem.code, 'PROVIDER_SESSION_FAILED');
      assert.equal(driver.gracefulStopCalls, 1);
      assert.equal(fx.processRepo.findByRootClaim(WS, RUN, STAGE, 1, 'primary-provider')?.terminationReason, 'PROCESS_IDLE_TIMEOUT');
      assert.equal(observation.unsubscribeCalls, 1);
    } finally {
      driver.handle.releaseExit();
      await Promise.allSettled([execution]);
      close(fx);
    }
  });

  it('P5C-05/P5C-06 each accepted stdout/stderr checkpoint resets the full idle budget', async () => {
    for (const activeStream of ['stdout', 'stderr'] as const) {
      const clock = new FakeClock();
      const handle = new GatedOutputHandle(
        activeStream === 'stdout' ? '{"type":"assistant","role":"assistant","content":"ok"}\n' : '',
        activeStream === 'stderr' ? 'diagnostic\n' : '',
      );
      const driver = new FakeDriver(handle);
      const adapter = new RecordingKimiAdapter({
        probe: probeFor(false),
        discover: async () => ({ found: true, selected: KIMI_EXE, candidates: [{ executable: KIMI_EXE, source: 'configuration', confidence: 1 }], warnings: [] }),
      });
      let outputAdapter!: CheckpointProbeAdapter;
      const fx = fixture(driver, {
        clock,
        adapter,
        outputAdapterFactory: repo => {
          outputAdapter = new CheckpointProbeAdapter(repo);
          return outputAdapter;
        },
      });
      const base = providerSnapshot();
      const execution = fx.coordinator.execute(stageInput({
        providerSnapshot: {
          ...base,
          timeoutPolicy: { ...base.timeoutPolicy, startupTimeoutMs: 1000, idleTimeoutMs: 200, totalTimeoutMs: 1000 },
        },
      }));
      try {
        await Promise.all([handle.stdoutReady.promise, handle.stderrReady.promise]);
        clock.advance(100);
        handle.releaseOutput();
        await outputAdapter.checkpointed.promise;
        await flushObservationChain();
        clock.advance(99);
        assert.equal(fx.processRepo.findByRootClaim(WS, RUN, STAGE, 1, 'primary-provider')?.status, 'running', activeStream);
        clock.advance(1);
        await flushObservationChain();
        assert.equal(fx.processRepo.findByRootClaim(WS, RUN, STAGE, 1, 'primary-provider')?.status, 'running', activeStream);
        clock.advance(100);
        await flushObservationChain();
        assert.equal(fx.processRepo.findByRootClaim(WS, RUN, STAGE, 1, 'primary-provider')?.status, 'stopping', activeStream);
        handle.releaseExit();
        const outcome = await execution;
        assert.equal(outcome.kind, 'failed', activeStream);
        if (outcome.kind === 'failed') assert.equal(outcome.problem.code, 'PROVIDER_SESSION_FAILED', activeStream);
      } finally {
        handle.releaseOutput();
        handle.releaseExit();
        await Promise.allSettled([execution]);
        close(fx);
      }
    }
  });

  it('OBS-14/OBS-18 observer failure and newer-attempt fencing make no guessed timer transition', async () => {
    for (const mode of ['failure', 'newer-attempt'] as const) {
      const clock = new FakeClock();
      const observation = new FakeObservationPort();
      const driver = new ControlledExitDriver();
      const fx = fixture(driver, { clock, observation });
      const base = providerSnapshot();
      const execution = fx.coordinator.execute(stageInput({
        providerSnapshot: {
          ...base,
          timeoutPolicy: { ...base.timeoutPolicy, startupTimeoutMs: 1000, idleTimeoutMs: 200, totalTimeoutMs: 1000 },
        },
      }));
      try {
        await driver.handle.waitExitEntered.promise;
        observation.emit(runtimeEvent('stage.started', 1, { payload: { attempt: mode === 'newer-attempt' ? 2 : 1 } }));
        await flushObservationChain();
        if (mode === 'failure') observation.fail();
        await flushObservationChain();
        assert.equal(observation.unsubscribeCalls, 1);
        assert.equal(fx.processRepo.findByRootClaim(WS, RUN, STAGE, 1, 'primary-provider')?.status, 'running');
        if (mode === 'failure') {
          observation.emit(runtimeEvent('approval.required', 2, {
            approvalRequestId: 'approval_after_failure',
            payload: { category: 'network', riskLevel: 'low', title: 'ignored', description: 'ignored', requestSummary: {} },
          }));
          await flushObservationChain();
          assert.equal(fx.processRepo.findByRootClaim(WS, RUN, STAGE, 1, 'primary-provider')?.status, 'running');
        }
        driver.handle.releaseExit();
        assert.equal((await execution).kind, 'completed');
      } finally {
        driver.handle.releaseExit();
        await Promise.allSettled([execution]);
        close(fx);
      }
    }
  });

  it('OBS-11/OBS-12/OBS-13 rejects non-resuming decisions and mismatched approval ids', async () => {
    const clock = new FakeClock();
    const observation = new FakeObservationPort();
    const driver = new ControlledExitDriver();
    const fx = fixture(driver, { clock, observation });
    const base = providerSnapshot();
    const execution = fx.coordinator.execute(stageInput({
      providerSnapshot: {
        ...base,
        timeoutPolicy: { ...base.timeoutPolicy, startupTimeoutMs: 1000, idleTimeoutMs: 200, totalTimeoutMs: 1000 },
      },
    }));
    try {
      await driver.handle.waitExitEntered.promise;
      observation.emit(runtimeEvent('stage.started', 1, { payload: { attempt: 1 } }));
      observation.emit(runtimeEvent('approval.required', 2, {
        approvalRequestId: 'approval_1',
        payload: { category: 'network', riskLevel: 'low', title: 'request', description: 'request', requestSummary: {} },
      }));
      await flushObservationChain();
      assert.equal(fx.processRepo.findByRootClaim(WS, RUN, STAGE, 1, 'primary-provider')?.status, 'waiting');

      observation.emit(runtimeEvent('approval.resolved', 3, {
        approvalRequestId: 'approval_other',
        payload: { decision: 'approve_once', decidedBy: 'test', decidedAt: NOW },
      }));
      await flushObservationChain();
      assert.equal(fx.processRepo.findByRootClaim(WS, RUN, STAGE, 1, 'primary-provider')?.status, 'waiting');

      observation.emit(runtimeEvent('approval.resolved', 4, {
        approvalRequestId: 'approval_1',
        payload: { decision: 'reject', decidedBy: 'test', decidedAt: NOW },
      }));
      await flushObservationChain();
      assert.equal(fx.processRepo.findByRootClaim(WS, RUN, STAGE, 1, 'primary-provider')?.status, 'waiting');

      const cancel = fx.coordinator.cancelAttempt({
        workspaceId: WS,
        runId: RUN,
        stageId: STAGE,
        stageAttempt: 1,
        correlationId: 'approval-cancel',
        causationId: 'approval-cancel',
      });
      driver.handle.releaseExit();
      const cancelled = await cancel;
      assert.equal(cancelled.kind, 'stopped', JSON.stringify(cancelled));
      await execution;
    } finally {
      driver.handle.releaseExit();
      await Promise.allSettled([execution]);
      close(fx);
    }
  });

  it('OBS-07 conflicting approval requests fail closed without a second pause', async () => {
    const clock = new FakeClock();
    const observation = new FakeObservationPort();
    const driver = new ControlledExitDriver();
    const fx = fixture(driver, { clock, observation });
    const base = providerSnapshot();
    const execution = fx.coordinator.execute(stageInput({
      providerSnapshot: {
        ...base,
        timeoutPolicy: { ...base.timeoutPolicy, startupTimeoutMs: 1000, idleTimeoutMs: 200, totalTimeoutMs: 1000 },
      },
    }));
    try {
      await driver.handle.waitExitEntered.promise;
      observation.emit(runtimeEvent('stage.started', 1, { payload: { attempt: 1 } }));
      observation.emit(runtimeEvent('approval.required', 2, {
        approvalRequestId: 'approval_1',
        payload: { category: 'network', riskLevel: 'low', title: 'request', description: 'request', requestSummary: {} },
      }));
      await flushObservationChain();
      assert.equal(fx.processRepo.findByRootClaim(WS, RUN, STAGE, 1, 'primary-provider')?.status, 'waiting');
      observation.emit(runtimeEvent('approval.required', 3, {
        approvalRequestId: 'approval_2',
        payload: { category: 'network', riskLevel: 'low', title: 'conflict', description: 'conflict', requestSummary: {} },
      }));
      await flushObservationChain();
      assert.equal(observation.unsubscribeCalls, 1);
      assert.equal(fx.processRepo.findByRootClaim(WS, RUN, STAGE, 1, 'primary-provider')?.status, 'waiting');

      const cancel = fx.coordinator.cancelAttempt({
        workspaceId: WS, runId: RUN, stageId: STAGE, stageAttempt: 1,
        correlationId: 'approval-conflict-cancel', causationId: 'approval-conflict-cancel',
      });
      driver.handle.releaseExit();
      assert.equal((await cancel).kind, 'stopped');
      await execution;
    } finally {
      driver.handle.releaseExit();
      await Promise.allSettled([execution]);
      close(fx);
    }
  });

  it('P5C-16 explicit cancel wins before idle timeout without a second stop or finalize', async () => {
    const clock = new FakeClock();
    const driver = new ControlledExitDriver();
    let processAdapter!: BlockingStoppingProcessAdapter;
    const adapter = new RecordingKimiAdapter({
      probe: probeFor(false),
      discover: async () => ({ found: true, selected: KIMI_EXE, candidates: [{ executable: KIMI_EXE, source: 'configuration', confidence: 1 }], warnings: [] }),
    });
    const fx = fixture(driver, {
      clock,
      adapter,
      processAdapterFactory: repo => {
        processAdapter = new BlockingStoppingProcessAdapter(repo);
        return processAdapter;
      },
    });
    const base = providerSnapshot();
    const execution = fx.coordinator.execute(stageInput({
      providerSnapshot: { ...base, timeoutPolicy: { ...base.timeoutPolicy, startupTimeoutMs: 1000, idleTimeoutMs: 100, totalTimeoutMs: 500 } },
    }));
    let cancel!: Promise<StageExecutionOutcome>;
    try {
      await driver.handle.waitExitEntered.promise;
      cancel = fx.coordinator.cancelAttempt({
        workspaceId: WS, runId: RUN, stageId: STAGE, stageAttempt: 1,
        correlationId: 'explicit-first', causationId: 'explicit-first',
      });
      await processAdapter.stoppingEntered.promise;
      clock.advance(1000);
      processAdapter.releaseStopping();
      driver.handle.releaseExit();
      const [cancelled, executed] = await Promise.all([cancel, execution]);
      assert.strictEqual(cancelled, executed);
      assert.equal(cancelled.kind, 'stopped');
      assert.equal(adapter.finalizedInputs.length, 1);
      assert.equal(adapter.cancelInputs[0]?.reason, 'cancel');
      assert.equal(adapter.finalizedInputs[0]?.cancelled, true);
      assert.equal(fx.processRepo.findByRootClaim(WS, RUN, STAGE, 1, 'primary-provider')?.terminationReason, 'cancel');
    } finally {
      processAdapter?.releaseStopping();
      driver.handle.releaseExit();
      await Promise.allSettled([execution, ...(cancel === undefined ? [] : [cancel])]);
      close(fx);
    }
  });

  it('P5C-15/P5C-16 idle timeout wins before explicit cancel and finalizes once as provider failure', async () => {
    const clock = new FakeClock();
    const driver = new ControlledExitDriver();
    const adapter = new RecordingKimiAdapter({
      probe: probeFor(false),
      discover: async () => ({ found: true, selected: KIMI_EXE, candidates: [{ executable: KIMI_EXE, source: 'configuration', confidence: 1 }], warnings: [] }),
    });
    const fx = fixture(driver, { clock, adapter });
    const base = providerSnapshot();
    const execution = fx.coordinator.execute(stageInput({
      providerSnapshot: { ...base, timeoutPolicy: { ...base.timeoutPolicy, startupTimeoutMs: 1000, idleTimeoutMs: 100, totalTimeoutMs: 500 } },
    }));
    let cancel!: Promise<StageExecutionOutcome>;
    try {
      await driver.handle.waitExitEntered.promise;
      clock.advance(100);
      await flushObservationChain();
      assert.equal(fx.processRepo.findByRootClaim(WS, RUN, STAGE, 1, 'primary-provider')?.status, 'stopping');
      cancel = fx.coordinator.cancelAttempt({
        workspaceId: WS, runId: RUN, stageId: STAGE, stageAttempt: 1,
        correlationId: 'timeout-first', causationId: 'timeout-first',
      });
      driver.handle.releaseExit();
      const [timedOut, joined] = await Promise.all([execution, cancel]);
      assert.strictEqual(timedOut, joined);
      assert.equal(timedOut.kind, 'failed');
      if (timedOut.kind === 'failed') assert.equal(timedOut.problem.code, 'PROVIDER_SESSION_FAILED');
      assert.equal(adapter.finalizedInputs.length, 1);
      assert.equal(adapter.cancelInputs[0]?.reason, 'IDLE_TIMEOUT');
      assert.equal(adapter.finalizedInputs[0]?.cancelled, false);
      assert.equal(fx.processRepo.findByRootClaim(WS, RUN, STAGE, 1, 'primary-provider')?.terminationReason, 'PROCESS_IDLE_TIMEOUT');
    } finally {
      driver.handle.releaseExit();
      await Promise.allSettled([execution, ...(cancel === undefined ? [] : [cancel])]);
      close(fx);
    }
  });

  it('P5C-08/OBS-19 total timeout continues while approval waiting pauses only idle', async () => {
    const clock = new FakeClock();
    const observation = new FakeObservationPort();
    const driver = new ControlledExitDriver();
    const fx = fixture(driver, { clock, observation });
    const base = providerSnapshot();
    const execution = fx.coordinator.execute(stageInput({
      providerSnapshot: {
        ...base,
        timeoutPolicy: { ...base.timeoutPolicy, startupTimeoutMs: 1000, idleTimeoutMs: 100, totalTimeoutMs: 300 },
      },
    }));
    try {
      await driver.handle.waitExitEntered.promise;
      observation.emit(runtimeEvent('stage.started', 1, { payload: { attempt: 1 } }));
      observation.emit(runtimeEvent('approval.required', 2, {
        approvalRequestId: 'approval_total',
        payload: { category: 'network', riskLevel: 'low', title: 'request', description: 'request', requestSummary: {} },
      }));
      await flushObservationChain();
      assert.equal(fx.processRepo.findByRootClaim(WS, RUN, STAGE, 1, 'primary-provider')?.status, 'waiting');
      clock.advance(299);
      assert.equal(fx.processRepo.findByRootClaim(WS, RUN, STAGE, 1, 'primary-provider')?.status, 'waiting');
      clock.advance(1);
      await flushObservationChain();
      assert.equal(fx.processRepo.findByRootClaim(WS, RUN, STAGE, 1, 'primary-provider')?.status, 'stopping');
      driver.handle.releaseExit();
      const outcome = await execution;
      assert.equal(outcome.kind, 'failed');
      if (outcome.kind === 'failed') assert.equal(outcome.problem.code, 'PROVIDER_SESSION_FAILED');
      assert.equal(fx.processRepo.findByRootClaim(WS, RUN, STAGE, 1, 'primary-provider')?.terminationReason, 'PROCESS_TOTAL_TIMEOUT');
    } finally {
      driver.handle.releaseExit();
      await Promise.allSettled([execution]);
      close(fx);
    }
  });

  it('MEDIUM-1B: concurrent identical execute coalesces validation to 1/1/1 and keeps exactly-one Session/Process/spawn', async () => {
    const cp = countingProbe();
    const driver = new FakeDriver(new FakeHandle(['{"type":"assistant","role":"assistant","content":"ok"}\n']));
    const fx = fixture(driver, { probe: cp.probe });
    try {
      const [a, b] = await Promise.all([fx.coordinator.execute(stageInput()), fx.coordinator.execute(stageInput())]);
      assert.equal(cp.counts.version, 1);
      assert.equal(cp.counts.help, 1);
      assert.equal(cp.counts.auth, 1);
      assert.equal(driver.spawnCalls, 1);
      assert.equal((fx.db.prepare('SELECT COUNT(*) AS c FROM provider_sessions').get() as { c: number }).c, 1);
      assert.equal((fx.db.prepare('SELECT COUNT(*) AS c FROM runtime_processes').get() as { c: number }).c, 1);
      assert.deepEqual([a.kind, b.kind].sort(), ['active', 'completed']);
    } finally { close(fx); }
  });});
