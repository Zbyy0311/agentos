import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { baselineMigration } from '../../migrations/migrations/001-baseline-schema.js';
import { migration002 } from '../../migrations/migrations/002-add-aggregate-versions.js';
import { migration003 } from '../../migrations/migrations/003-workspace-provider-config.js';
import { migration004 } from '../../migrations/migrations/004-workspace-tombstones.js';
import { migration011 } from '../../migrations/migrations/011-legacy-data-migration-foundation.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown; run(...params: unknown[]): unknown };
    close(): void;
  };
};

type Db = InstanceType<typeof DatabaseSync>;
const NOW = '2026-07-30T00:00:00.000Z';

function createDb(): Db {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const migration of [baselineMigration, migration002, migration003, migration004]) migration.apply({ db });
  migration011.apply({ db });
  return db;
}

test('[M27-P2-T002] SQLite-only Workspace is preserved and never receives a synthetic source Attempt', async () => {
  const db = createDb();
  try {
    db.prepare(`
      INSERT INTO workspaces (id, name, root_path, canonical_root_path, git_enabled, memory_enabled, last_opened_at, created_at, updated_at)
      VALUES ('sqlite-only', 'SQLite Only', 'C:\\sqlite-only', 'c:\\sqlite-only', 1, 1, ?, ?, ?)
    `).run(NOW, NOW, NOW);
    const { WorkspaceCompatibilityRepository } = await import('../WorkspaceCompatibilityRepository.js') as {
      WorkspaceCompatibilityRepository: new (db: Db) => { findWorkspaceById(id: string): unknown; findTombstone(id: string): unknown; findWorkspaceByCanonicalPath(path: string): unknown; findAgent(workspaceId: string, agentId: string): { rawProvider?: string; effectiveProvider: string; rawCliCommand: string; effectiveCliCommand: string; rawCliArgs: string[]; effectiveCliArgs: string[]; rawModel?: string; effectiveModel?: string; providerConfiguration?: { workspaceId?: string; argsTemplate?: string[]; model?: string } } | undefined };
    };
    const repo = new WorkspaceCompatibilityRepository(db);
    assert.ok(repo.findWorkspaceById('sqlite-only'));
    assert.equal(repo.findTombstone('sqlite-only'), null);
    assert.ok(repo.findWorkspaceByCanonicalPath('c:\\sqlite-only'));
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM legacy_data_migrations').get() as { count: number }).count, 0);

    db.prepare(`
      INSERT INTO workspaces (id, name, root_path, canonical_root_path, git_enabled, memory_enabled, last_opened_at, created_at, updated_at)
      VALUES ('provider-projection', 'Provider Projection', 'C:\\provider-projection', 'c:\\provider-projection', 1, 1, ?, ?, ?)
    `).run(NOW, NOW, NOW);
    db.prepare(`
      INSERT INTO provider_configurations (
        id, workspace_id, name, provider_type, adapter_id, runtime_mode,
        executable, args_template_json, capabilities_json, timeout_policy_json,
        approval_mode, output_mode, enabled, version, created_at, updated_at
      ) VALUES ('provider-projection-config', 'provider-projection', 'Codex Provider', 'codex', 'builtin.codex', 'cli', 'codex', '[]', '{}', '{}', 'agentos', 'parsed-text', 1, 1, ?, ?)
    `).run(NOW, NOW);
    db.prepare(`
      INSERT INTO agent_profiles (
        workspace_id, id, name, agent_role, provider, role_title, system_prompt,
        permissions_json, enabled, cli_command, cli_args_json, model, thinking_effort,
        provider_config_id, created_at, updated_at
      ) VALUES ('provider-projection', 'codex', 'Codex', 'codex', NULL, 'Codex', 'system', '[]', 1, 'stale-codex', '["stale"]', 'stale-model', 'auto', 'provider-projection-config', ?, ?)
    `).run(NOW, NOW);
    const nullRaw = repo.findAgent('provider-projection', 'codex');
    assert.equal(nullRaw?.rawProvider, undefined);
    assert.equal(nullRaw?.effectiveProvider, 'codex');
    assert.equal(nullRaw?.rawCliCommand, 'stale-codex');
    assert.equal(nullRaw?.effectiveCliCommand, 'codex');
    assert.deepEqual(nullRaw?.rawCliArgs, ['stale']);
    assert.deepEqual(nullRaw?.effectiveCliArgs, []);
    assert.equal(nullRaw?.rawModel, 'stale-model');
    assert.equal(nullRaw?.effectiveModel, undefined);
    assert.equal(nullRaw?.providerConfiguration?.workspaceId, 'provider-projection');
    db.prepare('UPDATE agent_profiles SET provider = ? WHERE workspace_id = ? AND id = ?').run('legacy-provider', 'provider-projection', 'codex');
    assert.equal(repo.findAgent('provider-projection', 'codex')?.effectiveProvider, 'codex');

    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare(`
      INSERT INTO workspaces (id, name, root_path, canonical_root_path, git_enabled, memory_enabled, last_opened_at, created_at, updated_at)
      VALUES ('binding-a', 'Binding A', 'C:\\binding-a', 'c:\\binding-a', 1, 1, ?, ?, ?),
             ('binding-b', 'Binding B', 'C:\\binding-b', 'c:\\binding-b', 1, 1, ?, ?, ?)
    `).run(NOW, NOW, NOW, NOW, NOW, NOW);
    db.prepare(`
      INSERT INTO provider_configurations (
        id, workspace_id, name, provider_type, adapter_id, runtime_mode,
        executable, args_template_json, capabilities_json, timeout_policy_json,
        approval_mode, output_mode, enabled, version, created_at, updated_at
      ) VALUES ('cross-binding-config', 'binding-b', 'Cross Binding', 'codex', 'builtin.codex', 'cli', 'codex', '[]', '{}', '{}', 'agentos', 'parsed-text', 1, 1, ?, ?)
    `).run(NOW, NOW);
    db.prepare(`
      INSERT INTO agent_profiles (
        workspace_id, id, name, agent_role, provider, role_title, system_prompt,
        permissions_json, enabled, cli_command, cli_args_json, thinking_effort,
        provider_config_id, created_at, updated_at
      ) VALUES ('binding-a', 'codex', 'Codex', 'codex', 'codex', 'Codex', 'system', '[]', 1, 'codex', '[]', 'auto', 'cross-binding-config', ?, ?)
    `).run(NOW, NOW);
    assert.throws(() => repo.findAgent('binding-a', 'codex'), /invalid provider binding/);

    db.prepare(`
      INSERT INTO agent_profiles (
        workspace_id, id, name, agent_role, provider, role_title, system_prompt,
        permissions_json, enabled, cli_command, cli_args_json, thinking_effort,
        provider_config_id, created_at, updated_at
      ) VALUES ('binding-a', 'missing', 'Missing', 'codex', 'codex', 'Codex', 'system', '[]', 1, 'codex', '[]', 'auto', 'missing-provider-config', ?, ?)
    `).run(NOW, NOW);
    db.exec('PRAGMA foreign_keys = ON');
    assert.throws(() => repo.findAgent('binding-a', 'missing'), /invalid provider binding/);
  } finally {
    db.close();
  }
});
