import test from 'node:test';
import assert from 'node:assert/strict';

import type { GitObservationSnapshotV1, Workspace } from '@agentos/shared';
import type {
  GitObservationCollectInputV1,
  GitObservationCollectOutcomeV1,
} from './GitObservationCollector.js';
import { GIT_COMMAND_CLEANUP_UNPROVEN_MESSAGE } from './GitCommandAdapter.js';
import type {
  GitObservationPersistenceCommandV1,
  GitObservationPersistenceResultV1,
} from './GitObservationPersistenceService.js';
import type { WorkspaceGitObservationRow } from '../store/WorkspaceGitObservationRepository.js';
import {
  WorkspaceGitObservationService,
  WorkspaceGitObservationServiceError,
} from './WorkspaceGitObservationService.js';

const WORKSPACE: Workspace = {
  id: 'ws-a',
  name: 'Workspace A',
  rootPath: 'E:\\durable\\workspace-a',
  gitEnabled: true,
  memoryEnabled: true,
  agents: [],
  lastOpenedAt: '2026-09-03T00:00:00.000Z',
  createdAt: '2026-09-03T00:00:00.000Z',
  updatedAt: '2026-09-03T00:00:00.000Z',
};

const NOT_GIT_SNAPSHOT: GitObservationSnapshotV1 = {
  schemaVersion: 1,
  trigger: 'on_demand',
  observationState: 'NOT_GIT',
  repositoryRoot: null,
  cwd: WORKSPACE.rootPath,
  baseCommitSha: null,
  finalCommitSha: null,
  dirtyState: 'not_applicable',
  statusCompleteness: 'not_applicable',
  changedFiles: null,
  diffState: 'not_applicable',
  truncation: { changedFiles: false, diff: false },
  error: null,
  subfailures: [],
};

const UNAVAILABLE_SNAPSHOT = {
  schemaVersion: 1,
  trigger: 'on_demand',
  observationState: 'UNAVAILABLE',
  repositoryRoot: null,
  cwd: WORKSPACE.rootPath,
  baseCommitSha: null,
  finalCommitSha: null,
  dirtyState: 'unknown',
  statusCompleteness: 'incomplete',
  changedFiles: null,
  diffState: 'unavailable',
  truncation: { changedFiles: false, diff: false },
  error: { phase: 'repository_discovery', code: 'GIT_EXECUTABLE_UNAVAILABLE' },
  subfailures: [],
} as const satisfies GitObservationSnapshotV1;

const CANCELLED_SNAPSHOT = {
  ...UNAVAILABLE_SNAPSHOT,
  error: { phase: 'repository_discovery', code: 'GIT_COMMAND_CANCELLED' },
} as const satisfies GitObservationSnapshotV1;

const ROW: WorkspaceGitObservationRow = {
  id: 'obs-existing',
  workspaceId: 'ws-a',
  admissionId: null,
  subjectKind: null,
  canonicalRunId: null,
  legacyRunId: null,
  observationState: 'NOT_GIT',
  repositoryRoot: null,
  baseCommitSha: null,
  dirtyState: null,
  statusSummaryJson: '{}',
  changedFilesJson: null,
  diffArtifactId: null,
  cwd: WORKSPACE.rootPath,
  errorCode: null,
  observedAt: '2026-09-03T00:00:00.000Z',
  createdAt: '2026-09-03T00:00:00.000Z',
};

interface HarnessOptions {
  readonly workspace?: Workspace | undefined;
  readonly outcome?: GitObservationCollectOutcomeV1;
  readonly collectorError?: unknown;
  readonly persistenceError?: unknown;
  readonly observationId?: string;
  readonly byId?: WorkspaceGitObservationRow | undefined;
  readonly latest?: WorkspaceGitObservationRow | undefined;
}

function createHarness(options: HarnessOptions = {}) {
  const collectorCalls: GitObservationCollectInputV1[] = [];
  const persistenceCalls: GitObservationPersistenceCommandV1[] = [];
  const workspaceLookups: string[] = [];
  const byIdCalls: Array<readonly [string, string]> = [];
  const latestCalls: string[] = [];
  let legacyFallbackCalls = 0;
  const workspace = Object.prototype.hasOwnProperty.call(options, 'workspace')
    ? options.workspace
    : WORKSPACE;
  const outcome = options.outcome ?? {
    snapshot: NOT_GIT_SNAPSHOT,
    diffBytes: new TextEncoder().encode('must-not-cross-m4'),
  };
  const persistenceResult: GitObservationPersistenceResultV1 = {
    observationId: options.observationId ?? 'obs-new',
    diffArtifactId: null,
    eventsCreated: 0,
    outboxRowsCreated: 0,
  };
  const storeWithLegacyFallback = {
    workspaceRepo: {
      findById(workspaceId: string) {
        workspaceLookups.push(workspaceId);
        return workspace;
      },
    },
    getWorkspaceFromLegacyJson() {
      legacyFallbackCalls += 1;
      return WORKSPACE;
    },
  };

  const service = new WorkspaceGitObservationService({
    store: storeWithLegacyFallback,
    collector: {
      async collect(input: GitObservationCollectInputV1) {
        collectorCalls.push(input);
        if (Object.prototype.hasOwnProperty.call(options, 'collectorError')) {
          throw options.collectorError;
        }
        return outcome;
      },
    },
    persistence: {
      async persist(command: GitObservationPersistenceCommandV1) {
        persistenceCalls.push(command);
        if (Object.prototype.hasOwnProperty.call(options, 'persistenceError')) {
          throw options.persistenceError;
        }
        return persistenceResult;
      },
    },
    observations: {
      findById(workspaceId: string, observationId: string) {
        byIdCalls.push([workspaceId, observationId]);
        return options.byId;
      },
      findLatestWorkspaceOnly(workspaceId: string) {
        latestCalls.push(workspaceId);
        return options.latest;
      },
    },
  });

  return {
    service,
    collectorCalls,
    persistenceCalls,
    workspaceLookups,
    byIdCalls,
    latestCalls,
    legacyFallbackCalls: () => legacyFallbackCalls,
  };
}

function rejectsWith(code: WorkspaceGitObservationServiceError['code']) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof WorkspaceGitObservationServiceError);
    assert.equal(error.code, code);
    assert.equal(error.message, `WORKSPACE_GIT_OBSERVATION_${code}`);
    return true;
  };
}

// Compile-only proof that forbidden caller-controlled collection/binding fields
// are absent from the public command. The runtime tests below also prove that
// hostile extra properties cannot override server-owned values.
function compileOnlyPublicCommand(service: WorkspaceGitObservationService): void {
  if (false) {
    // @ts-expect-error cwd is not a public M4 input
    void service.observeOnDemand({ workspaceId: 'ws-a', cwd: 'E:\\hostile' });
    // @ts-expect-error trigger is not a public M4 input
    void service.observeOnDemand({ workspaceId: 'ws-a', trigger: 'terminal' });
    // @ts-expect-error binding and canonical authority are not public M4 inputs
    void service.observeOnDemand({ workspaceId: 'ws-a', binding: { subjectKind: 'CANONICAL_RUN' } });
  }
}
void compileOnlyPublicCommand;

test('M4-U01 empty workspaceId is rejected with stable INPUT_INVALID', async () => {
  const fx = createHarness();
  await assert.rejects(
    fx.service.observeOnDemand({ workspaceId: ' \t ' }),
    rejectsWith('INPUT_INVALID'),
  );
  assert.equal(fx.workspaceLookups.length, 0);
  assert.equal(fx.collectorCalls.length, 0);
  assert.equal(fx.persistenceCalls.length, 0);
});

test('M4-U02 missing durable Workspace is rejected before collection', async () => {
  const fx = createHarness({ workspace: undefined });
  await assert.rejects(
    fx.service.observeOnDemand({ workspaceId: 'ws-missing' }),
    rejectsWith('WORKSPACE_NOT_FOUND'),
  );
  assert.deepEqual(fx.workspaceLookups, ['ws-missing']);
  assert.equal(fx.collectorCalls.length, 0);
  assert.equal(fx.persistenceCalls.length, 0);
});

test('M4-U03 Workspace resolution uses only the durable SQLite repository', async () => {
  const fx = createHarness({ workspace: undefined });
  await assert.rejects(
    fx.service.observeOnDemand({ workspaceId: WORKSPACE.id }),
    rejectsWith('WORKSPACE_NOT_FOUND'),
  );
  assert.equal(fx.collectorCalls.length, 0);
  assert.equal(fx.legacyFallbackCalls(), 0);
});

test('M4-U04 caller-supplied cwd cannot override the durable Workspace root', async () => {
  const fx = createHarness();
  await fx.service.observeOnDemand({
    workspaceId: WORKSPACE.id,
    cwd: 'E:\\hostile\\cwd',
  } as never);
  assert.equal(fx.collectorCalls[0]?.cwd, WORKSPACE.rootPath);
});

test('M4-U05 caller-supplied trigger cannot override the server trigger', async () => {
  const fx = createHarness();
  await fx.service.observeOnDemand({
    workspaceId: WORKSPACE.id,
    trigger: 'terminal',
  } as never);
  assert.equal(fx.collectorCalls[0]?.trigger, 'on_demand');
});

test("M4-U06 collector trigger is exactly 'on_demand'", async () => {
  const fx = createHarness();
  await fx.service.observeOnDemand({ workspaceId: WORKSPACE.id });
  assert.deepEqual(fx.collectorCalls.map(call => call.trigger), ['on_demand']);
});

test('M4-U07 collector cwd is the durable Workspace rootPath', async () => {
  const fx = createHarness();
  await fx.service.observeOnDemand({ workspaceId: WORKSPACE.id });
  assert.deepEqual(fx.collectorCalls.map(call => call.cwd), [WORKSPACE.rootPath]);
});

test('M4-U08 exact AbortSignal identity reaches the collector', async () => {
  const fx = createHarness();
  const controller = new AbortController();
  await fx.service.observeOnDemand({ workspaceId: WORKSPACE.id, signal: controller.signal });
  assert.strictEqual(fx.collectorCalls[0]?.signal, controller.signal);
});

test('M4-U09 each request calls the collector exactly once', async () => {
  const fx = createHarness();
  await fx.service.observeOnDemand({ workspaceId: WORKSPACE.id });
  assert.equal(fx.collectorCalls.length, 1);
});

test('M4-U10 successful collection calls M3 persistence exactly once afterward', async () => {
  const order: string[] = [];
  const fx = createHarness();
  const collector = (fx.service as unknown as { collector: { collect: (input: GitObservationCollectInputV1) => Promise<GitObservationCollectOutcomeV1> } }).collector;
  const persistence = (fx.service as unknown as { persistence: { persist: (command: GitObservationPersistenceCommandV1) => Promise<GitObservationPersistenceResultV1> } }).persistence;
  const originalCollect = collector.collect.bind(collector);
  const originalPersist = persistence.persist.bind(persistence);
  collector.collect = async input => {
    order.push('collect');
    return originalCollect(input);
  };
  persistence.persist = async command => {
    order.push('persist');
    return originalPersist(command);
  };
  await fx.service.observeOnDemand({ workspaceId: WORKSPACE.id });
  assert.deepEqual(order, ['collect', 'persist']);
  assert.equal(fx.persistenceCalls.length, 1);
});

test('M4-U11 persistence binding is exactly WORKSPACE_ONLY', async () => {
  const fx = createHarness();
  await fx.service.observeOnDemand({ workspaceId: WORKSPACE.id });
  assert.deepEqual(fx.persistenceCalls[0]?.binding, { subjectKind: 'WORKSPACE_ONLY' });
});

test('M4-U12 diffBytes are never passed to M3', async () => {
  const fx = createHarness();
  await fx.service.observeOnDemand({ workspaceId: WORKSPACE.id });
  const command = fx.persistenceCalls[0] as unknown as Record<string, unknown>;
  assert.equal(Object.prototype.hasOwnProperty.call(command, 'diffBytes'), false);
  assert.deepEqual(Object.keys(command).sort(), ['binding', 'snapshot', 'workspaceId']);
});

test('M4-U13 result contains only the observationId and unchanged snapshot', async () => {
  const fx = createHarness({ observationId: 'obs-result' });
  const result = await fx.service.observeOnDemand({ workspaceId: WORKSPACE.id });
  assert.deepEqual(Object.keys(result).sort(), ['observationId', 'snapshot']);
  assert.equal(result.observationId, 'obs-result');
  assert.strictEqual(result.snapshot, NOT_GIT_SNAPSHOT);
});

test('M4-U14 NOT_GIT is persisted unchanged instead of rejected', async () => {
  const fx = createHarness({ outcome: { snapshot: NOT_GIT_SNAPSHOT, diffBytes: null } });
  const result = await fx.service.observeOnDemand({ workspaceId: WORKSPACE.id });
  assert.strictEqual(result.snapshot, NOT_GIT_SNAPSHOT);
  assert.strictEqual(fx.persistenceCalls[0]?.snapshot, NOT_GIT_SNAPSHOT);
});

test('M4-U15 UNAVAILABLE is persisted unchanged instead of rejected', async () => {
  const fx = createHarness({ outcome: { snapshot: UNAVAILABLE_SNAPSHOT, diffBytes: null } });
  const result = await fx.service.observeOnDemand({ workspaceId: WORKSPACE.id });
  assert.strictEqual(result.snapshot, UNAVAILABLE_SNAPSHOT);
  assert.strictEqual(fx.persistenceCalls[0]?.snapshot, UNAVAILABLE_SNAPSHOT);
});

test('M4-U16 a normal cancellation snapshot is persisted', async () => {
  const fx = createHarness({ outcome: { snapshot: CANCELLED_SNAPSHOT, diffBytes: null } });
  const result = await fx.service.observeOnDemand({ workspaceId: WORKSPACE.id });
  assert.strictEqual(result.snapshot, CANCELLED_SNAPSHOT);
  assert.strictEqual(fx.persistenceCalls[0]?.snapshot, CANCELLED_SNAPSHOT);
});

test('M4-U17 cleanup-unproven rejects fail-closed without persistence', async () => {
  const fx = createHarness({
    collectorError: new Error(GIT_COMMAND_CLEANUP_UNPROVEN_MESSAGE),
  });
  await assert.rejects(
    fx.service.observeOnDemand({ workspaceId: WORKSPACE.id }),
    rejectsWith('CLEANUP_UNPROVEN'),
  );
  assert.equal(fx.collectorCalls.length, 1);
  assert.equal(fx.persistenceCalls.length, 0);
});

test('M4-U18 unexpected collector exception maps to stable COLLECTION_FAILED', async () => {
  const fx = createHarness({ collectorError: new Error('secret collector detail C:\\private') });
  await assert.rejects(
    fx.service.observeOnDemand({ workspaceId: WORKSPACE.id }),
    rejectsWith('COLLECTION_FAILED'),
  );
  assert.equal(fx.persistenceCalls.length, 0);
});

test('M4-U19 persistence exception maps to stable PERSISTENCE_FAILED', async () => {
  const fx = createHarness({ persistenceError: new Error('SQLITE_SECRET /private/db') });
  await assert.rejects(
    fx.service.observeOnDemand({ workspaceId: WORKSPACE.id }),
    rejectsWith('PERSISTENCE_FAILED'),
  );
});

test('M4-U20 raw underlying exception messages never cross the service boundary', async () => {
  const collector = createHarness({ collectorError: new Error('raw-git-stderr-token') });
  const persistence = createHarness({ persistenceError: new Error('raw-sqlite-token') });
  for (const fx of [collector, persistence]) {
    await assert.rejects(
      fx.service.observeOnDemand({ workspaceId: WORKSPACE.id }),
      (error: unknown) => {
        assert.ok(error instanceof WorkspaceGitObservationServiceError);
        assert.doesNotMatch(error.message, /raw-git-stderr-token|raw-sqlite-token/);
        assert.equal(Object.prototype.hasOwnProperty.call(error, 'cause'), false);
        return true;
      },
    );
  }
});

test('M4-U21 canonical authority is unreachable through the public facade', async () => {
  const fx = createHarness();
  await fx.service.observeOnDemand({
    workspaceId: WORKSPACE.id,
    admissionId: 'adm-hostile',
    canonicalRunId: 'run-hostile',
    binding: { subjectKind: 'CANONICAL_RUN' },
    authoritySource: { origin: 'operation', operationId: 'op-hostile' },
  } as never);
  assert.deepEqual(fx.persistenceCalls, [{
    workspaceId: WORKSPACE.id,
    snapshot: NOT_GIT_SNAPSHOT,
    binding: { subjectKind: 'WORKSPACE_ONLY' },
  }]);
});

test('M4-U22 getById validates both identifiers and delegates a Workspace-scoped read', () => {
  const fx = createHarness({ byId: ROW });
  assert.throws(
    () => fx.service.getById({ workspaceId: ' ', observationId: 'obs-existing' }),
    rejectsWith('INPUT_INVALID'),
  );
  assert.throws(
    () => fx.service.getById({ workspaceId: 'ws-a', observationId: '\t' }),
    rejectsWith('INPUT_INVALID'),
  );
  assert.strictEqual(
    fx.service.getById({ workspaceId: 'ws-a', observationId: 'obs-existing' }),
    ROW,
  );
  assert.deepEqual(fx.byIdCalls, [['ws-a', 'obs-existing']]);
});

test('M4-U23 getLatestWorkspaceOnly validates input and exposes only the bounded repository read', () => {
  const fx = createHarness({ latest: ROW });
  assert.throws(
    () => fx.service.getLatestWorkspaceOnly({ workspaceId: '' }),
    rejectsWith('INPUT_INVALID'),
  );
  assert.strictEqual(fx.service.getLatestWorkspaceOnly({ workspaceId: 'ws-a' }), ROW);
  assert.deepEqual(fx.latestCalls, ['ws-a']);
});
