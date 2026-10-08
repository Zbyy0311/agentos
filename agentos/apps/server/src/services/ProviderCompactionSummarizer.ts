import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import {
  assertRuntimePolicySupported,
  CLIError,
  CLIExecutor,
  type AgentConfig,
  type NormalizedCliEvent,
} from '@agentos/agent-core';
import type { AgentStage, RuntimePolicy } from '@agentos/shared';
import {
  ConversationCompactionError,
  type CompactionSummarizerPort,
  type CompactionSummaryRequest,
} from './ConversationCompactionService.js';

/**
 * Explicit allow-list entry for the CLI that is permitted to summarize.
 *
 * This is intentionally keyed by the frozen provider type at call time. The
 * adapter identity is checked separately so a profile can never silently move
 * a compaction attempt to another implementation.
 */
export interface SummarizationCliProfile {
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly command: string;
  readonly cliArgs: readonly string[];
  readonly role: AgentStage;
  readonly promptTemplate: (input: CompactionSummaryRequest) => string;
  readonly promptPrefix?: string;
}

export interface ProviderCompactionSummarizerOptions {
  /** Caller must provide an isolated absolute root that is outside all Workspaces. */
  readonly scratchRoot: string;
  /** Empty by default: no provider is implicitly authorized for compaction. */
  readonly profiles?: Readonly<Record<string, SummarizationCliProfile>>;
  readonly execute?: typeof CLIExecutor.execute;
  readonly now?: () => Date;
}

type CompactionExecutionLog = Awaited<ReturnType<typeof CLIExecutor.execute>>;

class SummarizerTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`summarizer timed out after ${timeoutMs}ms`);
    this.name = 'SummarizerTimeoutError';
  }
}

class SummarizerRuntimeEventError extends Error {
  constructor(readonly eventType: string) {
    super(`summarizer rejected runtime event ${eventType}`);
    this.name = 'SummarizerRuntimeEventError';
  }
}

/**
 * The current compaction error vocabulary has no profile/identity/tool
 * specific codes. Keep the existing failure code and put the fail-closed
 * reason in Error.message rather than inventing a new public code.
 */
function summaryFailure(code: 'COMPACTION_SUMMARY_FAILED' | 'COMPACTION_SUMMARY_INVALID', detail: string): ConversationCompactionError {
  const error = new ConversationCompactionError(code);
  error.message = `${code}: ${detail}`;
  return error;
}

export class ProviderCompactionSummarizer implements CompactionSummarizerPort {
  private readonly scratchRoot: string;
  private readonly profiles: Readonly<Record<string, SummarizationCliProfile>>;
  private readonly execute: typeof CLIExecutor.execute;
  private readonly now: () => Date;

  constructor(options: ProviderCompactionSummarizerOptions) {
    this.scratchRoot = options.scratchRoot;
    this.profiles = options.profiles ?? {};
    this.execute = options.execute ?? CLIExecutor.execute.bind(CLIExecutor);
    this.now = options.now ?? (() => new Date());
  }

  async summarize(request: CompactionSummaryRequest): Promise<{ readonly summary: string }> {
    let scratchDir: string | undefined;

    try {
      const provider = request?.provider;
      const providerType = provider?.providerType ?? null;
      const profile = providerType === null
        ? undefined
        : Object.prototype.hasOwnProperty.call(this.profiles, providerType)
          ? this.profiles[providerType]
          : undefined;

      if (profile === undefined) {
        throw summaryFailure(
          'COMPACTION_SUMMARY_FAILED',
          `SUM summarizer profile unavailable for ${providerType ?? 'null'}`,
        );
      }

      if (provider?.adapterId !== profile.adapterId || provider?.adapterVersion !== profile.adapterVersion) {
        throw summaryFailure(
          'COMPACTION_SUMMARY_FAILED',
          `SUM summarizer adapter identity mismatch: expected ${profile.adapterId}@${profile.adapterVersion}, ` +
          `got ${provider?.adapterId ?? 'null'}@${provider?.adapterVersion ?? 'null'}`,
        );
      }

      const model = typeof provider?.model === 'string' ? provider.model.trim() : '';
      if (!model) {
        throw summaryFailure('COMPACTION_SUMMARY_FAILED', 'SUM summarizer model unavailable for frozen provider identity');
      }

      const timeoutMs = request?.timeoutMs;
      if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
        throw summaryFailure('COMPACTION_SUMMARY_FAILED', `SUM summarizer timeout is invalid: ${String(timeoutMs)}`);
      }

      scratchDir = await this.createScratchDirectory();

      const runtimePolicy: RuntimePolicy = {
        workspaceWrite: false,
        networkPolicy: 'provider-default',
        toolPolicy: 'read-only',
        extraArgs: [...profile.cliArgs],
        promptPrefix: profile.promptPrefix ?? '',
        enforcement: 'cli-flag',
      };
      try {
        assertRuntimePolicySupported(runtimePolicy);
      } catch (error) {
        throw summaryFailure(
          'COMPACTION_SUMMARY_FAILED',
          `SUM summarizer runtime policy unsupported: ${safeErrorMessage(error)}`,
        );
      }

      const templatePrompt = profile.promptTemplate(request);
      if (typeof templatePrompt !== 'string') {
        throw summaryFailure('COMPACTION_SUMMARY_FAILED', 'SUM summarizer prompt template returned a non-string value');
      }

      // CLIExecutor has no RuntimePolicy parameter. Preserve the policy
      // prefix in the prompt while keeping the template as the source text.
      const promptPrefix = runtimePolicy.promptPrefix.trim();
      const prompt = promptPrefix ? `${promptPrefix}\n\n${templatePrompt}` : templatePrompt;
      const config: AgentConfig = {
        name: 'compaction-summarizer',
        role: profile.role,
        cliCommand: profile.command,
        cliArgs: [...profile.cliArgs],
        model,
        thinkingEffort: 'low',
      };

      return await this.executeSummary({
        request,
        config,
        prompt,
        scratchDir,
        timeoutMs,
      });
    } catch (error) {
      if (error instanceof ConversationCompactionError) throw error;
      throw summaryFailure('COMPACTION_SUMMARY_FAILED', formatUnexpectedFailure(error));
    } finally {
      if (scratchDir !== undefined) {
        try {
          await rm(scratchDir, { recursive: true, force: true });
        } catch {
          // Scratch cleanup must never replace the classified summarizer result.
        }
      }
    }
  }

  private async createScratchDirectory(): Promise<string> {
    if (!this.scratchRoot.trim() || !isAbsolute(this.scratchRoot)) {
      throw summaryFailure(
        'COMPACTION_SUMMARY_FAILED',
        'SUM summarizer scratchRoot must be a non-empty absolute path outside Workspace roots',
      );
    }

    const root = resolve(this.scratchRoot);
    await mkdir(root, { recursive: true });
    const timestamp = this.now().getTime();
    return mkdtemp(join(root, `agentos-compaction-${timestamp}-${randomUUID()}-`));
  }

  private async executeSummary(input: {
    readonly request: CompactionSummaryRequest;
    readonly config: AgentConfig;
    readonly prompt: string;
    readonly scratchDir: string;
    readonly timeoutMs: number;
  }): Promise<{ readonly summary: string }> {
    const controller = new AbortController();
    let timeoutTriggered = false;
    let rejectedEventType: string | undefined;
    let rejectRuntimeEvent!: (reason: unknown) => void;
    const runtimeEventFailure = new Promise<never>((_resolve, reject) => {
      rejectRuntimeEvent = reject;
    });

    const onRuntimeEvent = (event: NormalizedCliEvent): void => {
      if (rejectedEventType !== undefined) return;
      // LITE-09-110: a provider that compacts its own context mid-run may be
      // summarizing something narrower than the frozen source range we handed it,
      // so a native compaction signal is rejected exactly like an unsanctioned
      // tool call instead of being accepted as canonical evidence.
      const nativeCompaction = (event.type === 'diagnostic' || event.type === 'status')
        && isNativeCompactionNotice(event.type === 'diagnostic' ? event.message : event.label);
      if (!nativeCompaction && !event.type.startsWith('tool.') && event.type !== 'approval.requested') return;
      rejectedEventType = nativeCompaction ? 'provider.native_compaction' : event.type;
      controller.abort();
      rejectRuntimeEvent(new SummarizerRuntimeEventError(rejectedEventType));
    };

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutFailure = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        timeoutTriggered = true;
        controller.abort();
        reject(new SummarizerTimeoutError(input.timeoutMs));
      }, input.timeoutMs);
    });

    const execution = Promise.resolve().then(() => this.execute(
      input.config,
      input.prompt,
      {
        workspaceRoot: input.scratchDir,
        taskId: input.request.conversationId,
        signal: controller.signal,
        persistWorkspaceLog: false,
        onRuntimeEvent,
      },
    ));
    // A fake or a provider may finish after the hard timeout/event rejection.
    // Promise.race observes the promise, and this handler also prevents a late
    // rejection from becoming an unhandled rejection after the result is set.
    void execution.catch(() => undefined);

    try {
      const log = await Promise.race([execution, runtimeEventFailure, timeoutFailure]);
      if (timeoutTriggered) {
        throw new SummarizerTimeoutError(input.timeoutMs);
      }
      if (rejectedEventType !== undefined) {
        throw new SummarizerRuntimeEventError(rejectedEventType);
      }
      return this.readSummary(log, input.request.summaryMaxTokens);
    } catch (error) {
      if (timeoutTriggered || error instanceof SummarizerTimeoutError) {
        throw summaryFailure(
          'COMPACTION_SUMMARY_FAILED',
          `SUM summarizer timed out after ${input.timeoutMs}ms (exit code null)`,
        );
      }
      if (rejectedEventType !== undefined || error instanceof SummarizerRuntimeEventError) {
        const eventType = rejectedEventType ?? (error as SummarizerRuntimeEventError).eventType;
        throw summaryFailure('COMPACTION_SUMMARY_FAILED', `SUM summarizer runtime event rejected: ${eventType}`);
      }
      if (error instanceof ConversationCompactionError) throw error;

      const exitCode = extractExitCode(error);
      throw summaryFailure(
        'COMPACTION_SUMMARY_FAILED',
        `SUM summarizer execution failed: ${safeErrorMessage(error)} (exit code ${formatExitCode(exitCode)})`,
      );
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
  }

  private readSummary(log: CompactionExecutionLog, summaryMaxTokens: number): { readonly summary: string } {
    if (!log || typeof log !== 'object') {
      throw summaryFailure('COMPACTION_SUMMARY_FAILED', 'SUM summarizer returned an invalid execution log (exit code unknown)');
    }

    if (log.exitCode !== 0) {
      throw summaryFailure(
        'COMPACTION_SUMMARY_FAILED',
        `SUM summarizer execution failed (exit code ${formatExitCode(log.exitCode)})`,
      );
    }

    // LITE-09-110: a CLI may report that it compacted its own context. That
    // notice is the provider's internal behaviour, not an AgentOS summary, so it
    // is removed from the text that may become canonical. AgentOS publishes only
    // its own persisted summary, source range, policy, budget and snapshot.
    const rawStdout = typeof log.stdout === 'string' ? log.stdout : '';
    const rawStderr = typeof log.stderr === 'string' ? log.stderr : '';
    const cleanedStdout = stripNativeCompactionNotices(rawStdout);
    const cleanedStderr = stripNativeCompactionNotices(rawStderr);
    const summary = cleanedStdout.text || cleanedStderr.text;
    if (!summary) {
      const noticeCount = cleanedStdout.notices + cleanedStderr.notices;
      // A run whose only usable output was the provider describing its own
      // compaction fails closed instead of publishing provider internals as a
      // canonical summary or a review Candidate.
      throw summaryFailure('COMPACTION_SUMMARY_INVALID', noticeCount === 0
        ? 'SUM summarizer returned an empty summary'
        : 'SUM summarizer returned only ' + noticeCount + ' provider-native compaction notice(s)');
    }

    if (!Number.isFinite(summaryMaxTokens) || summaryMaxTokens < 0 || summary.length > summaryMaxTokens * 4) {
      throw summaryFailure(
        'COMPACTION_SUMMARY_INVALID',
        `SUM summarizer summary exceeded summaryMaxTokens (${summaryMaxTokens})`,
      );
    }
    return { summary };
  }
}

/**
 * LITE-09-110: the provider-native compaction boundary.
 *
 * Codex, Kimi and OpenCode all compact their own context when it grows. That is
 * the provider's internal behaviour and AgentOS deliberately does not model it:
 * the only canonical compaction evidence is the summary, source range, policy,
 * budget and context snapshot AgentOS persists itself. A CLI that announces its
 * own compaction must therefore not have that announcement published as an
 * AgentOS summary or turned into a review Candidate.
 *
 * The patterns are conservative and line-anchored, so ordinary prose that merely
 * mentions compaction is not swallowed.
 */
const NATIVE_COMPACTION_NOTICE_PATTERNS: readonly RegExp[] = [
  /^\s*(?:\[[^\]]{0,40}\]\s*)?(?:context|history|conversation|session)\s+(?:is\s+|has\s+been\s+)?(?:auto-?)?compacted\b/i,
  /^\s*(?:auto-?)?compact(?:ing|ion)\s+(?:of\s+)?(?:the\s+)?(?:context|history|conversation|session|messages?|tokens?)\b/i,
  /^\s*(?:warning|warn|info|note)\b[^:]{0,40}:\s*(?:auto-?)?compact(?:ing|ion)\b/i,
  /^\s*(?:auto-?)?compact(?:ing|ion)\b[^:]{0,40}\b(?:context|history|tokens?|messages?)\b/i,
];

export function isNativeCompactionNotice(line: string): boolean {
  return NATIVE_COMPACTION_NOTICE_PATTERNS.some(pattern => pattern.test(line));
}

/**
 * Removes provider-native compaction notices from CLI output. Returns the
 * remaining text together with how many notice lines were discarded, so the
 * caller can fail closed when nothing usable is left instead of publishing
 * provider internals as canonical evidence.
 */
export function stripNativeCompactionNotices(text: string): { readonly text: string; readonly notices: number } {
  if (!text) return { text: '', notices: 0 };
  let notices = 0;
  const kept: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (isNativeCompactionNotice(line)) {
      notices += 1;
      continue;
    }
    kept.push(line);
  }
  return { text: kept.join('\n').trim(), notices };
}

function extractExitCode(error: unknown): number | null | undefined {
  if (error instanceof CLIError) return error.exitCode;
  if (typeof error !== 'object' || error === null || !('exitCode' in error)) return undefined;
  const value = (error as { exitCode?: unknown }).exitCode;
  return typeof value === 'number' || value === null ? value : undefined;
}

function formatExitCode(exitCode: number | null | undefined): string {
  return exitCode === undefined ? 'unknown' : String(exitCode);
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof CLIError) return 'CLI execution failed';
  if (!(error instanceof Error)) return 'unknown execution error';
  const compact = error.message.replace(/\s+/g, ' ').trim();
  return compact ? compact.slice(0, 200) : error.name;
}

function formatUnexpectedFailure(error: unknown): string {
  const exitCode = extractExitCode(error);
  return `SUM summarizer execution failed: ${safeErrorMessage(error)} (exit code ${formatExitCode(exitCode)})`;
}
