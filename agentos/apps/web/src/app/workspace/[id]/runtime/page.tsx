'use client';

import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Compatibility entry for old Runtime links. Runtime now lives in the regular
 * workspace shell; the query is preserved so the unified page can select the
 * same conversation, view and Run without starting another execution.
 */
export default function RuntimeCompatibilityPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const workspaceId = typeof params.id === 'string' ? params.id : '';

  useEffect(() => {
    if (!workspaceId) return;
    const query = new URLSearchParams(searchParams.toString());
    // A collaboration ID does not establish the conversation's storage source.
    // Preserve an explicit legacy source; otherwise restore via the runtime
    // adapter, which the destination page validates before selection.
    query.set('conversationSource', query.get('conversationSource') === 'workspace' ? 'workspace' : 'runtime');
    query.set('view', query.get('runId') || query.get('collaborationId') ? 'execution' : 'chat');
    if (query.get('runId')) {
      const requestedRunSource = query.get('runSource');
      query.set('runSource', requestedRunSource === 'workspace' || requestedRunSource === 'canonical'
        ? requestedRunSource
        : query.get('collaborationId') ? 'canonical' : 'workspace');
    }
    router.replace(`/workspace/${encodeURIComponent(workspaceId)}?${query.toString()}`);
  }, [router, searchParams, workspaceId]);

  return <div className="app-shell grid h-screen place-items-center text-sm ui-muted">正在打开统一工作台…</div>;
}
