import { useState, useEffect, useCallback } from 'react';
import { useApi } from './useApi';
import type { Workspace } from '@agentos/shared';

interface CreateWorkspaceInput {
  name: string;
  rootPath: string;
  git?: boolean;
  memory?: boolean;
  readme?: boolean;
  docs?: boolean;
}

export function useWorkspace() {
  const { request } = useApi();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchWorkspaces = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await request<{ workspaces: Workspace[] }>('/api/workspaces');
      setWorkspaces(data.workspaces);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [request]);

  const createWorkspace = useCallback(async (input: CreateWorkspaceInput) => {
    const data = await request<{ workspace: Workspace }>('/api/workspaces', {
      method: 'POST',
      body: input,
    });
    await fetchWorkspaces();
    return data.workspace;
  }, [request, fetchWorkspaces]);

  const importWorkspace = useCallback(async (rootPath: string) => {
    const data = await request<{ workspace: Workspace }>('/api/workspaces/import', {
      method: 'POST',
      body: { rootPath },
    });
    await fetchWorkspaces();
    return data.workspace;
  }, [request, fetchWorkspaces]);

  const removeWorkspace = useCallback(async (id: string) => {
    await request(`/api/workspaces/${id}`, { method: 'DELETE' });
    await fetchWorkspaces();
  }, [request, fetchWorkspaces]);

  useEffect(() => {
    fetchWorkspaces();
  }, [fetchWorkspaces]);

  return { workspaces, loading, error, fetchWorkspaces, createWorkspace, importWorkspace, removeWorkspace };
}
