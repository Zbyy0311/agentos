import { posix } from 'node:path';

export class WorktreeRecoveryError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'WorktreeRecoveryError'; }
}

export function assertRecoveryPath(path: string): void {
  if (!path || path.startsWith('/') || /[\\:\x00-\x1f]/.test(path)
    || path.split('/').some(part => !part || part === '.' || part === '..' || /[ .]$/.test(part)
      || part.toLowerCase() === '.git' || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new WorktreeRecoveryError('WORKTREE_RECOVERY_UNSAFE_PATH');
  }
}

export function resolveRecoveryLink(path: string, target: string): string {
  assertRecoveryPath(path);
  if (!target || target.startsWith('/') || /[\\:\x00-\x1f]/.test(target)) {
    throw new WorktreeRecoveryError('WORKTREE_RECOVERY_LINK_ESCAPES_ROOT');
  }
  const resolved = posix.normalize(posix.join(posix.dirname(path), target));
  try { assertRecoveryPath(resolved); } catch { throw new WorktreeRecoveryError('WORKTREE_RECOVERY_LINK_ESCAPES_ROOT'); }
  return resolved;
}

function octal(bytes: Buffer): number {
  const text = bytes.toString('ascii').replace(/\0/g, '').trim();
  if (!/^[0-7]*$/.test(text)) throw new WorktreeRecoveryError('WORKTREE_RECOVERY_ARCHIVE_INVALID');
  const value = text ? parseInt(text, 8) : 0;
  if (!Number.isSafeInteger(value)) throw new WorktreeRecoveryError('WORKTREE_RECOVERY_ARCHIVE_INVALID');
  return value;
}
function cstring(bytes: Buffer): string { return bytes.subarray(0, bytes.indexOf(0) < 0 ? bytes.length : bytes.indexOf(0)).toString('utf8'); }
function writeOctal(header: Buffer, offset: number, width: number, value: number): void {
  header.write(value.toString(8).padStart(width - 1, '0') + '\0', offset, width, 'ascii');
}
function header(path: string, size: number, type = '0'): Buffer {
  const out = Buffer.alloc(512);
  out.write(path, 0, 100, 'utf8');
  writeOctal(out, 100, 8, 0o644); writeOctal(out, 108, 8, 0); writeOctal(out, 116, 8, 0);
  writeOctal(out, 124, 12, size); writeOctal(out, 136, 12, 0);
  out.fill(32, 148, 156); out.write(type, 156, 1); out.write('ustar\0', 257, 6); out.write('00', 263, 2);
  const sum = out.reduce((total, byte) => total + byte, 0);
  out.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return out;
}
function paxPath(path: string): Buffer {
  const suffix = ` path=${path}\n`;
  let length = Buffer.byteLength(suffix) + 1;
  while (length !== Buffer.byteLength(suffix) + String(length).length) length = Buffer.byteLength(suffix) + String(length).length;
  return Buffer.from(String(length) + suffix, 'utf8');
}

/** v2 contains ordinary files only; link semantics live solely in the manifest. */
export function createRecoveryArchive(files: readonly { path: string; bytes: Buffer }[]): Buffer {
  const chunks: Buffer[] = [];
  const names = new Set<string>();
  let total = 1024;
  for (const [index, file] of files.entries()) {
    assertRecoveryPath(file.path);
    const key = process.platform === 'win32' ? file.path.toLowerCase() : file.path;
    if (names.has(key)) throw new WorktreeRecoveryError('WORKTREE_RECOVERY_DUPLICATE_PATH');
    names.add(key);
    const pax = paxPath(file.path);
    chunks.push(header(`PaxHeaders/${index}`, pax.length, 'x'), pax, Buffer.alloc((512 - pax.length % 512) % 512),
      header(`files/${index}`, file.bytes.length), file.bytes, Buffer.alloc((512 - file.bytes.length % 512) % 512));
    total += 1024 + Math.ceil(pax.length / 512) * 512 + Math.ceil(file.bytes.length / 512) * 512;
    if (total > 100 * 1024 * 1024) throw new WorktreeRecoveryError('WORKTREE_RECOVERY_ARCHIVE_TOO_LARGE');
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}

export interface RecoveryArchiveFile { path: string; bytes: Buffer; kind: 'file' | 'symlink'; target?: string; }

/** Parse before writing anything. Native tar extraction is never used. */
export function readRecoveryArchive(bytes: Buffer, allowBaselineLinks = false): RecoveryArchiveFile[] {
  if (bytes.length === 0) return [];
  const files: RecoveryArchiveFile[] = [];
  const names = new Set<string>();
  let pax: Record<string, string> = {};
  let globalPax: Record<string, string> = {};
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const block = bytes.subarray(offset, offset + 512);
    offset += 512;
    if (block.every(byte => byte === 0)) {
      if (!bytes.subarray(offset).every(byte => byte === 0)) throw new WorktreeRecoveryError('WORKTREE_RECOVERY_ARCHIVE_INVALID');
      return files;
    }
    const sum = block.reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (octal(block.subarray(148, 156)) !== sum) throw new WorktreeRecoveryError('WORKTREE_RECOVERY_ARCHIVE_INVALID');
    const size = octal(block.subarray(124, 136));
    if (size > bytes.length - offset) throw new WorktreeRecoveryError('WORKTREE_RECOVERY_ARCHIVE_INVALID');
    const content = bytes.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    const type = cstring(block.subarray(156, 157));
    if (type === 'x' || type === 'g') {
      const fields: Record<string, string> = {};
      for (let start = 0; start < content.length;) {
        const space = content.indexOf(32, start);
        const length = Number(content.subarray(start, space).toString('ascii'));
        if (space < start || !Number.isSafeInteger(length) || length <= space - start + 1 || start + length > content.length
          || content[start + length - 1] !== 10) throw new WorktreeRecoveryError('WORKTREE_RECOVERY_ARCHIVE_INVALID');
        const record = content.subarray(space + 1, start + length - 1).toString('utf8');
        const equals = record.indexOf('=');
        if (equals <= 0) throw new WorktreeRecoveryError('WORKTREE_RECOVERY_ARCHIVE_INVALID');
        fields[record.slice(0, equals)] = record.slice(equals + 1);
        start += length;
      }
      if (type === 'g') globalPax = { ...globalPax, ...fields }; else pax = fields;
      continue;
    }
    if (type === 'L') { pax.path = cstring(content); continue; }
    const prefix = cstring(block.subarray(345, 500));
    const path = (pax.path ?? globalPax.path ?? (prefix ? prefix + '/' : '') + cstring(block.subarray(0, 100))).replace(/\/$/, '');
    const target = pax.linkpath ?? globalPax.linkpath ?? cstring(block.subarray(157, 257));
    if (pax.size !== undefined && Number(pax.size) !== size) throw new WorktreeRecoveryError('WORKTREE_RECOVERY_ARCHIVE_INVALID');
    pax = {};
    assertRecoveryPath(path);
    if (type === '5') continue;
    if (type !== '0' && type !== '' && !(allowBaselineLinks && type === '2')) {
      throw new WorktreeRecoveryError(type === '1' || type === '2' || type === 'K'
        ? 'WORKTREE_RECOVERY_V1_LINKS_UNSUPPORTED' : 'WORKTREE_RECOVERY_ARCHIVE_INVALID');
    }
    const key = process.platform === 'win32' ? path.toLowerCase() : path;
    if (names.has(key)) throw new WorktreeRecoveryError('WORKTREE_RECOVERY_DUPLICATE_PATH');
    names.add(key);
    files.push(type === '2' ? { path, bytes: Buffer.from(target), kind: 'symlink', target }
      : { path, bytes: Buffer.from(content), kind: 'file' });
  }
  throw new WorktreeRecoveryError('WORKTREE_RECOVERY_ARCHIVE_INVALID');
}
