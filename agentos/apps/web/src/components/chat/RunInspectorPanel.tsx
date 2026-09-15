'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RuntimeInspectorView, type InspectorProjectionDto } from './RuntimeInspectorView';
import type { UiTheme } from '../../lib/uiFoundation';
import {
  buildRunInspectorUrl,
  createInspectorIdempotencyKey,
  runtimeInspectorClient,
} from '../../lib/runtimeInspectorClient';

const CANCELLABLE_OPERATION_STATUSES = new Set(['queued', 'running', 'waiting_approval', 'paused']);

export function RunInspectorPanel(props: {
  readonly workspaceId: string;
  readonly apiBase: string;
  readonly runIds: readonly string[];
  readonly theme: UiTheme;
}) {
  const [selected, setSelected] = useState('');
  const [createdRunIds, setCreatedRunIds] = useState<string[]>([]);
  const [revision, setRevision] = useState(0);
  const runIds = [...new Set([...props.runIds, ...createdRunIds])];
  const runId = runIds.includes(selected) ? selected : runIds[0] ?? '';
  const refresh = () => setRevision(value => value + 1);
  const controlStyle = { backgroundColor: 'var(--surface-elevated)', color: 'var(--text-primary)',
    border: '1px solid var(--border-subtle)', borderRadius: 4, padding: '4px 6px', maxWidth: '100%' };

  return (
    <section aria-label="Run Inspector" style={{ padding: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <label style={{ minWidth: 0, flex: 1 }}>Run <select style={controlStyle} aria-label="Inspect Run" value={runId} onChange={event => setSelected(event.target.value)}>
          {runIds.map(id => <option key={id} value={id}>{id}</option>)}
        </select></label>
        <button style={controlStyle} type="button" disabled={!runId} onClick={refresh}>Refresh</button>
      </div>
      {runId ? <InspectorRequest
        key={`${props.workspaceId}:${runId}:${revision}`}
        workspaceId={props.workspaceId}
        runId={runId}
        apiBase={props.apiBase}
        theme={props.theme}
        onChanged={refresh}
        onRunCreated={id => {
          setCreatedRunIds(previous => previous.includes(id) ? previous : [id, ...previous]);
          setSelected(id);
        }}
      /> : <p>No linked Run in this conversation.</p>}
    </section>
  );
}

export { buildRunInspectorUrl } from '../../lib/runtimeInspectorClient';

function InspectorRequest(props: {
  readonly workspaceId: string;
  readonly runId: string;
  readonly apiBase: string;
  readonly theme: UiTheme;
  readonly onChanged: () => void;
  readonly onRunCreated: (runId: string) => void;
}) {
  const client = useMemo(
    () => runtimeInspectorClient({ workspaceId: props.workspaceId, apiBase: props.apiBase }),
    [props.apiBase, props.workspaceId],
  );
  const [projection, setProjection] = useState<InspectorProjectionDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const [actionPending, setActionPending] = useState(false);
  const idempotencyKeys = useRef(new Map<string, string>());

  useEffect(() => {
    const controller = new AbortController();
    setProjection(null);
    setError(null);
    void client.inspectRun(props.runId, controller.signal).then(next => {
      if (!controller.signal.aborted) setProjection(next);
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Inspector unavailable');
    });
    return () => controller.abort();
  }, [client, props.runId]);

  const operation = projection?.operations?.find(item => (
    item.type === 'run.start' && CANCELLABLE_OPERATION_STATUSES.has(item.status)
  ));
  const canCancelQueuedRun = projection?.overview.status === 'queued'
    && typeof projection.overview.version === 'number';
  const retryAlreadyAccepted = projection?.operations?.some(item => (
    item.type === 'run.retry'
      && (item.status === 'completed' || CANCELLABLE_OPERATION_STATUSES.has(item.status))
  )) ?? false;
  const canRetry = projection?.overview.status === 'failed'
    && typeof projection.overview.version === 'number'
    && !retryAlreadyAccepted;

  const actionKey = useCallback((action: 'cancel' | 'retry') => {
    const key = `${action}:${props.runId}`;
    const existing = idempotencyKeys.current.get(key);
    if (existing !== undefined) return existing;
    const created = createInspectorIdempotencyKey(action);
    idempotencyKeys.current.set(key, created);
    return created;
  }, [props.runId]);

  const runAction = useCallback(async (action: 'cancel' | 'retry') => {
    if (projection === null || typeof projection.overview.version !== 'number') return;
    setActionPending(true);
    setActionError(undefined);
    try {
      if (action === 'cancel') {
        if (operation !== undefined) {
          await client.cancelOperation(operation.operationId, operation.version);
        } else if (canCancelQueuedRun) {
          await client.cancelQueuedRun(props.runId, projection.overview.version, actionKey('cancel'));
        } else {
          return;
        }
        props.onChanged();
        return;
      }

      if (!canRetry) return;
      const result = await client.retryRun(props.runId, projection.overview.version, actionKey('retry'));
      const childRunId = result.run?.id;
      if (typeof childRunId === 'string' && childRunId.length > 0) props.onRunCreated(childRunId);
      props.onChanged();
    } catch (cause: unknown) {
      setActionError(cause instanceof Error ? cause.message : 'Inspector action failed');
    } finally {
      setActionPending(false);
    }
  }, [actionKey, canCancelQueuedRun, canRetry, client, operation, projection, props]);

  if (error) return <p role="alert">{error}</p>;
  if (!projection) return <p role="status">Loading Inspector…</p>;
  return (
    <RuntimeInspectorView
      theme={props.theme}
      projection={projection}
      {...(operation !== undefined || canCancelQueuedRun ? { onCancel: () => { void runAction('cancel'); } } : {})}
      {...(canRetry ? { onRetry: () => { void runAction('retry'); } } : {})}
      actionPending={actionPending}
      {...(actionError === undefined ? {} : { actionError })}
    />
  );
}
