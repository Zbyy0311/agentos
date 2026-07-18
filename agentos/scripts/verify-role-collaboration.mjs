import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const required = [
  'apps/server/src/services/AgentPresenceService.ts',
  'apps/server/src/services/GroupDispatchService.ts',
  'apps/server/src/services/RunDecisionService.ts',
  'apps/server/src/services/ApprovalRegistry.ts',
  'packages/agent-core/src/runtimePolicy.ts',
  'apps/web/src/components/chat/RunModeSelector.tsx',
];
const missing = required.filter(path => !existsSync(path));
if (missing.length) {
  console.error(`Missing required collaboration files:\n${missing.join('\n')}`);
  process.exit(1);
}

const commands = [
  ['pnpm.cmd', ['--filter', '@agentos/agent-core', 'test']],
  ['pnpm.cmd', ['--filter', '@agentos/server', 'test']],
  ['pnpm.cmd', ['--filter', '@agentos/web', 'test']],
  ['pnpm.cmd', ['-r', 'run', 'build']],
  ['git', ['diff', '--check']],
];
for (const [command, args] of commands) {
  console.log(`\n> ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { stdio: 'inherit', shell: true });
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log('\nRole collaboration verification passed.');
