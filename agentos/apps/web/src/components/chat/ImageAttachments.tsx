import { useRef, useState } from 'react';
import type { ImageDraft } from '@/lib/imageAttachments';
import { ImagePreviewModal, type ImagePreviewItem } from './ImagePreviewModal';

interface ImageAttachmentsProps {
  drafts: ImageDraft[];
  disabled: boolean;
  onFiles(files: File[]): void;
  onRemove(id: string): void;
}

export function ImageAttachments({ drafts, disabled, onFiles, onRemove }: ImageAttachmentsProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const previewItems: ImagePreviewItem[] = drafts.map(draft => ({ id: draft.id, name: draft.name, url: draft.previewUrl }));

  return <div className="flex min-w-0 items-center gap-2">
    <input
      ref={inputRef}
      type="file"
      accept="image/png,image/jpeg,image/gif,image/webp"
      multiple
      className="hidden"
      onChange={event => {
        onFiles(Array.from(event.target.files ?? []));
        event.target.value = '';
      }}
    />
    <button
      type="button"
      aria-label="添加图片"
      title="粘贴图片或选择图片"
      disabled={disabled}
      onClick={() => inputRef.current?.click()}
      className="ui-button-ghost grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-transparent text-sm focus-visible:border-[var(--app-accent)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
    >
      <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path strokeLinecap="round" strokeLinejoin="round" d="m16.5 6.5-7.1 7.1a3 3 0 0 0 4.2 4.2l6-6a4.5 4.5 0 0 0-6.4-6.4l-7 7a6 6 0 1 0 8.5 8.5l5.2-5.2" />
      </svg>
    </button>
    {drafts.length > 0 && <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto py-0.5">
      {drafts.map(draft => <div key={draft.id} className="group ui-panel relative h-11 w-11 shrink-0 overflow-hidden rounded-lg border">
        <button type="button" aria-label={`放大 ${draft.name}`} onClick={() => setSelectedId(draft.id)} className="h-full w-full cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]">
          <img src={draft.previewUrl} alt={draft.name} title={draft.name} className="h-full w-full object-cover transition duration-200 group-hover:scale-105" />
        </button>
        <button
          type="button"
          aria-label={`移除 ${draft.name}`}
          onClick={() => onRemove(draft.id)}
          className="ui-panel-raised absolute right-0.5 top-0.5 grid h-4 w-4 place-items-center rounded-full text-[11px] leading-none ui-text opacity-0 transition group-hover:opacity-100 focus:opacity-100"
        >×</button>
      </div>)}
    </div>}
    <ImagePreviewModal items={previewItems} selectedId={selectedId} onClose={() => setSelectedId(null)} onSelect={setSelectedId} />
  </div>;
}
