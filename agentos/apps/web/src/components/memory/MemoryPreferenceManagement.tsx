'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { preferenceContextLabels, preferenceDimensionLabels } from '@/lib/preferences';
import { useApi } from '@/lib/useApi';
import {
  isMemoryVersionConflict,
  memoryVersionConflictGuidance,
  preferenceEvidencePath,
  preferenceSuggestionActionPath,
  preferenceSuggestionActionPayload,
  preferenceSuggestionsPath,
  workspaceResponseIsCurrent,
  type PreferenceSuggestionAction,
  type PreferenceEvidenceDto,
  type PreferenceSuggestionDto,
} from '@/lib/memoryManagement';

interface MemoryPreferenceManagementProps {
  readonly workspaceId: string;
  onOpenRun(runId: string): void;
}

interface SuggestionCardProps {
  readonly workspaceId: string;
  readonly suggestion: PreferenceSuggestionDto;
  readonly busy: boolean;
  readonly confirmGlobal: boolean;
  onOpenRun(runId: string): void;
  onConfirmGlobalChange(value: boolean): void;
  onAction(action: PreferenceSuggestionAction): void;
}

const statusLabels: Record<PreferenceSuggestionDto['status'], string> = {
  pending: '待确认', confirmed: '已确认', rejected: '已拒绝', revoked: '已撤销',
};

function labelFor(labels: Record<string, string>, value: string): string {
  return labels[value] ?? value;
}

const signalLabels: Record<string, string> = {
  direct_correction: '直接修正',
  repeated_instruction: '重复要求',
  workflow_choice: '工作流选择',
  successful_application: '成功应用',
  rework: '返工',
  conflict: '冲突信号',
};

export function MemoryPreferenceEvidenceList({
  evidence, loading, error, onRetry, onOpenRun,
}: {
  readonly evidence: readonly PreferenceEvidenceDto[] | null;
  readonly loading: boolean;
  readonly error: string;
  onRetry(): void;
  onOpenRun(runId: string): void;
}) {
  if (loading) return <p role="status" className="mt-3 text-xs ui-dim">正在加载来源依据…</p>;
  if (error) return <div className="mt-3 text-xs text-[var(--app-danger)]"><p role="alert">{error}</p><button type="button" onClick={onRetry} className="ui-button-ghost mt-2 rounded-lg border ui-border px-3 py-2">重试加载依据</button></div>;
  if (evidence === null) return null;
  if (evidence.length === 0) return <p className="mt-3 text-xs ui-dim">暂无匹配的来源依据。</p>;
  return <ol aria-label="偏好来源证据" className="mt-3 space-y-2">
    {evidence.map(item => <li key={item.id} className="rounded-lg border ui-border p-3">
      <p className="text-sm leading-5 ui-text-soft">{item.summary || item.candidateValue}</p>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] ui-dim">
        <span>{signalLabels[item.signalType] ?? item.signalType}</span>
        <span>{item.polarity === 'positive' ? '支持' : '反向'}</span>
        <span>{item.status === 'active' ? '有效' : '已撤回'}</span>
        <span>权重 {item.weight}</span>
        <span>{new Date(item.observedAt).toLocaleString()}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px]">
        {item.runId && <button type="button" onClick={() => onOpenRun(item.runId)} className="underline underline-offset-2 ui-accent">打开来源 Run {item.runId.slice(0, 10)}</button>}
        {item.sourceEventId && <span className="break-all ui-dim">事件：{item.sourceEventId}</span>}
        {item.conversationId && <span className="break-all ui-dim">会话：{item.conversationId}</span>}
      </div>
    </li>)}
  </ol>;
}

export function MemoryPreferenceSuggestionCard({ workspaceId, suggestion, busy, confirmGlobal, onOpenRun, onConfirmGlobalChange, onAction }: SuggestionCardProps) {
  const { request } = useApi();
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [evidenceError, setEvidenceError] = useState('');
  const [evidence, setEvidence] = useState<PreferenceEvidenceDto[] | null>(null);
  const activeWorkspaceId = useRef(workspaceId);
  const evidenceGeneration = useRef(0);
  activeWorkspaceId.current = workspaceId;

  useEffect(() => {
    const generation = ++evidenceGeneration.current;
    return () => {
      if (evidenceGeneration.current === generation) evidenceGeneration.current += 1;
    };
  }, [workspaceId]);

  const loadEvidence = async () => {
    const generation = ++evidenceGeneration.current;
    setEvidenceLoading(true);
    setEvidenceError('');
    try {
      const result = await request<{ evidence: PreferenceEvidenceDto[] }>(preferenceEvidencePath(workspaceId, suggestion.projectionId));
      if (workspaceResponseIsCurrent(workspaceId, activeWorkspaceId.current, generation, evidenceGeneration.current)) setEvidence(result.evidence);
    } catch (loadError) {
      if (workspaceResponseIsCurrent(workspaceId, activeWorkspaceId.current, generation, evidenceGeneration.current)) {
        setEvidenceError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    } finally {
      if (workspaceResponseIsCurrent(workspaceId, activeWorkspaceId.current, generation, evidenceGeneration.current)) setEvidenceLoading(false);
    }
  };

  const toggleEvidence = () => {
    if (evidenceLoading) return;
    if (evidenceOpen) {
      setEvidenceOpen(false);
      return;
    }
    setEvidenceOpen(true);
    if (evidence === null) void loadEvidence();
  };

  return <article className="ui-panel rounded-xl border ui-border p-4" data-suggestion-id={suggestion.id} data-status={suggestion.status}>
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div>
        <h4 className="font-medium ui-text">{labelFor(preferenceDimensionLabels, suggestion.dimension)}：{suggestion.preferredValue}</h4>
        <p className="mt-1 text-xs ui-dim">{labelFor(preferenceContextLabels, suggestion.contextKind)} · {suggestion.scope === 'global' ? '建议全局适用' : '当前工作区'} · {suggestion.evidenceCount} 条依据</p>
      </div>
      <span className="rounded-full border ui-border px-2 py-1 text-[11px] ui-accent">{statusLabels[suggestion.status]}</span>
    </div>
    {suggestion.entryId && <p className="mt-2 break-all text-[11px] ui-dim">关联记忆：{suggestion.entryId}</p>}
    <div className="mt-3">
      <button type="button" aria-expanded={evidenceOpen} disabled={evidenceLoading} onClick={toggleEvidence} className="ui-button-ghost rounded-lg border ui-border px-3 py-2 text-xs disabled:opacity-50">
        {evidenceOpen ? '收起来源依据' : `查看来源依据（${suggestion.evidenceCount}）`}
      </button>
      {evidenceOpen && <MemoryPreferenceEvidenceList
        evidence={evidence}
        loading={evidenceLoading}
        error={evidenceError}
        onRetry={() => { void loadEvidence(); }}
        onOpenRun={onOpenRun}
      />}
    </div>
    {suggestion.status === 'pending' && <>
      <label className="mt-3 flex items-start gap-2 text-xs leading-5 ui-text-soft">
        <input type="checkbox" checked={confirmGlobal} disabled={busy} onChange={event => onConfirmGlobalChange(event.target.checked)} className="mt-1" />
        明确将此偏好确认为全局默认
      </label>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" disabled={busy} onClick={() => onAction('reject')} className="ui-button-ghost rounded-lg px-3 py-2 text-xs disabled:opacity-50">拒绝</button>
        <button type="button" disabled={busy} onClick={() => onAction('confirm')} className="ui-button-primary rounded-lg px-3 py-2 text-xs disabled:opacity-50">{busy ? '处理中…' : '确认偏好'}</button>
      </div>
    </>}
    {suggestion.status === 'confirmed' && <div className="mt-3 flex justify-end"><button type="button" disabled={busy} onClick={() => onAction('revoke')} className="ui-button-ghost rounded-lg border ui-border px-3 py-2 text-xs disabled:opacity-50">撤销确认</button></div>}
  </article>;
}

export function MemoryPreferenceManagement({ workspaceId, onOpenRun }: MemoryPreferenceManagementProps) {
  const { request } = useApi();
  const [suggestions, setSuggestions] = useState<PreferenceSuggestionDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);
  const [busyId, setBusyId] = useState<string>();
  const [globalChoices, setGlobalChoices] = useState<Record<string, boolean>>({});
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [notice, setNotice] = useState('');
  const activeWorkspaceId = useRef(workspaceId);
  const workspaceGeneration = useRef(0);
  activeWorkspaceId.current = workspaceId;

  const reload = useCallback(() => setReloadToken(value => value + 1), []);

  useEffect(() => {
    const generation = ++workspaceGeneration.current;
    setLoading(true);
    setError('');
    setStale(false);
    setNotice('');
    setSuggestions([]);
    void request<{ suggestions: PreferenceSuggestionDto[] }>(preferenceSuggestionsPath(workspaceId))
      .then(result => {
        if (workspaceResponseIsCurrent(workspaceId, activeWorkspaceId.current, generation, workspaceGeneration.current)) {
          setSuggestions(result.suggestions);
        }
      })
      .catch(loadError => {
        if (workspaceResponseIsCurrent(workspaceId, activeWorkspaceId.current, generation, workspaceGeneration.current)) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      })
      .finally(() => {
        if (workspaceResponseIsCurrent(workspaceId, activeWorkspaceId.current, generation, workspaceGeneration.current)) setLoading(false);
      });
    return () => {
      if (workspaceGeneration.current === generation) workspaceGeneration.current += 1;
    };
  }, [reloadToken, request, workspaceId]);

  const applyAction = async (suggestion: PreferenceSuggestionDto, action: PreferenceSuggestionAction) => {
    if (busyId) return;
    const generation = workspaceGeneration.current;
    setBusyId(suggestion.id);
    setError('');
    setStale(false);
    setNotice('');
    try {
      const result = await request<{ suggestion: PreferenceSuggestionDto; entry?: { id: string } }>(
        preferenceSuggestionActionPath(suggestion.projectionId, action),
        {
          method: 'POST',
          body: preferenceSuggestionActionPayload(suggestion, workspaceId, action, globalChoices[suggestion.id] === true),
        },
      );
      if (!workspaceResponseIsCurrent(workspaceId, activeWorkspaceId.current, generation, workspaceGeneration.current)) return;
      setSuggestions(current => current.map(item => item.id === suggestion.id ? result.suggestion : item));
      setGlobalChoices(current => ({ ...current, [suggestion.id]: false }));
      setNotice(action === 'confirm'
        ? `偏好已确认${result.entry ? '，并关联了正式记忆。' : '。'}当前对话中的明确指令始终优先。`
        : action === 'reject' ? '偏好建议已拒绝。' : '偏好确认已撤销。');
    } catch (actionError) {
      if (!workspaceResponseIsCurrent(workspaceId, activeWorkspaceId.current, generation, workspaceGeneration.current)) return;
      const message = actionError instanceof Error ? actionError.message : String(actionError);
      setError([message, memoryVersionConflictGuidance(actionError)].filter(Boolean).join(' '));
      setStale(isMemoryVersionConflict(actionError));
    } finally {
      if (workspaceResponseIsCurrent(workspaceId, activeWorkspaceId.current, generation, workspaceGeneration.current)) setBusyId(undefined);
    }
  };

  return <section aria-label="偏好建议管理" className="min-h-0 min-w-0 flex-1 overflow-y-auto" data-agentos="memory-preference-management">
    <header className="mb-4">
      <div className="text-[11px] tracking-[0.14em] ui-dim">LEARNED DEFAULTS</div>
      <h3 className="mt-1 text-lg font-semibold ui-text">偏好建议</h3>
      <p className="mt-2 text-xs leading-5 ui-dim">从使用中学习到的默认偏好会先等待确认。全局适用必须明确勾选；确认后的默认偏好仍低于你当前对话中的明确指令。</p>
    </header>
    {notice && <p role="status" className="mb-3 rounded-lg border ui-border p-3 text-xs ui-accent">{notice}</p>}
    {error && <div role="alert" className="mb-3 rounded-lg border border-[var(--app-danger)]/30 p-3 text-xs text-[var(--app-danger)]"><p>{error}</p><button type="button" onClick={reload} className="ui-button-ghost mt-2 rounded-lg border ui-border px-3 py-2">{stale ? '重新加载最新版本' : '重试'}</button></div>}
    {loading ? <p role="status" className="p-3 text-sm ui-dim">正在加载偏好建议…</p> : suggestions.length === 0
      ? <p className="rounded-xl border border-dashed ui-border p-5 text-sm ui-dim">暂无偏好建议。</p>
      : <div className="space-y-3">{suggestions.map(suggestion => <MemoryPreferenceSuggestionCard
        key={suggestion.id}
        workspaceId={workspaceId}
        suggestion={suggestion}
        busy={busyId === suggestion.id}
        confirmGlobal={globalChoices[suggestion.id] === true}
        onOpenRun={onOpenRun}
        onConfirmGlobalChange={value => setGlobalChoices(current => ({ ...current, [suggestion.id]: value }))}
        onAction={action => { void applyAction(suggestion, action); }}
      />)}</div>}
  </section>;
}
