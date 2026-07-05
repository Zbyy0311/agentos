import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CLIExecutor } from './executor.js';
import { AGENT_CONFIGS } from './config.js';
import type { PipelineResult, ChunkCallback } from './types.js';
import type { TaskLog, AgentStage } from '@agentos/shared';

export class AgentRunner {
  private workspaceRoot: string;
  private taskId: string;
  private taskTitle: string;
  private logs: TaskLog[] = [];
  private onChunk?: ChunkCallback;

  constructor(workspaceRoot: string, taskId: string, taskTitle: string, onChunk?: ChunkCallback) {
    this.workspaceRoot = workspaceRoot;
    this.taskId = taskId;
    this.taskTitle = taskTitle;
    this.onChunk = onChunk;
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

  private async buildContextForStage(stage: AgentStage, previousLogs: TaskLog[]): Promise<string> {
    const memory = await this.readMemory();
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
      previousOutput ? `## Previous Agent Output\n${previousOutput}` : '',
      ``,
      `## Instructions`,
      `Execute your role as defined in AGENT_MANAGER.md.`,
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
      AGENT_CONFIGS[stage],
      prompt,
      { workspaceRoot: this.workspaceRoot, taskId: this.taskId, onChunk: this.onChunk },
    );
    this.logs.push(log);
    return log;
  }

  getLogs(): TaskLog[] {
    return this.logs;
  }
}
