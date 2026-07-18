'use client';

import { useEffect, useState } from 'react';
import type { RuntimeArtifact } from '@agentos/shared';

const MAX_PREVIEW_BYTES = 256 * 1024;

export function ArtifactPreviewDialog({ artifact, url, onClose }: { artifact: RuntimeArtifact; url: string; onClose(): void }) {
  const [content, setContent] = useState<string | null>(null);
  const [tooLarge, setTooLarge] = useState(false);
  const isImage = artifact.type === 'image';
  useEffect(() => {
    if (isImage) return;
    const controller = new AbortController();
    void fetch(url, { signal: controller.signal }).then(async response => {
      const length = Number(response.headers.get('content-length') ?? 0);
      if (length > MAX_PREVIEW_BYTES) { setTooLarge(true); return; }
      const value = await response.text();
      if (new TextEncoder().encode(value).byteLength > MAX_PREVIEW_BYTES) setTooLarge(true);
      else setContent(value);
    }).catch(() => setContent('无法加载该产物预览。'));
    return () => controller.abort();
  }, [isImage, url]);
  return <div className="fixed inset-0 z-[90] grid place-items-center bg-black/50 p-6" role="dialog" aria-modal="true" aria-label="产物预览" onClick={onClose}>
    <section className="ui-panel max-h-[90vh] w-full max-w-4xl overflow-auto rounded-2xl border p-4 shadow-[var(--app-shadow)]" onClick={event => event.stopPropagation()}>
      <div className="mb-3 flex items-center justify-between gap-3"><h2 className="truncate font-medium ui-text">{artifact.title}</h2><button type="button" onClick={onClose} className="ui-button-ghost rounded-lg px-2 py-1 text-xs">关闭</button></div>
      {isImage ? <img src={url} alt={artifact.title} className="max-h-[75vh] max-w-full rounded-xl object-contain" /> : tooLarge ? <div className="space-y-2 text-sm ui-text-soft"><p>文件超过 256 KiB，已降级为元数据预览。</p><p className="text-xs ui-dim">{artifact.mimeType ?? artifact.type} · {artifact.sizeBytes} bytes</p><a href={url} target="_blank" rel="noreferrer" className="ui-button-ghost inline-flex rounded-lg px-2.5 py-1 text-xs">在新标签页打开</a></div> : <pre className="max-h-[75vh] overflow-auto whitespace-pre-wrap break-words rounded-xl bg-[var(--app-bg)] p-3 font-mono text-xs leading-5 ui-text-soft">{content ?? '正在加载…'}</pre>}
    </section>
  </div>;
}

