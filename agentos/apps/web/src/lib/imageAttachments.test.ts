import assert from 'node:assert/strict';
import test from 'node:test';
import { canSendMessage, fileToImageDraft, getAdjacentImageId, isImageClipboardItem, validateImageDrafts, type ImageDraft } from './imageAttachments.ts';

function draft(overrides: Partial<ImageDraft> = {}): ImageDraft {
  return {
    id: 'attachment-1',
    name: 'screen.png',
    mimeType: 'image/png',
    size: 1024,
    dataUrl: 'data:image/png;base64,AA==',
    previewUrl: 'blob:screen',
    ...overrides,
  };
}

test('accepts the supported image MIME types', () => {
  for (const mimeType of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
    assert.deepEqual(validateImageDrafts([draft({ mimeType })]), { ok: true });
  }
});

test('rejects unsupported MIME types', () => {
  const result = validateImageDrafts([draft({ mimeType: 'application/pdf' })]);
  assert.equal(result.ok, false);
});

test('rejects an image larger than 10 MB', () => {
  const result = validateImageDrafts([draft({ size: 10 * 1024 * 1024 + 1 })]);
  assert.equal(result.ok, false);
});

test('rejects more than five images and more than 25 MB total', () => {
  assert.equal(validateImageDrafts(Array.from({ length: 6 }, (_, index) => draft({ id: `attachment-${index}` }))).ok, false);
  assert.equal(validateImageDrafts([
    draft({ id: 'attachment-a', size: 10 * 1024 * 1024 }),
    draft({ id: 'attachment-b', size: 10 * 1024 * 1024 }),
    draft({ id: 'attachment-c', size: 5 * 1024 * 1024 + 1 }),
  ]).ok, false);
});

test('allows an image-only message and requires either text or an image', () => {
  assert.equal(canSendMessage('', [draft()]), true);
  assert.equal(canSendMessage('  ', []), false);
  assert.equal(canSendMessage('分析这张图', []), true);
});

test('recognizes image clipboard items without intercepting text items', () => {
  assert.equal(isImageClipboardItem({ type: 'image/png' }), true);
  assert.equal(isImageClipboardItem({ type: 'text/plain' }), false);
});

test('moves through image drafts and wraps at both ends', () => {
  const drafts = [draft({ id: 'first' }), draft({ id: 'second' }), draft({ id: 'third' })];
  assert.equal(getAdjacentImageId(drafts, 'first', 1), 'second');
  assert.equal(getAdjacentImageId(drafts, 'first', -1), 'third');
  assert.equal(getAdjacentImageId(drafts, 'third', 1), 'first');
});

test('returns no adjacent image when the carousel is empty', () => {
  assert.equal(getAdjacentImageId([], 'missing', 1), undefined);
});

test('converts a browser image file into a draft with a data URL preview', async () => {
  const image = new File([new Uint8Array([104, 105])], 'screen.png', { type: 'image/png' });
  const result = await fileToImageDraft(image);
  assert.equal(result.name, 'screen.png');
  assert.equal(result.mimeType, 'image/png');
  assert.equal(result.size, 2);
  assert.equal(result.dataUrl, 'data:image/png;base64,aGk=');
  assert.match(result.previewUrl, /^blob:/);
});

test('rejects a non-image browser file before reading it', async () => {
  const pdf = new File(['pdf'], 'file.pdf', { type: 'application/pdf' });
  await assert.rejects(fileToImageDraft(pdf), /仅支持 PNG、JPEG、GIF 和 WebP 图片/);
});
