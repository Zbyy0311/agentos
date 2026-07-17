'use client';

import type { RuntimeArtifact } from '@agentos/shared';
import { getArtifactContentUrl, getArtifactIcon, getChatVisibleArtifacts } from '@/lib/artifacts';

interface ArtifactShelfProps {
  artifacts: RuntimeArtifact[];
  apiBase: string;
}

export function ArtifactShelf({ artifacts, apiBase }: ArtifactShelfProps) {
  const items = getChatVisibleArtifacts(artifacts);
  return <section aria-label="Agent artifacts">
    <div className="mb-2 flex items-center justify-between gap-3">
      <h3 className="font-medium ui-text">Artifacts</h3>
      <span className="text-xs ui-dim">{items.length}</span>
    </div>
    {items.length === 0
      ? <p className="ui-dim">No artifacts were produced.</p>
      : <div className="grid gap-2 sm:grid-cols-2">
        {items.map(artifact => <ArtifactCard key={artifact.id} artifact={artifact} apiBase={apiBase} />)}
      </div>}
  </section>;
}

function ArtifactCard({ artifact, apiBase }: { artifact: RuntimeArtifact; apiBase: string }) {
  const url = getArtifactContentUrl(apiBase, artifact);
  const isImage = artifact.type === 'image' && Boolean(url);
  return <article className="rounded-xl border ui-border bg-[var(--app-surface-soft)] p-3" aria-label={`${artifact.type} artifact: ${artifact.title}`}>
    {isImage && <img src={url} alt={artifact.title} loading="lazy" className="mb-2 max-h-40 w-full rounded-lg object-contain" />}
    <div className="flex items-start gap-2">
      <span aria-hidden="true" className="text-lg">{getArtifactIcon(artifact.type)}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium ui-text" title={artifact.title}>{artifact.title}</div>
        <div className="mt-1 text-[11px] uppercase tracking-[0.12em] ui-dim">{artifact.type} · {formatBytes(artifact.sizeBytes)} · {artifact.agentId}</div>
        {artifact.summary && <p className="mt-1 line-clamp-2 text-xs ui-muted">{artifact.summary}</p>}
      </div>
    </div>
    <div className="mt-3 flex items-center gap-2">
      {url
        ? <a href={url} target="_blank" rel="noreferrer" className="ui-button-ghost rounded-lg px-2.5 py-1 text-xs">Open</a>
        : <span className="text-xs ui-dim">Metadata only</span>}
      {artifact.originalPath && <span className="truncate text-[11px] ui-dim" title={artifact.originalPath}>{artifact.originalPath}</span>}
    </div>
  </article>;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 102.4) / 10} KB`;
  return `${Math.round(value / (1024 * 102.4)) / 10} MB`;
}
