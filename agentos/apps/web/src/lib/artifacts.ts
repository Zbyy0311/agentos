import type { RuntimeArtifact } from '@agentos/shared';

export function normalizeArtifacts(artifacts: RuntimeArtifact[]): RuntimeArtifact[] {
  const order: Record<RuntimeArtifact['type'], number> = { diff: 0, file: 1, image: 1, report: 2, log: 3, manifest: 4, archive: 5 };
  return [...artifacts].sort((left, right) => {
    const typeOrder = order[left.type] - order[right.type];
    if (typeOrder) return typeOrder;
    const created = new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
    return created || left.title.localeCompare(right.title);
  });
}

export function getChatVisibleArtifacts(artifacts: RuntimeArtifact[]): RuntimeArtifact[] {
  return normalizeArtifacts(artifacts.filter(artifact => artifact.type !== 'log'));
}

export function getArtifactContentUrl(apiBase: string, artifact: RuntimeArtifact): string | undefined {
  if (!artifact.contentAvailable) return undefined;
  return `${apiBase}/api/workspaces/${encodeURIComponent(artifact.workspaceId)}/artifacts/${encodeURIComponent(artifact.id)}/content`;
}

export function getArtifactIcon(type: RuntimeArtifact['type']): string {
  switch (type) {
    case 'file': return '📄';
    case 'diff': return '🧩';
    case 'report': return '📊';
    case 'image': return '🖼️';
    case 'log': return '📝';
    case 'manifest': return '📋';
    case 'archive': return '🗜️';
    default: return '📦';
  }
}
