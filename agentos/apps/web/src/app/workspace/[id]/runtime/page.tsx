'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { DirectConversationWorkbench } from '@/components/chat/DirectConversationWorkbench';
import { RunInspectorPanel } from '@/components/chat/RunInspectorPanel';
import { useDirectConversation } from '@/lib/useDirectConversation';
import { useApi } from '@/lib/useApi';
import { resolveLayoutMode } from '@/lib/uiFoundation';
import type { UiTheme } from '@/lib/uiFoundation';

/**
 * Direct Conversation UX page (forward Conversation runtime).
 *
 * Composes the four-column workbench (Agents / Conversations / Canvas / Inspector)
 * over the forward runtime. This is an additive route; the legacy workspace page is
 * untouched (COMPATIBILITY).
 */
export default function DirectConversationPage() {
  const params = useParams();
  const workspaceId = typeof params.id === 'string' ? params.id : '';
  const { API_BASE } = useApi();
  const state = useDirectConversation(workspaceId, API_BASE);
  const [viewportWidth, setViewportWidth] = useState(1600);

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const active = state.conversations.find(c => c.id === state.activeConversationId);
  const theme: UiTheme = 'dark';
  const runIds = [...new Set(state.messages.flatMap(message => message.runId ? [message.runId] : []))].reverse();

  return (
    <DirectConversationWorkbench
      theme={theme}
      inspector={<RunInspectorPanel key={state.activeConversationId ?? workspaceId} workspaceId={workspaceId}
        apiBase={API_BASE} runIds={runIds} theme={theme} />}
      viewportWidth={viewportWidth}
      workspaceName={workspaceId}
      agents={state.agents}
      conversations={state.conversations}
      activeConversationId={state.activeConversationId}
      activeConversationTitle={active?.title ?? 'Conversation'}
      activeConversationKind={active?.kind ?? 'direct'}
      messages={state.messages}
      stream={state.stream}
      composerMode={state.mode}
      composerContent={state.content}
      sending={state.sending}
      {...(state.error === undefined ? {} : { error: state.error })}
      onSelectConversation={state.selectConversation}
      onCreateConversation={() => {}}
      onModeChange={state.setMode}
      onContentChange={state.setContent}
      onSend={() => { void state.send(); }}
    />
  );
}
