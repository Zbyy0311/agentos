'use client';

import { useRef, useState } from 'react';
import { groupInteractionRecoveryPath, groupInteractionRecoveryRequest } from '@/lib/groupInteractionRecovery';

interface GroupRecoveryResult {
  readonly interaction: { readonly id: string; readonly version: number };
  readonly message: { readonly id: string; readonly content: string };
  readonly participantAgentIds?: readonly string[];
  readonly replayed: boolean;
}

export function GroupInteractionRecoveryPanel(props: {
  readonly workspaceId: string;
  readonly apiBase: string;
  readonly interactionId: string;
  readonly interactionVersion: number;
  readonly ownerEpoch: number;
  readonly onRecovered: (result: GroupRecoveryResult) => void;
}) {
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const busyRef = useRef(false);

  const submit = async () => {
    const normalized = content.trim();
    if (!normalized || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      const intent = groupInteractionRecoveryRequest({
        workspaceId: props.workspaceId,
        interactionId: props.interactionId,
        interactionVersion: props.interactionVersion,
        ownerEpoch: props.ownerEpoch,
      }, normalized);
      const response = await fetch(`${props.apiBase.replace(/\/+$/u, '')}${groupInteractionRecoveryPath(props.workspaceId, props.interactionId)}`, {
        method: intent.method,
        headers: { 'Content-Type': 'application/json', ...intent.headers },
        body: JSON.stringify(intent.body),
      });
      const payload = await response.json().catch(() => ({})) as GroupRecoveryResult & { readonly error?: string };
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
      const result = payload;
      props.onRecovered(result);
      setContent('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法建立新的讨论轮次');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return <section className="mt-4 rounded-xl border border-[var(--app-warning)]/40 bg-[var(--app-surface-soft)] p-4" aria-label="恢复中断的群组讨论">
    <h3 className="text-sm font-medium ui-text">从新一轮继续</h3>
    <p className="mt-2 text-xs leading-5 ui-text-soft">旧轮次和已完成回复会保留并明确结束；系统会创建关联的新轮次，不会重放中断的 Agent 调用。请填写新的讨论指令。</p>
    <label htmlFor="group-recovery-content" className="mt-3 block text-xs ui-muted">新一轮指令</label>
    <textarea id="group-recovery-content" value={content} onChange={event => setContent(event.target.value)} rows={3} maxLength={16_000} className="ui-input mt-1 w-full resize-y rounded-lg px-3 py-2 text-sm ui-text" placeholder="说明接下来希望 Agent 如何继续" />
    {error && <div role="alert" className="mt-2 text-xs text-[var(--app-danger)]">{error}</div>}
    <div className="mt-3 flex justify-end"><button type="button" disabled={busy || !content.trim()} className="ui-button-primary rounded-lg px-3 py-2 text-xs disabled:cursor-not-allowed disabled:opacity-50" onClick={() => { void submit(); }}>{busy ? '建立新一轮…' : '建立关联新一轮'}</button></div>
  </section>;
}
