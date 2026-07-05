import { useMemo, useEffect, useRef } from 'react';
import { useStore } from '../stores/useStore';
import { AGENT_COLORS } from '../types';
import { format } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { Users, Bot, MoreVertical, Phone, Info } from 'lucide-react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import ChatInput from './ChatInput';

export default function ChatRoom() {
  const { messages, agents, activeRoom } = useStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const activeAgent = useMemo(() => {
    const id = activeRoom.replace('agent_', '');
    return agents.find(a => String(a.id) === id);
  }, [activeRoom, agents]);

  const roomMessages = useMemo(() => {
    if (activeRoom === 'group') {
      return messages.filter(m => m.room === 'group');
    }
    const agentId = activeRoom.replace('agent_', '');
    const roomKey = `agent_${agentId}`;
    return messages.filter(m => m.room === roomKey);
  }, [messages, activeRoom]);

  const workingAgents = useMemo(() => {
    const working = agents.filter(a => a.status === 'working');
    if (activeRoom === 'group') return working;
    return activeAgent?.status === 'working' ? [activeAgent] : [];
  }, [agents, activeAgent, activeRoom]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [roomMessages.length, workingAgents.length]);

  const renderContent = (content: string) => {
    const parts = content.split(/(```[\s\S]*?```)/g);
    return parts.map((part, i) => {
      if (part.startsWith('```')) {
        const match = part.match(/```(\w+)?\n?([\s\S]*?)```/);
        if (match) {
          return (
            <SyntaxHighlighter
              key={i}
              language={match[1] || 'text'}
              style={oneDark}
              className="rounded-lg text-xs !mt-2 !mb-0"
              customStyle={{ maxHeight: 260, overflow: 'auto' }}
            >
              {match[2].trim()}
            </SyntaxHighlighter>
          );
        }
        return <code key={i} className="text-xs bg-gray-100 rounded px-1">{part}</code>;
      }
      const highlighted = part.split(/(@\S+)/g).map((seg, j) =>
        /^@\S+/.test(seg) ? (
          <span key={j} className="text-indigo-600 font-medium bg-indigo-50 px-1 rounded">{seg}</span>
        ) : (
          seg
        )
      );
      return <span key={i}>{highlighted}</span>;
    });
  };

  const isUser = (name?: string) => name === '用户';

  return (
    <div className="flex flex-col h-full bg-white">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100">
        <div className="flex items-center gap-3">
          {activeRoom === 'group' ? (
            <div className="w-9 h-9 rounded-full bg-indigo-500 flex items-center justify-center">
              <Users className="w-5 h-5 text-white" />
            </div>
          ) : activeAgent ? (
            <div className={`w-9 h-9 rounded-full ${AGENT_COLORS[activeAgent.name] || 'bg-slate-400'} flex items-center justify-center`}>
              <span className="text-white font-bold text-sm">{activeAgent.name[0]}</span>
            </div>
          ) : (
            <div className="w-9 h-9 rounded-full bg-gray-300 flex items-center justify-center">
              <Bot className="w-5 h-5 text-white" />
            </div>
          )}

          <div>
            <div className="text-sm font-bold text-slate-800">
              {activeRoom === 'group' ? '群聊' : activeAgent?.name || '智能体'}
            </div>
            <div className="text-xs" style={{ color: '#34c759' }}>
              {activeRoom === 'group'
                ? `${agents.length} 个智能体在线`
                : activeAgent?.status === 'working' ? '在线' : activeAgent?.status === 'waiting' ? '等待中' : '空闲'}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-4 text-gray-400">
          <Phone className="w-4 h-4 cursor-pointer hover:text-indigo-500 transition-colors" />
          <Info className="w-4 h-4 cursor-pointer hover:text-indigo-500 transition-colors" />
          <MoreVertical className="w-4 h-4 cursor-pointer hover:text-indigo-500 transition-colors" />
        </div>
      </div>

      {/* Messages */}
      <div ref={containerRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-1 bg-[#fafbfc] flex flex-col">
        {roomMessages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-gray-300">
            <Users className="w-12 h-12 mb-3 opacity-30" />
            <p className="text-sm">暂无消息</p>
            <p className="text-xs mt-1">发送第一条消息开始协作</p>
          </div>
        )}

        {roomMessages.map((msg, i) => {
          const user = isUser(msg.agent_name);
          const color = AGENT_COLORS[msg.agent_name || ''] || 'bg-slate-400';
          const showAvatar = i === 0 || roomMessages[i - 1]?.agent_name !== msg.agent_name;
          const isCode = msg.action === 'code';

          return (
            <div
              key={msg.id}
              className={`flex gap-2.5 max-w-[78%] mb-1.5 ${
                user ? 'flex-row-reverse self-end ml-auto' : 'self-start'
              }`}
            >
              {!user && showAvatar && (
                <div
                  className={`w-8 h-8 rounded-full ${color} flex items-center justify-center flex-shrink-0 self-end`}
                  style={{ fontSize: 12, fontWeight: 700, color: '#fff' }}
                >
                  {(msg.agent_name || '?')[0]}
                </div>
              )}
              {!user && !showAvatar && <div className="w-8 flex-shrink-0" />}

              <div>
                {showAvatar && !user && (
                  <div className="text-[10px] text-slate-400 mb-0.5 ml-1">
                    {msg.agent_name}
                    {msg.action && (
                      <span className="ml-1.5 px-1 py-0.5 bg-slate-100 rounded text-slate-500">{msg.action}</span>
                    )}
                  </div>
                )}

                <div
                  className={`px-3 py-2 text-sm leading-relaxed break-words ${
                    user
                      ? 'bg-indigo-500 text-white rounded-2xl rounded-tr-md'
                      : isCode
                        ? 'bg-white border border-gray-200 rounded-2xl rounded-tl-md overflow-hidden'
                        : 'bg-white border border-gray-200 rounded-2xl rounded-tl-md'
                  }`}
                >
                  {renderContent(msg.content)}

                  {msg.deliverables.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {msg.deliverables.map((d) => (
                        <span key={d} className="text-[10px] px-2 py-0.5 bg-emerald-50 text-emerald-700 rounded-full">
                          {d}
                        </span>
                      ))}
                    </div>
                  )}

                  <div className={`text-[9px] mt-1.5 text-right ${user ? 'text-indigo-200' : 'text-slate-400'}`}>
                    {format(new Date(msg.created_at), 'HH:mm', { locale: zhCN })}
                    {msg.target !== 'all' && msg.room === 'group' && (
                      <span className="ml-1">@{msg.target}</span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}

        {/* Typing indicator */}
        {workingAgents.length > 0 && (
          <div className="flex items-center gap-3 self-start mb-2 ml-2 max-w-[78%]">
            <div className={`w-8 h-8 rounded-full ${AGENT_COLORS[workingAgents[0].name] || 'bg-slate-400'} flex items-center justify-center flex-shrink-0 self-end`}
                 style={{ fontSize: 12, fontWeight: 700, color: '#fff' }}>
              {workingAgents[0].name[0]}
            </div>
            <div className="flex flex-col">
              <div className="text-[10px] text-slate-400 mb-0.5 ml-1">
                {workingAgents.map(a => a.name).join(', ')} 思考中
              </div>
              <div className="flex gap-1 px-3 py-2 bg-white border border-gray-200 rounded-2xl rounded-tl-md">
                <span className="typing-dot" />
                <span className="typing-dot" />
                <span className="typing-dot" />
              </div>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <ChatInput />
    </div>
  );
}
