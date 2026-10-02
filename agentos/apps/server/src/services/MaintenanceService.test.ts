import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { getWorkflowTemplate } from '@agentos/shared';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MaintenanceBarrier } from './MaintenanceBarrier.js';
import { MaintenanceCoordinator } from './MaintenanceCoordinator.js';
import { MaintenanceService } from './MaintenanceService.js';
import { SqliteStore } from '../store/SqliteStore.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import express from 'express';
import { createMaintenanceRoutes } from '../routes/maintenance.js';
import { main as runMaintenanceCli } from '../commands/maintenance.js';
import { CollaborationRepository } from '../store/CollaborationRepository.js';
import { ConversationRepository } from '../store/ConversationRepository.js';
import { MemoryEntryRepository } from '../store/MemoryEntryRepository.js';
import { TurnContextSnapshotRepository } from '../store/TurnContextSnapshotRepository.js';
import { MemoryFeedbackService } from './MemoryFeedbackService.js';
import { inTransaction } from '../store/Transaction.js';
import { createCollaborationRoutes } from '../routes/collaborations.js';
import { CollaborationWorkflowService } from './CollaborationWorkflowService.js';
import { WorktreeManager } from './WorktreeManager.js';
import { WorkspaceGitRootRegistry } from './WorkspaceGitRootRegistry.js';
import { CollaborationApplyJournalService } from './CollaborationApplyJournal.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (path: string) => {
  prepare(sql: string): { all(...parameters: unknown[]): unknown[]; get(...parameters: unknown[]): unknown; run(...parameters: unknown[]): unknown };
  exec(sql: string): void;
  close(): void;
} };

interface Fixture {
  readonly root: string;
  readonly dataRoot: string;
  readonly workspaceRoot: string;
  readonly store: SqliteStore;
  readonly workspace: ReturnType<WorkspaceManager['create']>;
  readonly service: MaintenanceService;
  cleanup(): void;
}

function createFixture(gitEnabled = false): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'agentos-maintenance-test-'));
  const dataRoot = join(root, 'data-root');
  const workspaceRoot = join(root, 'user-workspace');
  mkdirSync(dataRoot, { recursive: true });
  mkdirSync(workspaceRoot, { recursive: true });
  const store = new SqliteStore(dataRoot);
  const workspaceManager = new WorkspaceManager(store);
  const workspace = workspaceManager.create('Backup fixture', workspaceRoot, { git: gitEnabled, memory: false, docs: false, readme: false });
  const service = new MaintenanceService(dataRoot, store.getDatabase() as any, [{ id: workspace.id, rootPath: workspace.rootPath }]);
  const db = store.getDatabase() as any;
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO conversations (id, workspace_id, conversation_type, title, created_at, updated_at)
    VALUES (?, ?, 'direct', 'Backup fixture', ?, ?)`).run('conv_fixture', workspace.id, now, now);
  db.prepare(`INSERT INTO messages (id, conversation_id, workspace_id, sender_type, content, created_at)
    VALUES (?, ?, ?, 'user', 'fixture message', ?)`).run('msg_fixture', 'conv_fixture', workspace.id, now);
  db.prepare(`INSERT INTO agent_runs (id, workspace_id, conversation_id, source_message_id, objective, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'fixture run', 'completed', ?, ?)`).run('run_fixture', workspace.id, 'conv_fixture', 'msg_fixture', now, now);

  const memoryPath = 'agent-memory/records/knowledge/memory_fixture.md';
  const memoryAbsolute = join(workspaceRoot, ...memoryPath.split('/'));
  mkdirSync(join(memoryAbsolute, '..'), { recursive: true });
  writeFileSync(memoryAbsolute, '# Durable memory evidence\nsource: candidate_fixture\n', 'utf8');
  db.prepare(`INSERT INTO memories (id, workspace_id, memory_type, status, title, summary, content_path,
    tags_json, related_files_json, importance, confidence, created_at, updated_at)
    VALUES (?, ?, 'knowledge', 'active', 'Durable memory', 'Evidence summary', ?, '[]', '[]', 90, 95, ?, ?)`)
    .run('memory_fixture', workspace.id, memoryPath, now, now);
  db.prepare(`INSERT INTO memory_candidates (id, workspace_id, run_id, memory_type, title, summary, content,
    confidence, operation, conflicting_memory_ids_json, status, created_at)
    VALUES (?, ?, ?, 'knowledge', 'Unapplied candidate', 'Candidate summary', 'candidate evidence', 90, 'create', '[]', 'pending', ?)`)
    .run('candidate_fixture', workspace.id, 'run_fixture', now);

  const attachmentPath = '.agentos/attachments/conv_fixture/attachment.png';
  const attachmentAbsolute = join(workspaceRoot, ...attachmentPath.split('/'));
  mkdirSync(join(attachmentAbsolute, '..'), { recursive: true });
  writeFileSync(attachmentAbsolute, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x44]));
  db.prepare(`INSERT INTO message_attachments (id, message_id, conversation_id, workspace_id, name, mime_type, size, relative_path)
    VALUES (?, ?, ?, ?, 'attachment.png', 'image/png', 9, ?)`)
    .run('attachment_fixture', 'msg_fixture', 'conv_fixture', workspace.id, attachmentPath);

  const candidateEvidence = join(dataRoot, '.agentos', 'candidates', 'candidate_fixture.json');
  const reviewEvidence = join(dataRoot, '.agentos', 'evidence', 'review_fixture.json');
  mkdirSync(join(candidateEvidence, '..'), { recursive: true });
  mkdirSync(join(reviewEvidence, '..'), { recursive: true });
  writeFileSync(candidateEvidence, JSON.stringify({ id: 'candidate_fixture', status: 'awaiting_application' }), 'utf8');
  writeFileSync(reviewEvidence, JSON.stringify({ candidateId: 'candidate_fixture', conclusion: 'approved' }), 'utf8');
  writeFileSync(join(dataRoot, '.agentos', 'provider-private.json'), '{"privateProfile":"preserve-in-backup"}\n', 'utf8');
  mkdirSync(join(dataRoot, 'workspace'), { recursive: true });
  writeFileSync(join(dataRoot, 'workspace', 'workspaces.json'), JSON.stringify({
    workspaces: [{ id: workspace.id, name: workspace.name, rootPath: workspace.rootPath, agents: [] }],
  }), 'utf8');

  return {
    root, dataRoot, workspaceRoot, store, workspace, service,
    cleanup() {
      try { store.close(); } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10 }); }
    },
  };
}

async function cloneBackup(source: string, root: string): Promise<string> {
  const cloned = join(root, `backup-copy-${Math.random().toString(16).slice(2)}`);
  cpSync(source, cloned, { recursive: true });
  return cloned;
}

test('online backup drains writes and active executions, then restores SQLite candidates, memory, attachments and evidence', async () => {
  const fx = createFixture();
  const barrier = new MaintenanceBarrier();
  let activeExecutions = 1;
  const coordinator = new MaintenanceCoordinator(fx.dataRoot, 'test-instance', barrier, {
    inspectActivity: () => ({ counts: { activeExecutions } }),
    drainTimeoutMs: 2_000,
    maxDurationMs: 5_000,
  });
  const db = fx.store.getDatabase() as any;
  const releaseWrite = barrier.enterMutation()!;
  db.exec('BEGIN IMMEDIATE');
  db.prepare(`UPDATE memory_candidates SET content = ? WHERE id = ?`).run('committed-in-maintenance-test', 'candidate_fixture');

  try {
    const running = coordinator.run('backup', ({ signal }) => fx.service.createBackup({ signal }));
    await new Promise(resolvePromise => setTimeout(resolvePromise, 10));
    assert.equal(barrier.snapshot.quiescing, true);
    assert.equal(barrier.enterMutation(), undefined, 'writes are rejected after the fence closes');
    assert.equal(barrier.enterDispatcherStart(), undefined, 'new dispatch starts are rejected after the fence closes');
    db.exec('COMMIT');
    activeExecutions = 0;
    releaseWrite();

    const completed = await running;
    assert.equal(completed.drain.activeMutatingRequests, 0);
    assert.equal(completed.drain.activity.counts.activeExecutions, 0);
    const backupPath = completed.result.backupDirectory;
    const restoredRoot = join(fx.root, 'restored-data');
    const originalMemoryPath = join(fx.workspaceRoot, 'agent-memory', 'records', 'knowledge', 'memory_fixture.md');
    const originalMemoryBytes = readFileSync(originalMemoryPath);
    const originalMemoryMtime = statSync(originalMemoryPath).mtimeMs;
    const restored = await MaintenanceService.restoreBackup(backupPath, restoredRoot);
    assert.equal(restored.schemaVersion, DEFAULT_REGISTRY_MIGRATIONS.at(-1)?.id);
    assert.equal(restored.dataRoot, restoredRoot);
    assert.equal(completed.result.manifest.buildVersion.length > 0, true);
    assert.equal(completed.result.manifest.buildCommit.length > 0, true);
    assert.equal(completed.result.manifest.buildId.length > 0, true);
    assert.equal(readFileSync(join(restoredRoot, '.agentos', 'provider-private.json'), 'utf8'), '{"privateProfile":"preserve-in-backup"}\n');
    assert.equal(readFileSync(join(restoredRoot, '.agentos', 'candidates', 'candidate_fixture.json'), 'utf8').includes('awaiting_application'), true);
    const isolatedWorkspaceRoot = join(restoredRoot, 'workspace-roots', fx.workspace.id);
    assert.equal(readFileSync(join(isolatedWorkspaceRoot, 'agent-memory', 'records', 'knowledge', 'memory_fixture.md'), 'utf8').includes('Durable memory evidence'), true);
    assert.equal(readFileSync(join(isolatedWorkspaceRoot, '.agentos', 'attachments', 'conv_fixture', 'attachment.png')).byteLength, 9);
    assert.deepEqual(readFileSync(originalMemoryPath), originalMemoryBytes,
      'restore must not create or change referenced files in the original workspace');
    assert.equal(statSync(originalMemoryPath).mtimeMs, originalMemoryMtime);
    const restoredLegacy = JSON.parse(readFileSync(join(restoredRoot, 'workspace', 'workspaces.json'), 'utf8')) as { workspaces: Array<{ id: string; rootPath: string }> };
    assert.equal(restoredLegacy.workspaces[0]?.rootPath, isolatedWorkspaceRoot);

    const restoredDb = new DatabaseSync(join(restoredRoot, '.agentos', 'agentos.sqlite'));
    try {
      assert.equal((restoredDb.prepare('SELECT content FROM memory_candidates WHERE id = ?').get('candidate_fixture') as { content: string }).content,
        'committed-in-maintenance-test');
      assert.equal((restoredDb.prepare('SELECT content_path FROM memories WHERE id = ?').get('memory_fixture') as { content_path: string }).content_path,
        'agent-memory/records/knowledge/memory_fixture.md');
      const mappedRoot = restoredDb.prepare('SELECT root_path, canonical_root_path FROM workspaces WHERE id = ?').get(fx.workspace.id) as { root_path: string; canonical_root_path: string };
      assert.equal(mappedRoot.root_path, isolatedWorkspaceRoot);
      assert.equal(mappedRoot.canonical_root_path, isolatedWorkspaceRoot);
      assert.equal((restoredDb.prepare('SELECT COUNT(*) AS count FROM message_attachments WHERE id = ?').get('attachment_fixture') as { count: number }).count, 1);
      assert.equal((restoredDb.prepare('PRAGMA integrity_check').all()[0] as { integrity_check: string }).integrity_check, 'ok');
      assert.equal(restoredDb.prepare('PRAGMA foreign_key_check').all().length, 0);
    } finally {
      restoredDb.close();
    }
    assert.equal(coordinator.status.quiescing, false);
    assert.equal(JSON.parse(readFileSync(join(fx.dataRoot, '.agentos', 'maintenance-state.json'), 'utf8')).status, 'completed');
  } finally {
    if (barrier.snapshot.activeMutatingRequests > 0) releaseWrite();
    try { db.exec('ROLLBACK'); } catch { /* transaction already committed */ }
    fx.cleanup();
  }
});

test('HTTP backup route and offline CLI restore preserve referenced files in an isolated workspace', async () => {
  const fx = createFixture(true);
  const collaboration = seedBinaryCollaborationCandidate(fx);
  const feedback = seedMemoryFeedbackProof(fx);
  const barrier = new MaintenanceBarrier();
  const coordinator = new MaintenanceCoordinator(fx.dataRoot, 'http-e2e-instance', barrier, {
    inspectActivity: () => ({ counts: {} }),
    drainTimeoutMs: 2_000,
    maxDurationMs: 5_000,
  });
  const app = express();
  app.use(express.json());
  app.use('/api/maintenance', createMaintenanceRoutes({
    coordinator,
    diagnostics: { async readiness() { return { ok: true }; } } as any,
    service: fx.service,
    instanceId: 'http-e2e-instance',
  }));
  const server = await new Promise<ReturnType<typeof app.listen>>(resolvePromise => {
    const listening = app.listen(0, '127.0.0.1', () => resolvePromise(listening));
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const originalMemoryPath = join(fx.workspaceRoot, 'agent-memory', 'records', 'knowledge', 'memory_fixture.md');
  const originalMemoryBytes = readFileSync(originalMemoryPath);
  const originalMemoryMtime = statSync(originalMemoryPath).mtimeMs;
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/maintenance/backup`, { method: 'POST' });
    assert.equal(response.status, 201);
    const backup = await response.json() as { backupDirectory: string; fileCount: number };
    assert.ok(backup.backupDirectory);
    assert.ok(backup.fileCount >= 5);
    const manifest = await MaintenanceService.readAndVerifyBackup(backup.backupDirectory);
    assert.equal(manifest.files.some(item => item.targetPath.startsWith('.agentos/worktrees/')), false,
      'the disposable Git worktree is intentionally excluded; candidate data must be independently durable');
    execFileSync('git', ['worktree', 'remove', '--force', collaboration.sourceWorktree], { cwd: fx.workspaceRoot, stdio: 'pipe', windowsHide: true });
    await new Promise<void>((resolvePromise, rejectPromise) => server.close(error => error ? rejectPromise(error) : resolvePromise()));

    const restoredRoot = join(fx.root, 'http-e2e-restored-data');
    assert.equal(await runMaintenanceCli([
      'restore', '--backup', backup.backupDirectory,
      '--source-data-root', fx.dataRoot,
      '--target-data-root', restoredRoot,
    ]), 0);

    const isolatedWorkspaceRoot = join(restoredRoot, 'workspace-roots', fx.workspace.id);
    assert.equal(readFileSync(join(isolatedWorkspaceRoot, 'agent-memory', 'records', 'knowledge', 'memory_fixture.md'), 'utf8')
      .includes('Durable memory evidence'), true);
    assert.equal(readFileSync(join(isolatedWorkspaceRoot, '.agentos', 'attachments', 'conv_fixture', 'attachment.png')).byteLength, 9);
    assert.equal(readFileSync(join(restoredRoot, '.agentos', 'candidates', 'candidate_fixture.json'), 'utf8')
      .includes('awaiting_application'), true);
    assert.equal(readFileSync(join(restoredRoot, '.agentos', 'evidence', 'review_fixture.json'), 'utf8')
      .includes('approved'), true);
    assert.deepEqual(readFileSync(originalMemoryPath), originalMemoryBytes);
    assert.equal(statSync(originalMemoryPath).mtimeMs, originalMemoryMtime);

    const restoredDb = new DatabaseSync(join(restoredRoot, '.agentos', 'agentos.sqlite'));
    try {
      assert.equal((restoredDb.prepare('PRAGMA integrity_check').all()[0] as { integrity_check: string }).integrity_check, 'ok');
      assert.equal(restoredDb.prepare('PRAGMA foreign_key_check').all().length, 0);
      assert.equal((restoredDb.prepare('SELECT COUNT(*) AS count FROM memory_candidates WHERE id = ?')
        .get('candidate_fixture') as { count: number }).count, 1);
      const restoredFeedback = restoredDb.prepare(`SELECT f.context_hash, f.kind, a.status, a.version
        FROM memory_version_feedback f JOIN memory_feedback_actions a ON a.feedback_id=f.id WHERE f.id=?`)
        .get(feedback.id) as { context_hash: string; kind: string; status: string; version: number } | undefined;
      assert.deepEqual(restoredFeedback && { ...restoredFeedback }, {
        context_hash: createHash('sha256').update(feedback.frozenContext).digest('hex'),
        kind: 'wrong', status: 'resolved', version: 2,
      }, 'frozen memory feedback and its resolved correction action survive the backup');
      const restoredProof = restoredDb.prepare(`SELECT from_status, to_status, expected_version, version
        FROM memory_feedback_action_audit WHERE action_id=?`).get(feedback.actionId) as {
          from_status: string; to_status: string; expected_version: number; version: number;
        } | undefined;
      assert.deepEqual(restoredProof && { ...restoredProof }, { from_status: 'pending', to_status: 'resolved', expected_version: 1, version: 2 },
        'the feedback action audit proof survives and remains FK-valid');
      const mappedRoot = restoredDb.prepare('SELECT root_path, canonical_root_path FROM workspaces WHERE id = ?')
        .get(fx.workspace.id) as { root_path: string; canonical_root_path: string };
      assert.equal(mappedRoot.root_path, isolatedWorkspaceRoot);
      assert.equal(mappedRoot.canonical_root_path, isolatedWorkspaceRoot);
    } finally {
      restoredDb.close();
    }

    assert.equal(existsSync(join(restoredRoot, '.agentos', 'worktrees')), false);
    const restoredStore = new SqliteStore(restoredRoot);
    const restoredWorkspaces = new WorkspaceManager(restoredStore);
    const restoredWorktrees = new WorktreeManager(join(restoredRoot, '.agentos', 'worktrees'));
    const gitRoots = new WorkspaceGitRootRegistry(restoredRoot, restoredStore, restoredWorkspaces, restoredWorktrees);
    try {
      const beforeReconnect = await gitRoots.status(fx.workspace.id);
      assert.equal(beforeReconnect.canReview, false, 'the isolated non-Git workspace is never presented as review-ready');
      assert.equal(beforeReconnect.canApply, false, 'the isolated non-Git workspace is never presented as applicable');
      assert.equal(beforeReconnect.reasonCode, 'WORKSPACE_GIT_ROOT_UNAVAILABLE');
      const reconnectedRoot = join(fx.root, 'reconnected-project');
      execFileSync('git', ['-c', 'core.symlinks=false', 'clone', '--quiet', fx.workspaceRoot, reconnectedRoot], {
        stdio: 'pipe', windowsHide: true,
      });
      execFileSync('git', ['config', 'core.symlinks', 'false'], { cwd: reconnectedRoot, stdio: 'pipe', windowsHide: true });
      const checked = await gitRoots.check(fx.workspace.id, reconnectedRoot);
      assert.equal(checked.canReview, true);
      assert.equal(checked.canApply, true);
      assert.equal(checked.activeCandidateCount, 1);
      assert.equal((await gitRoots.reconnect(fx.workspace.id, reconnectedRoot)).explicitlyReconnected, true);

      const restoredService = new CollaborationWorkflowService({
        store: restoredStore,
        workspaces: restoredWorkspaces,
        worktrees: restoredWorktrees,
        workspaceGitRootFor: id => gitRoots.rootPathFor(id),
        dispatchRun: async () => undefined,
        requestRunAdmission: async () => false,
        releaseRunAdmission: async () => undefined,
        requestApplicationAdmission: async () => true,
        releaseApplicationAdmission: async () => undefined,
        cancelRun: async () => ({ expectedRunVersion: 1, worktreePreserved: true }),
        registerWorktreePath: () => undefined,
      });
      const collaborationApp = express();
      collaborationApp.use(express.json());
      collaborationApp.use('/api/workspaces/:workspaceId', createCollaborationRoutes(restoredService, restoredWorkspaces));
      const collaborationServer = await new Promise<ReturnType<typeof collaborationApp.listen>>(resolvePromise => {
        const listening = collaborationApp.listen(0, '127.0.0.1', () => resolvePromise(listening));
      });
      const collaborationAddress = collaborationServer.address();
      assert.ok(collaborationAddress && typeof collaborationAddress === 'object');
      try {
        const detailResponse = await fetch(`http://127.0.0.1:${collaborationAddress.port}/api/workspaces/${fx.workspace.id}/collaboration/tasks/${collaboration.taskId}`);
        assert.equal(detailResponse.status, 200);
        const details = await detailResponse.json() as {
          task: { version: number };
          candidates: Array<{ id: string; diffText: string; manifest: Array<{ path: string; sizeBytes: number; sha256: string }> }>;
          reviews: Array<{ id: string; summary: string }>;
        };
        const candidate = details.candidates.find(item => item.id === collaboration.candidateId);
        assert.ok(candidate);
        assert.match(candidate.diffText, /GIT binary patch/u);
        assert.deepEqual(candidate.manifest, [{
          path: 'payload.bin', sizeBytes: collaboration.candidateBytes.byteLength,
          sha256: createHash('sha256').update(collaboration.candidateBytes).digest('hex'),
        }]);
        assert.equal(details.reviews.some(review => review.id === collaboration.reviewId), true);
        assert.equal(readFileSync(join(restoredRoot, '.agentos', 'artifacts', fx.workspace.id, collaboration.runId,
          collaboration.diffArtifactId, 'content'), 'utf8'), candidate.diffText);
        assert.equal(readFileSync(join(restoredRoot, '.agentos', 'artifacts', fx.workspace.id, collaboration.runId,
          collaboration.reviewArtifactId, 'content'), 'utf8'), 'Binary candidate reviewed and approved.');

        const applyResponse = await fetch(`http://127.0.0.1:${collaborationAddress.port}/api/workspaces/${fx.workspace.id}/collaboration/tasks/${collaboration.taskId}/apply`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'restored-binary-candidate-apply' },
          body: JSON.stringify({ expectedVersion: details.task.version }),
        });
        assert.equal(applyResponse.status, 200, await applyResponse.clone().text());
        const applied = await applyResponse.json() as { task: { status: string } };
        assert.equal(applied.task.status, 'applied');
        assert.deepEqual(readFileSync(join(reconnectedRoot, 'payload.bin')), collaboration.candidateBytes,
          'the restored frozen candidate applies through the real collaboration route after explicit Git reconnection');
        assert.deepEqual(readFileSync(join(fx.workspaceRoot, 'payload.bin')), Buffer.from([0, 1, 2, 3, 4]),
          'apply changes only the explicitly reconnected isolated project');
      } finally {
        await new Promise<void>(resolvePromise => collaborationServer.close(() => resolvePromise()));
      }
    } finally {
      restoredStore.close();
    }
  } finally {
    if (server.listening) await new Promise<void>(resolvePromise => server.close(() => resolvePromise()));
    fx.cleanup();
  }
});

function seedBinaryCollaborationCandidate(fx: Fixture): {
  readonly taskId: string; readonly candidateId: string; readonly reviewId: string; readonly runId: string;
  readonly baseCommit: string; readonly candidateBytes: Buffer; readonly diffArtifactId: string; readonly reviewArtifactId: string;
  readonly sourceWorktree: string;
} {
  // Git for Windows creates dangling .git/t* reparse entries when symlinks are
  // enabled; disabling them keeps this disposable binary-only fixture removable.
  execFileSync('git', ['-c', 'core.symlinks=false', 'init', '-q'], { cwd: fx.workspaceRoot, stdio: 'pipe', windowsHide: true });
  execFileSync('git', ['config', 'core.symlinks', 'false'], { cwd: fx.workspaceRoot, stdio: 'pipe', windowsHide: true });
  execFileSync('git', ['config', 'user.email', 'agentos-test@example.invalid'], { cwd: fx.workspaceRoot, stdio: 'pipe', windowsHide: true });
  execFileSync('git', ['config', 'user.name', 'AgentOS Test'], { cwd: fx.workspaceRoot, stdio: 'pipe', windowsHide: true });
  writeFileSync(join(fx.workspaceRoot, 'payload.bin'), Buffer.from([0, 1, 2, 3, 4]));
  execFileSync('git', ['add', '-A'], { cwd: fx.workspaceRoot, stdio: 'pipe', windowsHide: true });
  execFileSync('git', ['commit', '-qm', 'backup fixture base'], { cwd: fx.workspaceRoot, stdio: 'pipe', windowsHide: true });
  const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.workspaceRoot, encoding: 'utf8', windowsHide: true }).trim();
  const candidateWorktree = join(fx.dataRoot, '.agentos', 'worktrees', 'candidate-source');
  mkdirSync(join(candidateWorktree, '..'), { recursive: true });
  execFileSync('git', ['worktree', 'add', '--detach', candidateWorktree, baseCommit], { cwd: fx.workspaceRoot, stdio: 'pipe', windowsHide: true });
  const candidateBytes = Buffer.from([0, 255, 17, 0, 99, 128, 4, 33]);
  writeFileSync(join(candidateWorktree, 'payload.bin'), candidateBytes);
  const diffText = execFileSync('git', ['diff', '--binary', '--', 'payload.bin'], { cwd: candidateWorktree, encoding: 'utf8', windowsHide: true });
  const db = fx.store.getDatabase() as any;
  const now = new Date().toISOString();
  const repository = new CollaborationRepository(db);
  const [planner, implementer, reviewer] = fx.workspace.agents;
  assert.ok(planner && implementer && reviewer);
  const plan = repository.create({
    workspaceId: fx.workspace.id, title: 'Binary backup candidate', objective: 'Preserve a frozen binary candidate',
    scope: ['payload.bin'], acceptanceCommands: ['node -e "process.exit(0)"'], plannerAgentId: planner.id,
    implementerAgentId: implementer.id, reviewerAgentId: reviewer.id, planHash: 'binary-candidate-plan', baseCommit,
    maxReworkRounds: 1, createdAt: now,
  });
  const graph = fx.store.workflowTemplateService().instantiateTemplateRun({
    workspace: fx.workspace,
    template: getWorkflowTemplate('plan-implement-review')!,
    roleBindings: { planner: planner.role, implementer: implementer.role, reviewer: reviewer.role },
    agentBindings: { plan: planner.id, implement: implementer.id, review: reviewer.id },
    createdBy: 'maintenance-backup-test', createdAt: now, worktreeMode: 'required',
  });
  const confirmed = repository.confirm({ workspaceId: fx.workspace.id, id: plan.id, expectedVersion: plan.version,
    canonicalTaskId: graph.task.id, canonicalRunId: graph.run.id, confirmedAt: now, idempotencyKey: 'backup-candidate-confirm' });
  const running = repository.progress({ workspaceId: fx.workspace.id, id: plan.id, expectedVersion: confirmed.version, status: 'running' });
  const reviewing = repository.progress({ workspaceId: fx.workspace.id, id: plan.id, expectedVersion: running.version, status: 'reviewing' });
  const reviewStage = fx.store.runStageRepository().listByRun(fx.workspace.id, graph.run.id)
    .find(stage => stage.workflowStageKey === 'review');
  assert.ok(reviewStage);
  db.prepare("UPDATE runs SET status='completed',completed_at=?,updated_at=? WHERE workspace_id=? AND id=?")
    .run(now, now, fx.workspace.id, graph.run.id);
  db.prepare("UPDATE run_stages SET status='completed',started_at=?,completed_at=?,updated_at=?,version=version+1 WHERE workspace_id=? AND run_id=? AND id=?")
    .run(now, now, now, fx.workspace.id, graph.run.id, reviewStage.id);
  const testOutput = execFileSync('node', ['-e', 'process.exit(0)'], { cwd: candidateWorktree, encoding: 'utf8', windowsHide: true });
  const candidateId = 'candidate-binary-backup';
  const diffArtifactId = 'artifact-binary-diff';
  const manifestArtifactId = 'artifact-binary-manifest';
  const reviewArtifactId = 'artifact-binary-review';
  const manifest = [{ path: 'payload.bin', sizeBytes: candidateBytes.byteLength, sha256: createHash('sha256').update(candidateBytes).digest('hex') }];
  repository.createCandidate({
    id: candidateId, collaborationTaskId: plan.id, workspaceId: fx.workspace.id, canonicalRunId: graph.run.id,
    round: 0, baseCommit, headCommit: baseCommit, diffHash: createHash('sha256').update(diffText).digest('hex'),
    diffText, snapshotVersion: 2, manifest, testStatus: 'passed', testCommand: 'node -e "process.exit(0)"',
    testExitCode: 0, testOutput: `${testOutput}\nexit 0`, status: 'created', diffArtifactId, manifestArtifactId, createdAt: now,
  });
  const reviewSummary = 'Binary candidate reviewed and approved.';
  repository.recordStageOutput({
    workspaceId: fx.workspace.id, collaborationTaskId: plan.id, runId: graph.run.id, stageId: reviewStage.id,
    stageAttempt: reviewStage.attempt, agentId: reviewer.id, role: 'reviewer', status: 'available',
    publicOutput: reviewSummary, outputHash: createHash('sha256').update(reviewSummary).digest('hex'), createdAt: now,
    reviewCandidateId: candidateId, reviewCandidateHash: createHash('sha256').update(diffText).digest('hex'), reviewConclusion: 'approved',
  });
  repository.reviewCandidate({ workspaceId: fx.workspace.id, candidateId, conclusion: 'approved',
    summary: reviewSummary, reviewerAgentId: reviewer.id, artifactId: reviewArtifactId });
  const reviewId = 'review-binary-backup';
  repository.createReview({
    id: reviewId, collaborationTaskId: plan.id, candidateId, workspaceId: fx.workspace.id, canonicalRunId: graph.run.id,
    stageId: reviewStage.id, stageAttempt: reviewStage.attempt, reviewerAgentId: reviewer.id,
    candidateDiffHash: createHash('sha256').update(diffText).digest('hex'), conclusion: 'approved',
    summary: reviewSummary, artifactId: reviewArtifactId, createdAt: now,
  });
  repository.progress({ workspaceId: fx.workspace.id, id: plan.id, expectedVersion: reviewing.version,
    status: 'awaiting_application', currentCandidateId: candidateId });
  const artifactRoot = join(fx.dataRoot, '.agentos', 'artifacts', fx.workspace.id, graph.run.id);
  for (const [id, bytes] of [
    [diffArtifactId, Buffer.from(diffText)],
    [manifestArtifactId, Buffer.from(JSON.stringify(manifest))],
    [reviewArtifactId, Buffer.from('Binary candidate reviewed and approved.')],
  ] as const) {
    const path = join(artifactRoot, id, 'content');
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, bytes);
  }
  const evidencePath = join(fx.dataRoot, '.agentos', 'evidence', `${candidateId}.json`);
  mkdirSync(join(evidencePath, '..'), { recursive: true });
  writeFileSync(evidencePath, JSON.stringify({ candidateId, diffHash: createHash('sha256').update(diffText).digest('hex'), reviewId }));
  return { taskId: plan.id, candidateId, reviewId, runId: graph.run.id, baseCommit, candidateBytes, diffArtifactId, reviewArtifactId,
    sourceWorktree: candidateWorktree };
}

function seedMemoryFeedbackProof(fx: Fixture): { readonly id: string; readonly actionId: string; readonly frozenContext: string } {
  const now = new Date().toISOString();
  const memoryId = 'backup-feedback-memory-entry';
  const frozenContext = 'Frozen context used to prove the reviewed memory version.';
  new MemoryEntryRepository(fx.store.getDatabase()).createEntry({
    id: memoryId, workspaceId: fx.workspace.id, scope: 'workspace', category: 'knowledge',
    authority: 'user-explicit', confidence: 1, importance: 1, status: 'active',
    title: 'Feedback proof memory', content: 'The exact version selected for this turn.', sources: [], createdAt: now,
  });
  new ConversationRepository(fx.store.getDatabase()).createConversation({
    id: 'backup-feedback-conversation', workspaceId: fx.workspace.id, kind: 'direct',
    title: 'Feedback proof context', createdAt: now,
  });
  inTransaction(fx.store.getDatabase(), () => new TurnContextSnapshotRepository(fx.store.getDatabase()).insertWithinTransaction({
    id: 'backup-feedback-turn', workspaceId: fx.workspace.id, conversationId: 'backup-feedback-conversation',
    agentId: fx.workspace.agents[0]!.id, budgetJson: '{}', selectedEntryIdsJson: JSON.stringify([memoryId]),
    totalTokens: 12, truncated: false, queryHash: 'b'.repeat(64), retrievalStrategyVersion: 'maintenance-backup-test',
    createdAt: now,
    memoryPayload: {
      contextText: frozenContext,
      selected: [{ memoryId, memoryVersion: 1, rank: 1, score: 1, scope: 'workspace', category: 'knowledge',
        authority: 'user-explicit', confidence: 1, importance: 1, tokenCost: 12, reasons: ['scope-match'], sourceRefs: [] }],
      exclusions: [], retrievalDegraded: false,
    },
  }));
  const service = new MemoryFeedbackService(fx.store.getDatabase());
  const item = service.add(fx.workspace.id, {
    expectedVersion: 1, memoryId, memoryVersion: 1, contextKind: 'turn', contextId: 'backup-feedback-turn',
    kind: 'wrong', comment: 'Preserve this reviewed correction and its evidence.',
  });
  assert.ok(item.action);
  service.resolveAction(fx.workspace.id, item.action.id, 1, 'resolved');
  return { id: item.id, actionId: item.action.id, frozenContext };
}

test('restore isolates interrupted collaboration apply and preserves verified recovery payload', async () => {
  const fx = createFixture(true);
  const collaboration = seedBinaryCollaborationCandidate(fx);
  const db = fx.store.getDatabase() as any;
  const controlId = 'control-restore-recovery';
  const sourceBytes = readFileSync(join(fx.workspaceRoot, 'payload.bin'));
  const recoveryRoot = join(fx.dataRoot, '.agentos', 'collaboration-apply-recovery');
  const recoveryPath = join(recoveryRoot, `${controlId}.json`);
  const image = {
    path: 'payload.bin', pre: sourceBytes.toString('base64'), post: collaboration.candidateBytes.toString('base64'),
    preMode: 0o644, postMode: 0o644,
  };
  const digest = (value: Buffer | null) => value === null ? null : createHash('sha256').update(value).digest('hex');
  const journal = {
    controlId, workspaceId: fx.workspace.id, taskId: collaboration.taskId, candidateId: collaboration.candidateId,
    candidateHash: (db.prepare('SELECT diff_hash FROM collaboration_candidates WHERE id=?').get(collaboration.candidateId) as { diff_hash: string }).diff_hash,
    baseCommit: collaboration.baseCommit, targetRoot: fx.workspaceRoot, recoveryPath, images: [image], state: 'written',
  };
  const serialized = JSON.stringify(journal);
  const imagesJson = JSON.stringify({
    recoveryHash: createHash('sha256').update(serialized).digest('hex'),
    paths: [{ path: image.path, pre: digest(sourceBytes), post: digest(collaboration.candidateBytes) }],
  });
  mkdirSync(recoveryRoot, { recursive: true });
  writeFileSync(recoveryPath, serialized, { flag: 'wx' });
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO collaboration_controls(id,workspace_id,collaboration_task_id,action,idempotency_key,request_hash,
    expected_version,epoch,canonical_run_id,candidate_id,state,created_at,updated_at)
    VALUES(?,?,?,'apply',?,?,1,1,?,?,'running',?,?)`).run(
    controlId, fx.workspace.id, collaboration.taskId, 'restore-recovery-key', 'restore-recovery-request',
    collaboration.runId, collaboration.candidateId, now, now,
  );
  db.prepare(`INSERT INTO collaboration_apply_journals(control_id,workspace_id,collaboration_task_id,candidate_id,candidate_hash,
    base_commit,state,recovery_path,images_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,'written',?,?,?,?)`).run(
    controlId, fx.workspace.id, collaboration.taskId, collaboration.candidateId, journal.candidateHash,
    collaboration.baseCommit, recoveryPath, imagesJson, now, now,
  );
  try {
    const backup = await fx.service.createBackup();
    execFileSync('git', ['worktree', 'remove', '--force', collaboration.sourceWorktree], { cwd: fx.workspaceRoot, stdio: 'pipe', windowsHide: true });
    const restoredRoot = join(fx.root, 'recovery-isolated-data');
    await MaintenanceService.restoreBackup(backup.backupDirectory, restoredRoot);
    assert.deepEqual(readFileSync(join(fx.workspaceRoot, 'payload.bin')), sourceBytes,
      'restore preserves the original project preimage and never replays journal bytes into it');

    const restoredDb = new DatabaseSync(join(restoredRoot, '.agentos', 'agentos.sqlite'));
    try {
      const control = restoredDb.prepare('SELECT state,error_code,recovery_reference FROM collaboration_controls WHERE id=?').get(controlId) as {
        state: string; error_code: string; recovery_reference: string;
      };
      const applyJournal = restoredDb.prepare('SELECT state,recovery_path FROM collaboration_apply_journals WHERE control_id=?').get(controlId) as {
        state: string; recovery_path: string;
      };
      assert.equal(control.state, 'recovery_required');
      assert.equal(control.error_code, 'RESTORE_RECOVERY_REQUIRED');
      assert.equal(applyJournal.state, 'recovery_required');
      assert.equal(control.recovery_reference, applyJournal.recovery_path);
      assert.equal(applyJournal.recovery_path, join(restoredRoot, '.agentos', 'collaboration-apply-recovery', `${controlId}.json`));
      const restoredMaterial = JSON.parse(readFileSync(applyJournal.recovery_path, 'utf8')) as typeof journal;
      assert.equal(restoredMaterial.targetRoot, join(restoredRoot, 'workspace-roots', fx.workspace.id));
      assert.equal(restoredMaterial.recoveryPath, applyJournal.recovery_path);
      assert.equal(restoredMaterial.state, 'recovery_required');
      assert.deepEqual(restoredMaterial.images, [image]);
      assert.equal((restoredDb.prepare('PRAGMA integrity_check').all()[0] as { integrity_check: string }).integrity_check, 'ok');
      assert.equal(restoredDb.prepare('PRAGMA foreign_key_check').all().length, 0);
    } finally { restoredDb.close(); }

    const restoredStore = new SqliteStore(restoredRoot);
    try {
      const pending = await new CollaborationApplyJournalService(restoredStore.getDatabase()).loadPending();
      assert.equal(pending.length, 1);
      assert.equal(pending[0]?.state, 'recovery_required');
      assert.equal(pending[0]?.targetRoot, join(restoredRoot, 'workspace-roots', fx.workspace.id));
      assert.equal(pending[0]?.images[0]?.post, collaboration.candidateBytes.toString('base64'));
    } finally { restoredStore.close(); }
  } finally {
    fx.cleanup();
  }
});

test('restore rejects a modified payload hash and preserves both the source and absent target', async () => {
  const fx = createFixture();
  try {
    const backup = await fx.service.createBackup();
    assert.throws(() => MaintenanceService.assertMatchingBuild({ ...backup.manifest, buildCommit: '0000000000000000000000000000000000000000' }),
      (error: { code?: string }) => error.code === 'RESTORE_BUILD_MISMATCH');
    const tampered = await cloneBackup(backup.backupDirectory, fx.root);
    const manifest = JSON.parse(readFileSync(join(tampered, 'manifest.json'), 'utf8')) as { files: Array<{ payloadPath: string; scope: string }> };
    const entry = manifest.files.find(item => item.scope === 'data-root')!;
    writeFileSync(join(tampered, ...entry.payloadPath.split('/')), 'changed bytes');
    const target = join(fx.root, 'must-stay-absent');
    await assert.rejects(MaintenanceService.restoreBackup(tampered, target), (error: { code?: string }) => error.code === 'BACKUP_HASH_MISMATCH');
    assert.equal(existsSync(target), false);
    assert.equal((fx.store.getDatabase() as any).prepare('SELECT COUNT(*) AS count FROM memory_candidates').get().count, 1);
  } finally {
    fx.cleanup();
  }
});

test('restore rejects manifest path traversal before writing anywhere', async () => {
  const fx = createFixture();
  try {
    const backup = await fx.service.createBackup();
    const tampered = await cloneBackup(backup.backupDirectory, fx.root);
    const manifestPath = join(tampered, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { files: Array<{ payloadPath: string; scope: string; targetPath: string }> };
    const entry = manifest.files.find(item => item.scope === 'data-root')!;
    entry.targetPath = '../../outside.txt';
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const target = join(fx.root, 'traversal-target');
    await assert.rejects(MaintenanceService.restoreBackup(tampered, target), (error: { code?: string }) => error.code === 'BACKUP_PATH_INVALID');
    assert.equal(existsSync(target), false);
    assert.equal(existsSync(join(fx.root, 'outside.txt')), false);
  } finally {
    fx.cleanup();
  }
});

test('restore rejects legacy workspace references without an isolated mapping', async () => {
  const fx = createFixture();
  try {
    const backup = await fx.service.createBackup();
    const tampered = await cloneBackup(backup.backupDirectory, fx.root);
    const manifestPath = join(tampered, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      files: Array<{ scope: string; targetPath: string; payloadPath: string; sizeBytes: number; sha256: string }>;
    };
    const metadata = manifest.files.find(item => item.scope === 'data-root' && item.targetPath === 'workspace/workspaces.json')!;
    const payloadPath = join(tampered, ...metadata.payloadPath.split('/'));
    const workspaceConfig = JSON.parse(readFileSync(payloadPath, 'utf8')) as { workspaces: unknown[] };
    workspaceConfig.workspaces.push({ id: 'unmapped-workspace', rootPath: fx.workspaceRoot });
    const payload = Buffer.from(JSON.stringify(workspaceConfig));
    writeFileSync(payloadPath, payload);
    metadata.sizeBytes = payload.byteLength;
    metadata.sha256 = createHash('sha256').update(payload).digest('hex');
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const target = join(fx.root, 'unmapped-restore-target');
    await assert.rejects(MaintenanceService.restoreBackup(tampered, target),
      (error: { code?: string }) => error.code === 'RESTORE_WORKSPACE_MAPPING_FAILED');
    assert.equal(existsSync(target), false);
    assert.equal(existsSync(fx.workspaceRoot), true);
  } finally {
    fx.cleanup();
  }
});

test('restore rejects a SQLite-corrupt bundle even when its file hash is recomputed', async () => {
  const fx = createFixture();
  try {
    const backup = await fx.service.createBackup();
    const tampered = await cloneBackup(backup.backupDirectory, fx.root);
    const manifestPath = join(tampered, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      files: Array<{ scope: string; payloadPath: string; sizeBytes: number; sha256: string }>;
    };
    const database = manifest.files.find(item => item.scope === 'database')!;
    const databasePath = join(tampered, ...database.payloadPath.split('/'));
    const corruptBytes = Buffer.alloc(4096, 0x41);
    writeFileSync(databasePath, corruptBytes);
    database.sizeBytes = corruptBytes.byteLength;
    database.sha256 = createHash('sha256').update(corruptBytes).digest('hex');
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const target = join(fx.root, 'corrupt-target');
    await assert.rejects(MaintenanceService.restoreBackup(tampered, target), (error: { code?: string }) => error.code === 'BACKUP_DATABASE_INVALID');
    assert.equal(existsSync(target), false);
    assert.equal(readFileSync(join(fx.dataRoot, '.agentos', 'provider-private.json'), 'utf8').includes('preserve-in-backup'), true);
  } finally {
    fx.cleanup();
  }
});

test('cleanup CAS removes only listed derived cache and rotated log files while preserving runtime, task and evidence files', async () => {
  const fx = createFixture();
  try {
    const agentos = join(fx.dataRoot, '.agentos');
    const cacheFile = join(agentos, 'cache', 'derived.json');
    const cachesFile = join(agentos, 'caches', 'stale.bin');
    const rotatedLog = join(agentos, 'logs', 'diagnostics', 'server-test.log.1');
    const activeLog = join(agentos, 'logs', 'diagnostics', 'server-test.log');
    const tempFile = join(agentos, 'tmp', 'keep-for-recovery.tmp');
    const evidence = join(agentos, 'evidence', 'review_fixture.json');
    for (const path of [cacheFile, cachesFile, rotatedLog, activeLog, tempFile]) {
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, `fixture:${path}`);
    }
    const service = new MaintenanceService(fx.dataRoot, fx.store.getDatabase() as any, [{ id: fx.workspace.id, rootPath: fx.workspace.rootPath }]);
    const preview = await service.previewCleanup('test');
    assert.equal(preview.deletionsAvailable, true);
    assert.deepEqual(preview.candidates.map(candidate => candidate.path), [
      '.agentos/cache/derived.json',
      '.agentos/caches/stale.bin',
      '.agentos/logs/diagnostics/server-test.log.1',
    ]);
    const result = await service.applyCleanup(preview, 'test');
    assert.equal(result.deletedCount, 3);
    assert.equal(existsSync(cacheFile), false);
    assert.equal(existsSync(cachesFile), false);
    assert.equal(existsSync(rotatedLog), false);
    assert.equal(existsSync(activeLog), true);
    assert.equal(existsSync(tempFile), true);
    assert.equal(existsSync(evidence), true);
    assert.equal(existsSync(join(fx.workspaceRoot, 'agent-memory', 'records', 'knowledge', 'memory_fixture.md')), true);
    await assert.rejects(service.applyCleanup(preview, 'test'), (error: { code?: string }) => error.code === 'CLEANUP_PREVIEW_STALE');
  } finally {
    fx.cleanup();
  }
});

test('cleanup CAS rejects stale hashes and refuses candidate or evidence paths', async () => {
  const fx = createFixture();
  try {
    const cacheFile = join(fx.dataRoot, '.agentos', 'cache', 'changed.json');
    mkdirSync(join(cacheFile, '..'), { recursive: true });
    writeFileSync(cacheFile, 'preview bytes');
    const service = new MaintenanceService(fx.dataRoot, fx.store.getDatabase() as any, [{ id: fx.workspace.id, rootPath: fx.workspace.rootPath }]);
    const preview = await service.previewCleanup();
    writeFileSync(cacheFile, 'changed after preview');
    await assert.rejects(service.applyCleanup(preview), (error: { code?: string }) => error.code === 'CLEANUP_PREVIEW_STALE');
    assert.equal(existsSync(cacheFile), true);
    const forged = { ...preview, candidates: [{ ...preview.candidates[0]!, path: '.agentos/evidence/review_fixture.json' }] };
    await assert.rejects(service.applyCleanup(forged), (error: { code?: string }) => error.code === 'CLEANUP_PREVIEW_STALE');
    assert.equal(existsSync(join(fx.dataRoot, '.agentos', 'evidence', 'review_fixture.json')), true);
  } finally {
    fx.cleanup();
  }
});

test('storage diagnostics summarize capacity and backups without reading secrets and omit lease temp files', async () => {
  const fx = createFixture();
  try {
    const agentosRoot = join(fx.dataRoot, '.agentos');
    mkdirSync(agentosRoot, { recursive: true });
    writeFileSync(join(agentosRoot, 'maintenance-state.json.123.tmp'), 'temporary lease contents');
    writeFileSync(join(agentosRoot, 'provider-private.json'), '{"token":"do-not-print"}');
    const backup = await fx.service.createBackup();
    assert.equal(backup.manifest.files.some(file => file.targetPath.includes('maintenance-state.json.123.tmp')), false);

    const report = await fx.service.inspectStorage();
    assert.equal(report.dataRoot, fx.dataRoot);
    assert.equal(report.database.present, true);
    assert.ok(report.database.sizeBytes > 0);
    assert.equal(report.backups.count, 1);
    assert.ok(report.backups.sizeBytes > 0);
    assert.ok(report.managedData.fileCount > 0);
    assert.equal(JSON.stringify(report).includes('do-not-print'), false);
  } finally {
    fx.cleanup();
  }
});
