'use client';

interface MarkdownBlock {
  type: 'text' | 'code';
  lines: string[];
}

export function MemoryMarkdownPreview({ content }: { content: string }) {
  const blocks = parseMarkdown(content);
  return <div aria-label="Markdown 只读预览" className="space-y-2 rounded-xl border ui-border bg-[var(--app-surface-soft)] p-4 text-sm leading-6 ui-text-soft">
    {blocks.length === 0 ? <p className="ui-dim">暂无正文</p> : blocks.map((block, blockIndex) => block.type === 'code'
      ? <pre key={blockIndex} className="overflow-x-auto rounded-lg border ui-border bg-[var(--app-bg)] px-3 py-2 font-mono text-xs leading-5"><code>{block.lines.join('\n')}</code></pre>
      : block.lines.map((line, lineIndex) => renderMarkdownLine(line, `${blockIndex}-${lineIndex}`)),
    )}
  </div>;
}

function parseMarkdown(content: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let codeLines: string[] | undefined;
  for (const line of content.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      if (codeLines) {
        blocks.push({ type: 'code', lines: codeLines });
        codeLines = undefined;
      } else {
        codeLines = [];
      }
      continue;
    }
    if (codeLines) {
      codeLines.push(line);
      continue;
    }
    const last = blocks.at(-1);
    if (last?.type === 'text') last.lines.push(line);
    else blocks.push({ type: 'text', lines: [line] });
  }
  if (codeLines) blocks.push({ type: 'code', lines: codeLines });
  return blocks;
}

function renderMarkdownLine(line: string, key: string) {
  if (!line.trim()) return <div key={key} className="h-2" />;
  const heading = line.match(/^(#{1,3})\s+(.*)$/);
  if (heading) {
    const level = heading[1].length;
    const className = level === 1 ? 'text-lg font-semibold ui-text' : level === 2 ? 'text-base font-semibold ui-text' : 'text-sm font-semibold ui-text';
    const Heading = level === 1 ? 'h2' : level === 2 ? 'h3' : 'h4';
    return <Heading key={key} className={className}>{heading[2]}</Heading>;
  }
  const numbered = line.match(/^\s*(\d+)\.\s+(.*)$/);
  if (numbered) return <p key={key} className="flex gap-2"><span className="shrink-0 ui-accent">{numbered[1]}.</span><span>{numbered[2]}</span></p>;
  if (/^\s*-\s+/.test(line)) return <p key={key} className="flex gap-2"><span className="ui-accent">•</span><span>{line.replace(/^\s*-\s+/, '')}</span></p>;
  return <p key={key}>{line}</p>;
}
