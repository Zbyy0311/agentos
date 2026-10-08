import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { acquireServerOwnership } from '../serverOwnership.js';
import { MaintenanceService, MaintenanceServiceError } from '../services/MaintenanceService.js';

const DEFAULT_SERVER_URL = 'http://127.0.0.1:3000';

interface ParsedCommand {
  readonly command: 'readiness' | 'diagnostics-export' | 'backup' | 'storage' | 'cleanup-preview' | 'cleanup-apply' | 'verify-backup' | 'restore';
  readonly serverUrl?: string;
  readonly backupDirectory?: string;
  readonly sourceDataRoot?: string;
  readonly targetDataRoot?: string;
  readonly previewFile?: string;
}

function parseArguments(argv: readonly string[]): ParsedCommand {
  const command = argv[0];
  if (command !== 'readiness' && command !== 'diagnostics-export' && command !== 'backup' && command !== 'storage'
    && command !== 'cleanup-preview' && command !== 'cleanup-apply' && command !== 'verify-backup' && command !== 'restore') {
    throw new MaintenanceServiceError('MAINTENANCE_USAGE');
  }
  const values = new Map<string, string>();
  const allowed = new Set(['--server-url', '--backup', '--source-data-root', '--target-data-root', '--preview-file']);
  for (let index = 1; index < argv.length; index += 1) {
    const key = argv[index]!;
    if (!allowed.has(key) || values.has(key)) throw new MaintenanceServiceError('MAINTENANCE_USAGE');
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new MaintenanceServiceError('MAINTENANCE_USAGE');
    values.set(key, value);
    index += 1;
  }
  const serverUrl = values.get('--server-url') ?? DEFAULT_SERVER_URL;
  if (command !== 'restore') assertLoopbackUrl(serverUrl);
  if (command === 'restore') {
    const backupDirectory = values.get('--backup');
    const sourceDataRoot = values.get('--source-data-root');
    const targetDataRoot = values.get('--target-data-root');
    if (!backupDirectory || !sourceDataRoot || !targetDataRoot
      || !isAbsolutePath(backupDirectory) || !isAbsolutePath(sourceDataRoot) || !isAbsolutePath(targetDataRoot)
      || values.has('--server-url') || values.has('--preview-file')) throw new MaintenanceServiceError('MAINTENANCE_USAGE');
    return { command, backupDirectory: resolve(backupDirectory), sourceDataRoot: resolve(sourceDataRoot), targetDataRoot: resolve(targetDataRoot) };
  }
  if (command === 'verify-backup') {
    const backupDirectory = values.get('--backup');
    if (!backupDirectory || !isAbsolutePath(backupDirectory)
      || values.has('--source-data-root') || values.has('--target-data-root') || values.has('--preview-file')
      || values.has('--server-url')) throw new MaintenanceServiceError('MAINTENANCE_USAGE');
    return { command, backupDirectory: resolve(backupDirectory) };
  }
  if (command === 'cleanup-apply') {
    const previewFile = values.get('--preview-file');
    if (!previewFile || values.has('--backup') || values.has('--source-data-root') || values.has('--target-data-root')) {
      throw new MaintenanceServiceError('MAINTENANCE_USAGE');
    }
    return { command, serverUrl: serverUrl.replace(/\/$/, ''), previewFile: resolve(previewFile) };
  }
  if (values.has('--backup') || values.has('--source-data-root') || values.has('--target-data-root') || values.has('--preview-file')) {
    throw new MaintenanceServiceError('MAINTENANCE_USAGE');
  }
  return { command, serverUrl: serverUrl.replace(/\/$/, '') };
}

function isAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('/');
}

function assertLoopbackUrl(value: string): void {
  let url: URL;
  try { url = new URL(value); } catch { throw new MaintenanceServiceError('MAINTENANCE_SERVER_URL_INVALID'); }
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname.toLowerCase())) {
    throw new MaintenanceServiceError('MAINTENANCE_SERVER_URL_MUST_BE_LOOPBACK');
  }
}

async function requestServer(url: string, path: string, method = 'GET', requestBody?: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${url}${path}`, {
      method,
      ...(requestBody === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody) }),
      signal: AbortSignal.timeout(20 * 60_000),
    });
  } catch {
    throw new MaintenanceServiceError('MAINTENANCE_SERVER_UNAVAILABLE');
  }
  let body: unknown;
  try { body = await response.json(); } catch { body = undefined; }
  if (!response.ok) {
    const code = body && typeof body === 'object' && 'code' in body && typeof body.code === 'string'
      ? body.code
      : `HTTP_${response.status}`;
    throw new MaintenanceServiceError(code);
  }
  return body;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const args = parseArguments(argv);
    if (args.command === 'verify-backup') {
      const manifest = await MaintenanceService.readAndVerifyBackup(args.backupDirectory!);
      MaintenanceService.assertMatchingBuild(manifest);
      process.stdout.write(`${JSON.stringify({
        ok: true,
        buildVersion: manifest.buildVersion,
        buildCommit: manifest.buildCommit,
        buildId: manifest.buildId,
        schemaVersion: manifest.schemaVersion,
        fileCount: manifest.files.length,
      }, null, 2)}\n`);
      return 0;
    }
    if (args.command === 'restore') {
      const manifest = await MaintenanceService.readAndVerifyBackup(args.backupDirectory!);
      if (resolve(args.sourceDataRoot!) !== resolve(manifest.sourceDataRoot)) {
        throw new MaintenanceServiceError('RESTORE_SOURCE_ROOT_MISMATCH');
      }
      const ownership = await acquireServerOwnership(args.sourceDataRoot!);
      try {
        const result = await MaintenanceService.restoreBackup(args.backupDirectory!, args.targetDataRoot!);
        process.stdout.write(`${JSON.stringify({
          ok: true,
          dataRoot: result.dataRoot,
          schemaVersion: result.schemaVersion,
          restoredFiles: result.restoredFiles,
          restoredWorkspaceFiles: result.restoredWorkspaceFiles,
          workspaceMapping: 'isolated-under-new-data-root',
          nextStep: `Set AGENTOS_PROJECT_ROOT=${result.dataRoot} before starting the matching AgentOS build.`,
        }, null, 2)}\n`);
      } finally {
        await ownership.release();
      }
      return 0;
    }
    const path = args.command === 'readiness'
      ? '/api/readiness'
      : args.command === 'diagnostics-export'
        ? '/api/diagnostics/export'
      : args.command === 'backup'
        ? '/api/maintenance/backup'
        : args.command === 'storage'
          ? '/api/maintenance/storage'
          : args.command === 'cleanup-apply'
            ? '/api/maintenance/cleanup/apply'
            : '/api/maintenance/cleanup/preview';
    const requestBody = args.command === 'cleanup-apply'
      ? JSON.parse((await readFile(args.previewFile!, 'utf8')).replace(/^\uFEFF/u, ''))
      : undefined;
    const method = args.command === 'backup' || args.command === 'cleanup-apply' ? 'POST' : 'GET';
    const result = await requestServer(args.serverUrl!, path, method, requestBody);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    const code = error instanceof MaintenanceServiceError
      ? error.code
      : typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'MAINTENANCE_COMMAND_FAILED';
    process.stderr.write(`${code}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await main();
}
