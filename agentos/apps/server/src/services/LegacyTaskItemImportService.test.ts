import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { baselineMigration } from '../migrations/migrations/001-baseline-schema.js';
import { migration002 } from '../migrations/migrations/002-add-aggregate-versions.js';
import { migration003 } from '../migrations/migrations/003-workspace-provider-config.js';
import { migration004 } from '../migrations/migrations/004-workspace-tombstones.js';
import { migration011 } from '../migrations/migrations/011-legacy-data-migration-foundation.js';
import { canonicalizeLegacyJson } from './LegacySourceParser.js';
import type { LegacyTaskImportRunInput, LegacyTaskImportSummary } from './LegacyTaskItemImportService.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown; run(...params: unknown[]): unknown };
    close(): void;
  };
};

type Db = InstanceType<typeof DatabaseSync>;
const NOW = '2026-07-30T00:00:00.000Z';

function hash(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function task(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: `Task ${id}`,
    status: 'open',
    priority: 'medium',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function applySchema(db: Db): void {
  db.exec('PRAGMA foreign_keys = ON');
  for (const migration of [baselineMigration, migration002, migration003, migration004]) migration.apply({ db });
  migration011.apply({ db });
}

function writeTasks(root: string, workspaceId: string, tasks: unknown[], rawText?: string): Uint8Array {
  const bytes = Buffer.from(rawText ?? JSON.stringify({ tasks }), 'utf8');
  const dir = join(root, 'workspace', workspaceId, '.agentos');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'tasks.json'), bytes);
  return bytes;
}

function insertCanonicalWorkspace(db: Db, id: string): void {
  db.prepare(`
    INSERT INTO workspaces (id, name, root_path, canonical_root_path, git_enabled, memory_enabled, last_opened_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?)
  `).run(id, `Workspace ${id}`, `C:\\workspaces\\${id}`, `c:\\workspaces\\${id}`, NOW, NOW, NOW);
}

interface Fixture {
  root: string;
  databasePath: string;
  db: Db;
  service: {
    run(input: LegacyTaskImportRunInput): Promise<LegacyTaskImportSummary>;
  };
  backupCalls: { count: number };
  leaseCalls: { count: number };
  releaseCalls: { count: number };
  stages: string[];
  cleanup(): void;
}

async function fixture(options: {
  insertHook?: (task: Record<string, unknown>, index: number) => void;
} = {}): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'agentos-m27-p3-tasks-'));
  mkdirSync(join(root, '.agentos'), { recursive: true });
  const databasePath = join(root, '.agentos', 'agentos.sqlite');
  const db = new DatabaseSync(databasePath);
  applySchema(db);
  const backupCalls = { count: 0 };
  const leaseCalls = { count: 0 };
  const releaseCalls = { count: 0 };
  const stages: string[] = [];
  const { LegacyTaskItemImportService } = await import('./LegacyTaskItemImportService.js');
  const service = new LegacyTaskItemImportService({
    leaseFactory: async () => {
      leaseCalls.count += 1;
      return {
        release: async () => {
          releaseCalls.count += 1;
        },
      };
    },
    databaseFactory: () => new DatabaseSync(databasePath),
    migrationIdFactory: (() => { let n = 0; return () => `p3-migration-${++n}`; })(),
    clock: () => NOW,
    stageProbe: (stage: string) => {
      stages.push(stage);
    },
    backupProvider: {
      createAndVerify: async () => {
        backupCalls.count += 1;
        return {};
      },
    },
    ...(options.insertHook ? { insertHook: options.insertHook } : {}),
  });
  return {
    root,
    databasePath,
    db,
    service,
    backupCalls,
    leaseCalls,
    releaseCalls,
    stages,
    cleanup() {
      try { db.close(); } catch { /* best effort */ }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function runInput(
  fx: { root: string; databasePath: string },
  workspaceId: string,
  mode: 'dry-run' | 'apply' = 'apply',
): LegacyTaskImportRunInput {
  return {
    projectRoot: fx.root,
    sourceRoot: fx.root,
    databasePath: fx.databasePath,
    backupDirectory: join(fx.root, 'backups'),
    kind: 'tasks',
    mode,
    workspaceId,
  };
}

function countRows(db: Db, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

interface RegistryRow {
  status: string;
  attempt: number;
  revision: number | null;
  entity_count: number;
  error_code: string | null;
  source_hash: string;
  payload_hash: string | null;
  migration_kind: string;
}

function registryRows(db: Db): RegistryRow[] {
  return db.prepare(`
    SELECT status, attempt, revision, entity_count, error_code, source_hash, payload_hash, migration_kind
    FROM legacy_data_migrations ORDER BY attempt
  `).all() as RegistryRow[];
}

test('[M27-P3-T001] Valid apply import writes the complete lossless snapshot and Completed Registry atomically', async () => {
  const fx = await fixture();
  try {
    const tasks = [
      task('alpha', {
        description: 'first',
        'x-custom-field': { nested: true },
        outputs: [{ type: 'file', path: 'a.txt' }],
      }),
      task('beta', { workspaceId: 'ws-tasks', body: 'line1\nline2' }),
    ];
    const source = writeTasks(fx.root, 'ws-tasks', tasks);
    const result = await fx.service.run(runInput(fx, 'ws-tasks'));
    assert.deepEqual(result, {
      mode: 'apply',
      kind: 'tasks',
      workspaceId: 'ws-tasks',
      sourceCount: 2,
      validTaskCount: 2,
      completedCount: 1,
      noopCount: 0,
      quarantinedCount: 0,
      importedCount: 2,
      revision: 1,
    });
    assert.equal(fx.backupCalls.count, 1);

    const rows = fx.db.prepare(`
      SELECT workspace_scope_id, canonical_workspace_id, legacy_task_id, revision, payload_hash, payload_json
      FROM legacy_task_items ORDER BY legacy_task_id
    `).all() as Array<Record<string, unknown>>;
    assert.equal(rows.length, 2);
    assert.equal(rows[0].workspace_scope_id, 'ws-tasks');
    assert.equal(rows[0].canonical_workspace_id, null);
    assert.equal(rows[0].revision, 1);
    assert.deepEqual(JSON.parse(rows[0].payload_json as string), tasks[0]);
    assert.equal(rows[0].payload_json, canonicalizeLegacyJson(tasks[0]));
    assert.equal(rows[0].payload_hash, hash(canonicalizeLegacyJson(tasks[0])));
    assert.deepEqual(JSON.parse(rows[1].payload_json as string), tasks[1]);

    const registry = registryRows(fx.db);
    assert.equal(registry.length, 1);
    assert.deepEqual({
      status: registry[0].status,
      attempt: registry[0].attempt,
      revision: registry[0].revision,
      entityCount: registry[0].entity_count,
      errorCode: registry[0].error_code,
      migrationKind: registry[0].migration_kind,
    }, {
      status: 'completed',
      attempt: 1,
      revision: 1,
      entityCount: 2,
      errorCode: null,
      migrationKind: 'legacy_task_item_import',
    });
    assert.equal(registry[0].payload_hash, hash(canonicalizeLegacyJson(tasks)));
    assert.equal(registry[0].source_hash, hash(source));

    // Source bytes are never modified.
    assert.deepEqual(readFileSync(join(fx.root, 'workspace', 'ws-tasks', '.agentos', 'tasks.json')), source);

    // Existing canonical Workspace is linked; missing one stays NULL.
    const fx2 = await fixture();
    try {
      insertCanonicalWorkspace(fx2.db, 'ws-tasks');
      writeTasks(fx2.root, 'ws-tasks', [task('alpha')]);
      const linked = await fx2.service.run(runInput(fx2, 'ws-tasks'));
      assert.equal(linked.completedCount, 1);
      const link = fx2.db.prepare('SELECT canonical_workspace_id FROM legacy_task_items').get() as { canonical_workspace_id: unknown };
      assert.equal(link.canonical_workspace_id, 'ws-tasks');
      // Tombstoned Workspace is treated as absent.
      fx2.db.prepare('INSERT INTO _workspace_tombstones (workspace_id, deleted_at) VALUES (?, ?)').run('ws-gone', NOW);
      writeTasks(fx2.root, 'ws-gone', [task('orphan')]);
      const tombstoned = await fx2.service.run(runInput(fx2, 'ws-gone'));
      assert.equal(tombstoned.completedCount, 1);
      const orphan = fx2.db.prepare(`
        SELECT canonical_workspace_id FROM legacy_task_items WHERE workspace_scope_id = 'ws-gone'
      `).get() as { canonical_workspace_id: unknown };
      assert.equal(orphan.canonical_workspace_id, null);
    } finally {
      fx2.cleanup();
    }
  } finally {
    fx.cleanup();
  }
});

test('[M27-P3-T002] Strict envelope rejection quarantines with revision NULL and zero compatibility rows', async () => {
  for (const raw of ['[1,2]', '{"other":[]}', '{"tasks":{"not":"array"}}', '"text"']) {
    const fx = await fixture();
    try {
      writeTasks(fx.root, 'ws-env', [], raw);
      const result = await fx.service.run(runInput(fx, 'ws-env'));
      assert.equal(result.quarantinedCount, 1);
      assert.equal(result.completedCount, 0);
      assert.equal(result.importedCount, 0);
      assert.equal(result.revision, null);
      assert.equal(countRows(fx.db, 'legacy_task_items'), 0);
      const registry = registryRows(fx.db);
      assert.equal(registry.length, 1);
      assert.equal(registry[0].status, 'quarantined');
      assert.equal(registry[0].error_code, 'LEGACY_TASK_SOURCE_PARSE_FAILED');
      assert.equal(registry[0].revision, null);
      assert.equal(fx.backupCalls.count, 1);
    } finally {
      fx.cleanup();
    }
  }
});

test('[M27-P3-T003] Duplicate object key anywhere in the source quarantines the whole Workspace import', async () => {
  const fx = await fixture();
  try {
    writeTasks(fx.root, 'ws-dup-key', [], '{"tasks":[{"id":"dup","id":"other"}]}');
    const result = await fx.service.run(runInput(fx, 'ws-dup-key'));
    assert.equal(result.quarantinedCount, 1);
    assert.equal(countRows(fx.db, 'legacy_task_items'), 0);
    const registry = registryRows(fx.db);
    assert.equal(registry.length, 1);
    assert.equal(registry[0].status, 'quarantined');
    assert.equal(registry[0].error_code, 'LEGACY_TASK_SOURCE_PARSE_FAILED');
  } finally {
    fx.cleanup();
  }
});

test('[M27-P3-T004] Non-finite and unsafe numbers fail closed instead of being normalized', async () => {
  for (const raw of [
    '{"tasks":[{"id":"n1","count":1e999}]}',
    '{"tasks":[{"id":"n2","big":9007199254740993}]}',
    '{"tasks":[{"id":"n3","neg":-0}]}',
  ]) {
    const fx = await fixture();
    try {
      writeTasks(fx.root, 'ws-num', [], raw);
      const result = await fx.service.run(runInput(fx, 'ws-num'));
      assert.equal(result.quarantinedCount, 1);
      assert.equal(countRows(fx.db, 'legacy_task_items'), 0);
      const registry = registryRows(fx.db);
      assert.equal(registry[0].status, 'quarantined');
      assert.equal(registry[0].error_code, 'LEGACY_TASK_SOURCE_PARSE_FAILED');
    } finally {
      fx.cleanup();
    }
  }
});

test('[M27-P3-T005] Source preflight runs under acquired-and-released Ownership with zero Backup and zero Attempt', async () => {
  const fx = await fixture();
  try {
    await assert.rejects(
      () => fx.service.run(runInput(fx, 'ws-missing')),
      (error: unknown) => (error as { code?: unknown }).code === 'LEGACY_TASK_SOURCE_NOT_READABLE',
    );
    // Ownership is always acquired and released even when the source is
    // missing; no Backup and no Attempt are ever created.
    assert.equal(fx.leaseCalls.count, 1);
    assert.equal(fx.releaseCalls.count, 1);
    assert.equal(fx.backupCalls.count, 0);
    assert.equal(countRows(fx.db, 'legacy_data_migrations'), 0);
    assert.equal(countRows(fx.db, 'legacy_task_items'), 0);
    // Ownership was acquired before the source read was attempted.
    assert.deepEqual(fx.stages, ['ownership']);

    // tasks.json that is a directory is unreadable too.
    mkdirSync(join(fx.root, 'workspace', 'ws-dir', '.agentos', 'tasks.json'), { recursive: true });
    await assert.rejects(
      () => fx.service.run(runInput(fx, 'ws-dir')),
      (error: unknown) => (error as { code?: unknown }).code === 'LEGACY_TASK_SOURCE_NOT_READABLE',
    );
    assert.equal(fx.leaseCalls.count, 2);
    assert.equal(fx.releaseCalls.count, 2);
    assert.equal(fx.backupCalls.count, 0);
    assert.equal(countRows(fx.db, 'legacy_data_migrations'), 0);

    // dry-run follows the same preflight contract.
    await assert.rejects(
      () => fx.service.run(runInput(fx, 'ws-missing', 'dry-run')),
      (error: unknown) => (error as { code?: unknown }).code === 'LEGACY_TASK_SOURCE_NOT_READABLE',
    );
    assert.equal(fx.leaseCalls.count, 3);
    assert.equal(fx.releaseCalls.count, 3);
    assert.equal(fx.backupCalls.count, 0);

    // Successful run ordering: ownership < source read/hash < no-op lookup < backup < attempt.
    const fxOrder = await fixture();
    try {
      writeTasks(fxOrder.root, 'ws-order', [task('alpha')]);
      const result = await fxOrder.service.run(runInput(fxOrder, 'ws-order'));
      assert.equal(result.completedCount, 1);
      assert.deepEqual(fxOrder.stages, ['ownership', 'source-read', 'noop-check', 'backup', 'attempt']);
    } finally {
      fxOrder.cleanup();
    }

    // A junctioned workspace directory escaping the source root is rejected.
    const fxJunction = await fixture();
    const outside = mkdtempSync(join(tmpdir(), 'agentos-m27-p3-outside-'));
    try {
      mkdirSync(join(outside, '.agentos'), { recursive: true });
      writeFileSync(join(outside, '.agentos', 'tasks.json'), JSON.stringify({ tasks: [task('escaped')] }));
      mkdirSync(join(fxJunction.root, 'workspace'), { recursive: true });
      symlinkSync(outside, join(fxJunction.root, 'workspace', 'ws-junction'), 'junction');
      await assert.rejects(
        () => fxJunction.service.run(runInput(fxJunction, 'ws-junction')),
        (error: unknown) => (error as { code?: unknown }).code === 'LEGACY_TASK_SOURCE_NOT_READABLE',
      );
      assert.equal(fxJunction.backupCalls.count, 0);
      assert.equal(countRows(fxJunction.db, 'legacy_data_migrations'), 0);
      assert.equal(countRows(fxJunction.db, 'legacy_task_items'), 0);
    } finally {
      rmSync(outside, { recursive: true, force: true });
      fxJunction.cleanup();
    }

    // Project A database + Project B source root is rejected before
    // Ownership with zero writes.
    const fxA = await fixture();
    const fxB = await fixture();
    try {
      writeTasks(fxB.root, 'ws-cross', [task('alpha')]);
      await assert.rejects(
        () => fxA.service.run({
          projectRoot: fxA.root,
          sourceRoot: fxB.root,
          databasePath: fxA.databasePath,
          backupDirectory: join(fxA.root, 'backups'),
          kind: 'tasks',
          mode: 'apply',
          workspaceId: 'ws-cross',
        }),
        (error: unknown) => (error as { code?: unknown }).code === 'LEGACY_DATA_MIGRATION_PATH_MISMATCH',
      );
      assert.equal(fxA.leaseCalls.count, 0);
      assert.equal(fxA.backupCalls.count, 0);
      assert.equal(countRows(fxA.db, 'legacy_data_migrations'), 0);
      assert.equal(countRows(fxA.db, 'legacy_task_items'), 0);
    } finally {
      fxA.cleanup();
      fxB.cleanup();
    }
  } finally {
    fx.cleanup();
  }
});

test('[M27-P3-T006] Unknown fields, outputs and array order survive the lossless round-trip', async () => {
  const fx = await fixture();
  try {
    const original = {
      id: 'rt',
      title: 'round-trip',
      outputs: [
        { type: 'file', path: 'first.txt' },
        { type: 'file', path: 'second.txt' },
      ],
      'x-extension': { deep: [3, 2, 1], flag: true, note: null },
      history: ['created', 'queued', 'done'],
    };
    writeTasks(fx.root, 'ws-rt', [original]);
    const result = await fx.service.run(runInput(fx, 'ws-rt'));
    assert.equal(result.completedCount, 1);
    const row = fx.db.prepare('SELECT payload_json FROM legacy_task_items WHERE legacy_task_id = ?')
      .get('rt') as { payload_json: string };
    const stored = JSON.parse(row.payload_json) as Record<string, unknown>;
    assert.deepEqual(stored, original);
    assert.deepEqual(
      (stored.outputs as Array<Record<string, unknown>>).map(output => output.path),
      ['first.txt', 'second.txt'],
    );
    assert.deepEqual((stored['x-extension'] as Record<string, unknown>).deep, [3, 2, 1]);
    assert.deepEqual(stored.history, ['created', 'queued', 'done']);
  } finally {
    fx.cleanup();
  }
});

test('[M27-P3-T007] Stored payload is canonical JSON with recursively sorted object keys', async () => {
  const fx = await fixture();
  try {
    const raw = '{"tasks":[{"zeta":1,"id":"canon","alpha":{"b":2,"a":1},"list":[{"y":2,"x":1}]}]}';
    writeTasks(fx.root, 'ws-canon', [], raw);
    const result = await fx.service.run(runInput(fx, 'ws-canon'));
    assert.equal(result.completedCount, 1);
    const row = fx.db.prepare('SELECT payload_json, payload_hash FROM legacy_task_items').get() as {
      payload_json: string;
      payload_hash: string;
    };
    assert.equal(row.payload_json, '{"alpha":{"a":1,"b":2},"id":"canon","list":[{"x":1,"y":2}],"zeta":1}');
    assert.equal(row.payload_hash, hash(row.payload_json));
  } finally {
    fx.cleanup();
  }
});

test('[M27-P3-T008] Exact source match is a no-op with no Parser, Backup, Attempt or row writes', async () => {
  const fx = await fixture();
  try {
    writeTasks(fx.root, 'ws-noop', [task('alpha'), task('beta')]);
    const first = await fx.service.run(runInput(fx, 'ws-noop'));
    assert.equal(first.completedCount, 1);
    assert.equal(fx.backupCalls.count, 1);

    const second = await fx.service.run(runInput(fx, 'ws-noop'));
    assert.deepEqual(second, {
      mode: 'apply',
      kind: 'tasks',
      workspaceId: 'ws-noop',
      sourceCount: 2,
      validTaskCount: 2,
      completedCount: 0,
      noopCount: 1,
      quarantinedCount: 0,
      importedCount: 0,
      revision: 1,
    });
    assert.equal(fx.backupCalls.count, 1);
    assert.equal(countRows(fx.db, 'legacy_data_migrations'), 1);
    assert.equal(countRows(fx.db, 'legacy_task_items'), 2);

    // dry-run against the exact source is a no-op as well and writes nothing.
    const dry = await fx.service.run(runInput(fx, 'ws-noop', 'dry-run'));
    assert.equal(dry.noopCount, 1);
    assert.equal(dry.revision, 1);
    assert.equal(fx.backupCalls.count, 1);
    assert.equal(countRows(fx.db, 'legacy_data_migrations'), 1);
    assert.equal(countRows(fx.db, 'legacy_task_items'), 2);
  } finally {
    fx.cleanup();
  }
});

test('[M27-P3-T009] Source-only hash change records a new Completed Attempt and reuses the latest Revision without new rows', async () => {
  const fx = await fixture();
  try {
    const tasks = [task('alpha'), task('beta')];
    writeTasks(fx.root, 'ws-src', tasks);
    const first = await fx.service.run(runInput(fx, 'ws-src'));
    assert.equal(first.completedCount, 1);

    // Same semantic payload, different exact bytes (pretty-printed).
    writeTasks(fx.root, 'ws-src', tasks, `${JSON.stringify({ tasks }, null, 2)}\n`);
    const second = await fx.service.run(runInput(fx, 'ws-src'));
    assert.equal(second.completedCount, 1);
    assert.equal(second.noopCount, 0);
    assert.equal(second.revision, 1);
    assert.equal(second.importedCount, 0);
    assert.equal(fx.backupCalls.count, 2);

    const registry = registryRows(fx.db);
    assert.equal(registry.length, 2);
    assert.deepEqual(registry.map(row => [row.status, row.attempt, row.revision]), [
      ['completed', 1, 1],
      ['completed', 2, 1],
    ]);
    assert.notEqual(registry[0].source_hash, registry[1].source_hash);
    assert.equal(registry[0].payload_hash, registry[1].payload_hash);
    // No new compatibility rows were written for the reused Revision.
    assert.equal(countRows(fx.db, 'legacy_task_items'), 2);
    const revisions = fx.db.prepare('SELECT DISTINCT revision FROM legacy_task_items').all() as Array<{ revision: number }>;
    assert.deepEqual(revisions.map(row => row.revision), [1]);
  } finally {
    fx.cleanup();
  }
});

test('[M27-P3-T010] Accepted payload change writes the complete next-Revision snapshot and never reuses history', async () => {
  const fx = await fixture();
  try {
    const v1 = [task('alpha'), task('beta')];
    writeTasks(fx.root, 'ws-rev', v1);
    const first = await fx.service.run(runInput(fx, 'ws-rev'));
    assert.equal(first.revision, 1);
    assert.equal(first.importedCount, 2);

    const v2 = [task('alpha'), task('beta'), task('gamma')];
    writeTasks(fx.root, 'ws-rev', v2);
    const second = await fx.service.run(runInput(fx, 'ws-rev'));
    assert.equal(second.revision, 2);
    assert.equal(second.importedCount, 3);
    assert.equal(countRows(fx.db, 'legacy_task_items'), 5);

    // Revision 2 is a complete snapshot: every Task exists at revision 2.
    const rev2 = fx.db.prepare(`
      SELECT legacy_task_id FROM legacy_task_items WHERE revision = 2 ORDER BY legacy_task_id
    `).all() as Array<{ legacy_task_id: string }>;
    assert.deepEqual(rev2.map(row => row.legacy_task_id), ['alpha', 'beta', 'gamma']);

    // A historical payload reappearing with fresh exact bytes after a newer
    // Revision gets latest_revision + 1; the older Revision is never reused.
    writeTasks(fx.root, 'ws-rev', v1, `${JSON.stringify({ tasks: v1 }, null, 2)}\n`);
    const third = await fx.service.run(runInput(fx, 'ws-rev'));
    assert.equal(third.revision, 3);
    assert.equal(third.importedCount, 2);
    assert.equal(countRows(fx.db, 'legacy_task_items'), 7);
    const registry = registryRows(fx.db);
    assert.deepEqual(registry.map(row => [row.attempt, row.revision]), [
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
  } finally {
    fx.cleanup();
  }
});

test('[M27-P3-T011] Duplicate Task ID inside one Workspace source quarantines the whole import', async () => {
  const fx = await fixture();
  try {
    writeTasks(fx.root, 'ws-dup', [task('dup'), task('dup', { title: 'other' }), task('solo')]);
    const result = await fx.service.run(runInput(fx, 'ws-dup'));
    assert.equal(result.quarantinedCount, 1);
    assert.equal(result.completedCount, 0);
    assert.equal(result.importedCount, 0);
    assert.equal(result.revision, null);
    assert.equal(countRows(fx.db, 'legacy_task_items'), 0);
    const registry = registryRows(fx.db);
    assert.equal(registry.length, 1);
    assert.equal(registry[0].status, 'quarantined');
    assert.equal(registry[0].error_code, 'LEGACY_TASK_DUPLICATE_SOURCE_ID');
    assert.equal(registry[0].revision, null);
  } finally {
    fx.cleanup();
  }
});

test('[M27-P3-T012] Cross-workspace Task items fail closed while matching workspaceId is accepted', async () => {
  const fx = await fixture();
  try {
    writeTasks(fx.root, 'ws-x', [
      task('local', { workspaceId: 'ws-x' }),
      task('foreign', { workspaceId: 'ws-other' }),
    ]);
    const result = await fx.service.run(runInput(fx, 'ws-x'));
    assert.equal(result.quarantinedCount, 1);
    assert.equal(result.importedCount, 0);
    assert.equal(countRows(fx.db, 'legacy_task_items'), 0);
    const registry = registryRows(fx.db);
    assert.equal(registry.length, 1);
    assert.equal(registry[0].status, 'quarantined');
    assert.equal(registry[0].error_code, 'LEGACY_TASK_CROSS_WORKSPACE_ITEM');

    // A Task whose workspaceId matches --workspace-id imports cleanly.
    const fx2 = await fixture();
    try {
      writeTasks(fx2.root, 'ws-x', [task('local', { workspaceId: 'ws-x' })]);
      const accepted = await fx2.service.run(runInput(fx2, 'ws-x'));
      assert.equal(accepted.completedCount, 1);
      assert.equal(accepted.importedCount, 1);
    } finally {
      fx2.cleanup();
    }
  } finally {
    fx.cleanup();
  }
});

test('[M2.8-P3-R1-T201] parse failure rerun is a no-op without a new Attempt or Backup and a changed source re-quarantines', async () => {
  const fx = await fixture();
  try {
    writeTasks(fx.root, 'ws-tasks', [], 'not-json');
    const first = await fx.service.run(runInput(fx, 'ws-tasks'));
    assert.equal(first.quarantinedCount, 1);
    assert.equal(fx.backupCalls.count, 1);
    assert.equal(registryRows(fx.db).length, 1);

    const second = await fx.service.run(runInput(fx, 'ws-tasks'));
    assert.equal(second.noopCount, 1);
    assert.equal(second.quarantinedCount, 0);
    assert.equal(fx.backupCalls.count, 1);
    assert.equal(registryRows(fx.db).length, 1);

    writeTasks(fx.root, 'ws-tasks', [], 'not-json-changed');
    const third = await fx.service.run(runInput(fx, 'ws-tasks'));
    assert.equal(third.noopCount, 0);
    assert.equal(third.quarantinedCount, 1);
    assert.equal(fx.backupCalls.count, 2);
    const rows = registryRows(fx.db);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(row => ({ status: row.status, attempt: row.attempt })), [
      { status: 'quarantined', attempt: 1 },
      { status: 'quarantined', attempt: 2 },
    ]);
    assert.ok(rows.every(row => row.error_code === 'LEGACY_TASK_SOURCE_PARSE_FAILED'));
  } finally {
    fx.cleanup();
  }
});

test('[M2.8-P3-R1-T202] duplicate rejection rerun is a no-op without a new Attempt or Backup and a changed source re-quarantines', async () => {
  const fx = await fixture();
  try {
    writeTasks(fx.root, 'ws-tasks', [task('alpha'), task('alpha')]);
    const first = await fx.service.run(runInput(fx, 'ws-tasks'));
    assert.equal(first.quarantinedCount, 1);
    assert.equal(fx.backupCalls.count, 1);
    assert.equal(registryRows(fx.db).length, 1);

    const second = await fx.service.run(runInput(fx, 'ws-tasks'));
    assert.equal(second.noopCount, 1);
    assert.equal(second.quarantinedCount, 0);
    assert.equal(fx.backupCalls.count, 1);
    assert.equal(registryRows(fx.db).length, 1);

    writeTasks(fx.root, 'ws-tasks', [task('alpha'), task('alpha'), task('beta')]);
    const third = await fx.service.run(runInput(fx, 'ws-tasks'));
    assert.equal(third.noopCount, 0);
    assert.equal(third.quarantinedCount, 1);
    assert.equal(fx.backupCalls.count, 2);
    const rows = registryRows(fx.db);
    assert.equal(rows.length, 2);
    assert.ok(rows.every(row => row.status === 'quarantined' && row.error_code === 'LEGACY_TASK_DUPLICATE_SOURCE_ID'));
  } finally {
    fx.cleanup();
  }
});

test('[M2.8-P3-R1-T203] a failed exact-source Attempt stays retryable', async () => {
  const fx = await fixture();
  try {
    const source = writeTasks(fx.root, 'ws-tasks', [task('alpha')]);
    const { LegacyDataMigrationRepository } = await import('../store/LegacyDataMigrationRepository.js') as {
      LegacyDataMigrationRepository: new (db: Db) => {
        reconcileStaleRunningAndReserveAttempt(input: Record<string, unknown>): { id: string };
        transitionRunningToFailed(id: string, input: Record<string, unknown>): void;
      };
    };
    const repository = new LegacyDataMigrationRepository(fx.db);
    const failedSeed = repository.reconcileStaleRunningAndReserveAttempt({
      migrationKind: 'legacy_task_item_import',
      sourceKey: 'tasks.json',
      scopeKind: 'workspace',
      scopeKey: 'ws-tasks',
      canonicalWorkspaceId: null,
      sourceHash: hash(source),
      migrationId: 'retry-failed-attempt',
      now: NOW,
    });
    repository.transitionRunningToFailed(failedSeed.id, {
      errorCode: 'LEGACY_TASK_IMPORT_OPERATION_FAILED',
      finishedAt: NOW,
      updatedAt: NOW,
    });
    const result = await fx.service.run(runInput(fx, 'ws-tasks'));
    assert.equal(result.completedCount, 1);
    assert.equal(result.noopCount, 0);
    assert.equal(result.importedCount, 1);
    assert.equal(countRows(fx.db, 'legacy_task_items'), 1);
    assert.deepEqual(registryRows(fx.db).map(row => row.status), ['failed', 'completed']);
  } finally {
    fx.cleanup();
  }
});
