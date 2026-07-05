import { Network } from 'lucide-react';

const NODES = [
  { id: 'client', label: '前端 React', x: 100, y: 50 },
  { id: 'ws', label: 'WebSocket', x: 300, y: 50 },
  { id: 'api', label: 'FastAPI', x: 300, y: 150 },
  { id: 'db', label: 'SQLite', x: 500, y: 150 },
  { id: 'agents', label: 'Agent 服务', x: 300, y: 250 },
  { id: 'tasks', label: '任务服务', x: 150, y: 250 },
  { id: 'metrics', label: '监控服务', x: 450, y: 250 },
];

const EDGES = [
  { from: 'client', to: 'ws' },
  { from: 'ws', to: 'api' },
  { from: 'api', to: 'db' },
  { from: 'api', to: 'agents' },
  { from: 'api', to: 'tasks' },
  { from: 'api', to: 'metrics' },
];

export default function ArchitectureGraph() {
  return (
    <div className="bg-white rounded-xl shadow p-4">
      <div className="flex items-center gap-2 mb-3">
        <Network className="w-4 h-4 text-slate-500" />
        <h2 className="text-sm font-semibold text-slate-700">系统架构图</h2>
      </div>
      <div className="relative w-full h-72 bg-slate-50 rounded-lg overflow-hidden">
        <svg className="absolute inset-0 w-full h-full">
          {EDGES.map((edge, i) => {
            const from = NODES.find((n) => n.id === edge.from)!;
            const to = NODES.find((n) => n.id === edge.to)!;
            return (
              <g key={i}>
                <line
                  x1={from.x}
                  y1={from.y}
                  x2={to.x}
                  y2={to.y}
                  stroke="#cbd5e1"
                  strokeWidth="2"
                />
                <circle r="2" fill="#6366f1">
                  <animateMotion
                    dur="2s"
                    repeatCount="indefinite"
                    path={`M${from.x},${from.y} L${to.x},${to.y}`}
                  />
                </circle>
              </g>
            );
          })}
        </svg>
        {NODES.map((node) => (
          <div
            key={node.id}
            className="absolute -translate-x-1/2 -translate-y-1/2 bg-white border-2 border-indigo-100 shadow rounded-lg px-3 py-2 text-xs font-medium"
            style={{ left: node.x, top: node.y }}
          >
            {node.label}
          </div>
        ))}
      </div>
    </div>
  );
}
