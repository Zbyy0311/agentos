import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { WorkspaceRepository } from '../WorkspaceRepository.js';
import { createEntityId } from '../Identity.js';
import { assertVersionedMutation } from '../Repository.js';

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
    description TEXT, root_path TEXT NOT NULL,
    canonical_root_path TEXT NOT NULL UNIQUE,
    repository_type TEXT NOT NULL DEFAULT 'directory',
    default_branch TEXT, default_agent_id TEXT,
    default_provider_config_id TEXT,
    default_workflow_definition_id TEXT,
    default_policy_profile_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    settings_version INTEGER NOT NULL DEFAULT 1,
    git_enabled INTEGER NOT NULL DEFAULT 1,
    memory_enabled INTEGER NOT NULL DEFAULT 1,
    last_opened_at TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    archived_at TEXT, deleted_at TEXT,
    version INTEGER NOT NULL DEFAULT 1
  )`);
  db.exec(`CREATE TABLE agent_profiles (
    workspace_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL,
    agent_role TEXT NOT NULL, provider TEXT, role_title TEXT NOT NULL,
    system_prompt TEXT NOT NULL, permissions_json TEXT NOT NULL,
    enabled INTEGER NOT NULL, cli_command TEXT NOT NULL, cli_args_json TEXT NOT NULL,
    model TEXT, thinking_effort TEXT NOT NULL DEFAULT 'auto',
    provider_config_id TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, id)
  )`);
  db.exec(`CREATE TABLE provider_configurations (
    id TEXT PRIMARY KEY, workspace_id TEXT,
    name TEXT NOT NULL, provider_type TEXT NOT NULL,
    adapter_id TEXT, runtime_mode TEXT NOT NULL DEFAULT 'cli',
    executable TEXT, args_template_json TEXT,
    model TEXT, environment_profile_id TEXT, secret_profile_id TEXT,
    working_directory_mode TEXT NOT NULL DEFAULT 'relative',
    custom_working_directory TEXT,
    capabilities_json TEXT NOT NULL DEFAULT '{}',
    timeout_policy_json TEXT NOT NULL DEFAULT '{}',
    approval_mode TEXT NOT NULL DEFAULT 'auto',
    output_mode TEXT NOT NULL DEFAULT 'parsed-text',
    enabled INTEGER NOT NULL DEFAULT 1,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT
  )`);
  return db;
}

test('insert and findById', () => {
  const db = createDb();
  const repo = new WorkspaceRepository(db as any);
  const now = new Date().toISOString();
  const ws = { id: createEntityId('workspace'), name: 'test', rootPath: '/home/test', gitEnabled: true, memoryEnabled: true, agents: [], lastOpenedAt: now, createdAt: now, updatedAt: now };

  repo.insert(ws);
  const found = repo.findById(ws.id);
  assert.ok(found);
  assert.equal(found!.id, ws.id);
  assert.equal(found!.name, 'test');
  assert.equal(found!.rootPath, '/home/test');
});

test('findAll returns empty when no workspaces', () => {
  const db = createDb();
  const repo = new WorkspaceRepository(db as any);
  assert.deepEqual(repo.findAll(), []);
});

test('insert two workspaces and findAll returns both sorted', () => {
  const db = createDb();
  const repo = new WorkspaceRepository(db as any);
  const now = new Date().toISOString();
  const ws1 = { id: createEntityId('workspace'), name: 'B', rootPath: '/b', gitEnabled: true, memoryEnabled: true, agents: [], lastOpenedAt: '2026-01-01T00:00:00.000Z', createdAt: now, updatedAt: now };
  const ws2 = { id: createEntityId('workspace'), name: 'A', rootPath: '/a', gitEnabled: true, memoryEnabled: true, agents: [], lastOpenedAt: '2026-07-01T00:00:00.000Z', createdAt: now, updatedAt: now };
  repo.insert(ws1);
  repo.insert(ws2);
  const all = repo.findAll();
  assert.equal(all.length, 2);
  assert.equal(all[0].id, ws2.id); // more recent lastOpenedAt first
});

test('findByCanonicalPath', () => {
  const db = createDb();
  const repo = new WorkspaceRepository(db as any);
  const now = new Date().toISOString();
  const ws = { id: createEntityId('workspace'), name: 'test', rootPath: 'C:\\test-workspace', gitEnabled: true, memoryEnabled: true, agents: [], lastOpenedAt: now, createdAt: now, updatedAt: now };
  repo.insert(ws);
  const found = repo.findByCanonicalPath('c:\\test-workspace');
  assert.ok(found);
  assert.equal(found!.id, ws.id);
});

test('update workspace name', () => {
  const db = createDb();
  const repo = new WorkspaceRepository(db as any);
  const now = new Date().toISOString();
  const ws = { id: createEntityId('workspace'), name: 'test', rootPath: '/home/test', gitEnabled: true, memoryEnabled: true, agents: [], lastOpenedAt: now, createdAt: now, updatedAt: now };
  repo.insert(ws);
  const updated = repo.update({ ...ws, name: 'renamed', updatedAt: new Date().toISOString() });
  assert.equal(updated.name, 'renamed');
  const found = repo.findById(ws.id);
  assert.equal(found!.name, 'renamed');
});

test('version conflict detected with concurrent update', () => {
  assert.throws(() => {
    assertVersionedMutation({ changes: 0 }, { entityType: 'workspaces', entityId: 'ws-version-test', expectedVersion: 1 });
  }, (err: unknown) => {
    return (err as Error).message.includes('version conflict');
  });
});

test('deleteById removes workspace and agent profiles', () => {
  const db = createDb();
  const repo = new WorkspaceRepository(db as any);
  const now = new Date().toISOString();
  const wsId = createEntityId('workspace');
  const ws = { id: wsId, name: 'test', rootPath: '/home/test', gitEnabled: true, memoryEnabled: true, agents: [], lastOpenedAt: now, createdAt: now, updatedAt: now };
  repo.insert(ws);
  db.prepare("INSERT INTO agent_profiles VALUES (?1, 'a1', 'Codex', 'codex', 'codex', 'Manager', '', '[]', 1, 'codex', '[]', NULL, 'auto', NULL, ?2, ?2)").run(wsId, now);
  repo.deleteById(wsId);
  assert.equal(repo.exists(wsId), false);
  const agents = db.prepare('SELECT * FROM agent_profiles WHERE workspace_id = ?').all(wsId) as unknown[];
  assert.equal(agents.length, 0);
});

test('count returns correct number', () => {
  const db = createDb();
  const repo = new WorkspaceRepository(db as any);
  const now = new Date().toISOString();
  assert.equal(repo.count(), 0);
  repo.insert({ id: createEntityId('workspace'), name: 'a', rootPath: '/a', gitEnabled: true, memoryEnabled: true, agents: [], lastOpenedAt: now, createdAt: now, updatedAt: now });
  repo.insert({ id: createEntityId('workspace'), name: 'b', rootPath: '/b', gitEnabled: true, memoryEnabled: true, agents: [], lastOpenedAt: now, createdAt: now, updatedAt: now });
  assert.equal(repo.count(), 2);
});

test('assembleRows attaches agents from JOIN', () => {
  const db = createDb();
  const repo = new WorkspaceRepository(db as any);
  const now = new Date().toISOString();
  const wsId = createEntityId('workspace');
  repo.insert({ id: wsId, name: 'test', rootPath: '/home/test', gitEnabled: true, memoryEnabled: true, agents: [], lastOpenedAt: now, createdAt: now, updatedAt: now });
  db.prepare("INSERT INTO agent_profiles VALUES (?1, 'codex', 'Codex', 'codex', 'codex', 'Manager', '', '[]', 1, 'codex', '[]', NULL, 'auto', NULL, ?2, ?2)").run(wsId, now);
  db.prepare("INSERT INTO agent_profiles VALUES (?1, 'kimi', 'KimiCode', 'kimi', 'kimi', 'Worker', '', '[]', 1, 'kimi', '[]', NULL, 'auto', NULL, ?2, ?2)").run(wsId, now);

  const found = repo.findById(wsId);
  assert.ok(found);
  assert.equal(found!.agents.length, 2);
  assert.equal(found!.agents[0].id, 'codex');
  assert.equal(found!.agents[1].id, 'kimi');
});
