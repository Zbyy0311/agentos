import { useEffect, useCallback, useState } from 'react';
import { useStore } from '../stores/useStore';
import { useWebSocket } from '../hooks/useWebSocket';
import { agentsApi, tasksApi, messagesApi, filesApi, metricsApi } from '../api/client';
import ChatSidebar from '../components/ChatSidebar';
import ChatRoom from '../components/ChatRoom';
import KanbanBoard from '../components/KanbanBoard';
import RepoView from '../components/RepoView';
import MetricsPanel from '../components/MetricsPanel';
import { MessageCircle, ListTodo, FileCode, Activity, RefreshCw } from 'lucide-react';

type RightPanel = 'tasks' | 'files' | 'metrics' | null;

export default function Dashboard() {
  const {
    setAgents, setTasks, setMessages, setFiles, setMetrics,
    activeRoom,
  } = useStore();

  const [rightPanel, setRightPanel] = useState<RightPanel>(null);

  const loadAll = useCallback(async () => {
    try {
      const room = activeRoom === 'group' ? 'group' : activeRoom;
      const [agents, tasks, messages, files, metrics] = await Promise.all([
        agentsApi.list(),
        tasksApi.list(),
        messagesApi.list(100, room),
        filesApi.list(),
        metricsApi.list(),
      ]);
      setAgents(agents);
      setTasks(tasks);
      setMessages(messages);
      setFiles(files);
      setMetrics(metrics);
    } catch (e) {
      console.error('Load data failed', e);
    }
  }, [setAgents, setTasks, setMessages, setFiles, setMetrics, activeRoom]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  useEffect(() => {
    const timer = setInterval(loadAll, 15000);
    return () => clearInterval(timer);
  }, [loadAll]);

  useWebSocket();

  return (
    <div className="h-screen w-screen flex flex-col bg-[#f0f2f5] overflow-hidden">
      <div className="flex flex-1 overflow-hidden w-full h-full">
        {/* Left Sidebar */}
        <ChatSidebar />

        {/* Main Chat */}
        <div className="flex-1 flex flex-col min-w-0">
          {rightPanel ? (
            <RightPanelView panel={rightPanel} onClose={() => setRightPanel(null)} />
          ) : (
            <ChatRoom />
          )}
        </div>

        {/* Right Toolbar Icons */}
        {!rightPanel && (
          <div className="w-12 bg-white border-l border-gray-100 flex flex-col items-center py-4 gap-5">
            <ToolButton
              icon={<MessageCircle className="w-5 h-5" />}
              active={rightPanel === null}
              label="聊天"
              onClick={() => setRightPanel(null)}
            />
            <ToolButton
              icon={<ListTodo className="w-5 h-5" />}
              active={rightPanel === 'tasks'}
              label="任务"
              onClick={() => setRightPanel('tasks')}
            />
            <ToolButton
              icon={<FileCode className="w-5 h-5" />}
              active={rightPanel === 'files'}
              label="文件"
              onClick={() => setRightPanel('files')}
            />
            <ToolButton
              icon={<Activity className="w-5 h-5" />}
              active={rightPanel === 'metrics'}
              label="指标"
              onClick={() => setRightPanel('metrics')}
            />
            <div className="flex-1" />
            <ToolButton
              icon={<RefreshCw className="w-4 h-4" />}
              active={false}
              label="重载"
              onClick={loadAll}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function ToolButton({ icon, active, label, onClick }: {
  icon: React.ReactNode;
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={`p-2 rounded-lg transition-colors ${
        active ? 'bg-indigo-50 text-indigo-600' : 'text-slate-400 hover:text-slate-600 hover:bg-gray-50'
      }`}
    >
      {icon}
    </button>
  );
}

function RightPanelView({ panel, onClose }: { panel: RightPanel; onClose: () => void }) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-100 bg-white">
        <h3 className="text-sm font-bold text-slate-700">
          {panel === 'tasks' ? '任务看板' : panel === 'files' ? '代码仓库' : '性能指标'}
        </h3>
        <button onClick={onClose} className="text-xs text-slate-400 hover:text-slate-600">
          ✕ 关闭
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {panel === 'tasks' && <KanbanBoard />}
        {panel === 'files' && <RepoView />}
        {panel === 'metrics' && <MetricsPanel />}
      </div>
    </div>
  );
}
