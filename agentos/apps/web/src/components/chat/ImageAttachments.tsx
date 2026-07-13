import { useRef } from 'react';
import type { ImageDraft } from '@/lib/imageAttachments';

interface ImageAttachmentsProps {
  drafts: ImageDraft[];
  disabled: boolean;
  onFiles(files: File[]): void;
  onRemove(id: string): void;
}

export function ImageAttachments({ drafts, disabled, onFiles, onRemove }: ImageAttachmentsProps) {
  const inputRef = useRef<HTMLInputElement>(null);

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
      className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-transparent text-slate-500 transition hover:border-slate-700 hover:bg-slate-800 hover:text-slate-200 focus-visible:border-blue-400 focus-visible:outline-none disabled:cursor-not-allowed disabled:text-slate-700"
    >
      <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path strokeLinecap="round" strokeLinejoin="round" d="m16.5 6.5-7.1 7.1a3 3 0 0 0 4.2 4.2l6-6a4.5 4.5 0 0 0-6.4-6.4l-7 7a6 6 0 1 0 8.5 8.5l5.2-5.2" />
      </svg>
    </button>
    {drafts.length > 0 && <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto py-0.5">
      {drafts.map(draft => <div key={draft.id} className="group relative h-11 w-11 shrink-0 overflow-hidden rounded-lg border border-slate-700 bg-slate-950">
        <img src={draft.previewUrl} alt={draft.name} title={draft.name} className="h-full w-full object-cover" />
        <button
          type="button"
          aria-label={`移除 ${draft.name}`}
          onClick={() => onRemove(draft.id)}
          className="absolute right-0.5 top-0.5 grid h-4 w-4 place-items-center rounded-full bg-slate-950/85 text-[11px] leading-none text-slate-200 opacity-0 transition group-hover:opacity-100 focus:opacity-100"
        >×</button>
      </div>)}
    </div>}
  </div>;
}
