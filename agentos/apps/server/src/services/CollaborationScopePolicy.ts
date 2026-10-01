export const COLLABORATION_SCOPE_POLICY_VERSION = 1 as const;

export type CollaborationScopeEntry =
  | { readonly kind: 'repository'; readonly path: './' }
  | { readonly kind: 'directory'; readonly path: string }
  | { readonly kind: 'file'; readonly path: string };

export interface NormalizedCollaborationScope {
  readonly policyVersion: typeof COLLABORATION_SCOPE_POLICY_VERSION;
  readonly entries: readonly CollaborationScopeEntry[];
  /** Canonical POSIX spellings suitable for persistence and plan hashing. */
  readonly paths: readonly string[];
}

export class CollaborationScopeError extends Error {
  readonly code: 'COLLABORATION_SCOPE_INVALID' | 'COLLABORATION_SCOPE_OUTSIDE_APPROVED';
  readonly paths: readonly string[];

  constructor(
    code: CollaborationScopeError['code'],
    message: string,
    paths: readonly string[] = [],
  ) {
    super(`${code}: ${message}`);
    this.name = 'CollaborationScopeError';
    this.code = code;
    this.paths = [...paths];
  }
}

const WINDOWS_DEVICE_NAME = /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\..*)?$/i;
const INVALID_WINDOWS_CHARACTER = /[<>:"|]/u;
const GLOB_CHARACTER = /[*?\[\]{}]/u;
const AMBIGUOUS_SLASH = /[\u2044\u2215\u29F8\uFF0F]/u;

function invalidScope(path: string, reason: string): never {
  throw new CollaborationScopeError('COLLABORATION_SCOPE_INVALID', `${JSON.stringify(path)} ${reason}`, [path]);
}

function comparePath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeEntry(rawPath: unknown): CollaborationScopeEntry {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    invalidScope(String(rawPath), 'must be a non-empty repository-relative POSIX path');
  }

  if (rawPath === './') return { kind: 'repository', path: './' };
  if (
    rawPath !== rawPath.trim()
    || /\s/u.test(rawPath)
    || /[\u0000-\u001F\u007F]/u.test(rawPath)
    || rawPath.includes('\\')
    || rawPath.startsWith('/')
    || /^[A-Za-z]:/u.test(rawPath)
    || rawPath.includes(':')
    || INVALID_WINDOWS_CHARACTER.test(rawPath)
    || GLOB_CHARACTER.test(rawPath)
    || AMBIGUOUS_SLASH.test(rawPath)
  ) {
    invalidScope(rawPath, 'contains whitespace, an absolute/ambiguous separator, a device/ADS character, or a glob');
  }

  const isDirectory = rawPath.endsWith('/');
  const path = isDirectory ? rawPath.slice(0, -1) : rawPath;
  const segments = path.split('/');
  if (
    path.length === 0
    || segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    invalidScope(rawPath, 'contains an empty, current-directory, or traversal segment');
  }

  for (const segment of segments) {
    if (segment.toLowerCase() === '.git' || /[. ]$/u.test(segment) || WINDOWS_DEVICE_NAME.test(segment)) {
      invalidScope(rawPath, 'contains a Windows device name or a Windows-normalized segment');
    }
  }

  return isDirectory
    ? { kind: 'directory', path: `${path}/` }
    : { kind: 'file', path };
}

/**
 * Normalize the deliberately small, machine-checkable scope language.
 * A file has no trailing slash; a directory has one; only `./` means the
 * whole repository. Whitespace is rejected so prose is never guessed as a path.
 */
export function normalizeCollaborationScope(scope: readonly string[]): NormalizedCollaborationScope {
  if (!Array.isArray(scope) || scope.length === 0) {
    throw new CollaborationScopeError('COLLABORATION_SCOPE_INVALID', 'scope must contain at least one path');
  }

  const byPath = new Map<string, CollaborationScopeEntry>();
  for (const value of scope) {
    const entry = normalizeEntry(value);
    byPath.set(entry.path, entry);
  }

  if (byPath.has('./') && byPath.size !== 1) {
    throw new CollaborationScopeError(
      'COLLABORATION_SCOPE_INVALID',
      '`./` is the explicit whole-repository scope and cannot be combined with narrower paths',
      [...byPath.keys()],
    );
  }

  const entries = [...byPath.values()].sort((left, right) => comparePath(left.path, right.path));
  return {
    policyVersion: COLLABORATION_SCOPE_POLICY_VERSION,
    entries,
    paths: entries.map(entry => entry.path),
  };
}

export function resolveCollaborationScopePolicy(
  scope: NormalizedCollaborationScope | readonly string[],
): NormalizedCollaborationScope {
  if (Array.isArray(scope)) return normalizeCollaborationScope(scope);
  const policy = scope as NormalizedCollaborationScope;
  const fromPaths = normalizeCollaborationScope(policy.paths);
  const sameEntries = JSON.stringify(policy.entries) === JSON.stringify(fromPaths.entries);
  if (policy.policyVersion !== COLLABORATION_SCOPE_POLICY_VERSION || !sameEntries) {
    throw new CollaborationScopeError('COLLABORATION_SCOPE_INVALID', 'scope policy version or entries are invalid');
  }
  return fromPaths;
}

function isRepositoryRelativeGitPath(path: string): boolean {
  if (
    path.length === 0
    || path.includes('\0')
    || path.includes('\\')
    || path.startsWith('/')
    || /^[A-Za-z]:/u.test(path)
    || path.includes(':')
  ) return false;
  const segments = path.split('/');
  return segments.every(segment =>
    segment.length > 0
    && segment !== '.'
    && segment !== '..'
    && segment.toLowerCase() !== '.git'
    && !/[. ]$/u.test(segment)
    && !WINDOWS_DEVICE_NAME.test(segment));
}

export function assertCollaborationPathsWithinScope(
  scope: NormalizedCollaborationScope | readonly string[],
  changedPaths: readonly string[],
): void {
  const normalized = resolveCollaborationScopePolicy(scope);
  const outside = new Set<string>();

  for (const path of changedPaths) {
    if (!isRepositoryRelativeGitPath(path)) {
      throw new CollaborationScopeError('COLLABORATION_SCOPE_INVALID', 'Git reported an invalid repository-relative path', [path]);
    }
    const allowed = normalized.entries.some(entry => {
      if (entry.kind === 'repository') return true;
      if (entry.kind === 'file') return path === entry.path;
      const directory = entry.path.slice(0, -1);
      return path.startsWith(`${directory}/`);
    });
    if (!allowed) outside.add(path);
  }

  if (outside.size > 0) {
    const paths = [...outside].sort(comparePath);
    throw new CollaborationScopeError(
      'COLLABORATION_SCOPE_OUTSIDE_APPROVED',
      `candidate changes paths outside the approved scope: ${paths.join(', ')}`,
      paths,
    );
  }
}
