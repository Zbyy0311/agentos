'use client';

import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import type { WorkspaceLayoutPanel } from '@/lib/workspaceLayout';

const PANEL_LABELS: Record<WorkspaceLayoutPanel, string> = {
  workspace: 'Agent 导航',
  history: '会话列表',
  inspector: '执行状态',
};

export function WorkspacePanelOverlay({ panel, children, onClose }: { panel: WorkspaceLayoutPanel; children: ReactNode; onClose(): void }) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return <div className={`workspace-panel-overlay workspace-panel-overlay-${panel}`} role="presentation">
    <button type="button" className="workspace-panel-overlay-backdrop" aria-label={`关闭${PANEL_LABELS[panel]}`} onClick={onClose} />
    <section className="workspace-panel-overlay-panel" role="dialog" aria-modal="true" aria-label={PANEL_LABELS[panel]}>
      <div className="workspace-panel-overlay-header">
        <span>{PANEL_LABELS[panel]}</span>
        <button ref={closeButtonRef} type="button" className="ui-button-ghost rounded-lg px-2 py-1 text-xs" onClick={onClose}>关闭</button>
      </div>
      <div className="workspace-panel-overlay-content">{children}</div>
    </section>
  </div>;
}
