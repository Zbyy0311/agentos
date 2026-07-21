import { Router, type Request, type Response } from 'express';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { SqliteStore } from '../store/SqliteStore.js';
import { ProviderConfigurationRepository, DEFAULT_CAPABILITIES, DEFAULT_TIMEOUT_POLICY } from '../store/ProviderConfigurationRepository.js';
import { createEntityId } from '../store/Identity.js';
import type { ProviderConfiguration } from '../store/ProviderConfigurationRepository.js';

export function createProviderConfigRoutes(store: SqliteStore, workspaceManager: WorkspaceManager): Router {
  const router = Router({ mergeParams: true });

  router.get('/provider-configs', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    try {
      const repo = new ProviderConfigurationRepository((store as any).database);
      const configs = repo.findByWorkspace(workspace.id);
      res.json({ providerConfigs: configs, workspaceId: workspace.id });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/provider-configs/:providerConfigId', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    try {
      const repo = new ProviderConfigurationRepository((store as any).database);
      const config = repo.findById(req.params.providerConfigId);
      if (!config) return res.status(404).json({ error: 'Provider configuration not found' });
      res.json({ providerConfig: config, workspaceId: workspace.id });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/provider-configs', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    try {
      const repo = new ProviderConfigurationRepository((store as any).database);
      const now = new Date().toISOString();
      const config: ProviderConfiguration = {
        id: createEntityId('provider'),
        workspaceId: workspace.id,
        name: req.body.name || 'New Provider',
        providerType: req.body.providerType || 'custom-cli',
        adapterId: req.body.adapterId || 'builtin.custom-cli',
        runtimeMode: req.body.runtimeMode || 'cli',
        executable: req.body.executable,
        argsTemplate: req.body.argsTemplate,
        model: req.body.model,
        environmentProfileId: req.body.environmentProfileId,
        secretProfileId: req.body.secretProfileId,
        workingDirectoryMode: req.body.workingDirectoryMode || 'workspace',
        customWorkingDirectory: req.body.customWorkingDirectory,
        capabilities: req.body.capabilities || { ...DEFAULT_CAPABILITIES },
        timeoutPolicy: req.body.timeoutPolicy || { ...DEFAULT_TIMEOUT_POLICY },
        approvalMode: req.body.approvalMode || 'agentos',
        outputMode: req.body.outputMode || 'parsed-text',
        enabled: req.body.enabled !== false,
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      const created = repo.insert(config);
      res.status(201).json({ providerConfig: created, workspaceId: workspace.id });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.put('/provider-configs/:providerConfigId', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    try {
      const repo = new ProviderConfigurationRepository((store as any).database);
      const existing = repo.findById(req.params.providerConfigId);
      if (!existing) return res.status(404).json({ error: 'Provider configuration not found' });
      const updated: ProviderConfiguration = {
        ...existing,
        name: req.body.name ?? existing.name,
        providerType: req.body.providerType ?? existing.providerType,
        adapterId: req.body.adapterId ?? existing.adapterId,
        runtimeMode: req.body.runtimeMode ?? existing.runtimeMode,
        executable: req.body.executable !== undefined ? req.body.executable : existing.executable,
        argsTemplate: req.body.argsTemplate ?? existing.argsTemplate,
        model: req.body.model !== undefined ? req.body.model : existing.model,
        environmentProfileId: req.body.environmentProfileId !== undefined ? req.body.environmentProfileId : existing.environmentProfileId,
        secretProfileId: req.body.secretProfileId !== undefined ? req.body.secretProfileId : existing.secretProfileId,
        workingDirectoryMode: req.body.workingDirectoryMode ?? existing.workingDirectoryMode,
        customWorkingDirectory: req.body.customWorkingDirectory !== undefined ? req.body.customWorkingDirectory : existing.customWorkingDirectory,
        capabilities: req.body.capabilities ?? existing.capabilities,
        timeoutPolicy: req.body.timeoutPolicy ?? existing.timeoutPolicy,
        approvalMode: req.body.approvalMode ?? existing.approvalMode,
        outputMode: req.body.outputMode ?? existing.outputMode,
        enabled: req.body.enabled !== undefined ? req.body.enabled : existing.enabled,
        updatedAt: new Date().toISOString(),
      };
      const saved = repo.update(updated);
      res.json({ providerConfig: saved, workspaceId: workspace.id });
    } catch (error) {
      if (error instanceof Error && error.message.includes('version conflict')) {
        return res.status(409).json({ error: error.message });
      }
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.delete('/provider-configs/:providerConfigId', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    try {
      const repo = new ProviderConfigurationRepository((store as any).database);
      const existing = repo.findById(req.params.providerConfigId);
      if (!existing) return res.status(404).json({ error: 'Provider configuration not found' });
      repo.archive(req.params.providerConfigId);
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
