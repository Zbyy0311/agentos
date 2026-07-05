import { useStore } from '../stores/useStore';
import { AGENT_COLORS } from '../types';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, LineChart, Line } from 'recharts';
import { Activity } from 'lucide-react';

export default function MetricsPanel() {
  const metrics = useStore((s) => s.metrics);
  const agents = useStore((s) => s.agents);

  const data = metrics.map((m) => {
    const agent = agents.find((a) => a.id === m.agent_id);
    return {
      name: agent?.name || '系统',
      response: m.response_time_ms,
      loc: m.lines_of_code,
      warnings: m.warnings,
      errors: m.errors,
      health: m.health_score,
    };
  });

  const totalLoc = metrics.reduce((sum, m) => sum + m.lines_of_code, 0);
  const totalWarnings = metrics.reduce((sum, m) => sum + m.warnings, 0);
  const totalErrors = metrics.reduce((sum, m) => sum + m.errors, 0);
  const avgHealth = metrics.length ? (metrics.reduce((sum, m) => sum + m.health_score, 0) / metrics.length) : 100;

  return (
    <div className="bg-white rounded-xl shadow p-4">
      <div className="flex items-center gap-2 mb-3">
        <Activity className="w-4 h-4 text-slate-500" />
        <h2 className="text-sm font-semibold text-slate-700">性能监控面板</h2>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <StatCard label="代码行数" value={totalLoc} />
        <StatCard label="警告" value={totalWarnings} />
        <StatCard label="错误" value={totalErrors} />
        <StatCard label="健康度" value={`${avgHealth.toFixed(1)}%`} />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 h-48">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data}>
            <XAxis dataKey="name" tick={{ fontSize: 10 }} />
            <YAxis tick={{ fontSize: 10 }} />
            <Tooltip />
            <Bar dataKey="response" name="响应时间(ms)" fill="#6366f1" />
          </BarChart>
        </ResponsiveContainer>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data}>
            <XAxis dataKey="name" tick={{ fontSize: 10 }} />
            <YAxis domain={[0, 100]} tick={{ fontSize: 10 }} />
            <Tooltip />
            <Line type="monotone" dataKey="health" name="健康度" stroke="#10b981" />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {agents.map((a) => (
          <span key={a.id} className={`text-[10px] px-2 py-0.5 rounded text-white ${AGENT_COLORS[a.name] || 'bg-slate-400'}`}>
            {a.name} · {a.status}
          </span>
        ))}
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-slate-50 rounded p-3 text-center">
      <div className="text-lg font-bold text-slate-800">{value}</div>
      <div className="text-[10px] text-slate-500">{label}</div>
    </div>
  );
}
