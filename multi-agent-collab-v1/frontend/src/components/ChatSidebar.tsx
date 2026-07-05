import { useStore } from '../stores/useStore';
import { AGENT_COLORS } from '../types';
import { Users, Search, Bot } from 'lucide-react';
import { useState, useMemo } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale';

export default function ChatSidebar() {
  const { agents, messages, activeRoom, setActiveRoom } = useStore();
  const [search, setSearch] = useState('');

  const lastMsgs = useMemo(() => {
    const map: Record<string, { text: string; time: string }> = {};

    for (const m of messages) {
      if (m.room === 'group' && !map.group) {
        map.group = { text: m.content.slice(0, 30), time: m.created_at };
      }
      if (m.room === 'group') continue;
      const key = m.agent_name || m.target;
      if (key && !map[key]) {
        map[key] = { text: m.content.slice(0, 30), time: m.created_at };
      }
    }
    return map;
  }, [messages]);

  const filteredAgents = useMemo(() => {
    if (!search.trim()) return agents;
    return agents.filter(a => a.name.toLowerCase().includes(search.toLowerCase()));
  }, [agents, search]);

  return (
    <aside className="w-[300px] min-w-[260px] bg-white border-r border-gray-100 flex flex-col h-full">
      <div className="px-4 pt-5 pb-3 border-b border-gray-50">
        <div className="flex items-center gap-2 mb-2">
          <Bot className="w-5 h-5 text-indigo-500" />
          <h1 className="text-lg font-bold text-slate-800">Multi-Agent</h1>
        </div>
        <p className="text-xs text-slate-400">协作系统 v1.0</p>
      </div>

      <div className="px-3 py-3">
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="搜索智能体..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-8 pr-3 py-2 text-sm border-none rounded-lg bg-gray-50 outline-none focus:bg-gray-100 transition-colors"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {/* Group Chat */}
        <button
          onClick={() => setActiveRoom('group')}
          className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors relative ${
            activeRoom === 'group' ? 'bg-indigo-50' : 'hover:bg-gray-50'
          }`}
        >
          {activeRoom === 'group' && (
            <div className="absolute left-0 top-2 bottom-2 w-[3px] bg-indigo-500 rounded-r-md" />
          )}
          <div className="w-10 h-10 rounded-full bg-indigo-500 flex items-center justify-center flex-shrink-0">
            <Users className="w-5 h-5 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-slate-800 flex items-center gap-1.5">
              群聊
              <span className="text-[10px] bg-indigo-100 text-indigo-600 px-1.5 py-0.5 rounded font-medium">
                全部
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5 truncate">
              {lastMsgs.group?.text || '点击进入群聊'}
            </p>
          </div>
          <div className="text-[10px] text-slate-300 flex-shrink-0">
            {lastMsgs.group?.time
              ? formatDistanceToNow(new Date(lastMsgs.group.time), { addSuffix: true, locale: zhCN }).replace('大约', '')
              : ''}
          </div>
        </button>

        {/* Agent items */}
        {filteredAgents.map((agent) => {
          const color = AGENT_COLORS[agent.name] || 'bg-slate-400';
          const roomId = `agent_${agent.id}`;
          return (
            <button
              key={agent.id}
              onClick={() => setActiveRoom(roomId)}
              className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors relative ${
                activeRoom === roomId ? 'bg-indigo-50' : 'hover:bg-gray-50'
              }`}
            >
              {activeRoom === roomId && (
                <div className="absolute left-0 top-2 bottom-2 w-[3px] bg-indigo-500 rounded-r-md" />
              )}
              <div className={`w-10 h-10 rounded-full ${color} flex items-center justify-center flex-shrink-0 relative`}>
                <span className="text-white font-semibold text-sm">{agent.name[0]}</span>
                {agent.status === 'working' && (
                  <span className="absolute bottom-0.5 right-0.5 w-2.5 h-2.5 bg-emerald-400 border-2 border-white rounded-full" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-slate-800">{agent.name}</div>
                <p className="text-xs text-slate-400 mt-0.5 truncate">{agent.role}</p>
              </div>
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full flex-shrink-0 ${
                agent.status === 'working' ? 'bg-emerald-50 text-emerald-600' :
                agent.status === 'waiting' ? 'bg-amber-50 text-amber-600' :
                'bg-gray-50 text-gray-500'
              }`}>
                {agent.status === 'working' ? '在线' : agent.status === 'waiting' ? '等待' : '空闲'}
              </span>
            </button>
          );
        })}
      </div>

      <div className="px-4 py-3 border-t border-gray-50">
        <div className="text-[10px] text-slate-300 text-center">
          {agents.length} 个智能体在线
        </div>
      </div>
    </aside>
  );
}
