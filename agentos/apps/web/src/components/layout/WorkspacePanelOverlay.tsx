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
  const panelRef = useRef<HTMLElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    const focusableSelector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const backgroundNodes = overlayRef.current?.parentElement
      ? Array.from(overlayRef.current.parentElement.children).filter(node => node !== overlayRef.current) as HTMLElement[]
      : [];
    const priorInert = backgroundNodes.map(node => node.inert);
    backgroundNodes.forEach(node => { node.inert = true; });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? []).filter(element => element.offsetParent !== null);
      if (focusable.length === 0) {
        event.preventDefault();
        closeButtonRef.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      backgroundNodes.forEach((node, index) => { node.inert = priorInert[index]; });
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [onClose]);

  return <div ref={overlayRef} className={`workspace-panel-overlay workspace-panel-overlay-${panel}`} role="presentation">
    <button type="button" className="workspace-panel-overlay-backdrop" aria-label={`关闭${PANEL_LABELS[panel]}`} onClick={onClose} />
    <section ref={panelRef} className="workspace-panel-overlay-panel" role="dialog" aria-modal="true" aria-label={PANEL_LABELS[panel]}>
      <div className="workspace-panel-overlay-header">
        <span>{PANEL_LABELS[panel]}</span>
        <button ref={closeButtonRef} type="button" className="ui-button-ghost rounded-lg px-2 py-1 text-xs" onClick={onClose}>关闭</button>
      </div>
      <div className="workspace-panel-overlay-content">{children}</div>
    </section>
  </div>;
}
