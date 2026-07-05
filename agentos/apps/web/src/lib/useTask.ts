import { useState, useEffect, useCallback } from 'react';
import { useApi } from './useApi';
import type { TaskItem } from '@agentos/shared';

export function useTask(workspaceId: string | null) {
  const { request } = useApi();
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const fetchTasks = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    setError('');
    try {
      const data = await request<{ tasks: TaskItem[] }>(`/api/workspaces/${workspaceId}/tasks`);
      setTasks(data.tasks);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [request, workspaceId]);

  const createTask = useCallback(async (title: string) => {
    if (!workspaceId) throw new Error('No workspace selected');
    const data = await request<{ task: TaskItem }>(`/api/workspaces/${workspaceId}/tasks`, {
      method: 'POST',
      body: { title },
    });
    await fetchTasks();
    return data.task;
  }, [request, workspaceId, fetchTasks]);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  return { tasks, loading, error, fetchTasks, createTask };
}
