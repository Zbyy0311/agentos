import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CLIExecutor } from './executor.js';
import { AGENT_CONFIGS } from './config.js';
import type { Workspace, AgentConfig, PipelineResult, ChunkCallback } from './types.js';
import type { TaskLog, AgentStage } from '@agentos/shared';

const STAGE_ROLE_MAP: Record<AgentStage, import('@agentos/shared').AgentRole> = {
  codex_manager: 'codex',
  kimi_worker: 'kimi',
  opencode_reviewer: 'opencode',
  codex_final_review: 'codex',
};

export class AgentRunner {
  private workspace: Workspace;
  private taskId: string;
  private taskTitle: string;
  private logs: TaskLog[] = [];
  private onChunk?: ChunkCallback;
  private signal?: AbortSignal;

  constructor(workspace: Workspace, taskId: string, taskTitle: string, onChunk?: ChunkCallback, opts?: { signal?: AbortSignal }) {
    this.workspace = workspace;
    this.taskId = taskId;
    this.taskTitle = taskTitle;
    this.onChunk = onChunk;
    this.signal = opts?.signal;
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
        cliArgs: workspaceAgent.cliArgs,
        model: workspaceAgent.model,
      };
    }
    return AGENT_CONFIGS[stage];
  }

  private async readMemory(): Promise<string> {
    const memoryFiles = [
      'PROJECT.md',
      'TASKS.md',
      'DECISIONS.md',
      'LOG.md',
      'KNOWLEDGE.md',
      'REVIEW.md',
      'TEST.md',
    ];
    const parts: string[] = [];
    for (const file of memoryFiles) {
      try {
        const content = await readFile(join(this.workspaceRoot, 'agent-memory', file), 'utf-8');
        parts.push(`--- ${file} ---\n${content}`);
      } catch {
        parts.push(`--- ${file} ---\n(file not found)`);
      }
    }
    return parts.join('\n\n');
  }

  private async readAgentRules(): Promise<string> {
    try {
      return await readFile(join(this.workspaceRoot, 'docs', 'AGENT_RULE.md'), 'utf-8');
    } catch {
      return '(AGENT_RULE.md not found)';
    }
  }

  private async buildContextForStage(stage: AgentStage, previousLogs: TaskLog[]): Promise<string> {
    const memory = await this.readMemory();
    const rules = await this.readAgentRules();
    const previousOutput = previousLogs
      .map(l => `[${l.stage}] ${l.agentName}:\n${l.stdout}`)
      .join('\n\n');

    return [
      `## Task ID: ${this.taskId}`,
      `## Task Title: ${this.taskTitle}`,
      ``,
      `## Current Stage: ${stage}`,
      ``,
      `## Project Memory`,
      memory,
      ``,
      `## Agent Rules`,
      rules,
      ``,
      previousOutput ? `## Previous Agent Output\n${previousOutput}` : '',
      ``,
      `## Instructions`,
      `Execute your role as defined in AGENT_RULE.md.`,
      `Output your analysis, decisions, and any code changes.`,
    ].join('\n');
  }

  async runCodexManager(): Promise<TaskLog> {
    const context = await this.buildContextForStage('codex_manager', []);
    const prompt = [
      `You are Codex, the Manager Agent.`,
      `Your role is to analyze the task, break it into subtasks, assess risks, and decide the approach.`,
      ``,
      context,
      ``,
      `## Output Requirements`,
      `1. Task Understanding`,
      `2. Subtask Breakdown`,
      `3. Risk Assessment`,
      `4. Next Steps`,
      `5. Decision`,
    ].join('\n');

    return this.executeAndRecord('codex_manager', prompt);
  }

  async runKimiWorker(): Promise<TaskLog> {
    const context = await this.buildContextForStage('kimi_worker', this.logs);
    const prompt = [
      `You are KimiCode, the Worker Agent.`,
      `Your role is to implement the code based on Codex's plan.`,
      ``,
      context,
      ``,
      `## Output Requirements`,
      `1. Implementation Plan`,
      `2. Code Changes`,
      `3. Files Modified`,
      `4. Notes for Reviewer`,
    ].join('\n');

    return this.executeAndRecord('kimi_worker', prompt);
  }

  async runOpenCodeReviewer(): Promise<TaskLog> {
    const context = await this.buildContextForStage('opencode_reviewer', this.logs);
    const prompt = [
      `You are OpenCode, the Reviewer Agent.`,
      `Your role is to review the implementation for quality, security, and correctness.`,
      ``,
      context,
      ``,
      `## Output Requirements`,
      `1. Quality Check (checklist)`,
      `2. Risks Found`,
      `3. Score (1-10)`,
      `4. Recommendations`,
    ].join('\n');

    return this.executeAndRecord('opencode_reviewer', prompt);
  }

  async runCodexFinalReview(): Promise<TaskLog> {
    const context = await this.buildContextForStage('codex_final_review', this.logs);
    const prompt = [
      `You are Codex, the Manager Agent — Final Review.`,
      `Your role is to make the final decision on whether to accept the work.`,
      ``,
      context,
      ``,
      `## Output Requirements`,
      `1. Summary of Work Done`,
      `2. Review of OpenCode's Findings`,
      `3. Final Decision (Approve / Reject / Modify)`,
      `4. Next Steps`,
    ].join('\n');

    return this.executeAndRecord('codex_final_review', prompt);
  }

  private async executeAndRecord(stage: AgentStage, prompt: string): Promise<TaskLog> {
    const log = await CLIExecutor.execute(
      this.getAgentConfig(stage),
      prompt,
      { workspaceRoot: this.workspaceRoot, taskId: this.taskId, onChunk: this.onChunk, signal: this.signal },
    );
    this.logs.push(log);
    return log;
  }

  getLogs(): TaskLog[] {
    return this.logs;
  }
}
