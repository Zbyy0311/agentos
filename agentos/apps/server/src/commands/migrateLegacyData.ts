import { fileURLToPath } from 'node:url';
import { isAbsolute, join, resolve } from 'node:path';

import {
  LEGACY_WORKSPACE_BACKUP_FAILED,
  LEGACY_WORKSPACE_CANONICAL_CONFLICT,
  LEGACY_WORKSPACE_CANONICAL_ROOT_CONFLICT,
  LEGACY_WORKSPACE_DUPLICATE_SOURCE_ID,
  LEGACY_WORKSPACE_OPERATION_FAILED,
  LEGACY_WORKSPACE_SOURCE_ENTRY_MISSING,
  LEGACY_WORKSPACE_SOURCE_INVALID,
  LEGACY_WORKSPACE_SOURCE_NOT_READABLE,
  LEGACY_WORKSPACE_SOURCE_PARSE_FAILED,
  WorkspaceCompatibilityMigrationError,
  WorkspaceCompatibilityMigrationService,
  type WorkspaceMigrationMode,
} from '../services/WorkspaceCompatibilityMigrationService.js';
import {
  LEGACY_TASK_CROSS_WORKSPACE_ITEM,
  LEGACY_TASK_DUPLICATE_SOURCE_ID,
  LEGACY_TASK_IMPORT_INVALID_ARGUMENTS,
  LEGACY_TASK_SOURCE_INVALID,
  LEGACY_TASK_SOURCE_NOT_READABLE,
  LEGACY_TASK_SOURCE_PARSE_FAILED,
  LegacyTaskItemImportError,
  LegacyTaskItemImportService,
} from '../services/LegacyTaskItemImportService.js';
import { canonicalizeLegacyMigrationDatabasePath } from '../services/LegacyMigrationExecutionLock.js';

const INVALID_ARGUMENTS = 'LEGACY_WORKSPACE_MIGRATION_INVALID_ARGUMENTS';

interface ParsedArguments {
  database: string;
  sourceRoot: string;
  backupDirectory: string;
  kind: 'workspace' | 'tasks';
  mode: WorkspaceMigrationMode;
  workspaceId?: string;
}

function fail(code: string): never {
  throw new WorkspaceCompatibilityMigrationError(code);
}

function parseArguments(argv: string[]): ParsedArguments {
  const values = new Map<string, string>();
  const allowed = new Set(['--database', '--source-root', '--backup-dir', '--kind', '--mode', '--confirm', '--workspace-id']);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!allowed.has(flag)) fail(INVALID_ARGUMENTS);
    if (values.has(flag)) fail(INVALID_ARGUMENTS);
    const value = argv[index + 1];
    if (typeof value !== 'string' || value.startsWith('--') || value.length === 0) fail(INVALID_ARGUMENTS);
    values.set(flag, value);
    index += 1;
  }
  const kind = values.get('--kind');
  if (kind !== 'workspace' && kind !== 'tasks') fail(INVALID_ARGUMENTS);
  const mode = values.get('--mode');
  if (mode !== 'dry-run' && mode !== 'apply') fail(INVALID_ARGUMENTS);
  const database = values.get('--database');
  const sourceRoot = values.get('--source-root');
  const backupDirectory = values.get('--backup-dir');
  if (database === undefined || sourceRoot === undefined || backupDirectory === undefined) fail(INVALID_ARGUMENTS);
  if (!isAbsolute(database) || !isAbsolute(sourceRoot) || !isAbsolute(backupDirectory)) fail(INVALID_ARGUMENTS);
  const confirm = values.get('--confirm');
  if (mode === 'apply' && confirm !== 'APPLY-M2.7') fail(INVALID_ARGUMENTS);
  if (mode === 'dry-run' && confirm !== undefined) fail(INVALID_ARGUMENTS);
  const workspaceId = values.get('--workspace-id');
  if (kind === 'tasks' && workspaceId === undefined) fail(INVALID_ARGUMENTS);
  if (workspaceId !== undefined && workspaceId.length === 0) fail(INVALID_ARGUMENTS);
  const canonicalBackup = canonicalizeLegacyMigrationDatabasePath(resolve(backupDirectory));
  if (canonicalBackup === canonicalizeLegacyMigrationDatabasePath(database)
    || canonicalBackup === canonicalizeLegacyMigrationDatabasePath(sourceRoot)
    || canonicalBackup === canonicalizeLegacyMigrationDatabasePath(join(resolve(sourceRoot), 'workspace', 'workspaces.json'))) fail(INVALID_ARGUMENTS);
  if (kind === 'tasks' && workspaceId !== undefined
    && canonicalBackup === canonicalizeLegacyMigrationDatabasePath(
      join(resolve(sourceRoot), 'workspace', workspaceId, '.agentos', 'tasks.json'))) {
    fail(INVALID_ARGUMENTS);
  }
  return { database, sourceRoot, backupDirectory, kind, mode, ...(workspaceId ? { workspaceId } : {}) };
}

function exitCode(error: unknown): number {
  const code = error instanceof WorkspaceCompatibilityMigrationError || error instanceof LegacyTaskItemImportError
    ? error.code
    : LEGACY_WORKSPACE_OPERATION_FAILED;
  if (code === INVALID_ARGUMENTS || code === LEGACY_TASK_IMPORT_INVALID_ARGUMENTS
    || code === 'LEGACY_DATA_MIGRATION_PATH_MISMATCH') return 2;
  if (code === LEGACY_WORKSPACE_BACKUP_FAILED) return 3;
  if (code === LEGACY_WORKSPACE_SOURCE_NOT_READABLE || code === LEGACY_WORKSPACE_SOURCE_PARSE_FAILED || code === LEGACY_WORKSPACE_SOURCE_INVALID
    || code === LEGACY_TASK_SOURCE_NOT_READABLE || code === LEGACY_TASK_SOURCE_PARSE_FAILED || code === LEGACY_TASK_SOURCE_INVALID) return 4;
  if (code === 'LEGACY_DATA_MIGRATION_RUNTIME_ACTIVE' || code === 'LEGACY_DATA_MIGRATION_ACTIVE'
    || code === LEGACY_WORKSPACE_CANONICAL_CONFLICT || code === LEGACY_WORKSPACE_CANONICAL_ROOT_CONFLICT
    || code === LEGACY_WORKSPACE_DUPLICATE_SOURCE_ID || code === LEGACY_WORKSPACE_SOURCE_ENTRY_MISSING
    || code === LEGACY_TASK_DUPLICATE_SOURCE_ID || code === LEGACY_TASK_CROSS_WORKSPACE_ITEM) return 5;
  return 6;
}

function stableErrorCode(error: unknown): string {
  if (error instanceof WorkspaceCompatibilityMigrationError || error instanceof LegacyTaskItemImportError) {
    return error.code;
  }
  return LEGACY_WORKSPACE_OPERATION_FAILED;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const args = parseArguments(argv);
    if (args.kind === 'tasks') {
      const result = await new LegacyTaskItemImportService().run({
        projectRoot: args.sourceRoot,
        sourceRoot: args.sourceRoot,
        databasePath: args.database,
        backupDirectory: args.backupDirectory,
        kind: 'tasks',
        mode: args.mode,
        workspaceId: args.workspaceId as string,
      });
      process.stdout.write(`${JSON.stringify({
        mode: result.mode,
        kind: result.kind,
        sourceCount: result.sourceCount,
        validTaskCount: result.validTaskCount,
        completedCount: result.completedCount,
        noopCount: result.noopCount,
        quarantinedCount: result.quarantinedCount,
        importedCount: result.importedCount,
        revision: result.revision,
      })}\n`);
      return result.quarantinedCount > 0 ? 5 : 0;
    }
    const result = await new WorkspaceCompatibilityMigrationService().run({
      projectRoot: args.sourceRoot,
      sourceRoot: args.sourceRoot,
      databasePath: args.database,
      backupDirectory: args.backupDirectory,
      kind: 'workspace',
      mode: args.mode,
      ...(args.workspaceId ? { workspaceId: args.workspaceId } : {}),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (args.mode === 'dry-run' && result.invalidCount > 0) return 4;
    return result.quarantinedCount > 0 || result.failedCount > 0 || result.conflictCount > 0 ? 5 : 0;
  } catch (error) {
    process.stderr.write(`${stableErrorCode(error)}\n`);
    return exitCode(error);
  }
}

if (process.argv[1] !== undefined && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  main().then(code => { process.exitCode = code; }).catch(() => { process.exitCode = 6; });
}
