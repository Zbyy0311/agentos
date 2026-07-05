import { useEffect, useRef, useCallback } from 'react';
import { useStore } from '../stores/useStore';
import type { WSMessage, Agent, Task, Message, RepoFile, Metric } from '../types';

const WS_URL = import.meta.env.VITE_WS_URL || `ws://${window.location.host}/ws`;

export function useWebSocket() {
  const ws = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>();
  const {
    upsertAgent, upsertTask, upsertMessage, upsertFile, upsertMetric,
    removeAgent, removeTask,
  } = useStore();

  const handleMessage = useCallback((event: MessageEvent) => {
    try {
      const msg: WSMessage = JSON.parse(event.data);
      switch (msg.type) {
        case 'agent.created':
        case 'agent.updated':
          upsertAgent(msg.payload as Agent);
          break;
        case 'agent.deleted':
          removeAgent((msg.payload as { id: number }).id);
          break;
        case 'task.created':
        case 'task.updated':
          upsertTask(msg.payload as Task);
          break;
        case 'task.deleted':
          removeTask((msg.payload as { id: number }).id);
          break;
        case 'message.created':
          upsertMessage(msg.payload as Message);
          break;
        case 'file.updated':
          upsertFile(msg.payload as RepoFile);
          break;
        case 'metric.updated':
          upsertMetric(msg.payload as Metric);
          break;
      }
    } catch (e) {
      console.error('WebSocket message parse error', e);
    }
  }, [upsertAgent, upsertTask, upsertMessage, upsertFile, upsertMetric, removeAgent, removeTask]);

  const connect = useCallback(() => {
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    const socket = new WebSocket(WS_URL);
    ws.current = socket;
    socket.onmessage = handleMessage;
    socket.onclose = () => {
      reconnectTimer.current = setTimeout(connect, 3000);
    };
    socket.onerror = () => {
      socket.close();
    };
  }, [handleMessage]);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      ws.current?.close();
    };
  }, [connect]);

  const send = useCallback((data: unknown) => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify(data));
    }
  }, []);

  return { send };
}
