'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState, useRef, useCallback } from 'react';
import { useApi } from '@/lib/useApi';
import { useTask } from '@/lib/useTask';
import type { Workspace, TaskItem, TaskLog } from '@agentos/shared';

// ---------- Agent stage display helpers ----------

const STAGE_META: Record<string, { label: string; color: string; icon: string }> = {
  codex_manager:       { label: 'Codex — Manager',        color: 'border-l-blue-500',  icon: '🧠' },
  kimi_worker:         { label: 'KimiCode — Worker',      color: 'border-l-green-500', icon: '⚡' },
  opencode_reviewer:   { label: 'OpenCode — Reviewer',    color: 'border-l-yellow-500',icon: '🔍' },
  codex_final_review:  { label: 'Codex — Final Review',   color: 'border-l-purple-500',icon: '✅' },
};

function StageCard({ log, collapsed: initial }: { log: TaskLog; collapsed?: boolean }) {
  const [open, setOpen] = useState(initial ?? false);
  const meta = STAGE_META[log.stage] || { label: log.stage, color: 'border-l-slate-500', icon: '🤖' };

  return (
    <div className={`border border-surface-600 rounded-lg bg-surface-800 border-l-4 ${meta.color} mb-3`}>
      <button
        className="w-full flex items-center gap-3 px-4 py-3 text-left"
        onClick={() => setOpen(!open)}
      >
        <span className="text-lg">{meta.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium">{meta.label}</div>
          <div className="text-[11px] text-slate-500">
            {log.duration}ms · exit {log.exitCode}
          </div>
        </div>
        <span className={`text-xs px-2 py-0.5 rounded ${
          log.exitCode === 0
            ? 'bg-green-900 text-green-300'
            : 'bg-red-900 text-red-300'
        }`}>
          {log.exitCode === 0 ? 'OK' : 'FAIL'}
        </span>
        <span className="text-slate-500 text-sm">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="px-4 pb-4">
          <pre className="text-[12px] text-slate-300 bg-surface-900 rounded p-3 overflow-x-auto whitespace-pre-wrap max-h-96 overflow-y-auto">
            {log.stdout}
          </pre>
          {log.stderr && (
            <details className="mt-2">
              <summary className="text-[11px] text-red-400 cursor-pointer">stderr</summary>
              <pre className="text-[11px] text-red-300 bg-surface-900 rounded p-2 mt-1 overflow-x-auto">{log.stderr}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- Page ----------

export default function WorkspacePage() {
  const params = useParams();
  const workspaceId = typeof params.id === 'string' ? params.id : null;
  const { request } = useApi();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [loadingWorkspace, setLoadingWorkspace] = useState(true);
  const [workspaceError, setWorkspaceError] = useState('');
  const { tasks, loading: loadingTasks, createTask, fetchTasks } = useTask(workspaceId);
  const [taskTitle, setTaskTitle] = useState('');

  // Pipeline state
  const [runningTaskId, setRunningTaskId] = useState<string | null>(null);
  const [status, setStatus] = useState<TaskItem['status']>('idle' as any);
  const [outputs, setOutputs] = useState<TaskLog[]>([]);

  // SSE streaming — use a ref so we never lose partial lines across chunks
  const streamTextRef = useRef('');
  const [, forceRender] = useState(0);

  // Abort controller ref — allows user to cancel a running pipeline
  const abortRef = useRef<AbortController | null>(null);

  const streamEndRef = useRef<HTMLDivElement>(null);
  const outputEndRef = useRef<HTMLDivElement>(null);

  // Re-read latest streamText for the UI
  const streamText = streamTextRef.current;

  // Auto-scroll
  useEffect(() => { streamEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [streamText]);
  useEffect(() => { outputEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [outputs]);

  // Load git diff
  const [diff, setDiff] = useState('');
  useEffect(() => {
    if (!workspaceId) return;
    request<{ diff: string }>(`/api/workspaces/${workspaceId}/git/diff`)
      .then(data => setDiff(data.diff))
      .catch(() => {});
  }, [workspaceId, request, status]);

  // Fetch workspace
  useEffect(() => {
    if (!workspaceId) return;
    setLoadingWorkspace(true);
    setWorkspaceError('');
    request<{ workspace: Workspace }>(`/api/workspaces/${workspaceId}`)
      .then(data => setWorkspace(data.workspace))
      .catch(e => setWorkspaceError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoadingWorkspace(false));
  }, [workspaceId, request]);

  const handleCreateTask = async () => {
    if (!taskTitle.trim()) return;
    try {
      await createTask(taskTitle);
      setTaskTitle('');
    } catch { /* ignore */ }
  };

  // Cancel pipeline
  const cancelRun = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, []);

  const runTask = useCallback(async (taskId: string) => {
    setRunningTaskId(taskId);
    setStatus('running');
    setOutputs([]);
    streamTextRef.current = '';
    forceRender(n => n + 1);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000'}/api/workspaces/${workspaceId}/tasks/${taskId}/run`,
        {
          method: 'POST',
          headers: { Accept: 'text/event-stream' },
          signal: controller.signal,
        },
      );
      if (!response.ok || !response.body) throw new Error(`Run failed: ${response.status}`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let currentEvent = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (currentEvent === 'thinking') {
                // Append text directly to the ref — no line-joining logic needed
                if (data.text) {
                  streamTextRef.current += data.text;
                  forceRender(n => n + 1);
                }
              } else if (currentEvent === 'stage') {
                if (data.status === 'running') {
                  streamTextRef.current += `\n━━━ ${data.agent || data.stage} ${data.status} ━━━\n`;
                  forceRender(n => n + 1);
                } else if (data.status === 'completed' && data.log) {
                  setOutputs(prev => [...prev, data.log]);
                  streamTextRef.current += `\n━━━ ${data.stage} completed ─── ${data.log.duration}ms\n`;
                  forceRender(n => n + 1);
                }
              } else if (currentEvent === 'status' && data.status !== 'running') {
                setStatus(data.status);
              } else if (currentEvent === 'done') {
                setStatus(data.status);
                if (data.error) {
                  streamTextRef.current += `\n✗ Pipeline failed: ${data.error}\n`;
                  forceRender(n => n + 1);
                }
              }
              if (currentEvent !== 'thinking') currentEvent = '';
            } catch {
              // ignore parse errors
            }
          }
        }
      }
      // Refresh to get persisted outputs
      try {
        const statusRes = await request<{ task: TaskItem }>(`/api/workspaces/${workspaceId}/tasks/${taskId}/status`);
        if (statusRes.task.outputs?.length) setOutputs(statusRes.task.outputs);
      } catch { /* ignore */ }
      await fetchTasks();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setStatus('failed' as any);
        streamTextRef.current += '\n⛔ Pipeline cancelled\n';
        forceRender(n => n + 1);
      } else {
        setStatus('failed');
        streamTextRef.current += `\n✗ Pipeline error: ${err instanceof Error ? err.message : String(err)}\n`;
        forceRender(n => n + 1);
      }
    } finally {
      setRunningTaskId(null);
      abortRef.current = null;
    }
  }, [workspaceId, request, fetchTasks]);

  // Load persisted outputs when selecting completed/failed task
  const selectTask = useCallback(async (task: TaskItem) => {
    if (task.status === 'running' || task.status === 'pending') return;
    setRunningTaskId(task.id);
    setStatus(task.status as any);
    streamTextRef.current = '';
    forceRender(n => n + 1);
    setOutputs(task.outputs || []);
  }, []);

  if (loadingWorkspace) return <div className="p-8 text-slate-500">Loading workspace...</div>;
  if (workspaceError) return <div className="p-8 text-red-400">Error: {workspaceError}</div>;
  if (!workspace) return <div className="p-8 text-red-400">Workspace not found</div>;

  return (
    <div className="flex flex-col h-screen bg-[#0f1117] text-slate-200">
      <header className="flex items-center justify-between px-6 py-3 border-b border-surface-700 bg-surface-800">
        <div>
          <div className="font-semibold">{workspace.name}</div>
          <div className="text-xs text-slate-500 truncate">{workspace.rootPath}</div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-[10px] px-2 py-0.5 rounded ${
            status === 'running' ? 'bg-blue-900 text-blue-300' :
            status === 'completed' ? 'bg-green-900 text-green-300' :
            status === 'failed' ? 'bg-red-900 text-red-300' :
            'bg-slate-700 text-slate-400'
          }`}>
            {status}
          </span>
          {status === 'running' && runningTaskId && (
            <button
              onClick={cancelRun}
              className="px-2 py-0.5 bg-red-700 hover:bg-red-600 rounded text-[10px]"
            >
              Cancel
            </button>
          )}
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Left: Task list */}
        <aside className="w-64 border-r border-surface-700 bg-surface-800 p-4 overflow-y-auto flex flex-col">
          <div className="text-xs font-medium text-slate-400 mb-2">TASKS</div>
          <div className="flex gap-2 mb-3">
            <input
              type="text"
              value={taskTitle}
              onChange={e => setTaskTitle(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleCreateTask()}
              placeholder="New task..."
              className="flex-1 bg-surface-900 border border-surface-600 rounded px-2 py-1 text-xs outline-none focus:border-blue-500"
            />
            <button onClick={handleCreateTask} className="px-2 py-1 bg-blue-600 rounded text-xs">Add</button>
          </div>
          {loadingTasks && <div className="text-xs text-slate-500">Loading...</div>}
          <div className="space-y-1 flex-1 overflow-y-auto">
            {tasks.map(task => (
              <div
                key={task.id}
                className={`flex items-center justify-between p-2 rounded text-xs cursor-pointer transition-colors ${
                  runningTaskId === task.id
                    ? 'bg-surface-700 ring-1 ring-blue-500'
                    : 'bg-surface-900 hover:bg-surface-700'
                }`}
                onClick={() => selectTask(task)}
              >
                <span className="truncate flex-1">{task.title}</span>
                <span className={`ml-2 text-[10px] px-1.5 py-0.5 rounded ${
                  task.status === 'completed' ? 'bg-green-900 text-green-300' :
                  task.status === 'failed' ? 'bg-red-900 text-red-300' :
                  task.status === 'running' ? 'bg-blue-900 text-blue-300' :
                  'bg-slate-700 text-slate-400'
                }`}>
                  {task.status}
                </span>
                <button
                  onClick={e => { e.stopPropagation(); runTask(task.id); }}
                  disabled={status === 'running'}
                  className="ml-2 px-2 py-0.5 bg-green-700 rounded disabled:bg-slate-700"
                >
                  Run
                </button>
              </div>
            ))}
          </div>
        </aside>

        {/* Center: Pipeline output — structured stage cards + live stream */}
        <main className="flex-1 flex flex-col overflow-hidden">
          {/* Stage outputs (completed) */}
          {outputs.length > 0 && (
            <div className="flex-1 overflow-y-auto p-4">
              <div className="text-xs font-medium text-slate-400 mb-3 uppercase tracking-wider">
                Agent Outputs
              </div>
              {outputs.map((log, i) => (
                <StageCard key={`${log.stage}-${i}`} log={log} collapsed={false} />
              ))}
              <div ref={outputEndRef} />
            </div>
          )}

          {/* Live stream (during run) */}
          {streamText && (
            <div className={`${outputs.length > 0 ? 'border-t border-surface-700 max-h-64' : 'flex-1'} overflow-y-auto p-4 font-mono text-xs`}>
              {outputs.length > 0 && (
                <div className="text-xs font-medium text-slate-400 mb-2 uppercase tracking-wider">Live Stream</div>
              )}
              <pre className="whitespace-pre-wrap">{streamText}</pre>
              <div ref={streamEndRef} />
            </div>
          )}

          {/* Empty state */}
          {outputs.length === 0 && !streamText && (
            <div className="flex-1 flex items-center justify-center text-slate-500 text-sm">
              Select a task and click Run to start the pipeline.
            </div>
          )}
        </main>

        {/* Right: Git diff */}
        <aside className="w-80 border-l border-surface-700 bg-surface-800 p-4 overflow-y-auto">
          <div className="text-xs font-medium text-slate-400 mb-2">GIT DIFF</div>
          <pre className="text-[11px] text-slate-400 whitespace-pre-wrap">{diff || '(no changes)'}</pre>
        </aside>
      </div>
    </div>
  );
}
