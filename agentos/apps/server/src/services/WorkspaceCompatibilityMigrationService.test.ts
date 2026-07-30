import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { baselineMigration } from '../migrations/migrations/001-baseline-schema.js';
import { migration002 } from '../migrations/migrations/002-add-aggregate-versions.js';
import { migration003 } from '../migrations/migrations/003-workspace-provider-config.js';
import { migration004 } from '../migrations/migrations/004-workspace-tombstones.js';
import { migration011 } from '../migrations/migrations/011-legacy-data-migration-foundation.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import { DEFAULT_CAPABILITIES, DEFAULT_TIMEOUT_POLICY } from '../store/ProviderConfigurationRepository.js';
import { canonicalizeLegacyJson } from './LegacySourceParser.js';

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

function runCrashAfterReservationChild(fx: { root: string; databasePath: string }): Promise<{ code: number | null; output: string }> {
  const input = JSON.stringify(runInput(fx));
  const script = `
    import { WorkspaceCompatibilityMigrationService } from './src/services/WorkspaceCompatibilityMigrationService.ts';
    const input = JSON.parse(${JSON.stringify(input)});
    const service = new WorkspaceCompatibilityMigrationService({
      beforeAggregateTransaction: () => process.exit(90),
    });
    await service.run(input);
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
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

    const crashFx = await fixture();
    try {
      writeSource(crashFx.root, [workspace('crash-adoption', join(crashFx.root, 'crash-adoption'), { agents: [] })]);
      crashFx.db.close();
      const crashed = await runCrashAfterReservationChild(crashFx);
      assert.equal(crashed.code, 90, crashed.output);
      const runningAfterCrash = new DatabaseSync(crashFx.databasePath);
      try {
        const row = runningAfterCrash.prepare(`
          SELECT status, attempt, canonical_workspace_id, error_code
          FROM legacy_data_migrations
          WHERE scope_key = 'crash-adoption'
          ORDER BY attempt
        `).all() as Array<Record<string, unknown>>;
        assert.deepEqual(row.map(value => ({
          status: value.status,
          attempt: value.attempt,
          canonical_workspace_id: value.canonical_workspace_id,
          error_code: value.error_code,
        })), [{ status: 'running', attempt: 1, canonical_workspace_id: null, error_code: null }]);
        assert.equal((runningAfterCrash.prepare('SELECT COUNT(*) AS count FROM workspaces').get() as { count: number }).count, 0);
      } finally {
        runningAfterCrash.close();
      }
      const resumed = await crashFx.service.run(runInput(crashFx));
      assert.equal(resumed.completedCount, 1);
      const evidence = new DatabaseSync(crashFx.databasePath);
      try {
        const rows = evidence.prepare(`
          SELECT status, attempt, canonical_workspace_id, error_code
          FROM legacy_data_migrations
          WHERE scope_key = 'crash-adoption'
          ORDER BY attempt
        `).all() as Array<Record<string, unknown>>;
        assert.deepEqual(rows.map(value => ({
          status: value.status,
          attempt: value.attempt,
          canonical_workspace_id: value.canonical_workspace_id,
          error_code: value.error_code,
        })), [
          { status: 'failed', attempt: 1, canonical_workspace_id: null, error_code: 'LEGACY_DATA_MIGRATION_INTERRUPTED' },
          { status: 'completed', attempt: 2, canonical_workspace_id: null, error_code: null },
        ]);
      } finally {
        evidence.close();
      }
    } finally {
      crashFx.cleanup();
    }
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

    const providerProjectionFx = await fixture();
    try {
      const projectionWorkspace = workspace('provider-projection', join(providerProjectionFx.root, 'provider-projection'));
      insertWorkspace(providerProjectionFx.db, projectionWorkspace);
      insertEqualChildren(providerProjectionFx.db, projectionWorkspace);
      providerProjectionFx.db.prepare('UPDATE agent_profiles SET provider = NULL, cli_command = ?, cli_args_json = ?, model = ? WHERE workspace_id = ? AND id = ?').run('stale-codex', JSON.stringify(['stale']), 'stale-model', 'provider-projection', 'codex');
      writeSource(providerProjectionFx.root, [projectionWorkspace]);
      const nullRawResult = await providerProjectionFx.service.run(runInput(providerProjectionFx));
      assert.equal(nullRawResult.equalCount, 1);
      assert.equal(nullRawResult.conflictCount, 0);
      providerProjectionFx.db.prepare('UPDATE agent_profiles SET provider = ? WHERE workspace_id = ? AND id = ?').run('legacy-provider', 'provider-projection', 'codex');
      const rawChangedBytes = Buffer.from(`{ "workspaces" : [ ${JSON.stringify(projectionWorkspace)} ] }`, 'utf8');
      writeFileSync(join(providerProjectionFx.root, 'workspace', 'workspaces.json'), rawChangedBytes);
      const historicalRawResult = await providerProjectionFx.service.run(runInput(providerProjectionFx));
      assert.equal(historicalRawResult.equalCount, 1);
      assert.equal(historicalRawResult.conflictCount, 0);
    } finally {
      providerProjectionFx.cleanup();
    }
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
    const payloadEvidence = fx.db.prepare('SELECT payload_hash, source_schema_version, entity_count FROM legacy_data_migrations').get() as Record<string, unknown>;
    assert.equal(payloadEvidence.payload_hash, hash(canonicalizeLegacyJson([source])));
    assert.equal(payloadEvidence.source_schema_version, 1);
    assert.equal(payloadEvidence.entity_count, 1);

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

    const crossBindingFx = await fixture();
    try {
      const workspaceA = workspace('cross-binding-a', join(crossBindingFx.root, 'cross-binding-a'));
      const workspaceB = workspace('cross-binding-b', join(crossBindingFx.root, 'cross-binding-b'), { agents: [] });
      insertWorkspace(crossBindingFx.db, workspaceA);
      insertWorkspace(crossBindingFx.db, workspaceB);
      const sourceAgent = (workspaceA.agents as Array<Record<string, unknown>>)[0];
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
      crossBindingFx.db.prepare(`
        INSERT INTO provider_configurations (
          id, workspace_id, name, provider_type, adapter_id, runtime_mode,
          executable, args_template_json, model, capabilities_json, timeout_policy_json,
          approval_mode, output_mode, enabled, version, created_at, updated_at
        ) VALUES ('cross-binding-provider', ?, ?, 'codex', 'builtin.codex', 'cli', ?, ?, NULL, ?, ?, 'agentos', 'parsed-text', 1, 1, ?, ?)
      `).run(workspaceB.id, `${sourceAgent.name} Provider`, sourceAgent.cliCommand, JSON.stringify(sourceAgent.cliArgs), JSON.stringify(capabilities), JSON.stringify(timeoutPolicy), NOW, NOW);
      crossBindingFx.db.prepare(`
        INSERT INTO agent_profiles (
          workspace_id, id, name, agent_role, provider, role_title, system_prompt,
          permissions_json, enabled, cli_command, cli_args_json, model, thinking_effort,
          provider_config_id, created_at, updated_at
        ) VALUES (?, ?, ?, 'codex', 'codex', 'Codex', 'system', '["read"]', 1, ?, ?, NULL, 'auto', 'cross-binding-provider', ?, ?)
      `).run(workspaceA.id, sourceAgent.id, sourceAgent.name, sourceAgent.cliCommand, JSON.stringify(sourceAgent.cliArgs), NOW, NOW);
      const sourceWorkspace = workspaceA;
      writeSource(crossBindingFx.root, [sourceWorkspace]);
      const before = {
        workspaceA: (crossBindingFx.db.prepare('SELECT version FROM workspaces WHERE id = ?').get(workspaceA.id) as { version: number }).version,
        workspaceB: (crossBindingFx.db.prepare('SELECT version FROM workspaces WHERE id = ?').get(workspaceB.id) as { version: number }).version,
        providers: (crossBindingFx.db.prepare('SELECT COUNT(*) AS count FROM provider_configurations').get() as { count: number }).count,
      };
      const result = await crossBindingFx.service.run(runInput(crossBindingFx));
      assert.equal(result.conflictCount, 1);
      assert.equal(result.quarantinedCount, 1);
      assert.equal(result.completedCount, 0);
      const row = crossBindingFx.db.prepare('SELECT status, error_code, payload_hash, source_schema_version, entity_count, revision FROM legacy_data_migrations').get() as Record<string, unknown>;
      assert.deepEqual({ status: row.status, error_code: row.error_code, payload_hash: row.payload_hash, source_schema_version: row.source_schema_version, entity_count: row.entity_count, revision: row.revision }, {
        status: 'quarantined', error_code: 'LEGACY_WORKSPACE_CANONICAL_CONFLICT', payload_hash: hash(canonicalizeLegacyJson([sourceWorkspace])), source_schema_version: 1, entity_count: 1, revision: null,
      });
      assert.equal((crossBindingFx.db.prepare('SELECT version FROM workspaces WHERE id = ?').get(workspaceA.id) as { version: number }).version, before.workspaceA);
      assert.equal((crossBindingFx.db.prepare('SELECT version FROM workspaces WHERE id = ?').get(workspaceB.id) as { version: number }).version, before.workspaceB);
      assert.equal((crossBindingFx.db.prepare('SELECT COUNT(*) AS count FROM provider_configurations').get() as { count: number }).count, before.providers);
    } finally {
      crossBindingFx.cleanup();
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
    const source = workspace('new-id', join(fx.root, 'shared-root'));
    writeSource(fx.root, [source]);
    const result = await fx.service.run(runInput(fx));
    assert.equal(result.conflictCount, 1);
    assert.equal(result.quarantinedCount, 1);
    assert.equal((fx.db.prepare('SELECT COUNT(*) AS count FROM workspaces').get() as { count: number }).count, 1);
    const row = fx.db.prepare('SELECT error_code, canonical_workspace_id FROM legacy_data_migrations').get() as Record<string, unknown>;
    assert.deepEqual({ error_code: row.error_code, canonical_workspace_id: row.canonical_workspace_id }, { error_code: 'LEGACY_WORKSPACE_CANONICAL_ROOT_CONFLICT', canonical_workspace_id: null });
    const payloadEvidence = fx.db.prepare('SELECT payload_hash, source_schema_version, entity_count, revision FROM legacy_data_migrations').get() as Record<string, unknown>;
    assert.equal(payloadEvidence.payload_hash, hash(canonicalizeLegacyJson([source])));
    assert.equal(payloadEvidence.source_schema_version, 1);
    assert.equal(payloadEvidence.entity_count, 1);
    assert.equal(payloadEvidence.revision, null);

    const aliasFx = await fixture();
    try {
      const physicalRoot = join(aliasFx.root, 'physical-root');
      const aliasRoot = join(aliasFx.root, 'alias-root');
      mkdirSync(physicalRoot);
      symlinkSync(physicalRoot, aliasRoot, process.platform === 'win32' ? 'junction' : 'dir');
      const existing = workspace('alias-root', physicalRoot);
      const source = workspace('alias-root', aliasRoot);
      insertWorkspace(aliasFx.db, existing);
      writeSource(aliasFx.root, [source]);
      const result = await aliasFx.service.run(runInput(aliasFx));
      assert.equal(result.conflictCount, 1);
      assert.equal(result.quarantinedCount, 1);
      assert.equal(result.completedCount, 0);
      const row = aliasFx.db.prepare('SELECT error_code, payload_hash, source_schema_version, entity_count, revision FROM legacy_data_migrations').get() as Record<string, unknown>;
      assert.deepEqual({ error_code: row.error_code, payload_hash: row.payload_hash, source_schema_version: row.source_schema_version, entity_count: row.entity_count, revision: row.revision }, {
        error_code: 'LEGACY_WORKSPACE_CANONICAL_CONFLICT', payload_hash: hash(canonicalizeLegacyJson([source])), source_schema_version: 1, entity_count: 1, revision: null,
      });
      assert.equal((aliasFx.db.prepare('SELECT root_path, version FROM workspaces WHERE id = ?').get('alias-root') as { root_path: string; version: number }).root_path, physicalRoot);
    } finally {
      aliasFx.cleanup();
    }
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

    const kimiFx = await fixture();
    try {
      const kimiSourceWorkspace = workspace('boot-kimi', join(kimiFx.root, 'boot-kimi'), { agents: [agent('kimi', { model: 'provider-model' })] });
      insertWorkspace(kimiFx.db, kimiSourceWorkspace);
      const sourceAgent = (kimiSourceWorkspace.agents as Array<Record<string, unknown>>)[0];
      const kimiArgs = ['-m', 'kimi-code/kimi-for-coding', '-p'];
      kimiFx.db.prepare(`
        INSERT INTO provider_configurations (
          id, workspace_id, name, provider_type, adapter_id, runtime_mode,
          executable, args_template_json, model, capabilities_json, timeout_policy_json,
          approval_mode, output_mode, enabled, version, created_at, updated_at
        ) VALUES (?, ?, ?, 'kimicode', 'builtin.kimi', 'cli', 'kimi', ?, 'provider-model', ?, ?, 'agentos', 'parsed-text', 1, 1, ?, ?)
      `).run('boot-kimi-provider', kimiSourceWorkspace.id, `${sourceAgent.name} Provider`, JSON.stringify(kimiArgs), JSON.stringify(DEFAULT_CAPABILITIES), JSON.stringify(DEFAULT_TIMEOUT_POLICY), NOW, NOW);
      kimiFx.db.prepare(`
        INSERT INTO agent_profiles (
          workspace_id, id, name, agent_role, provider, role_title, system_prompt,
          permissions_json, enabled, cli_command, cli_args_json, model, thinking_effort,
          provider_config_id, created_at, updated_at
        ) VALUES (?, ?, ?, 'kimi', 'kimi', 'Kimi', 'system', '["read"]', 1, 'opencode', '["--legacy"]', 'legacy-model', 'auto', ?, ?, ?)
      `).run(kimiSourceWorkspace.id, sourceAgent.id, sourceAgent.name, 'boot-kimi-provider', NOW, NOW);
      const beforeRaw = kimiFx.db.prepare('SELECT provider, cli_command, cli_args_json, model FROM agent_profiles WHERE workspace_id = ? AND id = ?').get(kimiSourceWorkspace.id, sourceAgent.id) as Record<string, unknown>;
      const beforeVersions = {
        workspace: (kimiFx.db.prepare('SELECT version FROM workspaces WHERE id = ?').get(kimiSourceWorkspace.id) as { version: number }).version,
        provider: (kimiFx.db.prepare('SELECT version FROM provider_configurations WHERE id = ?').get('boot-kimi-provider') as { version: number }).version,
      };
      writeSource(kimiFx.root, [kimiSourceWorkspace]);
      const firstKimi = await kimiFx.service.run(runInput(kimiFx));
      assert.equal(firstKimi.equalCount, 1);
      assert.equal(firstKimi.conflictCount, 0);
      assert.equal(firstKimi.dispositions.equal_existing, 1);
      const afterRaw = kimiFx.db.prepare('SELECT provider, cli_command, cli_args_json, model FROM agent_profiles WHERE workspace_id = ? AND id = ?').get(kimiSourceWorkspace.id, sourceAgent.id) as Record<string, unknown>;
      assert.deepEqual(afterRaw, beforeRaw);
      assert.equal((kimiFx.db.prepare('SELECT version FROM workspaces WHERE id = ?').get(kimiSourceWorkspace.id) as { version: number }).version, beforeVersions.workspace);
      assert.equal((kimiFx.db.prepare('SELECT version FROM provider_configurations WHERE id = ?').get('boot-kimi-provider') as { version: number }).version, beforeVersions.provider);
      const whitespaceKimiBytes = Buffer.from(`{ "workspaces" : [ ${JSON.stringify(kimiSourceWorkspace)} ] }`, 'utf8');
      writeFileSync(join(kimiFx.root, 'workspace', 'workspaces.json'), whitespaceKimiBytes);
      const secondKimi = await kimiFx.service.run(runInput(kimiFx));
      assert.equal(secondKimi.equalCount, 1);
      assert.equal(secondKimi.conflictCount, 0);
      assert.equal(secondKimi.completedCount, 1);
      const kimiRows = kimiFx.db.prepare(`SELECT revision, payload_hash, status FROM legacy_data_migrations WHERE scope_key = ? ORDER BY attempt`).all(kimiSourceWorkspace.id) as Array<Record<string, unknown>>;
      assert.deepEqual(kimiRows.map(row => ({ revision: row.revision, status: row.status })), [{ revision: 1, status: 'completed' }, { revision: 1, status: 'completed' }]);
      assert.equal(kimiRows[0]?.payload_hash, kimiRows[1]?.payload_hash);
    } finally {
      kimiFx.cleanup();
    }
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

    const mimoFx = await fixture();
    try {
      const mimoAgent = { id: 'mimo', name: 'Mimo', role: 'mimo', enabled: true, cliCommand: 'mimo', cliArgs: ['--legacy'], model: 'mimo-model' };
      const mimoWorkspace = workspace('mimo-round-trip', join(mimoFx.root, 'mimo-round-trip'), { agents: [mimoAgent] });
      const mimoFirstSource = writeSource(mimoFx.root, [mimoWorkspace]);
      const firstMimo = await mimoFx.service.run(runInput(mimoFx));
      assert.equal(firstMimo.completedCount, 1);
      assert.equal((mimoFx.db.prepare('SELECT provider_type FROM provider_configurations WHERE workspace_id = ?').get(mimoWorkspace.id) as { provider_type: string }).provider_type, 'custom-cli');
      const beforeMimo = {
        workspace: (mimoFx.db.prepare('SELECT version FROM workspaces WHERE id = ?').get(mimoWorkspace.id) as { version: number }).version,
        provider: (mimoFx.db.prepare('SELECT version FROM provider_configurations WHERE workspace_id = ?').get(mimoWorkspace.id) as { version: number }).version,
      };
      const mimoWhitespaceSource = Buffer.from(`{ "workspaces" : [ ${JSON.stringify(mimoWorkspace)} ] }`, 'utf8');
      writeFileSync(join(mimoFx.root, 'workspace', 'workspaces.json'), mimoWhitespaceSource);
      const secondMimo = await mimoFx.service.run(runInput(mimoFx));
      assert.notDeepEqual(mimoFirstSource, mimoWhitespaceSource);
      assert.equal(secondMimo.equalCount, 1);
      assert.equal(secondMimo.conflictCount, 0);
      assert.equal(secondMimo.completedCount, 1);
      assert.equal((mimoFx.db.prepare('SELECT version FROM workspaces WHERE id = ?').get(mimoWorkspace.id) as { version: number }).version, beforeMimo.workspace);
      assert.equal((mimoFx.db.prepare('SELECT version FROM provider_configurations WHERE workspace_id = ?').get(mimoWorkspace.id) as { version: number }).version, beforeMimo.provider);
      const mimoRows = mimoFx.db.prepare(`SELECT revision, payload_hash, status FROM legacy_data_migrations WHERE scope_key = ? ORDER BY attempt`).all(mimoWorkspace.id) as Array<Record<string, unknown>>;
      assert.deepEqual(mimoRows.map(row => ({ revision: row.revision, status: row.status })), [{ revision: 1, status: 'completed' }, { revision: 1, status: 'completed' }]);
      assert.equal(mimoRows[0]?.payload_hash, mimoRows[1]?.payload_hash);
    } finally {
      mimoFx.cleanup();
    }
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

  const sourcePathFx = await fixture();
  try {
    writeSource(sourcePathFx.root, [workspace('source-backup-path', join(sourcePathFx.root, 'source-backup-path'), { agents: [] })]);
    sourcePathFx.db.close();
    const sourceFile = join(sourcePathFx.root, 'workspace', 'workspaces.json');
    const sourceBackupPath = await runCommand(['--database', sourcePathFx.databasePath, '--source-root', sourcePathFx.root, '--backup-dir', sourceFile, '--kind', 'workspace', '--mode', 'apply', '--confirm', 'APPLY-M2.7']);
    assert.equal(sourceBackupPath.code, 2);
    assert.match(sourceBackupPath.output, /LEGACY_WORKSPACE_MIGRATION_INVALID_ARGUMENTS/);
    assert.doesNotMatch(sourceBackupPath.output, new RegExp(sourcePathFx.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(readFileSync(sourceFile).length > 0, true);
  } finally {
    sourcePathFx.cleanup();
  }
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

    const applyResult = await runCommand(['--database', fx.databasePath, '--source-root', fx.root, '--backup-dir', join(fx.root, 'dry-backups'), '--kind', 'workspace', '--mode', 'apply', '--confirm', 'APPLY-M2.7']);
    assert.equal(applyResult.code, 0, applyResult.output);
    const backupCountAfterApply = readdirSync(join(fx.root, 'dry-backups')).length;
    const appliedDb = new DatabaseSync(fx.databasePath);
    const appliedVersion = (appliedDb.prepare('SELECT version FROM workspaces WHERE id = ?').get('dry-run') as { version: number }).version;
    const appliedCounts = {
      workspaces: (appliedDb.prepare('SELECT COUNT(*) AS count FROM workspaces').get() as { count: number }).count,
      agents: (appliedDb.prepare('SELECT COUNT(*) AS count FROM agent_profiles').get() as { count: number }).count,
      providers: (appliedDb.prepare('SELECT COUNT(*) AS count FROM provider_configurations').get() as { count: number }).count,
      records: (appliedDb.prepare('SELECT COUNT(*) AS count FROM legacy_data_migrations').get() as { count: number }).count,
    };
    appliedDb.close();
    const exactNoopDryRun = await runCommand(['--database', fx.databasePath, '--source-root', fx.root, '--backup-dir', join(fx.root, 'dry-backups'), '--kind', 'workspace', '--mode', 'dry-run']);
    assert.equal(exactNoopDryRun.code, 0, exactNoopDryRun.output);
    assert.match(exactNoopDryRun.output, /"noopCount":1/);
    assert.equal(readdirSync(join(fx.root, 'dry-backups')).length, backupCountAfterApply);
    const noopDb = new DatabaseSync(fx.databasePath);
    try {
      assert.equal((noopDb.prepare('SELECT version FROM workspaces WHERE id = ?').get('dry-run') as { version: number }).version, appliedVersion);
      assert.deepEqual({
        workspaces: (noopDb.prepare('SELECT COUNT(*) AS count FROM workspaces').get() as { count: number }).count,
        agents: (noopDb.prepare('SELECT COUNT(*) AS count FROM agent_profiles').get() as { count: number }).count,
        providers: (noopDb.prepare('SELECT COUNT(*) AS count FROM provider_configurations').get() as { count: number }).count,
        records: (noopDb.prepare('SELECT COUNT(*) AS count FROM legacy_data_migrations').get() as { count: number }).count,
      }, appliedCounts);
    } finally {
      noopDb.close();
    }
    assert.deepEqual(readFileSync(join(fx.root, 'workspace', 'workspaces.json')), source);

    const backupCountBeforeInvalid = readdirSync(join(fx.root, 'dry-backups')).length;
    const invalidSource = writeSource(fx.root, [workspace('dry-invalid', join(fx.root, 'dry-invalid'), { name: '' })]);
    const invalidDryRun = await runCommand(['--database', fx.databasePath, '--source-root', fx.root, '--backup-dir', join(fx.root, 'dry-backups'), '--kind', 'workspace', '--mode', 'dry-run']);
    assert.equal(invalidDryRun.code, 4, invalidDryRun.output);
    assert.equal(existsSync(join(fx.root, 'dry-backups')), true);
    assert.equal(readdirSync(join(fx.root, 'dry-backups')).length, backupCountBeforeInvalid);
    const invalidCheck = new DatabaseSync(fx.databasePath);
    try {
      assert.equal((invalidCheck.prepare('SELECT COUNT(*) AS count FROM legacy_data_migrations').get() as { count: number }).count, appliedCounts.records);
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
