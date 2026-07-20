'use client';

import { useCallback, useEffect, useState } from 'react';
import type { PreferenceEvidence, PreferenceProjection, UserProfile } from '@agentos/shared';
import { useApi } from '@/lib/useApi';
import { preferenceContextLabels, preferenceDimensionLabels, preferenceStatusLabels } from '@/lib/preferences';

interface PreferencePanelProps { workspaceId: string; onClose(): void; onOpenRun(runId: string): void; }

export function PreferencePanel({ workspaceId, onClose, onOpenRun }: PreferencePanelProps) {
  const { request } = useApi();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [projections, setProjections] = useState<PreferenceProjection[]>([]);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');

  const load = useCallback(async () => {
    const result = await request<{ profile: UserProfile; projections: PreferenceProjection[] }>(`/api/workspaces/${workspaceId}/preferences`);
    setProfile(result.profile); setProjections(result.projections); setError('');
  }, [request, workspaceId]);
  useEffect(() => { void load().catch(loadError => setError(loadError instanceof Error ? loadError.message : String(loadError))); }, [load]);

  const setLearning = async (enabled: boolean) => {
    setBusyId('learning');
    try { const result = await request<{ profile: UserProfile }>(`/api/workspaces/${workspaceId}/preferences/learning`, { method: 'POST', body: { enabled } }); setProfile(result.profile); }
    catch (actionError) { setError(actionError instanceof Error ? actionError.message : String(actionError)); }
    finally { setBusyId(''); }
  };
  const sleep = async (projectionId: string) => {
    setBusyId(projectionId);
    try { await request(`/api/workspaces/${workspaceId}/preferences/${projectionId}/sleep`, { method: 'POST' }); await load(); }
    catch (actionError) { setError(actionError instanceof Error ? actionError.message : String(actionError)); }
    finally { setBusyId(''); }
  };
  const openSource = async (projectionId: string) => {
    try {
      const result = await request<{ evidence: PreferenceEvidence[] }>(`/api/workspaces/${workspaceId}/preferences/evidence?projectionId=${encodeURIComponent(projectionId)}`);
      const source = result.evidence.at(-1);
      if (source) onOpenRun(source.runId); else setError('该偏好暂无可打开的来源 Run');
    } catch (actionError) { setError(actionError instanceof Error ? actionError.message : String(actionError)); }
  };
  const clear = async () => {
    if (!window.confirm('清除已形成的偏好投影？历史隐式证据会保留，但不会继续注入这些投影。')) return;
    setBusyId('clear');
    try { await request(`/api/workspaces/${workspaceId}/preferences/clear`, { method: 'POST' }); await load(); }
    catch (actionError) { setError(actionError instanceof Error ? actionError.message : String(actionError)); }
    finally { setBusyId(''); }
  };

  return <div className="fixed inset-0 z-[75] bg-[var(--app-surface)] p-6"><div className="mx-auto flex h-full max-w-5xl flex-col"><div className="mb-5 flex items-start justify-between gap-4"><div><div className="text-[11px] tracking-[0.16em] ui-dim">ADAPTIVE PREFERENCES</div><h2 className="mt-1 text-xl font-semibold ui-text">交互与工作偏好</h2><p className="mt-1 text-xs leading-5 ui-muted">只根据你的实际操作和修正逐步学习；当前要求始终优先。</p></div><button type="button" onClick={onClose} className="ui-button-ghost rounded-lg px-3 py-2 text-sm">返回聊天</button></div>
    {error && <div className="mb-4 rounded-lg border border-[var(--app-danger)]/30 p-3 text-sm text-[var(--app-danger)]">{error}</div>}
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border ui-border p-4"><div><div className="text-sm font-medium ui-text">隐式学习</div><div className="mt-1 text-xs ui-muted">暂停后不会记录新的偏好证据，也不会注入已有投影。</div></div><div className="flex gap-2"><button type="button" disabled={!profile || busyId === 'learning'} onClick={() => { void setLearning(!profile?.learningEnabled); }} className="ui-button-ghost rounded-lg px-3 py-2 text-sm disabled:opacity-50">{profile?.learningEnabled ? '暂停学习' : '恢复学习'}</button><button type="button" disabled={busyId === 'clear'} onClick={() => { void clear(); }} className="rounded-lg border border-[var(--app-danger)]/40 px-3 py-2 text-sm text-[var(--app-danger)] disabled:opacity-50">清除投影</button></div></div>
    <div className="min-h-0 flex-1 overflow-y-auto"><div className="grid gap-3 md:grid-cols-2">{projections.map(projection => <article key={projection.id} className="rounded-2xl border ui-border p-4"><div className="flex items-start justify-between gap-3"><div><div className="text-sm font-medium ui-text">{preferenceDimensionLabels[projection.dimension]}</div><div className="mt-1 text-xs ui-muted">{preferenceContextLabels[projection.contextKind]} · {projection.scope === 'workspace' ? '当前工作区' : '全局'}</div></div><span className={`rounded-full border px-2 py-1 text-[11px] ${projection.status === 'stable' ? 'border-[var(--app-success)]/40 text-[var(--app-success)]' : 'ui-border ui-text-soft'}`}>{preferenceStatusLabels[projection.status]}</span></div><p className="mt-4 rounded-xl bg-[var(--app-surface-soft)] px-3 py-2 text-sm ui-text">{projection.preferredValue}</p><div className="mt-3 grid grid-cols-3 gap-2 text-xs ui-muted"><span>置信度 {projection.confidence}%</span><span>{projection.independentRunCount} 次运行</span><span>{projection.evidenceCount} 条证据</span></div><div className="mt-4 flex items-center justify-between gap-2"><span className="text-[11px] ui-dim">最近支持 {new Date(projection.lastSupportedAt).toLocaleDateString('zh-CN')}</span><div className="flex gap-2"><button type="button" onClick={() => { void openSource(projection.id); }} className="ui-button-ghost rounded-lg px-2 py-1.5 text-xs">查看来源</button><button type="button" disabled={projection.status === 'dormant' || busyId === projection.id} onClick={() => { void sleep(projection.id); }} className="ui-button-ghost rounded-lg px-2 py-1.5 text-xs disabled:opacity-50">休眠</button></div></div></article>)}{projections.length === 0 && <div className="rounded-2xl border border-dashed ui-border p-8 text-center text-sm ui-dim md:col-span-2">还没有形成可注入的偏好。继续使用，系统会在重复行为和修正中逐步学习。</div>}</div></div>
  </div></div>;
}
