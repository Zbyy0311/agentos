import { existsSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Workspace, WorkspaceAgent } from '@agentos/shared';
import type { Store } from '../store/Store.js';

const DEFAULT_AGENTS: WorkspaceAgent[] = [
  { id: 'codex', name: 'Codex', role: 'codex', enabled: true, cliCommand: 'codex', cliArgs: ['exec', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '--ephemeral'] },
  { id: 'kimi', name: 'KimiCode', role: 'kimi', enabled: true, cliCommand: 'opencode', cliArgs: ['--pure', 'run', '--model', 'kimi-for-coding/k2p7'], model: 'kimi-for-coding/k2p7' },
  { id: 'opencode', name: 'OpenCode', role: 'opencode', enabled: true, cliCommand: 'opencode', cliArgs: ['--pure', 'run', '--model', 'deepseek/deepseek-v4-flash'], model: 'deepseek/deepseek-v4-flash' },
];

export class WorkspaceManager {
  constructor(private store: Store) {}

  list(): Workspace[] {
    return this.store.loadWorkspaces().sort((a, b) =>
      new Date(b.lastOpenedAt).getTime() - new Date(a.lastOpenedAt).getTime()
    );
  }

  get(id: string): Workspace | undefined {
    return this.store.loadWorkspaces().find(w => w.id === id);
  }

  create(name: string, rootPath: string, options: { git?: boolean; memory?: boolean; readme?: boolean; docs?: boolean } = {}): Workspace {
    if (this.store.loadWorkspaces().some(w => w.rootPath === rootPath)) {
      throw new Error('Workspace already exists at this path');
    }

    const now = new Date().toISOString();
    const workspace: Workspace = {
      id: randomUUID().slice(0, 8),
      name,
      rootPath,
      gitEnabled: options.git ?? true,
      memoryEnabled: options.memory ?? true,
      agents: structuredClone(DEFAULT_AGENTS),
      lastOpenedAt: now,
      createdAt: now,
      updatedAt: now,
    };

    this.initializeWorkspaceDirectory(workspace, options);
    const workspaces = [...this.store.loadWorkspaces(), workspace];
    this.store.saveWorkspaces(workspaces);
    return workspace;
  }

  importExisting(rootPath: string): Workspace {
    const existing = this.store.loadWorkspaces().find(w => w.rootPath === rootPath);
    if (existing) return this.touch(existing.id);

    const name = rootPath.split(/[\\/]/).pop() || 'imported';
    return this.create(name, rootPath, { git: existsSync(join(rootPath, '.git')), memory: false, readme: false, docs: false });
  }

  remove(id: string): void {
    const workspaces = this.store.loadWorkspaces().filter(w => w.id !== id);
    this.store.saveWorkspaces(workspaces);
  }

  touch(id: string): Workspace {
    const workspaces = this.store.loadWorkspaces();
    const workspace = workspaces.find(w => w.id === id);
    if (!workspace) throw new Error('Workspace not found');
    workspace.lastOpenedAt = new Date().toISOString();
    workspace.updatedAt = new Date().toISOString();
    this.store.saveWorkspaces(workspaces);
    return workspace;
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
      this.ensureFile(join(docsDir, 'AGENT_RULE.md'), `# Agent Rules\n\n## General Rules\n\n1. **No memory deletion** — Agents must never delete or overwrite memory files\n2. **No overlapping work** — Agents must not overwrite another agent's output\n3. **Every modification must be logged** — All changes go to \`agent-memory/LOG.md\`\n4. **Risk must be documented** — Every agent must output risk assessment\n5. **Next steps must be provided** — Every agent output must include next steps\n\n## Codex (Manager) Rules\n- Must break tasks into clear subtasks\n- Must assess risks before proceeding\n- Must make final decision on all work\n- Must document architecture decisions in DECISIONS.md\n\n## KimiCode (Worker) Rules\n- Must follow Codex's task breakdown\n- Must output code changes clearly\n- Must document implementation decisions\n- Must flag uncertainties to Codex\n\n## OpenCode (Reviewer) Rules\n- Must review all code changes\n- Must check for: correctness, security, performance, style\n- Must provide a score (1-10)\n- Must document all findings\n\n## Enforcement\n- Violations are logged in \`agent-memory/LOG.md\`\n- Repeated violations cause pipeline failure\n- Pipeline must not proceed past a failed review\n`);
    }

    if (options.git ?? true) {
      if (!existsSync(join(workspace.rootPath, '.git'))) {
        try {
          const { execSync } = require('node:child_process');
          execSync('git init', { cwd: workspace.rootPath, stdio: 'pipe' });
        } catch { /* git init best-effort */ }
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
