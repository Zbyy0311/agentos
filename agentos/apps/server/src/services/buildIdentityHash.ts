import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const RUNTIME_EXTENSIONS = new Set(['.cjs', '.js', '.json', '.mjs', '.node', '.wasm']);
const ARTIFACT_DIRECTORIES = [
  'apps/server/dist',
  'packages/agent-core/dist',
  'packages/process-runtime/dist',
  'packages/shared/dist',
] as const;
const BUILD_INPUT_FILES = [
  'pnpm-lock.yaml',
  'apps/server/package.json',
  'packages/agent-core/package.json',
  'packages/process-runtime/package.json',
  'packages/shared/package.json',
  'scripts/agentos-diagnostic-redaction.mjs',
] as const;

/** Hashes the executable workspace output plus dependency lock/manifests, excluding the stamp itself. */
export function computeBuildArtifactHash(projectRoot: string): string {
  const root = resolve(projectRoot);
  const files = new Map<string, string>();
  for (const path of BUILD_INPUT_FILES) {
    const absolute = join(root, path);
    files.set(path, absolute);
  }
  for (const directory of ARTIFACT_DIRECTORIES) {
    const absolute = join(root, directory);
    collectRuntimeFiles(root, absolute, files);
  }
  if (files.size === BUILD_INPUT_FILES.length) throw new Error('BUILD_ARTIFACTS_MISSING');

  const digest = createHash('sha256');
  for (const [path, absolute] of [...files.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    const bytes = readFileSync(absolute);
    digest.update(path.replaceAll(sep, '/') + '\0' + bytes.byteLength + '\0', 'utf8');
    digest.update(bytes);
    digest.update('\0', 'utf8');
  }
  return digest.digest('hex');
}

function collectRuntimeFiles(root: string, directory: string, output: Map<string, string>): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      collectRuntimeFiles(root, absolute, output);
      continue;
    }
    if (!entry.isFile() || entry.name === 'build-identity.json' || entry.name.startsWith('build-identity.json.tmp-')) continue;
    const extension = entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase();
    if (!RUNTIME_EXTENSIONS.has(extension)) continue;
    output.set(relative(root, absolute).split(sep).join('/'), absolute);
  }
}
