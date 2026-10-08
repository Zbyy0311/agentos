import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';

export const OFFICIAL_CODEX_PROVIDER_KIND = 'official-openai-npm-codex';
export const SIMULATED_CODEX_PROVIDER_KIND = 'deterministic-fixture-cli';
export const OFFICIAL_CODEX_TRUST_BOUNDARY = 'local-operator-managed-official-npm-install';

const wrapperPackageName = '@openai/codex';
const platformAlias = '@openai/codex-win32-x64';
const platformPackageName = '@openai/codex';
const platformSuffix = '-win32-x64';
const acceptedVendorExecutables = [
  ['vendor', 'bin', 'codex.exe'],
  ['vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'],
];

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function isWithin(root, target) {
  const path = relative(root, target);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function runVersionProbe(executablePath) {
  const result = spawnSync(executablePath, ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  invariant(!result.error && result.status === 0,
    `official Codex CLI --version probe failed${result.error ? `: ${result.error.message}` : ''}`);
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

export function resolveNpmGlobalRoot() {
  const result = process.platform === 'win32'
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm root -g'], {
      encoding: 'utf8', windowsHide: true, shell: false, timeout: 10_000, maxBuffer: 1024 * 1024,
    })
    : spawnSync('npm', ['root', '-g'], {
      encoding: 'utf8', shell: false, timeout: 10_000, maxBuffer: 1024 * 1024,
    });
  invariant(!result.error && result.status === 0,
    `could not resolve the operator-managed npm global root${result.error ? `: ${result.error.message}` : ''}`);
  const candidate = (result.stdout ?? '').split(/\r?\n/u).map(line => line.trim()).filter(Boolean).at(-1);
  invariant(candidate && existsSync(candidate), 'npm root -g did not return an existing package directory');
  return realpathSync(candidate);
}

function readPackageJson(packageRoot, description) {
  const path = resolve(packageRoot, 'package.json');
  invariant(existsSync(path), `${description} package.json is missing`);
  const bytes = readFileSync(path);
  let document;
  try { document = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error(`${description} package.json is invalid`); }
  invariant(document && typeof document === 'object' && !Array.isArray(document),
    `${description} package.json must be an object`);
  return { path, bytes, document };
}

function packageRootForExecutable(executablePath, npmGlobalRoot) {
  const canonicalExecutable = realpathSync(executablePath);
  const fileStat = lstatSync(canonicalExecutable);
  invariant(fileStat.isFile(), 'configured Codex executable must be a regular file');
  invariant(basename(canonicalExecutable).toLowerCase() === 'codex.exe',
    'real acceptance requires the official vendor/bin/codex.exe, not a fixture or wrapper');

  const canonicalNpmRoot = realpathSync(npmGlobalRoot);
  const aliasRoot = resolve(canonicalNpmRoot, '@openai', 'codex-win32-x64');
  const wrapperRoot = resolve(canonicalNpmRoot, '@openai', 'codex');
  const nestedAliasRoot = resolve(wrapperRoot, 'node_modules', '@openai', 'codex-win32-x64');
  const candidateRoots = [aliasRoot, nestedAliasRoot]
    .filter(path => existsSync(path))
    .map(path => realpathSync(path));

  const matchingRoots = candidateRoots.filter(root => {
    const relativeExecutable = relative(root, canonicalExecutable).split(sep).join('/').toLowerCase();
    return acceptedVendorExecutables.some(parts => relativeExecutable === parts.join('/'));
  });
  invariant(matchingRoots.length === 1,
    'real acceptance executable must be the vendor codex.exe inside the official global @openai/codex-win32-x64 package');

  const platformRoot = matchingRoots[0];
  const canonicalWrapperRoot = realpathSync(wrapperRoot);
  invariant(isWithin(canonicalNpmRoot, canonicalWrapperRoot),
    'official @openai/codex wrapper package is outside the npm global install');
  const wrapper = readPackageJson(canonicalWrapperRoot, 'official @openai/codex');
  const platform = readPackageJson(platformRoot, 'official @openai/codex-win32-x64');
  invariant(wrapper.document.name === wrapperPackageName && /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(wrapper.document.version ?? ''),
    'global npm package metadata is not an official @openai/codex package');
  invariant(platform.document.name === platformPackageName
    && platform.document.version === `${wrapper.document.version}${platformSuffix}`,
  'Windows x64 payload metadata does not match the adjacent official @openai/codex version');
  invariant(wrapper.document.optionalDependencies?.[platformAlias]
    === `npm:${platformPackageName}@${platform.document.version}`,
  'official @openai/codex metadata does not bind the installed Windows x64 npm payload');

  return {
    canonicalExecutable,
    canonicalNpmRoot,
    wrapperRoot: realpathSync(wrapperRoot),
    wrapper,
    platformRoot,
    platform,
    relativeExecutable: relative(platformRoot, canonicalExecutable).split(sep).join('/'),
  };
}

function parseCliVersion(versionOutput) {
  invariant(typeof versionOutput === 'string' && versionOutput.length > 0,
    'Codex CLI version output is required');
  const match = versionOutput.match(/\bcodex(?:-cli)?\s+v?(\d+\.\d+\.\d+)\b/iu)
    ?? versionOutput.match(/\b(\d+\.\d+\.\d+)\b/u);
  invariant(match, 'Codex CLI --version output does not contain a semantic version');
  return match[1];
}

function identityDigest(identity) {
  const fields = [
    identity.schemaVersion,
    identity.kind,
    identity.trustBoundary,
    identity.packageName,
    identity.packageVersion,
    identity.platformPackageAlias,
    identity.platformPackageName,
    identity.platformPackageVersion,
    identity.npmGlobalRoot,
    identity.packageRoot,
    identity.executableRelativePath,
    identity.executablePath,
    identity.cliVersion,
    identity.packageJsonSha256,
    identity.platformPackageJsonSha256,
    identity.executableSha256,
  ];
  return sha256(Buffer.from(JSON.stringify(fields), 'utf8'));
}

/**
 * Capture the operator-managed official npm Codex installation identity.
 * The optional versionOutput lets a runner reuse its already-captured --version
 * output; omission performs a bounded local --version probe.
 */
export function captureOfficialCodexIdentity(executablePath, {
  npmGlobalRoot,
  versionOutput,
} = {}) {
  const trustedNpmRoot = npmGlobalRoot ? realpathSync(npmGlobalRoot) : resolveNpmGlobalRoot();
  const packageInfo = packageRootForExecutable(executablePath, trustedNpmRoot);
  const cliVersion = parseCliVersion(versionOutput ?? runVersionProbe(packageInfo.canonicalExecutable));
  invariant(cliVersion === packageInfo.wrapper.document.version,
    'Codex CLI --version does not match the adjacent official npm package version');

  const identity = {
    schemaVersion: 1,
    kind: OFFICIAL_CODEX_PROVIDER_KIND,
    trustBoundary: OFFICIAL_CODEX_TRUST_BOUNDARY,
    packageName: wrapperPackageName,
    packageVersion: packageInfo.wrapper.document.version,
    platformPackageAlias: platformAlias,
    platformPackageName: packageInfo.platform.document.name,
    platformPackageVersion: packageInfo.platform.document.version,
    npmGlobalRoot: packageInfo.canonicalNpmRoot,
    packageRoot: packageInfo.platformRoot,
    executableRelativePath: packageInfo.relativeExecutable,
    executablePath: packageInfo.canonicalExecutable,
    cliVersion,
    packageJsonSha256: sha256(packageInfo.wrapper.bytes),
    platformPackageJsonSha256: sha256(packageInfo.platform.bytes),
    executableSha256: sha256(readFileSync(packageInfo.canonicalExecutable)),
  };
  identity.identitySha256 = identityDigest(identity);
  return identity;
}

/** Re-resolve package metadata and the executable, rerun --version, and compare captured hashes. */
export function verifyOfficialCodexIdentity(identity, options = {}) {
  invariant(identity && typeof identity === 'object' && !Array.isArray(identity),
    'official Codex provider identity is required');
  invariant(identity.kind === OFFICIAL_CODEX_PROVIDER_KIND,
    'real acceptance rejects simulated or unrecognized Provider kinds');
  invariant(identity.trustBoundary === OFFICIAL_CODEX_TRUST_BOUNDARY,
    'Provider identity does not declare the local-operator trust boundary');
  const current = captureOfficialCodexIdentity(identity.executablePath, {
    npmGlobalRoot: options.npmGlobalRoot ?? resolveNpmGlobalRoot(),
    versionOutput: options.versionOutput,
  });
  for (const field of [
    'schemaVersion', 'kind', 'trustBoundary', 'packageName', 'packageVersion',
    'platformPackageAlias', 'platformPackageName', 'platformPackageVersion',
    'npmGlobalRoot', 'packageRoot', 'executableRelativePath', 'executablePath',
    'cliVersion', 'packageJsonSha256', 'platformPackageJsonSha256', 'executableSha256',
    'identitySha256',
  ]) {
    invariant(identity[field] === current[field], `Provider identity ${field} changed since capture`);
  }
  return current;
}
