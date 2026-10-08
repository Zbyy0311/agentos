import { execFileSync } from 'node:child_process';
import { extname, join, relative, resolve, sep } from 'node:path';
import type { RuntimeArtifact, RunFileChange } from '@agentos/shared';
import type { NormalizedCliEvent } from '@agentos/agent-core';
import { redactRuntimeText } from '@agentos/agent-core';
import { RuntimeArtifactService } from './RuntimeArtifactService.js';

export interface ArtifactCollectionContext {
  workspaceId: string;
  workspaceRoot: string;
  runId: string;
  sourceExecutionId: string;
  agentId: string;
}

interface Baseline {
  head: string | null;
  dirty: boolean;
}

interface ToolObservation {
  toolName: string;
  command?: string;
  startedAt: number;
}

interface CollectionState {
  baseline: Baseline;
  events: NormalizedCliEvent[];
  tools: Map<string, ToolObservation>;
  dedupe: Set<string>;
}

type ArtifactCreatedCallback = (artifact: RuntimeArtifact) => void;

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

export class RuntimeArtifactCollector {
  private readonly runs = new Map<string, CollectionState>();

  constructor(
    private readonly service: RuntimeArtifactService,
    private readonly onCreated?: ArtifactCreatedCallback,
  ) {}

  start(context: ArtifactCollectionContext): void {
    if (this.runs.has(this.key(context))) return;
    this.runs.set(this.key(context), {
      baseline: captureBaseline(context.workspaceRoot),
      events: [],
      tools: new Map(),
      dedupe: new Set(),
    });
  }

  async recordRuntimeEvent(context: ArtifactCollectionContext, event: NormalizedCliEvent): Promise<void> {
    const state = this.state(context);
    state.events.push(publicEvent(event));
    if (event.type === 'tool.started') {
      state.tools.set(event.callId, {
        toolName: event.toolName,
        command: event.inputPreview ?? event.summary,
        startedAt: Date.now(),
      });
      return;
    }
    if (event.type !== 'tool.completed') return;
    const started = state.tools.get(event.callId);
    // Completed command evidence survives retries without a repeated start.
    // Retain the bounded observation until finalize so failed persistence can retry.
    const evidence = event.commandResult;
    const command = evidence?.command ?? extractCommand(started?.command);
    if (!command || !isTestCommand(command)) return;
    const finalTest = evidence !== undefined && Number.isSafeInteger(evidence.exitCode) &&
      event.success === (evidence.exitCode === 0) && isDirectTestCommand(command);
    const status = finalTest ? (event.success ? 'passed' : 'failed') : 'verdict unverified';
    const report = [
      `Command: ${command}`,
      `Status: ${status}`,
      event.outputPreview ?? event.summary,
    ].filter(Boolean).join('\n');
    await this.create(context, {
      type: finalTest ? 'test' : 'report',
      title: event.success ? 'Test report' : 'Test failure report',
      summary: redactRuntimeText(`${command} ${status}`, 512),
      source: { kind: 'text', content: redactRuntimeText(report, 8192) },
      ...(finalTest ? { completion: {
        conclusion: event.success ? 'pass' as const : 'fail' as const,
        sourceKey: `execution:${context.sourceExecutionId}:tool:${event.callId}`,
      } } : {}),
    });
  }

  async collectFileChanges(context: ArtifactCollectionContext, changes: Array<Omit<RunFileChange, 'runId'>>): Promise<void> {
    for (const change of changes) {
      const originalPath = normalizeRelativePath(change.path);
      if (!originalPath) continue;
      const absolutePath = resolve(context.workspaceRoot, originalPath);
      const type = IMAGE_EXTENSIONS.has(extname(originalPath).toLowerCase()) ? 'image' : 'file';
      if (change.changeType === 'deleted') {
        await this.create(context, {
          type,
          title: originalPath,
          summary: 'File was deleted during execution',
          originalPath,
          source: { kind: 'reference', originalPath },
        });
      } else {
        await this.create(context, {
          type,
          title: originalPath,
          originalPath,
          source: { kind: 'workspace-file', absolutePath },
        });
      }
    }
  }

  async finalize(context: ArtifactCollectionContext): Promise<void> {
    const state = this.state(context);
    if (!state.baseline.dirty && state.baseline.head) {
      const diff = readGitDiff(context.workspaceRoot, state.baseline.head);
      if (diff.trim()) {
        await this.create(context, {
          type: 'diff',
          title: 'Workspace diff',
          summary: 'Changes compared with the clean execution baseline',
          source: { kind: 'text', content: diff },
        });
      }
    } else {
      state.events.push({
        type: 'diagnostic',
        level: 'warning',
        code: 'artifact.diff_skipped_dirty_baseline',
        message: 'Workspace baseline was already dirty; diff artifact was skipped',
      });
    }
    const log = state.events.map(formatPublicEvent).filter(Boolean).join('\n');
    if (log.trim()) {
      await this.create(context, {
        type: 'log',
        title: 'Execution log',
        summary: 'Normalized public runtime events',
        source: { kind: 'text', content: log },
      });
    }
    this.runs.delete(this.key(context));
  }

  private state(context: ArtifactCollectionContext): CollectionState {
    const existing = this.runs.get(this.key(context));
    if (existing) return existing;
    this.start(context);
    return this.runs.get(this.key(context))!;
  }

  private async create(context: ArtifactCollectionContext, input: Omit<Parameters<RuntimeArtifactService['create']>[0], keyof ArtifactCollectionContext | 'workspaceId' | 'workspaceRoot' | 'runId' | 'sourceExecutionId' | 'agentId'>): Promise<void> {
    const state = this.state(context);
    const key = input.completion?.sourceKey ?? `${input.type}:${input.originalPath ?? input.title}:${input.source.kind === 'text' ? hashText(input.source.content) : input.source.kind}`;
    if (!input.completion && state.dedupe.has(key)) return;
    const artifact = await this.service.create({
      ...context,
      ...input,
    });
    // Failed persistence must be retryable; do not remember uncommitted work.
    const alreadyNotified = state.dedupe.has(key);
    state.dedupe.add(key);
    if (!alreadyNotified) this.onCreated?.(artifact);
  }

  private key(context: ArtifactCollectionContext): string {
    return `${context.workspaceId}:${context.runId}`;
  }
}

function extractCommand(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  const withoutToolName = normalized.replace(/^[A-Za-z0-9_.-]+:\s*/, '').trim();
  return withoutToolName || normalized;
}

function isTestCommand(command: string): boolean {
  const normalized = command.toLowerCase();
  const commandBoundary = "(?:^|[\\s'\"`])";
  const commandEnd = "(?:[\\s'\"]|$)";
  const direct = new RegExp(`${commandBoundary}(?:npm|pnpm|yarn|bun)\\s+(?:run\\s+)?test${commandEnd}`, 'i').test(normalized)
    || /^node\s+--test(?:\s|$)/i.test(normalized)
    || new RegExp(`${commandBoundary}(?:npx\\s+)?(?:vitest|jest|pytest|cargo\\s+test|go\\s+test|dotnet\\s+test)${commandEnd}`, 'i').test(normalized);
  if (direct) return true;
  return /(?:powershell|cmd)(?:\.exe)?/i.test(normalized)
    && new RegExp(`${commandBoundary}(?:npm|pnpm|yarn|bun)\\s+(?:run\\s+)?test${commandEnd}`, 'i').test(normalized);
}

/** S2: only a whole direct invocation; quoted wrappers/composition stay reports. */
export function isDirectTestCommand(command: string): boolean {
  if (command.length > 512 || /[\r\n;&|><`$()]/u.test(command)) return false;
  // A bounded literal argv grammar: no shell expansion, quotes or executable
  // wrappers which could mask a failing child exit. Unknown grammar is not final.
  const tokens = command.trim().split(/\s+/u);
  if (tokens.some(token => !/^[a-zA-Z0-9_.:/\\=-]+$/u.test(token))) return false;
  const executable = tokens[0]?.toLowerCase();
  // Lite recognises a bounded Node test file invocation only. Other runners
  // and package scripts keep report behavior until their exit contract is proven.
  return executable === 'node' && tokens[1] === '--test' && tokens.length > 2 &&
    tokens.slice(2).every(token => !token.startsWith('-') && /\.(?:cjs|mjs|js)$/i.test(token));
}

function captureBaseline(workspaceRoot: string): Baseline {
  try {
    const status = execGit(workspaceRoot, ['status', '--porcelain'])
      .split(/\r?\n/)
      .filter(line => line && !/\.agentos(?:[\\/]|$)/i.test(line.slice(3).trim()))
      .join('\n');
    const head = execGit(workspaceRoot, ['rev-parse', 'HEAD']).trim() || null;
    return { head, dirty: Boolean(status.trim()) };
  } catch {
    return { head: null, dirty: true };
  }
}

function readGitDiff(workspaceRoot: string, head: string): string {
  try {
    return execGit(workspaceRoot, ['diff', '--no-ext-diff', '--unified=3', head]);
  } catch {
    return '';
  }
}

function execGit(workspaceRoot: string, args: string[]): string {
  return execFileSync('git', ['-C', workspaceRoot, ...args], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function normalizeRelativePath(value: string): string | undefined {
  const normalized = value.replaceAll('\\', '/');
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../') || /^[A-Za-z]:\//.test(normalized)) return undefined;
  const segments = normalized.split('/').filter(Boolean);
  if (segments.some(segment => segment === '..')) return undefined;
  return segments.join('/');
}

function publicEvent(event: NormalizedCliEvent): NormalizedCliEvent {
  if (event.type === 'status') return { type: 'status', phase: event.phase, label: event.phase };
  if (event.type === 'assistant.message') return { type: 'assistant.message', text: event.text, ...(event.messageId ? { messageId: event.messageId } : {}) };
  if (event.type === 'tool.started') return { ...event, inputPreview: event.inputPreview?.slice(0, 512), summary: event.summary.slice(0, 512) };
  if (event.type === 'tool.completed') return { ...event, outputPreview: event.outputPreview?.slice(0, 1024), summary: event.summary.slice(0, 512) };
  return event;
}

function formatPublicEvent(event: NormalizedCliEvent): string {
  switch (event.type) {
    case 'status': return `[status] ${event.phase}`;
    case 'assistant.message': return `[assistant] ${event.text}`;
    case 'tool.started': return `[tool.started] ${event.toolName}: ${event.inputPreview ?? event.summary}`;
    case 'tool.completed': return `[tool.completed] ${event.toolName}: ${event.success ? 'success' : 'failed'}${event.outputPreview ? `\n${event.outputPreview}` : ''}`;
    case 'usage': return `[usage] input=${event.inputTokens ?? 0} output=${event.outputTokens ?? 0}`;
    case 'diagnostic': return `[diagnostic] ${event.code}: ${event.message}`;
    case 'approval.requested': return `[approval.requested] ${event.toolName}: ${event.riskLevel}`;
    case 'approval.resolved': return `[approval.resolved] ${event.requestId}: ${event.decision}`;
  }
}

function hashText(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  return String(hash);
}
