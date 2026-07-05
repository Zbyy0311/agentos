import { useState } from 'react';
import { useStore } from '../stores/useStore';
import { AGENT_COLORS } from '../types';
import { format } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { ChevronDown, ChevronUp, MessageSquare } from 'lucide-react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

export default function ConversationTimeline() {
  const messages = useStore((s) => s.messages);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const toggle = (id: number) => {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpanded(next);
  };

  const renderContent = (content: string, id: number) => {
    const codeBlock = content.match(/```(\w+)?\n([\s\S]*?)```/);
    if (codeBlock) {
      const lang = codeBlock[1] || 'text';
      const code = codeBlock[2];
      const preview = code.split('\n').slice(0, 4).join('\n');
      const isExpanded = expanded.has(id);
      return (
        <div className="mt-2">
          <SyntaxHighlighter language={lang} style={oneDark} className="rounded text-xs">
            {isExpanded ? code : preview + (code.split('\n').length > 4 ? '\n...' : '')}
          </SyntaxHighlighter>
          {code.split('\n').length > 4 && (
            <button
              onClick={() => toggle(id)}
              className="text-xs text-indigo-600 mt-1 flex items-center gap-1"
            >
              {isExpanded ? <><ChevronUp className="w-3 h-3" /> 收起</> : <><ChevronDown className="w-3 h-3" /> 展开</>}
            </button>
          )}
        </div>
      );
    }
    return <p className="text-sm text-slate-700 mt-1 whitespace-pre-wrap">{highlightMentions(content)}</p>;
  };

  const highlightMentions = (text: string) => {
    const parts = text.split(/(@\w+)/g);
    return parts.map((part, i) =>
      /^@\w+/.test(part) ? (
        <span key={i} className="text-indigo-600 font-medium bg-indigo-50 px-1 rounded">{part}</span>
      ) : (
        part
      )
    );
  };

  return (
    <div className="bg-white rounded-xl shadow p-4">
      <div className="flex items-center gap-2 mb-3">
        <MessageSquare className="w-4 h-4 text-slate-500" />
        <h2 className="text-sm font-semibold text-slate-700">对话流时间线</h2>
      </div>
      <div className="space-y-3 max-h-[420px] overflow-y-auto pr-1">
        {messages.length === 0 && (
          <p className="text-sm text-slate-400">暂无消息</p>
        )}
        {messages.map((msg) => {
          const color = AGENT_COLORS[msg.agent_name || ''] || 'bg-slate-400';
          return (
            <div key={msg.id} className="flex gap-3">
              <div className={`w-2 h-2 mt-2 rounded-full shrink-0 ${color}`} />
              <div className="flex-1 border-l-2 pl-3 pb-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold">{msg.agent_name || '系统'}</span>
                  <span className="text-[10px] text-slate-400">
                    {format(new Date(msg.created_at), 'HH:mm:ss', { locale: zhCN })}
                  </span>
                  <span className="text-[10px] px-1.5 py-0.5 bg-slate-100 rounded text-slate-500">
                    {msg.action}
                  </span>
                </div>
                {renderContent(msg.content, msg.id)}
                {msg.deliverables.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {msg.deliverables.map((d) => (
                      <span key={d} className="text-[10px] px-2 py-0.5 bg-emerald-50 text-emerald-700 rounded">
                        {d}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
