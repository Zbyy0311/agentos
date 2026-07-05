import express from 'express';
import cors from 'cors';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonFileStore } from './store/JsonFileStore.js';
import { WorkspaceManager } from './managers/WorkspaceManager.js';
import { createWorkspaceRoutes } from './routes/workspaces.js';
import { createTaskRoutes } from './routes/tasks.js';
import { createAgentRoutes } from './routes/agents.js';
import { createGitRoutes } from './routes/git.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');

const store = new JsonFileStore(PROJECT_ROOT);
const workspaceManager = new WorkspaceManager(store);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'agentos-server', time: new Date().toISOString() });
});

app.use('/api/workspaces', createWorkspaceRoutes(workspaceManager));
app.use('/api/workspaces/:workspaceId/tasks', createTaskRoutes(store, workspaceManager));
app.use('/api/workspaces/:workspaceId/git', createGitRoutes(workspaceManager));
app.use('/api/agents', createAgentRoutes(workspaceManager));

app.listen(PORT, () => {
  console.log(`[AgentOS Server] running on http://localhost:${PORT}`);
  console.log(`[AgentOS Server] API base: http://localhost:${PORT}/api`);
});
