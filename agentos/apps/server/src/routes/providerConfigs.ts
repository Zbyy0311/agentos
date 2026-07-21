import { Router, type Request, type Response } from 'express';
import type { SqliteStore } from '../store/SqliteStore.js';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { ProviderConfigurationRepository, DEFAULT_CAPABILITIES, DEFAULT_TIMEOUT_POLICY } from '../store/ProviderConfigurationRepository.js';
import { createEntityId } from '../store/Identity.js';
import type { ProviderConfiguration } from '../store/ProviderConfigurationRepository.js';

const VALID_PROVIDER_TYPES = ['codex','claude-code','kimicode','opencode','gemini-cli','custom-cli','remote'] as const;

export function createProviderConfigRoutes(store: SqliteStore, workspaceManager: WorkspaceManager): Router {
  const router = Router({ mergeParams: true });
  const repo = new ProviderConfigurationRepository(store.getDatabase() as any);

  router.get('/provider-configs', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found', code: 'WORKSPACE_NOT_FOUND' });
    try {
      const configs = repo.findByWorkspace(workspace.id);
      res.json({ providerConfigs: configs, workspaceId: workspace.id });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error), code: 'INTERNAL_ERROR' });
    }
  });

  router.get('/provider-configs/:providerConfigId', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found', code: 'WORKSPACE_NOT_FOUND' });
    try {
      const config = repo.findById(req.params.providerConfigId);
      if (!config || config.workspaceId !== workspace.id) {
        return res.status(404).json({ error: 'Provider configuration not found', code: 'PROVIDER_CONFIG_NOT_FOUND' });
      }
      res.json({ providerConfig: config, workspaceId: workspace.id });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error), code: 'INTERNAL_ERROR' });
    }
  });

  router.post('/provider-configs', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found', code: 'WORKSPACE_NOT_FOUND' });
    try {
      const name = typeof req.body.name === 'string' && req.body.name.trim().length > 0 ? req.body.name.trim() : undefined;
      if (!name) return res.status(400).json({ error: 'Provider name is required', code: 'VALIDATION_ERROR' });
      const providerType = req.body.providerType;
      if (providerType && !VALID_PROVIDER_TYPES.includes(providerType)) {
        return res.status(400).json({ error: `Invalid provider type: ${providerType}`, code: 'VALIDATION_ERROR' });
      }

      const now = new Date().toISOString();
      const config: ProviderConfiguration = {
        id: createEntityId('provider'),
        workspaceId: workspace.id,
        name,
        providerType: providerType || 'custom-cli',
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
      res.status(500).json({ error: error instanceof Error ? error.message : String(error), code: 'INTERNAL_ERROR' });
    }
  });

  router.put('/provider-configs/:providerConfigId', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found', code: 'WORKSPACE_NOT_FOUND' });
    try {
      const existing = repo.findById(req.params.providerConfigId);
      if (!existing || existing.workspaceId !== workspace.id) {
        return res.status(404).json({ error: 'Provider configuration not found', code: 'PROVIDER_CONFIG_NOT_FOUND' });
      }
      const expectedVersion = typeof req.body.expectedVersion === 'number' && Number.isInteger(req.body.expectedVersion)
        ? req.body.expectedVersion
        : undefined;
      if (expectedVersion === undefined) {
        return res.status(400).json({ error: 'expectedVersion is required for updates', code: 'VALIDATION_ERROR' });
      }
      if (existing.version !== expectedVersion) {
        return res.status(409).json({
          error: `Version conflict: expected ${expectedVersion}, current ${existing.version}`,
          code: 'VERSION_CONFLICT',
        });
      }
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
      // Pass the client-provided version directly; repository uses it in the WHERE clause
      // so stale clients are correctly rejected.
      const saved = repo.update(updated, expectedVersion);
      res.json({ providerConfig: saved, workspaceId: workspace.id });
    } catch (error) {
      if (error instanceof Error && error.message.includes('version conflict')) {
        return res.status(409).json({ error: error.message, code: 'VERSION_CONFLICT' });
      }
      res.status(500).json({ error: error instanceof Error ? error.message : String(error), code: 'INTERNAL_ERROR' });
    }
  });

  router.delete('/provider-configs/:providerConfigId', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found', code: 'WORKSPACE_NOT_FOUND' });
    try {
      const existing = repo.findById(req.params.providerConfigId);
      if (!existing || existing.workspaceId !== workspace.id) {
        return res.status(404).json({ error: 'Provider configuration not found', code: 'PROVIDER_CONFIG_NOT_FOUND' });
      }
      const expectedVersion = typeof req.body.expectedVersion === 'number' && Number.isInteger(req.body.expectedVersion)
        ? req.body.expectedVersion
        : undefined;
      if (expectedVersion === undefined) {
        return res.status(400).json({ error: 'expectedVersion is required for archive', code: 'VALIDATION_ERROR' });
      }
      if (existing.version !== expectedVersion) {
        return res.status(409).json({
          error: `Version conflict: expected ${expectedVersion}, current ${existing.version}`,
          code: 'VERSION_CONFLICT',
        });
      }
      // Check if any enabled agent profile references this config
      const db = store.getDatabase();
      const activeRef = db.prepare(`
        SELECT 1 FROM agent_profiles WHERE provider_config_id = ? AND enabled = 1 LIMIT 1
      `).get(existing.id) as undefined | Record<string, unknown>;
      if (activeRef) {
        return res.status(409).json({
          error: 'Provider configuration is referenced by an enabled agent and cannot be archived',
          code: 'PROVIDER_CONFIG_IN_USE',
        });
      }
      repo.archive(existing.id, expectedVersion);
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error), code: 'INTERNAL_ERROR' });
    }
  });

  return router;
}
