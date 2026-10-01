'use client';

import { useEffect, useState } from 'react';
import { useApi } from '@/lib/useApi';

interface Suggestion {
  entryId: string;
  version: number;
  title: string;
  reasonCode: 'expired' | 'outdated-feedback' | 'low-value';
  proposedLifecycleAction: 'revalidate' | 'set-validity' | 'archive';
}
interface Result { available: boolean; evaluatedAt: string; suggestions: Suggestion[] }

const explanations = {
  expired: '已过期，后续调用不会选取。核实来源后，可重新验证并设置有效期。重新验证本身不会延长有效期。',
  'outdated-feedback': '当前版本收到过时反馈。请核实来源并处理关联反馈待办。',
  'low-value': '至少 180 天未更新，重要性不高于 0.2、置信度不高于 0.35，建议检查后归档。',
};

export function MemoryMaintenance({ workspaceId, onOpenEntry }: { workspaceId: string; onOpenEntry(id: string): void }) {
  const { request } = useApi();
  const [result, setResult] = useState<Result>();
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setResult(undefined);
    setError('');
    void request<Result>(`/api/workspaces/${encodeURIComponent(workspaceId)}/memory/maintenance`)
      .then(value => {
        if (!value || typeof value.available !== 'boolean' || !Array.isArray(value.suggestions)
          || value.suggestions.some(row => !row || typeof row.entryId !== 'string' || !Number.isSafeInteger(row.version)
            || row.version < 1 || typeof row.title !== 'string' || !Object.hasOwn(explanations, row.reasonCode))) {
          throw new Error('维护建议响应无效');
        }
        if (!cancelled) setResult(value);
      }).catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : '维护建议加载失败'); });
    return () => { cancelled = true; };
  }, [request, workspaceId, reload]);
  return <section aria-label="记忆维护建议" className="min-h-0 min-w-0 flex-1 overflow-auto">
    <h3 className="text-lg font-semibold ui-text">维护建议</h3>
    <p className="my-3 text-xs leading-5 ui-dim">建议不会自动修改记忆。查看条目后再决定是否重新验证、设置有效期或归档；历史上下文和审计记录会保留。</p>
    {error ? <div role="alert" className="text-sm ui-text"><p>{error}</p><button type="button" className="ui-button-ghost mt-2 px-3 py-2" onClick={() => setReload(value => value + 1)}>重试</button></div>
      : !result ? <p role="status" className="text-sm ui-dim">正在加载维护建议…</p>
        : !result.available ? <p className="text-sm ui-dim">当前存储版本暂不支持维护建议。</p>
          : result.suggestions.length === 0 ? <p className="text-sm ui-dim">暂无维护建议。</p>
            : <div className="space-y-3">{result.suggestions.map(row => <article key={row.entryId} className="rounded-xl border ui-border p-4">
              <h4 className="break-words text-sm font-medium ui-text">{row.title} · v{row.version}</h4>
              <p className="mt-2 text-xs leading-5 ui-dim">{explanations[row.reasonCode]}</p>
              <button type="button" className="ui-button-ghost mt-3 rounded-lg border ui-border px-3 py-2 text-xs" onClick={() => onOpenEntry(row.entryId)}>查看并处理</button>
            </article>)}</div>}
  </section>;
}
