'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  listRuntimeApprovals,
  resolveRuntimeApproval,
  type RuntimeApprovalDecision,
  type RuntimeApprovalRequest,
} from '@/lib/runtimeApprovals';

interface RuntimeApprovalPanelProps {
  readonly apiBase: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly onResolved?: () => void;
}

interface RuntimeApprovalCardProps {
  readonly request: RuntimeApprovalRequest;
  readonly busy: boolean;
  readonly onDecision: (decision: RuntimeApprovalDecision) => void;
}

const POLL_INTERVAL_MS = 5_000;
const UI_ACTOR = 'workspace-ui';

export function RuntimeApprovalPanel(props: RuntimeApprovalPanelProps) {
  const [requests, setRequests] = useState<RuntimeApprovalRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState<string>();

  const load = useCallback(async (signal: AbortSignal, disposed: () => boolean) => {
    try {
      const result = await listRuntimeApprovals(props.apiBase, props.workspaceId, signal);
      if (disposed()) return;
      setRequests(result.requests.filter(request => request.runId === props.runId && request.status === 'pending'));
      setError(undefined);
    } catch (loadError) {
      if (disposed() || (loadError instanceof DOMException && loadError.name === 'AbortError')) return;
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      if (!disposed()) setLoading(false);
    }
  }, [props.apiBase, props.runId, props.workspaceId]);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    const isDisposed = () => disposed;
    const refresh = () => { void load(controller.signal, isDisposed); };
    refresh();
    const timer = window.setInterval(refresh, POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [load]);

  const decide = async (request: RuntimeApprovalRequest, decision: RuntimeApprovalDecision) => {
    setBusyId(request.id);
    setError(undefined);
    try {
      await resolveRuntimeApproval(props.apiBase, props.workspaceId, request.id, {
        expectedVersion: request.version,
        decision,
        decidedBy: UI_ACTOR,
      });
      setRequests(current => current.filter(item => item.id !== request.id));
      props.onResolved?.();
    } catch (decisionError) {
      setError(decisionError instanceof Error ? decisionError.message : String(decisionError));
    } finally {
      setBusyId(undefined);
    }
  };

  if (loading || (requests.length === 0 && error === undefined)) return null;

  return (
    <section data-agentos="runtime-approval" aria-label="运行时审批" className="mt-5 border-t ui-border pt-5">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="signal-section-label">需要审批</h3>
        <span className="text-[11px] ui-dim">Run {props.runId}</span>
      </div>
      {error ? <div role="alert" className="mb-3 rounded-lg border border-[var(--app-danger)]/30 p-3 text-xs text-[var(--app-danger)]">{error}</div> : null}
      {requests.map(request => (
        <RuntimeApprovalCard
          key={request.id}
          request={request}
          busy={busyId === request.id}
          onDecision={decision => { void decide(request, decision); }}
        />
      ))}
    </section>
  );
}

export function RuntimeApprovalCard({ request, busy, onDecision }: RuntimeApprovalCardProps) {
  return (
    <article className="rounded-xl border border-[var(--app-warning)]/40 bg-[var(--app-surface-raised)] p-3">
      <div className="text-xs font-semibold ui-text">{request.title}</div>
      <p className="mt-2 text-xs leading-5 ui-text-soft">{request.description}</p>
      <dl className="mt-3 space-y-1 text-[10px] ui-dim">
        <div><dt className="inline">动作指纹：</dt><dd className="inline break-all font-mono">{request.actionFingerprint}</dd></div>
        <div><dt className="inline">策略：</dt><dd className="inline">{request.policyVersion} · 截止 {formatExpiry(request.expiresAt)}</dd></div>
      </dl>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" disabled={busy} onClick={() => onDecision('reject')} className="ui-button-ghost rounded-lg px-3 py-2 text-xs disabled:opacity-50">拒绝执行</button>
        <button type="button" disabled={busy} onClick={() => onDecision('approve_once')} className="ui-button-primary rounded-lg px-3 py-2 text-xs disabled:opacity-50">批准本次执行</button>
      </div>
    </article>
  );
}

function formatExpiry(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN');
}
