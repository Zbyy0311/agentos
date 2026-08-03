import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

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

import type {
  RunSnapshotPayload,
  RunSnapshotPayloadV1,
  RunSnapshotPayloadV2,
  V2RunOrigin,
  V2RunReason,
} from '@agentos/shared';
import { MigrationRegistry } from '../migrations/registry.js';
import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import {
  M3_013_LEGACY_DEFINITION_HASH,
  M3_013_LEGACY_WORKFLOW_KEY,
  M3_013_LEGACY_WORKFLOW_V2_ID,
} from '../migrations/migrations/013-workflow-creation-metadata-v2.js';
import {
  M25_UNBOUND_DEFINITION_HASH,
  M25_UNBOUND_DEFINITION_KEY,
  M25_UNBOUND_DEFINITION_NAME,
  M25_UNBOUND_WORKFLOW_ID,
} from '../migrations/migrations/007-workflow-definitions.js';
import { canonicalizeJson, hashCanonicalJson } from '../snapshots/canonicalJson.js';
import { inTransaction } from './Transaction.js';
import {
  RunSnapshotIntegrityError,
  RunSnapshotRepository,
  RunSnapshotValidationError,
} from './RunSnapshotRepository.js';

type Db = InstanceType<typeof DatabaseSync>;

const HASH64 = 'a'.repeat(64);
const NOW = '2026-01-01T00:00:00.000Z';

function migratedDb(): Db {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner(db, new MigrationRegistry([...DEFAULT_REGISTRY_MIGRATIONS])).run();
  seedRun(db, 'ws_snapshot', 'task_snapshot', 'run_snapshot');
  return db;
}

function seedRun(
  db: Db,
  workspaceId: string,
  taskId: string,
  runId: string,
  origin: V2RunOrigin = 'v2_api',
  reason: V2RunReason = 'initial',
  parentRunId: string | null = null,
  rootRunId = runId,
): void {
  db.prepare(`
    INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(workspaceId, workspaceId, `/${workspaceId}`, `/${workspaceId}`, NOW, NOW, NOW);
  db.prepare(`
    INSERT INTO tasks (id, workspace_id, legacy_task_id, title, status, priority, created_by, created_at, updated_at)
    VALUES (?, ?, NULL, 'Snapshot Task', 'open', 'normal', 'test', ?, ?)
  `).run(taskId, workspaceId, NOW, NOW);
  db.prepare(`
    INSERT INTO runs (id, workspace_id, task_id, parent_run_id, root_run_id, status, reason, origin, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, 'test', ?, ?)
  `).run(runId, workspaceId, taskId, parentRunId, rootRunId, reason, origin, NOW, NOW);
}

function samplePayload(overrides: {
  workspaceId?: string;
  taskId?: string;
  origin?: V2RunOrigin;
  reason?: V2RunReason;
  parentRunId?: string | null;
  rootRunId?: string;
} = {}): RunSnapshotPayloadV1 {
  return {
    schemaVersion: 1,
    capturedAt: '2026-01-01T00:00:00.000Z',
    run: {
      workspaceId: overrides.workspaceId ?? 'ws_snapshot',
      taskId: overrides.taskId ?? 'task_snapshot',
      origin: overrides.origin ?? 'v2_api',
      reason: overrides.reason ?? 'initial',
      parentRunId: overrides.parentRunId === undefined ? null : overrides.parentRunId,
      rootRunId: overrides.rootRunId ?? 'run_snapshot',
    },
    workflow: {
      definitionId: M25_UNBOUND_WORKFLOW_ID,
      definitionKey: M25_UNBOUND_DEFINITION_KEY,
      definitionVersion: 1,
      name: M25_UNBOUND_DEFINITION_NAME,
      definitionHash: M25_UNBOUND_DEFINITION_HASH,
      stages: [],
    },
    security: { redactionApplied: false },
  };
}

function clonePayload(payload: RunSnapshotPayloadV1): RunSnapshotPayloadV1 {
  return JSON.parse(JSON.stringify(payload)) as RunSnapshotPayloadV1;
}

function sampleStage(): RunSnapshotPayloadV1['workflow']['stages'][number] {
  return {
    workflowStageKey: 'codex_manager',
    name: 'codex_manager',
    sequence: 1,
    agent: {
      agentId: 'agent_snapshot',
      name: 'Snapshot Agent',
      role: 'codex',
      roleTitle: 'Manager',
      systemPrompt: 'Use the snapshot fixture.',
      permissions: ['read', 'write', 'review'],
      providerConfigId: 'provider_snapshot',
      enabled: true,
      version: 1,
    },
    provider: {
      providerConfigId: 'provider_snapshot',
      name: 'Snapshot Provider',
      providerType: 'codex',
      adapterId: 'codex-cli',
      runtimeMode: 'cli',
      executable: 'codex',
      argsTemplate: [],
      model: null,
      environmentProfileId: null,
      secretProfileId: null,
      workingDirectoryMode: 'workspace',
      workspaceRelativeWorkingDirectory: null,
      capabilities: {
        sessionResume: true,
        structuredEvents: true,
        nativeApprovals: true,
        subagents: true,
        toolEvents: true,
        fileEvents: true,
        usageEvents: true,
        reasoningStream: true,
        interactiveInput: true,
        pause: true,
        cancellation: true,
        modelSelection: true,
        workspaceAwareness: true,
        nativeSandbox: true,
        outputContracts: true,
      },
      timeoutPolicy: {
        discoveryTimeoutMs: 1,
        validationTimeoutMs: 2,
        startupTimeoutMs: 3,
        idleTimeoutMs: null,
        totalTimeoutMs: null,
        cancelGracePeriodMs: 4,
        approvalTimeoutMs: null,
      },
      approvalMode: 'agentos',
      outputMode: 'structured',
      enabled: true,
      version: 1,
    },
  };
}

function samplePayloadWithStage(): RunSnapshotPayloadV1 {
  const payload = samplePayload();
  payload.workflow.stages = [sampleStage()];
  return payload;
}

function sampleV2Payload(): RunSnapshotPayloadV2 {
  const stage = sampleStage();
  return {
    schemaVersion: 2,
    capturedAt: NOW,
    run: {
      workspaceId: 'ws_snapshot',
      taskId: 'task_snapshot',
      origin: 'v2_api',
      reason: 'initial',
      parentRunId: null,
      rootRunId: 'run_snapshot',
    },
    workflow: {
      definitionId: M3_013_LEGACY_WORKFLOW_V2_ID,
      definitionKey: M3_013_LEGACY_WORKFLOW_KEY,
      definitionVersion: 2,
      name: 'legacy-pipeline-v2',
      definitionHash: M3_013_LEGACY_DEFINITION_HASH,
      worktreeMode: 'preferred',
      stages: [
        { ...stage, workflowStageKey: 'codex_manager', name: 'codex_manager', sequence: 1, dependsOn: [] },
        { ...stage, workflowStageKey: 'kimi_worker', name: 'kimi_worker', sequence: 2, dependsOn: ['codex_manager'] },
        { ...stage, workflowStageKey: 'opencode_reviewer', name: 'opencode_reviewer', sequence: 3, dependsOn: ['kimi_worker'] },
        { ...stage, workflowStageKey: 'codex_final_review', name: 'codex_final_review', sequence: 4, dependsOn: ['opencode_reviewer'] },
      ],
    },
    security: { redactionApplied: false },
  };
}

function insertSnapshot(repository: RunSnapshotRepository, payload = samplePayload()) {
  return repository.insert({
    workspaceId: 'ws_snapshot',
    runId: 'run_snapshot',
    workflowDefinitionId: M25_UNBOUND_WORKFLOW_ID,
    payload,
  });
}

function cloneV2Payload(payload: RunSnapshotPayloadV2): RunSnapshotPayloadV2 {
  return JSON.parse(JSON.stringify(payload)) as RunSnapshotPayloadV2;
}

function insertRawSnapshot(
  db: Db,
  payload: RunSnapshotPayload,
  workflowDefinitionId: string,
  id = 'snapshot_00000000000000000000000001',
): void {
  const snapshotJson = canonicalizeJson(payload);
  db.prepare(`
    INSERT INTO run_snapshots (
      id, workspace_id, run_id, workflow_definition_id, snapshot_schema_version,
      snapshot_json, content_hash, redaction_applied, captured_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    'ws_snapshot',
    'run_snapshot',
    workflowDefinitionId,
    payload.schemaVersion,
    snapshotJson,
    hashCanonicalJson(payload),
    payload.security.redactionApplied ? 1 : 0,
    payload.capturedAt,
  );
}

function assertValidation(fn: () => unknown, message?: string): void {
  assert.throws(fn, (error: unknown) => (
    error instanceof RunSnapshotValidationError
    && error.code === 'RUN_SNAPSHOT_VALIDATION_FAILED'
  ), message);
}

describe('RunSnapshotRepository', () => {
  it('rejects extra top-level, stage, agent, provider and security fields', () => {
    const topLevel = samplePayloadWithStage();
    (topLevel as unknown as Record<string, unknown>).secret = 'must-not-persist';
    const cases: Array<() => RunSnapshotPayloadV1> = [
      () => topLevel,
      () => {
        const payload = samplePayloadWithStage();
        (payload.workflow.stages[0] as unknown as Record<string, unknown>).secret = 'must-not-persist';
        return payload;
      },
      () => {
        const payload = samplePayloadWithStage();
        (payload.workflow.stages[0].agent as unknown as Record<string, unknown>).token = 'must-not-persist';
        return payload;
      },
      () => {
        const payload = samplePayloadWithStage();
        (payload.workflow.stages[0].provider as unknown as Record<string, unknown>).token = 'must-not-persist';
        return payload;
      },
      () => {
        const payload = samplePayloadWithStage();
        (payload.security as unknown as Record<string, unknown>).secret = 'must-not-persist';
        return payload;
      },
    ];
    for (const makePayload of cases) {
      const db = migratedDb();
      try {
        assertValidation(() => insertSnapshot(new RunSnapshotRepository(db), makePayload()));
      } finally {
        db.close();
      }
    }
  });

  it('rejects forbidden provider fields', () => {
    for (const field of [
      'customWorkingDirectory',
      'environment',
      'authorization',
      'cookie',
      'apiKey',
      'resolvedCommand',
    ]) {
      const db = migratedDb();
      try {
        const payload = samplePayloadWithStage();
        (payload.workflow.stages[0].provider as unknown as Record<string, unknown>)[field] = 'must-not-persist';
        assertValidation(() => insertSnapshot(new RunSnapshotRepository(db), payload));
      } finally {
        db.close();
      }
    }
  });

  it('rejects invalid nested V1 shape and bindings', () => {
    const mutations: Array<(payload: RunSnapshotPayloadV1) => void> = [
      (payload) => { payload.workflow.stages[0].workflowStageKey = ''; },
      (payload) => { payload.workflow.stages[0].workflowStageKey = ' codex_manager'; },
      (payload) => { payload.workflow.stages[0].name = 'different-name'; },
      (payload) => {
        payload.workflow.stages.push({ ...sampleStage(), sequence: 2 });
      },
      (payload) => {
        payload.workflow.stages.push({ ...sampleStage(), workflowStageKey: 'other', name: 'other' });
      },
      (payload) => { payload.workflow.stages[0].sequence = 0; },
      (payload) => { payload.workflow.stages[0].sequence = 1.5; },
      (payload) => { payload.workflow.stages[0].agent = null; },
      (payload) => { payload.workflow.stages[0].provider = null; },
      (payload) => {
        (payload.workflow.stages[0].agent as { providerConfigId: string }).providerConfigId = 'other-provider';
      },
      (payload) => {
        (payload.workflow.stages[0].agent as { role: string }).role = 'invalid-role';
      },
      (payload) => {
        (payload.workflow.stages[0].agent as { permissions: string[] }).permissions = ['execute'];
      },
      (payload) => {
        delete (payload.workflow.stages[0].provider?.capabilities as unknown as Record<string, unknown>).pause;
      },
      (payload) => {
        (payload.workflow.stages[0].provider?.capabilities as unknown as Record<string, unknown>).unexpected = true;
      },
      (payload) => {
        (payload.workflow.stages[0].provider?.capabilities as unknown as Record<string, unknown>).pause = 'yes';
      },
      (payload) => {
        delete (payload.workflow.stages[0].provider?.timeoutPolicy as unknown as Record<string, unknown>).startupTimeoutMs;
      },
      (payload) => {
        (payload.workflow.stages[0].provider?.timeoutPolicy as unknown as Record<string, unknown>).unexpected = 1;
      },
      (payload) => {
        (payload.workflow.stages[0].provider?.timeoutPolicy as unknown as Record<string, unknown>).startupTimeoutMs = -1;
      },
      (payload) => {
        (payload.workflow.stages[0].provider as unknown as Record<string, unknown>).providerType = 'unknown';
      },
      (payload) => {
        (payload.workflow.stages[0].provider as unknown as Record<string, unknown>).argsTemplate = [null];
      },
      (payload) => {
        (payload.workflow.stages[0].provider as unknown as Record<string, unknown>).workspaceRelativeWorkingDirectory = '/absolute/path';
      },
      (payload) => {
        (payload.workflow.stages[0].provider as unknown as Record<string, unknown>).workspaceRelativeWorkingDirectory = 'C:\\absolute\\path';
      },
      (payload) => {
        (payload.workflow.stages[0].provider as unknown as Record<string, unknown>).workspaceRelativeWorkingDirectory = '\\\\server\\share';
      },
      (payload) => {
        (payload.workflow.stages[0].provider as unknown as Record<string, unknown>).workspaceRelativeWorkingDirectory = 'nested/../../escape';
      },
      (payload) => {
        delete (payload.workflow.stages[0].provider as unknown as Record<string, unknown>).model;
      },
      (payload) => { payload.workflow.definitionVersion = 0; },
      (payload) => { payload.workflow.definitionHash = 'A'.repeat(64); },
    ];
    for (const mutate of mutations) {
      const db = migratedDb();
      try {
        const payload = samplePayloadWithStage();
        mutate(payload);
        assertValidation(() => insertSnapshot(new RunSnapshotRepository(db), payload));
      } finally {
        db.close();
      }
    }
  });

  it('rejects Windows root-relative and drive-relative working directories', () => {
    const invalidPaths = [
      String.raw`\Windows\Temp`,
      'C:outside-workspace',
      String.raw`D:folder\file`,
      'C:',
    ];
    for (const directory of invalidPaths) {
      const db = migratedDb();
      try {
        const payload = samplePayloadWithStage();
        (payload.workflow.stages[0].provider as unknown as Record<string, unknown>).workspaceRelativeWorkingDirectory = directory;
        assertValidation(() => insertSnapshot(new RunSnapshotRepository(db), payload));
      } finally {
        db.close();
      }
    }
  });

  it('accepts valid workspace-relative working directories', () => {
    const validPaths = [
      'nested/subdirectory',
      String.raw`nested\subdirectory`,
      '.',
      'config',
      'config/file.txt',
    ];
    for (const directory of validPaths) {
      const db = migratedDb();
      try {
        const payload = samplePayloadWithStage();
        (payload.workflow.stages[0].provider as unknown as Record<string, unknown>).workspaceRelativeWorkingDirectory = directory;
        const snapshot = insertSnapshot(new RunSnapshotRepository(db), payload);
        assert.equal(
          (snapshot.payload.workflow.stages[0].provider as unknown as Record<string, unknown>).workspaceRelativeWorkingDirectory,
          directory,
        );
        assert.equal(
          (new RunSnapshotRepository(db).findByRunId('ws_snapshot', 'run_snapshot')?.payload.workflow.stages[0].provider as unknown as Record<string, unknown>).workspaceRelativeWorkingDirectory,
          directory,
        );
      } finally {
        db.close();
      }
    }
  });

  it('fails closed on read for root-relative and drive-relative working directories', () => {
    const invalidPaths = [String.raw`\Windows\Temp`, 'C:outside-workspace'];
    for (const directory of invalidPaths) {
      const db = migratedDb();
      try {
        const repository = new RunSnapshotRepository(db);
        const payload = samplePayloadWithStage();
        const snapshot = insertSnapshot(repository, payload);
        const tampered = clonePayload(payload);
        (tampered.workflow.stages[0].provider as unknown as Record<string, unknown>).workspaceRelativeWorkingDirectory = directory;
        const snapshotJson = canonicalizeJson(tampered);
        const snapshotHash = hashCanonicalJson(tampered);
        db.prepare('DELETE FROM run_snapshots WHERE id = ?').run(snapshot.id);
        db.prepare(`
          INSERT INTO run_snapshots (
            id, workspace_id, run_id, workflow_definition_id, snapshot_schema_version,
            snapshot_json, content_hash, redaction_applied, captured_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(snapshot.id, 'ws_snapshot', 'run_snapshot', M25_UNBOUND_WORKFLOW_ID, 1, snapshotJson, snapshotHash, 0, payload.capturedAt);
        assert.throws(
          () => repository.findByRunId('ws_snapshot', 'run_snapshot'),
          (error: unknown) => error instanceof RunSnapshotIntegrityError
            && !error.message.includes(directory),
        );
      } finally {
        db.close();
      }
    }
  });

  it('rejects symbol, accessor, non-enumerable and sparse runtime values', () => {
    const mutations: Array<(payload: RunSnapshotPayloadV1) => void> = [
      (payload) => {
        Object.defineProperty(payload, Symbol('secret'), { value: 'must-not-persist', enumerable: true });
      },
      (payload) => {
        Object.defineProperty(payload, 'capturedAt', {
          configurable: true,
          enumerable: true,
          get: () => '2026-01-01T00:00:00.000Z',
        });
      },
      (payload) => {
        Object.defineProperty(payload.workflow.stages[0].provider, 'model', {
          configurable: true,
          enumerable: false,
          value: null,
        });
      },
      (payload) => {
        (payload.workflow.stages[0].provider as unknown as Record<string, unknown>).argsTemplate = new Array(1);
      },
      (payload) => {
        const stages = [sampleStage()] as RunSnapshotPayloadV1['workflow']['stages'] & { extra?: unknown };
        stages.extra = true;
        payload.workflow.stages = stages;
      },
    ];
    for (const mutate of mutations) {
      const db = migratedDb();
      try {
        const payload = samplePayloadWithStage();
        mutate(payload);
        assertValidation(() => insertSnapshot(new RunSnapshotRepository(db), payload));
      } finally {
        db.close();
      }
    }
  });

  it('insert/read round-trip stores canonical JSON and the correct hash', () => {
    const db = migratedDb();
    try {
      const repository = new RunSnapshotRepository(db);
      const payload = samplePayload();
      const snapshot = insertSnapshot(repository, payload);
      const row = db.prepare(
        'SELECT id, snapshot_json, content_hash, redaction_applied FROM run_snapshots WHERE run_id = ?',
      ).get('run_snapshot') as { id: string; snapshot_json: string; content_hash: string; redaction_applied: number };
      assert.match(snapshot.id, /^snapshot_[0-9A-HJKMNP-TV-Z]{26}$/);
      assert.deepEqual(snapshot.payload, payload);
      const stored = repository.findByRunId('ws_snapshot', 'run_snapshot');
      assert.ok(stored);
      if (stored.payload.schemaVersion !== 1) throw new Error('expected a V1 Snapshot');
      assert.deepEqual(stored.payload, payload);
      assert.equal(row.snapshot_json, canonicalizeJson(payload));
      assert.equal(row.content_hash, hashCanonicalJson(payload));
      assert.equal(row.redaction_applied, 0);
    } finally {
      db.close();
    }
  });

  it('accepts and verifies a V2 Snapshot with frozen worktreeMode and dependsOn metadata', () => {
    const db = migratedDb();
    try {
      const repository = new RunSnapshotRepository(db);
      const payload = sampleV2Payload();
      const snapshot = repository.insert({
        workspaceId: 'ws_snapshot',
        runId: 'run_snapshot',
        workflowDefinitionId: M3_013_LEGACY_WORKFLOW_V2_ID,
        payload,
      });
      const stored = repository.findByRunId('ws_snapshot', 'run_snapshot');
      assert.ok(stored);
      if (stored.payload.schemaVersion !== 2) throw new Error('expected a V2 Snapshot');
      assert.equal(stored.payload.workflow.worktreeMode, 'preferred');
      assert.deepEqual(stored.payload.workflow.stages.map(stage => stage.dependsOn), [
        [], ['codex_manager'], ['kimi_worker'], ['opencode_reviewer'],
      ]);
      assert.equal(repository.verifyHash(snapshot), true);
      assert.equal(
        (db.prepare('SELECT snapshot_schema_version FROM run_snapshots WHERE run_id = ?').get('run_snapshot') as { snapshot_schema_version: number }).snapshot_schema_version,
        2,
      );
    } finally {
      db.close();
    }
  });

  it('rejects V2 inserts whose workflow metadata does not match the referenced Workflow V2', () => {
    const mutations: Array<[string, (payload: RunSnapshotPayloadV2) => void]> = [
      ['worktreeMode', payload => { payload.workflow.worktreeMode = 'disabled'; }],
      ['dependsOn', payload => { payload.workflow.stages[1]!.dependsOn = []; }],
      ['missing stage', payload => { payload.workflow.stages.pop(); }],
      ['additional stage', payload => {
        payload.workflow.stages.push({
          ...payload.workflow.stages[3]!,
          workflowStageKey: 'extra_stage',
          name: 'extra_stage',
          sequence: 5,
          dependsOn: ['codex_final_review'],
        });
      }],
      ['reordered stages', payload => {
        payload.workflow.stages = [
          payload.workflow.stages[1]!,
          payload.workflow.stages[0]!,
          payload.workflow.stages[2]!,
          payload.workflow.stages[3]!,
        ];
      }],
    ];
    for (const [label, mutate] of mutations) {
      const db = migratedDb();
      try {
        const payload = cloneV2Payload(sampleV2Payload());
        mutate(payload);
        assertValidation(() => new RunSnapshotRepository(db).insert({
          workspaceId: 'ws_snapshot',
          runId: 'run_snapshot',
          workflowDefinitionId: M3_013_LEGACY_WORKFLOW_V2_ID,
          payload,
        }), label);
      } finally {
        db.close();
      }
    }
  });

  it('rejects V2 inserts and reads that reference a Workflow V1', () => {
    const db = migratedDb();
    try {
      const payload = cloneV2Payload(sampleV2Payload());
      payload.workflow.definitionId = M25_UNBOUND_WORKFLOW_ID;
      payload.workflow.definitionKey = M25_UNBOUND_DEFINITION_KEY;
      payload.workflow.definitionVersion = 1;
      payload.workflow.name = M25_UNBOUND_DEFINITION_NAME;
      payload.workflow.definitionHash = M25_UNBOUND_DEFINITION_HASH;
      payload.workflow.worktreeMode = 'disabled';
      payload.workflow.stages = [];
      const repository = new RunSnapshotRepository(db);
      assertValidation(() => repository.insert({
        workspaceId: 'ws_snapshot',
        runId: 'run_snapshot',
        workflowDefinitionId: M25_UNBOUND_WORKFLOW_ID,
        payload,
      }), 'insert V2 Snapshot referencing Workflow V1');

      insertRawSnapshot(db, payload, M25_UNBOUND_WORKFLOW_ID);
      assert.throws(
        () => repository.findByRunId('ws_snapshot', 'run_snapshot'),
        (error: unknown) => error instanceof RunSnapshotIntegrityError
          && error.message.includes('V2 Snapshot requires a V2 workflow definition'),
      );
    } finally {
      db.close();
    }
  });

  it('fails closed on read when a V2 Snapshot binding is tampered', () => {
    const mutations: Array<[string, (payload: RunSnapshotPayloadV2) => void]> = [
      ['worktreeMode', payload => { payload.workflow.worktreeMode = 'disabled'; }],
      ['dependsOn', payload => { payload.workflow.stages[1]!.dependsOn = []; }],
      ['missing stage', payload => { payload.workflow.stages.pop(); }],
      ['additional stage', payload => {
        payload.workflow.stages.push({
          ...payload.workflow.stages[3]!,
          workflowStageKey: 'extra_stage',
          name: 'extra_stage',
          sequence: 5,
          dependsOn: ['codex_final_review'],
        });
      }],
      ['reordered stages', payload => {
        payload.workflow.stages = [
          payload.workflow.stages[1]!,
          payload.workflow.stages[0]!,
          payload.workflow.stages[2]!,
          payload.workflow.stages[3]!,
        ];
      }],
    ];
    for (const [label, mutate] of mutations) {
      const db = migratedDb();
      try {
        const payload = cloneV2Payload(sampleV2Payload());
        mutate(payload);
        insertRawSnapshot(db, payload, M3_013_LEGACY_WORKFLOW_V2_ID);
        assert.throws(
          () => new RunSnapshotRepository(db).findByRunId('ws_snapshot', 'run_snapshot'),
          (error: unknown) => error instanceof RunSnapshotIntegrityError
            && error.message.includes('Snapshot stages do not match the referenced workflow')
              || error instanceof RunSnapshotIntegrityError
                && error.message.includes('Snapshot worktreeMode does not match the referenced workflow'),
          label,
        );
      } finally {
        db.close();
      }
    }
  });

  it('findByRunId is workspace-scoped and pre-M2.5 Runs return undefined', () => {
    const db = migratedDb();
    try {
      const repository = new RunSnapshotRepository(db);
      assert.equal(repository.findByRunId('other_workspace', 'run_snapshot'), undefined);
      seedRun(db, 'ws_without_snapshot', 'task_without_snapshot', 'run_without_snapshot');
      assert.equal(repository.findByRunId('ws_without_snapshot', 'run_without_snapshot'), undefined);
    } finally {
      db.close();
    }
  });

  it('keeps one Snapshot per Run enforced by the database', () => {
    const db = migratedDb();
    try {
      const repository = new RunSnapshotRepository(db);
      insertSnapshot(repository);
      assert.throws(() => insertSnapshot(repository));
    } finally {
      db.close();
    }
  });

  it('rejects workspace, task, origin, reason, parent and root metadata mismatches', () => {
    const cases: Array<Partial<Parameters<typeof samplePayload>[0]>> = [
      { workspaceId: 'wrong_workspace' },
      { taskId: 'wrong_task' },
      { origin: 'legacy_pipeline' },
      { reason: 'manual' },
      { parentRunId: 'parent_run' },
      { rootRunId: 'wrong_root' },
    ];
    for (const overrides of cases) {
      const db = migratedDb();
      try {
        assertValidation(() => insertSnapshot(new RunSnapshotRepository(db), samplePayload(overrides)));
      } finally {
        db.close();
      }
    }
  });

  it('requires explicit null for a NULL parent_run_id', () => {
    const db = migratedDb();
    try {
      const repository = new RunSnapshotRepository(db);
      assert.equal(insertSnapshot(repository, samplePayload()).payload.run.parentRunId, null);
      const missing = samplePayload();
      delete (missing.run as unknown as Record<string, unknown>).parentRunId;
      const missingDb = migratedDb();
      try {
        assertValidation(() => insertSnapshot(new RunSnapshotRepository(missingDb), missing));
      } finally {
        missingDb.close();
      }
    } finally {
      db.close();
    }
  });

  it('rejects workflow ID, key, version, name and hash mismatches', () => {
    const fields = [
      (p: RunSnapshotPayloadV1) => { p.workflow.definitionId = 'workflow_wrong'; },
      (p: RunSnapshotPayloadV1) => { p.workflow.definitionKey = 'wrong-key'; },
      (p: RunSnapshotPayloadV1) => { p.workflow.definitionVersion = 2; },
      (p: RunSnapshotPayloadV1) => { p.workflow.name = 'wrong-name'; },
      (p: RunSnapshotPayloadV1) => { p.workflow.definitionHash = HASH64; },
    ];
    for (const mutate of fields) {
      const db = migratedDb();
      try {
        const payload = samplePayload();
        mutate(payload);
        assertValidation(() => insertSnapshot(new RunSnapshotRepository(db), payload));
      } finally {
        db.close();
      }
    }
  });

  it('derives redaction_applied from the payload and reads archived/disabled references', () => {
    const db = migratedDb();
    try {
      db.exec("UPDATE workflow_definitions SET enabled = 0, archived_at = '2026-01-02T00:00:00.000Z' WHERE id = 'workflow_00000000000000000000000002'");
      const payload = samplePayload();
      payload.security.redactionApplied = true;
      const snapshot = insertSnapshot(new RunSnapshotRepository(db), payload);
      assert.equal(snapshot.redactionApplied, true);
      assert.equal(new RunSnapshotRepository(db).findByRunId('ws_snapshot', 'run_snapshot')?.workflowDefinitionId, M25_UNBOUND_WORKFLOW_ID);
    } finally {
      db.close();
    }
  });

  it('verifyHash returns true for the stored payload and false for tampering', () => {
    const db = migratedDb();
    try {
      const repository = new RunSnapshotRepository(db);
      const snapshot = insertSnapshot(repository);
      assert.equal(repository.verifyHash(snapshot), true);
      const tampered = { ...snapshot, payload: clonePayload(snapshot.payload) };
      tampered.payload.security.redactionApplied = true;
      assert.equal(repository.verifyHash(tampered), false);
      const invalid = { ...snapshot, payload: clonePayload(snapshot.payload) };
      (invalid.payload as unknown as Record<string, unknown>).unsupported = 1n;
      assert.equal(repository.verifyHash(invalid), false);
    } finally {
      db.close();
    }
  });

  it('rejects direct SQL hash and metadata tampering without echoing JSON', () => {
    const db = migratedDb();
    try {
      const payload = samplePayload();
      const repository = new RunSnapshotRepository(db);
      const snapshot = insertSnapshot(repository, payload);
      const extraPayload = clonePayload(payload) as unknown as Record<string, unknown>;
      extraPayload.secret = 'sensitive-snapshot-json';
      const snapshotJson = canonicalizeJson(extraPayload);
      const snapshotHash = hashCanonicalJson(extraPayload);
      db.prepare('DELETE FROM run_snapshots WHERE id = ?').run(snapshot.id);
      db.prepare(`
        INSERT INTO run_snapshots (
          id, workspace_id, run_id, workflow_definition_id, snapshot_schema_version,
          snapshot_json, content_hash, redaction_applied, captured_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(snapshot.id, 'ws_snapshot', 'run_snapshot', M25_UNBOUND_WORKFLOW_ID, 1, snapshotJson, snapshotHash, 0, payload.capturedAt);
      assert.throws(
        () => repository.findByRunId('ws_snapshot', 'run_snapshot'),
        (error: unknown) => error instanceof RunSnapshotIntegrityError
          && !error.message.includes('sensitive-snapshot-json'),
      );
      db.prepare('DELETE FROM run_snapshots WHERE id = ?').run(snapshot.id);
      db.prepare(`
        INSERT INTO run_snapshots (
          id, workspace_id, run_id, workflow_definition_id, snapshot_schema_version,
          snapshot_json, content_hash, redaction_applied, captured_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(snapshot.id, 'ws_snapshot', 'run_snapshot', M25_UNBOUND_WORKFLOW_ID, 1, snapshotJson, snapshot.contentHash, 0, 'wrong-time');
      assert.throws(() => repository.findByRunId('ws_snapshot', 'run_snapshot'), RunSnapshotIntegrityError);
    } finally {
      db.close();
    }
  });

  it('fails closed when the source Run changes but keeps historical Workflow availability readable', () => {
    const db = migratedDb();
    try {
      const repository = new RunSnapshotRepository(db);
      insertSnapshot(repository);
      db.prepare('UPDATE runs SET reason = ? WHERE id = ?').run('manual', 'run_snapshot');
      assert.throws(() => repository.findByRunId('ws_snapshot', 'run_snapshot'), RunSnapshotIntegrityError);
    } finally {
      db.close();
    }

    const archivedDb = migratedDb();
    try {
      const repository = new RunSnapshotRepository(archivedDb);
      insertSnapshot(repository);
      archivedDb.prepare(
        "UPDATE workflow_definitions SET enabled = 0, archived_at = '2026-01-02T00:00:00.000Z' WHERE id = ?",
      ).run(M25_UNBOUND_WORKFLOW_ID);
      assert.equal(repository.findByRunId('ws_snapshot', 'run_snapshot')?.workflowDefinitionId, M25_UNBOUND_WORKFLOW_ID);
    } finally {
      archivedDb.close();
    }
  });

  it('does not expose update/delete/upsert/backfill or find-all APIs', () => {
    const names = Object.getOwnPropertyNames(RunSnapshotRepository.prototype);
    for (const forbidden of ['update', 'delete', 'upsert', 'backfill', 'findAll', 'findById']) {
      assert.equal(names.includes(forbidden), false, forbidden);
    }
  });

  it('participates in an external transaction and rolls back with it', () => {
    const db = migratedDb();
    try {
      const repository = new RunSnapshotRepository(db);
      assert.throws(() => inTransaction(db, () => {
        insertSnapshot(repository);
        throw new Error('outer rollback');
      }), /outer rollback/);
      assert.equal(repository.findByRunId('ws_snapshot', 'run_snapshot'), undefined);
    } finally {
      db.close();
    }
  });
});
