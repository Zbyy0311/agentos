import { useEffect, useRef } from 'react';
import { getAdjacentImageId } from '@/lib/imageAttachments';

export interface ImagePreviewItem {
  id: string;
  name: string;
  url: string;
}

interface ImagePreviewModalProps {
  items: ImagePreviewItem[];
  selectedId: string | null;
  onClose(): void;
  onSelect(id: string): void;
}

export function ImagePreviewModal({ items, selectedId, onClose, onSelect }: ImagePreviewModalProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const selectedIndex = items.findIndex(item => item.id === selectedId);
  const selectedItem = selectedIndex >= 0 ? items[selectedIndex] : undefined;

  useEffect(() => {
    if (!selectedId || !selectedItem) {
      if (selectedId && !selectedItem) onClose();
      return;
    }

    closeRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        const direction = event.key === 'ArrowLeft' ? -1 : 1;
        const nextId = getAdjacentImageId(items, selectedId, direction);
        if (nextId) onSelect(nextId);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [items, onClose, onSelect, selectedId, selectedItem]);

  if (!selectedItem) return null;

  const movePreview = (direction: -1 | 1) => {
    const nextId = getAdjacentImageId(items, selectedItem.id, direction);
    if (nextId) onSelect(nextId);
  };

  return <div
    className="fixed inset-0 z-[90] flex items-center justify-center bg-black/75 p-4"
    role="dialog"
    aria-modal="true"
    aria-label={`图片预览：${selectedItem.name}`}
    onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}
  >
    <div className="relative flex max-h-[calc(100vh-2rem)] w-full max-w-5xl flex-col gap-3 rounded-2xl border ui-border bg-[var(--app-surface)] p-3 sm:p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] tracking-[0.14em] ui-dim">IMAGE PREVIEW</div>
          <div className="truncate text-sm font-medium ui-text">{selectedItem.name}</div>
        </div>
        <button ref={closeRef} type="button" onClick={onClose} className="ui-button-ghost shrink-0 rounded-lg px-2.5 py-1.5 text-xs">关闭</button>
      </div>

      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-xl bg-black/30 p-2 sm:p-4">
        {items.length > 1 && <button type="button" aria-label="上一张" onClick={() => movePreview(-1)} className="ui-panel-raised absolute left-2 top-1/2 z-10 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-full text-lg ui-text transition hover:border-[var(--app-accent)]">‹</button>}
        <img src={selectedItem.url} alt={selectedItem.name} className="max-h-[min(72vh,720px)] max-w-full object-contain" />
        {items.length > 1 && <button type="button" aria-label="下一张" onClick={() => movePreview(1)} className="ui-panel-raised absolute right-2 top-1/2 z-10 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-full text-lg ui-text transition hover:border-[var(--app-accent)]">›</button>}
      </div>

      {items.length > 1 && <>
        <div className="flex items-center justify-center gap-2 overflow-x-auto px-1">
          {items.map((item, index) => <button
            key={item.id}
            type="button"
            aria-label={`切换到第 ${index + 1} 张`}
            aria-current={item.id === selectedId ? 'true' : undefined}
            onClick={() => onSelect(item.id)}
            className={`h-12 w-12 shrink-0 overflow-hidden rounded-lg border-2 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)] ${item.id === selectedId ? 'border-[var(--app-accent)]' : 'border-transparent opacity-65 hover:opacity-100'}`}
          ><img src={item.url} alt="" className="h-full w-full object-cover" /></button>)}
        </div>
        <div className="text-center text-xs ui-muted">{selectedIndex + 1} / {items.length}</div>
      </>}
    </div>
  </div>;
}
