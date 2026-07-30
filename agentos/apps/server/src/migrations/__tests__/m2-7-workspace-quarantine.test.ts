import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { baselineMigration } from '../migrations/001-baseline-schema.js';
import { migration002 } from '../migrations/002-add-aggregate-versions.js';
import { migration003 } from '../migrations/003-workspace-provider-config.js';
import { migration004 } from '../migrations/004-workspace-tombstones.js';
import { migration011 } from '../migrations/011-legacy-data-migration-foundation.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => { exec(sql: string): void; prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown; run(...params: unknown[]): unknown }; close(): void };
};

function schema(db: InstanceType<typeof DatabaseSync>): void {
  db.exec('PRAGMA foreign_keys = ON');
  for (const migration of [baselineMigration, migration002, migration003, migration004]) migration.apply({ db });
  migration011.apply({ db });
}

test('[M27-P2-T007] Source failures quarantine or fail closed without Empty Success', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentos-m27-p2-quarantine-'));
  mkdirSync(join(root, '.agentos'), { recursive: true });
  mkdirSync(join(root, 'workspace'), { recursive: true });
  const databasePath = join(root, '.agentos', 'agentos.sqlite');
  const db = new DatabaseSync(databasePath);
  schema(db);
  const { WorkspaceCompatibilityMigrationService } = await import('../../services/WorkspaceCompatibilityMigrationService.js') as {
    WorkspaceCompatibilityMigrationService: new (options?: Record<string, unknown>) => any;
  };
  let migrationSequence = 0;
  const service = new WorkspaceCompatibilityMigrationService({
    leaseFactory: async () => ({ release: async () => {} }),
    databaseFactory: () => new DatabaseSync(databasePath),
    migrationIdFactory: () => `p2-quarantine-migration-${++migrationSequence}`,
    clock: () => '2026-07-30T00:00:00.000Z',
    backupProvider: { createAndVerify: async () => ({ sqliteBackupFileName: 'backup.sqlite', jsonBackupFileName: 'backup.json', sqliteBackupHash: 'a'.repeat(64), jsonBackupHash: 'b'.repeat(64) }) },
  });
  const input = (mode: 'dry-run' | 'apply') => ({
    projectRoot: root,
    sourceRoot: root,
    databasePath,
    backupDirectory: join(root, 'backups'),
    kind: 'workspace',
    mode,
  });
  try {
    writeFileSync(join(root, 'workspace', 'workspaces.json'), '{"workspaces": [', 'utf8');
    await assert.rejects(
      () => service.run(input('dry-run')),
      (error: unknown) => (error as { code?: string }).code === 'LEGACY_WORKSPACE_SOURCE_PARSE_FAILED',
    );
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM legacy_data_migrations').get() as { count: number }).count, 0);

    rmSync(join(root, 'workspace', 'workspaces.json'), { force: true });
    await assert.rejects(
      () => service.run(input('dry-run')),
      (error: unknown) => (error as { code?: string }).code === 'LEGACY_WORKSPACE_SOURCE_NOT_READABLE',
    );
    mkdirSync(join(root, 'workspace', 'workspaces.json'));
    await assert.rejects(
      () => service.run(input('dry-run')),
      (error: unknown) => (error as { code?: string }).code === 'LEGACY_WORKSPACE_SOURCE_NOT_READABLE',
    );
    rmSync(join(root, 'workspace', 'workspaces.json'), { recursive: true, force: true });

    writeFileSync(join(root, 'workspace', 'workspaces.json'), '{"workspaces":[{"id":"invalid","name":"","rootPath":"C:\\\\invalid","gitEnabled":true,"memoryEnabled":true,"agents":[],"lastOpenedAt":"2026-07-30T00:00:00.000Z","createdAt":"2026-07-30T00:00:00.000Z","updatedAt":"2026-07-30T00:00:00.000Z"}]}', 'utf8');
    const result = await service.run(input('apply'));
    assert.equal(result.invalidCount, 1);
    assert.equal(result.quarantinedCount, 1);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM workspaces').get() as { count: number }).count, 0);

    const duplicateWorkspace = { id: 'duplicate', name: 'Duplicate', rootPath: 'C:\\\\duplicate', gitEnabled: true, memoryEnabled: true, agents: [], lastOpenedAt: '2026-07-30T00:00:00.000Z', createdAt: '2026-07-30T00:00:00.000Z', updatedAt: '2026-07-30T00:00:00.000Z' };
    writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [duplicateWorkspace, duplicateWorkspace] }), 'utf8');
    const duplicateResult = await service.run(input('apply'));
    assert.equal(duplicateResult.sourceCount, 2);
    assert.equal(duplicateResult.selectedCount, 1);
    assert.equal(duplicateResult.invalidCount, 1);
    assert.equal(duplicateResult.quarantinedCount, 1);
    assert.equal(duplicateResult.dispositions.LEGACY_WORKSPACE_DUPLICATE_SOURCE_ID, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM legacy_data_migrations WHERE scope_key = 'duplicate'").get() as { count: number }).count, 1);

    const invalidWithoutId = { name: 'No ID', rootPath: 'C:\\\\no-id', gitEnabled: true, memoryEnabled: true, agents: [], lastOpenedAt: '2026-07-30T00:00:00.000Z', createdAt: '2026-07-30T00:00:00.000Z', updatedAt: '2026-07-30T00:00:00.000Z' };
    writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [invalidWithoutId, invalidWithoutId] }), 'utf8');
    const invalidGlobalResult = await service.run(input('apply'));
    assert.equal(invalidGlobalResult.sourceCount, 2);
    assert.equal(invalidGlobalResult.selectedCount, 1);
    assert.equal(invalidGlobalResult.invalidCount, 1);
    assert.equal(invalidGlobalResult.quarantinedCount, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM legacy_data_migrations WHERE scope_kind = 'global'").get() as { count: number }).count, 1);

    const duplicateAgent = { id: 'agent-duplicate', name: 'Agent Duplicate', role: 'codex', enabled: true, cliCommand: 'codex', cliArgs: ['--task'] };
    const invalidAgentWorkspace = { id: 'invalid-agent-workspace', name: 'Invalid Agent Workspace', rootPath: 'C:\\\\invalid-agent-workspace', gitEnabled: true, memoryEnabled: true, agents: [duplicateAgent, duplicateAgent], lastOpenedAt: '2026-07-30T00:00:00.000Z', createdAt: '2026-07-30T00:00:00.000Z', updatedAt: '2026-07-30T00:00:00.000Z' };
    writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [invalidAgentWorkspace] }), 'utf8');
    const duplicateAgentResult = await service.run(input('apply'));
    assert.equal(duplicateAgentResult.invalidCount, 1);
    assert.equal(duplicateAgentResult.quarantinedCount, 1);
    assert.equal(duplicateAgentResult.dispositions.LEGACY_WORKSPACE_SOURCE_INVALID, 1);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM workspaces').get() as { count: number }).count, 0);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
