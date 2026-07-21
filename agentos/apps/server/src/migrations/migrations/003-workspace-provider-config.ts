import { createHash } from 'node:crypto';
import type { Migration, MigrationContext } from '../types.js';

const DDL_STATEMENTS = [
  `CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    root_path TEXT NOT NULL,
    canonical_root_path TEXT NOT NULL UNIQUE,
    repository_type TEXT NOT NULL DEFAULT 'directory',
    default_branch TEXT,
    default_agent_id TEXT,
    default_provider_config_id TEXT,
    default_workflow_definition_id TEXT,
    default_policy_profile_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    settings_version INTEGER NOT NULL DEFAULT 1,
    git_enabled INTEGER NOT NULL DEFAULT 1,
    memory_enabled INTEGER NOT NULL DEFAULT 1,
    last_opened_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT,
    deleted_at TEXT,
    version INTEGER NOT NULL DEFAULT 1
  )`,

  `CREATE INDEX IF NOT EXISTS idx_workspaces_status ON workspaces(status)`,

  `CREATE TABLE provider_configurations (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    name TEXT NOT NULL,
    provider_type TEXT NOT NULL CHECK (provider_type IN ('codex','claude-code','kimicode','opencode','gemini-cli','custom-cli','remote')),
    adapter_id TEXT NOT NULL,
    runtime_mode TEXT NOT NULL CHECK (runtime_mode IN ('cli','api','ssh','container')),
    executable TEXT,
    args_template_json TEXT NOT NULL DEFAULT '[]',
    model TEXT,
    environment_profile_id TEXT,
    secret_profile_id TEXT,
    working_directory_mode TEXT NOT NULL DEFAULT 'workspace' CHECK (working_directory_mode IN ('workspace','worktree','custom')),
    custom_working_directory TEXT,
    capabilities_json TEXT NOT NULL,
    timeout_policy_json TEXT NOT NULL,
    approval_mode TEXT NOT NULL DEFAULT 'agentos' CHECK (approval_mode IN ('agentos','native','hybrid','disabled')),
    output_mode TEXT NOT NULL DEFAULT 'parsed-text' CHECK (output_mode IN ('structured','parsed-text','raw-stream')),
    enabled INTEGER NOT NULL DEFAULT 1,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
  )`,

  `CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_config_workspace_name ON provider_configurations(workspace_id, name)`,

  `CREATE INDEX IF NOT EXISTS idx_provider_config_workspace_enabled ON provider_configurations(workspace_id, enabled)`,

  `ALTER TABLE agent_profiles ADD COLUMN provider_config_id TEXT REFERENCES provider_configurations(id)`,

  `CREATE INDEX IF NOT EXISTS idx_agent_profiles_provider_config ON agent_profiles(provider_config_id)`,
];

const CANONICAL_SOURCE = DDL_STATEMENTS.join('\n');

export const migration003Checksum = createHash('sha256')
  .update(CANONICAL_SOURCE)
  .digest('hex')
  .slice(0, 16);

export const migration003: Migration = {
  id: '003',
  name: 'workspace-provider-config',
  checksum: migration003Checksum,
  apply(ctx: MigrationContext): void {
    for (const stmt of DDL_STATEMENTS) {
      ctx.db.exec(stmt);
    }
  },
};
