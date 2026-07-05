import { useStore } from '../stores/useStore';
import { AGENT_COLORS, STATUS_COLORS } from '../types';
import { formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { User } from 'lucide-react';

export default function AgentCard() {
  const agents = useStore((s) => s.agents);

  return (
    <div className="bg-white rounded-xl shadow p-4">
      <h2 className="text-sm font-semibold text-slate-700 mb-3">Agent 状态</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {agents.map((agent) => {
          const color = AGENT_COLORS[agent.name] || 'bg-slate-400';
          return (
            <div key={agent.id} className="border rounded-lg p-3 hover:shadow-md transition">
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-full flex items-center justify-center text-white ${color}`}>
                  {agent.avatar ? (
                    <img src={agent.avatar} alt={agent.name} className="w-full h-full rounded-full" />
                  ) : (
                    <User className="w-5 h-5" />
                  )}
                </div>
                <div className="flex-1">
                  <div className="font-medium">{agent.name}</div>
                  <div className="text-xs text-slate-500">{agent.role}</div>
                </div>
                <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_COLORS[agent.status]}`}>
                  {agent.status}
                </span>
              </div>
              <div className="mt-3">
                <div className="flex justify-between text-xs mb-1">
                  <span>进度</span>
                  <span>{agent.progress}%</span>
                </div>
                <div className="w-full bg-slate-100 rounded-full h-2">
                  <div
                    className={`h-2 rounded-full ${color}`}
                    style={{ width: `${agent.progress}%` }}
                  />
                </div>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {agent.skills.slice(0, 3).map((skill) => (
                  <span key={skill} className="text-[10px] px-1.5 py-0.5 bg-slate-100 text-slate-600 rounded">
                    {skill}
                  </span>
                ))}
              </div>
              <div className="mt-2 text-[10px] text-slate-400">
                最近活动: {agent.last_active_at
                  ? formatDistanceToNow(new Date(agent.last_active_at), { addSuffix: true, locale: zhCN })
                  : '未知'}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
