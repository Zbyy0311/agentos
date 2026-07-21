import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Workspace } from '@agentos/shared';
import { DEFAULT_WORKSPACE_AGENTS } from '@agentos/agent-core';
import { createEntityId } from '../store/Identity.js';
import { toCanonicalRootPath } from '../store/WorkspacePath.js';
import { providerFromLegacyRole, defaultRoleTitle, defaultSystemPrompt, defaultPermissions } from '../store/SqliteStore.js';
import { inTransaction } from '../store/Transaction.js';
import type { SqliteStore } from '../store/SqliteStore.js';

export class WorkspaceManager {
  constructor(private store: SqliteStore) {}

  list(): Workspace[] {
    return this.store.loadWorkspaces().sort((a, b) =>
      new Date(b.lastOpenedAt).getTime() - new Date(a.lastOpenedAt).getTime(),
    );
  }

  get(id: string): Workspace | undefined {
    // SQLite-first: check repository
    const ws = this.store.workspaceRepo.findById(id);
    if (ws) return ws;
    // Fallback: JSON dual-read (legacy workspaces not yet migrated to SQLite)
    return this.store.loadWorkspaces().find(w => w.id === id);
  }

  create(name: string, rootPath: string, options: { git?: boolean; memory?: boolean; readme?: boolean; docs?: boolean } = {}): Workspace {
    const canonicalPath = toCanonicalRootPath(rootPath);
    const existing = this.store.workspaceRepo.findByCanonicalPath(canonicalPath);
    if (existing) {
      throw new Error('Workspace already exists at this path');
    }

    const now = new Date().toISOString();
    const wsId = createEntityId('workspace');
    const workspace: Workspace = {
      id: wsId,
      name,
      rootPath,
      gitEnabled: options.git ?? true,
      memoryEnabled: options.memory ?? true,
      agents: structuredClone(DEFAULT_WORKSPACE_AGENTS),
      lastOpenedAt: now,
      createdAt: now,
      updatedAt: now,
    };

    this.initializeWorkspaceDirectory(workspace, options);
    const db = this.store.getDatabase();
    inTransaction(db, () => {
      this.store.workspaceRepo.insertWithinTransaction(workspace);
      for (const agent of workspace.agents) {
        const providerConfigId = createEntityId('provider');
        db.prepare(`
          INSERT INTO provider_configurations (
            id, workspace_id, name, provider_type, adapter_id, runtime_mode,
            executable, args_template_json, model,
            capabilities_json, timeout_policy_json,
            approval_mode, output_mode, enabled, version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        `).run(
          providerConfigId, wsId, `${agent.name} Provider`,
          agent.role === 'codex' ? 'codex' : agent.role === 'opencode' ? 'opencode' : 'custom-cli',
          `builtin.${agent.role}`,
          'cli',
          agent.cliCommand, JSON.stringify(agent.cliArgs), agent.model ?? null,
          JSON.stringify({
            sessionResume: false, structuredEvents: false, nativeApprovals: false,
            subagents: false, toolEvents: false, fileEvents: false, usageEvents: false,
            reasoningStream: false, interactiveInput: false, pause: false,
            cancellation: false, modelSelection: false, workspaceAwareness: false,
            nativeSandbox: false, outputContracts: false,
          }),
          JSON.stringify({
            discoveryTimeoutMs: 10_000, validationTimeoutMs: 30_000,
            startupTimeoutMs: 60_000, idleTimeoutMs: 600_000,
            totalTimeoutMs: null, cancelGracePeriodMs: 5_000, approvalTimeoutMs: null,
          }),
          'agentos', 'parsed-text', 1, now, now,
        );
        const provider = providerFromLegacyRole(agent.role as any);
        db.prepare(`
          INSERT INTO agent_profiles (
            workspace_id, id, name, agent_role, provider, role_title, system_prompt,
            permissions_json, enabled, cli_command, cli_args_json, model,
            thinking_effort, provider_config_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          wsId, agent.id, agent.name, agent.role, provider,
          defaultRoleTitle(agent.role as any), defaultSystemPrompt(agent.role as any),
          JSON.stringify(defaultPermissions(agent.role as any)),
          agent.enabled ? 1 : 0,
          agent.cliCommand, JSON.stringify(agent.cliArgs), agent.model ?? null,
          agent.thinkingEffort ?? 'auto', providerConfigId, now, now,
        );
      }
    });
    return workspace;
  }

  importExisting(rootPath: string): Workspace {
    const canonicalPath = toCanonicalRootPath(rootPath);
    const existing = this.store.workspaceRepo.findByCanonicalPath(canonicalPath);
    if (existing) return this.touch(existing.id);

    const name = rootPath.split(/[\\/]/).pop() || 'imported';
    return this.create(name, rootPath, {
      git: existsSync(join(rootPath, '.git')),
      memory: false,
      readme: false,
      docs: false,
    });
  }

  remove(id: string): void {
    this.store.deleteWorkspace(id);
  }

  touch(id: string): Workspace {
    const existing = this.store.workspaceRepo.findById(id);
    if (!existing) throw new Error('Workspace not found');
    const now = new Date().toISOString();
    const updated = this.store.workspaceRepo.update({
      ...existing,
      lastOpenedAt: now,
      updatedAt: now,
    });
    return updated;
  }

  recent(limit = 5): Workspace[] {
    return this.list().slice(0, limit);
  }

  private initializeWorkspaceDirectory(workspace: Workspace, options: { readme?: boolean; docs?: boolean; memory?: boolean; git?: boolean }): void {
    mkdirSync(workspace.rootPath, { recursive: true });

    if (options.memory ?? true) {
      const memoryDir = join(workspace.rootPath, 'agent-memory');
      mkdirSync(memoryDir, { recursive: true });
      this.ensureFile(join(memoryDir, 'PROJECT.md'), `# ${workspace.name}\n\nProject memory initialized.\n`);
      this.ensureFile(join(memoryDir, 'TASKS.md'), `# Tasks\n\n| ID | Title | Status | Agent | Created | Updated |\n|----|-------|--------|-------|---------|---------|\n`);
      this.ensureFile(join(memoryDir, 'DECISIONS.md'), `# Decisions\n\n`);
      this.ensureFile(join(memoryDir, 'KNOWLEDGE.md'), `# Knowledge\n\n`);
      this.ensureFile(join(memoryDir, 'REVIEW.md'), `# Review\n\n`);
      this.ensureFile(join(memoryDir, 'TEST.md'), `# Test\n\n`);
      this.ensureFile(join(memoryDir, 'LOG.md'), `# Log\n\n| Time | Agent | Action | Task ID | Mode | Result |\n|------|-------|--------|---------|------|--------|\n`);
    }

    if (options.docs ?? true) {
      const docsDir = join(workspace.rootPath, 'docs');
      mkdirSync(docsDir, { recursive: true });
      this.ensureFile(join(docsDir, 'AGENT_RULE.md'), `# Agent Rules

## General Rules

1. **No memory deletion** - Agents must never delete or overwrite memory files
2. **No overlapping work** - Agents must not overwrite another agent's output
3. **Every modification must be logged** - All changes go to \`agent-memory/LOG.md\`
4. **Risk must be documented** - Every agent must output risk assessment
5. **Next steps must be provided** - Every agent output must include next steps

## Codex (Manager) Rules

- Must break tasks into clear subtasks
- Must assess risks before proceeding
- Must make final decision on all work
- Must document architecture decisions in DECISIONS.md

## KimiCode (Worker) Rules

- Must follow Codex's task breakdown
- Must output code changes clearly
- Must document implementation decisions
- Must flag uncertainties to Codex

## OpenCode (Reviewer) Rules

- Must review all code changes
- Must check for: correctness, security, performance, style
- Must provide a score (1-10)
- Must document all findings

## Enforcement

- Violations are logged in \`agent-memory/LOG.md\`
- Repeated violations cause pipeline failure
- Pipeline must not proceed past a failed review
`);
    }

    if (options.git ?? true) {
      if (!existsSync(join(workspace.rootPath, '.git'))) {
        try {
          const { execSync } = require('node:child_process');
          execSync('git init', { cwd: workspace.rootPath, stdio: 'pipe' });
        } catch {
          // git init is best-effort only
        }
      }
    }

    if (options.readme ?? true) {
      this.ensureFile(join(workspace.rootPath, 'README.md'), `# ${workspace.name}\n\nManaged by AgentOS.\n`);
    }
  }

  private ensureFile(path: string, content: string): void {
    if (!existsSync(path)) writeFileSync(path, content, 'utf-8');
  }
}
