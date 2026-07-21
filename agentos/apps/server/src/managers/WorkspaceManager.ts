import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Workspace } from '@agentos/shared';
import { DEFAULT_WORKSPACE_AGENTS } from '@agentos/agent-core';
import { createEntityId } from '../store/Identity.js';
import { toCanonicalRootPath } from '../store/WorkspacePath.js';
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
    const workspace: Workspace = {
      id: createEntityId('workspace'),
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
    this.store.workspaceRepo.insert(workspace);
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
