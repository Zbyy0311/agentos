'use client';

import { useEffect, useRef, useState } from 'react';
import type { MemoryContextRecord, MemoryContextSelection } from '@/lib/memoryContexts';
import {
  canProvideMemoryVersionFeedback,
  memoryFeedbackResponseIsCurrent,
  submitMemoryVersionFeedback,
  type MemoryFeedbackKind,
} from '@/lib/memoryFeedback';
import { isMemoryVersionConflict, memoryVersionConflictGuidance } from '@/lib/memoryManagement';
import { useApi } from '@/lib/useApi';

interface MemoryVersionFeedbackProps {
  readonly workspaceId: string;
  readonly context: Pick<MemoryContextRecord, 'id' | 'kind'>;
  readonly selection: Pick<MemoryContextSelection, 'memoryId' | 'memoryVersion' | 'store'>;
}

const FEEDBACK_CHOICES: readonly { readonly kind: MemoryFeedbackKind; readonly label: string }[] = [
  { kind: 'helpful', label: '有帮助' },
  { kind: 'wrong', label: '有错误' },
  { kind: 'outdated', label: '已过时' },
];

function unavailableReason(context: MemoryVersionFeedbackProps['context'], selection: MemoryVersionFeedbackProps['selection']): string {
  if (selection.memoryVersion === null) return '历史记录未保存此记忆的版本，无法提交版本反馈。';
  if (selection.store === 'legacy') return '此条选择来自旧版存储，无法提交正式记忆反馈。';
  if (context.kind === 'legacy-execution' && selection.store !== 'canonical') {
    return '旧版 Execution 未标明正式记忆来源，暂不可反馈。';
  }
  return '此历史选择没有可反馈的正式记忆版本。';
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return [message, memoryVersionConflictGuidance(error)].filter(Boolean).join(' ');
}

export function MemoryVersionFeedback({ workspaceId, context, selection }: MemoryVersionFeedbackProps) {
  const { request } = useApi();
  const [comment, setComment] = useState('');
  const [busyKind, setBusyKind] = useState<MemoryFeedbackKind>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [stale, setStale] = useState(false);
  const activeWorkspaceId = useRef(workspaceId);
  const requestGeneration = useRef(0);
  activeWorkspaceId.current = workspaceId;

  useEffect(() => {
    const generation = ++requestGeneration.current;
    setBusyKind(undefined);
    setError('');
    setNotice('');
    setStale(false);
    return () => {
      if (requestGeneration.current === generation) requestGeneration.current += 1;
    };
  }, [workspaceId, context.id, context.kind, selection.memoryId, selection.memoryVersion, selection.store]);

  const eligible = canProvideMemoryVersionFeedback(context.kind, selection);

  const submit = async (kind: MemoryFeedbackKind) => {
    if (busyKind || !eligible) return;
    const generation = requestGeneration.current;
    const isCurrent = () => memoryFeedbackResponseIsCurrent(
      workspaceId,
      activeWorkspaceId.current,
      generation,
      requestGeneration.current,
    );
    setBusyKind(kind);
    setError('');
    setNotice('');
    setStale(false);
    try {
      const feedback = await submitMemoryVersionFeedback(
        request,
        workspaceId,
        context,
        selection,
        kind,
        comment,
        isCurrent,
      );
      if (!isCurrent() || !feedback) return;
      setNotice(feedback.action
        ? `反馈已记录，已创建${feedback.action.action === 'correction' ? '修正' : '重新验证'}待办。`
        : '感谢反馈，已记录到这条冻结的记忆选择。');
      setComment('');
    } catch (submitError) {
      if (!isCurrent()) return;
      setError(errorText(submitError));
      setStale(isMemoryVersionConflict(submitError));
    } finally {
      if (isCurrent()) setBusyKind(undefined);
    }
  };

  return (
    <section aria-label={`对 ${selection.memoryId} 的反馈`} className="mt-3 border-t ui-border pt-3" data-agentos="memory-version-feedback" data-memory-id={selection.memoryId}>
      <div className="text-[11px] ui-dim">反馈针对冻结版本 v{selection.memoryVersion ?? '未知'}；提交前会读取当前正式记忆版本。</div>
      {!eligible ? <p className="mt-2 text-xs ui-dim">{unavailableReason(context, selection)}</p> : <>
        <label className="mt-2 block text-[11px] ui-dim">
          补充说明（可选）
          <textarea
            aria-label={`对 ${selection.memoryId} 的补充反馈`}
            value={comment}
            maxLength={2000}
            disabled={Boolean(busyKind)}
            onChange={event => setComment(event.target.value)}
            rows={2}
            className="mt-1 w-full resize-y rounded-lg border ui-border bg-[var(--app-surface)] px-3 py-2 text-xs ui-text outline-none focus:border-[var(--app-accent)] disabled:opacity-50"
          />
        </label>
        <div className="mt-2 flex flex-wrap gap-2">
          {FEEDBACK_CHOICES.map(choice => <button
            key={choice.kind}
            type="button"
            disabled={Boolean(busyKind)}
            onClick={() => { void submit(choice.kind); }}
            className="ui-button-ghost rounded-lg border ui-border px-3 py-2 text-xs disabled:opacity-50"
          >
            {busyKind === choice.kind ? '提交中…' : choice.label}
          </button>)}
        </div>
      </>}
      {notice && <p role="status" className="mt-2 text-xs ui-accent">{notice}</p>}
      {error && <div className="mt-2 text-xs text-[var(--app-danger)]"><p role="alert">{error}</p>{stale && <p className="mt-1">再次提交会先读取最新正式记忆版本。</p>}</div>}
    </section>
  );
}
