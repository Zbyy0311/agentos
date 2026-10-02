import { createHash } from 'node:crypto';
import type { CollaborationCandidateManifestEntry } from '@agentos/shared';

export function collaborationCandidateContentHash(input: {
  readonly diffHash: string;
  readonly snapshotVersion: number;
  readonly manifest: readonly CollaborationCandidateManifestEntry[];
}): string {
  const manifest = input.manifest.map(item => [
    item.path,
    item.sizeBytes,
    item.sha256 ?? null,
    item.gitObjectId?.toLowerCase() ?? null,
    item.baseSizeBytes ?? null,
    item.baseSha256 ?? null,
    item.baseObjectId?.toLowerCase() ?? null,
    item.binary ?? false,
    item.deleted ?? false,
  ] as const).sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0);
  return createHash('sha256').update(JSON.stringify({
    schemaVersion: 1,
    diffHash: input.diffHash.toLowerCase(),
    snapshotVersion: input.snapshotVersion,
    manifest,
  })).digest('hex');
}
