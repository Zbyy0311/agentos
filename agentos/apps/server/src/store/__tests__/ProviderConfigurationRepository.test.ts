import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ProviderConfigurationRepository, DEFAULT_CAPABILITIES, DEFAULT_TIMEOUT_POLICY } from '../ProviderConfigurationRepository.js';
import { createEntityId } from '../Identity.js';
import { assertVersionedMutation } from '../Repository.js';
import type { ProviderConfiguration } from '../ProviderConfigurationRepository.js';

test('update returns incremented version', () => {
  const db = createDb();
  const repo = new ProviderConfigurationRepository(db as any);
  const config = makeConfig();
  repo.insert(config);
  assert.equal(config.version, 1);
  const updated = repo.update({ ...config, name: 'v2', updatedAt: new Date().toISOString() }, config.version);
  assert.equal(updated.version, 2);
  const found = repo.findById(config.id);
  assert.equal(found!.version, 2);
});

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string, opts?: { open?: boolean }) => {
    exec(sql: string): void;
    prepare(sql: string): { all(...p: unknown[]): unknown[]; get(...p: unknown[]): unknown; run(...p: unknown[]): unknown };
    close(): void;
  };
};

function createDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`CREATE TABLE workspaces (
    id TEXT PRIMARY KEY, name TEXT NOT NULL,
    root_path TEXT NOT NULL, canonical_root_path TEXT NOT NULL UNIQUE,
    git_enabled INTEGER NOT NULL DEFAULT 1,
    memory_enabled INTEGER NOT NULL DEFAULT 1,
    last_opened_at TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1
  )`);
  db.exec(`INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at)
    VALUES ('ws-1', 'WS1', '/ws1', '/ws1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`);
  db.exec(`INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at)
    VALUES ('ws-2', 'WS2', '/ws2', '/ws2', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`);
  db.exec(`INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at)
    VALUES ('ws-test1', 'Test', '/test', '/test', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`);
  db.exec(`CREATE TABLE provider_configurations (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    name TEXT NOT NULL,
    provider_type TEXT NOT NULL CHECK (provider_type IN ('codex','claude-code','kimicode','opencode','gemini-cli','custom-cli','remote')),
    adapter_id TEXT NOT NULL, runtime_mode TEXT NOT NULL CHECK (runtime_mode IN ('cli','api','ssh','container')),
    executable TEXT, args_template_json TEXT NOT NULL DEFAULT '[]', model TEXT,
    environment_profile_id TEXT, secret_profile_id TEXT,
    working_directory_mode TEXT NOT NULL DEFAULT 'workspace' CHECK (working_directory_mode IN ('workspace','worktree','custom')),
    custom_working_directory TEXT, capabilities_json TEXT NOT NULL,
    timeout_policy_json TEXT NOT NULL,
    approval_mode TEXT NOT NULL DEFAULT 'agentos' CHECK (approval_mode IN ('agentos','native','hybrid','disabled')),
    output_mode TEXT NOT NULL DEFAULT 'parsed-text' CHECK (output_mode IN ('structured','parsed-text','raw-stream')),
    enabled INTEGER NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT
  )`);
  return db;
}

function makeConfig(overrides: Partial<ProviderConfiguration> = {}): ProviderConfiguration {
  const now = new Date().toISOString();
  return {
    id: 'provider_0ABCDEFGHJKMNPQRSTVWXYZ01',
    workspaceId: 'ws-test1',
    name: 'Default Codex CLI',
    providerType: 'codex',
    adapterId: 'builtin.codex',
    runtimeMode: 'cli',
    executable: 'codex',
    argsTemplate: ['exec', '--ephemeral'],
    model: 'claude-sonnet-4-6',
    workingDirectoryMode: 'workspace',
    capabilities: { ...DEFAULT_CAPABILITIES, structuredEvents: true },
    timeoutPolicy: { ...DEFAULT_TIMEOUT_POLICY },
    approvalMode: 'agentos',
    outputMode: 'parsed-text',
    enabled: true,
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test('insert and findById', () => {
  const db = createDb();
  const repo = new ProviderConfigurationRepository(db as any);
  const config = makeConfig();
  repo.insert(config);
  const found = repo.findById(config.id);
  assert.ok(found);
  assert.equal(found!.name, 'Default Codex CLI');
  assert.equal(found!.providerType, 'codex');
  assert.deepEqual(found!.capabilities.structuredEvents, true);
});

test('findByWorkspace returns matching configs', () => {
  const db = createDb();
  const repo = new ProviderConfigurationRepository(db as any);
  const c1 = makeConfig({ id: 'provider_A', name: 'A', workspaceId: 'ws-1' });
  const c2 = makeConfig({ id: 'provider_B', name: 'B', workspaceId: 'ws-1' });
  const c3 = makeConfig({ id: 'provider_C', name: 'C', workspaceId: 'ws-2' });
  repo.insert(c1);
  repo.insert(c2);
  repo.insert(c3);
  assert.equal(repo.findByWorkspace('ws-1').length, 2);
  assert.equal(repo.findByWorkspace('ws-2').length, 1);
});

test('update config fields', () => {
  const db = createDb();
  const repo = new ProviderConfigurationRepository(db as any);
  const config = makeConfig();
  repo.insert(config);
  const updated = repo.update({ ...config, name: 'Renamed', outputMode: 'structured', enabled: false, updatedAt: new Date().toISOString() }, config.version);
  assert.equal(updated.name, 'Renamed');
  assert.equal(updated.outputMode, 'structured');
  assert.equal(updated.enabled, false);
  const found = repo.findById(config.id);
  assert.equal(found!.name, 'Renamed');
});

test('version conflict detected via assertVersionedMutation', () => {
  assert.throws(() => {
    assertVersionedMutation({ changes: 0 }, { entityType: 'provider_configurations', entityId: 'p1', expectedVersion: 1 });
  }, (err: unknown) => {
    return (err as Error).message.includes('version conflict');
  });
});

test('archive sets archivedAt', () => {
  const db = createDb();
  const repo = new ProviderConfigurationRepository(db as any);
  const config = makeConfig();
  repo.insert(config);
  repo.archive(config.id, config.version);
  const found = repo.findById(config.id);
  assert.ok(found);
  assert.ok(found!.archivedAt);
});

test('requires expectedVersion for update and archive', () => {
  const db = createDb();
  const repo = new ProviderConfigurationRepository(db as any);
  const config = makeConfig();
  repo.insert(config);
  const updateWithoutVersion = (value: ProviderConfiguration, expectedVersion?: number): ProviderConfiguration =>
    (repo.update as unknown as (config: ProviderConfiguration, version: number) => ProviderConfiguration)(value, expectedVersion as number);
  const archiveWithoutVersion = (id: string, expectedVersion?: number): void =>
    (repo.archive as unknown as (providerId: string, version: number) => void)(id, expectedVersion as number);
  assert.throws(() => updateWithoutVersion({ ...config, name: 'must fail' }), /expectedVersion is required/);
  assert.throws(() => archiveWithoutVersion(config.id), /expectedVersion is required/);
  assert.equal(repo.findById(config.id)?.version, 1);
});

test('archive rejects a stale expectedVersion without mutating the configuration', () => {
  const db = createDb();
  const repo = new ProviderConfigurationRepository(db as any);
  const config = makeConfig();
  repo.insert(config);
  repo.update({ ...config, name: 'newer', updatedAt: new Date().toISOString() }, config.version);
  assert.throws(() => repo.archive(config.id, config.version), /version conflict/);
  assert.equal(repo.findById(config.id)?.archivedAt, undefined);
});

test('findByWorkspace excludes archived configs', () => {
  const db = createDb();
  const repo = new ProviderConfigurationRepository(db as any);
  const c1 = makeConfig({ id: 'provider_A', workspaceId: 'ws-1' });
  repo.insert(c1);
  repo.archive(c1.id, c1.version);
  assert.equal(repo.findByWorkspace('ws-1').length, 0);
});
