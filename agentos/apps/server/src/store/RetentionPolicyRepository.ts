import type { TransactionDatabase } from './Transaction.js';

/**
 * Retention policy configuration persistence (migration 065; 10-Data-Model
 * §116). A policy is a named, versioned JSON document per (scope, domain):
 * the workspace-specific enabled policy wins over the global one
 * (empty workspace_id). Consumers interpret policy_json per domain — the
 * Event retention service reads the 'runtime_events' domain shape.
 */
export class RetentionPolicyRepositoryError extends Error {
  constructor(readonly code: 'INPUT_INVALID' | 'PERSISTENCE_FAILED' | 'READ_FAILED' | 'NOT_FOUND', message: string) {
    super(code === 'PERSISTENCE_FAILED' || code === 'READ_FAILED' ? code : code + ': ' + message);
    this.name = 'RetentionPolicyRepositoryError';
  }
}

export interface RetentionPolicyRecord {
  readonly id: string;
  /** Empty string denotes the global (all-Workspaces) policy. */
  readonly workspaceId: string;
  readonly domain: string;
  readonly name: string;
  readonly policy: Record<string, unknown>;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface SaveRetentionPolicyInput {
  readonly id: string;
  readonly workspaceId?: string;
  readonly domain: string;
  readonly name: string;
  readonly policy: Record<string, unknown>;
  readonly enabled?: boolean;
  readonly now: string;
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function toRecord(row: Record<string, unknown>): RetentionPolicyRecord {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    domain: row.domain as string,
    name: row.name as string,
    policy: JSON.parse(row.policy_json as string) as Record<string, unknown>,
    enabled: (row.enabled as number) === 1,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    version: row.version as number,
  };
}

export class RetentionPolicyRepository {
  constructor(private readonly db: TransactionDatabase) {}

  /**
   * Create or replace the (workspaceId|global, domain, name) policy row.
   * Re-saves keep the row id and bump version/updated_at.
   */
  save(input: SaveRetentionPolicyInput): RetentionPolicyRecord {
    if (!nonBlank(input.id) || !nonBlank(input.domain) || !nonBlank(input.name) || !nonBlank(input.now)
      || input.policy === null || typeof input.policy !== 'object' || Array.isArray(input.policy)) {
      throw new RetentionPolicyRepositoryError('INPUT_INVALID', 'a required policy field is missing or blank');
    }
    const workspaceId = input.workspaceId ?? '';
    const enabled = input.enabled ?? true;
    const policyJson = JSON.stringify(input.policy);
    try {
      this.db.prepare(
        `INSERT INTO retention_policies (id, workspace_id, domain, name, policy_json, enabled, created_at, updated_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(workspace_id, domain, name) DO UPDATE SET
           policy_json = excluded.policy_json,
           enabled = excluded.enabled,
           updated_at = excluded.updated_at,
           version = version + 1`,
      ).run(input.id, workspaceId, input.domain, input.name, policyJson, enabled ? 1 : 0, input.now, input.now);
    } catch (error) {
      throw new RetentionPolicyRepositoryError('PERSISTENCE_FAILED', error instanceof Error ? error.message : 'retention policy could not be saved');
    }
    const record = this.get(workspaceId, input.domain, input.name);
    if (record === undefined) {
      throw new RetentionPolicyRepositoryError('PERSISTENCE_FAILED', 'policy row not readable after save: ' + input.id);
    }
    return record;
  }

  get(workspaceId: string | undefined, domain: string, name: string): RetentionPolicyRecord | undefined {
    if (!nonBlank(domain) || !nonBlank(name)) return undefined;
    const row = this.db.prepare(
      'SELECT * FROM retention_policies WHERE workspace_id = ? AND domain = ? AND name = ?',
    ).get(workspaceId ?? '', domain, name) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  /**
   * The effective policy for a domain: the workspace-specific enabled row
   * wins over the global enabled row. Returns undefined when neither exists
   * or the only matching rows are disabled.
   */
  getEffective(workspaceId: string | undefined, domain: string): RetentionPolicyRecord | undefined {
    if (!nonBlank(domain)) return undefined;
    const scoped = this.get(workspaceId, domain, 'default') ?? this.listScoped(workspaceId, domain).find(p => p.enabled);
    if (scoped?.enabled) return scoped;
    const global = this.listScoped('', domain).find(p => p.enabled);
    return global;
  }

  list(domain?: string): RetentionPolicyRecord[] {
    const rows = (domain === undefined
      ? this.db.prepare('SELECT * FROM retention_policies ORDER BY domain ASC, workspace_id ASC, name ASC').all()
      : this.db.prepare('SELECT * FROM retention_policies WHERE domain = ? ORDER BY workspace_id ASC, name ASC').all(domain)) as Record<string, unknown>[];
    return rows.map(toRecord);
  }

  private listScoped(workspaceId: string | undefined, domain: string): RetentionPolicyRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM retention_policies WHERE workspace_id = ? AND domain = ? ORDER BY name ASC',
    ).all(workspaceId ?? '', domain) as Record<string, unknown>[];
    return rows.map(toRecord);
  }
}
