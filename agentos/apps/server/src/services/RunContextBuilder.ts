import type { MemorySearchInput, MemoryUsage } from '@agentos/shared';
import { MemoryRetriever } from './MemoryRetriever.js';
import type { MemoryRetrievalService } from './MemoryRetrievalService.js';
import { applyBudget, injectedEntryText, RETRIEVAL_STRATEGY_VERSION_V1 } from './MemoryContextBudgetSelector.js';
import { withMemorySemanticStrategyVersion } from './MemoryRetrievalService.js';
import { MEMORY_RELEVANCE_POLICY } from './MemoryLexicalIndex.js';
import { CHAT_MEMORY_RETRIEVAL_LIMIT, DEFAULT_CHAT_MEMORY_BUDGET } from './ChatMemorySelectionPort.js';
import { createHash } from 'node:crypto';
import type { ExecutionMemorySelection } from '../store/MemoryExecutionContextRepository.js';

export const MAX_MEMORY_ITEMS = 5;
export const MAX_MEMORY_CHARACTERS = 6000;
export const MAX_SINGLE_MEMORY_CHARACTERS = 1800;

export interface RunContextResult {
  context: string;
  usages: MemoryUsage[];
  /** Read-only canonical attribution, never written to legacy memory_usages. */
  entryUsages?: readonly {
    readonly entryId: string;
    readonly version: number;
    /** One-based position in the combined, actually injected context. */
    readonly rank: number;
    readonly injectedCharacters: number;
  }[];
  /** MF-3 structured ranking ran without usable FTS ranking. Errors still propagate. */
  retrievalDegraded?: boolean;
  /** Optional semantic degradation cause; the frozen strategy also carries it. */
  retrievalDegradedReason?: string;
  selection?: {
    queryHash: string;
    retrievalStrategyVersion?: string;
    selected: readonly ExecutionMemorySelection[];
    exclusions: readonly { memoryId: string; memoryVersion?: number; reason: string }[];
    truncated: boolean;
  };
}

export class RunContextBuilder {
  constructor(
    private readonly retriever: MemoryRetriever,
    private readonly entryRetriever?: MemoryRetrievalService,
    private readonly isMemoryEnabled?: (workspaceId: string) => boolean,
  ) {}

  async build(input: MemorySearchInput & {
    runId: string;
    workspaceRoot: string;
    memoryEnabled: boolean;
    agentId?: string;
    conversationId?: string;
  }): Promise<RunContextResult> {
    const entryUsages: NonNullable<RunContextResult['entryUsages']>[number][] = [];
    const empty = { context: '', usages: [], ...(this.entryRetriever ? { entryUsages } : {}) };
    const memoryEnabled = () => input.memoryEnabled && (this.isMemoryEnabled?.(input.workspaceId) ?? true);
    const disabled = (): RunContextResult => ({
      ...empty,
      ...(this.entryRetriever ? {
        entryUsages: [],
        retrievalDegraded: false,
        selection: {
          queryHash: createHash('sha256').update(input.query.slice(0, 2000)).digest('hex'),
          retrievalStrategyVersion: `${RETRIEVAL_STRATEGY_VERSION_V1}+memory-disabled`,
          selected: [], exclusions: [], truncated: false,
        },
      } : {}),
    });
    if (!memoryEnabled()) return disabled();
    const itemLimit = Math.max(0, Math.min(MAX_MEMORY_ITEMS, Math.floor(input.limit)));
    const characterLimit = Math.max(0, Math.min(MAX_MEMORY_CHARACTERS, Math.floor(input.maxCharacters)));
    if (!(itemLimit > 0) || !(characterLimit > 0)) return empty;
    const heading = '历史记忆只提供背景；与当前用户明确指令冲突时，当前指令优先。\n## 与本次任务相关的项目记忆\n\n';
    let usedCharacters = 0;
    const sections: string[] = [];
    const usages: MemoryUsage[] = [];
    const remainingCharacters = () => characterLimit - usedCharacters - (sections.length ? 2 : heading.length);
    const append = (section: string) => {
      usedCharacters += section.length + (sections.length ? 2 : heading.length);
      sections.push(section);
    };
    let retrievalDegraded: boolean | undefined;
    let retrievalDegradedReason: string | undefined;
    let retrievalStrategyVersion: string | undefined;
    const selectedRecords: ExecutionMemorySelection[] = [];
    const excludedRecords: { memoryId: string; memoryVersion?: number; reason: string }[] = [];
    let truncated = false;

    if (this.entryRetriever) {
      // A legacy AgentRun UUID is not a canonical Task/Run ownership claim.
      const retrieval = await this.entryRetriever.retrievePrepared({
        context: {
          workspaceId: input.workspaceId,
          ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
          ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
        },
        query: input.query.slice(0, 2000),
        limit: CHAT_MEMORY_RETRIEVAL_LIMIT,
        selectionPolicy: MEMORY_RELEVANCE_POLICY,
      });
      if (!memoryEnabled()) return disabled();
      retrievalDegraded = retrieval.degraded;
      retrievalDegradedReason = retrieval.semantic?.degraded ? retrieval.semantic.reason : undefined;
      retrievalStrategyVersion = withMemorySemanticStrategyVersion(RETRIEVAL_STRATEGY_VERSION_V1, retrieval);
      const outcome = applyBudget(retrieval.results, {
        ...DEFAULT_CHAT_MEMORY_BUDGET,
        maxEntries: Math.min(DEFAULT_CHAT_MEMORY_BUDGET.maxEntries, itemLimit),
      });
      excludedRecords.push(...(retrieval.exclusions ?? []), ...outcome.exclusions);
      truncated = outcome.truncated;
      for (const selected of outcome.selected) {
        const remaining = remainingCharacters();
        if (sections.length >= itemLimit || remaining <= 0) {
          excludedRecords.push({ memoryId: selected.entry.id, memoryVersion: selected.entry.version, reason: 'character-budget' });
          continue;
        }
        const text = injectedEntryText(selected.entry).slice(0, Math.min(MAX_SINGLE_MEMORY_CHARACTERS, remaining));
        if (!text) continue;
        const wasTruncated = text !== injectedEntryText(selected.entry);
        truncated ||= wasTruncated;
        append(text);
        selectedRecords.push({ memoryId: selected.entry.id, memoryVersion: selected.entry.version,
          store: 'canonical', rank: sections.length, tokenCost: Math.ceil(text.length / 4),
          reasons: [...selected.explanation.reasons, ...(wasTruncated ? ['character-truncated'] : [])] });
        entryUsages.push({
          entryId: selected.entry.id,
          version: selected.explanation.memoryVersion,
          rank: sections.length,
          injectedCharacters: text.length,
        });
      }
    }

    // The compatibility store can only fill the capacity left by canonical Entries.
    const remainingItems = itemLimit - sections.length;
    const memories = remainingItems > 0 && remainingCharacters() > 0
      ? await this.retriever.search(input.workspaceRoot, {
        ...input,
        ...(this.entryRetriever ? { selectionPolicy: MEMORY_RELEVANCE_POLICY } : {}),
        limit: remainingItems,
        maxCharacters: remainingCharacters(),
      })
      : [];
    if (!memoryEnabled()) return disabled();
    for (const [index, item] of memories.entries()) {
      const remaining = remainingCharacters();
      if (sections.length >= itemLimit || remaining <= 0) break;
      const prefix = `### [${item.memory.type}] ${item.memory.title}\n`;
      const suffix = `\n来源记忆：${item.memory.id}`;
      const bodyLimit = Math.min(MAX_SINGLE_MEMORY_CHARACTERS, remaining) - prefix.length - suffix.length;
      if (bodyLimit <= 0) continue;
      const body = `${item.memory.summary}\n${item.content}`.slice(0, bodyLimit);
      if (!body) continue;
      const text = `${prefix}${body}${suffix}`;
      append(text);
      truncated ||= body.length < `${item.memory.summary}\n${item.content}`.length;
      selectedRecords.push({ memoryId: item.memory.id, memoryVersion: null, store: 'legacy',
        rank: sections.length, tokenCost: Math.ceil(text.length / 4), reasons: ['legacy-fallback', ...(item.reasons ?? [])] });
      usages.push({ runId: input.runId, memoryId: item.memory.id, rank: this.entryRetriever ? sections.length : index + 1,
        injectedCharacters: text.length, usedAt: new Date().toISOString() });
    }
    return {
      context: sections.length ? `${heading}${sections.join('\n\n')}` : '',
      usages,
      ...(this.entryRetriever ? {
        entryUsages,
        retrievalDegraded,
        ...(retrievalDegradedReason === undefined ? {} : { retrievalDegradedReason }),
      } : {}),
      selection: {
        queryHash: createHash('sha256').update(input.query.slice(0, 2000)).digest('hex'),
        ...(retrievalStrategyVersion === undefined ? {} : { retrievalStrategyVersion }),
        selected: selectedRecords, exclusions: excludedRecords, truncated,
      },
    };
  }
}
