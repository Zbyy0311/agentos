import { randomUUID } from 'node:crypto';
import type { AgentEventDraft, MemoryCandidate, MemoryCandidateStatus, MemoryType } from '@agentos/shared';
import { EventBus } from '../events/EventBus.js';
import { createAgentEvent } from '../events/createAgentEvent.js';
import { SqliteStore } from '../store/SqliteStore.js';
import { MemoryService } from './MemoryService.js';
import { MemoryExtractor, type MemoryExtractionInput } from './MemoryExtractor.js';

export interface GenerateMemoryCandidatesResult {
  candidates: MemoryCandidate[];
  outcome: 'created' | 'existing' | 'none';
  reason?: 'no_valuable_public_evidence';
}

export interface AcceptMemoryCandidateInput {
  title?: string;
  summary?: string;
  content?: string;
}

export class MemoryCandidateService {
  constructor(
    private readonly store: SqliteStore,
    private readonly memoryService = new MemoryService(store),
    private readonly extractor = new MemoryExtractor(),
    private readonly eventBus?: EventBus,
  ) {}

  list(workspaceId: string, status: MemoryCandidateStatus | 'all' = 'pending'): MemoryCandidate[] {
    if (!['pending', 'accepted', 'rejected', 'all'].includes(status)) throw new Error('Invalid memory candidate status');
    return this.store.listMemoryCandidates(workspaceId, status);
  }

  async generate(input: { workspaceId: string; workspaceRoot: string; runId: string; memoryEnabled: boolean; force?: boolean }): Promise<GenerateMemoryCandidatesResult> {
    if (!input.memoryEnabled) throw new Error('Workspace memory is disabled');
    const run = this.store.getRun(input.workspaceId, input.runId);
    if (!run) throw new Error('Run not found');
    if (run.status !== 'completed') throw new Error(`Run must be completed before generating candidates (status: ${run.status})`);
    const existing = this.store.listMemoryCandidates(input.workspaceId, 'pending').filter(candidate => candidate.runId === run.id);
    if (existing.length > 0) return { candidates: existing, outcome: 'existing' };

    const sourceMessage = this.store.getMessage(input.workspaceId, run.sourceMessageId);
    if (!sourceMessage) throw new Error('Run source message not found');
    const visibleReplies = this.store.listMessages(input.workspaceId, run.conversationId, 1000)
      .filter(message => message.id !== sourceMessage.id && message.createdAt >= sourceMessage.createdAt && message.senderType !== 'user')
      .map(message => message.content);
    const extractionInput: MemoryExtractionInput = {
      objective: sourceMessage.content,
      resultSummary: run.resultSummary ?? '',
      fileChanges: this.store.listRunFileChanges(input.workspaceId, run.id),
      visibleReplies,
    };
    const extraction = this.extractor.extract(extractionInput);
    const drafts = extraction.drafts;
    if (drafts.length === 0) {
      return extraction.reason === 'no_valuable_public_evidence'
        ? { candidates: [], outcome: 'none', reason: 'no_valuable_public_evidence' }
        : { candidates: [], outcome: 'none' };
    }
    const candidates: MemoryCandidate[] = [];
    for (const draft of drafts.slice(0, 3)) {
      if (draft.operation === 'ignore') continue;
      const now = new Date().toISOString();
      const candidate: MemoryCandidate = {
        id: randomUUID(), workspaceId: input.workspaceId, runId: run.id, type: draft.type,
        title: draft.title, summary: draft.summary, content: draft.content, confidence: draft.confidence,
        operation: draft.operation, conflictingMemoryIds: this.findConflicts(input.workspaceId, draft.type, draft.title, draft.summary),
        status: 'pending', createdAt: now,
      };
      this.store.createMemoryCandidate(candidate);
      await this.publishEvent(createAgentEvent({
        type: 'memory.candidate.created', workspaceId: input.workspaceId, conversationId: run.conversationId, runId: run.id,
        payload: { candidateId: candidate.id, type: candidate.type, title: candidate.title },
      }));
      candidates.push(candidate);
    }
    if (candidates.length === 0) {
      return extraction.reason === 'no_valuable_public_evidence'
        ? { candidates: [], outcome: 'none', reason: 'no_valuable_public_evidence' }
        : { candidates: [], outcome: 'none' };
    }
    return { candidates, outcome: 'created' };
  }

  async accept(workspaceId: string, workspaceRoot: string, memoryEnabled: boolean, candidateId: string, input: AcceptMemoryCandidateInput = {}): Promise<MemoryCandidate> {
    const candidate = this.store.getMemoryCandidate(workspaceId, candidateId);
    if (!candidate) throw new Error('Memory candidate not found');
    if (candidate.status !== 'pending') throw new Error('Memory candidate has already been reviewed');
    if (!memoryEnabled) throw new Error('Workspace memory is disabled');
    await this.memoryService.create({
      workspaceId, workspaceRoot, memoryEnabled,
      type: candidate.type,
      title: input.title ?? candidate.title,
      summary: input.summary ?? candidate.summary,
      content: input.content ?? candidate.content,
      confidence: candidate.confidence,
      sourceRunIds: [candidate.runId],
    });
    const accepted = this.store.updateMemoryCandidateStatus(workspaceId, candidateId, 'accepted');
    return accepted;
  }

  reject(workspaceId: string, candidateId: string): MemoryCandidate {
    return this.store.updateMemoryCandidateStatus(workspaceId, candidateId, 'rejected');
  }

  private findConflicts(workspaceId: string, type: MemoryType, title: string, summary: string): string[] {
    const matches = new Map<string, MemoryCandidate['id']>();
    for (const query of [title, summary]) {
      if (!query.trim()) continue;
      for (const memory of this.store.listMemories(workspaceId, { type, query, status: 'active', limit: 5 })) {
        matches.set(memory.id, memory.id);
        if (matches.size >= 5) return [...matches.values()];
      }
    }
    return [...matches.values()];
  }

  private async publishEvent(event: AgentEventDraft): Promise<void> {
    if (this.eventBus) await this.eventBus.publish(event);
  }
}
