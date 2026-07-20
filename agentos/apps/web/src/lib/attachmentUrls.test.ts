import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveAttachmentUrl } from './attachmentUrls';

test('resolves a history attachment path against the API origin', () => {
  assert.equal(
    resolveAttachmentUrl('http://localhost:3000', '/api/workspaces/workspace-1/attachments/attachment-1'),
    'http://localhost:3000/api/workspaces/workspace-1/attachments/attachment-1',
  );
});

test('preserves absolute and browser-local attachment URLs', () => {
  assert.equal(resolveAttachmentUrl('http://localhost:3000/', 'https://cdn.example.com/image.png'), 'https://cdn.example.com/image.png');
  assert.equal(resolveAttachmentUrl('http://localhost:3000/', 'blob:http://localhost:3001/preview'), 'blob:http://localhost:3001/preview');
  assert.equal(resolveAttachmentUrl('http://localhost:3000/', 'data:image/png;base64,AA=='), 'data:image/png;base64,AA==');
});
