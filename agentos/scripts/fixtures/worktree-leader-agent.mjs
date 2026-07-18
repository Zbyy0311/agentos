const prompt = process.argv.at(-1) ?? '';
if (prompt.length === 0) process.exit(2);
console.log('Delegation plan: KimiCode and the Codex worker must work only in their own execution worktrees. Each worker must replace shared.txt with exactly WORKTREE_SHARED_OK plus a newline, create exactly one untracked file named agent-kimi.txt or agent-codex-worker.txt containing its agent name plus a newline, modify no other file, ask no questions, and make no commit. Then report the changed files.');
