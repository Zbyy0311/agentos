import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  captureOfficialCodexIdentity,
  OFFICIAL_CODEX_PROVIDER_KIND,
  OFFICIAL_CODEX_TRUST_BOUNDARY,
  SIMULATED_CODEX_PROVIDER_KIND,
  verifyOfficialCodexIdentity,
} from './acceptance-provider-identity.mjs';

const packageVersion = '0.146.0';
const platformVersion = `${packageVersion}-win32-x64`;

function packageFixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentos-provider-identity-'));
  const npmGlobalRoot = resolve(root, 'node_modules');
  const wrapperRoot = resolve(npmGlobalRoot, '@openai', 'codex');
  const platformRoot = resolve(wrapperRoot, 'node_modules', '@openai', 'codex-win32-x64');
  const executablePath = resolve(platformRoot, 'vendor', 'bin', 'codex.exe');
  mkdirSync(resolve(platformRoot, 'vendor', 'bin'), { recursive: true });
  writeFileSync(resolve(wrapperRoot, 'package.json'), JSON.stringify({
    name: '@openai/codex',
    version: packageVersion,
    optionalDependencies: {
      '@openai/codex-win32-x64': `npm:@openai/codex@${platformVersion}`,
    },
  }));
  writeFileSync(resolve(platformRoot, 'package.json'), JSON.stringify({
    name: '@openai/codex',
    version: platformVersion,
  }));
  writeFileSync(executablePath, Buffer.from('operator-installed official package executable fixture bytes'));
  return { root, npmGlobalRoot, wrapperRoot, platformRoot, executablePath };
}

function withPackageFixture(run) {
  const fixture = packageFixture();
  try { return run(fixture); }
  finally { rmSync(fixture.root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
}

const versionOutput = 'codex-cli 0.146.0\n';

test('captures official npm package identity and rechecks the package, CLI version, and executable bytes', () => withPackageFixture(fixture => {
  const identity = captureOfficialCodexIdentity(fixture.executablePath, {
    npmGlobalRoot: fixture.npmGlobalRoot,
    versionOutput,
  });
  assert.equal(identity.kind, OFFICIAL_CODEX_PROVIDER_KIND);
  assert.equal(identity.trustBoundary, OFFICIAL_CODEX_TRUST_BOUNDARY);
  assert.equal(identity.packageName, '@openai/codex');
  assert.equal(identity.packageVersion, packageVersion);
  assert.equal(identity.platformPackageAlias, '@openai/codex-win32-x64');
  assert.equal(identity.platformPackageVersion, platformVersion);
  assert.equal(identity.executableRelativePath, 'vendor/bin/codex.exe');
  assert.equal(identity.executableSha256, createHash('sha256').update(readFileSync(fixture.executablePath)).digest('hex'));
  assert.equal(identity.identitySha256.length, 64);

  const verified = verifyOfficialCodexIdentity(identity, {
    npmGlobalRoot: fixture.npmGlobalRoot,
    versionOutput,
  });
  assert.equal(verified.identitySha256, identity.identitySha256);

  writeFileSync(fixture.executablePath, 'changed bytes');
  assert.throws(() => verifyOfficialCodexIdentity(identity, {
    npmGlobalRoot: fixture.npmGlobalRoot,
    versionOutput,
  }), /executableSha256 changed since capture/);
}));

test('rejects a self-supplied codex-fixture executable outside the official npm vendor path', () => withPackageFixture(fixture => {
  const fixtureExecutable = resolve(fixture.root, 'codex-fixture.exe');
  writeFileSync(fixtureExecutable, 'fixture');
  assert.throws(() => captureOfficialCodexIdentity(fixtureExecutable, {
    npmGlobalRoot: fixture.npmGlobalRoot,
    versionOutput,
  }), /vendor\/bin\/codex\.exe/);
}));

test('rejects an executable outside the operator-selected npm global root', () => withPackageFixture(fixture => {
  const foreignNpmGlobalRoot = resolve(fixture.root, 'foreign-node_modules');
  const foreignWrapperRoot = resolve(foreignNpmGlobalRoot, '@openai', 'codex');
  const foreignPlatformRoot = resolve(foreignWrapperRoot, 'node_modules', '@openai', 'codex-win32-x64');
  const foreignExecutable = resolve(foreignPlatformRoot, 'vendor', 'bin', 'codex.exe');
  mkdirSync(resolve(foreignPlatformRoot, 'vendor', 'bin'), { recursive: true });
  writeFileSync(resolve(foreignWrapperRoot, 'package.json'), JSON.stringify({
    name: '@openai/codex',
    version: packageVersion,
    optionalDependencies: {
      '@openai/codex-win32-x64': `npm:@openai/codex@${platformVersion}`,
    },
  }));
  writeFileSync(resolve(foreignPlatformRoot, 'package.json'), JSON.stringify({
    name: '@openai/codex',
    version: platformVersion,
  }));
  writeFileSync(foreignExecutable, 'foreign operator-installed executable fixture bytes');

  assert.doesNotThrow(() => captureOfficialCodexIdentity(foreignExecutable, {
    npmGlobalRoot: foreignNpmGlobalRoot,
    versionOutput,
  }));
  assert.throws(() => captureOfficialCodexIdentity(foreignExecutable, {
    npmGlobalRoot: fixture.npmGlobalRoot,
    versionOutput,
  }), /inside the official global @openai\/codex-win32-x64 package/);
}));

test('rejects payload metadata that does not match the official wrapper version and alias', () => withPackageFixture(fixture => {
  writeFileSync(resolve(fixture.platformRoot, 'package.json'), JSON.stringify({
    name: '@openai/codex',
    version: '0.146.1-win32-x64',
  }));
  assert.throws(() => captureOfficialCodexIdentity(fixture.executablePath, {
    npmGlobalRoot: fixture.npmGlobalRoot,
    versionOutput,
  }), /payload metadata does not match/);
}));

test('rejects a CLI version that differs from the adjacent official npm package', () => withPackageFixture(fixture => {
  assert.throws(() => captureOfficialCodexIdentity(fixture.executablePath, {
    npmGlobalRoot: fixture.npmGlobalRoot,
    versionOutput: 'codex-cli 0.145.0\n',
  }), /--version does not match/);
}));

test('real identity verification rejects the deterministic simulated provider kind', () => {
  assert.throws(() => verifyOfficialCodexIdentity({
    kind: SIMULATED_CODEX_PROVIDER_KIND,
    trustBoundary: 'none',
  }, { npmGlobalRoot: tmpdir(), versionOutput }), /rejects simulated or unrecognized Provider kinds/);
});
