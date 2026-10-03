import type { ProviderAuthenticationState, ProviderValidationResult } from '@agentos/agent-core/providers';
import type { ProviderCapabilitiesV1 } from '@agentos/shared';
import {
  CodexProviderAdapter,
  KimiCodeProviderAdapter,
  OpenCodeProviderAdapter,
  ProviderRegistry,
  ProviderValidationService as LocalProviderValidationService,
} from '@agentos/agent-core/providers';
import { NodeProcessProbePort } from '@agentos/process-runtime';
import type { SqliteStore } from '../store/SqliteStore.js';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { ProviderConfigurationRepository, type ProviderConfiguration } from '../store/ProviderConfigurationRepository.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import { getAgentOsBuildIdentity } from './BuildIdentity.js';

type Statement = {
  all(...parameters: unknown[]): unknown[];
  get(...parameters: unknown[]): unknown;
};
type Database = { prepare(sql: string): Statement };

export interface ProviderValidator {
  validate(configuration: ProviderConfiguration, overrides?: { environment?: NodeJS.ProcessEnv; workspaceRoot?: string }): Promise<ProviderValidationResult>;
}

export function createLocalProviderValidator(): ProviderValidator {
  const probe = new NodeProcessProbePort();
  const validator = new LocalProviderValidationService(new ProviderRegistry([
    new KimiCodeProviderAdapter({ probe }),
    new CodexProviderAdapter({ probe }),
    new OpenCodeProviderAdapter({ probe }),
  ]));
  return { validate: (configuration, overrides) => validator.validate(configuration, overrides) };
}

export interface ReadinessReport {
  readonly ok: boolean;
  readonly checkedAt: string;
  readonly build: ReturnType<typeof getAgentOsBuildIdentity>;
  readonly liveness: { readonly ok: true };
  readonly database: {
    readonly status: 'ok' | 'failed';
    readonly integrity: 'ok' | 'failed' | 'unknown';
    readonly foreignKeys: 'ok' | 'failed' | 'unknown';
  };
  readonly migrations: {
    readonly status: 'current' | 'pending' | 'invalid' | 'unknown';
    readonly appliedVersion: string;
    readonly expectedVersion: string;
    readonly pendingIds: readonly string[];
    readonly mismatchedIds: readonly string[];
  };
  readonly recovery: {
    readonly status: 'clear' | 'pending' | 'unknown';
    readonly activeExecutions: Readonly<Record<string, number>>;
    readonly recoveryRequiredRuns: number;
    readonly pendingAdmissions: number;
  };
  readonly providers: {
    readonly status: 'available' | 'degraded' | 'unknown';
    readonly configured: number;
    readonly validated: number;
    readonly entries: readonly ProviderReadinessEntry[];
  };
  readonly maintenance: ReadinessMaintenanceStatus;
}

export interface ReadinessMaintenanceStatus {
  readonly active: boolean;
  readonly quiescing: boolean;
  readonly recoveredAfterRestart: boolean;
  readonly operation?: {
    readonly kind: string;
    readonly status: string;
    readonly startedAt: string;
    readonly leaseExpiresAt: string;
  };
}

export interface MaintenanceDiagnosticsOptions {
  readonly providerValidator?: ProviderValidator;
  readonly now?: () => Date;
  readonly readMaintenanceStatus?: () => ReadinessMaintenanceStatus;
}

export interface SanitizedDiagnosticsExport {
  readonly format: 'agentos-diagnostics';
  readonly formatVersion: 1;
  readonly exportedAt: string;
  readonly build: ReturnType<typeof getAgentOsBuildIdentity>;
  readonly readiness: Omit<ReadinessReport, 'build' | 'providers'> & {
    readonly providers: Omit<ReadinessReport['providers'], 'entries'> & {
      readonly entries: readonly (Omit<ProviderReadinessEntry, 'capabilities'> & { readonly capabilities: ProviderCapabilitiesV1 })[];
    };
  };
}

export interface MaintenanceActivitySnapshot {
  readonly counts: Readonly<Record<string, number>>;
  readonly unknown?: boolean;
}

export interface ProviderReadinessEntry {
  readonly providerConfigId: string;
  readonly providerType: string;
  readonly enabled: boolean;
  readonly validation: 'valid' | 'invalid' | 'unknown' | 'disabled';
  readonly cliVersion?: string;
  readonly authentication?: ProviderValidationResult['authentication'];
  readonly capabilities: ProviderValidationResult['capabilities'];
  readonly outputMode: ProviderValidationResult['outputMode'];
  readonly errorCodes: readonly string[];
  readonly checkedAt?: string;
}

export class MaintenanceDiagnosticsService {
  private readonly database: Database;
  private readonly providerRepository: ProviderConfigurationRepository;
  private readonly providerValidator: ProviderValidator;
  private readonly now: () => Date;
  private readMaintenanceStatus: () => ReadinessMaintenanceStatus;

  constructor(
    private readonly store: SqliteStore,
    private readonly workspaces: WorkspaceManager,
    private readonly options: MaintenanceDiagnosticsOptions = {},
  ) {
    this.database = store.getDatabase() as unknown as Database;
    this.providerRepository = new ProviderConfigurationRepository(this.database as any);
    this.providerValidator = options.providerValidator ?? createLocalProviderValidator();
    this.now = options.now ?? (() => new Date());
    this.readMaintenanceStatus = options.readMaintenanceStatus ?? (() => ({
      active: false,
      quiescing: false,
      recoveredAfterRestart: false,
    }));
  }

  setMaintenanceStatusReader(reader: () => ReadinessMaintenanceStatus): void {
    this.readMaintenanceStatus = reader;
  }

  async readiness(): Promise<ReadinessReport> {
    const checkedAt = this.now().toISOString();
    const database = this.checkDatabase();
    const migrations = this.checkMigrations();
    const recovery = this.checkRecovery();
    const providers = await this.checkProviders();
    const maintenance = this.readMaintenanceStatus();
    const ok = database.status === 'ok'
      && migrations.status === 'current'
      && recovery.status !== 'unknown'
      && recovery.recoveryRequiredRuns === 0
      && !maintenance.active;
    return { ok, checkedAt, build: getAgentOsBuildIdentity(), liveness: { ok: true }, database, migrations, recovery, providers, maintenance };
  }

  async exportSanitized(): Promise<SanitizedDiagnosticsExport> {
    const report = await this.readiness();
    const providers = {
      status: report.providers.status,
      configured: report.providers.configured,
      validated: report.providers.validated,
      entries: report.providers.entries.map(entry => ({
        providerConfigId: safeDiagnosticLabel(entry.providerConfigId) ?? 'unknown',
        providerType: safeDiagnosticLabel(entry.providerType) ?? 'unknown',
        enabled: entry.enabled,
        validation: entry.validation,
        ...(entry.cliVersion ? { cliVersion: entry.cliVersion } : {}),
        ...(safeAuthentication(entry.authentication) ? { authentication: safeAuthentication(entry.authentication) } : {}),
        capabilities: sanitizeCapabilities(entry.capabilities),
        outputMode: entry.outputMode,
        errorCodes: entry.errorCodes.filter(code => /^[A-Z0-9_]{1,80}$/u.test(code)),
        ...(safeTimestamp(entry.checkedAt) ? { checkedAt: safeTimestamp(entry.checkedAt) } : {}),
      })),
    };
    return {
      format: 'agentos-diagnostics',
      formatVersion: 1,
      exportedAt: report.checkedAt,
      build: report.build,
      readiness: {
        ok: report.ok,
        checkedAt: report.checkedAt,
        liveness: report.liveness,
        database: report.database,
        migrations: report.migrations,
        recovery: report.recovery,
        providers,
        maintenance: sanitizeMaintenanceStatus(report.maintenance),
      },
    };
  }

  inspectActivity(): MaintenanceActivitySnapshot {
    return inspectMaintenanceActivity(this.database);
  }

  private checkDatabase(): ReadinessReport['database'] {
    try {
      const integrity = this.database.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>;
      const integrityOk = integrity.length === 1 && integrity[0]?.integrity_check === 'ok';
      const foreignKeys = this.database.prepare('PRAGMA foreign_key_check').all();
      const foreignKeysOk = foreignKeys.length === 0;
      return {
        status: integrityOk && foreignKeysOk ? 'ok' : 'failed',
        integrity: integrityOk ? 'ok' : 'failed',
        foreignKeys: foreignKeysOk ? 'ok' : 'failed',
      };
    } catch {
      return { status: 'failed', integrity: 'unknown', foreignKeys: 'unknown' };
    }
  }

  private checkMigrations(): ReadinessReport['migrations'] {
    try {
      const applied = this.database.prepare('SELECT migration_id AS id, name, checksum FROM _schema_migrations ORDER BY CAST(migration_id AS INTEGER)')
        .all() as Array<{ id: string; name: string; checksum: string }>;
      const expected = DEFAULT_REGISTRY_MIGRATIONS;
      const appliedById = new Map(applied.map(item => [item.id, item]));
      const expectedById = new Map(expected.map(item => [item.id, item]));
      const mismatchedIds = applied.filter(item => {
        const known = expectedById.get(item.id);
        return !known || known.name !== item.name || known.checksum !== item.checksum;
      }).map(item => item.id);
      const pendingIds = expected.filter(item => !appliedById.has(item.id)).map(item => item.id);
      const latest = applied.at(-1)?.id ?? '000';
      const expectedLatest = expected.at(-1)?.id ?? '000';
      const status = mismatchedIds.length > 0 ? 'invalid' : pendingIds.length > 0 ? 'pending' : 'current';
      return { status, appliedVersion: latest, expectedVersion: expectedLatest, pendingIds, mismatchedIds };
    } catch {
      const expectedLatest = DEFAULT_REGISTRY_MIGRATIONS.at(-1)?.id ?? '000';
      return { status: 'unknown', appliedVersion: 'unknown', expectedVersion: expectedLatest, pendingIds: [], mismatchedIds: [] };
    }
  }

  private checkRecovery(): ReadinessReport['recovery'] {
    try {
      const activeExecutions = this.inspectActivity();
      if (activeExecutions.unknown) return { status: 'unknown', activeExecutions: activeExecutions.counts, recoveryRequiredRuns: 0, pendingAdmissions: 0 };
      const recoveryRequiredRuns = hasColumn(this.database, 'runs', 'recovery_required')
        ? countWhere(this.database, 'runs', 'recovery_required = 1')
        : 0;
      const pendingAdmissions = tableExists(this.database, 'workspace_admissions')
        ? countWhere(this.database, 'workspace_admissions', "state IN ('REQUESTED', 'QUEUED')")
        : 0;
      return {
        status: recoveryRequiredRuns > 0 ? 'pending' : 'clear',
        activeExecutions: activeExecutions.counts,
        recoveryRequiredRuns,
        pendingAdmissions: Number.isFinite(pendingAdmissions) ? pendingAdmissions : 0,
      };
    } catch {
      return { status: 'unknown', activeExecutions: {}, recoveryRequiredRuns: 0, pendingAdmissions: 0 };
    }
  }

  private async checkProviders(): Promise<ReadinessReport['providers']> {
    const entries: ProviderReadinessEntry[] = [];
    let configured = 0;
    let validated = 0;
    let failed = false;
    try {
      const workspaceById = new Map(this.workspaces.list().map(workspace => [workspace.id, workspace]));
      for (const workspace of workspaceById.values()) {
        for (const configuration of this.providerRepository.findByWorkspace(workspace.id)) {
          configured += 1;
          if (!configuration.enabled) {
            entries.push({
              providerConfigId: safeDiagnosticLabel(configuration.id) ?? 'unknown',
              providerType: safeDiagnosticLabel(configuration.providerType) ?? 'unknown',
              enabled: false,
              validation: 'disabled',
              capabilities: sanitizeCapabilities(configuration.capabilities),
              outputMode: configuration.outputMode,
              errorCodes: [],
            });
            continue;
          }
          try {
            const result = await this.providerValidator.validate(configuration, {
              environment: process.env,
              workspaceRoot: workspace.rootPath,
            });
            validated += 1;
            if (!result.valid) failed = true;
            entries.push({
              providerConfigId: safeDiagnosticLabel(configuration.id) ?? 'unknown',
              providerType: safeDiagnosticLabel(configuration.providerType) ?? 'unknown',
              enabled: true,
              validation: result.valid ? 'valid' : 'invalid',
              ...(safeVersion(result.cliVersion) ? { cliVersion: safeVersion(result.cliVersion) } : {}),
              ...(safeAuthentication(result.authentication) ? { authentication: safeAuthentication(result.authentication) } : {}),
              capabilities: sanitizeCapabilities(result.capabilities),
              outputMode: result.outputMode,
              errorCodes: result.errors.map(error => safeProviderCode(error.code)),
              ...(safeTimestamp(result.checkedAt) ? { checkedAt: safeTimestamp(result.checkedAt) } : {}),
            });
          } catch {
            failed = true;
            entries.push({
              providerConfigId: safeDiagnosticLabel(configuration.id) ?? 'unknown',
              providerType: safeDiagnosticLabel(configuration.providerType) ?? 'unknown',
              enabled: true,
              validation: 'unknown',
              capabilities: sanitizeCapabilities(configuration.capabilities),
              outputMode: configuration.outputMode,
              errorCodes: ['PROVIDER_VALIDATION_FAILED'],
            });
          }
        }
      }
      return { status: failed ? 'degraded' : 'available', configured, validated, entries };
    } catch {
      return { status: 'unknown', configured, validated, entries };
    }
  }
}

export function inspectMaintenanceActivity(database: Database): MaintenanceActivitySnapshot {
  const counts: Record<string, number> = {};
  let unknown = false;
  const policies: ReadonlyArray<{ table: string; statuses: readonly string[] }> = [
    { table: 'runs', statuses: ['starting', 'running'] },
    { table: 'run_stages', statuses: ['running'] },
    { table: 'agent_runs', statuses: ['running'] },
    { table: 'executions', statuses: ['running'] },
    { table: 'cr_agent_turns', statuses: ['streaming'] },
    // Group provider work can outlive the HTTP response that dispatched it.
    // Interrupted owners are reconciled during startup and are deliberately
    // not active after that durable recovery boundary.
    { table: 'cr_group_interaction_executions', statuses: ['claimed', 'running', 'stop_requested'] },
    // A running summarizer is an independent provider call; queued work has not
    // crossed the provider boundary and does not hold maintenance.
    { table: 'conversation_compactions', statuses: ['running'] },
    { table: 'runtime_processes', statuses: ['created', 'starting', 'running', 'waiting', 'stopping'] },
    { table: 'processes', statuses: ['starting', 'running'] },
  ];
  for (const policy of policies) {
    if (!tableExists(database, policy.table)) continue;
    try {
      const columns = tableColumns(database, policy.table);
      const statusColumn = columns.includes('status') ? 'status' : columns.includes('state') ? 'state' : undefined;
      if (!statusColumn) { unknown = true; continue; }
      const placeholders = policy.statuses.map(() => '?').join(',');
      const row = database.prepare(`SELECT COUNT(*) AS count FROM "${policy.table}" WHERE "${statusColumn}" IN (${placeholders})`)
        .get(...policy.statuses) as { count: number } | undefined;
      counts[policy.table] = Number(row?.count ?? 0);
      if (policy.table === 'runtime_processes') {
        const unresolved = database.prepare("SELECT COUNT(*) AS count FROM runtime_processes WHERE status IN ('unknown', 'orphaned')")
          .get() as { count: number } | undefined;
        if (Number(unresolved?.count ?? 0) > 0) unknown = true;
      }
    } catch {
      unknown = true;
    }
  }
  return { counts, ...(unknown ? { unknown: true } : {}) };
}

function safeVersion(value: string | undefined): string | undefined {
  if (!value || value.length > 80 || !/^[\w.+-]+$/u.test(value)) return undefined;
  return value;
}

function safeDiagnosticLabel(value: string): string | undefined {
  if (!value || value.length > 128 || !/^[\w.-]+$/u.test(value)) return undefined;
  return value;
}

function safeProviderCode(value: string): string {
  return /^[A-Z0-9_.-]{1,80}$/u.test(value) ? value : 'PROVIDER_VALIDATION_FAILED';
}

function safeTimestamp(value: string | undefined): string | undefined {
  return value && Number.isFinite(Date.parse(value)) ? value : undefined;
}

function safeAuthentication(value: unknown): ProviderAuthenticationState | undefined {
  return typeof value === 'string' && [
    'authenticated', 'unauthenticated', 'required', 'expired', 'unknown', 'not-required',
  ].includes(value) ? value as ProviderAuthenticationState : undefined;
}

function sanitizeCapabilities(value: object): ProviderCapabilitiesV1 {
  const raw = value as Record<string, unknown>;
  return {
    sessionResume: raw.sessionResume === true,
    structuredEvents: raw.structuredEvents === true,
    nativeApprovals: raw.nativeApprovals === true,
    subagents: raw.subagents === true,
    toolEvents: raw.toolEvents === true,
    fileEvents: raw.fileEvents === true,
    usageEvents: raw.usageEvents === true,
    reasoningStream: raw.reasoningStream === true,
    interactiveInput: raw.interactiveInput === true,
    pause: raw.pause === true,
    cancellation: raw.cancellation === true,
    modelSelection: raw.modelSelection === true,
    workspaceAwareness: raw.workspaceAwareness === true,
    nativeSandbox: raw.nativeSandbox === true,
    outputContracts: raw.outputContracts === true,
  };
}

function sanitizeMaintenanceStatus(status: ReadinessMaintenanceStatus): ReadinessMaintenanceStatus {
  const operation = status.operation;
  return {
    active: status.active === true,
    quiescing: status.quiescing === true,
    recoveredAfterRestart: status.recoveredAfterRestart === true,
    ...(operation ? {
      operation: {
        kind: operation.kind === 'backup' || operation.kind === 'cleanup' ? operation.kind : 'unknown',
        status: ['active', 'completed', 'expired', 'failed'].includes(operation.status) ? operation.status : 'unknown',
        startedAt: safeTimestamp(operation.startedAt) ?? 'unknown',
        leaseExpiresAt: safeTimestamp(operation.leaseExpiresAt) ?? 'unknown',
      },
    } : {}),
  };
}

function tableExists(db: Database, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function tableColumns(db: Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map(column => column.name);
}

function hasColumn(db: Database, table: string, column: string): boolean {
  return tableExists(db, table) && tableColumns(db, table).includes(column);
}

function countWhere(db: Database, table: string, condition: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM "${table}" WHERE ${condition}`).get() as { count: number } | undefined;
  return Number(row?.count ?? 0);
}
