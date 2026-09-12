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
      if (!event.type.startsWith('tool.') && event.type !== 'approval.requested') return;
      rejectedEventType = event.type;
      controller.abort();
      rejectRuntimeEvent(new SummarizerRuntimeEventError(event.type));
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

    const stdout = typeof log.stdout === 'string' ? log.stdout.trim() : '';
    const stderr = typeof log.stderr === 'string' ? log.stderr.trim() : '';
    const summary = stdout || stderr;
    if (!summary) {
      throw summaryFailure('COMPACTION_SUMMARY_INVALID', 'SUM summarizer returned an empty summary');
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
