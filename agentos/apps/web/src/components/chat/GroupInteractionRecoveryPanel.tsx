'use client';

import { useEffect, useRef, useState } from 'react';
import { groupInteractionRecoveryPath, groupInteractionRecoveryRequest, type GroupRecoveryContext } from '@/lib/groupInteractionRecovery';
import type { GroupInteractionRecoveryResult } from '@/lib/groupConversationClient';

type RecoveryPhase = 'prepared' | 'ready' | 'responding' | 'dispatched';

const recoveryPhaseOrder: Record<RecoveryPhase, number> = {
  prepared: 0,
  ready: 1,
  responding: 2,
  dispatched: 3,
};
const activeRecoveryRespondDispatches = new Set<string>();

interface StoredRecoveryIntent {
  readonly identityKey: string;
  readonly context: GroupRecoveryContext;
  readonly content: string;
  readonly idempotencyKey: string;
  readonly phase: RecoveryPhase;
  readonly result?: GroupInteractionRecoveryResult;
}

export interface GroupRecoveryDispatchState {
  readonly phase: () => RecoveryPhase;
  /** Persist before the one permitted new-round Provider start. */
  readonly markResponding: () => boolean;
  readonly markDispatched: () => void;
}

export interface GroupRecoveryIdentity {
  readonly workspaceId: string;
  readonly conversationId: string;
  /** Interrupted interaction that authorized this linked recovery. */
  readonly interactionId: string;
  readonly identityKey: string;
  readonly generation: number;
}

function storageKey(identityKey: string, context: GroupRecoveryContext): string {
  return `agentos:group-recovery:v1:${encodeURIComponent(JSON.stringify([
    identityKey, context.workspaceId, context.interactionId, context.interactionVersion, context.ownerEpoch,
  ]))}`;
}

function readStoredIntent(key: string, identityKey: string, context: GroupRecoveryContext): StoredRecoveryIntent | null {
  try {
    const value = window.localStorage.getItem(key);
    if (!value) return null;
    const parsed = JSON.parse(value) as Partial<StoredRecoveryIntent>;
    if (parsed.identityKey !== identityKey || JSON.stringify(parsed.context) !== JSON.stringify(context)
      || typeof parsed.content !== 'string' || typeof parsed.idempotencyKey !== 'string'
      || !['prepared', 'ready', 'responding', 'dispatched'].includes(parsed.phase ?? '')
      || (parsed.phase !== 'prepared' && !parsed.result)
      || (parsed.result && (typeof parsed.result.interaction?.id !== 'string' || typeof parsed.result.message?.id !== 'string'
        || typeof parsed.result.replayed !== 'boolean'))) return null;
    return parsed as StoredRecoveryIntent;
  } catch {
    return null;
  }
}

export function GroupInteractionRecoveryPanel(props: {
  readonly workspaceId: string;
  readonly apiBase: string;
  readonly identityKey?: string;
  readonly conversationId?: string;
  readonly generation?: number;
  readonly interactionId: string;
  readonly interactionVersion: number;
  readonly ownerEpoch: number;
  /** The primary workspace handler marks immediately before its bound respond call. */
  readonly dispatchManagedByCaller?: boolean;
  /** Rejects a completed recovery CAS when its original target is no longer visible. */
  readonly canDispatch?: (identity: GroupRecoveryIdentity) => boolean;
  readonly onRecovered: (result: GroupInteractionRecoveryResult, dispatch: GroupRecoveryDispatchState, identity: GroupRecoveryIdentity) => void | Promise<void>;
}) {
  const identityKey = props.identityKey ?? JSON.stringify(['legacy-group-recovery', props.workspaceId, props.interactionId]);
  const context: GroupRecoveryContext = {
    workspaceId: props.workspaceId,
    interactionId: props.interactionId,
    interactionVersion: props.interactionVersion,
    ownerEpoch: props.ownerEpoch,
  };
  const key = storageKey(identityKey, context);
  const [content, setContent] = useState('');
  const [pendingIntent, setPendingIntent] = useState<StoredRecoveryIntent | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const busyRef = useRef(false);
  const pendingIntentRef = useRef<StoredRecoveryIntent | null>(null);

  const updateIntent = (intent: StoredRecoveryIntent): StoredRecoveryIntent => {
    // A second tab or a remounted panel may have advanced this same intent
    // while an earlier recovery response was in flight. Never move its durable
    // dispatch fence backwards when that response is replayed.
    const stored = readStoredIntent(key, identityKey, context);
    const next = stored && recoveryPhaseOrder[stored.phase] > recoveryPhaseOrder[intent.phase]
      ? stored
      : intent;
    window.localStorage.setItem(key, JSON.stringify(next));
    pendingIntentRef.current = next;
    setPendingIntent(next);
    return next;
  };

  useEffect(() => {
    const restored = readStoredIntent(key, identityKey, context);
    if (restored) {
      pendingIntentRef.current = restored;
      setPendingIntent(restored);
      setContent(restored.content);
    }
  }, [key, identityKey, context.workspaceId, context.interactionId, context.interactionVersion, context.ownerEpoch]);

  const submit = async () => {
    if (busyRef.current) return;
    if (!('locks' in navigator)) {
      setError('当前浏览器不支持跨标签页安全锁；为避免同一恢复意图重复启动 Provider，本次没有提交。');
      return;
    }
    let intent = pendingIntentRef.current ?? readStoredIntent(key, identityKey, context);
    if (intent) {
      pendingIntentRef.current = intent;
      setPendingIntent(intent);
      setContent(intent.content);
    }
    if (intent?.phase === 'responding' || intent?.phase === 'dispatched') {
      setError('新轮次的启动请求已经发送或结果未确认；为避免重复调用 Provider，系统不会再次启动。');
      return;
    }
    if (!intent) {
      const normalized = content.trim();
      if (!normalized) return;
      const request = groupInteractionRecoveryRequest(context, normalized);
      intent = {
        identityKey,
        context,
        content: normalized,
        idempotencyKey: request.headers['Idempotency-Key'],
        phase: 'prepared',
      };
      try {
        intent = updateIntent(intent);
      } catch {
        setError('无法保存恢复意图；为避免丢失幂等键，本次没有请求服务器。');
        return;
      }
    }

    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      let result = intent.result;
      if (!result) {
        const request = groupInteractionRecoveryRequest(context, intent.content);
        const response = await fetch(`${props.apiBase.replace(/\/+$/u, '')}${groupInteractionRecoveryPath(props.workspaceId, props.interactionId)}`, {
          method: request.method,
          headers: { 'Content-Type': 'application/json', ...request.headers },
          body: JSON.stringify(request.body),
        });
        const payload = await response.json().catch(() => ({})) as GroupInteractionRecoveryResult & { readonly error?: string };
        if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
        if (!payload.interaction || !payload.message || typeof payload.replayed !== 'boolean') {
          throw new Error('恢复响应缺少新轮次或源消息；意图已保留，未启动 Provider。');
        }
        result = payload;
        intent = updateIntent({ ...intent, phase: 'ready', result });
      }

      const dispatchRecoveredResult = async () => {
        const current = readStoredIntent(key, identityKey, context);
        if (!current || current.phase !== 'ready') {
          setError('该恢复意图已由另一个页面实例启动或锁定；为避免重复调用 Provider，本页不会再次启动。');
          return;
        }
        intent = current;
        const dispatch: GroupRecoveryDispatchState = {
          phase: () => pendingIntentRef.current?.phase ?? intent!.phase,
          markResponding: () => {
            if (activeRecoveryRespondDispatches.has(key)) return false;
            const latest = readStoredIntent(key, identityKey, context);
            if (!latest || latest.phase !== 'ready') return false;
            activeRecoveryRespondDispatches.add(key);
            try {
              intent = updateIntent({ ...latest, phase: 'responding' });
              return true;
            } catch (cause) {
              activeRecoveryRespondDispatches.delete(key);
              throw cause;
            }
          },
          markDispatched: () => {
            const latest = readStoredIntent(key, identityKey, context);
            if (!latest || latest.phase !== 'responding') return;
            intent = updateIntent({ ...latest, phase: 'dispatched' });
          },
        };
        const identity: GroupRecoveryIdentity = {
          workspaceId: props.workspaceId,
          conversationId: props.conversationId ?? result!.interaction.conversationId,
          interactionId: props.interactionId,
          identityKey,
          generation: props.generation ?? 0,
        };
        if (props.canDispatch && !props.canDispatch(identity)) {
          setError('恢复已记录，但原工作区或群聊已切换；为避免串入其他会话，本页不会启动新轮次。');
          return;
        }
        if (!props.dispatchManagedByCaller && !dispatch.markResponding()) {
          setError('该恢复意图已由另一个页面实例启动或锁定；为避免重复调用 Provider，本页不会再次启动。');
          return;
        }
        await props.onRecovered(result!, dispatch, identity);
        if (!props.dispatchManagedByCaller) dispatch.markDispatched();
      };

      // The durable phase remains the crash/reload fence; the Web Lock closes
      // the cross-tab race where two pages read `ready` before either writes
      // `responding`. Without Web Locks, submit exits before making requests.
      await navigator.locks.request(`agentos-group-recovery:${key}`, dispatchRecoveredResult);
      if (pendingIntentRef.current?.phase === 'prepared') {
        setError('恢复结果已收到，但恢复意图状态无法确认；请勿重复启动 Provider。');
      } else {
        setContent('');
      }
    } catch (cause) {
      const phase = pendingIntentRef.current?.phase;
      if (phase === 'responding' || phase === 'dispatched') {
        setError(cause instanceof Error
          ? `${cause.message} 新轮次启动结果未确认；恢复意图已锁定，不会重放 Provider。`
          : '新轮次启动结果未确认；恢复意图已锁定，不会重放 Provider。');
      } else {
        setError(cause instanceof Error
          ? `${cause.message} 恢复意图已保留；重试会沿用原请求键。`
          : '恢复请求结果未确认。恢复意图已保留；重试会沿用原请求键。');
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const providerMayHaveStarted = pendingIntent?.phase === 'responding' || pendingIntent?.phase === 'dispatched';

  return <section className="mt-4 rounded-xl border border-[var(--app-warning)]/40 bg-[var(--app-surface-soft)] p-4" aria-label="恢复中断的群组讨论">
    <h3 className="text-sm font-medium ui-text">从新一轮继续</h3>
    <p className="mt-2 text-xs leading-5 ui-text-soft">旧轮次和已完成回复会保留并明确结束；系统会创建关联的新轮次，不会重放中断的 Agent 调用。请填写新的讨论指令。</p>
    <label htmlFor="group-recovery-content" className="mt-3 block text-xs ui-muted">新一轮指令</label>
    <textarea id="group-recovery-content" value={content} onChange={event => setContent(event.target.value)} rows={3} maxLength={16_000} disabled={pendingIntent !== null} className="ui-input mt-1 w-full resize-y rounded-lg px-3 py-2 text-sm ui-text disabled:opacity-70" placeholder="说明接下来希望 Agent 如何继续" />
    {pendingIntent?.phase === 'prepared' && <div role="status" className="mt-2 text-xs ui-muted">恢复请求尚未确认；重试会保留原指令和幂等键。</div>}
    {providerMayHaveStarted && <div role="status" className="mt-2 text-xs ui-muted">Provider 启动状态已锁定；不会自动重复启动。</div>}
    {error && <div role="alert" className="mt-2 text-xs text-[var(--app-danger)]">{error}</div>}
    <div className="mt-3 flex justify-end"><button type="button" disabled={busy || !content.trim() || providerMayHaveStarted} className="ui-button-primary rounded-lg px-3 py-2 text-xs disabled:cursor-not-allowed disabled:opacity-50" onClick={() => { void submit(); }}>{busy ? '建立新一轮…' : '建立关联新一轮'}</button></div>
  </section>;
}
