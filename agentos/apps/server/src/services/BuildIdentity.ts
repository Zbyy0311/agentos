import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AgentOsBuildIdentity {
  readonly version: string;
  readonly commit: string;
  readonly id: string;
}

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILD_IDENTITY = discoverBuildIdentity();

export function getAgentOsBuildIdentity(): AgentOsBuildIdentity {
  return BUILD_IDENTITY;
}

function discoverBuildIdentity(): AgentOsBuildIdentity {
  let packageVersion: string | undefined;
  try {
    const packageJson = JSON.parse(readFileSync(join(SERVER_ROOT, 'package.json'), 'utf8')) as { version?: unknown };
    if (typeof packageJson.version === 'string') packageVersion = packageJson.version;
  } catch { /* packaged installations can provide an explicit build version */ }
  const version = validBuildLabel(process.env.AGENTOS_BUILD_VERSION)
    ?? validBuildLabel(process.env.npm_package_version)
    ?? validBuildLabel(packageVersion)
    ?? 'unknown';

  const configuredCommit = process.env.AGENTOS_BUILD_COMMIT?.trim().toLowerCase();
  let commit = configuredCommit && /^[a-f0-9]{7,64}$/u.test(configuredCommit) ? configuredCommit : undefined;
  if (!commit) {
    try {
      const discovered = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
        cwd: SERVER_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim().toLowerCase();
      if (/^[a-f0-9]{7,64}$/u.test(discovered)) commit = discovered;
    } catch { /* packaged installations can provide AGENTOS_BUILD_COMMIT */ }
  }
  const id = validBuildLabel(process.env.AGENTOS_BUILD_ID) ?? commit ?? 'unknown';
  return Object.freeze({ version, commit: commit ?? 'unknown', id });
}

function validBuildLabel(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 160 && /^[\w.+-]+$/u.test(value) ? value : undefined;
}
