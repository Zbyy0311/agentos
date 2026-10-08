import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqliteStore } from './SqliteStore.js';
import { WorkspaceAdmissionRepository } from './WorkspaceAdmissionRepository.js';
import {
  WorkspaceGitObservationRepository,
  type WorkspaceGitObservationRow,
} from './WorkspaceGitObservationRepository.js';

const T0 = '2026-09-03T00:00:00.000Z';
const T1 = '2026-09-03T00:00:01.000Z';
const T2 = '2026-09-03T00:00:02.000Z';

interface Fixture {
  readonly root: string;
  readonly store: SqliteStore;
  readonly repository: WorkspaceGitObservationRepository;
  readonly admissions: WorkspaceAdmissionRepository;
  close(): void;
}

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'agentos-m4-observation-repo-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({
    workspaces: [
      {
        id: 'ws-a',
        name: 'Workspace A',
        rootPath: join(root, 'ws-a'),
        gitEnabled: true,
        memoryEnabled: true,
        agents: [{
          id: 'agent-a', name: 'Agent A', role: 'codex', enabled: true,
          cliCommand: 'agent', cliArgs: [],
        }],
        lastOpenedAt: T0,
        createdAt: T0,
        updatedAt: T0,
      },
      {
        id: 'ws-b',
        name: 'Workspace B',
        rootPath: join(root, 'ws-b'),
        gitEnabled: true,
        memoryEnabled: true,
        agents: [{
          id: 'agent-b', name: 'Agent B', role: 'codex', enabled: true,
          cliCommand: 'agent', cliArgs: [],
        }],
        lastOpenedAt: T0,
        createdAt: T0,
        updatedAt: T0,
      },
    ],
  }), 'utf8');
  mkdirSync(join(root, 'ws-a'), { recursive: true });
  mkdirSync(join(root, 'ws-b'), { recursive: true });
  const store = new SqliteStore(root);
  const db = store.getDatabase();
  return {
    root,
    store,
    repository: new WorkspaceGitObservationRepository(db),
    admissions: new WorkspaceAdmissionRepository(db),
    close() {
      try {
        store.close();
      } finally {
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    },
  };
}

function workspaceOnlyRow(overrides: Partial<WorkspaceGitObservationRow> = {}): WorkspaceGitObservationRow {
  return {
    id: 'obs-workspace',
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
    cwd: 'E:\\workspace',
    errorCode: null,
    observedAt: T0,
    createdAt: T0,
    ...overrides,
  };
}

function seedCanonicalSubject(fx: Fixture): void {
  const db = fx.store.getDatabase();
  db.prepare(
    'INSERT INTO tasks (id, workspace_id, title, status, priority, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('task-a', 'ws-a', 'Task', 'open', 'normal', 'test', T0, T0);
  db.prepare(
    'INSERT INTO runs (id, workspace_id, task_id, root_run_id, status, reason, origin, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('run-a', 'ws-a', 'task-a', 'run-a', 'queued', 'initial', 'v2_api', 'test', T0, T0);
  fx.admissions.insertAdmission({
    id: 'adm-canonical',
    workspaceId: 'ws-a',
    subjectKind: 'CANONICAL_RUN',
    canonicalRunId: 'run-a',
    legacyRunId: null,
    requestedMutationClass: 'READ_ONLY',
    effectiveMutationClass: 'READ_ONLY',
    enforcementEvidenceJson: null,
    requestOrder: 1,
    state: 'GRANTED',
    queueReason: null,
    releaseReason: null,
    requestedAt: T0,
    grantedAt: T0,
    releasedAt: null,
    createdAt: T0,
    updatedAt: T0,
    version: 1,
  });
}

function seedLegacySubject(fx: Fixture): void {
  fx.store.createConversation({
    id: 'conv-a', workspaceId: 'ws-a', type: 'direct', title: 'Conversation',
    agentId: 'agent-a', createdAt: T0, updatedAt: T0,
  });
  fx.store.createMessage({
    id: 'msg-a', conversationId: 'conv-a', workspaceId: 'ws-a',
    senderType: 'user', content: 'hello', createdAt: T0,
  });
  fx.store.createRun({
    id: 'legacy-run-a', workspaceId: 'ws-a', conversationId: 'conv-a',
    sourceMessageId: 'msg-a', objective: 'observe', status: 'running',
    createdAt: T0, updatedAt: T0,
  });
  fx.admissions.insertAdmission({
    id: 'adm-legacy',
    workspaceId: 'ws-a',
    subjectKind: 'LEGACY_AGENT_RUN',
    canonicalRunId: null,
    legacyRunId: 'legacy-run-a',
    requestedMutationClass: 'READ_ONLY',
    effectiveMutationClass: 'READ_ONLY',
    enforcementEvidenceJson: null,
    requestOrder: 2,
    state: 'GRANTED',
    queueReason: null,
    releaseReason: null,
    requestedAt: T0,
    grantedAt: T0,
    releasedAt: null,
    createdAt: T0,
    updatedAt: T0,
    version: 1,
  });
}

test('M4-R01 findById remains Workspace scoped', () => {
  const fx = createFixture();
  try {
    fx.repository.insertObservation(workspaceOnlyRow({
      id: 'obs-b',
      workspaceId: 'ws-b',
    }));
    assert.equal(fx.repository.findById('ws-a', 'obs-b'), undefined);
    assert.equal(fx.repository.findById('ws-b', 'obs-b')?.id, 'obs-b');
  } finally {
    fx.close();
  }
});

test('M4-R02 findLatestWorkspaceOnly returns the latest Workspace-only row', () => {
  const fx = createFixture();
  try {
    fx.repository.insertObservation(workspaceOnlyRow({ id: 'obs-old', createdAt: T0 }));
    fx.repository.insertObservation(workspaceOnlyRow({ id: 'obs-new', createdAt: T2 }));
    assert.equal(fx.repository.findLatestWorkspaceOnly('ws-a')?.id, 'obs-new');
  } finally {
    fx.close();
  }
});

test('M4-R03 latest Workspace-only read excludes Admission-bound canonical rows', () => {
  const fx = createFixture();
  try {
    seedCanonicalSubject(fx);
    fx.repository.insertObservation(workspaceOnlyRow({ id: 'obs-workspace', createdAt: T0 }));
    fx.repository.insertObservation(workspaceOnlyRow({
      id: 'obs-canonical',
      admissionId: 'adm-canonical',
      subjectKind: 'CANONICAL_RUN',
      canonicalRunId: 'run-a',
      createdAt: T2,
    }));
    assert.equal(fx.repository.findLatestWorkspaceOnly('ws-a')?.id, 'obs-workspace');
  } finally {
    fx.close();
  }
});

test('M4-R04 latest Workspace-only read excludes Admission-bound legacy rows', () => {
  const fx = createFixture();
  try {
    seedLegacySubject(fx);
    fx.repository.insertObservation(workspaceOnlyRow({ id: 'obs-workspace', createdAt: T0 }));
    fx.repository.insertObservation(workspaceOnlyRow({
      id: 'obs-legacy',
      admissionId: 'adm-legacy',
      subjectKind: 'LEGACY_AGENT_RUN',
      legacyRunId: 'legacy-run-a',
      createdAt: T2,
    }));
    assert.equal(fx.repository.findLatestWorkspaceOnly('ws-a')?.id, 'obs-workspace');
  } finally {
    fx.close();
  }
});

test('M4-R05 latest Workspace-only read returns undefined for an empty Workspace', () => {
  const fx = createFixture();
  try {
    fx.repository.insertObservation(workspaceOnlyRow({
      id: 'obs-b',
      workspaceId: 'ws-b',
    }));
    assert.equal(fx.repository.findLatestWorkspaceOnly('ws-a'), undefined);
  } finally {
    fx.close();
  }
});

test('M4-R06 equal timestamps are ordered deterministically by id DESC', () => {
  const fx = createFixture();
  try {
    fx.repository.insertObservation(workspaceOnlyRow({ id: 'obs-a', createdAt: T1 }));
    fx.repository.insertObservation(workspaceOnlyRow({ id: 'obs-z', createdAt: T1 }));
    fx.repository.insertObservation(workspaceOnlyRow({ id: 'obs-m', createdAt: T1 }));
    assert.equal(fx.repository.findLatestWorkspaceOnly('ws-a')?.id, 'obs-z');
  } finally {
    fx.close();
  }
});

test('M4-R07 latest query uses get + LIMIT 1 and the existing admission index', () => {
  let capturedSql = '';
  let getCalls = 0;
  const repository = new WorkspaceGitObservationRepository({
    prepare(sql: string) {
      capturedSql = sql;
      return {
        get(workspaceId: unknown) {
          getCalls += 1;
          assert.equal(workspaceId, 'ws-a');
          return undefined;
        },
      };
    },
  } as never);
  assert.equal(repository.findLatestWorkspaceOnly('ws-a'), undefined);
  assert.equal(getCalls, 1);
  assert.match(capturedSql, /WHERE workspace_id = \? AND admission_id IS NULL/u);
  assert.match(capturedSql, /ORDER BY created_at DESC, id DESC LIMIT 1$/u);

  const fx = createFixture();
  try {
    const plan = fx.store.getDatabase().prepare(
      'EXPLAIN QUERY PLAN SELECT id FROM workspace_git_observations'
        + ' WHERE workspace_id = ? AND admission_id IS NULL'
        + ' ORDER BY created_at DESC, id DESC LIMIT 1',
    ).all('ws-a') as Array<{ detail: string }>;
    assert.ok(
      plan.some(step => step.detail.includes('workspace_git_observations_admission')),
      JSON.stringify(plan),
    );
  } finally {
    fx.close();
  }
});
