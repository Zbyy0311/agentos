import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { win32 } from 'node:path';

export class CollaborationPathBoundaryError extends Error {
  readonly code = 'COLLABORATION_PATH_BOUNDARY';
  readonly path?: string;

  constructor(message: string, path?: string) {
    super(`COLLABORATION_PATH_BOUNDARY: ${message}${path ? ` (${JSON.stringify(path)})` : ''}`);
    this.name = 'CollaborationPathBoundaryError';
    this.path = path;
  }
}

interface PathComponentWitness {
  readonly path: string;
  readonly exists: boolean;
  readonly realPath?: string;
  readonly mode?: number;
  readonly device?: string;
  readonly inode?: string;
  readonly size?: string;
  readonly mtimeNs?: string;
  readonly ctimeNs?: string;
}

interface PathWitness {
  readonly path: string;
  readonly components: readonly PathComponentWitness[];
}

interface PathComponentObservation {
  readonly witness: PathComponentWitness;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
}

export interface CollaborationPathBoundaryWitness {
  readonly rootRealPath: string;
  readonly root: PathComponentWitness;
  readonly paths: readonly PathWitness[];
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function validateRelativePath(path: string): string[] {
  if (
    typeof path !== 'string'
    || path.length === 0
    || path.includes('\0')
    || path.includes('\\')
    || path.startsWith('/')
    || isAbsolute(path)
    || win32.isAbsolute(path)
    || /^[A-Za-z]:/u.test(path)
    || path.includes(':')
  ) {
    throw new CollaborationPathBoundaryError('path is not a repository-relative POSIX path', path);
  }

  const segments = path.split('/');
  if (segments.some(segment =>
    segment.length === 0
    || segment === '.'
    || segment === '..'
    || segment.toLowerCase() === '.git'
    || /[. ]$/u.test(segment)
    || /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\..*)?$/iu.test(segment))) {
    throw new CollaborationPathBoundaryError('path contains traversal or a Windows-special segment', path);
  }
  return segments;
}

function componentWitness(
  path: string,
  stats: Awaited<ReturnType<typeof lstat>>,
  realPath: string,
): PathComponentWitness {
  return {
    path,
    exists: true,
    realPath,
    mode: Number(stats.mode),
    device: String(stats.dev),
    inode: String(stats.ino),
    size: String(stats.size),
    mtimeNs: String((stats as typeof stats & { mtimeNs?: bigint }).mtimeNs ?? BigInt(Math.trunc(Number(stats.mtimeMs) * 1_000_000))),
    ctimeNs: String((stats as typeof stats & { ctimeNs?: bigint }).ctimeNs ?? BigInt(Math.trunc(Number(stats.ctimeMs) * 1_000_000))),
  };
}

function sameWitness(left: CollaborationPathBoundaryWitness, right: CollaborationPathBoundaryWitness): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Validate every existing ancestor without following links, then confirm each
 * canonical path remains below the checkout root. Missing leaves are allowed
 * for deleted files; their existing ancestors are still checked and witnessed.
 */
export async function captureCollaborationPathBoundary(
  rootPath: string,
  repositoryRelativePaths: readonly string[],
): Promise<CollaborationPathBoundaryWitness> {
  const absoluteRoot = resolve(rootPath);
  let rootStats;
  try {
    rootStats = await lstat(absoluteRoot, { bigint: true });
  } catch (error) {
    throw new CollaborationPathBoundaryError(`checkout root cannot be inspected: ${(error as Error).message}`, rootPath);
  }
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new CollaborationPathBoundaryError('checkout root is not a real directory', rootPath);
  }

  let rootRealPath: string;
  try {
    rootRealPath = await realpath(absoluteRoot);
  } catch (error) {
    throw new CollaborationPathBoundaryError(`checkout root cannot be resolved: ${(error as Error).message}`, rootPath);
  }
  const root = componentWitness('.', rootStats, rootRealPath);
  const uniquePaths = [...new Set(repositoryRelativePaths)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const paths: PathWitness[] = [];
  const observations = new Map<string, PathComponentObservation>();
  const missingPrefixes = new Set<string>();

  for (const path of uniquePaths) {
    const segments = validateRelativePath(path);
    let cursor = rootRealPath;
    const components: PathComponentWitness[] = [];

    for (let index = 0; index < segments.length; index += 1) {
      const componentPath = segments.slice(0, index + 1).join('/');
      const isLeaf = index === segments.length - 1;
      if (missingPrefixes.has(componentPath)) {
        for (let rest = index; rest < segments.length; rest += 1) {
          components.push({ path: segments.slice(0, rest + 1).join('/'), exists: false });
          missingPrefixes.add(segments.slice(0, rest + 1).join('/'));
        }
        break;
      }

      let observation = observations.get(componentPath);
      if (!observation) {
        const absolutePath = join(cursor, segments[index]);
        let stats;
        try {
          stats = await lstat(absolutePath, { bigint: true });
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT' || code === 'ENOTDIR') {
            for (let rest = index; rest < segments.length; rest += 1) {
              const missingPath = segments.slice(0, rest + 1).join('/');
              components.push({ path: missingPath, exists: false });
              missingPrefixes.add(missingPath);
            }
            break;
          }
          throw new CollaborationPathBoundaryError(`path cannot be inspected: ${(error as Error).message}`, path);
        }

        if (stats.isSymbolicLink()) {
          throw new CollaborationPathBoundaryError('symlink or junction ancestor is not allowed', componentPath);
        }

        let realComponentPath: string;
        try {
          realComponentPath = await realpath(absolutePath);
        } catch (error) {
          throw new CollaborationPathBoundaryError(`path changed while resolving: ${(error as Error).message}`, componentPath);
        }
        if (!isWithin(rootRealPath, realComponentPath) || stats.dev !== rootStats.dev) {
          throw new CollaborationPathBoundaryError('path resolves outside the checkout tree', componentPath);
        }

        observation = {
          witness: componentWitness(componentPath, stats, realComponentPath),
          isFile: stats.isFile(),
          isDirectory: stats.isDirectory(),
        };
        observations.set(componentPath, observation);
      }

      if ((!isLeaf && !observation.isDirectory) || (isLeaf && !observation.isFile && !observation.isDirectory)) {
        throw new CollaborationPathBoundaryError('path contains an unsupported file type or non-directory ancestor', componentPath);
      }
      components.push(observation.witness);
      cursor = join(cursor, segments[index]);
    }

    paths.push({ path, components });
  }

  return { rootRealPath, root, paths };
}

/** Re-check the path ancestry and identities after a read, copy, or write. */
export async function assertCollaborationPathBoundaryUnchanged(
  rootPath: string,
  witness: CollaborationPathBoundaryWitness,
): Promise<void> {
  const current = await captureCollaborationPathBoundary(rootPath, witness.paths.map(item => item.path));
  if (!sameWitness(witness, current)) {
    throw new CollaborationPathBoundaryError('path or ancestor changed during the operation');
  }
}
