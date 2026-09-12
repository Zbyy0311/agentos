import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CLIExecutor } from '@agentos/agent-core';
import type { AgentConfig, NormalizedCliEvent } from '@agentos/agent-core';
import type { TaskLog } from '@agentos/shared';
import {
  ConversationCompactionError,
  type CompactionProviderIdentity,
  type CompactionSummaryRequest,
} from './ConversationCompactionService.js';
import {
  ProviderCompactionSummarizer,
  type SummarizationCliProfile,
} from './ProviderCompactionSummarizer.js';

type Execute = typeof CLIExecutor.execute;
type ExecuteContext = Parameters<Execute>[2];

const SUMMARY_PROMPT_TEMPLATE = 'Summarize the supplied conversation into a concise factual summary. Output only the summary.';
const FIXED_NOW = new Date('2026-09-12T00:00:00.000Z');

function makeRequest(overrides: {
  readonly provider?: Partial<CompactionProviderIdentity>;
  readonly summaryMaxTokens?: number;
  readonly timeoutMs?: number;
} = {}): CompactionSummaryRequest {
  return {
    workspaceId: 'workspace-under-test',
    conversationId: 'conversation-under-test',
    sourceMessages: [{
      id: 'message-1',
      senderType: 'user',
      content: '保留这个结论',
      status: 'completed',
      createdAt: FIXED_NOW.toISOString(),
    }],
    priorSummary: null,
    summaryMaxTokens: overrides.summaryMaxTokens ?? 32,
    timeoutMs: overrides.timeoutMs ?? 100,
    provider: {
      providerConfigId: 'provider-config-frozen',
      providerType: 'codex',
      adapterId: 'adapter.compaction',
      adapterVersion: '1.2.3',
      model: 'frozen-model',
      ...overrides.provider,
    },
  };
}

function makeProfile(overrides: Partial<SummarizationCliProfile> = {}): SummarizationCliProfile {
  return {
    adapterId: 'adapter.compaction',
    adapterVersion: '1.2.3',
    command: 'fake-summary-cli',
    cliArgs: ['exec', '--sandbox', 'read-only'],
    role: 'codex_manager',
    promptTemplate: () => SUMMARY_PROMPT_TEMPLATE,
    ...overrides,
  };
}

function makeLog(stdout: string, exitCode: number | null = 0, stderr = ''): TaskLog {
  return {
    stage: 'codex_manager',
    agentName: 'compaction-summarizer',
    stdout,
    stderr,
    exitCode,
    timestamp: FIXED_NOW.toISOString(),
    duration: 1,
    mode: 'real',
  };
}

function makeExecute(handler: (config: AgentConfig, prompt: string, context: ExecuteContext) => Promise<TaskLog>): Execute {
  return handler;
}

function makeSummarizer(root: string, execute: Execute, profile?: SummarizationCliProfile): ProviderCompactionSummarizer {
  return new ProviderCompactionSummarizer({
    scratchRoot: root,
    profiles: profile === undefined ? {} : { codex: profile },
    execute,
    now: () => new Date(FIXED_NOW),
  });
}

async function withScratch<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'agentos-provider-compaction-test-'));
  try {
    return await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function expectCompactionError(
  action: () => Promise<unknown>,
  code: 'COMPACTION_SUMMARY_FAILED' | 'COMPACTION_SUMMARY_INVALID',
  message: RegExp,
): Promise<void> {
  let error: unknown;
  try {
    await action();
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof ConversationCompactionError);
  assert.equal(error.code, code);
  assert.match(error.message, message);
}

test('returns a trimmed summary through the isolated CLIExecutor context', async () => {
  await withScratch(async root => {
    let observedConfig: AgentConfig | undefined;
    let observedPrompt: string | undefined;
    let observedContext: ExecuteContext | undefined;
    const execute = makeExecute(async (config, prompt, context) => {
      observedConfig = config;
      observedPrompt = prompt;
      observedContext = context;
      return makeLog('  summary from the frozen CLI  \n');
    });

    const result = await makeSummarizer(root, execute, makeProfile()).summarize(makeRequest());

    assert.equal(result.summary, 'summary from the frozen CLI');
    assert.equal(observedConfig?.name, 'compaction-summarizer');
    assert.equal(observedConfig?.role, 'codex_manager');
    assert.equal(observedConfig?.cliCommand, 'fake-summary-cli');
    assert.deepEqual(observedConfig?.cliArgs, ['exec', '--sandbox', 'read-only']);
    assert.equal(observedConfig?.model, 'frozen-model');
    assert.equal(observedConfig?.thinkingEffort, 'low');
    assert.equal(observedPrompt, SUMMARY_PROMPT_TEMPLATE);
    assert.equal(observedContext?.taskId, 'conversation-under-test');
    assert.equal(observedContext?.persistWorkspaceLog, false);
    assert.ok(observedContext?.signal);
    assert.ok(observedContext?.workspaceRoot.startsWith(root));
    assert.notEqual(observedContext?.workspaceRoot, root);
  });
});

test('fails closed when the provider type has no summarization profile', async () => {
  await withScratch(async root => {
    let executed = false;
    const execute = makeExecute(async () => {
      executed = true;
      return makeLog('should not run');
    });

    await expectCompactionError(
      () => makeSummarizer(root, execute).summarize(makeRequest()),
      'COMPACTION_SUMMARY_FAILED',
      /profile unavailable for codex/,
    );
    assert.equal(executed, false);
  });
});

test('fails closed when the frozen adapter identity differs from the allow-list profile', async () => {
  await withScratch(async root => {
    const execute = makeExecute(async () => makeLog('should not run'));
    await expectCompactionError(
      () => makeSummarizer(root, execute, makeProfile()).summarize(makeRequest({ provider: { adapterId: 'adapter.other' } })),
      'COMPACTION_SUMMARY_FAILED',
      /adapter identity mismatch/,
    );
  });
});

test('fails closed when the frozen model is empty', async () => {
  await withScratch(async root => {
    const execute = makeExecute(async () => makeLog('should not run'));
    await expectCompactionError(
      () => makeSummarizer(root, execute, makeProfile()).summarize(makeRequest({ provider: { model: '   ' } })),
      'COMPACTION_SUMMARY_FAILED',
      /model unavailable/,
    );
  });
});

test('rejects the first tool or approval runtime event', async () => {
  await withScratch(async root => {
    const execute = makeExecute(async (_config, _prompt, context) => {
      const event: NormalizedCliEvent = {
        type: 'tool.started',
        callId: 'tool-1',
        toolName: 'read_file',
        summary: 'must be rejected',
      };
      context.onRuntimeEvent?.(event);
      return makeLog('tool output must not become a summary');
    });

    await expectCompactionError(
      () => makeSummarizer(root, execute, makeProfile()).summarize(makeRequest()),
      'COMPACTION_SUMMARY_FAILED',
      /tool\.started/,
    );
  });
});

test('fails with the provider exit code when execution is non-zero', async () => {
  await withScratch(async root => {
    const execute = makeExecute(async () => makeLog('', 23, 'private stderr must not be copied'));
    await expectCompactionError(
      () => makeSummarizer(root, execute, makeProfile()).summarize(makeRequest()),
      'COMPACTION_SUMMARY_FAILED',
      /exit code 23/,
    );
  });
});

test('aborts and fails on the hard timeout', async () => {
  await withScratch(async root => {
    let signal: AbortSignal | undefined;
    const execute = makeExecute(async (_config, _prompt, context) => {
      signal = context.signal;
      return new Promise<TaskLog>(() => {});
    });

    await expectCompactionError(
      () => makeSummarizer(root, execute, makeProfile()).summarize(makeRequest({ timeoutMs: 15 })),
      'COMPACTION_SUMMARY_FAILED',
      /timed out.*exit code null/,
    );
    assert.equal(signal?.aborted, true);
  });
});

test('rejects an empty or oversized summary', async () => {
  await withScratch(async root => {
    const emptyExecute = makeExecute(async () => makeLog('  \n', 0, '  '));
    await expectCompactionError(
      () => makeSummarizer(root, emptyExecute, makeProfile()).summarize(makeRequest()),
      'COMPACTION_SUMMARY_INVALID',
      /empty summary/,
    );
  });

  await withScratch(async root => {
    const longExecute = makeExecute(async () => makeLog('123456789'));
    await expectCompactionError(
      () => makeSummarizer(root, longExecute, makeProfile()).summarize(makeRequest({ summaryMaxTokens: 2 })),
      'COMPACTION_SUMMARY_INVALID',
      /exceeded summaryMaxTokens/,
    );
  });
});
