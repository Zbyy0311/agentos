export const SUPPORTED_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_COUNT = 5;
export const MAX_TOTAL_IMAGE_BYTES = 25 * 1024 * 1024;

export interface ImageDraft {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  dataUrl: string;
  previewUrl: string;
}

export type ImageValidationResult = { ok: true } | { ok: false; error: string };

const supportedMimeTypes = new Set<string>(SUPPORTED_IMAGE_MIME_TYPES);

export function isSupportedImageMimeType(mimeType: string): boolean {
  return supportedMimeTypes.has(mimeType.toLowerCase());
}

export function isImageClipboardItem(item: { type?: string } | null | undefined): boolean {
  return Boolean(item?.type && isSupportedImageMimeType(item.type));
}

export function validateImageDrafts(drafts: ImageDraft[]): ImageValidationResult {
  if (drafts.length > MAX_IMAGE_COUNT) return { ok: false, error: `最多选择 ${MAX_IMAGE_COUNT} 张图片` };
  if (drafts.some(draft => !isSupportedImageMimeType(draft.mimeType))) return { ok: false, error: '仅支持 PNG、JPEG、GIF 和 WebP 图片' };
  if (drafts.some(draft => draft.size > MAX_IMAGE_SIZE_BYTES)) return { ok: false, error: '单张图片不能超过 10 MB' };
  if (drafts.reduce((total, draft) => total + draft.size, 0) > MAX_TOTAL_IMAGE_BYTES) return { ok: false, error: '单条消息图片总大小不能超过 25 MB' };
  return { ok: true };
}

export function canSendMessage(content: string, drafts: ImageDraft[]): boolean {
  return Boolean(content.trim()) || (drafts.length > 0 && validateImageDrafts(drafts).ok);
}

export async function fileToImageDraft(file: File): Promise<ImageDraft> {
  if (!isSupportedImageMimeType(file.type)) throw new Error('仅支持 PNG、JPEG、GIF 和 WebP 图片');
  if (file.size > MAX_IMAGE_SIZE_BYTES) throw new Error('单张图片不能超过 10 MB');
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    id,
    name: file.name || 'image',
    mimeType: file.type,
    size: file.size,
    dataUrl: `data:${file.type};base64,${btoa(binary)}`,
    previewUrl: URL.createObjectURL(file),
  };
}
