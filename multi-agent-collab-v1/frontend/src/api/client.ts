import axios from 'axios';
import type { Agent, Task, Message, RepoFile, Metric } from '../types';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || '/api',
  headers: {
    'Content-Type': 'application/json',
  },
});

export const agentsApi = {
  list: () => api.get<Agent[]>('/agents/').then(r => r.data),
  create: (data: Partial<Agent>) => api.post<Agent>('/agents/', data).then(r => r.data),
  update: (id: number, data: Partial<Agent>) => api.patch<Agent>(`/agents/${id}`, data).then(r => r.data),
  remove: (id: number) => api.delete(`/agents/${id}`),
};

export const tasksApi = {
  list: () => api.get<Task[]>('/tasks/').then(r => r.data),
  create: (data: Partial<Task>) => api.post<Task>('/tasks/', data).then(r => r.data),
  update: (id: number, data: Partial<Task>) => api.patch<Task>(`/tasks/${id}`, data).then(r => r.data),
  remove: (id: number) => api.delete(`/tasks/${id}`),
};

export const messagesApi = {
  list: (limit = 100, room?: string) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (room) params.set('room', room);
    return api.get<Message[]>(`/messages/?${params}`).then(r => r.data);
  },
  create: (data: Partial<Message>) => api.post<Message>('/messages/', data).then(r => r.data),
};

export const filesApi = {
  list: () => api.get<RepoFile[]>('/files/').then(r => r.data),
  upsert: (data: Partial<RepoFile>) => api.post<RepoFile>('/files/', data).then(r => r.data),
};

export const metricsApi = {
  list: () => api.get<Metric[]>('/metrics/').then(r => r.data),
  create: (data: Partial<Metric>) => api.post<Metric>('/metrics/', data).then(r => r.data),
};

export const demoApi = {
  run: () => api.post('/demo/run'),
};

export default api;
