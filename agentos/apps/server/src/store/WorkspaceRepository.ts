import type { Workspace } from '@agentos/shared';
import type { TransactionDatabase } from './Transaction.js';
import { inTransaction } from './Transaction.js';
import { assertVersionedMutation } from './Repository.js';
import { toCanonicalRootPath } from './WorkspacePath.js';

interface WorkspaceRow {
  id: string;
  name: string;
  root_path: string;
  canonical_root_path: string;
  git_enabled: number;
  memory_enabled: number;
  last_opened_at: string;
  created_at: string;
  updated_at: string;
  version: number;
}

export interface WorkspaceListRow {
  id: string;
  name: string;
  root_path: string;
  canonical_root_path: string;
  git_enabled: number;
  memory_enabled: number;
  last_opened_at: string;
  created_at: string;
  updated_at: string;
  version: number;
  agent_id: string | null;
  agent_name: string | null;
  agent_role: string | null;
  agent_provider: string | null;
  agent_enabled: number | null;
  agent_cli_command: string | null;
  agent_cli_args_json: string | null;
  agent_model: string | null;
  agent_thinking_effort: string | null;
  provider_config_id: string | null;
}

export class WorkspaceRepository {
  constructor(private db: TransactionDatabase) {}

  findAll(): Workspace[] {
    const rows = this.db.prepare(`
      SELECT w.*, ap.id AS agent_id, ap.name AS agent_name, ap.agent_role,
        ap.provider AS agent_provider, ap.enabled AS agent_enabled,
        ap.cli_command AS agent_cli_command, ap.cli_args_json AS agent_cli_args_json,
        ap.model AS agent_model, ap.thinking_effort AS agent_thinking_effort
      FROM workspaces w
      LEFT JOIN agent_profiles ap ON ap.workspace_id = w.id
      ORDER BY w.last_opened_at DESC, ap.name COLLATE NOCASE
    `).all() as WorkspaceListRow[];
    return this.assembleRows(rows);
  }

  findById(id: string): Workspace | undefined {
    const rows = this.db.prepare(`
      SELECT w.*, ap.id AS agent_id, ap.name AS agent_name, ap.agent_role,
        ap.provider AS agent_provider, ap.enabled AS agent_enabled,
        ap.cli_command AS agent_cli_command, ap.cli_args_json AS agent_cli_args_json,
        ap.model AS agent_model, ap.thinking_effort AS agent_thinking_effort,
        ap.provider_config_id
      FROM workspaces w
      LEFT JOIN agent_profiles ap ON ap.workspace_id = w.id
      WHERE w.id = ?
      ORDER BY ap.name COLLATE NOCASE
    `).all(id) as WorkspaceListRow[];
    if (rows.length === 0) return undefined;
    return this.assembleRows(rows)[0];
  }

  findByCanonicalPath(canonicalPath: string): Workspace | undefined {
    const rows = this.db.prepare(`
      SELECT w.*, ap.id AS agent_id, ap.name AS agent_name, ap.agent_role,
        ap.provider AS agent_provider, ap.enabled AS agent_enabled,
        ap.cli_command AS agent_cli_command, ap.cli_args_json AS agent_cli_args_json,
        ap.model AS agent_model, ap.thinking_effort AS agent_thinking_effort,
        ap.provider_config_id
      FROM workspaces w
      LEFT JOIN agent_profiles ap ON ap.workspace_id = w.id
      WHERE w.canonical_root_path = ?
      ORDER BY ap.name COLLATE NOCASE
    `).all(canonicalPath) as WorkspaceListRow[];
    if (rows.length === 0) return undefined;
    return this.assembleRows(rows)[0];
  }

  insert(workspace: Workspace): Workspace {
    inTransaction(this.db, () => {
      const canonicalPath = toCanonicalRootPath(workspace.rootPath);
      this.db.prepare(`
        INSERT INTO workspaces (id, name, root_path, canonical_root_path, git_enabled, memory_enabled,
          last_opened_at, created_at, updated_at, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `).run(
        workspace.id, workspace.name, workspace.rootPath, canonicalPath,
        workspace.gitEnabled ? 1 : 0, workspace.memoryEnabled ? 1 : 0,
        workspace.lastOpenedAt, workspace.createdAt, workspace.updatedAt,
      );
    });
    return workspace;
  }

  update(workspace: Workspace): Workspace {
    const canonicalPath = toCanonicalRootPath(workspace.rootPath);
    inTransaction(this.db, () => {
      const row = this.db.prepare('SELECT version FROM workspaces WHERE id = ?')
        .get(workspace.id) as { version: number } | undefined;
      if (!row) throw new Error('Workspace not found');

      const result = this.db.prepare(`
        UPDATE workspaces
        SET name = ?, root_path = ?, canonical_root_path = ?, git_enabled = ?, memory_enabled = ?,
          last_opened_at = ?, updated_at = ?, version = version + 1
        WHERE id = ? AND version = ?
      `).run(
        workspace.name, workspace.rootPath, canonicalPath,
        workspace.gitEnabled ? 1 : 0, workspace.memoryEnabled ? 1 : 0,
        workspace.lastOpenedAt, workspace.updatedAt,
        workspace.id, row.version,
      );

      assertVersionedMutation(result as { changes: number }, {
        entityType: 'workspaces', entityId: workspace.id, expectedVersion: row.version,
      });
    });
    return workspace;
  }

  deleteById(id: string): void {
    inTransaction(this.db, () => {
      this.db.prepare('DELETE FROM agent_profiles WHERE workspace_id = ?').run(id);
      this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
    });
  }

  exists(id: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM workspaces WHERE id = ?').get(id);
    return row !== undefined;
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS cnt FROM workspaces').get() as { cnt: number };
    return row.cnt;
  }

  private assembleRows(rows: WorkspaceListRow[]): Workspace[] {
    const map = new Map<string, Workspace>();
    for (const row of rows) {
      let ws = map.get(row.id);
      if (!ws) {
        ws = {
          id: row.id,
          name: row.name,
          rootPath: row.root_path,
          gitEnabled: row.git_enabled === 1,
          memoryEnabled: row.memory_enabled === 1,
          agents: [],
          lastOpenedAt: row.last_opened_at,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
        map.set(row.id, ws);
      }
      if (row.agent_id) {
        const agent = {
          id: row.agent_id,
          name: row.agent_name!,
          provider: (row.agent_provider || row.agent_role) as Workspace['agents'][number]['provider'],
          role: row.agent_role as Workspace['agents'][number]['role'],
          enabled: row.agent_enabled === 1,
          cliCommand: row.agent_cli_command!,
          cliArgs: parseJson<string[]>(row.agent_cli_args_json!, []),
          ...(row.agent_model ? { model: row.agent_model } : {}),
          ...(row.agent_thinking_effort && row.agent_thinking_effort !== 'auto'
            ? { thinkingEffort: row.agent_thinking_effort as Workspace['agents'][number]['thinkingEffort'] }
            : {}),
        };
        ws.agents.push(agent);
      }
    }
    return [...map.values()];
  }
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
