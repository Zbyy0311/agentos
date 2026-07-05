import type { TaskLog, AgentStage, Workspace } from '@agentos/shared';

export interface AgentConfig {
  name: string;
  role: AgentStage;
  cliCommand: string;
  cliArgs: string[];
  model?: string;
}

export interface PipelineResult {
  success: boolean;
  logs: TaskLog[];
  error?: string;
}

export type ChunkCallback = (text: string, done: boolean) => void;

export type { Workspace };
