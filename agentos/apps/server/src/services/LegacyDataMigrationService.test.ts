import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

import { baselineMigration } from '../migrations/migrations/001-baseline-schema.js';
import { migration002 } from '../migrations/migrations/002-add-aggregate-versions.js';
import { migration003 } from '../migrations/migrations/003-workspace-provider-config.js';

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

const NOW = '2026-07-30T00:00:00.000Z';

interface Fixture {
  root: string;
  databasePath: string;
  service: any;
  calls: string[];
  parserCalls: number;
  backupCalls: number;
  processCalls: number;
  run(source: Uint8Array, process?: (context: any) => Promise<Record<string, unknown>> | Record<string, unknown>): Promise<any>;
  records(): Array<Record<string, unknown>>;
  cleanup(): void;
}

async function createFixture(): Promise<Fixture> {
  const { migration011 } = await import('../migrations/migrations/011-legacy-data-migration-foundation.js') as {
    migration011: { apply(context: { db: Db }): void };
  };
  const { LegacyDataMigrationService } = await import('./LegacyDataMigrationService.js') as {
    LegacyDataMigrationService: new (options?: Record<string, unknown>) => any;
  };
  const { parseLegacyJsonSource } = await import('./LegacySourceParser.js') as {
    parseLegacyJsonSource(bytes: Uint8Array): unknown;
  };

  const root = mkdtempSync(join(tmpdir(), 'agentos-m27-service-'));
  const dataDir = join(root, '.agentos');
  mkdirSync(dataDir, { recursive: true });
  const databasePath = join(dataDir, 'agentos.sqlite');
  const setup = new DatabaseSync(databasePath);
  setup.exec('PRAGMA foreign_keys = ON');
  for (const migration of [baselineMigration, migration002, migration003]) migration.apply({ db: setup });
  migration011.apply({ db: setup });
  setup.prepare(`
    INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at)
    VALUES ('ws-1', 'Workspace', ?, ?, ?, ?, ?)
  `).run(root, root.toLowerCase(), NOW, NOW, NOW);
  setup.close();

  const calls: string[] = [];
  const state = { parserCalls: 0, backupCalls: 0, processCalls: 0 };
  let idSequence = 0;
  const service = new LegacyDataMigrationService({
    leaseFactory: async () => {
      calls.push('lease');
      return {
        release: async () => {
          calls.push('release');
        },
      };
    },
    migrationIdFactory: () => `migration-${++idSequence}`,
    clock: () => NOW,
    parser: (bytes: Uint8Array) => {
      state.parserCalls += 1;
      calls.push('parser');
      return parseLegacyJsonSource(bytes);
    },
  });

  return {
    root,
    databasePath,
    service,
    calls,
    get parserCalls() { return state.parserCalls; },
    get backupCalls() { return state.backupCalls; },
    get processCalls() { return state.processCalls; },
    async run(source, process) {
      return await service.run({
        projectRoot: root,
        databasePath,
        migrationKind: 'legacy_task_item_import',
        sourceKey: 'tasks.json',
        scopeKind: 'workspace',
        scopeKey: 'scope-1',
        canonicalWorkspaceId: 'ws-1',
        sourceBytesLoader: async () => source,
        databaseFactory: () => new DatabaseSync(databasePath),
        backupProvider: {
          createAndVerify: async () => {
            state.backupCalls += 1;
            calls.push('backup');
            return {
              sqliteBackupFileName: 'sqlite.backup',
              jsonBackupFileName: 'source.backup',
              sqliteBackupHash: '0'.repeat(64),
              jsonBackupHash: '1'.repeat(64),
            };
          },
        },
        process: async (context: any) => {
          state.processCalls += 1;
          calls.push(`process:${context.revisionAction}:${context.revision}`);
          return process ? await process(context) : { outcome: 'completed' };
        },
      });
    },
    records() {
      const db = new DatabaseSync(databasePath);
      try {
        return db.prepare(`
          SELECT id, status, attempt, revision, payload_hash, source_schema_version, entity_count, error_code
          FROM legacy_data_migrations
          ORDER BY attempt ASC
        `).all() as Array<Record<string, unknown>>;
      } finally {
        db.close();
      }
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('[M27-P1-T009] Source-only hash branch creates a new Completed Attempt and reuses the accepted Revision', async () => {
  const fixture = await createFixture();
  try {
    const first = await fixture.run(Buffer.from('[{"id":"task-1","value":1}]', 'utf8'));
    const second = await fixture.run(Buffer.from("[ { \"value\": 1, \"id\": \"task-1\" }\n]", 'utf8'));
    assert.equal(first.status, 'completed');
    assert.equal(second.status, 'completed');
    assert.equal(second.record.attempt, 2);
    assert.equal(second.record.revision, 1);
    assert.deepEqual(fixture.calls.filter(call => call.startsWith('process:')), ['process:new:1', 'process:reuse:1']);
    assert.equal(fixture.records().length, 2);
  } finally {
    fixture.cleanup();
  }
});

test('[M27-P1-T010] Payload Hash branch creates the next accepted Revision', async () => {
  const fixture = await createFixture();
  try {
    await fixture.run(Buffer.from('[{"id":"task-1","value":1}]', 'utf8'));
    const changed = await fixture.run(Buffer.from('[{"id":"task-1","value":2}]', 'utf8'));
    assert.equal(changed.status, 'completed');
    assert.equal(changed.record.revision, 2);
    const records = fixture.records();
    assert.deepEqual(records.map(record => record.revision), [1, 2]);
  } finally {
    fixture.cleanup();
  }
});

test('[M27-P1-T040] exact-source no-op returns old evidence and creates no Attempt', async () => {
  const fixture = await createFixture();
  try {
    const source = Buffer.from('[{"id":"task-1","value":1}]', 'utf8');
    const first = await fixture.run(source);
    const parserCalls = fixture.parserCalls;
    const backupCalls = fixture.backupCalls;
    const processCalls = fixture.processCalls;
    const second = await fixture.run(source);
    assert.equal(second.status, 'noop');
    assert.equal(second.record.id, first.record.id);
    assert.equal(second.record.payloadHash, first.record.payloadHash);
    assert.equal(second.record.sourceSchemaVersion, 1);
    assert.equal(second.record.revision, 1);
    assert.equal(second.record.entityCount, 1);
    assert.equal(fixture.parserCalls, parserCalls);
    assert.equal(fixture.backupCalls, backupCalls);
    assert.equal(fixture.processCalls, processCalls);
    assert.equal(fixture.records().length, 1);
  } finally {
    fixture.cleanup();
  }
});

test('[M27-P1-T041] exact-source no-op calls neither SQLite nor JSON Backup Provider', async () => {
  const fixture = await createFixture();
  try {
    const source = Buffer.from('[{"id":"task-1"}]', 'utf8');
    await fixture.run(source);
    fixture.calls.length = 0;
    const beforeBackup = fixture.backupCalls;
    const result = await fixture.run(source);
    assert.equal(result.status, 'noop');
    assert.equal(fixture.backupCalls, beforeBackup);
    assert.deepEqual(fixture.calls, ['lease', 'release']);
  } finally {
    fixture.cleanup();
  }
});

test('[M27-P1-T042] no-op miss verifies Backup before Attempt Reservation', async () => {
  const fixture = await createFixture();
  try {
    const order: string[] = [];
    const result = await fixture.run(Buffer.from('[{"id":"task-1"}]', 'utf8'), async context => {
      const attempts = (context.db.prepare('SELECT COUNT(*) AS count FROM legacy_data_migrations').get() as { count: number }).count;
      order.push(`process:${attempts}`);
      return { outcome: 'completed' };
    });
    assert.equal(result.status, 'completed');
    assert.deepEqual(order, ['process:1']);
    assert.ok(fixture.calls.indexOf('backup') < fixture.calls.indexOf('parser'));
    assert.ok(fixture.calls.indexOf('backup') < fixture.calls.findIndex(call => call.startsWith('process:')));
  } finally {
    fixture.cleanup();
  }
});

test('[M27-P1-T044] Source-only hash change reuses the latest accepted Revision', async () => {
  const fixture = await createFixture();
  try {
    await fixture.run(Buffer.from('[{"id":"task-1","value":1}]', 'utf8'));
    await fixture.run(Buffer.from('[{"id":"task-1","value":2}]', 'utf8'));
    const sourceOnly = await fixture.run(Buffer.from('[ { "value": 2, "id": "task-1" } ]', 'utf8'));
    assert.equal(sourceOnly.status, 'completed');
    assert.equal(sourceOnly.record.revision, 2);
    assert.equal(sourceOnly.record.attempt, 3);
    assert.deepEqual(fixture.records().map(record => record.revision), [1, 2, 2]);
  } finally {
    fixture.cleanup();
  }
});

test('[M27-P1-T045] an older Payload returning after a newer accepted Payload creates latest Revision plus one', async () => {
  const fixture = await createFixture();
  try {
    await fixture.run(Buffer.from('[{"id":"task-1","value":1}]', 'utf8'));
    await fixture.run(Buffer.from('[{"id":"task-1","value":2}]', 'utf8'));
    // New source bytes encoding the older Payload: the exact-source no-op
    // misses, and the Payload differs from the latest accepted Payload.
    const historical = await fixture.run(Buffer.from('[ { "value": 1, "id": "task-1" } ]', 'utf8'));
    assert.equal(historical.status, 'completed');
    assert.equal(historical.record.revision, 3);
    assert.deepEqual(fixture.records().map(record => record.revision), [1, 2, 3]);
  } finally {
    fixture.cleanup();
  }
});
