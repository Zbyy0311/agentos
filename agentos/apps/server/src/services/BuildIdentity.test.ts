import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBuildIdentity, type AgentOsBuildIdentityStamp } from './BuildIdentity.js';
import { computeBuildIdentityStampSha256, type BuildIdentityStampPayload } from './BuildIdentityStamp.js';

const stampPayload: BuildIdentityStampPayload = {
  format: 'agentos-build-identity',
  formatVersion: 2,
  version: '0.1.0',
  commit: 'a'.repeat(40),
  id: `sha256-${'b'.repeat(64)}`,
  runtimeArtifactSha256: 'b'.repeat(64),
};
const stamp: AgentOsBuildIdentityStamp = {
  ...stampPayload,
  stampSha256: computeBuildIdentityStampSha256(stampPayload),
};

test('compiled identity uses the verified build-time stamp instead of startup env or checkout HEAD', () => {
  const identity = resolveBuildIdentity({
    compiled: true,
    stamp,
    runtimeArtifactSha256: stamp.runtimeArtifactSha256,
    environment: { AGENTOS_BUILD_VERSION: '9.9.9', AGENTOS_BUILD_COMMIT: 'c'.repeat(40), AGENTOS_BUILD_ID: 'new-head' },
    packageVersion: '9.9.9',
    gitCommit: 'c'.repeat(40),
  });
  assert.deepEqual(identity, {
    version: stamp.version,
    commit: stamp.commit,
    id: stamp.id,
    verified: true,
    source: 'compiled-stamp',
  });
});

test('compiled identity fails closed when the stamp is missing, invalid or no longer matches dist files', () => {
  for (const input of [
    { compiled: true },
    { compiled: true, stamp: { ...stamp, commit: 'unknown' }, runtimeArtifactSha256: stamp.runtimeArtifactSha256 },
    { compiled: true, stamp, runtimeArtifactSha256: 'c'.repeat(64) },
  ]) {
    assert.deepEqual(resolveBuildIdentity(input), {
      version: 'unknown', commit: 'unknown', id: 'unstamped', verified: false, source: 'unavailable',
    });
  }
});

test('a valid stamp with a different emitted-artifact hash is rejected after dist changes', () => {
  assert.equal(resolveBuildIdentity({ compiled: true, stamp, runtimeArtifactSha256: 'c'.repeat(64) }).source, 'unavailable');
});

test('compiled identity rejects metadata changes even when each changed value remains valid', () => {
  for (const tampered of [
    { ...stamp, commit: 'c'.repeat(40) },
    { ...stamp, version: '9.9.9' },
    { ...stamp, id: `tampered-${'b'.repeat(64)}` },
  ]) {
    assert.deepEqual(resolveBuildIdentity({
      compiled: true, stamp: tampered, runtimeArtifactSha256: stamp.runtimeArtifactSha256,
    }), {
      version: 'unknown', commit: 'unknown', id: 'unstamped', verified: false, source: 'unavailable',
    });
  }
});

test('compiled identity rejects changed stamp digest and fields outside the complete stamp shape', () => {
  assert.equal(resolveBuildIdentity({
    compiled: true,
    stamp: { ...stamp, stampSha256: 'c'.repeat(64) },
    runtimeArtifactSha256: stamp.runtimeArtifactSha256,
  }).source, 'unavailable');
  assert.equal(resolveBuildIdentity({
    compiled: true,
    stamp: { ...stamp, unexpected: 'not-covered' },
    runtimeArtifactSha256: stamp.runtimeArtifactSha256,
  }).source, 'unavailable');
});

test('source checkout identity is explicitly marked uncompiled and snapshots build env or Git at startup', () => {
  const identity = resolveBuildIdentity({
    compiled: false,
    packageVersion: '0.1.0',
    gitCommit: 'd'.repeat(40),
    environment: {},
  });
  assert.deepEqual(identity, {
    version: '0.1.0', commit: 'd'.repeat(40), id: 'd'.repeat(40), verified: false, source: 'source-checkout',
  });
});
