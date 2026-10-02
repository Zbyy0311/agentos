import { appendFileSync, lstatSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createDiagnosticRedactor } from '../../../../scripts/agentos-diagnostic-redaction.mjs';

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_ROTATIONS = 4;
const MAX_ROTATIONS = 20;

export interface DiagnosticLoggerOptions {
  readonly directory: string;
  readonly instanceId: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => Date;
  readonly maxBytes?: number;
  readonly rotations?: number;
}

/** Creates the same bounded, redacting file logger used by production startup. */
export function createDiagnosticLogger(options: DiagnosticLoggerOptions): (entry: string) => void {
  const redact = createDiagnosticRedactor(options.environment ?? process.env);
  const now = options.now ?? (() => new Date());
  const maxBytes = Number.isSafeInteger(options.maxBytes) && Number(options.maxBytes) > 0
    ? Number(options.maxBytes)
    : DEFAULT_MAX_BYTES;
  const rotations = Number.isSafeInteger(options.rotations)
    ? Math.min(MAX_ROTATIONS, Math.max(0, Number(options.rotations)))
    : DEFAULT_ROTATIONS;
  const safeInstanceId = /^[\w.-]{1,80}$/u.test(options.instanceId) ? options.instanceId : 'unknown';
  const logPath = join(options.directory, `server-${safeInstanceId}.log`);

  return (entry: string): void => {
    const line = `${now().toISOString()} [server] ${redact(entry)}\n`;
    const incomingBytes = Buffer.byteLength(line, 'utf8');
    if (incomingBytes > maxBytes) return;
    try {
      mkdirSync(options.directory, { recursive: true });
      if (!rotateDiagnosticLog(logPath, incomingBytes, maxBytes, rotations)) return;
      appendFileSync(logPath, line, { encoding: 'utf-8', flag: 'a' });
    } catch {
      // Diagnostics are best-effort and must not disrupt server startup or shutdown.
    }
  };
}

function rotateDiagnosticLog(logPath: string, incomingBytes: number, maxBytes: number, rotations: number): boolean {
  const current = lstatOptional(logPath);
  if (current && (!current.isFile() || current.isSymbolicLink())) return false;
  if (current && Number(current.size) + incomingBytes <= maxBytes) return true;
  if (!current) return true;

  if (rotations === 0) {
    // With rotation disabled, retain only the newest bounded entry.
    unlinkSync(logPath);
    return true;
  }

  const paths = Array.from({ length: rotations + 1 }, (_, index) => index === 0 ? logPath : `${logPath}.${index}`);
  const entries = paths.map(path => lstatOptional(path));
  if (entries.some(info => info && (!info.isFile() || info.isSymbolicLink()))) return false;
  for (let index = rotations; index >= 1; index -= 1) {
    const source = paths[index - 1]!;
    const destination = paths[index]!;
    const sourceInfo = lstatOptional(source);
    if (!sourceInfo) continue;
    if (lstatOptional(destination)) unlinkSync(destination);
    renameSync(source, destination);
  }
  return true;
}

function lstatOptional(path: string): ReturnType<typeof lstatSync> | undefined {
  try { return lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
