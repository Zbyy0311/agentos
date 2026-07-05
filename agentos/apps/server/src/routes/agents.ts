import { Router } from 'express';
import { AGENT_CONFIGS, resolveCommand, FORCE_MOCK } from '@agentos/agent-core';

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
        const resolved = FORCE_MOCK ? null : await resolveCommand(c.cli);
        const connected = resolved !== null;
        return {
          ...c,
          connected,
          mode: FORCE_MOCK ? 'mock' : (connected ? 'real' : 'mock'),
          path: resolved ?? '',
        };
      })
    );

    res.json({ agents });
  });

  return router;
}
