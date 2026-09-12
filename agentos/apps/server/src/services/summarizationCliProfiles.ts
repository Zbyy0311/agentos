/**
 * S6 / LITE-09-106: the code-level allowlist of CLI execution profiles a
 * Conversation compaction summary may run through.
 *
 * The Conversation execution path does not go through the RunEngine provider
 * registry: a Turn drives the Agent's CLI through the agent-core CLIExecutor.
 * A summary run therefore has to be explicit about which CLI it may start, how
 * the prompt is delivered, and — most importantly — that the run cannot touch
 * the Workspace. Providers without an allowlisted profile fail closed; nothing
 * is silently downgraded to a different model or a wider sandbox.
 */
import { isCodexCli } from '@agentos/agent-core';
import type { AgentProfile } from '@agentos/shared';
import type { SummarizationCliProfile } from './ProviderCompactionSummarizer.js';
import type { CompactionProviderIdentity, CompactionSummaryRequest } from './ConversationCompactionService.js';

/** Version of the token estimator behind every recorded budget. */
export const SUMMARIZATION_ESTIMATOR_VERSION = 'lite-v1-chars4';

function renderSummarizationPrompt(input: CompactionSummaryRequest): string {
  const prior = input.priorSummary === null || input.priorSummary.trim().length === 0
    ? ''
    : 'Previous summary (already accepted; fold it into the new one):\n' + input.priorSummary.trim() + '\n\n';
  const excerpt = input.sourceMessages
    .map(message => '(' + message.senderType + ') ' + message.content)
    .join('\n');
  return 'You are a lossless conversation summarizer for an agent runtime.\n'
    + 'Summarize the exchange below so that a later turn can continue without reading the original messages.\n'
    + 'Rules:\n'
    + '- Output ONLY the summary text. No preamble, no headings, no code fences.\n'
    + '- Do not use tools, do not read or write files, do not run commands.\n'
    + '- Keep decisions, constraints, identifiers, unresolved questions, and outcomes.\n'
    + '- Stay under ' + String(input.summaryMaxTokens) + ' tokens.\n\n'
    + prior
    + '--- conversation excerpt ---\n'
    + excerpt
    + '\n--- end of excerpt ---\n';
}

/**
 * Only the Codex CLI can currently prove a read-only, tool-free execution
 * (agent-core resolves enforcement 'cli-flag' for it; every other provider
 * resolves 'unsupported' and the summarizer rejects it before any process
 * starts). Everything else stays absent so the attempt fails closed.
 */
export const SUMMARIZATION_CLI_PROFILES: Readonly<Record<string, SummarizationCliProfile>> = {
  codex: {
    adapterId: 'cli.codex',
    adapterVersion: '1.0.0',
    command: 'codex',
    // The CLI-level read-only enforcement is part of the profile, not the
    // prompt: `--sandbox read-only` is what the Conversation read-only path
    // uses as well, and the summarizer refuses any profile that omits it. The
    // `exec` subcommand has to come first because `--skip-git-repo-check` is
    // scoped to it, and the summary runs in an isolated scratch directory
    // rather than inside a trusted repository.
    cliArgs: ['exec', '--sandbox', 'read-only', '--skip-git-repo-check'],
    role: 'codex_manager',
    promptPrefix: '[Summarization mode] Produce a summary only. Do not use tools and do not modify files.',
    promptTemplate: renderSummarizationPrompt,
  },
};

export function summarizationCliKind(cliCommand: string): string {
  if (isCodexCli(cliCommand)) return 'codex';
  // agent-core exposes isOpenCodeCli only internally; a bare command match is
  // enough here because a non-allowlisted kind fails closed anyway.
  if (/(^|[\\/])opencode(\.exe)?$/i.test(cliCommand.trim())) return 'opencode';
  return 'kimi';
}

/**
 * Freeze the execution identity of the summary run at trigger time. The model
 * is written into the durable task row so a later configuration change cannot
 * silently re-interpret historical summaries.
 */
export function summarizationIdentityFor(
  agent: Pick<AgentProfile, 'cliCommand' | 'model' | 'providerConfigId'>,
): CompactionProviderIdentity | undefined {
  const kind = summarizationCliKind(agent.cliCommand);
  const profile = SUMMARIZATION_CLI_PROFILES[kind];
  if (profile === undefined) return undefined;
  const model = agent.model;
  if (typeof model !== 'string' || model.trim().length === 0) return undefined;
  return {
    providerConfigId: agent.providerConfigId ?? null,
    providerType: kind,
    adapterId: profile.adapterId,
    adapterVersion: profile.adapterVersion,
    model,
  };
}
