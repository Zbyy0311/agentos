'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CollaborationProgress, CollaborationTask } from '@agentos/shared';
import { mergeCollaborationTaskPage, resolveExplicitTaskProgress } from './collaborationTaskHistory';

export type CollaborationProgressConnection = 'idle' | 'connecting' | 'connected' | 'polling' | 'offline';
export type CollaborationTaskSelectionReason = 'user' | 'auto';

export interface CollaborationProgressState {
  readonly tasks: CollaborationTask[];
  readonly hasMoreTasks: boolean;
  readonly loadingMoreTasks: boolean;
  readonly selectedTaskId: string | null;
  readonly progress: CollaborationProgress | null;
  readonly loading: boolean;
  readonly error: string;
  readonly connection: CollaborationProgressConnection;
  /** Monotonic signal shared with execution/inspector projections. */
  readonly refreshRevision: number;
  readonly selectTask: (taskId: string) => void;
  readonly loadMoreTasks: () => void;
  readonly refresh: () => void;
}

const TERMINAL_STATUSES = new Set(['applied', 'failed', 'blocked', 'cancelled']);

function taskPriority(task: CollaborationTask): number {
  return TERMINAL_STATUSES.has(task.status) ? 1 : 0;
}

function chooseTask(tasks: CollaborationTask[], selectedTaskId: string | null): CollaborationTask | undefined {
  const selected = selectedTaskId === null ? undefined : tasks.find(task => task.id === selectedTaskId);
  if (selected) return selected;
  return [...tasks].sort((left, right) => taskPriority(left) - taskPriority(right)
    || right.updatedAt.localeCompare(left.updatedAt)
    || right.id.localeCompare(left.id))[0];
}

async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', signal });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { detail?: unknown; error?: unknown };
    const message = typeof body.detail === 'string' ? body.detail : typeof body.error === 'string' ? body.error : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export function useCollaborationProgress(input: {
  readonly apiBase: string;
  readonly workspaceId: string | null;
  readonly conversationId: string | null;
  readonly preferredTaskId?: string | null;
  readonly enabled?: boolean;
  readonly onTaskSelectionChange?: (taskId: string, reason: CollaborationTaskSelectionReason) => void;
}): CollaborationProgressState {
  const enabled = input.enabled ?? true;
  const identityKey = JSON.stringify([input.workspaceId, input.conversationId, input.preferredTaskId ?? null, enabled]);
  const currentIdentityRef = useRef(identityKey);
  currentIdentityRef.current = identityKey;
  const [loadedIdentityKey, setLoadedIdentityKey] = useState(identityKey);
  const [tasks, setTasks] = useState<CollaborationTask[]>([]);
  const [hasMoreTasks, setHasMoreTasks] = useState(false);
  const [loadingMoreTasks, setLoadingMoreTasks] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [progress, setProgress] = useState<CollaborationProgress | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [connection, setConnection] = useState<CollaborationProgressConnection>('idle');
  const [refreshToken, setRefreshToken] = useState(0);
  const requestGeneration = useRef(0);
  const refreshTimer = useRef<number | null>(null);
  const inFlightRef = useRef(false);
  const queuedRefreshRef = useRef(false);
  const loadingMoreRef = useRef(false);
  const pageAbortRef = useRef<AbortController | null>(null);
  const loadedTaskCountRef = useRef(0);

  const refresh = useCallback(() => {
    if (inFlightRef.current) {
      queuedRefreshRef.current = true;
      return;
    }
    setRefreshToken(value => value + 1);
  }, []);
  const selectTask = useCallback((taskId: string) => {
    setSelectedTaskId(taskId);
    queuedRefreshRef.current = false;
    setRefreshToken(value => value + 1);
    input.onTaskSelectionChange?.(taskId, 'user');
  }, [input.onTaskSelectionChange]);

  const loadMoreTasks = useCallback(() => {
    if (!enabled || !input.workspaceId || !input.conversationId || !hasMoreTasks || loadingMoreRef.current) return;
    const controller = new AbortController();
    pageAbortRef.current?.abort();
    pageAbortRef.current = controller;
    loadingMoreRef.current = true;
    setLoadingMoreTasks(true);
    const generation = requestGeneration.current;
    const offset = loadedTaskCountRef.current;
    const limit = 100;
    const query = new URLSearchParams({ conversationId: input.conversationId, limit: String(limit), offset: String(offset) });
    void getJson<{ tasks: CollaborationTask[] }>(
      `${input.apiBase}/api/workspaces/${encodeURIComponent(input.workspaceId)}/collaboration/tasks?${query.toString()}`,
      controller.signal,
    ).then(result => {
      if (generation !== requestGeneration.current || controller.signal.aborted || currentIdentityRef.current !== identityKey) return;
      const ownedTasks = result.tasks.filter(task => task.workspaceId === input.workspaceId && task.conversationId === input.conversationId);
      setTasks(current => mergeCollaborationTaskPage(current, ownedTasks, selectedTaskId, limit).tasks);
      loadedTaskCountRef.current = offset + result.tasks.length;
      setHasMoreTasks(result.tasks.length >= limit);
    }).catch(cause => {
      if (!controller.signal.aborted && generation === requestGeneration.current) {
        setError(cause instanceof Error ? cause.message : '历史协作任务加载失败');
      }
    }).finally(() => {
      if (pageAbortRef.current === controller) {
        pageAbortRef.current = null;
        loadingMoreRef.current = false;
        setLoadingMoreTasks(false);
      }
    });
  }, [enabled, hasMoreTasks, identityKey, input.apiBase, input.conversationId, input.workspaceId, selectedTaskId]);

  useEffect(() => {
    setLoadedIdentityKey(identityKey);
    requestGeneration.current += 1;
    setTasks([]);
    loadedTaskCountRef.current = 0;
    setHasMoreTasks(false);
    setLoadingMoreTasks(false);
    pageAbortRef.current?.abort();
    loadingMoreRef.current = false;
    setSelectedTaskId(input.preferredTaskId ?? null);
    setProgress(null);
    setError('');
    setConnection(enabled && input.conversationId ? 'connecting' : 'idle');
  }, [enabled, identityKey, input.conversationId, input.preferredTaskId, input.workspaceId]);

  useEffect(() => {
    if (!enabled || !input.workspaceId || !input.conversationId) return undefined;
    const workspaceId = input.workspaceId;
    const conversationId = input.conversationId;
    const controller = new AbortController();
    const generation = ++requestGeneration.current;
    inFlightRef.current = true;
    let disposed = false;

    const load = async () => {
      setLoading(true);
      setConnection(current => current === 'connected' ? current : 'polling');
      try {
        const query = new URLSearchParams({ conversationId, limit: '100', offset: '0' });
        const explicitTaskId = loadedIdentityKey !== identityKey ? input.preferredTaskId ?? null : selectedTaskId ?? input.preferredTaskId ?? null;
        const taskListPromise = getJson<{ tasks: CollaborationTask[] }>(
          `${input.apiBase}/api/workspaces/${encodeURIComponent(workspaceId)}/collaboration/tasks?${query.toString()}`,
          controller.signal,
        );
        const explicitProgressPromise = explicitTaskId
          ? getJson<{ progress: CollaborationProgress }>(
            `${input.apiBase}/api/workspaces/${encodeURIComponent(workspaceId)}/collaboration/tasks/${encodeURIComponent(explicitTaskId)}/progress`,
            controller.signal,
          )
          : undefined;
        const [result, explicitResult] = await Promise.all([
          taskListPromise,
          explicitProgressPromise ?? Promise.resolve(undefined),
        ]);
        if (disposed || generation !== requestGeneration.current || currentIdentityRef.current !== identityKey) return;
        const nextTasks = result.tasks.filter(task => task.workspaceId === workspaceId && task.conversationId === conversationId);
        setTasks(current => mergeCollaborationTaskPage(current, nextTasks, explicitTaskId, 100).tasks);
        loadedTaskCountRef.current = Math.max(loadedTaskCountRef.current, result.tasks.length);
        setHasMoreTasks(result.tasks.length >= 100);
        if (explicitTaskId && explicitResult) {
          const validated = explicitResult.progress.task.workspaceId === workspaceId
            ? resolveExplicitTaskProgress(explicitResult.progress, conversationId, explicitTaskId) : null;
          if (!validated) {
            setSelectedTaskId(explicitTaskId);
            setProgress(null);
            setError('指定的协作任务不存在、已移除或不属于当前群聊');
            setConnection('connected');
            return;
          }
          setTasks(current => mergeCollaborationTaskPage(current, [validated.task], explicitTaskId, 100).tasks);
          setSelectedTaskId(explicitTaskId);
          setProgress(validated);
          setError('');
          setConnection('connected');
          return;
        }
        const task = chooseTask(nextTasks, explicitTaskId);
        if (!task) {
          setSelectedTaskId(null);
          setProgress(null);
          setError('');
          setConnection('idle');
          return;
        }
        if (task.id !== selectedTaskId) {
          setSelectedTaskId(task.id);
          if (!input.preferredTaskId) input.onTaskSelectionChange?.(task.id, 'auto');
        }
        const detail = await getJson<{ progress: CollaborationProgress }>(
          `${input.apiBase}/api/workspaces/${encodeURIComponent(workspaceId)}/collaboration/tasks/${encodeURIComponent(task.id)}/progress`,
          controller.signal,
        );
        if (disposed || generation !== requestGeneration.current || currentIdentityRef.current !== identityKey) return;
        if (!resolveExplicitTaskProgress(detail.progress, conversationId, task.id) || detail.progress.task.workspaceId !== workspaceId) throw new Error('协作任务进度不属于当前群聊');
        setProgress(detail.progress);
        setError('');
        setConnection('connected');
      } catch (cause) {
        if (disposed || controller.signal.aborted || currentIdentityRef.current !== identityKey) return;
        setError(cause instanceof Error ? cause.message : '协作任务进度加载失败');
        setConnection('offline');
      } finally {
        if (!disposed && generation === requestGeneration.current) {
          inFlightRef.current = false;
          setLoading(false);
          if (queuedRefreshRef.current) {
            queuedRefreshRef.current = false;
            setRefreshToken(value => value + 1);
          }
        }
      }
    };
    void load();
    return () => {
      disposed = true;
      controller.abort();
      if (generation === requestGeneration.current) {
        inFlightRef.current = false;
        queuedRefreshRef.current = false;
      }
    };
  }, [identityKey, loadedIdentityKey, input.apiBase, input.conversationId, input.onTaskSelectionChange, input.preferredTaskId, input.workspaceId, enabled, refreshToken, selectedTaskId]);

  useEffect(() => {
    const runId = progress?.currentRunId;
    if (!enabled || loadedIdentityKey !== identityKey || progress?.task.conversationId !== input.conversationId || !runId || !input.workspaceId || !input.conversationId) return undefined;
    const url = new URL(`${input.apiBase}/api/runs/${encodeURIComponent(runId)}/stream`);
    url.searchParams.set('afterSequence', String(progress.eventCursor));
    let disposed = false;
    const source = new EventSource(url.toString());
    setConnection('connecting');
    const scheduleRefresh = () => {
      if (disposed || refreshTimer.current !== null) return;
      refreshTimer.current = window.setTimeout(() => {
        refreshTimer.current = null;
        if (!disposed) refresh();
      }, 120);
    };
    const onEvent = () => {
      if (disposed || currentIdentityRef.current !== identityKey) return;
      setConnection('connected');
      scheduleRefresh();
    };
    const onError = () => {
      if (!disposed) setConnection('offline');
    };
    source.addEventListener('runtime-event', onEvent);
    source.addEventListener('message', onEvent);
    source.addEventListener('error', onError);
    return () => {
      disposed = true;
      source.removeEventListener('runtime-event', onEvent);
      source.removeEventListener('message', onEvent);
      source.removeEventListener('error', onError);
      source.close();
      if (refreshTimer.current !== null) {
        window.clearTimeout(refreshTimer.current);
        refreshTimer.current = null;
      }
    };
  }, [enabled, identityKey, loadedIdentityKey, input.apiBase, input.conversationId, input.workspaceId, progress?.task.conversationId, progress?.currentRunId, progress?.eventCursor, refresh]);

  useEffect(() => {
    if (!progress || TERMINAL_STATUSES.has(progress.task.status) || !input.workspaceId || !input.conversationId) return undefined;
    const trigger = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    const timer = window.setInterval(trigger, 2000);
    document.addEventListener('visibilitychange', trigger);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', trigger);
    };
  }, [input.conversationId, input.workspaceId, progress, refresh]);

  const visible = enabled && loadedIdentityKey === identityKey;
  const visibleProgress = visible && progress?.task.workspaceId === input.workspaceId
    && progress.task.conversationId === input.conversationId && progress.task.id === selectedTaskId ? progress : null;
  return { tasks: visible ? tasks : [], hasMoreTasks: visible && hasMoreTasks, loadingMoreTasks: visible && loadingMoreTasks,
    selectedTaskId: visible ? selectedTaskId : null, progress: visibleProgress, loading: !visible || loading,
    error: visible ? error : '', connection: visible ? connection : 'idle', refreshRevision: refreshToken, selectTask, loadMoreTasks, refresh };
}

export { TERMINAL_STATUSES };
