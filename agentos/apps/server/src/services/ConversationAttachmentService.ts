import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_COUNT = 5;
const MAX_TOTAL_IMAGE_BYTES = 25 * 1024 * 1024;

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

export interface ConversationAttachmentInput {
  name: string;
  mimeType: string;
  dataUrl: string;
}

export interface StoredConversationAttachment {
  id: string;
  messageId: string;
  conversationId: string;
  workspaceId: string;
  name: string;
  mimeType: string;
  size: number;
  relativePath: string;
}

export interface SaveConversationAttachmentsInput {
  workspaceRoot: string;
  workspaceId: string;
  conversationId: string;
  messageId: string;
  attachments: ConversationAttachmentInput[];
}

export function validateConversationAttachmentInputs(attachments: ConversationAttachmentInput[]): void {
  validateAttachmentCount(attachments);
  const decoded = attachments.map(decodeAttachment);
  const totalSize = decoded.reduce((total, attachment) => total + attachment.bytes.length, 0);
  if (totalSize > MAX_TOTAL_IMAGE_BYTES) throw new Error('单条消息图片总大小不能超过 25 MB');
}

export async function saveConversationAttachments(input: SaveConversationAttachmentsInput): Promise<StoredConversationAttachment[]> {
  validateConversationAttachmentInputs(input.attachments);
  const decoded = input.attachments.map(decodeAttachment);

  const saved: StoredConversationAttachment[] = [];
  try {
    for (const attachment of decoded) {
      const id = randomUUID();
      const relativePath = join('.agentos', 'attachments', input.conversationId, `${id}.${IMAGE_EXTENSIONS[attachment.mimeType]}`);
      const absolutePath = getAttachmentAbsolutePath(input.workspaceRoot, relativePath);
      await mkdir(join(input.workspaceRoot, '.agentos', 'attachments', input.conversationId), { recursive: true });
      await writeFile(absolutePath, attachment.bytes, { flag: 'wx' });
      saved.push({
        id,
        messageId: input.messageId,
        conversationId: input.conversationId,
        workspaceId: input.workspaceId,
        name: attachment.name,
        mimeType: attachment.mimeType,
        size: attachment.bytes.length,
        relativePath,
      });
    }
    return saved;
  } catch (error) {
    await cleanupConversationAttachments(input.workspaceRoot, saved);
    throw error;
  }
}

export async function cleanupConversationAttachments(workspaceRoot: string, attachments: StoredConversationAttachment[]): Promise<void> {
  await Promise.all(attachments.map(async attachment => {
    try {
      await unlink(getAttachmentAbsolutePath(workspaceRoot, attachment.relativePath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }));
}

export function getAttachmentAbsolutePath(workspaceRoot: string, relativePath: string): string {
  const attachmentRoot = resolve(workspaceRoot, '.agentos', 'attachments');
  const absolutePath = resolve(workspaceRoot, relativePath);
  const pathFromRoot = relative(attachmentRoot, absolutePath);
  if (!pathFromRoot || pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) throw new Error('附件路径无效');
  return absolutePath;
}

function validateAttachmentCount(attachments: ConversationAttachmentInput[]): void {
  if (attachments.length > MAX_IMAGE_COUNT) throw new Error(`最多选择 ${MAX_IMAGE_COUNT} 张图片`);
}

function decodeAttachment(input: ConversationAttachmentInput): { name: string; mimeType: string; bytes: Buffer } {
  const mimeType = input.mimeType.toLowerCase();
  if (!IMAGE_EXTENSIONS[mimeType]) throw new Error('仅支持图片附件');
  const match = input.dataUrl.match(/^data:([^;]+);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match || match[1]!.toLowerCase() !== mimeType || match[2]!.length % 4 !== 0) throw new Error('图片数据格式无效');
  const bytes = Buffer.from(match[2]!, 'base64');
  if (bytes.length === 0) throw new Error('图片数据格式无效');
  if (bytes.length > MAX_IMAGE_SIZE_BYTES) throw new Error('单张图片不能超过 10 MB');
  return { name: input.name.trim() || 'image', mimeType, bytes };
}
