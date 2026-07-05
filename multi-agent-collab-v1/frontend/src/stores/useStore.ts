import { create } from 'zustand';
import type { Agent, Task, Message, RepoFile, Metric, ChatRoom } from '../types';

interface AppState {
  agents: Agent[];
  tasks: Task[];
  messages: Message[];
  files: RepoFile[];
  metrics: Metric[];
  selectedAgent: Agent | null;
  selectedFile: RepoFile | null;
  activeRoom: 'group' | string;
  chatRooms: ChatRoom[];

  setAgents: (agents: Agent[]) => void;
  setTasks: (tasks: Task[]) => void;
  setMessages: (messages: Message[]) => void;
  setFiles: (files: RepoFile[]) => void;
  setMetrics: (metrics: Metric[]) => void;
  upsertAgent: (agent: Agent) => void;
  upsertTask: (task: Task) => void;
  upsertMessage: (message: Message) => void;
  upsertFile: (file: RepoFile) => void;
  upsertMetric: (metric: Metric) => void;
  removeAgent: (id: number) => void;
  removeTask: (id: number) => void;
  setSelectedAgent: (agent: Agent | null) => void;
  setSelectedFile: (file: RepoFile | null) => void;
  setActiveRoom: (room: string) => void;
  setChatRooms: (rooms: ChatRoom[]) => void;
}

export const useStore = create<AppState>((set) => ({
  agents: [],
  tasks: [],
  messages: [],
  files: [],
  metrics: [],
  selectedAgent: null,
  selectedFile: null,
  activeRoom: 'group',
  chatRooms: [],

  setAgents: (agents) => set({ agents }),
  setTasks: (tasks) => set({ tasks }),
  setMessages: (messages) => set({ messages }),
  setFiles: (files) => set({ files }),
  setMetrics: (metrics) => set({ metrics }),
  setActiveRoom: (activeRoom) => set({ activeRoom }),
  setChatRooms: (chatRooms) => set({ chatRooms }),

  upsertAgent: (agent) => set((state) => ({
    agents: state.agents.some(a => a.id === agent.id)
      ? state.agents.map(a => a.id === agent.id ? agent : a)
      : [...state.agents, agent]
  })),
  upsertTask: (task) => set((state) => ({
    tasks: state.tasks.some(t => t.id === task.id)
      ? state.tasks.map(t => t.id === task.id ? task : t)
      : [...state.tasks, task]
  })),
  upsertMessage: (message) => set((state) => ({
    messages: state.messages.some(m => m.id === message.id)
      ? state.messages.map(m => m.id === message.id ? message : m)
      : [...state.messages, message]
  })),
  upsertFile: (file) => set((state) => ({
    files: state.files.some(f => f.id === file.id)
      ? state.files.map(f => f.id === file.id ? file : f)
      : [...state.files, file]
  })),
  upsertMetric: (metric) => set((state) => ({
    metrics: state.metrics.some(m => m.id === metric.id)
      ? state.metrics.map(m => m.id === metric.id ? metric : m)
      : [...state.metrics, metric]
  })),
  removeAgent: (id) => set((state) => ({ agents: state.agents.filter(a => a.id !== id) })),
  removeTask: (id) => set((state) => ({ tasks: state.tasks.filter(t => t.id !== id) })),
  setSelectedAgent: (selectedAgent) => set({ selectedAgent }),
  setSelectedFile: (selectedFile) => set({ selectedFile }),
}));
