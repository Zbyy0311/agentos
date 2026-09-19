'use client';

import { useState } from 'react';

export function DiffBlock({ content }: { content: string }) {
  const [wrapped, setWrapped] = useState(false);
  return <div className="markdown-code-block max-w-full overflow-hidden rounded-xl border ui-border">
    <div className="flex items-center justify-between border-b ui-border px-3 py-1.5 text-[10px] ui-dim"><span>diff</span><button type="button" aria-pressed={wrapped} aria-label={wrapped ? '关闭代码换行' : '开启代码换行'} onClick={() => setWrapped(current => !current)} className="ui-button-ghost rounded px-1.5 py-0.5">{wrapped ? '滚动' : '换行'}</button></div>
    <pre className={`${wrapped ? 'whitespace-pre-wrap break-words' : 'overflow-x-auto whitespace-pre'} bg-[var(--app-bg)] p-3 font-mono text-xs leading-5`} aria-label="代码差异">
      {content.split('\n').map((line, index) => <span key={`${index}-${line}`} className={`block ${line.startsWith('+') && !line.startsWith('+++') ? 'bg-[color:var(--app-success)]/10 text-[var(--app-success)]' : line.startsWith('-') && !line.startsWith('---') ? 'bg-[color:var(--app-danger)]/10 text-[var(--app-danger)]' : line.startsWith('@@') ? 'text-[var(--app-accent)]' : 'ui-text-soft'}`}>{line || ' '}</span>)}
    </pre>
  </div>;
}
