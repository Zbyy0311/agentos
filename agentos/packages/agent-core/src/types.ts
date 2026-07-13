import type { TaskLog, AgentStage, ThinkingEffort, Workspace } from '@agentos/shared';
import type { AgentImageAttachment } from './imageInput.js';

export interface AgentConfig {
  name: string;
  role: AgentStage;
  cliCommand: string;
  cliArgs: string[];
  env?: NodeJS.ProcessEnv;
  model?: string;
  thinkingEffort?: ThinkingEffort;
  imageAttachments?: AgentImageAttachment[];
}

export interface PipelineResult {
  success: boolean;
  logs: TaskLog[];
  error?: string;
}

export type ChunkCallback = (text: string, done: boolean) => void;
export type ActivityCallback = (source: 'stdout' | 'stderr') => void;

export type { Workspace };
