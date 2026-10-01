import {
  conversationDraftStorageKey,
  createConversationDraftIdentityKey,
  createEmptyConversationDraft,
  deserializeConversationDraft,
  serializeConversationDraft,
  settleDraftSubmission,
  type ConversationDraft,
  type ConversationDraftIdentity,
  type SubmittedConversationDraft,
  type PersistedAttachmentMetadata,
} from './conversationDraftState';

export interface DraftTextStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface DraftBlobStorage {
  get(key: string): Promise<Blob | undefined>;
  put(key: string, value: Blob): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface ConversationDraftLoadResult {
  readonly draft: ConversationDraft;
  readonly warning?: string;
}

export interface ConversationDraftSaveResult {
  readonly warning?: string;
}

export class ConversationDraftRepository {
  constructor(
    private readonly textStorage: DraftTextStorage,
    private readonly blobStorage: DraftBlobStorage,
  ) {}

  async load(identity: ConversationDraftIdentity): Promise<ConversationDraftLoadResult> {
    const storageKey = conversationDraftStorageKey(identity);
    let serialized: string | null;
    try {
      serialized = this.textStorage.getItem(storageKey);
    } catch {
      return { draft: createEmptyConversationDraft(), warning: '浏览器文本存储不可用；草稿仅保留在当前页面，刷新可能丢失。' };
    }
    if (!serialized) return { draft: createEmptyConversationDraft() };
    const decoded = deserializeConversationDraft(serialized);
    if (!decoded) return { draft: createEmptyConversationDraft(), warning: '已保存草稿格式无法识别；本次使用内存草稿，刷新风险较高。' };

    const key = createConversationDraftIdentityKey(identity);
    const attachmentsById = new Map<string, ConversationDraft['attachments'][number]>();
    let warning: string | undefined;
    const queuedAttachmentMetadata = decoded.draft.queue.flatMap(item => item.attachments);
    const allMetadata = [...decoded.attachments, ...queuedAttachmentMetadata];
    for (const metadata of allMetadata) {
      if (attachmentsById.has(metadata.id)) continue;
      try {
        const blob = await this.blobStorage.get(blobKey(key, metadata.id));
        if (!blob) {
          warning = '部分已保存图片文件不可用；已保留附件引用，发送前请重新选择图片。';
          attachmentsById.set(metadata.id, { ...metadata, previewUrl: '' });
          continue;
        }
        attachmentsById.set(metadata.id, {
          ...metadata,
          previewUrl: URL.createObjectURL(blob),
          blob,
        });
      } catch {
        warning = '图片存储不可用；已恢复文字草稿，图片仅能在当前页面保留，刷新可能丢失。';
        attachmentsById.set(metadata.id, { ...metadata, previewUrl: '' });
      }
    }
    const attachments = decoded.attachments.flatMap(metadata => {
      const attachment = attachmentsById.get(metadata.id);
      return attachment ? [attachment] : [];
    });
    const queue = decoded.draft.queue.map(item => ({
      ...item,
      attachments: item.attachments.flatMap(metadata => {
        const attachment = attachmentsById.get(metadata.id);
        return attachment ? [attachment] : [];
      }),
    }));
    return { draft: { ...decoded.draft, attachments, queue }, ...(warning === undefined ? {} : { warning }) };
  }

  async save(identity: ConversationDraftIdentity, draft: ConversationDraft): Promise<ConversationDraftSaveResult> {
    const storageKey = conversationDraftStorageKey(identity);
    const identityKey = createConversationDraftIdentityKey(identity);
    const previousIds = this.readStoredAttachmentIds(storageKey);
    let warning: string | undefined;

    const persistedAttachments = new Map<string, ConversationDraft['attachments'][number]>();
    for (const attachment of [...draft.attachments, ...draft.queue.flatMap(item => item.attachments)]) {
      if (persistedAttachments.has(attachment.id)) continue;
      try {
        const blob = attachment.blob ?? (attachment.dataUrl ? await dataUrlBlob(attachment.dataUrl) : undefined);
        if (!blob) throw new Error('image blob missing');
        await this.blobStorage.put(blobKey(identityKey, attachment.id), blob);
        persistedAttachments.set(attachment.id, { ...attachment, blob, dataUrl: undefined });
      } catch {
        warning = '图片无法持久化；本次附件仅保留在内存，刷新可能丢失。';
      }
    }

    // Retain missing-Blob metadata too: recovery must fail visibly, not send a
    // silently reduced attachment list after refresh.
    const serialized = serializeConversationDraft(draft);
    try {
      this.textStorage.setItem(storageKey, serialized);
    } catch {
      return { warning: '浏览器存储不可用；草稿和附件仅保留在当前页面，刷新可能丢失。' };
    }

    const retainedIds = new Set([...draft.attachments, ...draft.queue.flatMap(item => item.attachments)].map(attachment => attachment.id));
    for (const id of previousIds) {
      if (retainedIds.has(id)) continue;
      try { await this.blobStorage.delete(blobKey(identityKey, id)); }
      catch { warning ??= '部分旧图片未能从浏览器存储中移除。'; }
    }
    return warning === undefined ? {} : { warning };
  }

  async migrate(from: ConversationDraftIdentity, to: ConversationDraftIdentity, draft: ConversationDraft): Promise<ConversationDraftSaveResult> {
    const result = await this.save(to, draft);
    if (result.warning) return result;
    return this.remove(from);
  }

  async remove(identity: ConversationDraftIdentity): Promise<ConversationDraftSaveResult> {
    const storageKey = conversationDraftStorageKey(identity);
    const identityKey = createConversationDraftIdentityKey(identity);
    const ids = this.readStoredAttachmentIds(storageKey);
    let warning: string | undefined;
    try { this.textStorage.removeItem(storageKey); }
    catch { return { warning: '草稿归属迁移未能移除原身份记录；原草稿仍保留。' }; }
    const removals = await Promise.all(ids.map(async id => {
      try { await this.blobStorage.delete(blobKey(identityKey, id)); return true; }
      catch { return false; }
    }));
    if (removals.some(removed => !removed)) warning ??= '部分旧图片未能从原身份存储中移除。';
    return warning === undefined ? {} : { warning };
  }

  async settleSubmission(
    identity: ConversationDraftIdentity,
    submitted: SubmittedConversationDraft,
    outcome: 'committed' | 'ambiguous',
  ): Promise<ConversationDraftSaveResult> {
    if (outcome !== 'committed') return {};
    const identityKey = createConversationDraftIdentityKey(identity);
    if (submitted.identityKey !== identityKey) return {};
    const storageKey = conversationDraftStorageKey(identity);
    let serialized: string | null;
    try {
      serialized = this.textStorage.getItem(storageKey);
    } catch {
      return { warning: '发送已完成，但浏览器草稿存储不可用；刷新前请检查草稿状态。' };
    }
    if (!serialized) return {};
    const decoded = deserializeConversationDraft(serialized);
    if (!decoded) return { warning: '发送已完成，但已保存草稿无法识别；未自动清理本地内容。' };
    const metadataAttachment = (item: PersistedAttachmentMetadata) => ({ ...item, previewUrl: '' });
    const draft: ConversationDraft = {
      ...decoded.draft,
      attachments: decoded.attachments.map(metadataAttachment),
      queue: decoded.draft.queue.map(item => ({ ...item, attachments: item.attachments.map(metadataAttachment) })),
    };
    const settled = settleDraftSubmission(identityKey, draft, submitted, 'committed');
    const retainedIds = new Set([
      ...settled.attachments.map(item => item.id),
      ...settled.queue.flatMap(item => item.attachments.map(attachment => attachment.id)),
    ]);
    try {
      this.textStorage.setItem(storageKey, serializeConversationDraft(settled));
    } catch {
      return { warning: '发送已完成，但本地草稿清理失败；刷新后可能仍显示已提交内容。' };
    }
    for (const attachmentId of submitted.attachmentIds) {
      if (retainedIds.has(attachmentId)) continue;
      try { await this.blobStorage.delete(blobKey(identityKey, attachmentId)); }
      catch { return { warning: '发送已完成，但部分已提交图片未能从本地存储移除。' }; }
    }
    return {};
  }

  private readStoredAttachmentIds(storageKey: string): string[] {
    try {
      const serialized = this.textStorage.getItem(storageKey);
      if (!serialized) return [];
      const decoded = deserializeConversationDraft(serialized);
      return decoded
        ? [...decoded.attachments.map(item => item.id), ...decoded.draft.queue.flatMap(item => item.attachments.map(attachment => attachment.id))]
        : [];
    } catch {
      return [];
    }
  }
}

function blobKey(identityKey: string, attachmentId: string): string {
  return `${identityKey}:${attachmentId}`;
}

async function dataUrlBlob(dataUrl: string): Promise<Blob> {
  const response = await fetch(dataUrl);
  return response.blob();
}

function openDraftDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const request = indexedDB.open('agentos-web-drafts', 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('images')) database.createObjectStore('images');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
    request.onblocked = () => reject(new Error('IndexedDB upgrade blocked'));
  });
}

async function withDraftStore<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openDraftDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction('images', mode);
    const request = operation(transaction.objectStore('images'));
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
    transaction.oncomplete = () => { database.close(); resolve(request.result); };
    transaction.onerror = () => { database.close(); reject(transaction.error ?? new Error('IndexedDB transaction failed')); };
    transaction.onabort = () => { database.close(); reject(transaction.error ?? new Error('IndexedDB transaction aborted')); };
  });
}

const browserDraftBlobStorage: DraftBlobStorage = {
  get: key => withDraftStore('readonly', store => store.get(key)),
  put: (key, value) => withDraftStore('readwrite', store => store.put(value, key)).then(() => undefined),
  delete: key => withDraftStore('readwrite', store => store.delete(key)).then(() => undefined),
};

const browserDraftTextStorage: DraftTextStorage = {
  getItem: key => window.localStorage.getItem(key),
  setItem: (key, value) => window.localStorage.setItem(key, value),
  removeItem: key => window.localStorage.removeItem(key),
};

export const browserConversationDraftRepository = new ConversationDraftRepository(browserDraftTextStorage, browserDraftBlobStorage);
