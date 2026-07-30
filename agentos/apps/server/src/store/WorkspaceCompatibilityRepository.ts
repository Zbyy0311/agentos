import type { AgentProfile, Workspace } from '@agentos/shared';

import type { ProviderConfiguration } from './ProviderConfigurationRepository.js';
import { ProviderConfigurationRepository } from './ProviderConfigurationRepository.js';
import type { TransactionDatabase } from './Transaction.js';
import { WorkspaceRepository } from './WorkspaceRepository.js';
import { LegacyDataMigrationRepository, type LegacyMigrationScope } from './LegacyDataMigrationRepository.js';

export interface WorkspaceTombstone {
  workspaceId: string;
  deletedAt: string;
}

export interface AgentCompatibilityProjection {
  id: string;
  workspaceId: string;
  name: string;
  role: AgentProfile['role'];
  provider: AgentProfile['provider'];
  enabled: boolean;
  cliCommand: string;
  cliArgs: string[];
  model?: string;
  thinkingEffort: AgentProfile['thinkingEffort'];
  providerConfigId: string | null;
  providerConfiguration?: ProviderConfiguration;
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error('invalid agent arguments');
  }
  return value;
}

export class WorkspaceCompatibilityRepository {
  private readonly workspaces: WorkspaceRepository;
  private readonly providers: ProviderConfigurationRepository;

  constructor(private readonly db: TransactionDatabase) {
    this.workspaces = new WorkspaceRepository(db);
    this.providers = new ProviderConfigurationRepository(db);
  }

  findWorkspaceById(id: string): Workspace | undefined {
    return this.workspaces.findById(id);
  }

  findWorkspaceByCanonicalPath(path: string): Workspace | undefined {
    return this.workspaces.findByCanonicalPath(path);
  }

  findWorkspaceByRootPath(path: string): Workspace | undefined {
    return this.workspaces.findByRootPath(path);
  }

  findTombstone(id: string): WorkspaceTombstone | null {
    const row = this.db.prepare(
      'SELECT workspace_id, deleted_at FROM _workspace_tombstones WHERE workspace_id = ?',
    ).get(id) as { workspace_id?: unknown; deleted_at?: unknown } | undefined;
    if (row === undefined) return null;
    if (typeof row.workspace_id !== 'string' || typeof row.deleted_at !== 'string') {
      throw new Error('invalid workspace tombstone');
    }
    return { workspaceId: row.workspace_id, deletedAt: row.deleted_at };
  }

  findAgent(workspaceId: string, agentId: string): AgentCompatibilityProjection | undefined {
    const row = this.db.prepare(`
      SELECT workspace_id, id, name, agent_role, provider, enabled,
        cli_command, cli_args_json, model, thinking_effort, provider_config_id
      FROM agent_profiles
      WHERE workspace_id = ? AND id = ?
    `).get(workspaceId, agentId) as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    if (typeof row.workspace_id !== 'string' || typeof row.id !== 'string'
      || typeof row.name !== 'string' || typeof row.agent_role !== 'string'
      || typeof row.enabled !== 'number' || typeof row.cli_command !== 'string'
      || typeof row.cli_args_json !== 'string' || typeof row.thinking_effort !== 'string') {
      throw new Error('invalid agent profile');
    }
    const providerConfigId = row.provider_config_id === null
      ? null
      : typeof row.provider_config_id === 'string' ? row.provider_config_id : (() => { throw new Error('invalid provider binding'); })();
    const providerConfiguration = providerConfigId === null
      ? undefined
      : this.providers.findById(providerConfigId);
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      name: row.name,
      role: row.agent_role as AgentProfile['role'],
      provider: (row.provider ?? undefined) as AgentProfile['provider'],
      enabled: row.enabled === 1,
      cliCommand: row.cli_command,
      cliArgs: parseStringArray(JSON.parse(row.cli_args_json)),
      ...(typeof row.model === 'string' ? { model: row.model } : {}),
      thinkingEffort: row.thinking_effort as AgentProfile['thinkingEffort'],
      providerConfigId,
      ...(providerConfiguration ? { providerConfiguration } : {}),
    };
  }

  findProviderByWorkspaceAndName(workspaceId: string, name: string): ProviderConfiguration | undefined {
    return this.providers.findByWorkspaceAndName(workspaceId, name);
  }

  findCompletedByExactSource(scope: LegacyMigrationScope) {
    return new LegacyDataMigrationRepository(this.db).findCompletedByExactSource(scope);
  }

  insertWorkspaceWithinTransaction(workspace: Workspace): Workspace {
    return this.workspaces.insertWithinTransaction(workspace);
  }

  insertProviderWithinTransaction(config: ProviderConfiguration): ProviderConfiguration {
    return this.providers.insertWithinTransaction(config);
  }

  insertAgentWithinTransaction(profile: AgentProfile): AgentProfile {
    this.db.prepare(`
      INSERT INTO agent_profiles (
        workspace_id, id, name, agent_role, provider, role_title, system_prompt,
        permissions_json, enabled, cli_command, cli_args_json, model, thinking_effort,
        provider_config_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      profile.workspaceId, profile.id, profile.name, profile.role, profile.provider ?? null,
      profile.roleTitle, profile.systemPrompt, JSON.stringify(profile.permissions), profile.enabled ? 1 : 0,
      profile.cliCommand, JSON.stringify(profile.cliArgs), profile.model ?? null,
      profile.thinkingEffort ?? 'auto', profile.providerConfigId ?? null,
      profile.createdAt, profile.updatedAt,
    );
    return profile;
  }

  bindAgentProviderWithinTransaction(workspaceId: string, agentId: string, providerConfigId: string): void {
    this.db.prepare(`
      UPDATE agent_profiles SET provider_config_id = ?
      WHERE workspace_id = ? AND id = ? AND provider_config_id IS NULL
    `).run(providerConfigId, workspaceId, agentId);
  }
}
