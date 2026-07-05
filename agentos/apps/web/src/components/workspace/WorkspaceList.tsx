import type { Workspace } from '@agentos/shared';

interface WorkspaceListProps {
  workspaces: Workspace[];
  onOpen: (id: string) => void;
  onRemove: (id: string) => void;
}

export function WorkspaceList({ workspaces, onOpen, onRemove }: WorkspaceListProps) {
  if (workspaces.length === 0) {
    return <div className="text-slate-500 text-sm text-center py-8">No workspaces yet. Create or import one.</div>;
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {workspaces.map(w => (
        <div
          key={w.id}
          className="bg-surface-800 border border-surface-700 rounded-lg p-4 hover:border-blue-500 transition-colors cursor-pointer"
          onClick={() => onOpen(w.id)}
        >
          <div className="flex items-start justify-between">
            <div className="font-medium truncate">{w.name}</div>
            <button
              onClick={e => { e.stopPropagation(); onRemove(w.id); }}
              className="text-xs text-slate-500 hover:text-red-400"
            >
              Remove
            </button>
          </div>
          <div className="text-xs text-slate-500 mt-1 truncate">{w.rootPath}</div>
          <div className="flex gap-2 mt-3 text-[10px]">
            <span className={`px-1.5 py-0.5 rounded ${w.gitEnabled ? 'bg-green-900 text-green-300' : 'bg-slate-700 text-slate-400'}`}>
              Git
            </span>
            <span className={`px-1.5 py-0.5 rounded ${w.memoryEnabled ? 'bg-green-900 text-green-300' : 'bg-slate-700 text-slate-400'}`}>
              Memory
            </span>
            <span className="px-1.5 py-0.5 rounded bg-slate-700 text-slate-400">
              {w.agents.length} agents
            </span>
          </div>
          <div className="text-[10px] text-slate-600 mt-2">
            Last opened: {new Date(w.lastOpenedAt).toLocaleString()}
          </div>
        </div>
      ))}
    </div>
  );
}
