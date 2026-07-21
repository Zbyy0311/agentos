import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ProviderConfigurationRepository, DEFAULT_CAPABILITIES, DEFAULT_TIMEOUT_POLICY } from '../ProviderConfigurationRepository.js';
import { createEntityId } from '../Identity.js';
import { assertVersionedMutation } from '../Repository.js';
import type { ProviderConfiguration } from '../ProviderConfigurationRepository.js';

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
  db.exec(`CREATE TABLE provider_configurations (
    id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT NOT NULL,
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
  const updated = repo.update({ ...config, name: 'Renamed', outputMode: 'structured', enabled: false, updatedAt: new Date().toISOString() });
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
  repo.archive(config.id);
  const found = repo.findById(config.id);
  assert.ok(found);
  assert.ok(found!.archivedAt);
});

test('findByWorkspace excludes archived configs', () => {
  const db = createDb();
  const repo = new ProviderConfigurationRepository(db as any);
  const c1 = makeConfig({ id: 'provider_A', workspaceId: 'ws-1' });
  repo.insert(c1);
  repo.archive(c1.id);
  assert.equal(repo.findByWorkspace('ws-1').length, 0);
});
