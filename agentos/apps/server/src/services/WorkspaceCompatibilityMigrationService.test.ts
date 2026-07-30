import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { baselineMigration } from '../migrations/migrations/001-baseline-schema.js';
import { migration002 } from '../migrations/migrations/002-add-aggregate-versions.js';
import { migration003 } from '../migrations/migrations/003-workspace-provider-config.js';
import { migration004 } from '../migrations/migrations/004-workspace-tombstones.js';
import { migration011 } from '../migrations/migrations/011-legacy-data-migration-foundation.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown; run(...params: unknown[]): unknown };
    close(): void;
  };
};

type Db = InstanceType<typeof DatabaseSync>;
const NOW = '2026-07-30T00:00:00.000Z';
const LATER = '2026-07-30T00:00:01.000Z';

function hash(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function agent(id = 'codex', overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: id === 'codex' ? 'Codex' : id,
    role: id === 'codex' ? 'codex' : 'kimi',
    enabled: true,
    cliCommand: id === 'kimi' ? 'opencode' : 'codex',
    cliArgs: id === 'kimi' ? ['--legacy'] : ['--task'],
    ...overrides,
  };
}

function workspace(id: string, rootPath: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: `Workspace ${id}`,
    rootPath,
    gitEnabled: true,
    memoryEnabled: true,
    agents: [agent()],
    lastOpenedAt: NOW,
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

function insertWorkspace(db: Db, value: Record<string, unknown>): void {
  db.prepare(`
    INSERT INTO workspaces (id, name, root_path, canonical_root_path, git_enabled, memory_enabled, last_opened_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(value.id, value.name, value.rootPath, String(value.rootPath).toLowerCase(), value.gitEnabled ? 1 : 0, value.memoryEnabled ? 1 : 0, value.lastOpenedAt, value.createdAt, value.updatedAt);
}

function insertEqualChildren(db: Db, value: Record<string, unknown>): void {
  const sourceAgent = (value.agents as Array<Record<string, unknown>>)[0];
  const providerId = 'provider-equal';
  const capabilities = {
    sessionResume: false, structuredEvents: false, nativeApprovals: false,
    subagents: false, toolEvents: false, fileEvents: false, usageEvents: false,
    reasoningStream: false, interactiveInput: false, pause: false,
    cancellation: false, modelSelection: false, workspaceAwareness: false,
    nativeSandbox: false, outputContracts: false,
  };
  const timeoutPolicy = {
    discoveryTimeoutMs: 10_000, validationTimeoutMs: 30_000, startupTimeoutMs: 60_000,
    idleTimeoutMs: 600_000, totalTimeoutMs: null, cancelGracePeriodMs: 5_000, approvalTimeoutMs: null,
  };
  db.prepare(`
    INSERT INTO provider_configurations (
      id, workspace_id, name, provider_type, adapter_id, runtime_mode,
      executable, args_template_json, model, capabilities_json, timeout_policy_json,
      approval_mode, output_mode, enabled, version, created_at, updated_at
    ) VALUES (?, ?, ?, 'codex', 'builtin.codex', 'cli', ?, ?, NULL, ?, ?, 'agentos', 'parsed-text', 1, 1, ?, ?)
  `).run(providerId, value.id, `${sourceAgent.name} Provider`, sourceAgent.cliCommand, JSON.stringify(sourceAgent.cliArgs), JSON.stringify(capabilities), JSON.stringify(timeoutPolicy), value.createdAt, value.updatedAt);
  db.prepare(`
    INSERT INTO agent_profiles (
      workspace_id, id, name, agent_role, provider, role_title, system_prompt,
      permissions_json, enabled, cli_command, cli_args_json, model, thinking_effort,
      provider_config_id, created_at, updated_at
    ) VALUES (?, ?, ?, 'codex', 'codex', 'Codex', 'system', '["read","review"]', 1, ?, ?, NULL, 'auto', ?, ?, ?)
  `).run(value.id, sourceAgent.id, sourceAgent.name, sourceAgent.cliCommand, JSON.stringify(sourceAgent.cliArgs), providerId, value.createdAt, value.updatedAt);
}

function writeSource(root: string, workspaces: unknown[], rawPrefix = '{"workspaces":'): Uint8Array {
  const bytes = Buffer.from(`${rawPrefix}${JSON.stringify(workspaces)}}`, 'utf8');
  const dir = join(root, 'workspace');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'workspaces.json'), bytes);
  return bytes;
}

async function fixture(): Promise<{
  root: string;
  databasePath: string;
  db: Db;
  service: any;
  backupCalls: { count: number };
  cleanup(): void;
}> {
  const root = mkdtempSync(join(tmpdir(), 'agentos-m27-p2-service-'));
  mkdirSync(join(root, '.agentos'), { recursive: true });
  const databasePath = join(root, '.agentos', 'agentos.sqlite');
  const db = new DatabaseSync(databasePath);
  applySchema(db);
  const backupCalls = { count: 0 };
  const { WorkspaceCompatibilityMigrationService } = await import('./WorkspaceCompatibilityMigrationService.js') as {
    WorkspaceCompatibilityMigrationService: new (options?: Record<string, unknown>) => any;
  };
  const service = new WorkspaceCompatibilityMigrationService({
    leaseFactory: async () => ({ release: async () => {} }),
    databaseFactory: () => new DatabaseSync(databasePath),
    migrationIdFactory: (() => { let n = 0; return () => `p2-migration-${++n}`; })(),
    clock: () => NOW,
    backupProvider: {
      createAndVerify: async () => {
        backupCalls.count += 1;
        return { sqliteBackupFileName: 'backup.sqlite', jsonBackupFileName: 'backup.json', sqliteBackupHash: hash('sqlite'), jsonBackupHash: hash('json') };
      },
    },
  });
  return {
    root,
    databasePath,
    db,
    service,
    backupCalls,
    cleanup() {
      try { db.close(); } catch {}
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function runInput(fx: { root: string; databasePath: string }, mode: 'dry-run' | 'apply' = 'apply', workspaceId?: string): Record<string, unknown> {
  return {
    projectRoot: fx.root,
    sourceRoot: fx.root,
    databasePath: fx.databasePath,
    backupDirectory: join(fx.root, 'backups'),
    kind: 'workspace',
    mode,
    ...(workspaceId ? { workspaceId } : {}),
  };
}

function runCommand(args: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/commands/migrateLegacyData.ts', ...args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { output += String(chunk); });
    child.once('error', reject);
    child.once('close', code => resolve({ code, output }));
  });
}

test('[M27-P2-T001] JSON-only adoption writes Workspace, Agent, Provider and Completed Registry atomically', async () => {
  const fx = await fixture();
  try {
    const source = writeSource(fx.root, [workspace('json-only', join(fx.root, 'json-only'), { agents: [agent(), agent('kimi')] })]);
    const result = await fx.service.run(runInput(fx));
    assert.equal(result.completedCount, 1);
    assert.equal(result.adoptableCount, 1);
    assert.equal(result.quarantinedCount, 0);
    assert.equal(fx.backupCalls.count, 1);
    assert.equal((fx.db.prepare('SELECT COUNT(*) AS count FROM workspaces').get() as { count: number }).count, 1);
    assert.equal((fx.db.prepare('SELECT COUNT(*) AS count FROM agent_profiles').get() as { count: number }).count, 2);
    assert.equal((fx.db.prepare('SELECT COUNT(*) AS count FROM provider_configurations').get() as { count: number }).count, 2);
    const kimi = fx.db.prepare(`
      SELECT ap.cli_command, ap.cli_args_json, pc.provider_type
      FROM agent_profiles ap JOIN provider_configurations pc ON pc.id = ap.provider_config_id
      WHERE ap.id = 'kimi'
    `).get() as Record<string, unknown>;
    assert.deepEqual({ cli_command: kimi.cli_command, cli_args_json: kimi.cli_args_json, provider_type: kimi.provider_type }, {
      cli_command: 'kimi',
      cli_args_json: JSON.stringify(['-m', 'kimi-code/kimi-for-coding', '-p']),
      provider_type: 'kimicode',
    });
    assert.equal((fx.db.prepare("SELECT COUNT(*) AS count FROM legacy_data_migrations WHERE status = 'completed'").get() as { count: number }).count, 1);
    assert.deepEqual(readFileSync(join(fx.root, 'workspace', 'workspaces.json')), source);
  } finally {
    fx.cleanup();
  }
});

test('[M27-P2-T003] Existing equal state is not overwritten and creates equal_existing evidence', async () => {
  const fx = await fixture();
  try {
    const value = workspace('equal', join(fx.root, 'equal'));
    insertWorkspace(fx.db, value);
    insertEqualChildren(fx.db, value);
    const source = writeSource(fx.root, [value]);
    const beforeVersion = (fx.db.prepare('SELECT version FROM workspaces WHERE id = ?').get('equal') as { version: number }).version;
    const result = await fx.service.run(runInput(fx));
    assert.equal(result.equalCount, 1);
    assert.equal(result.compatibleMissingCount, 0);
    assert.equal(result.completedCount, 1);
    assert.equal(result.dispositions.equal_existing, 1);
    assert.equal(fx.backupCalls.count, 1);
    assert.equal((fx.db.prepare('SELECT version FROM workspaces WHERE id = ?').get('equal') as { version: number }).version, beforeVersion);
    assert.equal((fx.db.prepare('SELECT COUNT(*) AS count FROM agent_profiles WHERE workspace_id = ?').get('equal') as { count: number }).count, 1);
    assert.equal((fx.db.prepare('SELECT COUNT(*) AS count FROM provider_configurations WHERE workspace_id = ?').get('equal') as { count: number }).count, 1);
    assert.equal(hash(readFileSync(join(fx.root, 'workspace', 'workspaces.json'))), hash(source));

    const compatible = workspace('compatible-missing', join(fx.root, 'compatible-missing'));
    insertWorkspace(fx.db, compatible);
    writeSource(fx.root, [compatible]);
    const compatibleResult = await fx.service.run(runInput(fx));
    assert.equal(compatibleResult.equalCount, 0);
    assert.equal(compatibleResult.compatibleMissingCount, 1);
    assert.equal(compatibleResult.dispositions.compatible_missing, 1);
    assert.equal((fx.db.prepare('SELECT COUNT(*) AS count FROM agent_profiles WHERE workspace_id = ?').get('compatible-missing') as { count: number }).count, 1);
    assert.equal((fx.db.prepare('SELECT COUNT(*) AS count FROM provider_configurations WHERE workspace_id = ?').get('compatible-missing') as { count: number }).count, 1);
  } finally {
    fx.cleanup();
  }
});

test('[M27-P2-T004] Same-ID conflict quarantines the whole Workspace without partial child writes', async () => {
  const fx = await fixture();
  try {
    const existing = workspace('conflict', join(fx.root, 'conflict'), { name: 'Existing Name' });
    insertWorkspace(fx.db, existing);
    const source = workspace('conflict', join(fx.root, 'conflict'), { name: 'JSON Name' });
    writeSource(fx.root, [source]);
    const result = await fx.service.run(runInput(fx));
    assert.equal(result.conflictCount, 1);
    assert.equal(result.quarantinedCount, 1);
    assert.equal(result.completedCount, 0);
    assert.equal(fx.backupCalls.count, 1);
    assert.equal((fx.db.prepare('SELECT COUNT(*) AS count FROM agent_profiles').get() as { count: number }).count, 0);
    const row = fx.db.prepare('SELECT status, error_code, revision, canonical_workspace_id FROM legacy_data_migrations').get() as Record<string, unknown>;
    assert.deepEqual({ status: row.status, error_code: row.error_code, revision: row.revision, canonical_workspace_id: row.canonical_workspace_id }, { status: 'quarantined', error_code: 'LEGACY_WORKSPACE_CANONICAL_CONFLICT', revision: null, canonical_workspace_id: 'conflict' });

    const agentConflictFx = await fixture();
    try {
      const existingAgentWorkspace = workspace('agent-conflict', join(agentConflictFx.root, 'agent-conflict'));
      insertWorkspace(agentConflictFx.db, existingAgentWorkspace);
      insertEqualChildren(agentConflictFx.db, existingAgentWorkspace);
      agentConflictFx.db.prepare('UPDATE agent_profiles SET name = ? WHERE workspace_id = ? AND id = ?').run('Existing Agent', 'agent-conflict', 'codex');
      writeSource(agentConflictFx.root, [existingAgentWorkspace]);
      const agentConflict = await agentConflictFx.service.run(runInput(agentConflictFx));
      assert.equal(agentConflict.conflictCount, 1);
      assert.equal(agentConflict.quarantinedCount, 1);
      assert.equal((agentConflictFx.db.prepare('SELECT COUNT(*) AS count FROM legacy_data_migrations').get() as { count: number }).count, 1);
    } finally {
      agentConflictFx.cleanup();
    }

    const providerConflictFx = await fixture();
    try {
      const existingProviderWorkspace = workspace('provider-conflict', join(providerConflictFx.root, 'provider-conflict'));
      insertWorkspace(providerConflictFx.db, existingProviderWorkspace);
      insertEqualChildren(providerConflictFx.db, existingProviderWorkspace);
      providerConflictFx.db.prepare('UPDATE provider_configurations SET executable = ? WHERE workspace_id = ?').run('other-cli', 'provider-conflict');
      writeSource(providerConflictFx.root, [existingProviderWorkspace]);
      const providerConflict = await providerConflictFx.service.run(runInput(providerConflictFx));
      assert.equal(providerConflict.conflictCount, 1);
      assert.equal(providerConflict.quarantinedCount, 1);
      assert.equal((providerConflictFx.db.prepare('SELECT COUNT(*) AS count FROM legacy_data_migrations').get() as { count: number }).count, 1);
    } finally {
      providerConflictFx.cleanup();
    }
  } finally {
    fx.cleanup();
  }
});

test('[M27-P2-T005] Tombstone wins, preserves evidence, and never resurrects Workspace children', async () => {
  const fx = await fixture();
  try {
    fx.db.prepare('INSERT INTO _workspace_tombstones (workspace_id, deleted_at) VALUES (?, ?)').run('dead', NOW);
    writeSource(fx.root, [workspace('dead', join(fx.root, 'dead'))]);
    const result = await fx.service.run(runInput(fx));
    assert.equal(result.tombstoneCount, 1);
    assert.equal(result.completedCount, 1);
    assert.equal((fx.db.prepare('SELECT COUNT(*) AS count FROM workspaces WHERE id = ?').get('dead') as { count: number }).count, 0);
    const row = fx.db.prepare('SELECT status, canonical_workspace_id FROM legacy_data_migrations').get() as Record<string, unknown>;
    assert.deepEqual({ status: row.status, canonical_workspace_id: row.canonical_workspace_id }, { status: 'completed', canonical_workspace_id: null });
  } finally {
    fx.cleanup();
  }
});

test('[M27-P2-T006] Canonical-root conflict quarantines without remapping or inserting', async () => {
  const fx = await fixture();
  try {
    const existing = workspace('existing-root-owner', join(fx.root, 'shared-root'));
    insertWorkspace(fx.db, existing);
    writeSource(fx.root, [workspace('new-id', join(fx.root, 'shared-root'))]);
    const result = await fx.service.run(runInput(fx));
    assert.equal(result.conflictCount, 1);
    assert.equal(result.quarantinedCount, 1);
    assert.equal((fx.db.prepare('SELECT COUNT(*) AS count FROM workspaces').get() as { count: number }).count, 1);
    const row = fx.db.prepare('SELECT error_code, canonical_workspace_id FROM legacy_data_migrations').get() as Record<string, unknown>;
    assert.deepEqual({ error_code: row.error_code, canonical_workspace_id: row.canonical_workspace_id }, { error_code: 'LEGACY_WORKSPACE_CANONICAL_ROOT_CONFLICT', canonical_workspace_id: null });
  } finally {
    fx.cleanup();
  }
});

test('[M27-P2-T008] Backup failure creates no Attempt or aggregate write and preserves source bytes', async () => {
  const fx = await fixture();
  try {
    const source = writeSource(fx.root, [workspace('backup-failure', join(fx.root, 'backup-failure'))]);
    const { WorkspaceCompatibilityMigrationService } = await import('./WorkspaceCompatibilityMigrationService.js') as { WorkspaceCompatibilityMigrationService: new (options?: Record<string, unknown>) => any };
    const service = new WorkspaceCompatibilityMigrationService({
      leaseFactory: async () => ({ release: async () => {} }),
      databaseFactory: () => new DatabaseSync(fx.databasePath),
      backupProvider: { createAndVerify: async () => { throw new Error('injected backup failure'); } },
    });
    await assert.rejects(
      () => service.run(runInput(fx)),
      (error: unknown) => (error as { code?: string }).code === 'LEGACY_DATA_MIGRATION_BACKUP_FAILED',
    );
    assert.equal((fx.db.prepare('SELECT COUNT(*) AS count FROM legacy_data_migrations').get() as { count: number }).count, 0);
    assert.equal((fx.db.prepare('SELECT COUNT(*) AS count FROM workspaces').get() as { count: number }).count, 0);
    assert.deepEqual(readFileSync(join(fx.root, 'workspace', 'workspaces.json')), source);
  } finally {
    fx.cleanup();
  }
});

test('[M27-P2-T009] Restart after adoption is boot-compatible and does not duplicate aggregates or evidence', async () => {
  const fx = await fixture();
  try {
    writeSource(fx.root, [workspace('restart', join(fx.root, 'restart'))]);
    const first = await fx.service.run(runInput(fx));
    assert.equal(first.completedCount, 1);
    const before = {
      workspaces: (fx.db.prepare('SELECT COUNT(*) AS count FROM workspaces').get() as { count: number }).count,
      agents: (fx.db.prepare('SELECT COUNT(*) AS count FROM agent_profiles').get() as { count: number }).count,
      providers: (fx.db.prepare('SELECT COUNT(*) AS count FROM provider_configurations').get() as { count: number }).count,
      records: (fx.db.prepare('SELECT COUNT(*) AS count FROM legacy_data_migrations').get() as { count: number }).count,
    };
    fx.db.exec('CREATE TABLE _schema_migrations (migration_id TEXT PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL, execution_ms INTEGER NOT NULL, app_version TEXT)');
    for (const id of ['001', '002', '003', '004', '011']) {
      const migration = DEFAULT_REGISTRY_MIGRATIONS.find(candidate => candidate.id === id)!;
      fx.db.prepare('INSERT INTO _schema_migrations (migration_id, name, checksum, applied_at, execution_ms, app_version) VALUES (?, ?, ?, ?, 0, NULL)')
        .run(migration.id, migration.name, migration.checksum, NOW);
    }
    const { SqliteStore } = await import('../store/SqliteStore.js') as { SqliteStore: new (root: string) => { close(): void } };
    const store = new SqliteStore(fx.root);
    store.close();
    assert.deepEqual({
      workspaces: (fx.db.prepare('SELECT COUNT(*) AS count FROM workspaces').get() as { count: number }).count,
      agents: (fx.db.prepare('SELECT COUNT(*) AS count FROM agent_profiles').get() as { count: number }).count,
      providers: (fx.db.prepare('SELECT COUNT(*) AS count FROM provider_configurations').get() as { count: number }).count,
      records: (fx.db.prepare('SELECT COUNT(*) AS count FROM legacy_data_migrations').get() as { count: number }).count,
    }, before);
  } finally {
    fx.cleanup();
  }
});

test('[M27-P2-T010] Accepted Payload Hash change allocates the next revision instead of reusing history', async () => {
  const fx = await fixture();
  try {
    const first = writeSource(fx.root, [workspace('revisioned', join(fx.root, 'revisioned'), { name: 'First' })]);
    await fx.service.run(runInput(fx));
    const second = writeSource(fx.root, [workspace('revisioned', join(fx.root, 'revisioned'), { name: 'First', unknownField: 'changed' })]);
    assert.notDeepEqual(first, second);
    await fx.service.run(runInput(fx));
    const rows = fx.db.prepare(`
      SELECT revision, payload_hash, status
      FROM legacy_data_migrations
      WHERE source_key = 'workspaces.json' AND scope_key = 'revisioned'
      ORDER BY revision ASC
    `).all() as Array<Record<string, unknown>>;
    assert.deepEqual(rows.map(row => ({ revision: row.revision, status: row.status })), [
      { revision: 1, status: 'completed' },
      { revision: 2, status: 'completed' },
    ]);
    assert.notEqual(rows[0]?.payload_hash, rows[1]?.payload_hash);

    const sourceOnlyBytes = Buffer.from(`{ "workspaces" : [ ${JSON.stringify(workspace('revisioned', join(fx.root, 'revisioned'), { name: 'First', unknownField: 'changed' }))} ] }`, 'utf8');
    writeFileSync(join(fx.root, 'workspace', 'workspaces.json'), sourceOnlyBytes);
    await fx.service.run(runInput(fx));
    const sourceOnlyRows = fx.db.prepare(`
      SELECT revision, payload_hash, status
      FROM legacy_data_migrations
      WHERE source_key = 'workspaces.json' AND scope_key = 'revisioned'
      ORDER BY attempt ASC
    `).all() as Array<Record<string, unknown>>;
    assert.deepEqual(sourceOnlyRows.map(row => ({ revision: row.revision, status: row.status })), [
      { revision: 1, status: 'completed' },
      { revision: 2, status: 'completed' },
      { revision: 2, status: 'completed' },
    ]);
    assert.equal(sourceOnlyRows[1]?.payload_hash, sourceOnlyRows[2]?.payload_hash);
  } finally {
    fx.cleanup();
  }
});

test('[M27-P2-T012] Command validation uses stable exit codes and rejects unsafe or unsupported invocations', async () => {
  const missing = await runCommand(['--kind', 'workspace', '--mode', 'dry-run']);
  assert.equal(missing.code, 2);
  assert.match(missing.output, /LEGACY_WORKSPACE_MIGRATION_INVALID_ARGUMENTS/);
  const tasks = await runCommand(['--database', 'C:\\not-a-real-db.sqlite', '--source-root', 'C:\\not-a-root', '--backup-dir', 'C:\\backup', '--kind', 'tasks', '--mode', 'dry-run']);
  assert.equal(tasks.code, 2);
  assert.match(tasks.output, /LEGACY_DATA_MIGRATION_KIND_NOT_IMPLEMENTED/);
  const noConfirm = await runCommand(['--database', 'C:\\not-a-real-db.sqlite', '--source-root', 'C:\\not-a-root', '--backup-dir', 'C:\\backup', '--kind', 'workspace', '--mode', 'apply']);
  assert.equal(noConfirm.code, 2);
  assert.match(noConfirm.output, /LEGACY_WORKSPACE_MIGRATION_INVALID_ARGUMENTS/);
  assert.doesNotMatch(noConfirm.output, /C:\\not-a-real-db|C:\\not-a-root/);
});

test('[M27-P2-T013] Dry-run performs strict compare under ownership with zero Backup, Attempt, Registry, aggregate, JSON, or backup-directory writes', async () => {
  const fx = await fixture();
  try {
    const source = writeSource(fx.root, [workspace('dry-run', join(fx.root, 'dry-run'))]);
    fx.db.close();
    const result = await runCommand(['--database', fx.databasePath, '--source-root', fx.root, '--backup-dir', join(fx.root, 'dry-backups'), '--kind', 'workspace', '--mode', 'dry-run']);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /"mode":"dry-run"/);
    assert.match(result.output, /"adoptableCount":1/);
    assert.equal((result.output.match(/dry-run/g) ?? []).length >= 1, true);
    assert.doesNotMatch(result.output, /dry-run\|agentos|Workspace dry-run/);
    assert.equal(existsSync(join(fx.root, 'dry-backups')), false);
    const check = new DatabaseSync(fx.databasePath);
    try {
      assert.equal((check.prepare('SELECT COUNT(*) AS count FROM legacy_data_migrations').get() as { count: number }).count, 0);
      assert.equal((check.prepare('SELECT COUNT(*) AS count FROM workspaces').get() as { count: number }).count, 0);
    } finally {
      check.close();
    }
    assert.deepEqual(readFileSync(join(fx.root, 'workspace', 'workspaces.json')), source);

    const invalidSource = writeSource(fx.root, [workspace('dry-invalid', join(fx.root, 'dry-invalid'), { name: '' })]);
    const invalidDryRun = await runCommand(['--database', fx.databasePath, '--source-root', fx.root, '--backup-dir', join(fx.root, 'dry-backups'), '--kind', 'workspace', '--mode', 'dry-run']);
    assert.equal(invalidDryRun.code, 4, invalidDryRun.output);
    assert.equal(existsSync(join(fx.root, 'dry-backups')), false);
    const invalidCheck = new DatabaseSync(fx.databasePath);
    try {
      assert.equal((invalidCheck.prepare('SELECT COUNT(*) AS count FROM legacy_data_migrations').get() as { count: number }).count, 0);
    } finally {
      invalidCheck.close();
    }
    assert.deepEqual(readFileSync(join(fx.root, 'workspace', 'workspaces.json')), invalidSource);
  } finally {
    fx.cleanup();
  }
});

test('[M27-P2-T014] Apply confirms before ownership, backs up once for a mixed batch, preserves source, and skips Backup on all-noop rerun', async () => {
  const fx = await fixture();
  try {
    const source = writeSource(fx.root, [workspace('apply-a', join(fx.root, 'apply-a'))]);
    fx.db.close();
    const first = await runCommand(['--database', fx.databasePath, '--source-root', fx.root, '--backup-dir', join(fx.root, 'apply-backups'), '--kind', 'workspace', '--mode', 'apply', '--confirm', 'APPLY-M2.7']);
    assert.equal(first.code, 0, first.output);
    assert.match(first.output, /"completedCount":1/);
    const backupFiles = readdirSync(join(fx.root, 'apply-backups'));
    assert.equal(backupFiles.filter((name: string) => name.endsWith('.sqlite') || name.endsWith('.json')).length, 2);
    const afterFirst = new DatabaseSync(fx.databasePath);
    try {
      assert.equal((afterFirst.prepare("SELECT COUNT(*) AS count FROM legacy_data_migrations WHERE status = 'completed'").get() as { count: number }).count, 1);
    } finally {
      afterFirst.close();
    }
    const second = await runCommand(['--database', fx.databasePath, '--source-root', fx.root, '--backup-dir', join(fx.root, 'apply-backups'), '--kind', 'workspace', '--mode', 'apply', '--confirm', 'APPLY-M2.7']);
    assert.equal(second.code, 0, second.output);
    assert.match(second.output, /"noopCount":1/);
    assert.equal(readdirSync(join(fx.root, 'apply-backups')).length, backupFiles.length);
    assert.deepEqual(readFileSync(join(fx.root, 'workspace', 'workspaces.json')), source);
  } finally {
    fx.cleanup();
  }
});
