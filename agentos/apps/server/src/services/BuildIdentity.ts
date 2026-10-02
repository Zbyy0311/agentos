import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeBuildArtifactHash } from './buildIdentityHash.js';
import { computeBuildIdentityStampSha256 } from './BuildIdentityStamp.js';

export interface AgentOsBuildIdentity {
  readonly version: string;
  readonly commit: string;
  readonly id: string;
  /** True only when the compiled artifact stamp matches the files on disk. */
  readonly verified: boolean;
  readonly source: 'compiled-stamp' | 'source-checkout' | 'unavailable';
}

export interface AgentOsBuildIdentityStamp {
  readonly format: 'agentos-build-identity';
  readonly formatVersion: 2;
  readonly version: string;
  readonly commit: string;
  readonly id: string;
  readonly runtimeArtifactSha256: string;
  readonly stampSha256: string;
}

export interface ResolveBuildIdentityInput {
  readonly compiled: boolean;
  readonly stamp?: unknown;
  readonly runtimeArtifactSha256?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly packageVersion?: unknown;
  readonly gitCommit?: string;
}

const MODULE_PATH = fileURLToPath(import.meta.url);
const SERVER_ROOT = resolve(dirname(MODULE_PATH), '..', '..');
const PROJECT_ROOT = resolve(SERVER_ROOT, '..', '..');
const COMPILED_RUNTIME = relative(SERVER_ROOT, MODULE_PATH).split(sep)[0] === 'dist';
const BUILD_IDENTITY = discoverBuildIdentity();

export function getAgentOsBuildIdentity(): AgentOsBuildIdentity {
  return BUILD_IDENTITY;
}

/** Compiled processes accept only a stamped identity whose output hash still matches. */
export function resolveBuildIdentity(input: ResolveBuildIdentityInput): AgentOsBuildIdentity {
  if (input.compiled) {
    const stamp = parseBuildStamp(input.stamp);
    if (!stamp || input.runtimeArtifactSha256 !== stamp.runtimeArtifactSha256
      || computeBuildIdentityStampSha256(stamp) !== stamp.stampSha256) return unavailableIdentity();
    return Object.freeze({
      version: stamp.version,
      commit: stamp.commit,
      id: stamp.id,
      verified: true,
      source: 'compiled-stamp',
    });
  }

  const environment = input.environment ?? process.env;
  const version = validBuildLabel(environment.AGENTOS_BUILD_VERSION)
    ?? validBuildLabel(environment.npm_package_version)
    ?? validBuildLabel(input.packageVersion)
    ?? 'unknown';
  const configuredCommit = environment.AGENTOS_BUILD_COMMIT?.trim().toLowerCase();
  const commit = configuredCommit && isCommit(configuredCommit)
    ? configuredCommit
    : (input.gitCommit?.trim().toLowerCase() && isCommit(input.gitCommit.trim().toLowerCase())
      ? input.gitCommit.trim().toLowerCase()
      : 'unknown');
  const id = validBuildLabel(environment.AGENTOS_BUILD_ID) ?? (commit === 'unknown' ? 'unknown' : commit);
  return Object.freeze({ version, commit, id, verified: false, source: 'source-checkout' });
}

function discoverBuildIdentity(): AgentOsBuildIdentity {
  if (COMPILED_RUNTIME) {
    try {
      const stamp = JSON.parse(readFileSync(join(SERVER_ROOT, 'dist', 'build-identity.json'), 'utf8')) as unknown;
      const runtimeArtifactSha256 = computeBuildArtifactHash(PROJECT_ROOT);
      return resolveBuildIdentity({ compiled: true, stamp, runtimeArtifactSha256 });
    } catch {
      // A compiled binary never borrows the current checkout's Git HEAD.
      return unavailableIdentity();
    }
  }

  let packageVersion: unknown;
  try {
    packageVersion = (JSON.parse(readFileSync(join(SERVER_ROOT, 'package.json'), 'utf8')) as { version?: unknown }).version;
  } catch { /* source checkouts can provide an explicit build version */ }
  let gitCommit: string | undefined;
  try {
    gitCommit = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().toLowerCase();
  } catch { /* source mode reports an unavailable commit honestly */ }
  return resolveBuildIdentity({ compiled: false, packageVersion, gitCommit });
}

function parseBuildStamp(value: unknown): AgentOsBuildIdentityStamp | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const stamp = value as Record<string, unknown>;
  const expectedKeys = ['commit', 'format', 'formatVersion', 'id', 'runtimeArtifactSha256', 'stampSha256', 'version'];
  const actualKeys = Object.keys(stamp).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])
    || stamp.format !== 'agentos-build-identity' || stamp.formatVersion !== 2
    || !validBuildLabel(stamp.version) || !isCommit(stamp.commit)
    || !validBuildLabel(stamp.id) || !isSha256(stamp.runtimeArtifactSha256)
    || !isSha256(stamp.stampSha256)) return undefined;
  return stamp as unknown as AgentOsBuildIdentityStamp;
}

function unavailableIdentity(): AgentOsBuildIdentity {
  return Object.freeze({ version: 'unknown', commit: 'unknown', id: 'unstamped', verified: false, source: 'unavailable' });
}

function validBuildLabel(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 160 && /^[\w.+-]+$/u.test(value)
    ? value
    : undefined;
}

function isCommit(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{7,64}$/u.test(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}
