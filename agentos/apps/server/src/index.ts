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
import { createAgentRoutes } from './routes/agents.js';
import { createGitRoutes } from './routes/git.js';
import { createConversationRoutes } from './routes/conversations.js';
import { recoverInterruptedRunningTasks } from './taskRecovery.js';
import { recoverInterruptedRuns } from './runRecovery.js';
import { EventBus } from './events/EventBus.js';
import { createRunRoutes } from './routes/runs.js';
import { createArtifactRoutes } from './routes/artifacts.js';
import { createMemoryRoutes } from './routes/memories.js';
import { createMemoryCandidateRoutes } from './routes/memoryCandidates.js';
import { createJsonErrorHandler } from './errorHandler.js';
import { getSignalExitCode } from './signals.js';
import { resolveProjectRoot } from './projectRoot.js';
import { RuntimeArtifactService } from './services/RuntimeArtifactService.js';
import { PreferenceService } from './services/PreferenceService.js';
import { RetentionService } from './services/RetentionService.js';
import { createPreferenceRoutes } from './routes/preferences.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolveProjectRoot(__dirname);

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
const workspaceManager = new WorkspaceManager(store);
const recoveredTasks = recoverInterruptedRunningTasks(store);
const recoveredRuns = recoverInterruptedRuns(store);
const eventBus = new EventBus();
eventBus.subscribe(event => store.appendAgentEvent(event));
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
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'agentos-server', time: new Date().toISOString() });
});

app.use('/api/workspaces', createWorkspaceRoutes(workspaceManager));
app.use('/api/workspaces/:workspaceId', createConversationRoutes(store, workspaceManager, undefined, eventBus, artifactService, preferenceService));
app.use('/api/workspaces/:workspaceId', createRunRoutes(store, workspaceManager));
app.use('/api/workspaces/:workspaceId', createArtifactRoutes(store, workspaceManager, artifactService));
app.use('/api/workspaces/:workspaceId', createMemoryRoutes(store, workspaceManager));
app.use('/api/workspaces/:workspaceId', createMemoryCandidateRoutes(store, workspaceManager, eventBus));
app.use('/api/workspaces/:workspaceId', createPreferenceRoutes(store, workspaceManager, preferenceService));
app.use('/api', createPreferenceRoutes(store, workspaceManager, preferenceService));
app.use('/api/workspaces/:workspaceId/tasks', createTaskRoutes(store, workspaceManager));
app.use('/api/workspaces/:workspaceId/git', createGitRoutes(workspaceManager));
app.use('/api/agents', createAgentRoutes(workspaceManager));
app.use(createJsonErrorHandler());

app.listen(PORT, () => {
  const msg = `SERVER_LISTEN pid=${process.pid} instanceId=${serverInstanceId} port=${PORT}`;
  console.log(`[AgentOS Server] running on http://localhost:${PORT}`);
  console.log(`[AgentOS Server] API base: http://localhost:${PORT}/api`);
  diagLog(msg);
  if (recoveredTasks.length > 0) {
    console.warn(`[AgentOS Server] recovered ${recoveredTasks.length} interrupted running task(s) as failed`);
    diagLog(`RECOVERED_TASKS count=${recoveredTasks.length} tasks=${JSON.stringify(recoveredTasks)}`);
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
