import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import type { WorkspaceReadOnlyEvidence } from '@agentos/shared';
import { MigrationRegistry } from '../migrations/registry.js';
import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import { WorkspaceAdmissionRepository, type AdmissionState } from '../store/WorkspaceAdmissionRepository.js';
import { isTransactionActive } from '../store/Transaction.js';
import {
  L1D_READ_ONLY_CAPACITY_V1,
  WorkspaceAdmissionAuthority,
  WorkspaceAdmissionAuthorityError,
  type WorkspaceAdmissionEvidenceCollector,
  type WorkspaceAdmissionEvidenceFactsV1,
  type WorkspaceAdmissionAuthorityTestHooks,
} from './WorkspaceAdmissionAuthority.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): {
      all(...parameters: unknown[]): unknown[];
      get(...parameters: unknown[]): unknown;
      run(...parameters: unknown[]): unknown;
    };
    close(): void;
  };
};

type Db = InstanceType<typeof DatabaseSync>;

const WORKSPACE_ID = 'ws_l1d';
const NOW = '2026-09-04T01:00:00.000Z';
const PAST = '2026-09-03T01:00:00.000Z';
const FUTURE = '2026-09-05T01:00:00.000Z';
const QUEUE_REASON = 'WAITING_FOR_WORKSPACE_ADMISSION';

const VERIFIED_EVIDENCE: WorkspaceReadOnlyEvidence = {
  status: 'verified',
  source: 'qualified-write-denial',
  boundaryId: 'boundary-l1d',
  qualificationId: 'qualification-l1d',
};

const FRESH_READ_ONLY_FACTS: WorkspaceAdmissionEvidenceFactsV1 = {
  observedAt: NOW,
  validUntil: FUTURE,
  declaredModifyingAction: false,
  declaredExternalSideEffect: false,
  evidence: VERIFIED_EVIDENCE,
};

interface Fixture {
  readonly root: string;
  readonly databasePath: string;
  readonly db: Db;
  readonly admissions: WorkspaceAdmissionRepository;
  readonly authority: WorkspaceAdmissionAuthority;
  close(): void;
}

function createDatabase(path = ':memory:'): Db {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  new MigrationRunner(db, new MigrationRegistry([...DEFAULT_REGISTRY_MIGRATIONS])).run();
  db.prepare(
    'INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(WORKSPACE_ID, 'L1D Workspace', 'C:/workspace/l1d', 'C:/workspace/l1d', NOW, NOW, NOW);
  return db;
}

function fixedCollector(
  facts: WorkspaceAdmissionEvidenceFactsV1 = FRESH_READ_ONLY_FACTS,
  onCollect?: () => void,
): WorkspaceAdmissionEvidenceCollector {
  return {
    collect: async () => {
      onCollect?.();
      return structuredClone(facts);
    },
  };
}

function createFixture(options: {
  readonly collector?: WorkspaceAdmissionEvidenceCollector;
  readonly testHooks?: WorkspaceAdmissionAuthorityTestHooks;
  readonly fileBacked?: boolean;
} = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'agentos-l1d-authority-'));
  const databasePath = options.fileBacked ? join(root, 'authority.sqlite') : ':memory:';
  const db = createDatabase(databasePath);
  const authority = new WorkspaceAdmissionAuthority({
    store: { getDatabase: () => db },
    evidenceCollector: options.collector ?? fixedCollector(),
    now: () => new Date(NOW),
    testHooks: options.testHooks,
  });
  return {
    root,
    databasePath,
    db,
    admissions: new WorkspaceAdmissionRepository(db),
    authority,
    close() {
      try { db.close(); } finally { rmSync(root, { recursive: true, force: true }); }
    },
  };
}

function seedCanonicalRun(
  db: Db,
  runId: string,
  status: 'queued' | 'starting' | 'running' | 'waiting_approval' | 'paused' | 'completed' | 'failed' | 'cancelled' = 'queued',
  failureCode: string | null = null,
): void {
  const taskId = `task_${runId}`;
  db.prepare(
    'INSERT INTO tasks (id, workspace_id, title, status, priority, created_by, created_at, updated_at)'
      + " VALUES (?, ?, ?, 'open', 'normal', 'test', ?, ?)",
  ).run(taskId, WORKSPACE_ID, taskId, NOW, NOW);
  db.prepare(
    'INSERT INTO runs ('
      + 'id, workspace_id, task_id, root_run_id, status, reason, origin, failure_code,'
      + ' next_event_sequence, completed_at, created_by, created_at, updated_at, version'
      + ") VALUES (?, ?, ?, ?, ?, 'initial', 'v2_api', ?, 1, ?, 'test', ?, ?, 1)",
  ).run(
    runId,
    WORKSPACE_ID,
    taskId,
    runId,
    status,
    failureCode,
    status === 'completed' || status === 'failed' || status === 'cancelled' ? NOW : null,
    NOW,
    NOW,
  );
}

function evidenceEnvelopeJson(input: {
  readonly admissionId: string;
  readonly runId: string;
  readonly observedAt?: string;
  readonly validUntil: string;
  readonly declaredModifyingAction?: boolean;
  readonly declaredExternalSideEffect?: boolean;
  readonly evidence?: WorkspaceReadOnlyEvidence;
}): string {
  return JSON.stringify({
    schemaVersion: 1,
    workspaceId: WORKSPACE_ID,
    admissionId: input.admissionId,
    subject: { subjectKind: 'CANONICAL_RUN', canonicalRunId: input.runId },
    observedAt: input.observedAt ?? PAST,
    validUntil: input.validUntil,
    declaredModifyingAction: input.declaredModifyingAction ?? false,
    declaredExternalSideEffect: input.declaredExternalSideEffect ?? false,
    evidence: input.evidence ?? VERIFIED_EVIDENCE,
  });
}

function seedAdmission(
  fixture: Fixture,
  input: {
    readonly id: string;
    readonly order: number;
    readonly requested?: 'READ_ONLY' | 'MODIFYING';
    readonly effective?: 'READ_ONLY' | 'MODIFYING';
    readonly state?: AdmissionState;
    readonly evidenceJson?: string | null;
    readonly runStatus?: 'queued' | 'starting' | 'running' | 'waiting_approval' | 'paused' | 'completed' | 'failed' | 'cancelled';
    readonly failureCode?: string | null;
  },
): string {
  const runId = `run_${input.id}`;
  seedCanonicalRun(fixture.db, runId, input.runStatus, input.failureCode);
  const state = input.state ?? 'REQUESTED';
  const terminalAdmission = state === 'RELEASED' || state === 'CANCELLED' || state === 'FAILED';
  fixture.admissions.insertAdmission({
    id: input.id,
    workspaceId: WORKSPACE_ID,
    subjectKind: 'CANONICAL_RUN',
    canonicalRunId: runId,
    legacyRunId: null,
    requestedMutationClass: input.requested ?? 'MODIFYING',
    effectiveMutationClass: input.effective ?? input.requested ?? 'MODIFYING',
    enforcementEvidenceJson: input.evidenceJson ?? null,
    requestOrder: input.order,
    state,
    queueReason: state === 'QUEUED' ? QUEUE_REASON : null,
    releaseReason: terminalAdmission ? 'RUN_TERMINAL' : null,
    requestedAt: NOW,
    grantedAt: state === 'GRANTED' || state === 'RELEASED' ? NOW : null,
    releasedAt: terminalAdmission ? NOW : null,
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
  });
  return runId;
}

function seedLegacyAdmission(
  fixture: Fixture,
  input: {
    readonly id: string;
    readonly order: number;
    readonly runStatus: 'queued' | 'running' | 'waiting_user' | 'completed' | 'failed' | 'cancelled';
    readonly state: AdmissionState;
  },
): string {
  const conversationId = `conversation_${input.id}`;
  const messageId = `message_${input.id}`;
  const runId = `legacy_${input.id}`;
  fixture.db.prepare(
    'INSERT INTO conversations (id, workspace_id, conversation_type, title, created_at, updated_at)'
      + " VALUES (?, ?, 'direct', ?, ?, ?)",
  ).run(conversationId, WORKSPACE_ID, conversationId, NOW, NOW);
  fixture.db.prepare(
    "INSERT INTO messages (id, conversation_id, workspace_id, sender_type, content, created_at)"
      + " VALUES (?, ?, ?, 'user', 'run', ?)",
  ).run(messageId, conversationId, WORKSPACE_ID, NOW);
  fixture.db.prepare(
    'INSERT INTO agent_runs ('
      + 'id, workspace_id, conversation_id, source_message_id, objective, status, completed_at, created_at, updated_at'
      + ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    runId,
    WORKSPACE_ID,
    conversationId,
    messageId,
    'legacy admission',
    input.runStatus,
    input.runStatus === 'completed' || input.runStatus === 'failed' || input.runStatus === 'cancelled' ? NOW : null,
    NOW,
    NOW,
  );
  fixture.admissions.insertAdmission({
    id: input.id,
    workspaceId: WORKSPACE_ID,
    subjectKind: 'LEGACY_AGENT_RUN',
    canonicalRunId: null,
    legacyRunId: runId,
    requestedMutationClass: 'MODIFYING',
    effectiveMutationClass: 'MODIFYING',
    enforcementEvidenceJson: null,
    requestOrder: input.order,
    state: input.state,
    queueReason: input.state === 'QUEUED' ? QUEUE_REASON : null,
    releaseReason: null,
    requestedAt: NOW,
    grantedAt: input.state === 'GRANTED' ? NOW : null,
    releasedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
  });
  return runId;
}

function states(fixture: Fixture): Record<string, AdmissionState> {
  return Object.fromEntries(
    fixture.admissions.listByWorkspace(WORKSPACE_ID).map(row => [row.id, row.state]),
  );
}

function isAuthorityError(code: WorkspaceAdmissionAuthorityError['code']): (error: unknown) => boolean {
  return error => {
    assert.ok(error instanceof WorkspaceAdmissionAuthorityError);
    assert.equal(error.code, code);
    assert.equal(error.message, `WORKSPACE_ADMISSION_${code}`);
    return true;
  };
}

describe('WorkspaceAdmissionAuthority unit contract', () => {
  test('L1D-U01 invalid input fails with stable INPUT_INVALID', async () => {
    const fixture = createFixture();
    try {
      await assert.rejects(
        fixture.authority.advanceWorkspaceAdmissions('  '),
        isAuthorityError('INPUT_INVALID'),
      );
      await assert.rejects(
        fixture.authority.releaseWorkspaceAdmission({ workspaceId: WORKSPACE_ID, admissionId: '' }),
        isAuthorityError('INPUT_INVALID'),
      );
    } finally { fixture.close(); }
  });

  test('L1D-U02 a missing Workspace fails with WORKSPACE_NOT_FOUND', async () => {
    const fixture = createFixture();
    try {
      await assert.rejects(
        fixture.authority.advanceWorkspaceAdmissions('ws_missing'),
        isAuthorityError('WORKSPACE_NOT_FOUND'),
      );
    } finally { fixture.close(); }
  });

  test('L1D-U03 frozen classifier, not requested class, is effective authority', async () => {
    const fixture = createFixture({
      collector: fixedCollector({
        ...FRESH_READ_ONLY_FACTS,
        declaredModifyingAction: true,
      }),
    });
    try {
      seedAdmission(fixture, {
        id: 'adm_u03',
        order: 1,
        requested: 'READ_ONLY',
        effective: 'READ_ONLY',
      });

      const granted = await fixture.authority.advanceWorkspaceAdmissions(WORKSPACE_ID);

      assert.deepEqual(granted.map(item => item.admissionId), ['adm_u03']);
      const persisted = fixture.admissions.findById(WORKSPACE_ID, 'adm_u03');
      assert.equal(persisted?.effectiveMutationClass, 'MODIFYING');
      assert.equal(persisted?.state, 'GRANTED');
    } finally { fixture.close(); }
  });

  test('L1D-U04 stale evidence is collected outside and revalidated/classified inside BEGIN IMMEDIATE', async () => {
    let collectedInsideTransaction: boolean | undefined;
    let revalidatedInsideTransaction: boolean | undefined;
    let fixture!: Fixture;
    fixture = createFixture({
      collector: fixedCollector({
        ...FRESH_READ_ONLY_FACTS,
        evidence: { status: 'provider-assertion' },
      }, () => {
        collectedInsideTransaction = isTransactionActive(fixture.db);
      }),
      testHooks: {
        beforeEvidenceRevalidationWithinTransaction: () => {
          revalidatedInsideTransaction = isTransactionActive(fixture.db);
        },
      },
    });
    try {
      const runId = `run_adm_u04`;
      seedAdmission(fixture, {
        id: 'adm_u04',
        order: 1,
        requested: 'READ_ONLY',
        effective: 'READ_ONLY',
        evidenceJson: evidenceEnvelopeJson({
          admissionId: 'adm_u04',
          runId,
          validUntil: PAST,
        }),
      });

      await fixture.authority.advanceWorkspaceAdmissions(WORKSPACE_ID);

      const persisted = fixture.admissions.findById(WORKSPACE_ID, 'adm_u04');
      assert.equal(collectedInsideTransaction, false);
      assert.equal(revalidatedInsideTransaction, true);
      assert.equal(persisted?.effectiveMutationClass, 'MODIFYING');
      assert.equal(persisted?.state, 'GRANTED');
      assert.match(persisted?.enforcementEvidenceJson ?? '', /provider-assertion/);
      assert.match(persisted?.enforcementEvidenceJson ?? '', new RegExp(FUTURE.replaceAll('.', '\\.')));
    } finally { fixture.close(); }
  });

  test('L1D-U05 stale evidence that cannot be recollected fails closed with no write', async () => {
    const fixture = createFixture({
      collector: {
        collect: async () => { throw new Error('collector failed at C:/private/workspace'); },
      },
    });
    try {
      seedAdmission(fixture, {
        id: 'adm_u05',
        order: 1,
        requested: 'READ_ONLY',
        effective: 'READ_ONLY',
      });
      const before = fixture.admissions.findById(WORKSPACE_ID, 'adm_u05');

      await assert.rejects(
        fixture.authority.advanceWorkspaceAdmissions(WORKSPACE_ID),
        isAuthorityError('STALE_EVIDENCE'),
      );

      assert.deepEqual(fixture.admissions.findById(WORKSPACE_ID, 'adm_u05'), before);
    } finally { fixture.close(); }
  });

  test('L1D-U06 MODIFYING winner follows durable request_order FIFO', async () => {
    const fixture = createFixture();
    try {
      seedAdmission(fixture, { id: 'adm_z_u06', order: 1 });
      seedAdmission(fixture, { id: 'adm_a_u06', order: 2 });

      const granted = await fixture.authority.advanceWorkspaceAdmissions(WORKSPACE_ID);

      assert.deepEqual(granted.map(item => item.admissionId), ['adm_z_u06']);
      assert.deepEqual(states(fixture), { adm_z_u06: 'GRANTED', adm_a_u06: 'QUEUED' });
    } finally { fixture.close(); }
  });

  test('L1D-U07 contiguous READ_ONLY head requests retain durable FIFO order', async () => {
    const fixture = createFixture();
    try {
      seedAdmission(fixture, { id: 'adm_z_u07', order: 1, requested: 'READ_ONLY', effective: 'MODIFYING' });
      seedAdmission(fixture, { id: 'adm_a_u07', order: 2, requested: 'READ_ONLY', effective: 'MODIFYING' });
      seedAdmission(fixture, { id: 'adm_m_u07', order: 3, requested: 'READ_ONLY', effective: 'MODIFYING' });

      const granted = await fixture.authority.advanceWorkspaceAdmissions(WORKSPACE_ID);

      assert.deepEqual(granted.map(item => item.admissionId), ['adm_z_u07', 'adm_a_u07']);
      assert.equal(fixture.admissions.findById(WORKSPACE_ID, 'adm_m_u07')?.state, 'QUEUED');
    } finally { fixture.close(); }
  });

  test('L1D-U08 frozen V1 READ_ONLY capacity is exactly two and is never exceeded', async () => {
    const fixture = createFixture();
    try {
      assert.equal(L1D_READ_ONLY_CAPACITY_V1, 2);
      for (let order = 1; order <= 3; order += 1) {
        seedAdmission(fixture, {
          id: `adm_u08_${order}`,
          order,
          requested: 'READ_ONLY',
          effective: 'MODIFYING',
        });
      }

      await fixture.authority.advanceWorkspaceAdmissions(WORKSPACE_ID);

      const granted = fixture.admissions.listByWorkspace(WORKSPACE_ID)
        .filter(row => row.state === 'GRANTED');
      assert.equal(granted.length, 2);
      assert.ok(granted.every(row => row.effectiveMutationClass === 'READ_ONLY'));
    } finally { fixture.close(); }
  });

  test('L1D-U09 an active MODIFYING admission blocks every later request', async () => {
    const fixture = createFixture();
    try {
      seedAdmission(fixture, { id: 'adm_u09_active', order: 1, state: 'GRANTED' });
      seedAdmission(fixture, { id: 'adm_u09_waiting', order: 2 });

      const granted = await fixture.authority.advanceWorkspaceAdmissions(WORKSPACE_ID);

      assert.deepEqual(granted, []);
      assert.equal(fixture.admissions.findById(WORKSPACE_ID, 'adm_u09_waiting')?.state, 'QUEUED');
    } finally { fixture.close(); }
  });

  test('L1D-U10 repeated advancement is idempotent', async () => {
    const fixture = createFixture();
    try {
      seedAdmission(fixture, { id: 'adm_u10', order: 1 });
      const first = await fixture.authority.advanceWorkspaceAdmissions(WORKSPACE_ID);
      const afterFirst = fixture.admissions.findById(WORKSPACE_ID, 'adm_u10');

      const second = await fixture.authority.advanceWorkspaceAdmissions(WORKSPACE_ID);

      assert.equal(first.length, 1);
      assert.deepEqual(second, []);
      assert.deepEqual(fixture.admissions.findById(WORKSPACE_ID, 'adm_u10'), afterFirst);
    } finally { fixture.close(); }
  });

  test('L1D-U11 RELEASED admissions are never re-granted', async () => {
    const fixture = createFixture();
    try {
      seedAdmission(fixture, {
        id: 'adm_u11_released',
        order: 1,
        state: 'RELEASED',
        runStatus: 'completed',
      });
      seedAdmission(fixture, { id: 'adm_u11_next', order: 2 });

      const granted = await fixture.authority.advanceWorkspaceAdmissions(WORKSPACE_ID);

      assert.deepEqual(granted.map(item => item.admissionId), ['adm_u11_next']);
      assert.equal(fixture.admissions.findById(WORKSPACE_ID, 'adm_u11_released')?.state, 'RELEASED');
    } finally { fixture.close(); }
  });

  test('L1D-U12 a queued request stays byte-for-byte unchanged while capacity is full', async () => {
    const fixture = createFixture();
    try {
      seedAdmission(fixture, { id: 'adm_u12_r1', order: 1, requested: 'READ_ONLY', effective: 'READ_ONLY', state: 'GRANTED' });
      seedAdmission(fixture, { id: 'adm_u12_r2', order: 2, requested: 'READ_ONLY', effective: 'READ_ONLY', state: 'GRANTED' });
      seedAdmission(fixture, { id: 'adm_u12_wait', order: 3, requested: 'READ_ONLY', effective: 'READ_ONLY', state: 'QUEUED' });
      const before = fixture.admissions.findById(WORKSPACE_ID, 'adm_u12_wait');

      const granted = await fixture.authority.advanceWorkspaceAdmissions(WORKSPACE_ID);

      assert.deepEqual(granted, []);
      assert.deepEqual(fixture.admissions.findById(WORKSPACE_ID, 'adm_u12_wait'), before);
    } finally { fixture.close(); }
  });

  test('L1D-U13 public errors redact collector and SQLite details', async () => {
    const fixture = createFixture({
      collector: {
        collect: async () => {
          throw new Error('fatal: C:/secret/repository/.git stderr with token=private');
        },
      },
    });
    try {
      seedAdmission(fixture, {
        id: 'adm_u13',
        order: 1,
        requested: 'READ_ONLY',
        effective: 'READ_ONLY',
      });

      await assert.rejects(
        fixture.authority.advanceWorkspaceAdmissions(WORKSPACE_ID),
        error => {
          assert.ok(error instanceof WorkspaceAdmissionAuthorityError);
          assert.equal(error.code, 'STALE_EVIDENCE');
          assert.equal(error.message, 'WORKSPACE_ADMISSION_STALE_EVIDENCE');
          assert.doesNotMatch(error.message, /secret|stderr|token|SELECT|sqlite/i);
          return true;
        },
      );
    } finally { fixture.close(); }
  });

  test('L1D-U14 a queue-head writer blocks later readers while readers are active', async () => {
    const fixture = createFixture();
    try {
      seedAdmission(fixture, {
        id: 'adm_u14_active_reader',
        order: 1,
        requested: 'READ_ONLY',
        effective: 'READ_ONLY',
        state: 'GRANTED',
      });
      seedAdmission(fixture, { id: 'adm_u14_writer', order: 2 });
      seedAdmission(fixture, {
        id: 'adm_u14_later_reader',
        order: 3,
        requested: 'READ_ONLY',
        effective: 'READ_ONLY',
      });

      const granted = await fixture.authority.advanceWorkspaceAdmissions(WORKSPACE_ID);

      assert.deepEqual(granted, []);
      assert.equal(fixture.admissions.findById(WORKSPACE_ID, 'adm_u14_writer')?.state, 'QUEUED');
      assert.equal(fixture.admissions.findById(WORKSPACE_ID, 'adm_u14_later_reader')?.state, 'QUEUED');
    } finally { fixture.close(); }
  });

  test('L1D-U15 a newly selected reader remains mutually exclusive with the next writer', async () => {
    const fixture = createFixture();
    try {
      seedAdmission(fixture, {
        id: 'adm_u15_reader',
        order: 1,
        requested: 'READ_ONLY',
        effective: 'MODIFYING',
      });
      seedAdmission(fixture, { id: 'adm_u15_writer', order: 2 });
      seedAdmission(fixture, {
        id: 'adm_u15_later_reader',
        order: 3,
        requested: 'READ_ONLY',
        effective: 'READ_ONLY',
      });

      const granted = await fixture.authority.advanceWorkspaceAdmissions(WORKSPACE_ID);

      assert.deepEqual(granted.map(item => item.admissionId), ['adm_u15_reader']);
      assert.deepEqual(states(fixture), {
        adm_u15_reader: 'GRANTED',
        adm_u15_writer: 'QUEUED',
        adm_u15_later_reader: 'QUEUED',
      });
    } finally { fixture.close(); }
  });

  test('L1D-U16 stale active READ_ONLY evidence is reclassified before occupancy is trusted', async () => {
    let collections = 0;
    const fixture = createFixture({
      collector: fixedCollector({
        ...FRESH_READ_ONLY_FACTS,
        evidence: { status: 'provider-assertion' },
      }, () => { collections += 1; }),
    });
    try {
      const activeRunId = 'run_adm_u16_active';
      seedAdmission(fixture, {
        id: 'adm_u16_active',
        order: 1,
        requested: 'READ_ONLY',
        effective: 'READ_ONLY',
        evidenceJson: evidenceEnvelopeJson({
          admissionId: 'adm_u16_active',
          runId: activeRunId,
          validUntil: PAST,
        }),
        state: 'GRANTED',
      });
      seedAdmission(fixture, { id: 'adm_u16_waiting_writer', order: 2 });

      const granted = await fixture.authority.advanceWorkspaceAdmissions(WORKSPACE_ID);

      assert.deepEqual(granted, []);
      assert.equal(collections, 1);
      assert.equal(
        fixture.admissions.findById(WORKSPACE_ID, 'adm_u16_active')?.effectiveMutationClass,
        'MODIFYING',
      );
      assert.equal(fixture.admissions.findById(WORKSPACE_ID, 'adm_u16_waiting_writer')?.state, 'QUEUED');
    } finally { fixture.close(); }
  });

  test('L1D-U17 collected evidence cannot be rebound to a different subject before BEGIN IMMEDIATE', async () => {
    let fixture!: Fixture;
    fixture = createFixture({
      testHooks: {
        afterEvidenceCollectionOutsideTransaction: () => {
          const reboundRunId = 'run_adm_u17_rebound';
          seedCanonicalRun(fixture.db, reboundRunId);
          fixture.db.prepare(
            'DELETE FROM workspace_admissions WHERE workspace_id = ? AND id = ?',
          ).run(WORKSPACE_ID, 'adm_u17');
          fixture.admissions.insertAdmission({
            id: 'adm_u17',
            workspaceId: WORKSPACE_ID,
            subjectKind: 'CANONICAL_RUN',
            canonicalRunId: reboundRunId,
            legacyRunId: null,
            requestedMutationClass: 'READ_ONLY',
            effectiveMutationClass: 'READ_ONLY',
            enforcementEvidenceJson: null,
            requestOrder: 1,
            state: 'REQUESTED',
            queueReason: null,
            releaseReason: null,
            requestedAt: NOW,
            grantedAt: null,
            releasedAt: null,
            createdAt: NOW,
            updatedAt: NOW,
            version: 1,
          });
        },
      },
    });
    try {
      seedAdmission(fixture, {
        id: 'adm_u17',
        order: 1,
        requested: 'READ_ONLY',
        effective: 'READ_ONLY',
      });

      await assert.rejects(
        fixture.authority.advanceWorkspaceAdmissions(WORKSPACE_ID),
        isAuthorityError('STALE_EVIDENCE'),
      );

      const persisted = fixture.admissions.findById(WORKSPACE_ID, 'adm_u17');
      assert.equal(persisted?.canonicalRunId, 'run_adm_u17_rebound');
      assert.equal(persisted?.state, 'REQUESTED');
      assert.equal(persisted?.enforcementEvidenceJson, null);
    } finally { fixture.close(); }
  });
});

function seedMissingProcess(db: Db, runId: string): void {
  const task = db.prepare('SELECT task_id FROM runs WHERE workspace_id = ? AND id = ?')
    .get(WORKSPACE_ID, runId) as { task_id: string };
  db.prepare(
    'INSERT INTO runtime_processes ('
      + 'id, workspace_id, task_id, run_id, claim_epoch, process_type, platform, status,'
      + ' executable_resolved, args_redacted_json, cwd_resolved, shell, detached,'
      + ' stdin_mode, stdout_mode, stderr_mode, timeout_policy_json, security_profile_ref,'
      + ' recovery_classification, recovery_evidence_json, recovery_checked_at,'
      + ' recovery_classifier_version, version, created_at, updated_at'
      + ') VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
  ).run(
    `proc_${'M'.repeat(26)}`,
    WORKSPACE_ID,
    task.task_id,
    runId,
    'provider',
    'win32',
    'unknown',
    'C:/provider.exe',
    '[]',
    'C:/workspace/l1d',
    'closed',
    'capture',
    'capture',
    '{}',
    'security-profile-l1d',
    'missing',
    '{}',
    NOW,
    'p6-m2b-v1',
    NOW,
    NOW,
  );
}

describe('WorkspaceAdmissionAuthority repository and transaction contract', () => {
  test('L1D-R01 repository reads the queue by request_order then id', () => {
    const fixture = createFixture();
    try {
      seedAdmission(fixture, { id: 'adm_r01_second', order: 2 });
      seedAdmission(fixture, { id: 'adm_r01_first', order: 1 });

      assert.deepEqual(
        fixture.admissions.listByWorkspace(WORKSPACE_ID).map(row => row.id),
        ['adm_r01_first', 'adm_r01_second'],
      );
    } finally { fixture.close(); }
  });

  test('L1D-R02 grant state, timestamp, classification, and version commit atomically', async () => {
    const fixture = createFixture();
    try {
      seedAdmission(fixture, { id: 'adm_r02', order: 1 });

      await fixture.authority.advanceWorkspaceAdmissions(WORKSPACE_ID);

      const row = fixture.admissions.findById(WORKSPACE_ID, 'adm_r02');
      assert.equal(row?.state, 'GRANTED');
      assert.equal(row?.effectiveMutationClass, 'MODIFYING');
      assert.equal(row?.queueReason, null);
      assert.equal(row?.grantedAt, NOW);
      assert.equal(row?.updatedAt, NOW);
      assert.equal(row?.version, 2);
    } finally { fixture.close(); }
  });

  test('L1D-R03 repository CAS rejects a stale version without changing the winner', () => {
    const fixture = createFixture();
    try {
      seedAdmission(fixture, { id: 'adm_r03', order: 1 });
      const first = fixture.admissions.updateState({
        workspaceId: WORKSPACE_ID,
        admissionId: 'adm_r03',
        expectedVersion: 1,
        state: 'QUEUED',
        queueReason: QUEUE_REASON,
        releaseReason: null,
        grantedAt: null,
        releasedAt: null,
        effectiveMutationClass: 'MODIFYING',
        enforcementEvidenceJson: null,
        updatedAt: NOW,
      });
      const stale = fixture.admissions.updateState({
        workspaceId: WORKSPACE_ID,
        admissionId: 'adm_r03',
        expectedVersion: 1,
        state: 'GRANTED',
        queueReason: null,
        releaseReason: null,
        grantedAt: NOW,
        releasedAt: null,
        effectiveMutationClass: 'MODIFYING',
        enforcementEvidenceJson: null,
        updatedAt: NOW,
      });

      assert.equal(first, true);
      assert.equal(stale, false);
      assert.equal(fixture.admissions.findById(WORKSPACE_ID, 'adm_r03')?.state, 'QUEUED');
      assert.equal(fixture.admissions.findById(WORKSPACE_ID, 'adm_r03')?.version, 2);
    } finally { fixture.close(); }
  });

  test('L1D-R04 SQLite invariant rejects a second active MODIFYING admission', () => {
    const fixture = createFixture();
    try {
      seedAdmission(fixture, { id: 'adm_r04_first', order: 1, state: 'GRANTED' });
      seedAdmission(fixture, { id: 'adm_r04_second', order: 2, state: 'QUEUED' });

      assert.throws(() => fixture.admissions.updateState({
        workspaceId: WORKSPACE_ID,
        admissionId: 'adm_r04_second',
        expectedVersion: 1,
        state: 'GRANTED',
        queueReason: null,
        releaseReason: null,
        grantedAt: NOW,
        releasedAt: null,
        effectiveMutationClass: 'MODIFYING',
        enforcementEvidenceJson: null,
        updatedAt: NOW,
      }), /UNIQUE constraint failed/);
      assert.equal(
        fixture.admissions.listByWorkspace(WORKSPACE_ID)
          .filter(row => row.state === 'GRANTED' && row.effectiveMutationClass === 'MODIFYING').length,
        1,
      );
    } finally { fixture.close(); }
  });

  test('L1D-R05 one transaction never persists more than two active readers', async () => {
    const fixture = createFixture();
    try {
      for (let order = 1; order <= 4; order += 1) {
        seedAdmission(fixture, {
          id: `adm_r05_${order}`,
          order,
          requested: 'READ_ONLY',
          effective: 'MODIFYING',
        });
      }

      await fixture.authority.advanceWorkspaceAdmissions(WORKSPACE_ID);

      const count = fixture.db.prepare(
        "SELECT COUNT(*) AS count FROM workspace_admissions"
          + " WHERE workspace_id = ? AND state = 'GRANTED' AND effective_mutation_class = 'READ_ONLY'",
      ).get(WORKSPACE_ID) as { count: number };
      assert.equal(count.count, L1D_READ_ONLY_CAPACITY_V1);
    } finally { fixture.close(); }
  });

  test('L1D-R06 release and next grant commit in the same transaction', async () => {
    const fixture = createFixture();
    try {
      seedAdmission(fixture, {
        id: 'adm_r06_first',
        order: 1,
        state: 'GRANTED',
        runStatus: 'completed',
      });
      seedAdmission(fixture, { id: 'adm_r06_second', order: 2 });

      const granted = await fixture.authority.releaseWorkspaceAdmission({
        workspaceId: WORKSPACE_ID,
        admissionId: 'adm_r06_first',
      });

      assert.deepEqual(granted.map(item => item.admissionId), ['adm_r06_second']);
      const released = fixture.admissions.findById(WORKSPACE_ID, 'adm_r06_first');
      const next = fixture.admissions.findById(WORKSPACE_ID, 'adm_r06_second');
      assert.equal(released?.state, 'RELEASED');
      assert.equal(released?.releasedAt, NOW);
      assert.equal(released?.releaseReason, 'RUN_TERMINAL');
      assert.equal(released?.version, 2);
      assert.equal(next?.state, 'GRANTED');
      assert.equal(next?.grantedAt, NOW);
      assert.equal(next?.version, 2);
    } finally { fixture.close(); }
  });

  test('L1D-R07 a non-terminal subject cannot release its admission', async () => {
    const fixture = createFixture();
    try {
      seedAdmission(fixture, {
        id: 'adm_r07',
        order: 1,
        state: 'GRANTED',
        runStatus: 'running',
      });
      const before = fixture.admissions.findById(WORKSPACE_ID, 'adm_r07');

      await assert.rejects(
        fixture.authority.releaseWorkspaceAdmission({
          workspaceId: WORKSPACE_ID,
          admissionId: 'adm_r07',
        }),
        isAuthorityError('ADMISSION_NOT_RELEASABLE'),
      );
      assert.deepEqual(fixture.admissions.findById(WORKSPACE_ID, 'adm_r07'), before);
    } finally { fixture.close(); }
  });

  test('L1D-R08 durable MISSING evidence alone is not a terminal release proof', async () => {
    const fixture = createFixture();
    try {
      const runId = seedAdmission(fixture, {
        id: 'adm_r08',
        order: 1,
        state: 'GRANTED',
        runStatus: 'running',
      });
      seedMissingProcess(fixture.db, runId);

      await assert.rejects(
        fixture.authority.releaseWorkspaceAdmission({
          workspaceId: WORKSPACE_ID,
          admissionId: 'adm_r08',
        }),
        isAuthorityError('ADMISSION_NOT_RELEASABLE'),
      );
      assert.equal(fixture.admissions.findById(WORKSPACE_ID, 'adm_r08')?.state, 'GRANTED');
    } finally { fixture.close(); }
  });
});

interface ConcurrentChild {
  readonly ready: Promise<void>;
  readonly result: Promise<{ readonly ok: boolean; readonly granted: string[]; readonly error?: string }>;
  release(): void;
}

function startConcurrentAdvanceChild(databasePath: string): ConcurrentChild {
  const source = `
    import { createRequire } from 'node:module';
    import { WorkspaceAdmissionAuthority } from './src/services/WorkspaceAdmissionAuthority.ts';
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const db = new DatabaseSync(process.env.L1D_DATABASE_PATH);
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    const waitForRelease = () => new Promise(resolve => process.stdin.once('data', resolve));
    const authority = new WorkspaceAdmissionAuthority({
      store: { getDatabase: () => db },
      now: () => new Date('${NOW}'),
      testHooks: {
        afterEvidenceCollectionOutsideTransaction: async () => {
          process.stdout.write('READY\\n');
          await waitForRelease();
        },
      },
    });
    try {
      const result = await authority.advanceWorkspaceAdmissions('${WORKSPACE_ID}');
      process.stdout.write('RESULT ' + JSON.stringify({ ok: true, granted: result.map(item => item.admissionId) }) + '\\n');
    } catch (error) {
      process.stdout.write('RESULT ' + JSON.stringify({ ok: false, granted: [], error: error instanceof Error ? error.message : 'UNKNOWN' }) + '\\n');
    } finally {
      db.close();
    }
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
    cwd: process.cwd(),
    env: { ...process.env, L1D_DATABASE_PATH: databasePath },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let readyResolved = false;
  let resolveReady!: () => void;
  const ready = new Promise<void>(resolve => { resolveReady = resolve; });
  child.stdout.on('data', chunk => {
    stdout += String(chunk);
    if (!readyResolved && stdout.includes('READY\n')) {
      readyResolved = true;
      resolveReady();
    }
  });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const result = new Promise<{ ok: boolean; granted: string[]; error?: string }>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`L1D concurrent child exited ${code}: ${stderr || stdout}`));
        return;
      }
      const line = stdout.split(/\r?\n/).find(candidate => candidate.startsWith('RESULT '));
      if (line === undefined) {
        reject(new Error(`L1D concurrent child returned no result: ${stderr || stdout}`));
        return;
      }
      try {
        resolve(JSON.parse(line.slice('RESULT '.length)) as { ok: boolean; granted: string[]; error?: string });
      } catch (error) {
        reject(new Error(`L1D concurrent child returned invalid JSON: ${line}`, { cause: error }));
      }
    });
  });
  return {
    ready,
    result,
    release: () => { child.stdin.end('GO\n'); },
  };
}

async function runTwoConcurrentAdvancers(databasePath: string) {
  const first = startConcurrentAdvanceChild(databasePath);
  const second = startConcurrentAdvanceChild(databasePath);
  await Promise.all([first.ready, second.ready]);
  first.release();
  second.release();
  return Promise.all([first.result, second.result]);
}

describe('WorkspaceAdmissionAuthority integration contract', () => {
  test('L1D-I01 one MODIFYING request becomes GRANTED', async () => {
    const fixture = createFixture();
    try {
      seedAdmission(fixture, { id: 'adm_i01', order: 1 });
      const granted = await fixture.authority.advanceWorkspaceAdmissions(WORKSPACE_ID);
      assert.deepEqual(granted.map(item => item.admissionId), ['adm_i01']);
      assert.equal(fixture.admissions.findById(WORKSPACE_ID, 'adm_i01')?.state, 'GRANTED');
    } finally { fixture.close(); }
  });

  test('L1D-I02 a second MODIFYING request remains QUEUED', async () => {
    const fixture = createFixture();
    try {
      seedAdmission(fixture, { id: 'adm_i02_first', order: 1 });
      seedAdmission(fixture, { id: 'adm_i02_second', order: 2 });
      await fixture.authority.advanceWorkspaceAdmissions(WORKSPACE_ID);
      assert.deepEqual(states(fixture), { adm_i02_first: 'GRANTED', adm_i02_second: 'QUEUED' });
    } finally { fixture.close(); }
  });

  test('L1D-I03 releasing the first writer advances the second writer', async () => {
    const fixture = createFixture();
    try {
      seedAdmission(fixture, { id: 'adm_i03_first', order: 1, state: 'GRANTED', runStatus: 'completed' });
      seedAdmission(fixture, { id: 'adm_i03_second', order: 2 });
      const granted = await fixture.authority.releaseWorkspaceAdmission({
        workspaceId: WORKSPACE_ID,
        admissionId: 'adm_i03_first',
      });
      assert.deepEqual(granted.map(item => item.admissionId), ['adm_i03_second']);
      assert.deepEqual(states(fixture), { adm_i03_first: 'RELEASED', adm_i03_second: 'GRANTED' });
    } finally { fixture.close(); }
  });

  test('L1D-I04 contiguous head readers batch-grant to V1 capacity', async () => {
    const fixture = createFixture();
    try {
      seedAdmission(fixture, { id: 'adm_i04_1', order: 1, requested: 'READ_ONLY', effective: 'MODIFYING' });
      seedAdmission(fixture, { id: 'adm_i04_2', order: 2, requested: 'READ_ONLY', effective: 'MODIFYING' });
      const granted = await fixture.authority.advanceWorkspaceAdmissions(WORKSPACE_ID);
      assert.deepEqual(granted.map(item => item.admissionId), ['adm_i04_1', 'adm_i04_2']);
    } finally { fixture.close(); }
  });

  test('L1D-I05 a reader over V1 capacity remains QUEUED', async () => {
    const fixture = createFixture();
    try {
      for (let order = 1; order <= 3; order += 1) {
        seedAdmission(fixture, { id: `adm_i05_${order}`, order, requested: 'READ_ONLY', effective: 'MODIFYING' });
      }
      await fixture.authority.advanceWorkspaceAdmissions(WORKSPACE_ID);
      assert.equal(fixture.admissions.findById(WORKSPACE_ID, 'adm_i05_3')?.state, 'QUEUED');
    } finally { fixture.close(); }
  });

  test('L1D-I06 real competing processes produce exactly one MODIFYING winner', async () => {
    const fixture = createFixture({ fileBacked: true });
    seedAdmission(fixture, { id: 'adm_i06_first', order: 1 });
    seedAdmission(fixture, { id: 'adm_i06_second', order: 2 });
    fixture.db.close();
    try {
      const results = await runTwoConcurrentAdvancers(fixture.databasePath);
      assert.equal(results.filter(result => result.ok).length, 2);
      assert.equal(results.flatMap(result => result.granted).length, 1);
      const db = new DatabaseSync(fixture.databasePath);
      try {
        const granted = new WorkspaceAdmissionRepository(db).listByWorkspace(WORKSPACE_ID)
          .filter(row => row.state === 'GRANTED' && row.effectiveMutationClass === 'MODIFYING');
        assert.deepEqual(granted.map(row => row.id), ['adm_i06_first']);
      } finally { db.close(); }
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('L1D-I07 concurrent advancement cannot double-grant readers', async () => {
    const fixture = createFixture({ fileBacked: true });
    for (let order = 1; order <= 3; order += 1) {
      const id = `adm_i07_${order}`;
      const runId = `run_${id}`;
      seedAdmission(fixture, {
        id,
        order,
        requested: 'READ_ONLY',
        effective: 'READ_ONLY',
        evidenceJson: evidenceEnvelopeJson({ admissionId: id, runId, observedAt: NOW, validUntil: FUTURE }),
      });
    }
    fixture.db.close();
    try {
      const results = await runTwoConcurrentAdvancers(fixture.databasePath);
      assert.equal(results.filter(result => result.ok).length, 2);
      assert.equal(results.flatMap(result => result.granted).length, 2);
      const db = new DatabaseSync(fixture.databasePath);
      try {
        const rows = new WorkspaceAdmissionRepository(db).listByWorkspace(WORKSPACE_ID);
        assert.equal(rows.filter(row => row.state === 'GRANTED').length, 2);
        assert.equal(rows.find(row => row.id === 'adm_i07_3')?.state, 'QUEUED');
      } finally { db.close(); }
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('L1D-I09 a running Run cannot release a GRANTED admission', async () => {
    const fixture = createFixture();
    try {
      seedAdmission(fixture, { id: 'adm_i09', order: 1, state: 'GRANTED', runStatus: 'running' });
      await assert.rejects(
        fixture.authority.releaseWorkspaceAdmission({ workspaceId: WORKSPACE_ID, admissionId: 'adm_i09' }),
        isAuthorityError('ADMISSION_NOT_RELEASABLE'),
      );
    } finally { fixture.close(); }
  });

  test('L1D-I10 a committed terminal Run releases its admission', async () => {
    const fixture = createFixture();
    try {
      seedAdmission(fixture, { id: 'adm_i10', order: 1, state: 'GRANTED', runStatus: 'completed' });
      await fixture.authority.releaseWorkspaceAdmission({ workspaceId: WORKSPACE_ID, admissionId: 'adm_i10' });
      assert.equal(fixture.admissions.findById(WORKSPACE_ID, 'adm_i10')?.state, 'RELEASED');
    } finally { fixture.close(); }
  });

  test('L1D-I11 MISSING without a terminal Run cannot release', async () => {
    const fixture = createFixture();
    try {
      const runId = seedAdmission(fixture, { id: 'adm_i11', order: 1, state: 'GRANTED', runStatus: 'running' });
      seedMissingProcess(fixture.db, runId);
      await assert.rejects(
        fixture.authority.releaseWorkspaceAdmission({ workspaceId: WORKSPACE_ID, admissionId: 'adm_i11' }),
        isAuthorityError('ADMISSION_NOT_RELEASABLE'),
      );
      assert.equal(fixture.admissions.findById(WORKSPACE_ID, 'adm_i11')?.state, 'GRANTED');
    } finally { fixture.close(); }
  });

  test('L1D-I12 MISSING plus committed terminal failure permits release', async () => {
    const fixture = createFixture();
    try {
      const runId = seedAdmission(fixture, { id: 'adm_i12', order: 1, state: 'GRANTED', runStatus: 'running' });
      seedMissingProcess(fixture.db, runId);
      fixture.db.prepare(
        "UPDATE runs SET status = 'failed', failure_code = 'RUN_PROCESS_MISSING', completed_at = ?, updated_at = ?, version = version + 1"
          + ' WHERE workspace_id = ? AND id = ?',
      ).run(NOW, NOW, WORKSPACE_ID, runId);

      await fixture.authority.releaseWorkspaceAdmission({ workspaceId: WORKSPACE_ID, admissionId: 'adm_i12' });

      const row = fixture.admissions.findById(WORKSPACE_ID, 'adm_i12');
      assert.equal(row?.state, 'RELEASED');
      assert.equal(row?.releaseReason, 'RUN_PROCESS_MISSING_TERMINAL');
    } finally { fixture.close(); }
  });

  test('L1D-I13 stale evidence is authoritatively replaced before grant', async () => {
    const fixture = createFixture();
    try {
      const runId = `run_adm_i13`;
      const stale = evidenceEnvelopeJson({ admissionId: 'adm_i13', runId, validUntil: PAST });
      seedAdmission(fixture, {
        id: 'adm_i13',
        order: 1,
        requested: 'READ_ONLY',
        effective: 'READ_ONLY',
        evidenceJson: stale,
      });

      await fixture.authority.advanceWorkspaceAdmissions(WORKSPACE_ID);

      const row = fixture.admissions.findById(WORKSPACE_ID, 'adm_i13');
      assert.equal(row?.state, 'GRANTED');
      assert.equal(row?.effectiveMutationClass, 'READ_ONLY');
      assert.notEqual(row?.enforcementEvidenceJson, stale);
      assert.match(row?.enforcementEvidenceJson ?? '', new RegExp(FUTURE.replaceAll('.', '\\.')));
    } finally { fixture.close(); }
  });

  test('L1D-I14 a failure after release and grant writes rolls the whole transaction back', async () => {
    let writes = 0;
    const fixture = createFixture({
      testHooks: {
        afterAdmissionWriteWithinTransaction: () => {
          writes += 1;
          if (writes === 2) throw new Error('injected database failure with private path C:/secret');
        },
      },
    });
    try {
      seedAdmission(fixture, { id: 'adm_i14_first', order: 1, state: 'GRANTED', runStatus: 'completed' });
      seedAdmission(fixture, { id: 'adm_i14_second', order: 2 });
      const before = fixture.admissions.listByWorkspace(WORKSPACE_ID);

      await assert.rejects(
        fixture.authority.releaseWorkspaceAdmission({ workspaceId: WORKSPACE_ID, admissionId: 'adm_i14_first' }),
        isAuthorityError('PERSISTENCE_FAILED'),
      );

      assert.deepEqual(fixture.admissions.listByWorkspace(WORKSPACE_ID), before);
    } finally { fixture.close(); }
  });

  test('L1D-I15 a new service instance recovers the same durable authority state', async () => {
    const fixture = createFixture({ fileBacked: true });
    seedAdmission(fixture, { id: 'adm_i15_first', order: 1 });
    seedAdmission(fixture, { id: 'adm_i15_second', order: 2 });
    await fixture.authority.advanceWorkspaceAdmissions(WORKSPACE_ID);
    fixture.db.close();
    let restarted: Db | undefined;
    try {
      restarted = new DatabaseSync(fixture.databasePath);
      restarted.exec('PRAGMA foreign_keys = ON');
      restarted.exec('PRAGMA busy_timeout = 5000');
      const authority = new WorkspaceAdmissionAuthority({
        store: { getDatabase: () => restarted! },
        now: () => new Date(NOW),
      });

      assert.deepEqual(
        new WorkspaceAdmissionRepository(restarted).listByWorkspace(WORKSPACE_ID).map(row => row.state),
        ['GRANTED', 'QUEUED'],
      );
      assert.deepEqual(await authority.advanceWorkspaceAdmissions(WORKSPACE_ID), []);
    } finally {
      restarted?.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('L1D-I16 canonical and legacy subjects share one FIFO and release authority', async () => {
    const fixture = createFixture();
    try {
      seedLegacyAdmission(fixture, {
        id: 'adm_i16_legacy',
        order: 1,
        runStatus: 'completed',
        state: 'GRANTED',
      });
      seedAdmission(fixture, { id: 'adm_i16_canonical', order: 2 });

      const granted = await fixture.authority.releaseWorkspaceAdmission({
        workspaceId: WORKSPACE_ID,
        admissionId: 'adm_i16_legacy',
      });

      assert.deepEqual(granted, [{
        admissionId: 'adm_i16_canonical',
        workspaceId: WORKSPACE_ID,
        subjectKind: 'CANONICAL_RUN',
        canonicalRunId: 'run_adm_i16_canonical',
      }]);
      assert.deepEqual(states(fixture), {
        adm_i16_legacy: 'RELEASED',
        adm_i16_canonical: 'GRANTED',
      });
    } finally { fixture.close(); }
  });
});
