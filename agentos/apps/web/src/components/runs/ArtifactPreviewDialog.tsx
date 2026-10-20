'use client';

import { useEffect, useMemo, useState } from 'react';
import type { RuntimeArtifact } from '@agentos/shared';
import { AgentOSError, createAgentOSClient } from '@agentos/api-client';
import { useLiquidGlass } from '@/components/glass/useLiquidGlass';
import { uiLayerClass } from '@/lib/uiLayers';

const MAX_PREVIEW_BYTES = 256 * 1024;

export function ArtifactPreviewDialog({ artifact, apiBase, onClose }: { artifact: RuntimeArtifact; apiBase: string; onClose(): void }) {
  const [content, setContent] = useState<string | null>(null);
  const [tooLarge, setTooLarge] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const glassRef = useLiquidGlass<HTMLElement>('modal');
  const isImage = artifact.type === 'image';
  const client = useMemo(() => createAgentOSClient({ baseUrl: apiBase }), [apiBase]);
  const url = client.artifactContentUrl(artifact);
  useEffect(() => {
    if (isImage || url === undefined) return;
    const controller = new AbortController();
    client.getArtifactContent(artifact, { signal: controller.signal }).then(async response => {
      const length = Number(response.headers.get('content-length') ?? 0);
      if (length > MAX_PREVIEW_BYTES) { setTooLarge(true); return; }
      const value = await response.text();
      if (new TextEncoder().encode(value).byteLength > MAX_PREVIEW_BYTES) setTooLarge(true);
      else setContent(value);
    }).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (error instanceof AgentOSError && error.status > 0) {
        setLoadError(error.status === 404 ? '产物不存在或已被清理。' : error.status === 403 ? '当前工作区无权读取该产物。' : `产物加载失败（${error.status}）。`);
        return;
      }
      setLoadError('无法连接到产物服务。');
    });
    return () => controller.abort();
  }, [isImage, url, client, artifact]);
  return <div className={`ui-overlay-enter fixed inset-0 ${uiLayerClass('mediaPreview')} grid place-items-center bg-black/50 p-6`} role="dialog" aria-modal="true" aria-label="产物预览" onClick={onClose}>
    <section ref={glassRef} className="glass-dialog ui-panel max-h-[90vh] w-full max-w-4xl overflow-auto rounded-2xl border p-4 shadow-[var(--app-shadow)]" onClick={event => event.stopPropagation()}>
      <div className="mb-3 flex items-center justify-between gap-3"><h2 className="truncate font-medium ui-text">{artifact.title}</h2><button type="button" onClick={onClose} className="ui-button-ghost rounded-lg px-2 py-1 text-xs">关闭</button></div>
      {loadError ? <div role="alert" className="ui-error rounded-xl border p-3 text-sm">{loadError}<p className="mt-1 text-xs ui-muted">仅保留服务端返回的元数据，不会改用其他 Run 的内容。</p></div> : isImage && url ? <img src={url} alt={artifact.title} onError={() => setLoadError('产物不存在或已被清理。')} className="max-h-[75vh] max-w-full rounded-xl object-contain" /> : tooLarge ? <div className="space-y-2 text-sm ui-text-soft"><p>文件超过 256 KiB，已降级为元数据预览。</p><p className="text-xs ui-dim">{artifact.mimeType ?? artifact.type} · {artifact.sizeBytes} bytes</p><a href={url} target="_blank" rel="noreferrer" className="ui-button-ghost inline-flex rounded-lg px-2.5 py-1 text-xs">在新标签页打开</a></div> : <pre className="max-h-[75vh] overflow-auto whitespace-pre-wrap break-words rounded-xl bg-[var(--app-bg)] p-3 font-mono text-xs leading-5 ui-text-soft">{content ?? '正在加载…'}</pre>}
    </section>
  </div>;
}
