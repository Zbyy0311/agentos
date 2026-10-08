'use client';

import type { ComponentPropsWithoutRef } from 'react';
import React from 'react';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import remarkGfm from 'remark-gfm';
import { DiffBlock } from './DiffBlock';

interface MarkdownMessageProps {
  content: string;
  apiBase?: string;
}

// react-markdown 9.x does not consistently expose the legacy `inline` prop.
// Keep the distinction at the Markdown tree boundary so inline code never
// falls through to the block renderer (which would put a <div> inside <p>).
const CodeBlockContext = React.createContext(false);

function isSafeUrl(value: string): boolean {
  if (value.startsWith('/') || value.startsWith('#')) return true;
  try {
    const url = new URL(value, 'http://agentos.local');
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isSameOriginArtifact(value: string, apiBase: string): boolean {
  try {
    const url = new URL(value, apiBase || 'http://agentos.local');
    const base = new URL(apiBase || 'http://agentos.local');
    return url.origin === base.origin && url.pathname.includes('/api/workspaces/') && url.pathname.includes('/artifacts/');
  } catch {
    return false;
  }
}

function CodeBlock({ inline, className, children, node: _node, ...props }: ComponentPropsWithoutRef<'code'> & { inline?: boolean; node?: unknown }) {
  const insidePre = React.useContext(CodeBlockContext);
  const isInline = inline ?? !insidePre;
  const language = /language-(\w+)/.exec(className ?? '')?.[1];
  const value = String(children).replace(/\n$/, '');
  if (isInline) return <code className="rounded bg-[var(--app-bg)] px-1 py-0.5 font-mono text-[0.9em] ui-text" {...props}>{children}</code>;
  if (language === 'diff' || language === 'patch') return <DiffBlock content={value} />;
  return <CodeBlockSurface language={language} value={value} />;
}

function CodeBlockSurface({ language, value }: { language?: string; value: string }) {
  const [wrapped, setWrapped] = React.useState(false);
  return <div className="markdown-code-block max-w-full overflow-hidden rounded-xl border ui-border">
    <div className="flex items-center justify-between border-b ui-border px-3 py-1.5 text-[10px] ui-dim">
      <span>{language ?? 'code'}</span>
      <button type="button" aria-pressed={wrapped} aria-label={wrapped ? '关闭代码换行' : '开启代码换行'} onClick={() => setWrapped(current => !current)} className="ui-button-ghost rounded px-1.5 py-0.5">{wrapped ? '滚动' : '换行'}</button>
    </div>
    <SyntaxHighlighter language={language} PreTag="div" wrapLongLines={wrapped} customStyle={{ margin: 0, borderRadius: 0, padding: '0.75rem', fontSize: '0.78rem', lineHeight: 1.55, background: 'var(--app-bg)', maxWidth: '100%', minWidth: 0, overflowX: wrapped ? 'hidden' : 'auto', whiteSpace: wrapped ? 'pre-wrap' : 'pre', overflowWrap: wrapped ? 'anywhere' : 'normal', wordBreak: wrapped ? 'break-word' : 'normal' }}>{value}</SyntaxHighlighter>
  </div>;
}

function MarkdownPre({ children }: { children?: React.ReactNode }) {
  return <CodeBlockContext.Provider value>{children}</CodeBlockContext.Provider>;
}

export function MarkdownMessage({ content, apiBase = '' }: MarkdownMessageProps) {
  return <div className="markdown-message space-y-2">
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code: CodeBlock,
        pre: MarkdownPre,
        a: ({ href, children, ...props }) => {
          const safeHref = href && isSafeUrl(href) ? href : undefined;
          return safeHref ? <a href={safeHref} target="_blank" rel="noreferrer noopener" {...props}>{children}</a> : <span {...props}>{children}</span>;
        },
        img: ({ src, alt, ...props }) => {
          if (!src || !isSameOriginArtifact(src, apiBase)) return <span className="ui-dim">[外部图片已隐藏]</span>;
          return <img src={src} alt={alt ?? ''} loading="lazy" className="max-h-80 max-w-full rounded-xl border ui-border object-contain" {...props} />;
        },
        table: ({ children }) => <div className="overflow-x-auto"><table className="min-w-full border-collapse text-xs">{children}</table></div>,
      }}
    >{content}</ReactMarkdown>
  </div>;
}
