import { useEffect, useRef, useState } from 'react';
import type { ToastItem } from '@/lib/uiFeedback';

const EXIT_DURATION_MS = 180;

interface ToastStackProps {
  toasts: ToastItem[];
  onDismiss(id: string): void;
}

type ToastTimers = { exitTimer: number; dismissTimer?: number };

export function ToastStack({ toasts, onDismiss }: ToastStackProps) {
  const [exiting, setExiting] = useState<Set<string>>(() => new Set());
  const timersRef = useRef(new Map<string, ToastTimers>());

  useEffect(() => {
    const activeIds = new Set(toasts.map(toast => toast.id));
    for (const [id, timers] of timersRef.current) {
      if (!activeIds.has(id)) {
        window.clearTimeout(timers.exitTimer);
        if (timers.dismissTimer !== undefined) window.clearTimeout(timers.dismissTimer);
        timersRef.current.delete(id);
        setExiting(current => {
          if (!current.has(id)) return current;
          const next = new Set(current);
          next.delete(id);
          return next;
        });
      }
    }

    for (const toast of toasts) {
      if (timersRef.current.has(toast.id)) continue;
      const exitTimer = window.setTimeout(() => {
        setExiting(current => new Set(current).add(toast.id));
        const dismissTimer = window.setTimeout(() => onDismiss(toast.id), EXIT_DURATION_MS);
        const timers = timersRef.current.get(toast.id);
        if (timers) timers.dismissTimer = dismissTimer;
      }, Math.max(0, toast.durationMs - EXIT_DURATION_MS));
      timersRef.current.set(toast.id, { exitTimer });
    }
  }, [onDismiss, toasts]);

  useEffect(() => () => {
    for (const timers of timersRef.current.values()) {
      window.clearTimeout(timers.exitTimer);
      if (timers.dismissTimer !== undefined) window.clearTimeout(timers.dismissTimer);
    }
    timersRef.current.clear();
  }, []);

  if (toasts.length === 0) return null;

  return <div className="pointer-events-none fixed bottom-6 right-6 z-[80] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2" data-toast-stack>
    {toasts.map(toast => <article key={toast.id} role={toast.tone === 'error' ? 'alert' : 'status'} aria-live={toast.tone === 'error' ? 'assertive' : 'polite'} className={`toast-item toast-${toast.tone} pointer-events-auto ${exiting.has(toast.id) ? 'toast-exit' : 'toast-enter'}`}>
      <span className="min-w-0 flex-1">{toast.message}</span>
      <button type="button" aria-label="关闭通知" onClick={() => onDismiss(toast.id)} className="toast-dismiss shrink-0">×</button>
    </article>)}
  </div>;
}
