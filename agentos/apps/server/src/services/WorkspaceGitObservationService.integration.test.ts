import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  promises as nodeFs,
  realpathSync,
  type Dirent,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GIT_COMMAND_EXECUTION_CONTRACT_V1,
  type GitObservationRuntimeEventContextAuthorityV1,
} from '@agentos/shared';
import { SqliteStore } from '../store/SqliteStore.js';
import { WorkspaceGitObservationRepository } from '../store/WorkspaceGitObservationRepository.js';
import { GIT_COMMAND_CLEANUP_UNPROVEN_MESSAGE } from './GitCommandAdapter.js';
import { GitObservationCollector } from './GitObservationCollector.js';
import { GitObservationPersistenceService } from './GitObservationPersistenceService.js';
import {
  WorkspaceGitObservationService,
  WorkspaceGitObservationServiceError,
  createWorkspaceGitObservationService,
} from './WorkspaceGitObservationService.js';

const NOW = '2026-09-03T00:00:00.000Z';

interface Fixture {
  readonly root: string;
  readonly projectRoot: string;
  readonly workspaceRoot: string;
  readonly store: SqliteStore;
  readonly observations: WorkspaceGitObservationRepository;
  close(): Promise<void>;
}

interface DurableCounts {
  readonly observations: number;
  readonly artifacts: number;
  readonly events: number;
  readonly outbox: number;
}

const DENY_ALL_AUTHORITY: GitObservationRuntimeEventContextAuthorityV1 = {
  authorize(): never {
    throw new Error('M4_TEST_CANONICAL_AUTHORITY_DENIED');
  },
};

async function makeWritableRecursive(target: string): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await nodeFs.readdir(target, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const child = join(target, entry.name);
    if (entry.isDirectory()) await makeWritableRecursive(child);
    try {
      await nodeFs.chmod(child, 0o777);
    } catch {
      // Best effort; the awaited removal below remains authoritative.
    }
  }
}

async function removeTreeRobust(target: string): Promise<void> {
  try {
    await nodeFs.rm(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  } catch {
    await makeWritableRecursive(target);
    await nodeFs.rm(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}

function createFixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agentos-m4-observe-')));
  const projectRoot = join(root, 'server-data');
  const workspaceRoot = join(root, 'workspace');
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(workspaceRoot, { recursive: true });
  const store = new SqliteStore(projectRoot);
  store.workspaceRepo.insert({
    id: 'ws-a',
    name: 'Workspace A',
    rootPath: workspaceRoot,
    gitEnabled: true,
    memoryEnabled: true,
    agents: [],
    lastOpenedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  });
  return {
    root,
    projectRoot,
    workspaceRoot,
    store,
    observations: new WorkspaceGitObservationRepository(store.getDatabase()),
    async close() {
      try {
        store.close();
      } finally {
        await removeTreeRobust(root);
      }
    },
  };
}

function gitSetupEnvironment(): Record<string, string> {
  return {
    ...process.env,
    LC_ALL: 'C',
    LANG: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ATTR_NOSYSTEM: '1',
  };
}

function runGit(cwd: string, args: readonly string[]): void {
  const result = spawnSync('git', [...args], {
    cwd,
    env: gitSetupEnvironment(),
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error('Git test setup failed');
  }
}

function initCommittedRepository(workspaceRoot: string): void {
  runGit(workspaceRoot, ['init', '-b', 'main']);
  writeFileSync(join(workspaceRoot, 'tracked.txt'), 'clean\n', 'utf8');
  runGit(workspaceRoot, ['add', '--', 'tracked.txt']);
  runGit(workspaceRoot, [
    '-c', 'user.name=AgentOS M4 Test',
    '-c', 'user.email=m4-test@example.invalid',
    '-c', 'commit.gpgsign=false',
    'commit', '-m', 'initial',
  ]);
}

function counts(fx: Fixture): DurableCounts {
  const db = fx.store.getDatabase();
  const count = (table: string): number => (
    db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }
  ).count;
  return {
    observations: count('workspace_git_observations'),
    artifacts: count('runtime_artifacts'),
    events: count('runtime_events'),
    outbox: count('outbox_messages'),
  };
}

function assertDurableDelta(
  before: DurableCounts,
  after: DurableCounts,
  observationDelta: number,
): void {
  assert.equal(after.observations - before.observations, observationDelta);
  assert.equal(after.artifacts - before.artifacts, 0);
  assert.equal(after.events - before.events, 0);
  assert.equal(after.outbox - before.outbox, 0);
}

function unavailableCommandResult() {
  return {
    stdout: new Uint8Array(0),
    stderrDiagnostic: new Uint8Array(0),
    stderrDiagnosticTruncated: false,
    termination: 'spawn_failed' as const,
    exitCode: null,
    spawnFailure: 'not_found' as const,
  };
}

function createServiceWithCollector(
  fx: Fixture,
  collector: GitObservationCollector,
): WorkspaceGitObservationService {
  const persistence = new GitObservationPersistenceService({
    store: fx.store,
    factWriter: fx.store.runtimeEventOutboxWriter(),
    eventAuthority: DENY_ALL_AUTHORITY,
    artifactRoot: join(fx.root, 'artifacts'),
  });
  return new WorkspaceGitObservationService({
    store: fx.store,
    collector,
    persistence,
    observations: fx.observations,
  });
}

function unavailableCollector(onExecute?: () => void): GitObservationCollector {
  return new GitObservationCollector({
    createCommandPort: () => ({
      executionContract: GIT_COMMAND_EXECUTION_CONTRACT_V1,
      async execute() {
        onExecute?.();
        return unavailableCommandResult();
      },
    }),
  });
}

test('M4-I01 production composition observes and persists a clean Git Workspace', async () => {
  const fx = createFixture();
  try {
    initCommittedRepository(fx.workspaceRoot);
    const service = createWorkspaceGitObservationService(fx.store);
    const before = counts(fx);
    const result = await service.observeOnDemand({ workspaceId: 'ws-a' });
    const after = counts(fx);

    assert.equal(result.snapshot.observationState, 'GIT');
    assert.equal(result.snapshot.dirtyState, 'clean');
    assert.equal(result.snapshot.statusCompleteness, 'complete');
    assert.ok(result.snapshot.baseCommitSha);
    assert.equal(fx.observations.findById('ws-a', result.observationId)?.id, result.observationId);
    assertDurableDelta(before, after, 1);
  } finally {
    await fx.close();
  }
});

test('M4-I02 production composition observes and persists a dirty Git Workspace', async () => {
  const fx = createFixture();
  try {
    initCommittedRepository(fx.workspaceRoot);
    writeFileSync(join(fx.workspaceRoot, 'tracked.txt'), 'dirty\n', 'utf8');
    const service = createWorkspaceGitObservationService(fx.store);
    const before = counts(fx);
    const result = await service.observeOnDemand({ workspaceId: 'ws-a' });
    const after = counts(fx);

    assert.equal(result.snapshot.observationState, 'GIT');
    assert.equal(result.snapshot.dirtyState, 'dirty');
    assert.equal(result.snapshot.changedFiles?.entries[0]?.path, 'tracked.txt');
    assertDurableDelta(before, after, 1);
  } finally {
    await fx.close();
  }
});

test('M4-I03 production composition persists a NOT_GIT Workspace', async () => {
  const fx = createFixture();
  try {
    const service = createWorkspaceGitObservationService(fx.store);
    const before = counts(fx);
    const result = await service.observeOnDemand({ workspaceId: 'ws-a' });
    const after = counts(fx);

    assert.equal(result.snapshot.observationState, 'NOT_GIT');
    assert.equal(fx.observations.findById('ws-a', result.observationId)?.observationState, 'NOT_GIT');
    assertDurableDelta(before, after, 1);
  } finally {
    await fx.close();
  }
});

test('M4-I04 deterministic M2 port seam persists UNAVAILABLE unchanged', async () => {
  const fx = createFixture();
  try {
    const service = createServiceWithCollector(fx, unavailableCollector());
    const before = counts(fx);
    const result = await service.observeOnDemand({ workspaceId: 'ws-a' });
    const after = counts(fx);

    assert.equal(result.snapshot.observationState, 'UNAVAILABLE');
    assert.equal(result.snapshot.error?.code, 'GIT_EXECUTABLE_UNAVAILABLE');
    assert.equal(
      fx.observations.findById('ws-a', result.observationId)?.errorCode,
      'GIT_EXECUTABLE_UNAVAILABLE',
    );
    assertDurableDelta(before, after, 1);
  } finally {
    await fx.close();
  }
});

test('M4-I05 pre-aborted caller signal is classified by M2 and persisted', async () => {
  const fx = createFixture();
  try {
    const service = createWorkspaceGitObservationService(fx.store);
    const controller = new AbortController();
    controller.abort();
    const before = counts(fx);
    const result = await service.observeOnDemand({
      workspaceId: 'ws-a',
      signal: controller.signal,
    });
    const after = counts(fx);

    assert.equal(result.snapshot.observationState, 'UNAVAILABLE');
    assert.equal(result.snapshot.error?.code, 'GIT_COMMAND_CANCELLED');
    assertDurableDelta(before, after, 1);
  } finally {
    await fx.close();
  }
});

test('M4-I06 cleanup-unproven rejects before M3 and leaves all durable tables unchanged', async () => {
  const fx = createFixture();
  try {
    let commandCalls = 0;
    const collector = new GitObservationCollector({
      createCommandPort: () => ({
        executionContract: GIT_COMMAND_EXECUTION_CONTRACT_V1,
        async execute() {
          commandCalls += 1;
          throw new Error(GIT_COMMAND_CLEANUP_UNPROVEN_MESSAGE);
        },
      }),
    });
    const service = createServiceWithCollector(fx, collector);
    const before = counts(fx);
    await assert.rejects(
      service.observeOnDemand({ workspaceId: 'ws-a' }),
      (error: unknown) => {
        assert.ok(error instanceof WorkspaceGitObservationServiceError);
        assert.equal(error.code, 'CLEANUP_UNPROVEN');
        return true;
      },
    );
    const after = counts(fx);
    assert.equal(commandCalls, 1);
    assertDurableDelta(before, after, 0);
  } finally {
    await fx.close();
  }
});

test('M4-I07 duplicate identical observations create two independent rows and IDs', async () => {
  const fx = createFixture();
  try {
    const service = createServiceWithCollector(fx, unavailableCollector());
    const before = counts(fx);
    const first = await service.observeOnDemand({ workspaceId: 'ws-a' });
    const second = await service.observeOnDemand({ workspaceId: 'ws-a' });
    const after = counts(fx);

    assert.deepEqual(first.snapshot, second.snapshot);
    assert.notEqual(first.observationId, second.observationId);
    assert.ok(fx.observations.findById('ws-a', first.observationId));
    assert.ok(fx.observations.findById('ws-a', second.observationId));
    assertDurableDelta(before, after, 2);
  } finally {
    await fx.close();
  }
});

test('M4-I08 concurrent same-Workspace observations collect independently and persist two rows', { timeout: 5_000 }, async () => {
  const fx = createFixture();
  try {
    let started = 0;
    let release!: () => void;
    const bothStarted = new Promise<void>(resolve => {
      release = resolve;
    });
    const collector = new GitObservationCollector({
      createCommandPort: () => ({
        executionContract: GIT_COMMAND_EXECUTION_CONTRACT_V1,
        async execute() {
          started += 1;
          if (started === 2) release();
          await bothStarted;
          return unavailableCommandResult();
        },
      }),
    });
    const service = createServiceWithCollector(fx, collector);
    const before = counts(fx);
    const [first, second] = await Promise.all([
      service.observeOnDemand({ workspaceId: 'ws-a' }),
      service.observeOnDemand({ workspaceId: 'ws-a' }),
    ]);
    const after = counts(fx);

    assert.equal(started, 2);
    assert.notEqual(first.observationId, second.observationId);
    assertDurableDelta(before, after, 2);
  } finally {
    await fx.close();
  }
});

test('M4-I09 getById returns the correct Workspace-scoped persisted row', async () => {
  const fx = createFixture();
  try {
    const service = createWorkspaceGitObservationService(fx.store);
    const before = counts(fx);
    const observed = await service.observeOnDemand({ workspaceId: 'ws-a' });
    const row = service.getById({ workspaceId: 'ws-a', observationId: observed.observationId });
    const after = counts(fx);

    assert.equal(row?.id, observed.observationId);
    assert.equal(row?.workspaceId, 'ws-a');
    assert.equal(
      service.getById({ workspaceId: 'ws-other', observationId: observed.observationId }),
      undefined,
    );
    assertDurableDelta(before, after, 1);
  } finally {
    await fx.close();
  }
});

test('M4-I10 getLatestWorkspaceOnly returns the same bounded latest row as the repository', async () => {
  const fx = createFixture();
  try {
    const service = createServiceWithCollector(fx, unavailableCollector());
    const before = counts(fx);
    await service.observeOnDemand({ workspaceId: 'ws-a' });
    await service.observeOnDemand({ workspaceId: 'ws-a' });
    const expected = fx.observations.findLatestWorkspaceOnly('ws-a');
    const actual = service.getLatestWorkspaceOnly({ workspaceId: 'ws-a' });
    const after = counts(fx);

    assert.ok(actual);
    assert.deepEqual(actual, expected);
    assert.equal(
      (fx.store.getDatabase().prepare(
        'SELECT COUNT(*) AS count FROM workspace_git_observations WHERE workspace_id = ? AND admission_id IS NULL',
      ).get('ws-a') as { count: number }).count,
      2,
    );
    assertDurableDelta(before, after, 2);
  } finally {
    await fx.close();
  }
});

test('M4-I11 SqliteStore exposes and reuses its one existing RuntimeEventOutboxWriter', async () => {
  const fx = createFixture();
  try {
    const writer = fx.store.runtimeEventOutboxWriter();
    assert.strictEqual(fx.store.runtimeEventOutboxWriter(), writer);
    assert.strictEqual(writer.transactionDatabase, fx.store.getDatabase());
    assert.strictEqual(
      (fx.store.providerSessionRepository() as unknown as { factWriter: unknown }).factWriter,
      writer,
    );
    assert.strictEqual(
      (fx.store.processRepository() as unknown as { factWriter: unknown }).factWriter,
      writer,
    );
    assert.strictEqual(
      (fx.store.processOutputReferenceRepository() as unknown as { factWriter: unknown }).factWriter,
      writer,
    );
  } finally {
    await fx.close();
  }
});

test('M4-I12 Observation insert failure maps to PERSISTENCE_FAILED and rolls back everything', async () => {
  const fx = createFixture();
  try {
    fx.store.getDatabase().exec(`
      CREATE TRIGGER m4_fail_observation_insert
      BEFORE INSERT ON workspace_git_observations
      BEGIN
        SELECT RAISE(ABORT, 'raw sqlite secret C:\\private\\agentos.sqlite');
      END
    `);
    const service = createServiceWithCollector(fx, unavailableCollector());
    const before = counts(fx);
    await assert.rejects(
      service.observeOnDemand({ workspaceId: 'ws-a' }),
      (error: unknown) => {
        assert.ok(error instanceof WorkspaceGitObservationServiceError);
        assert.equal(error.code, 'PERSISTENCE_FAILED');
        assert.equal(error.message, 'WORKSPACE_GIT_OBSERVATION_PERSISTENCE_FAILED');
        assert.doesNotMatch(error.message, /sqlite|private|secret/iu);
        return true;
      },
    );
    const after = counts(fx);
    assertDurableDelta(before, after, 0);
  } finally {
    await fx.close();
  }
});
