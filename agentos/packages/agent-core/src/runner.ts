import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CLIExecutor } from './executor.js';
import { AGENT_CONFIGS, STAGE_ROLE_MAP } from './config.js';
import { buildPreviousOutput, buildStageInstructions, buildStagePrompt } from './prompts.js';
import type { Workspace, AgentConfig, PipelineResult, ChunkCallback, ActivityCallback } from './types.js';
import type { TaskLog, AgentStage } from '@agentos/shared';

export interface MemoryFileSection {
  file: string;
  content?: string;
}

export type MemoryFileReader = (path: string, encoding: 'utf-8') => Promise<string>;

export async function readMemoryFiles(
  workspaceRoot: string,
  memoryFiles: readonly string[],
  readTextFile: MemoryFileReader = (path, encoding) => readFile(path, encoding),
): Promise<MemoryFileSection[]> {
  return Promise.all(memoryFiles.map(async file => {
    try {
      return { file, content: await readTextFile(join(workspaceRoot, 'agent-memory', file), 'utf-8') };
    } catch {
      return { file };
    }
  }));
}

export class AgentRunner {
  private workspace: Workspace;
  private taskId: string;
  private taskTitle: string;
  private logs: TaskLog[] = [];
  private onChunk?: ChunkCallback;
  private onActivity?: ActivityCallback;
  private signal?: AbortSignal;

  constructor(workspace: Workspace, taskId: string, taskTitle: string, onChunk?: ChunkCallback, opts?: { signal?: AbortSignal; onActivity?: ActivityCallback }) {
    this.workspace = workspace;
    this.taskId = taskId;
    this.taskTitle = taskTitle;
    this.onChunk = onChunk;
    this.signal = opts?.signal;
    this.onActivity = opts?.onActivity;
  }

  async runFullPipeline(): Promise<PipelineResult> {
    try {
      await this.runCodexManager();
      await this.runKimiWorker();
      await this.runOpenCodeReviewer();
      await this.runCodexFinalReview();

      return { success: true, logs: this.logs };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return { success: false, logs: this.logs, error: errorMessage };
    }
  }

  private get workspaceRoot(): string {
    return this.workspace.rootPath;
  }

  private getAgentConfig(stage: AgentStage): AgentConfig {
    const role = STAGE_ROLE_MAP[stage];
    const workspaceAgent = this.workspace.agents.find(a => a.role === role && a.enabled);
    if (workspaceAgent) {
      return {
        name: workspaceAgent.name,
        role: stage,
        cliCommand: workspaceAgent.cliCommand,
        cliArgs: [...workspaceAgent.cliArgs],
        model: workspaceAgent.model,
        thinkingEffort: workspaceAgent.thinkingEffort ?? 'auto',
      };
    }
    const defaults = AGENT_CONFIGS[stage];
    return {
      ...defaults,
      cliArgs: [...defaults.cliArgs],
      thinkingEffort: defaults.thinkingEffort ?? 'auto',
    };
  }

  getStageAgentName(stage: AgentStage): string {
    return this.getAgentConfig(stage).name;
  }

  private memoryFilesForStage(stage: AgentStage): string[] {
    switch (stage) {
      case 'codex_manager':
        return ['PROJECT.md', 'TASKS.md', 'DECISIONS.md', 'KNOWLEDGE.md', 'TEST.md'];
      case 'kimi_worker':
        return ['PROJECT.md', 'DECISIONS.md', 'KNOWLEDGE.md', 'TEST.md'];
      case 'opencode_reviewer':
        return ['PROJECT.md', 'DECISIONS.md', 'REVIEW.md', 'TEST.md'];
      case 'codex_final_review':
        return ['PROJECT.md', 'DECISIONS.md', 'REVIEW.md', 'TEST.md'];
    }
  }

  private trimSection(content: string, maxChars: number): string {
    if (content.length <= maxChars) return content;
    return `${content.slice(0, maxChars)}\n...(truncated)`;
  }

  private async readMemory(stage: AgentStage): Promise<string> {
    const memoryFiles = this.memoryFilesForStage(stage);
    const sections = await readMemoryFiles(this.workspaceRoot, memoryFiles);
    return sections.map(({ file, content }) => {
      if (content === undefined) return `--- ${file} ---\n(file not found)`;
      const maxChars = file === 'TASKS.md' ? 3000 : 2000;
      return `--- ${file} ---\n${this.trimSection(content, maxChars)}`;
    }).join('\n\n');
  }

  private async readAgentRules(): Promise<string> {
    try {
      return await readFile(join(this.workspaceRoot, 'docs', 'AGENT_RULE.md'), 'utf-8');
    } catch {
      return '(AGENT_RULE.md not found)';
    }
  }

  private async buildContextForStage(stage: AgentStage, previousLogs: TaskLog[]): Promise<string> {
    const memory = await this.readMemory(stage);
    const rules = await this.readAgentRules();
    const previousOutput = buildPreviousOutput(stage, previousLogs, this.trimSection.bind(this));

    return [
      `## Task ID: ${this.taskId}`,
      `## Task Title: ${this.taskTitle}`,
      '',
      `## Current Stage: ${stage}`,
      '',
      `## Project Memory`,
      memory,
      '',
      `## Agent Rules`,
      rules,
      '',
      previousOutput ? `## Previous Agent Output\n${previousOutput}` : '',
      '',
      `## Instructions`,
      `Execute your role as defined in AGENT_RULE.md.`,
      `Output your analysis, decisions, and any code changes.`,
      ...buildStageInstructions(stage),
    ].join('\n');
  }

  async runCodexManager(): Promise<TaskLog> {
    const context = await this.buildContextForStage('codex_manager', []);
    return this.executeAndRecord('codex_manager', buildStagePrompt('codex_manager', context));
  }

  async runKimiWorker(): Promise<TaskLog> {
    const context = await this.buildContextForStage('kimi_worker', this.logs);
    return this.executeAndRecord('kimi_worker', buildStagePrompt('kimi_worker', context));
  }

  async runOpenCodeReviewer(): Promise<TaskLog> {
    const context = await this.buildContextForStage('opencode_reviewer', this.logs);
    return this.executeAndRecord('opencode_reviewer', buildStagePrompt('opencode_reviewer', context));
  }

  async runCodexFinalReview(): Promise<TaskLog> {
    const context = await this.buildContextForStage('codex_final_review', this.logs);
    return this.executeAndRecord('codex_final_review', buildStagePrompt('codex_final_review', context));
  }

  private async executeAndRecord(stage: AgentStage, prompt: string): Promise<TaskLog> {
    const log = await CLIExecutor.execute(
      this.getAgentConfig(stage),
      prompt,
      { workspaceRoot: this.workspaceRoot, taskId: this.taskId, onChunk: this.onChunk, onActivity: this.onActivity, signal: this.signal },
    );
    this.logs.push(log);
    return log;
  }

  getLogs(): TaskLog[] {
    return this.logs;
  }
}
