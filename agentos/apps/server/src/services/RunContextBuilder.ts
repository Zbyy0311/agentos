import type { MemorySearchInput, MemoryUsage } from '@agentos/shared';
import { MemoryRetriever } from './MemoryRetriever.js';

export const MAX_MEMORY_ITEMS = 5;
export const MAX_MEMORY_CHARACTERS = 6000;
export const MAX_SINGLE_MEMORY_CHARACTERS = 1800;

export interface RunContextResult {
  context: string;
  usages: MemoryUsage[];
}

export class RunContextBuilder {
  constructor(private readonly retriever: MemoryRetriever) {}

  async build(input: MemorySearchInput & { runId: string; workspaceRoot: string; memoryEnabled: boolean }): Promise<RunContextResult> {
    if (!input.memoryEnabled) return { context: '', usages: [] };
    const memories = await this.retriever.search(input.workspaceRoot, {
      ...input,
      limit: Math.min(MAX_MEMORY_ITEMS, input.limit),
      maxCharacters: Math.min(MAX_MEMORY_CHARACTERS, input.maxCharacters),
    });
    let usedCharacters = 0;
    const sections: string[] = [];
    const usages: MemoryUsage[] = [];
    for (const [index, item] of memories.entries()) {
      const remaining = MAX_MEMORY_CHARACTERS - usedCharacters;
      if (remaining <= 0) break;
      const body = `${item.memory.summary}\n${item.content}`.slice(0, Math.min(MAX_SINGLE_MEMORY_CHARACTERS, remaining));
      if (!body) continue;
      usedCharacters += body.length;
      sections.push(`### [${item.memory.type}] ${item.memory.title}\n${body}\n来源记忆：${item.memory.id}`);
      usages.push({ runId: input.runId, memoryId: item.memory.id, rank: index + 1, injectedCharacters: body.length, usedAt: new Date().toISOString() });
    }
    return sections.length ? { context: `## 与本次任务相关的项目记忆\n\n${sections.join('\n\n')}`, usages } : { context: '', usages: [] };
  }
}
