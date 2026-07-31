import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import type { AgentProfile, Workspace, WorkspaceAgent } from '@agentos/shared';

import {
  DEFAULT_CAPABILITIES,
  DEFAULT_TIMEOUT_POLICY,
  type ProviderConfiguration,
  type ProviderType,
} from '../store/ProviderConfigurationRepository.js';
import {
  LegacyDataMigrationRepository,
  type LegacyMigrationScope,
} from '../store/LegacyDataMigrationRepository.js';
import {
  assertCanonicalProjectDatabasePath,
  type LegacyMigrationDatabase,
} from './LegacyDataMigrationService.js';
import { canonicalizeLegacyMigrationDatabasePath, LegacyMigrationExecutionLock, type LegacyMigrationLease } from './LegacyMigrationExecutionLock.js';
import { LegacyBackupVerifier, type LegacyBackupInput, type LegacyBackupResult } from './LegacyBackupVerifier.js';
import { canonicalizeLegacyJson, parseLegacyJsonSource, type LegacySourceParseResult } from './LegacySourceParser.js';
import { createEntityId } from '../store/Identity.js';
import { providerFromLegacyRole, defaultRoleTitle, defaultSystemPrompt, defaultPermissions } from '../store/SqliteStore.js';
import { toCanonicalRootPath } from '../store/WorkspacePath.js';
import { WorkspaceCompatibilityRepository, type AgentCompatibilityProjection } from '../store/WorkspaceCompatibilityRepository.js';

export const LEGACY_WORKSPACE_SOURCE_NOT_READABLE = 'LEGACY_WORKSPACE_SOURCE_NOT_READABLE' as const;
export const LEGACY_WORKSPACE_SOURCE_PARSE_FAILED = 'LEGACY_WORKSPACE_SOURCE_PARSE_FAILED' as const;
export const LEGACY_WORKSPACE_SOURCE_INVALID = 'LEGACY_WORKSPACE_SOURCE_INVALID' as const;
export const LEGACY_WORKSPACE_DUPLICATE_SOURCE_ID = 'LEGACY_WORKSPACE_DUPLICATE_SOURCE_ID' as const;
export const LEGACY_WORKSPACE_CANONICAL_CONFLICT = 'LEGACY_WORKSPACE_CANONICAL_CONFLICT' as const;
export const LEGACY_WORKSPACE_CANONICAL_ROOT_CONFLICT = 'LEGACY_WORKSPACE_CANONICAL_ROOT_CONFLICT' as const;
export const LEGACY_WORKSPACE_SOURCE_ENTRY_MISSING = 'LEGACY_WORKSPACE_SOURCE_ENTRY_MISSING' as const;
export const LEGACY_WORKSPACE_BACKUP_FAILED = 'LEGACY_DATA_MIGRATION_BACKUP_FAILED' as const;
export const LEGACY_WORKSPACE_OPERATION_FAILED = 'LEGACY_WORKSPACE_OPERATION_FAILED' as const;

export type WorkspaceMigrationMode = 'dry-run' | 'apply';

export interface WorkspaceCompatibilityRunInput {
  projectRoot: string;
  sourceRoot: string;
  databasePath: string;
  backupDirectory: string;
  kind: 'workspace';
  mode: WorkspaceMigrationMode;
  workspaceId?: string;
}

export interface WorkspaceCompatibilitySummary {
  mode: WorkspaceMigrationMode;
  kind: 'workspace';
  sourceCount: number;
  selectedCount: number;
  completedCount: number;
  noopCount: number;
  quarantinedCount: number;
  failedCount: number;
  adoptableCount: number;
  equalCount: number;
  compatibleMissingCount: number;
  tombstoneCount: number;
  conflictCount: number;
  invalidCount: number;
  dispositions: Record<string, number>;
}

export class WorkspaceCompatibilityMigrationError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'WorkspaceCompatibilityMigrationError';
    this.code = code;
  }
}

interface WorkspaceDatabase extends LegacyMigrationDatabase {
  readonly isTransaction?: boolean;
}

interface WorkspaceServiceOptions {
  leaseFactory?: (projectRoot: string, databasePath: string) => Promise<LegacyMigrationLease>;
  databaseFactory?: (databasePath: string) => WorkspaceDatabase;
  backupProvider?: { createAndVerify(input: LegacyBackupInput): Promise<LegacyBackupResult | Record<string, unknown>> };
  migrationIdFactory?: () => string;
  clock?: () => string;
  parser?: (bytes: Uint8Array) => LegacySourceParseResult;
  beforeAggregateTransaction?: (input: { scope: LegacyMigrationScope; attemptId: string }) => void | Promise<void>;
}

interface ValidWorkspace {
  source: Record<string, unknown>;
  workspace: Workspace;
  agents: WorkspaceAgent[];
}

type Classification =
  | { kind: 'tombstone'; source: Record<string, unknown>; workspace: ValidWorkspace; canonicalWorkspaceId: null; errorCode?: undefined }
  | { kind: 'adoptable'; source: Record<string, unknown>; workspace: ValidWorkspace; canonicalWorkspaceId: null; errorCode?: undefined }
  | { kind: 'equal'; source: Record<string, unknown>; workspace: ValidWorkspace; canonicalWorkspaceId: string; errorCode?: undefined }
  | { kind: 'compatible-missing'; source: Record<string, unknown>; workspace: ValidWorkspace; canonicalWorkspaceId: string; errorCode?: undefined }
  | { kind: 'conflict'; source: Record<string, unknown>; workspace: ValidWorkspace; canonicalWorkspaceId: string | null; errorCode: string }
  | { kind: 'invalid'; source: Record<string, unknown>; workspace: ValidWorkspace | null; canonicalWorkspaceId: null; errorCode: string };

const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const ROLES = new Set(['codex', 'kimi', 'opencode', 'mimo']);
const PROVIDERS = new Set(['codex', 'kimi', 'opencode', 'mimo', 'custom']);

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requiredString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isUtcTimestamp(value: unknown): value is string {
  return typeof value === 'string' && TIMESTAMP_PATTERN.test(value) && Number.isFinite(Date.parse(value));
}

function stableError(error: unknown, fallback: string): WorkspaceCompatibilityMigrationError {
  const code = error instanceof WorkspaceCompatibilityMigrationError ? error.code : fallback;
  return new WorkspaceCompatibilityMigrationError(code);
}

function providerType(provider: WorkspaceAgent['provider']): ProviderType {
  if (provider === 'codex') return 'codex';
  if (provider === 'opencode') return 'opencode';
  if (provider === 'kimi') return 'kimicode';
  return 'custom-cli';
}

function providerFromType(value: ProviderType): WorkspaceAgent['provider'] {
  if (value === 'codex') return 'codex';
  if (value === 'opencode') return 'opencode';
  if (value === 'kimicode') return 'kimi';
  return 'custom';
}

function normalizeAgent(value: Record<string, unknown>): WorkspaceAgent {
  const role = value.role as WorkspaceAgent['role'];
  const provider = value.provider === undefined
    ? providerFromLegacyRole(role)
    : value.provider as WorkspaceAgent['provider'];
  const normalized: WorkspaceAgent = {
    id: value.id as string,
    name: value.name as string,
    role,
    enabled: value.enabled as boolean,
    cliCommand: value.cliCommand as string,
    cliArgs: [...(value.cliArgs as string[])],
    ...(typeof value.model === 'string' ? { model: value.model } : {}),
    thinkingEffort: (value.thinkingEffort ?? 'auto') as WorkspaceAgent['thinkingEffort'],
    provider,
  };
  if (normalized.id === 'kimi' && normalized.role === 'kimi' && normalized.cliCommand === 'opencode') {
    normalized.cliCommand = 'kimi';
    normalized.cliArgs = ['-m', 'kimi-code/kimi-for-coding', '-p'];
  }
  return normalized;
}

function expectedProvider(workspaceId: string, agent: WorkspaceAgent, now: string, id: string): ProviderConfiguration {
  return {
    id,
    workspaceId,
    name: `${agent.name} Provider`,
    providerType: providerType(agent.provider),
    adapterId: `builtin.${agent.role}`,
    runtimeMode: 'cli',
    executable: agent.cliCommand,
    argsTemplate: [...agent.cliArgs],
    ...(agent.model ? { model: agent.model } : {}),
    workingDirectoryMode: 'workspace',
    capabilities: DEFAULT_CAPABILITIES,
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    approvalMode: 'agentos',
    outputMode: 'parsed-text',
    enabled: agent.enabled,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalizeLegacyJson(left) === canonicalizeLegacyJson(right);
}

function sameWorkspace(left: Workspace, right: Workspace): boolean {
  return left.id === right.id
    && left.name === right.name
    && toCanonicalRootPath(left.rootPath) === toCanonicalRootPath(right.rootPath)
    && left.gitEnabled === right.gitEnabled
    && left.memoryEnabled === right.memoryEnabled
    && left.lastOpenedAt === right.lastOpenedAt
    && left.createdAt === right.createdAt
    && left.updatedAt === right.updatedAt;
}

interface AgentRuntimeProjection {
  effectiveProvider: WorkspaceAgent['provider'];
  effectiveCliCommand: string;
  effectiveCliArgs: string[];
  effectiveModel?: string;
}

function projectProviderConfiguration(config: ProviderConfiguration, fallbackCliCommand: string): AgentRuntimeProjection {
  return {
    effectiveProvider: providerFromType(config.providerType),
    effectiveCliCommand: config.executable ?? fallbackCliCommand,
    effectiveCliArgs: [...(config.argsTemplate ?? [])],
    ...(config.model !== undefined ? { effectiveModel: config.model } : {}),
  };
}

function sameAgent(source: WorkspaceAgent, expected: AgentRuntimeProjection, existing: AgentCompatibilityProjection): boolean {
  return source.id === existing.id
    && source.name === existing.name
    && source.role === existing.role
    && expected.effectiveProvider === existing.effectiveProvider
    && source.enabled === existing.enabled
    && expected.effectiveCliCommand === existing.effectiveCliCommand
    && sameJson(expected.effectiveCliArgs, existing.effectiveCliArgs)
    && (expected.effectiveModel ?? undefined) === (existing.effectiveModel ?? undefined)
    && (source.thinkingEffort ?? 'auto') === (existing.thinkingEffort ?? 'auto');
}

function sameProvider(expected: ProviderConfiguration, existing: ProviderConfiguration): boolean {
  return !existing.archivedAt
    && expected.workspaceId === existing.workspaceId
    && expected.name === existing.name
    && expected.providerType === existing.providerType
    && expected.adapterId === existing.adapterId
    && expected.runtimeMode === existing.runtimeMode
    && (expected.executable ?? undefined) === (existing.executable ?? undefined)
    && sameJson(expected.argsTemplate ?? [], existing.argsTemplate ?? [])
    && (expected.model ?? undefined) === (existing.model ?? undefined)
    && expected.workingDirectoryMode === existing.workingDirectoryMode
    && (expected.customWorkingDirectory ?? undefined) === (existing.customWorkingDirectory ?? undefined)
    && sameJson(expected.capabilities, existing.capabilities)
    && sameJson(expected.timeoutPolicy, existing.timeoutPolicy)
    && expected.approvalMode === existing.approvalMode
    && expected.outputMode === existing.outputMode
    && expected.enabled === existing.enabled;
}

function validateWorkspace(value: unknown): ValidWorkspace | null {
  if (!isRecord(value)
    || !requiredString(value.id)
    || /[\\/]/.test(value.id)
    || !requiredString(value.name)
    || !requiredString(value.rootPath)
    || !isAbsolute(value.rootPath)
    || typeof value.gitEnabled !== 'boolean'
    || typeof value.memoryEnabled !== 'boolean'
    || !Array.isArray(value.agents)
    || !requiredString(value.lastOpenedAt)
    || !requiredString(value.createdAt)
    || !requiredString(value.updatedAt)
    || !isUtcTimestamp(value.lastOpenedAt)
    || !isUtcTimestamp(value.createdAt)
    || !isUtcTimestamp(value.updatedAt)) return null;
  const ids = new Set<string>();
  const agents: WorkspaceAgent[] = [];
  for (const raw of value.agents) {
    if (!isRecord(raw)
      || !requiredString(raw.id)
      || !requiredString(raw.name)
      || typeof raw.enabled !== 'boolean'
      || typeof raw.role !== 'string'
      || !ROLES.has(raw.role)
      || (raw.provider !== undefined && (typeof raw.provider !== 'string' || !PROVIDERS.has(raw.provider)))
      || !requiredString(raw.cliCommand)
      || !Array.isArray(raw.cliArgs)
      || raw.cliArgs.some(item => typeof item !== 'string')
      || (raw.model !== undefined && typeof raw.model !== 'string')
      || (raw.thinkingEffort !== undefined && !['auto', 'low', 'medium', 'high'].includes(raw.thinkingEffort as string))
      || ids.has(raw.id)) return null;
    ids.add(raw.id);
    agents.push(normalizeAgent(raw));
  }
  const workspace: Workspace = {
    id: value.id,
    name: value.name,
    rootPath: value.rootPath,
    gitEnabled: value.gitEnabled,
    memoryEnabled: value.memoryEnabled,
    agents,
    lastOpenedAt: value.lastOpenedAt,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
  return { source: value, workspace, agents };
}

export class WorkspaceCompatibilityMigrationService {
  private readonly leaseFactory: NonNullable<WorkspaceServiceOptions['leaseFactory']>;
  private readonly databaseFactory: NonNullable<WorkspaceServiceOptions['databaseFactory']>;
  private readonly backupProvider: NonNullable<WorkspaceServiceOptions['backupProvider']>;
  private readonly migrationIdFactory: NonNullable<WorkspaceServiceOptions['migrationIdFactory']>;
  private readonly clock: NonNullable<WorkspaceServiceOptions['clock']>;
  private readonly parser: NonNullable<WorkspaceServiceOptions['parser']>;
  private readonly beforeAggregateTransaction: NonNullable<WorkspaceServiceOptions['beforeAggregateTransaction']> | undefined;

  constructor(options: WorkspaceServiceOptions = {}) {
    this.leaseFactory = options.leaseFactory ?? ((projectRoot, databasePath) => new LegacyMigrationExecutionLock().acquire(projectRoot, databasePath));
    this.databaseFactory = options.databaseFactory ?? ((databasePath) => {
      // The runtime dependency is intentionally loaded here so dry-run and tests can inject it.
      const DatabaseSync = (createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => WorkspaceDatabase }).DatabaseSync;
      return new DatabaseSync(databasePath);
    });
    this.backupProvider = options.backupProvider ?? new LegacyBackupVerifier();
    this.migrationIdFactory = options.migrationIdFactory ?? (() => randomUUID());
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.parser = options.parser ?? (bytes => parseLegacyJsonSource(bytes, 'workspaces.json'));
    this.beforeAggregateTransaction = options.beforeAggregateTransaction;
  }

  async run(input: WorkspaceCompatibilityRunInput, _sourceOverride?: unknown[]): Promise<WorkspaceCompatibilitySummary> {
    this.validateInput(input);
    assertCanonicalProjectDatabasePath(input.projectRoot, input.databasePath);
    const sourcePath = this.resolveSourcePath(input.sourceRoot);
    let lease: LegacyMigrationLease;
    try {
      lease = await this.leaseFactory(input.projectRoot, input.databasePath);
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      if (code === 'LEGACY_DATA_MIGRATION_RUNTIME_ACTIVE' || code === 'LEGACY_DATA_MIGRATION_ACTIVE') {
        throw new WorkspaceCompatibilityMigrationError(code);
      }
      throw new WorkspaceCompatibilityMigrationError(LEGACY_WORKSPACE_OPERATION_FAILED);
    }
    let db: WorkspaceDatabase | undefined;
    try {
      const sourceBytes = this.readSource(sourcePath);
      const sourceHash = sha256(sourceBytes);
      db = this.databaseFactory(input.databasePath);
      this.assertDatabaseBinding(db, input.databasePath);
      const repository = new WorkspaceCompatibilityRepository(db);
      let parsed: LegacySourceParseResult;
      try {
        parsed = this.parser(sourceBytes);
      } catch {
        if (input.mode === 'dry-run') throw new WorkspaceCompatibilityMigrationError(LEGACY_WORKSPACE_SOURCE_PARSE_FAILED);
        await this.createBackup(input, db, sourceBytes, sourceHash);
        return this.quarantineParseFailure(db, repository, sourceHash);
      }
      const selected = this.selectEntries(parsed.value, input.workspaceId);
      const classifications = selected.map((entry, index) => this.classify(entry, repository, input.workspaceId, index));
      const summary = this.createSummary(input.mode, parsed.entityCount, classifications.length);
      for (const item of classifications) this.countClassification(summary, item);
      if (input.mode === 'dry-run') {
        for (const item of classifications) {
          if (this.hasNoop(repository, item, sourceHash)) summary.noopCount += 1;
        }
        return summary;
      }

      const pending = classifications.filter(item => !this.hasNoop(repository, item, sourceHash));
      if (pending.length === 0) {
        for (const item of classifications) summary.noopCount += 1;
        return summary;
      }
      await this.createBackup(input, db, sourceBytes, sourceHash);
      for (const item of classifications) {
        await this.processClassification(db, repository, item, sourceHash, parsed, summary);
      }
      return summary;
    } catch (error) {
      if (error instanceof WorkspaceCompatibilityMigrationError) throw error;
      throw stableError(error, LEGACY_WORKSPACE_OPERATION_FAILED);
    } finally {
      try { db?.close(); } catch { /* best effort */ }
      await lease.release().catch(() => {});
    }
  }

  private validateInput(input: WorkspaceCompatibilityRunInput): void {
    if (input.kind !== 'workspace' || !['dry-run', 'apply'].includes(input.mode)
      || !requiredString(input.projectRoot) || !requiredString(input.sourceRoot)
      || !requiredString(input.databasePath) || !requiredString(input.backupDirectory)) {
      throw new WorkspaceCompatibilityMigrationError('LEGACY_WORKSPACE_MIGRATION_INVALID_ARGUMENTS');
    }
  }

  private resolveSourcePath(sourceRoot: string): string {
    if (!isAbsolute(sourceRoot)) throw new WorkspaceCompatibilityMigrationError(LEGACY_WORKSPACE_SOURCE_NOT_READABLE);
    const resolvedRoot = resolve(sourceRoot);
    if (!existsSync(resolvedRoot)) throw new WorkspaceCompatibilityMigrationError(LEGACY_WORKSPACE_SOURCE_NOT_READABLE);
    let canonicalRoot: string;
    try { canonicalRoot = realpathSync.native(resolvedRoot); } catch { throw new WorkspaceCompatibilityMigrationError(LEGACY_WORKSPACE_SOURCE_NOT_READABLE); }
    const sourcePath = join(canonicalRoot, 'workspace', 'workspaces.json');
    try {
      const stat = lstatSync(sourcePath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('source file');
      const canonicalSource = realpathSync.native(sourcePath);
      if (canonicalizeLegacyMigrationDatabasePath(canonicalSource) !== canonicalizeLegacyMigrationDatabasePath(sourcePath)) throw new Error('source escape');
      return sourcePath;
    } catch {
      throw new WorkspaceCompatibilityMigrationError(LEGACY_WORKSPACE_SOURCE_NOT_READABLE);
    }
  }

  private readSource(sourcePath: string): Uint8Array {
    try { return readFileSync(sourcePath); } catch { throw new WorkspaceCompatibilityMigrationError(LEGACY_WORKSPACE_SOURCE_NOT_READABLE); }
  }

  private assertDatabaseBinding(db: WorkspaceDatabase, databasePath: string): void {
    const rows = db.prepare('PRAGMA database_list').all() as Array<{ name?: unknown; file?: unknown }>;
    const main = rows.find(row => row.name === 'main');
    if (main?.file !== databasePath && (typeof main?.file !== 'string'
      || canonicalizeLegacyMigrationDatabasePath(main.file) !== canonicalizeLegacyMigrationDatabasePath(databasePath))) {
      throw new WorkspaceCompatibilityMigrationError('LEGACY_DATA_MIGRATION_PATH_MISMATCH');
    }
  }

  private selectEntries(entries: unknown[], workspaceId?: string): unknown[] {
    if (workspaceId === undefined) {
      const counts = new Map<string, number>();
      for (const entry of entries) {
        if (isRecord(entry) && typeof entry.id === 'string') counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1);
      }
      const duplicateIds = new Set<string>();
      const selected: unknown[] = [];
      let invalidWithoutId = false;
      for (const entry of entries) {
        if (isRecord(entry) && typeof entry.id === 'string' && entry.id.length > 0) {
          if ((counts.get(entry.id) ?? 0) > 1) {
            if (!duplicateIds.has(entry.id)) {
              duplicateIds.add(entry.id);
              selected.push({ id: entry.id, __duplicate: true });
            }
          } else {
            selected.push(entry);
          }
        } else {
          invalidWithoutId = true;
        }
      }
      if (invalidWithoutId) selected.push({ __invalidGlobal: true });
      return selected;
    }
    const matches = entries.filter(entry => isRecord(entry) && entry.id === workspaceId);
    if (matches.length === 0) return [{ id: workspaceId, __missing: true }];
    if (matches.length > 1) return [{ id: workspaceId, __duplicate: true }];
    return matches;
  }

  private classify(entry: unknown, repository: WorkspaceCompatibilityRepository, workspaceId: string | undefined, _index: number): Classification {
    if (!isRecord(entry) || entry.__missing === true || entry.__invalidGlobal === true) {
      return { kind: 'invalid', source: isRecord(entry) ? entry : {}, workspace: null, canonicalWorkspaceId: null, errorCode: LEGACY_WORKSPACE_SOURCE_ENTRY_MISSING };
    }
    if (entry.__duplicate === true) {
      return { kind: 'invalid', source: entry, workspace: null, canonicalWorkspaceId: null, errorCode: LEGACY_WORKSPACE_DUPLICATE_SOURCE_ID };
    }
    const valid = validateWorkspace(entry);
    if (valid === null) {
      return { kind: 'invalid', source: entry, workspace: null, canonicalWorkspaceId: null, errorCode: LEGACY_WORKSPACE_SOURCE_INVALID };
    }
    if (workspaceId !== undefined && valid.workspace.id !== workspaceId) {
      return { kind: 'invalid', source: valid.source, workspace: valid, canonicalWorkspaceId: null, errorCode: LEGACY_WORKSPACE_SOURCE_ENTRY_MISSING };
    }
    const existing = repository.findWorkspaceById(valid.workspace.id);
    const tombstone = repository.findTombstone(valid.workspace.id);
    if (tombstone !== null) return { kind: 'tombstone', source: valid.source, workspace: valid, canonicalWorkspaceId: null };
    const rootOwner = repository.findWorkspaceByRootPath(valid.workspace.rootPath);
    if (existing === undefined && rootOwner !== undefined && rootOwner.id !== valid.workspace.id) {
      return { kind: 'conflict', source: valid.source, workspace: valid, canonicalWorkspaceId: null, errorCode: LEGACY_WORKSPACE_CANONICAL_ROOT_CONFLICT };
    }
    if (existing === undefined) {
      try {
        this.assertAgentSetCompatible(repository, valid.workspace.id, valid.workspace.updatedAt, valid.agents);
      } catch {
        return { kind: 'conflict', source: valid.source, workspace: valid, canonicalWorkspaceId: null, errorCode: LEGACY_WORKSPACE_CANONICAL_CONFLICT };
      }
      return { kind: 'adoptable', source: valid.source, workspace: valid, canonicalWorkspaceId: null };
    }
    if (!sameWorkspace(existing, valid.workspace)) {
      return { kind: 'conflict', source: valid.source, workspace: valid, canonicalWorkspaceId: existing.id, errorCode: LEGACY_WORKSPACE_CANONICAL_CONFLICT };
    }
    try {
      const hasMissingChildren = this.assertChildrenCompatible(repository, existing, valid.agents);
      if (hasMissingChildren) {
        return { kind: 'compatible-missing', source: valid.source, workspace: valid, canonicalWorkspaceId: existing.id };
      }
    } catch {
      return { kind: 'conflict', source: valid.source, workspace: valid, canonicalWorkspaceId: existing.id, errorCode: LEGACY_WORKSPACE_CANONICAL_CONFLICT };
    }
    return { kind: 'equal', source: valid.source, workspace: valid, canonicalWorkspaceId: existing.id };
  }

  private assertChildrenCompatible(repository: WorkspaceCompatibilityRepository, existing: Workspace, agents: WorkspaceAgent[]): boolean {
    return this.assertAgentSetCompatible(repository, existing.id, existing.updatedAt, agents);
  }

  private assertAgentSetCompatible(
    repository: WorkspaceCompatibilityRepository,
    workspaceId: string,
    updatedAt: string,
    agents: WorkspaceAgent[],
  ): boolean {
    const sourceIds = new Set(agents.map(agent => agent.id));
    const existingIds = repository.listAgentProfileIds(workspaceId);
    let hasMissingChildren = false;
    for (const existingAgentId of existingIds) {
      if (!sourceIds.has(existingAgentId)) throw new Error('agent set conflict');
    }
    for (const agent of agents) {
      const current = repository.findAgent(workspaceId, agent.id);
      if (current === undefined) {
        hasMissingChildren = true;
        continue;
      }
      const expected = expectedProvider(workspaceId, agent, updatedAt, current.providerConfigId ?? createEntityId('provider'));
      const expectedRuntime = projectProviderConfiguration(expected, agent.cliCommand);
      if (!sameAgent(agent, expectedRuntime, current)) throw new Error('agent conflict');
      if (current.providerConfigId === null) {
        hasMissingChildren = true;
        const provider = repository.findProviderByWorkspaceAndName(workspaceId, `${agent.name} Provider`);
        if (provider !== undefined && !sameProvider(expectedProvider(workspaceId, agent, updatedAt, provider.id), provider)) {
          throw new Error('provider conflict');
        }
        continue;
      }
      if (current.providerConfiguration === undefined) throw new Error('provider binding missing');
      if (!sameProvider(expected, current.providerConfiguration)) throw new Error('provider conflict');
    }
    return hasMissingChildren;
  }

  private createSummary(mode: WorkspaceMigrationMode, sourceCount: number, selectedCount: number): WorkspaceCompatibilitySummary {
    return { mode, kind: 'workspace', sourceCount, selectedCount, completedCount: 0, noopCount: 0, quarantinedCount: 0, failedCount: 0, adoptableCount: 0, equalCount: 0, compatibleMissingCount: 0, tombstoneCount: 0, conflictCount: 0, invalidCount: 0, dispositions: {} };
  }

  private countClassification(summary: WorkspaceCompatibilitySummary, item: Classification): void {
    if (item.kind === 'adoptable') summary.adoptableCount += 1;
    if (item.kind === 'equal') summary.equalCount += 1;
    if (item.kind === 'compatible-missing') summary.compatibleMissingCount += 1;
    if (item.kind === 'tombstone') summary.tombstoneCount += 1;
    if (item.kind === 'conflict') summary.conflictCount += 1;
    if (item.kind === 'invalid') summary.invalidCount += 1;
  }

  private hasNoop(repository: WorkspaceCompatibilityRepository, item: Classification, sourceHash: string): boolean {
    if (item.workspace === null || item.kind === 'conflict' || item.kind === 'invalid') return false;
    const scope: LegacyMigrationScope = { migrationKind: 'workspace_adoption', sourceKey: 'workspaces.json', scopeKind: 'workspace', scopeKey: item.workspace.workspace.id, canonicalWorkspaceId: item.canonicalWorkspaceId, sourceHash };
    return repository.findCompletedByExactSource(scope) !== null;
  }

  private async createBackup(input: WorkspaceCompatibilityRunInput, db: WorkspaceDatabase, sourceBytes: Uint8Array, sourceHash: string): Promise<void> {
    let migrationId: string;
    try { migrationId = this.migrationIdFactory(); } catch { throw new WorkspaceCompatibilityMigrationError(LEGACY_WORKSPACE_BACKUP_FAILED); }
    try {
      await this.backupProvider.createAndVerify({
        databasePath: input.databasePath,
        database: db,
        backupDirectory: input.backupDirectory,
        migrationId,
        sourceBytes,
        sourceHash,
        expectedTables: ['workspaces', 'agent_profiles', 'provider_configurations', 'legacy_data_migrations', 'legacy_task_items'],
      });
    } catch { throw new WorkspaceCompatibilityMigrationError(LEGACY_WORKSPACE_BACKUP_FAILED); }
  }

  private quarantineParseFailure(db: WorkspaceDatabase, repository: WorkspaceCompatibilityRepository, sourceHash: string): WorkspaceCompatibilitySummary {
    const migrations = new LegacyDataMigrationRepository(db);
    const id = this.migrationIdFactory();
    const now = this.clock();
    const scope: LegacyMigrationScope = { migrationKind: 'workspace_adoption', sourceKey: 'workspaces.json', scopeKind: 'global', scopeKey: 'global', canonicalWorkspaceId: null, sourceHash };
    const running = migrations.reconcileStaleRunningAndReserveAttempt({ ...scope, migrationId: id, now });
    migrations.transitionRunningToQuarantined(running.id, { errorCode: LEGACY_WORKSPACE_SOURCE_PARSE_FAILED, finishedAt: now, updatedAt: now });
    const summary = this.createSummary('apply', 0, 0);
    summary.quarantinedCount = 1;
    summary.dispositions.parse_failed = 1;
    return summary;
  }

  private async processClassification(db: WorkspaceDatabase, repository: WorkspaceCompatibilityRepository, item: Classification, sourceHash: string, parsed: LegacySourceParseResult, summary: WorkspaceCompatibilitySummary): Promise<void> {
    const migrations = new LegacyDataMigrationRepository(db);
    const validScopeKey = typeof item.source.id === 'string' && item.source.id.length > 0;
    const scope: LegacyMigrationScope = validScopeKey
      ? { migrationKind: 'workspace_adoption', sourceKey: 'workspaces.json', scopeKind: 'workspace', scopeKey: item.source.id as string, canonicalWorkspaceId: item.canonicalWorkspaceId, sourceHash }
      : { migrationKind: 'workspace_adoption', sourceKey: 'workspaces.json', scopeKind: 'global', scopeKey: 'global', canonicalWorkspaceId: null, sourceHash };
    if (item.workspace !== null) {
      const exact = migrations.findCompletedByExactSource(scope);
      if (exact !== null) {
        summary.noopCount += 1;
        return;
      }
    }
    const attemptId = this.migrationIdFactory();
    if (item.kind === 'invalid' || item.kind === 'conflict') {
      const running = migrations.reconcileStaleRunningAndReserveAttempt({ ...scope, migrationId: attemptId, now: this.clock() });
      const conflictEvidence = item.kind === 'conflict'
        ? { payloadHash: sha256(canonicalizeLegacyJson([item.source])), sourceSchemaVersion: parsed.sourceSchemaVersion, entityCount: 1 }
        : {};
      migrations.transitionRunningToQuarantined(running.id, { errorCode: item.errorCode, finishedAt: this.clock(), updatedAt: this.clock(), ...conflictEvidence });
      summary.quarantinedCount += 1;
      summary.dispositions[item.errorCode] = (summary.dispositions[item.errorCode] ?? 0) + 1;
      return;
    }
    const payloadJson = canonicalizeLegacyJson([item.source]);
    const payloadHash = sha256(payloadJson);
    const latest = migrations.findLatestAcceptedCompleted(scope);
    const revision = latest?.payloadHash === payloadHash ? (latest.revision ?? 1) : (latest?.revision ?? 0) + 1;

    const reservationScope: LegacyMigrationScope = item.kind === 'adoptable'
      ? { ...scope, canonicalWorkspaceId: null }
      : scope;
    const running = migrations.reconcileStaleRunningAndReserveAttempt({ ...reservationScope, migrationId: attemptId, now: this.clock() });
    try {
      await this.beforeAggregateTransaction?.({ scope: reservationScope, attemptId: running.id });
      db.exec('BEGIN IMMEDIATE');
      if (item.kind === 'adoptable') {
        repository.insertWorkspaceWithinTransaction(item.workspace.workspace);
        this.insertMissingChildren(repository, item.workspace, item.workspace.workspace.id);
      } else if (item.kind === 'equal' || item.kind === 'compatible-missing') {
        this.insertMissingChildren(repository, item.workspace, item.workspace.workspace.id);
      }
      migrations.transitionRunningToCompleted(running.id, {
        payloadHash,
        sourceSchemaVersion: parsed.sourceSchemaVersion,
        revision,
        entityCount: 1,
        finishedAt: this.clock(),
        updatedAt: this.clock(),
      });
      db.exec('COMMIT');
      summary.completedCount += 1;
      const disposition = item.kind === 'adoptable'
        ? 'adopted'
        : item.kind === 'tombstone'
          ? 'tombstone_preserved'
          : item.kind === 'compatible-missing' ? 'compatible_missing' : 'equal_existing';
      summary.dispositions[disposition] = (summary.dispositions[disposition] ?? 0) + 1;
    } catch {
      try { db.exec('ROLLBACK'); } catch { /* best effort */ }
      try { migrations.transitionRunningToFailed(running.id, { errorCode: LEGACY_WORKSPACE_OPERATION_FAILED, finishedAt: this.clock(), updatedAt: this.clock() }); } catch { /* preserve primary failure */ }
      summary.failedCount += 1;
      throw new WorkspaceCompatibilityMigrationError(LEGACY_WORKSPACE_OPERATION_FAILED);
    }
  }

  private insertMissingChildren(repository: WorkspaceCompatibilityRepository, workspace: ValidWorkspace, workspaceId: string): void {
    for (const agent of workspace.agents) {
      const current = repository.findAgent(workspaceId, agent.id);
      if (current !== undefined) {
        if (current.providerConfigId === null) {
          const provider = this.ensureProvider(repository, workspace, workspaceId, agent);
          repository.bindAgentProviderWithinTransaction(workspaceId, agent.id, provider.id);
        }
        continue;
      }
      this.insertAgentWithProvider(repository, workspace, workspaceId, agent);
    }
  }

  private ensureProvider(repository: WorkspaceCompatibilityRepository, workspace: ValidWorkspace, workspaceId: string, agent: WorkspaceAgent): ProviderConfiguration {
    const now = workspace.workspace.updatedAt;
    const providerName = `${agent.name} Provider`;
    let provider = repository.findProviderByWorkspaceAndName(workspaceId, providerName);
    if (provider?.archivedAt) throw new WorkspaceCompatibilityMigrationError(LEGACY_WORKSPACE_CANONICAL_CONFLICT);
    if (provider === undefined) {
      provider = expectedProvider(workspaceId, agent, now, createEntityId('provider'));
      repository.insertProviderWithinTransaction(provider);
    } else if (!sameProvider(expectedProvider(workspaceId, agent, now, provider.id), provider)) {
      throw new WorkspaceCompatibilityMigrationError(LEGACY_WORKSPACE_CANONICAL_CONFLICT);
    }
    return provider;
  }

  private insertAgentWithProvider(repository: WorkspaceCompatibilityRepository, workspace: ValidWorkspace, workspaceId: string, agent: WorkspaceAgent): void {
    const provider = this.ensureProvider(repository, workspace, workspaceId, agent);
    const profile: AgentProfile = {
      ...agent,
      workspaceId,
      providerConfigId: provider.id,
      roleTitle: defaultRoleTitle(agent.role),
      systemPrompt: defaultSystemPrompt(agent.role),
      permissions: defaultPermissions(agent.role),
      createdAt: workspace.workspace.createdAt,
      updatedAt: workspace.workspace.updatedAt,
    };
    repository.insertAgentWithinTransaction(profile);
  }
}
