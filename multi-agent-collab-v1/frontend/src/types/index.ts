export type AgentStatus = 'idle' | 'working' | 'waiting';

export interface Agent {
  id: number;
  name: string;
  role: string;
  avatar?: string;
  status: AgentStatus;
  skills: string[];
  current_task_id?: number;
  progress: number;
  last_active_at: string;
  created_at: string;
}

export type TaskStatus = 'todo' | 'in_progress' | 'in_review' | 'done';

export interface Task {
  id: number;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: 'low' | 'medium' | 'high';
  assignee_id?: number;
  dependencies: number[];
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: number;
  agent_id?: number;
  agent_name?: string;
  role?: string;
  action: string;
  target: string;
  room: string;
  content: string;
  deliverables: string[];
  next_steps: string[];
  created_at: string;
}

export type ChatRoom = { type: 'group'; name: '群聊'; id: '__group__' } | { type: 'agent'; agent: Agent };

export interface RepoFile {
  id: number;
  path: string;
  content?: string;
  agent_id?: number;
  agent_name?: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface Metric {
  id: number;
  agent_id?: number;
  response_time_ms: number;
  lines_of_code: number;
  warnings: number;
  errors: number;
  health_score: number;
  recorded_at: string;
}

export interface WSMessage {
  type: string;
  payload: unknown;
}

export const AGENT_COLORS: Record<string, string> = {
  Codex: 'bg-agent-codex',
  KimiCode: 'bg-agent-kimi',
  MimoCode: 'bg-agent-mimo',
  OpenCode: 'bg-agent-open',
  Reasonix: 'bg-agent-reasonix',
};

export const STATUS_COLORS: Record<string, string> = {
  idle: 'bg-emerald-100 text-emerald-700',
  working: 'bg-blue-100 text-blue-700',
  waiting: 'bg-amber-100 text-amber-700',
  todo: 'bg-slate-100 text-slate-600',
  in_progress: 'bg-blue-100 text-blue-700',
  in_review: 'bg-purple-100 text-purple-700',
  done: 'bg-green-100 text-green-700',
};
