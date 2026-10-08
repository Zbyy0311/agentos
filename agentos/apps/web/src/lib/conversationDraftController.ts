import {
  createConversationDraftIdentityKey,
  createEmptyConversationDraft,
  settleDraftSubmission,
  type ConversationDraft,
  type ConversationDraftIdentity,
  type SubmittedConversationDraft,
} from './conversationDraftState';
import type { ConversationDraftRepository } from './conversationDraftRepository';

export interface ConversationDraftSnapshot {
  readonly identityKey: string;
  readonly identity: ConversationDraftIdentity;
  readonly draft: ConversationDraft;
  readonly ready: boolean;
  readonly warning: string;
}

const STORAGE_WARNING = '草稿或图片存储失败；本次内容仅保留在内存，刷新可能丢失。';

/**
 * Keeps draft state keyed by the verified conversation identity, independent
 * of which identity the page currently renders. Async send/file callbacks can
 * therefore settle or update their original owner after navigation.
 */
export class ConversationDraftController {
  private readonly snapshots = new Map<string, ConversationDraftSnapshot>();
  private readonly loads = new Map<string, Promise<void>>();
  private readonly redirects = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private storageQueue: Promise<void> = Promise.resolve();

  constructor(private readonly repository: ConversationDraftRepository) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (identityKey: string | null): ConversationDraftSnapshot | null => {
    if (!identityKey) return null;
    return this.snapshots.get(this.resolveKey(identityKey)) ?? null;
  };

  async load(identity: ConversationDraftIdentity): Promise<void> {
    const identityKey = createConversationDraftIdentityKey(identity);
    const current = this.getSnapshot(identityKey);
    if (current?.ready) return;
    const pending = this.loads.get(identityKey);
    if (pending) return pending;

    if (!current) {
      this.snapshots.set(identityKey, {
        identityKey,
        identity,
        draft: createEmptyConversationDraft(),
        ready: false,
        warning: '',
      });
      this.notify();
    }

    const loading = this.repository.load(identity).then(result => {
      const resolvedKey = this.resolveKey(identityKey);
      const previous = this.snapshots.get(resolvedKey);
      if (previous?.ready) return;
      this.snapshots.set(resolvedKey, {
        identityKey: resolvedKey,
        identity: previous?.identity ?? identity,
        draft: result.draft,
        ready: true,
        warning: result.warning ?? '',
      });
      this.notify();
    }).catch(() => {
      const resolvedKey = this.resolveKey(identityKey);
      const previous = this.snapshots.get(resolvedKey);
      if (previous?.ready) return;
      this.snapshots.set(resolvedKey, {
        identityKey: resolvedKey,
        identity: previous?.identity ?? identity,
        draft: createEmptyConversationDraft(),
        ready: true,
        warning: '浏览器草稿存储不可用；内容仅保留在当前页面，刷新可能丢失。',
      });
      this.notify();
    }).finally(() => {
      this.loads.delete(identityKey);
    });
    this.loads.set(identityKey, loading);
    return loading;
  }

  updateDraft(identityKey: string, update: (current: ConversationDraft) => ConversationDraft): boolean {
    const resolvedKey = this.resolveKey(identityKey);
    const current = this.snapshots.get(resolvedKey);
    if (!current?.ready) return false;
    const changed = update(current.draft);
    if (changed === current.draft) return false;
    const next: ConversationDraftSnapshot = {
      ...current,
      draft: { ...changed, revision: current.draft.revision + 1 },
    };
    this.snapshots.set(resolvedKey, next);
    this.revokeRemovedPreviews(current.draft, next.draft);
    this.notify();
    void this.queueStorage(() => this.saveLatest(resolvedKey));
    return true;
  }

  async flushPersistence(): Promise<void> {
    await this.storageQueue;
  }

  async settleSubmission(
    identity: ConversationDraftIdentity,
    submitted: SubmittedConversationDraft,
    outcome: 'committed' | 'ambiguous',
  ): Promise<{ readonly warning?: string }> {
    if (outcome !== 'committed') return {};
    const requestedKey = createConversationDraftIdentityKey(identity);
    const targetKey = this.resolveKey(requestedKey);
    if (this.resolveKey(submitted.identityKey) !== targetKey) return {};
    await this.load(identity);
    const current = this.snapshots.get(targetKey);
    if (!current?.ready) return { warning: '发送已完成，但原会话草稿尚未能安全恢复；未清理本地内容。' };
    const normalizedSubmission = submitted.identityKey === targetKey
      ? submitted
      : { ...submitted, identityKey: targetKey };
    const settled = settleDraftSubmission(targetKey, current.draft, normalizedSubmission, 'committed');
    if (settled === current.draft) return {};
    this.snapshots.set(targetKey, { ...current, draft: settled });
    this.revokeRemovedPreviews(current.draft, settled);
    this.notify();
    await this.queueStorage(() => this.saveLatest(targetKey));
    const saved = this.getSnapshot(targetKey);
    return saved?.warning ? { warning: saved.warning } : {};
  }

  async migrateTo(
    sourceIdentity: ConversationDraftIdentity,
    targetIdentity: ConversationDraftIdentity,
  ): Promise<string | undefined> {
    const sourceKey = createConversationDraftIdentityKey(sourceIdentity);
    const targetKey = createConversationDraftIdentityKey(targetIdentity);
    if (this.resolveKey(sourceKey) === this.resolveKey(targetKey)) return this.resolveKey(targetKey);
    await Promise.all([this.load(sourceIdentity), this.load(targetIdentity)]);

    return this.queueStorage(async () => {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const resolvedSourceKey = this.resolveKey(sourceKey);
        if (resolvedSourceKey !== sourceKey) return resolvedSourceKey;
        const source = this.snapshots.get(sourceKey);
        const target = this.snapshots.get(this.resolveKey(targetKey));
        if (!source?.ready) return undefined;
        if (target && hasDraftContent(target.draft)) {
          this.setWarning(sourceKey, '草稿迁移目标已有独立内容；原草稿已保留，未覆盖目标草稿。');
          return undefined;
        }

        let persisted: Awaited<ReturnType<ConversationDraftRepository['save']>>;
        const migratedDraft: ConversationDraft = {
          ...source.draft,
          queue: source.draft.queue.map(item => ({ ...item, identityKey: targetKey })),
        };
        try {
          persisted = await this.repository.save(targetIdentity, migratedDraft);
        } catch {
          this.setWarning(sourceKey, STORAGE_WARNING);
          return undefined;
        }
        if (persisted.warning) {
          this.setWarning(sourceKey, persisted.warning);
          return undefined;
        }
        const afterSave = this.snapshots.get(sourceKey);
        if (!afterSave?.ready) return undefined;
        if (afterSave.draft.revision !== source.draft.revision) continue;

        const removed = await this.repository.remove(sourceIdentity);
        if (removed.warning) {
          this.setWarning(sourceKey, removed.warning);
          return undefined;
        }
        const afterRemove = this.snapshots.get(sourceKey);
        if (!afterRemove?.ready) return undefined;
        if (afterRemove.draft.revision !== source.draft.revision) continue;

        const destination: ConversationDraftSnapshot = {
          ...afterRemove,
          identityKey: targetKey,
          identity: targetIdentity,
          draft: migratedDraft,
          warning: '',
        };
        this.snapshots.set(targetKey, destination);
        this.snapshots.delete(sourceKey);
        this.redirects.set(sourceKey, targetKey);
        this.notify();
        return targetKey;
      }
      this.setWarning(sourceKey, '草稿迁移期间内容仍在变化；原身份草稿已保留，请确认后重试。');
      return undefined;
    });
  }

  private async saveLatest(identityKey: string): Promise<void> {
    const resolvedKey = this.resolveKey(identityKey);
    const current = this.snapshots.get(resolvedKey);
    if (!current?.ready) return;
    try {
      const result = await this.repository.save(current.identity, current.draft);
      this.setWarning(resolvedKey, result.warning ?? '');
    } catch {
      this.setWarning(resolvedKey, STORAGE_WARNING);
    }
  }

  private queueStorage<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.storageQueue.catch(() => undefined).then(operation);
    this.storageQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  private setWarning(identityKey: string, warning: string): void {
    const resolvedKey = this.resolveKey(identityKey);
    const current = this.snapshots.get(resolvedKey);
    if (!current || current.warning === warning) return;
    this.snapshots.set(resolvedKey, { ...current, warning });
    this.notify();
  }

  private resolveKey(identityKey: string): string {
    let resolved = identityKey;
    const seen = new Set<string>();
    while (this.redirects.has(resolved) && !seen.has(resolved)) {
      seen.add(resolved);
      const next = this.redirects.get(resolved);
      if (next === undefined) break;
      resolved = next;
    }
    return resolved;
  }

  private revokeRemovedPreviews(before: ConversationDraft, after: ConversationDraft): void {
    const retained = new Set(allAttachments(after).map(item => item.previewUrl));
    for (const attachment of allAttachments(before)) {
      if (!retained.has(attachment.previewUrl) && attachment.previewUrl.startsWith('blob:')) URL.revokeObjectURL(attachment.previewUrl);
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

function allAttachments(draft: ConversationDraft) {
  return [...draft.attachments, ...draft.queue.flatMap(item => item.attachments)];
}

function hasDraftContent(draft: ConversationDraft): boolean {
  return Boolean(draft.text || draft.mentionedAgentIds.length || draft.attachments.length || draft.queue.length
    || draft.runIntent !== 'execute' || draft.model || draft.thinkingEffort !== 'auto' || draft.scrollPosition > 0);
}
