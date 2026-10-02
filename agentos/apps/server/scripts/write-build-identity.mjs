import { execFileSync } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = resolve(serverRoot, '..', '..');
const distRoot = join(serverRoot, 'dist');
const packageJson = JSON.parse(readFileSync(join(serverRoot, 'package.json'), 'utf8'));
const version = validBuildLabel(process.env.AGENTOS_BUILD_VERSION) ?? validBuildLabel(packageJson.version);
const configuredCommit = process.env.AGENTOS_BUILD_COMMIT?.trim().toLowerCase();
const commit = configuredCommit && isCommit(configuredCommit) ? configuredCommit : discoverCommit();
if (!version || !commit) throw new Error('BUILD_IDENTITY_INPUT_INVALID: set AGENTOS_BUILD_VERSION/AGENTOS_BUILD_COMMIT at build time when package or Git metadata is unavailable');

const [hashModule, stampModule] = await Promise.all([
  import(pathToFileURL(join(distRoot, 'services', 'buildIdentityHash.js')).href),
  import(pathToFileURL(join(distRoot, 'services', 'BuildIdentityStamp.js')).href),
]);
const runtimeArtifactSha256 = hashModule.computeBuildArtifactHash(projectRoot);
const configuredId = process.env.AGENTOS_BUILD_ID?.trim();
if (configuredId && !validBuildLabel(configuredId)) throw new Error('BUILD_IDENTITY_INPUT_INVALID: AGENTOS_BUILD_ID is not a safe label');
const id = `${configuredId ? `${configuredId}-` : 'sha256-'}${runtimeArtifactSha256}`;
const stampPayload = {
  format: 'agentos-build-identity',
  formatVersion: 2,
  version,
  commit,
  id,
  runtimeArtifactSha256,
};
const stamp = { ...stampPayload, stampSha256: stampModule.computeBuildIdentityStampSha256(stampPayload) };
const output = join(distRoot, 'build-identity.json');
const temporary = `${output}.tmp-${process.pid}`;
writeFileSync(temporary, `${JSON.stringify(stamp, null, 2)}\n`, { flag: 'wx' });
renameSync(temporary, output);
process.stdout.write(`BUILD_IDENTITY_STAMPED version=${version} commit=${commit} id=${id}\n`);

function discoverCommit() {
  try {
    const value = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().toLowerCase();
    return isCommit(value) ? value : undefined;
  } catch { return undefined; }
}

function isCommit(value) { return /^[a-f0-9]{7,64}$/u.test(value); }

function validBuildLabel(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 90 && /^[\w.+-]+$/u.test(value)
    ? value
    : undefined;
}
