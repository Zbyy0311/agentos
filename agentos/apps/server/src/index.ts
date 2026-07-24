import express from 'express';
import cors from 'cors';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { SqliteStore } from './store/SqliteStore.js';
import { WorkspaceManager } from './managers/WorkspaceManager.js';
import { createWorkspaceRoutes } from './routes/workspaces.js';
import { createTaskRoutes } from './routes/tasks.js';
import { createV2TaskRoutes } from './routes/v2Tasks.js';
import { createV2RunRoutes } from './routes/v2Runs.js';
import { createAgentRoutes } from './routes/agents.js';
import { createGitRoutes } from './routes/git.js';
import { createConversationRoutes } from './routes/conversations.js';
import { recoverInterruptedTaskRuntime } from './taskRecovery.js';
import { recoverInterruptedRuns } from './runRecovery.js';
import { EventBus } from './events/EventBus.js';
import { createRunRoutes } from './routes/runs.js';
import { createArtifactRoutes } from './routes/artifacts.js';
import { createMemoryRoutes } from './routes/memories.js';
import { createMemoryCandidateRoutes } from './routes/memoryCandidates.js';
import { createJsonErrorHandler } from './errorHandler.js';
import { getSignalExitCode } from './signals.js';
import { resolveProjectRoot } from './projectRoot.js';
import { TaskRunService } from './services/TaskRunService.js';
import { RuntimeArtifactService } from './services/RuntimeArtifactService.js';
import { PreferenceService } from './services/PreferenceService.js';
import { RetentionService } from './services/RetentionService.js';
import { createPreferenceRoutes } from './routes/preferences.js';
import { createAgentPresenceRoutes } from './routes/agentPresence.js';
import { createWorktreeRoutes } from './routes/worktrees.js';
import { WorktreeManager } from './services/WorktreeManager.js';
import { createStorageRoutes } from './routes/storage.js';
import { createApprovalRoutes } from './routes/approvals.js';
import { createProviderConfigRoutes } from './routes/providerConfigs.js';
import { createLocalCorsOptions, createLocalWriteGuard, resolveLocalApiSecurityConfig } from './localApiSecurity.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolveProjectRoot(__dirname);
const security = resolveLocalApiSecurityConfig(process.env);

const serverInstanceId = randomUUID();
process.env.AGENTOS_SERVER_INSTANCE_ID = serverInstanceId;

const DIAG_LOG_DIR = join(PROJECT_ROOT, '.agentos', 'logs', 'diagnostics');
process.env.AGENTOS_DIAG_LOG_DIR = DIAG_LOG_DIR;
function diagLog(entry: string): void {
  const timestamp = new Date().toISOString();
  const line = `${timestamp} [server] ${entry}\n`;
  try {
    mkdirSync(DIAG_LOG_DIR, { recursive: true });
    appendFileSync(join(DIAG_LOG_DIR, `server-${serverInstanceId}.log`), line, 'utf-8');
  } catch {
    // Best-effort diagnostics; fail silently.
  }
}

diagLog(`INSTANCE_START pid=${process.pid} ppid=${process.ppid} instanceId=${serverInstanceId}`);

const store = new SqliteStore(PROJECT_ROOT);
const worktreeManager = new WorktreeManager(process.env.AGENTOS_WORKTREE_ROOT ?? join(PROJECT_ROOT, '.agentos', 'worktrees'));
void worktreeManager.reconcile().catch(error => diagLog(`WORKTREE_RECONCILE_ERROR error=${error instanceof Error ? error.message : String(error)}`));
const workspaceManager = new WorkspaceManager(store);
const taskRunService = new TaskRunService(store);
const recoveredTaskRuntime = recoverInterruptedTaskRuntime(store, taskRunService);
const recoveredRuns = recoverInterruptedRuns(store);
const eventBus = new EventBus(
  draft => store.appendAgentEvent(draft),
  (error, event) => {
    diagLog(`EVENT_SUBSCRIBER_ERROR eventId=${event.eventId} sequence=${event.sequence} error=${error instanceof Error ? error.message : String(error)}`);
  },
);
const artifactService = new RuntimeArtifactService(store, PROJECT_ROOT);
const preferenceService = new PreferenceService(store);
const retentionService = new RetentionService(store, undefined, error => {
  diagLog(`RETENTION_ERROR error=${error instanceof Error ? error.message : String(error)}`);
});
try {
  const result = retentionService.run();
  diagLog(`RETENTION_RUN reviewedMemoryCandidatesDeleted=${result.reviewedMemoryCandidatesDeleted}`);
} catch (error) {
  diagLog(`RETENTION_ERROR error=${error instanceof Error ? error.message : String(error)}`);
}
retentionService.start();

const app = express();
const parsedPort = Number.parseInt(process.env.PORT ?? '3000', 10);
const PORT = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : 3000;

app.use(cors(createLocalCorsOptions(security)));
app.use(createLocalWriteGuard(security));
app.use(express.json({ limit: '50mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'agentos-server', time: new Date().toISOString() });
});

app.use('/api/workspaces', createWorkspaceRoutes(workspaceManager));
app.use('/api/workspaces/:workspaceId', createConversationRoutes(store, workspaceManager, undefined, eventBus, artifactService, preferenceService, worktreeManager));
app.use('/api/workspaces/:workspaceId', createRunRoutes(store, workspaceManager));
app.use('/api/workspaces/:workspaceId', createArtifactRoutes(store, workspaceManager, artifactService));
app.use('/api/workspaces/:workspaceId', createMemoryRoutes(store, workspaceManager));
app.use('/api/workspaces/:workspaceId', createMemoryCandidateRoutes(store, workspaceManager, eventBus));
app.use('/api/workspaces/:workspaceId', createPreferenceRoutes(store, workspaceManager, preferenceService));
app.use('/api/workspaces/:workspaceId', createAgentPresenceRoutes(store, workspaceManager));
app.use('/api/workspaces/:workspaceId', createWorktreeRoutes(workspaceManager, worktreeManager, artifactService, store));
app.use('/api/workspaces/:workspaceId', createStorageRoutes(workspaceManager, PROJECT_ROOT, store, artifactService));
app.use('/api/workspaces/:workspaceId', createApprovalRoutes(store, workspaceManager));
app.use('/api/workspaces/:workspaceId', createProviderConfigRoutes(store, workspaceManager));
app.use('/api', createPreferenceRoutes(store, workspaceManager, preferenceService));
app.use('/api/workspaces/:workspaceId/tasks', createTaskRoutes(store, workspaceManager, { taskRunService }));
app.use('/api/workspaces/:workspaceId/v2', createV2TaskRoutes(store, workspaceManager));
app.use('/api/workspaces/:workspaceId/v2', createV2RunRoutes(store, workspaceManager));
app.use('/api/workspaces/:workspaceId/git', createGitRoutes(workspaceManager));
app.use('/api/agents', createAgentRoutes(workspaceManager));
app.use(createJsonErrorHandler());

app.listen(PORT, security.host, () => {
  const msg = `SERVER_LISTEN pid=${process.pid} instanceId=${serverInstanceId} port=${PORT}`;
  console.log(`[AgentOS Server] running on http://${security.host}:${PORT}`);
  console.log(`[AgentOS Server] API base: http://${security.host}:${PORT}/api`);
  diagLog(msg);
  if (recoveredTaskRuntime.recoveredLegacyTasks.length > 0) {
    console.warn(`[AgentOS Server] recovered ${recoveredTaskRuntime.recoveredLegacyTasks.length} interrupted running task(s) as failed`);
    diagLog(`RECOVERED_TASKS count=${recoveredTaskRuntime.recoveredLegacyTasks.length} tasks=${JSON.stringify(recoveredTaskRuntime.recoveredLegacyTasks)}`);
  }
  if (recoveredTaskRuntime.recoveredLegacyQueuedRuns.length > 0) {
    console.warn(`[AgentOS Server] recovered ${recoveredTaskRuntime.recoveredLegacyQueuedRuns.length} orphaned Legacy queued Run(s) as failed`);
    diagLog(`RECOVERED_LEGACY_QUEUED_RUNS count=${recoveredTaskRuntime.recoveredLegacyQueuedRuns.length} runs=${JSON.stringify(recoveredTaskRuntime.recoveredLegacyQueuedRuns.map(item => ({ workspaceId: item.workspaceId, taskId: item.taskId, runId: item.runId })))}`);
  }
  if (recoveredRuns > 0) {
    console.warn(`[AgentOS Server] recovered ${recoveredRuns} interrupted run(s) as failed`);
    diagLog(`RECOVERED_RUNS count=${recoveredRuns}`);
  }
});

function handleSignal(signal: string, exitCode: number): void {
  diagLog(`SIGNAL=${signal} pid=${process.pid} instanceId=${serverInstanceId}`);
  process.exit(exitCode);
}

process.on('SIGINT',  () => handleSignal('SIGINT', getSignalExitCode('SIGINT')));
process.on('SIGTERM', () => handleSignal('SIGTERM', getSignalExitCode('SIGTERM')));
process.on('SIGHUP',  () => handleSignal('SIGHUP', getSignalExitCode('SIGHUP')));

process.on('exit', (code) => {
  diagLog(`PROCESS_EXIT code=${code} pid=${process.pid} instanceId=${serverInstanceId}`);
});

process.on('uncaughtException', (err) => {
  diagLog(`UNCAUGHT_EXCEPTION pid=${process.pid} instanceId=${serverInstanceId} error=${err.message} stack=${err.stack?.split('\n').slice(0, 6).join('|')}`);
});

process.on('unhandledRejection', (reason) => {
  diagLog(`UNHANDLED_REJECTION pid=${process.pid} instanceId=${serverInstanceId} reason=${reason}`);
});
