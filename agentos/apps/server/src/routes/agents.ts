import { Router } from 'express';
import { access } from 'node:fs/promises';
import { AGENT_CONFIGS } from '@agentos/agent-core';

export function createAgentRoutes(): Router {
  const router = Router();

  router.get('/status', async (_req, res) => {
    const configs = Object.values(AGENT_CONFIGS).map(c => ({
      name: c.name,
      role: c.role,
      cli: c.cliCommand,
      model: c.model ?? '',
    }));

    const agents = await Promise.all(
      configs.map(async (c) => {
        let connected = false;
        try {
          await access(c.cli);
          connected = true;
        } catch {
          connected = false;
        }
        return { ...c, connected, mode: connected ? 'real' : 'mock' };
      })
    );

    res.json({ agents });
  });

  return router;
}
