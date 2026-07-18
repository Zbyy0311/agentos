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

function CodeBlock({ inline, className, children, ...props }: ComponentPropsWithoutRef<'code'> & { inline?: boolean }) {
  const language = /language-(\w+)/.exec(className ?? '')?.[1];
  const value = String(children).replace(/\n$/, '');
  if (inline) return <code className="rounded bg-[var(--app-bg)] px-1 py-0.5 font-mono text-[0.9em] ui-text" {...props}>{children}</code>;
  if (language === 'diff' || language === 'patch') return <DiffBlock content={value} />;
  return <SyntaxHighlighter language={language} PreTag="div" customStyle={{ margin: 0, borderRadius: '0.75rem', padding: '0.75rem', fontSize: '0.78rem', lineHeight: 1.55, background: 'var(--app-bg)' }}>{value}</SyntaxHighlighter>;
}

export function MarkdownMessage({ content, apiBase = '' }: MarkdownMessageProps) {
  return <div className="markdown-message space-y-2">
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code: CodeBlock,
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
