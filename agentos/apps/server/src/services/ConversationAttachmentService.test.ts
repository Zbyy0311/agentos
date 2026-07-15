import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  cleanupConversationAttachments,
  saveConversationAttachments,
  type ConversationAttachmentInput,
} from './ConversationAttachmentService.js';

const imageData = 'data:image/png;base64,aGVsbG8=';

function input(overrides: Partial<ConversationAttachmentInput> = {}): ConversationAttachmentInput {
  return { name: 'screen.png', mimeType: 'image/png', dataUrl: imageData, ...overrides };
}

test('saves an image under the conversation attachment directory and returns metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentos-attachments-'));
  try {
    const [attachment] = await saveConversationAttachments({
      workspaceRoot: root,
      workspaceId: 'workspace-a',
      conversationId: 'conversation-a',
      messageId: 'message-a',
      attachments: [input()],
    });

    assert.ok(attachment);
    assert.equal(attachment.workspaceId, 'workspace-a');
    assert.equal(attachment.conversationId, 'conversation-a');
    assert.equal(attachment.messageId, 'message-a');
    assert.equal(attachment.name, 'screen.png');
    assert.equal(attachment.mimeType, 'image/png');
    assert.equal(attachment.size, 5);
    assert.match(attachment.relativePath, /^\.agentos[\\/]attachments[\\/]conversation-a[\\/][0-9a-f-]+\.png$/);
    assert.deepEqual(await readFile(join(root, attachment.relativePath)), Buffer.from('hello'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects non-image MIME types and malformed data URLs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentos-attachments-'));
  try {
    await assert.rejects(
      saveConversationAttachments({ workspaceRoot: root, workspaceId: 'workspace-a', conversationId: 'conversation-a', messageId: 'message-a', attachments: [input({ mimeType: 'application/pdf' })] }),
      /仅支持图片/,
    );
    await assert.rejects(
      saveConversationAttachments({ workspaceRoot: root, workspaceId: 'workspace-a', conversationId: 'conversation-a', messageId: 'message-a', attachments: [input({ dataUrl: 'not-a-data-url' })] }),
      /图片数据格式无效/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a decoded image larger than 10 MB before writing it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentos-attachments-'));
  try {
    const tooLarge = `data:image/png;base64,${Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64')}`;
    await assert.rejects(
      saveConversationAttachments({ workspaceRoot: root, workspaceId: 'workspace-a', conversationId: 'conversation-a', messageId: 'message-a', attachments: [input({ dataUrl: tooLarge })] }),
      /不能超过 10 MB/,
    );
    await assert.rejects(stat(join(root, '.agentos', 'attachments', 'conversation-a')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cleanup removes saved files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentos-attachments-'));
  try {
    const attachments = await saveConversationAttachments({
      workspaceRoot: root,
      workspaceId: 'workspace-a',
      conversationId: 'conversation-a',
      messageId: 'message-a',
      attachments: [input()],
    });
    await cleanupConversationAttachments(root, attachments);
    await assert.rejects(stat(join(root, attachments[0]!.relativePath)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects an attachment directory symlink that points outside the workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentos-attachments-'));
  const outside = await mkdtemp(join(tmpdir(), 'agentos-attachments-outside-'));
  try {
    await mkdir(join(root, '.agentos'), { recursive: true });
    await symlink(outside, join(root, '.agentos', 'attachments'), 'junction');

    await assert.rejects(
      saveConversationAttachments({ workspaceRoot: root, workspaceId: 'workspace-a', conversationId: 'conversation-a', messageId: 'message-a', attachments: [input()] }),
      /附件路径无效/,
    );
    assert.deepEqual((await stat(outside)).isDirectory(), true);
    assert.deepEqual((await stat(outside)).size, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
