export type TaskStatus = 'pending' | 'running' | 'reviewing' | 'completed' | 'failed';

export type AgentRole = 'codex' | 'kimi' | 'opencode' | 'mimo';

export type AgentStage =
  | 'codex_manager'
  | 'kimi_worker'
  | 'opencode_reviewer'
  | 'codex_final_review';

export interface WorkspaceAgent {
  id: string;
  name: string;
  role: AgentRole;
  enabled: boolean;
  cliCommand: string;
  cliArgs: string[];
  model?: string;
}

export interface Workspace {
  id: string;
  name: string;
  rootPath: string;
  gitEnabled: boolean;
  memoryEnabled: boolean;
  agents: WorkspaceAgent[];
  lastOpenedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskItem {
  id: string;
  workspaceId: string;
  title: string;
  status: TaskStatus;
  currentAgent: AgentStage | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskLog {
  stage: AgentStage;
  agentName: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timestamp: string;
  duration: number;
}

export interface AgentResult {
  stage: AgentStage;
  agentName: string;
  success: boolean;
  message: string;
  log: TaskLog;
}

export interface TaskStatusResponse {
  task: TaskItem;
  logs: TaskLog[];
}

export interface ThinkingChunk {
  stage: AgentStage;
  agentName: string;
  text: string;
  done: boolean;
}
