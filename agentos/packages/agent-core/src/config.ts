import type { AgentConfig } from './types.js';

const CODEX_CLI = process.env.AGENTOS_CODEX_CLI ?? `C:\\Users\\Administrator\\AppData\\Roaming\\QClaw\\npm-global\\codex.cmd`;
const OPENCODE_CLI = process.env.AGENTOS_OPENCODE_CLI ?? `E:\\software\\opencode\\node_modules\\opencode-ai\\bin\\opencode.exe`;
const KIMI_MODEL = process.env.AGENTOS_KIMI_MODEL ?? 'kimi-for-coding/k2p7';
const OPENCODE_MODEL = process.env.AGENTOS_OPENCODE_MODEL ?? 'deepseek/deepseek-v4-flash';

const FORCE_MOCK = process.env.AGENTOS_FORCE_MOCK === 'true';

export const AGENT_CONFIGS: Record<string, AgentConfig> = {
  codex_manager: {
    name: 'Codex', role: 'codex_manager',
    cliCommand: FORCE_MOCK ? 'echo' : CODEX_CLI,
    cliArgs: FORCE_MOCK ? [] : ['exec', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '--ephemeral'],
  },
  kimi_worker: {
    name: 'KimiCode', role: 'kimi_worker',
    cliCommand: FORCE_MOCK ? 'echo' : OPENCODE_CLI,
    cliArgs: FORCE_MOCK ? [] : ['--pure', 'run', '--model', KIMI_MODEL],
    model: KIMI_MODEL,
  },
  opencode_reviewer: {
    name: 'OpenCode', role: 'opencode_reviewer',
    cliCommand: FORCE_MOCK ? 'echo' : OPENCODE_CLI,
    cliArgs: FORCE_MOCK ? [] : ['--pure', 'run', '--model', OPENCODE_MODEL],
    model: OPENCODE_MODEL,
  },
  codex_final_review: {
    name: 'Codex', role: 'codex_final_review',
    cliCommand: FORCE_MOCK ? 'echo' : CODEX_CLI,
    cliArgs: FORCE_MOCK ? [] : ['exec', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '--ephemeral'],
  },
};
