import { useState } from 'react';
import { useStore } from '../stores/useStore';
import { tasksApi, agentsApi } from '../api/client';
import type { Task, TaskStatus } from '../types';
import { STATUS_COLORS } from '../types';
import { Plus, GripVertical, Trash2 } from 'lucide-react';

const COLUMNS: { key: TaskStatus; label: string }[] = [
  { key: 'todo', label: '待办' },
  { key: 'in_progress', label: '进行中' },
  { key: 'in_review', label: '审查中' },
  { key: 'done', label: '已完成' },
];

export default function KanbanBoard() {
  const tasks = useStore((s) => s.tasks);
  const agents = useStore((s) => s.agents);
  const [newTask, setNewTask] = useState('');
  const [dragging, setDragging] = useState<number | null>(null);

  const createTask = async () => {
    if (!newTask.trim()) return;
    await tasksApi.create({ title: newTask, status: 'todo' });
    setNewTask('');
  };

  const moveTask = async (task: Task, status: TaskStatus) => {
    await tasksApi.update(task.id, { status });
    if (status === 'in_progress') {
      const agent = agents.find(a => a.name === 'Codex');
      if (agent) await agentsApi.update(agent.id, { status: 'working' });
    }
  };

  const deleteTask = async (id: number) => {
    await tasksApi.remove(id);
  };

  return (
    <div className="bg-white rounded-xl shadow p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-slate-700">任务看板</h2>
        <div className="flex gap-2">
          <input
            value={newTask}
            onChange={(e) => setNewTask(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && createTask()}
            placeholder="输入任务名称"
            className="text-xs border rounded px-2 py-1 w-40"
          />
          <button
            onClick={createTask}
            className="text-xs bg-indigo-600 text-white px-2 py-1 rounded flex items-center gap-1"
          >
            <Plus className="w-3 h-3" /> 新建
          </button>
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        {COLUMNS.map((col) => (
          <div
            key={col.key}
            className="bg-slate-50 rounded-lg p-2 min-h-[200px]"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const task = tasks.find((t) => t.id === dragging);
              if (task) moveTask(task, col.key);
              setDragging(null);
            }}
          >
            <div className="text-xs font-medium text-slate-500 mb-2 px-1">
              {col.label} ({tasks.filter((t) => t.status === col.key).length})
            </div>
            <div className="space-y-2">
              {tasks
                .filter((t) => t.status === col.key)
                .map((task) => (
                  <div
                    key={task.id}
                    draggable
                    onDragStart={() => setDragging(task.id)}
                    className="bg-white border rounded p-2 shadow-sm cursor-move hover:shadow"
                  >
                    <div className="flex items-start gap-1">
                      <GripVertical className="w-3 h-3 text-slate-300 mt-0.5" />
                      <div className="flex-1">
                        <div className="text-xs font-medium">{task.title}</div>
                        {task.description && (
                          <div className="text-[10px] text-slate-400 mt-0.5">{task.description}</div>
                        )}
                        <div className="flex items-center justify-between mt-2">
                          <span className={`text-[10px] px-1.5 py-0.5 rounded ${STATUS_COLORS[task.priority] || 'bg-slate-100'}`}>
                            {task.priority}
                          </span>
                          <button
                            onClick={() => deleteTask(task.id)}
                            className="text-slate-400 hover:text-red-500"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
