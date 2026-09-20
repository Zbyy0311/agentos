import { useEffect, useId, useRef } from 'react';
import { uiLayerClass } from '@/lib/uiLayers';

interface ConfirmDialogProps {
  eyebrow?: string;
  title: string;
  description: string;
  targetLabel?: string;
  targetDescription?: string;
  confirmLabel?: string;
  busy?: boolean;
  busyLabel?: string;
  onClose(): void;
  onConfirm(): void;
}

export function ConfirmDialog({
  eyebrow = 'CONFIRM ACTION',
  title,
  description,
  targetLabel,
  targetDescription,
  confirmLabel = '确认',
  busy = false,
  busyLabel = '处理中…',
  onClose,
  onConfirm,
}: ConfirmDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    cancelRef.current?.focus();
    document.body.style.overflow = 'hidden';

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!busy) onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = [cancelRef.current, confirmRef.current].filter((element): element is HTMLButtonElement => element !== null && !element.disabled);
      if (focusable.length === 0) return;
      const currentIndex = focusable.indexOf(document.activeElement as HTMLButtonElement);
      const nextIndex = event.shiftKey
        ? (currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1)
        : (currentIndex === focusable.length - 1 ? 0 : currentIndex + 1);
      event.preventDefault();
      focusable[nextIndex]?.focus();
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [busy, onClose]);

  const handleBackdropMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget && !busy) onClose();
  };

  return <div className={`ui-modal-backdrop fixed inset-0 ${uiLayerClass('confirmation')} flex items-center justify-center p-4 sm:p-6`} onMouseDown={handleBackdropMouseDown}>
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      className="ui-confirm-dialog ui-panel-raised w-full max-w-md overflow-hidden rounded-2xl border shadow-[var(--app-shadow)]"
      onMouseDown={event => event.stopPropagation()}
    >
      <div className="ui-confirm-dialog-accent" aria-hidden="true" />
      <div className="p-5 sm:p-6">
        <div className="flex items-start gap-4">
          <div className="ui-confirm-dialog-icon grid h-11 w-11 shrink-0 place-items-center rounded-2xl" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4m0 4h.01M5.5 19h13a1.5 1.5 0 0 0 1.3-2.25l-6.5-11.26a1.5 1.5 0 0 0-2.6 0L4.2 16.75A1.5 1.5 0 0 0 5.5 19Z" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <p className="signal-section-label ui-confirm-dialog-eyebrow">{eyebrow}</p>
            <h2 id={titleId} className="mt-2 text-lg font-semibold ui-text">{title}</h2>
            <p id={descriptionId} className="mt-2 text-sm leading-6 ui-text-soft">{description}</p>
          </div>
        </div>

        {targetLabel && <div className="ui-confirm-dialog-target mt-5 flex items-start gap-3 rounded-xl border px-3.5 py-3">
          <span className="ui-confirm-dialog-target-dot mt-1.5 h-2 w-2 shrink-0 rounded-full" aria-hidden="true" />
          <div className="min-w-0">
            <p className="break-words text-sm font-medium ui-text">{targetLabel}</p>
            {targetDescription && <p className="mt-1 text-xs leading-5 ui-muted">{targetDescription}</p>}
          </div>
        </div>}

        <div className="mt-6 flex justify-end gap-3">
          <button ref={cancelRef} type="button" disabled={busy} onClick={onClose} className="ui-button-secondary rounded-xl px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60">
            取消
          </button>
          <button ref={confirmRef} type="button" disabled={busy} onClick={onConfirm} className="ui-button-danger inline-flex min-w-20 items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-medium disabled:cursor-not-allowed">
            {busy && <span className="ui-confirm-dialog-spinner h-3.5 w-3.5 rounded-full border-2 border-white/35 border-t-white" aria-hidden="true" />}
            {busy ? busyLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  </div>;
}
