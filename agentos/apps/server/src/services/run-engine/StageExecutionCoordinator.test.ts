import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createM3RuntimeEventRegistry, type AgentSnapshotV1, type ProviderConfigurationSnapshotV1 } from '@agentos/shared';
import {
  DurableProcessCoordinator,
  FileArtifactSink,
  NodeProcessDriver,
  type ExitEvidence,
  type NativeIdentity,
  type NativeProcessHandle,
  type NativeProcessStreams,
  type PlatformProcessDriver,
  type SurvivorVerification,
  type TreeTerminationResult,
} from '@agentos/process-runtime';
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

class FakeDriver implements PlatformProcessDriver {
  spawnCalls = 0;
  constructor(private readonly handle: FakeHandle | FakeByteHandle | null, private readonly spawnError?: Error) {}
  async spawn() { this.spawnCalls += 1; if (this.spawnError !== undefined) throw this.spawnError; return this.handle!; }
  gracefulStop = async () => ({ delivered: true, detail: 'ok' });
  terminateTree = async (): Promise<TreeTerminationResult> => ({ classification: 'complete', attemptedMembers: [], errors: [] });
  verifySurvivors = async (): Promise<SurvivorVerification> => ({ classification: 'complete', knownPids: [] });
  inspectIdentity = async (identity: NativeIdentity): Promise<{ kind: 'match'; identity: NativeIdentity }> => ({ kind: 'match', identity });
}

interface FixtureOptions {
  readonly authFailure?: boolean;
  readonly probe?: ProcessProbePort;
  readonly sessionAdapterFactory?: (repo: ProviderSessionRepository) => DurableSessionRepositoryAdapter;
  readonly outputAdapterFactory?: (repo: ProcessOutputReferenceRepository) => DurableOutputReferenceRepositoryAdapter;
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
  const processRepo = new ProcessRepository(db, factWriter);
  const outputRepo = new ProcessOutputReferenceRepository(db, factWriter);
  const seam = new DurableAtomicSeamImpl(db, sessionRepo, processRepo);
  const sessionAdapter = opts.sessionAdapterFactory === undefined ? new DurableSessionRepositoryAdapter(sessionRepo) : opts.sessionAdapterFactory(sessionRepo);
  const processAdapter = new DurableProcessRepositoryAdapter(processRepo);
  const outputAdapter = opts.outputAdapterFactory === undefined ? new DurableOutputReferenceRepositoryAdapter(outputRepo) : opts.outputAdapterFactory(outputRepo);
  const durableCoordinator = new DurableProcessCoordinator({
    sessionRepository: sessionAdapter,
    processRepository: processAdapter,
    outputReferenceRepository: outputAdapter,
    artifactSink: new FileArtifactSink(join(root, 'sink')),
    atomicSeam: seam,
    driver,
  });
  const adapter = new KimiCodeProviderAdapter({
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
  });
  return { db, root, events, outbox, sessionRepo, processRepo, outputRepo, coordinator, driver, adapter };
}

function close(fx: ReturnType<typeof fixture>): void {
  fx.db.close();
  rmSync(fx.root, { recursive: true, force: true });
}

class SlowSessionAdapter extends DurableSessionRepositoryAdapter {
  async casSessionTransition(input: Parameters<DurableSessionRepositoryAdapter['casSessionTransition']>[0]) {
    if (input.to === 'active') await new Promise(resolve => setTimeout(resolve, 250));
    return super.casSessionTransition(input);
  }
}

class FinalizeFailOutputAdapter extends DurableOutputReferenceRepositoryAdapter {
  async finalizeReference(_input: Parameters<DurableOutputReferenceRepositoryAdapter['finalizeReference']>[0]) {
    return { kind: 'not-found' as const };
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