import type { ReactNode } from 'react';
import React from 'react';

export type StatusNoticeTone = 'info' | 'waiting' | 'success' | 'warning' | 'error';

export interface StatusNoticeProps {
  readonly tone: StatusNoticeTone;
  readonly children: ReactNode;
  readonly title?: string;
  readonly action?: ReactNode;
  readonly className?: string;
}

const toneClass: Record<StatusNoticeTone, string> = {
  info: 'border-[color:var(--app-info)]/35 bg-[color:var(--app-info)]/10',
  waiting: 'border-[color:var(--app-accent)]/35 bg-[var(--app-accent-soft)]',
  success: 'border-[color:var(--app-success)]/35 bg-[color:var(--app-success)]/10',
  warning: 'border-[color:var(--app-warning)]/40 bg-[color:var(--app-warning)]/10',
  error: 'ui-error',
};

export function StatusNotice({ tone, children, title, action, className = '' }: StatusNoticeProps) {
  const role = tone === 'error' ? 'alert' : 'status';
  return (
    <div role={role} className={`rounded-xl border px-4 py-3 text-sm ui-text-soft ${toneClass[tone]} ${className}`.trim()}>
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className={`mt-1 h-2 w-2 shrink-0 rounded-full ${tone === 'error' ? 'bg-[var(--app-danger)]' : tone === 'success' ? 'bg-[var(--app-success)]' : tone === 'warning' ? 'bg-[var(--app-warning)]' : 'bg-[var(--app-accent)]'}`} />
        <div className="min-w-0 flex-1">
          {title ? <div className="mb-1 text-xs font-semibold ui-text">{title}</div> : null}
          <div className="break-words">{children}</div>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
    </div>
  );
}
