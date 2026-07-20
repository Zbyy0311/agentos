'use client';

export function DiffBlock({ content }: { content: string }) {
  return <pre className="overflow-x-auto rounded-xl border ui-border bg-[var(--app-bg)] p-3 font-mono text-xs leading-5" aria-label="代码差异">
    {content.split('\n').map((line, index) => <span key={`${index}-${line}`} className={`block ${line.startsWith('+') && !line.startsWith('+++') ? 'bg-[color:var(--app-success)]/10 text-[var(--app-success)]' : line.startsWith('-') && !line.startsWith('---') ? 'bg-[color:var(--app-danger)]/10 text-[var(--app-danger)]' : line.startsWith('@@') ? 'text-[var(--app-accent)]' : 'ui-text-soft'}`}>{line || ' '}</span>)}
  </pre>;
}

