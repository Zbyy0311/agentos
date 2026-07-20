import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, resolve } from 'node:path';
import type { MemoryRecord, MemoryStatus, MemoryType } from '@agentos/shared';
import { SqliteStore } from '../store/SqliteStore.js';

const TYPE_DIRECTORIES: Record<MemoryType, string> = {
  overview: 'overview', convention: 'conventions', decision: 'decisions', experience: 'experiences',
};
const MEMORY_TYPES = new Set<MemoryType>(['overview', 'convention', 'decision', 'experience']);
const MEMORY_STATUSES = new Set<MemoryStatus>(['active', 'archived']);

export interface MemoryInput {
  workspaceId: string;
  workspaceRoot: string;
  memoryEnabled: boolean;
  type: MemoryType;
  title: string;
  summary: string;
  content: string;
  tags?: string[];
  relatedFiles?: string[];
  sourceRunIds?: string[];
  importance?: number;
  confidence?: number;
}

export interface MemoryUpdateInput extends Partial<Omit<MemoryInput, 'workspaceId' | 'workspaceRoot' | 'memoryEnabled' | 'content'>> {
  content?: string;
}

export interface MemoryDetails extends MemoryRecord {
  content: string;
}

export class MemoryService {
  constructor(private readonly store: SqliteStore) {}

  list(workspaceId: string, filter: { query?: string; type?: MemoryType; status?: MemoryStatus | 'all'; limit?: number } = {}): MemoryRecord[] {
    if (filter.type !== undefined && !MEMORY_TYPES.has(filter.type)) throw new Error('Invalid memory type');
    if (filter.status !== undefined && filter.status !== 'all' && !MEMORY_STATUSES.has(filter.status)) throw new Error('Invalid memory status');
    return this.store.listMemories(workspaceId, filter);
  }

  async get(workspaceId: string, workspaceRoot: string, memoryId: string): Promise<MemoryDetails | undefined> {
    const memory = this.store.getMemory(workspaceId, memoryId);
    if (!memory) return undefined;
    return { ...memory, content: await readMemoryFile(workspaceRoot, memory.contentPath) };
  }

  async create(input: MemoryInput): Promise<MemoryDetails> {
    assertMemoryEnabled(input.memoryEnabled);
    const normalized = normalizeMemoryInput(input);
    if (this.store.listMemories(input.workspaceId, { status: 'all', limit: 100 }).some(memory => memory.title.toLocaleLowerCase() === normalized.title.toLocaleLowerCase())) {
      throw new Error('Memory title already exists');
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    const contentPath = buildContentPath(normalized.type, id);
    const memory: MemoryRecord = { ...normalized, id, workspaceId: input.workspaceId, status: 'active', contentPath, createdAt: now, updatedAt: now };
    const absolutePath = safeResolve(input.workspaceRoot, contentPath);
    await atomicWrite(absolutePath, normalized.content);
    try {
      this.store.createMemory(memory, normalized.content);
    } catch (error) {
      this.store.deleteMemory(input.workspaceId, id);
      await rm(absolutePath, { force: true });
      throw error;
    }
    return { ...memory, content: normalized.content };
  }

  async update(workspaceId: string, workspaceRoot: string, memoryId: string, input: MemoryUpdateInput): Promise<MemoryDetails> {
    const current = this.store.getMemory(workspaceId, memoryId);
    if (!current) throw new Error('Memory not found');
    const currentContent = await readMemoryFile(workspaceRoot, current.contentPath);
    const normalized = normalizeMemoryInput({
      type: input.type ?? current.type, title: input.title ?? current.title, summary: input.summary ?? current.summary,
      content: input.content ?? currentContent, tags: input.tags ?? current.tags, relatedFiles: input.relatedFiles ?? current.relatedFiles,
      sourceRunIds: input.sourceRunIds ?? current.sourceRunIds, importance: input.importance ?? current.importance, confidence: input.confidence ?? current.confidence,
    });
    if (this.store.listMemories(workspaceId, { status: 'all', limit: 100 }).some(memory => memory.id !== memoryId && memory.title.toLocaleLowerCase() === normalized.title.toLocaleLowerCase())) {
      throw new Error('Memory title already exists');
    }
    const nextPath = buildContentPath(normalized.type, memoryId);
    const oldAbsolutePath = safeResolve(workspaceRoot, current.contentPath);
    const nextAbsolutePath = safeResolve(workspaceRoot, nextPath);
    const backupPath = `${oldAbsolutePath}.bak-${randomUUID()}`;
    await copyFile(oldAbsolutePath, backupPath);
    await atomicWrite(nextAbsolutePath, normalized.content);
    try {
      const updated = this.store.updateMemory(workspaceId, memoryId, {
        type: normalized.type, title: normalized.title, summary: normalized.summary, contentPath: nextPath,
        tags: normalized.tags, relatedFiles: normalized.relatedFiles, sourceRunIds: normalized.sourceRunIds,
        importance: normalized.importance, confidence: normalized.confidence,
      }, normalized.content);
      if (oldAbsolutePath !== nextAbsolutePath) await rm(oldAbsolutePath, { force: true });
      await rm(backupPath, { force: true });
      return { ...updated, content: normalized.content };
    } catch (error) {
      await rm(nextAbsolutePath, { force: true });
      await rename(backupPath, oldAbsolutePath).catch(() => undefined);
      throw error;
    }
  }

  archive(workspaceId: string, memoryId: string): MemoryRecord {
    const current = this.store.getMemory(workspaceId, memoryId);
    if (!current) throw new Error('Memory not found');
    return this.store.updateMemory(workspaceId, memoryId, { status: 'archived' });
  }
}

function normalizeMemoryInput(input: Pick<MemoryInput, 'type' | 'title' | 'summary' | 'content' | 'tags' | 'relatedFiles' | 'sourceRunIds' | 'importance' | 'confidence'>): Omit<MemoryRecord, 'id' | 'workspaceId' | 'status' | 'contentPath' | 'createdAt' | 'updatedAt'> & { content: string } {
  if (!MEMORY_TYPES.has(input.type)) throw new Error('Invalid memory type');
  const title = input.title.trim();
  if (!title || title.includes('/') || title.includes('\\') || title.includes('..')) throw new Error('Memory title is invalid');
  const summary = input.summary.trim();
  const content = input.content;
  if (!summary) throw new Error('Memory summary is required');
  if (typeof content !== 'string') throw new Error('Memory content is required');
  const importance = input.importance ?? 50;
  const confidence = input.confidence ?? 50;
  if (!Number.isInteger(importance) || importance < 0 || importance > 100) throw new Error('importance must be between 0 and 100');
  if (!Number.isInteger(confidence) || confidence < 0 || confidence > 100) throw new Error('confidence must be between 0 and 100');
  const tags = normalizeList(input.tags ?? [], 'tag');
  const relatedFiles = normalizeRelativeList(input.relatedFiles ?? []);
  const sourceRunIds = normalizeList(input.sourceRunIds ?? [], 'source run');
  return { type: input.type, title, summary, content, tags, relatedFiles, sourceRunIds, importance, confidence };
}

function normalizeList(values: string[], label: string): string[] {
  if (!Array.isArray(values) || values.some(value => typeof value !== 'string')) throw new Error(`${label} list is invalid`);
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function normalizeRelativeList(values: string[]): string[] {
  return normalizeList(values, 'related file').map(value => {
    const normalized = normalize(value).replaceAll('\\', '/');
    if (isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) throw new Error('related file path escapes workspace');
    return relative('.', normalized).replaceAll('\\', '/') || normalized;
  });
}

function buildContentPath(type: MemoryType, id: string): string {
  return `agent-memory/records/${TYPE_DIRECTORIES[type]}/${id}.md`;
}

function safeResolve(workspaceRoot: string, contentPath: string): string {
  const root = resolve(workspaceRoot);
  const target = resolve(root, contentPath);
  const rel = relative(root, target);
  if (!rel || rel === '..' || rel.startsWith(`..${normalize('/')}`) || isAbsolute(rel)) throw new Error('Memory path escapes workspace');
  return target;
}

async function atomicWrite(target: string, content: string): Promise<void> {
  await mkdir(join(target, '..'), { recursive: true });
  const temporary = `${target}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, content, 'utf8');
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function readMemoryFile(workspaceRoot: string, contentPath: string): Promise<string> {
  return readFile(safeResolve(workspaceRoot, contentPath), 'utf8');
}

function assertMemoryEnabled(enabled: boolean): void {
  if (!enabled) throw new Error('Workspace memory is disabled');
}
