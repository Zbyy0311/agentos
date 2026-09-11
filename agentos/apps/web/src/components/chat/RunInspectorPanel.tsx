'use client';

import { useEffect, useState } from 'react';
import { RuntimeInspectorView, type InspectorProjectionDto } from './RuntimeInspectorView';
import type { UiTheme } from '../../lib/uiFoundation';

export function RunInspectorPanel(props: {
  readonly workspaceId: string;
  readonly apiBase: string;
  readonly runIds: readonly string[];
  readonly theme: UiTheme;
}) {
  const [selected, setSelected] = useState('');
  const runId = props.runIds.includes(selected) ? selected : props.runIds[0] ?? '';
  const [revision, setRevision] = useState(0);
  const controlStyle = { backgroundColor: 'var(--surface-elevated)', color: 'var(--text-primary)',
    border: '1px solid var(--border-subtle)', borderRadius: 4, padding: '4px 6px', maxWidth: '100%' };
  return (
    <section aria-label="Run Inspector" style={{ padding: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <label style={{ minWidth: 0, flex: 1 }}>Run <select style={controlStyle} aria-label="Inspect Run" value={runId} onChange={event => setSelected(event.target.value)}>
        {props.runIds.map(id => <option key={id} value={id}>{id}</option>)}
      </select></label>
      <button style={controlStyle} type="button" disabled={!runId} onClick={() => setRevision(value => value + 1)}>Refresh</button>
      </div>
      {runId ? <InspectorRequest key={`${props.workspaceId}:${runId}:${revision}`}
        workspaceId={props.workspaceId} runId={runId} apiBase={props.apiBase} theme={props.theme} />
        : <p>No linked Run in this conversation.</p>}
    </section>
  );
}

function InspectorRequest(props: { workspaceId: string; runId: string; apiBase: string; theme: UiTheme }) {
  const [projection, setProjection] = useState<InspectorProjectionDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const url = `${props.apiBase}/api/workspaces/${encodeURIComponent(props.workspaceId)}/runs/${encodeURIComponent(props.runId)}/inspector`;
    void fetch(url, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error(`Inspector unavailable (${response.status})`);
      const body = await response.json() as { projection: InspectorProjectionDto };
      if (!controller.signal.aborted) setProjection(body.projection);
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Inspector unavailable');
    });
    return () => controller.abort();
  }, [props.apiBase, props.workspaceId, props.runId]);
  if (error) return <p role="alert">{error}</p>;
  if (!projection) return <p role="status">Loading Inspector…</p>;
  return <RuntimeInspectorView theme={props.theme} projection={projection} />;
}
