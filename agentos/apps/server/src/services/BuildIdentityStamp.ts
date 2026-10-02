import { createHash } from 'node:crypto';

export interface BuildIdentityStampPayload {
  readonly format: 'agentos-build-identity';
  readonly formatVersion: 2;
  readonly version: string;
  readonly commit: string;
  readonly id: string;
  readonly runtimeArtifactSha256: string;
}

/** Hashes every identity field together with the runtime artifact digest. */
export function computeBuildIdentityStampSha256(stamp: BuildIdentityStampPayload): string {
  const canonicalPayload = JSON.stringify({
    format: stamp.format,
    formatVersion: stamp.formatVersion,
    version: stamp.version,
    commit: stamp.commit,
    id: stamp.id,
    runtimeArtifactSha256: stamp.runtimeArtifactSha256,
  });
  return createHash('sha256').update(canonicalPayload, 'utf8').digest('hex');
}
