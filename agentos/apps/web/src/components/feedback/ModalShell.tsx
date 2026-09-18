'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';
import React from 'react';

export interface ModalShellProps {
  readonly title: string;
  readonly eyebrow?: string;
  readonly description?: string;
  readonly headerActions?: ReactNode;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly onClose: () => void;
  readonly closeOnOverlay?: boolean;
  readonly size?: 'sm' | 'md' | 'lg';
}

const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Shared modal frame for all workspace forms. The body is the only scrolling
 * region; header and footer stay opaque and sticky so a long form never leaks
 * a partially visible row underneath the actions.
 */
export function ModalShell({
  title,
  eyebrow,
  description,
  headerActions,
  children,
  footer,
  onClose,
  closeOnOverlay = true,
  size = 'md',
}: ModalShellProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const previousActive = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const dialog = dialogRef.current;
    const firstFocusable = dialog?.querySelector<HTMLElement>('[autofocus], ' + FOCUSABLE);
    firstFocusable?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(item => item.offsetParent !== null);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
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

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      previousActive?.focus();
    };
  }, []);

  const widthClass = size === 'sm' ? 'max-w-md' : size === 'lg' ? 'max-w-3xl' : 'max-w-xl';

  return (
    <div
      className="modal-shell fixed inset-0 z-50 flex items-center justify-center bg-[var(--app-overlay)] p-3 backdrop-blur-sm sm:p-6"
      onMouseDown={event => {
        if (closeOnOverlay && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        {...(description ? { 'aria-describedby': descriptionId } : {})}
        tabIndex={-1}
        className={`modal-shell-dialog ui-panel-raised flex max-h-[min(92vh,56rem)] w-full ${widthClass} min-w-0 flex-col overflow-hidden rounded-2xl border shadow-[var(--app-shadow)]`}
      >
        <header className="modal-shell-header flex shrink-0 items-start justify-between gap-4 border-b ui-border bg-[var(--app-surface-raised)] px-5 py-4 sm:px-6">
          <div className="min-w-0">
            {eyebrow ? <p className="text-xs font-medium tracking-[0.16em] ui-accent">{eyebrow}</p> : null}
            <h2 id={titleId} className={`${eyebrow ? 'mt-2' : ''} text-lg font-semibold ui-text`}>{title}</h2>
            {description ? <p id={descriptionId} className="mt-1 text-sm leading-5 ui-muted">{description}</p> : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">{headerActions ?? null}<button type="button" onClick={onClose} className="ui-button-ghost rounded-lg px-2 py-1 text-sm" aria-label="关闭弹窗">关闭</button></div>
        </header>
        <div className="modal-shell-body min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5 sm:px-6">
          {children}
        </div>
        {footer ? <footer className="modal-shell-footer shrink-0 border-t ui-border bg-[var(--app-surface-raised)] px-5 py-4 sm:px-6">{footer}</footer> : null}
      </div>
    </div>
  );
}
