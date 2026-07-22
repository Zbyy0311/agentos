import type { TransactionDatabase } from './Transaction.js';
import { inTransaction } from './Transaction.js';
import { assertVersionedMutation } from './Repository.js';
import { createEntityId } from './Identity.js';

export interface ProviderCapabilities {
  sessionResume: boolean;
  structuredEvents: boolean;
  nativeApprovals: boolean;
  subagents: boolean;
  toolEvents: boolean;
  fileEvents: boolean;
  usageEvents: boolean;
  reasoningStream: boolean;
  interactiveInput: boolean;
  pause: boolean;
  cancellation: boolean;
  modelSelection: boolean;
  workspaceAwareness: boolean;
  nativeSandbox: boolean;
  outputContracts: boolean;
}

export const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  sessionResume: false,
  structuredEvents: false,
  nativeApprovals: false,
  subagents: false,
  toolEvents: false,
  fileEvents: false,
  usageEvents: false,
  reasoningStream: false,
  interactiveInput: false,
  pause: false,
  cancellation: false,
  modelSelection: false,
  workspaceAwareness: false,
  nativeSandbox: false,
  outputContracts: false,
};

export interface ProviderTimeoutPolicy {
  discoveryTimeoutMs: number;
  validationTimeoutMs: number;
  startupTimeoutMs: number;
  idleTimeoutMs: number | null;
  totalTimeoutMs: number | null;
  cancelGracePeriodMs: number;
  approvalTimeoutMs: number | null;
}

export const DEFAULT_TIMEOUT_POLICY: ProviderTimeoutPolicy = {
  discoveryTimeoutMs: 10_000,
  validationTimeoutMs: 30_000,
  startupTimeoutMs: 60_000,
  idleTimeoutMs: 600_000,
  totalTimeoutMs: null,
  cancelGracePeriodMs: 5_000,
  approvalTimeoutMs: null,
};

export type ProviderType = 'codex' | 'claude-code' | 'kimicode' | 'opencode' | 'gemini-cli' | 'custom-cli' | 'remote';
export type RuntimeMode = 'cli' | 'api' | 'ssh' | 'container';
export type WorkingDirectoryMode = 'workspace' | 'worktree' | 'custom';
export type ApprovalMode = 'agentos' | 'native' | 'hybrid' | 'disabled';
export type OutputMode = 'structured' | 'parsed-text' | 'raw-stream';

export interface ProviderConfiguration {
  id: string;
  workspaceId?: string;
  name: string;
  providerType: ProviderType;
  adapterId: string;
  runtimeMode: RuntimeMode;
  executable?: string;
  argsTemplate?: string[];
  model?: string;
  environmentProfileId?: string;
  secretProfileId?: string;
  workingDirectoryMode: WorkingDirectoryMode;
  customWorkingDirectory?: string;
  capabilities: ProviderCapabilities;
  timeoutPolicy: ProviderTimeoutPolicy;
  approvalMode: ApprovalMode;
  outputMode: OutputMode;
  enabled: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

interface ProviderConfigurationRow {
  id: string;
  workspace_id: string | null;
  name: string;
  provider_type: ProviderType;
  adapter_id: string;
  runtime_mode: RuntimeMode;
  executable: string | null;
  args_template_json: string;
  model: string | null;
  environment_profile_id: string | null;
  secret_profile_id: string | null;
  working_directory_mode: WorkingDirectoryMode;
  custom_working_directory: string | null;
  capabilities_json: string;
  timeout_policy_json: string;
  approval_mode: ApprovalMode;
  output_mode: OutputMode;
  enabled: number;
  version: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export class ProviderConfigurationRepository {
  constructor(private db: TransactionDatabase) {}

  findByWorkspace(workspaceId: string): ProviderConfiguration[] {
    const rows = this.db.prepare(`
      SELECT * FROM provider_configurations
      WHERE workspace_id = ? AND archived_at IS NULL
      ORDER BY name COLLATE NOCASE
    `).all(workspaceId) as ProviderConfigurationRow[];
    return rows.map(r => this.toDomain(r));
  }

  findById(id: string): ProviderConfiguration | undefined {
    const row = this.db.prepare('SELECT * FROM provider_configurations WHERE id = ?')
      .get(id) as ProviderConfigurationRow | undefined;
    return row ? this.toDomain(row) : undefined;
  }

  /** Exact-name lookup within a workspace. Includes archived rows so results match the UNIQUE(workspace_id, name) index semantics. */
  findByWorkspaceAndName(workspaceId: string, name: string): ProviderConfiguration | undefined {
    const row = this.db.prepare(`
      SELECT * FROM provider_configurations
      WHERE workspace_id = ? AND name = ?
    `).get(workspaceId, name) as ProviderConfigurationRow | undefined;
    return row ? this.toDomain(row) : undefined;
  }

  insert(config: ProviderConfiguration): ProviderConfiguration {
    inTransaction(this.db, () => {
      this.db.prepare(`
        INSERT INTO provider_configurations (
          id, workspace_id, name, provider_type, adapter_id, runtime_mode,
          executable, args_template_json, model, environment_profile_id, secret_profile_id,
          working_directory_mode, custom_working_directory, capabilities_json,
          timeout_policy_json, approval_mode, output_mode, enabled, version,
          created_at, updated_at, archived_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        config.id, config.workspaceId ?? null, config.name, config.providerType,
        config.adapterId, config.runtimeMode,
        config.executable ?? null, JSON.stringify(config.argsTemplate ?? []),
        config.model ?? null, config.environmentProfileId ?? null,
        config.secretProfileId ?? null,
        config.workingDirectoryMode, config.customWorkingDirectory ?? null,
        JSON.stringify(config.capabilities), JSON.stringify(config.timeoutPolicy),
        config.approvalMode, config.outputMode, config.enabled ? 1 : 0,
        config.version, config.createdAt, config.updatedAt, config.archivedAt ?? null,
      );
    });
    return config;
  }

  update(config: ProviderConfiguration, expectedVersion: number): ProviderConfiguration {
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      throw new Error('expectedVersion is required');
    }
    inTransaction(this.db, () => {
      const row = { version: expectedVersion };

      const result = this.db.prepare(`
        UPDATE provider_configurations SET
          name = ?, provider_type = ?, adapter_id = ?, runtime_mode = ?,
          executable = ?, args_template_json = ?, model = ?, environment_profile_id = ?,
          secret_profile_id = ?, working_directory_mode = ?, custom_working_directory = ?,
          capabilities_json = ?, timeout_policy_json = ?, approval_mode = ?, output_mode = ?,
          enabled = ?, updated_at = ?, archived_at = ?, version = version + 1
        WHERE id = ? AND version = ?
      `).run(
        config.name, config.providerType, config.adapterId, config.runtimeMode,
        config.executable ?? null, JSON.stringify(config.argsTemplate ?? []),
        config.model ?? null, config.environmentProfileId ?? null,
        config.secretProfileId ?? null, config.workingDirectoryMode,
        config.customWorkingDirectory ?? null,
        JSON.stringify(config.capabilities), JSON.stringify(config.timeoutPolicy),
        config.approvalMode, config.outputMode, config.enabled ? 1 : 0,
        config.updatedAt, config.archivedAt ?? null,
        config.id, row.version,
      );

      assertVersionedMutation(result as { changes: number }, {
        entityType: 'provider_configurations', entityId: config.id, expectedVersion: row.version,
      });
    });
    return { ...config, version: expectedVersion + 1 };
  }

  archive(id: string, expectedVersion: number): void {
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      throw new Error('expectedVersion is required');
    }
    const config = this.findById(id);
    if (!config) throw new Error('Provider configuration not found');
    config.archivedAt = new Date().toISOString();
    config.updatedAt = new Date().toISOString();
    this.update(config, expectedVersion);
  }

  private toDomain(row: ProviderConfigurationRow): ProviderConfiguration {
    return {
      id: row.id,
      ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}),
      name: row.name,
      providerType: row.provider_type,
      adapterId: row.adapter_id,
      runtimeMode: row.runtime_mode,
      ...(row.executable ? { executable: row.executable } : {}),
      ...(row.args_template_json && row.args_template_json !== '[]'
        ? { argsTemplate: JSON.parse(row.args_template_json) as string[] }
        : {}),
      ...(row.model ? { model: row.model } : {}),
      ...(row.environment_profile_id ? { environmentProfileId: row.environment_profile_id } : {}),
      ...(row.secret_profile_id ? { secretProfileId: row.secret_profile_id } : {}),
      workingDirectoryMode: row.working_directory_mode,
      ...(row.custom_working_directory ? { customWorkingDirectory: row.custom_working_directory } : {}),
      capabilities: JSON.parse(row.capabilities_json) as ProviderCapabilities,
      timeoutPolicy: JSON.parse(row.timeout_policy_json) as ProviderTimeoutPolicy,
      approvalMode: row.approval_mode,
      outputMode: row.output_mode,
      enabled: row.enabled === 1,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
    };
  }
}
