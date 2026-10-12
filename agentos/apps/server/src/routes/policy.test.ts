import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { createEntityId } from '../store/Identity.js';
import { PolicyRepository } from '../store/PolicyRepository.js';
import { SqliteStore } from '../store/SqliteStore.js';
import { createPolicyRoutes } from './policy.js';

const NOW = '2026-09-12T10:30:00.000Z';

interface JsonResponse {
  readonly status: number;
  readonly body: Record<string, unknown> & { code?: string };
}

async function withServer(
  run: (fixture: {
    baseUrl: (path: string, workspaceId?: string) => string;
    workspaceId: string;
    policy: PolicyRepository;
  }) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'agentos-policy-route-'));
  const store = new SqliteStore(root);
  const workspaceManager = new WorkspaceManager(store);
  const workspace = await workspaceManager.create('Policy Workspace', join(root, 'workspace-a'), {
    git: false, memory: false, readme: false, docs: false,
  });
  const policy = new PolicyRepository(store.getDatabase());
  const app = express();
  app.use('/api/workspaces/:workspaceId', createPolicyRoutes(store, workspaceManager));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address() as AddressInfo;
  try {
    await run({
      workspaceId: workspace.id,
      policy,
      baseUrl: (path, workspaceId = workspace.id) => `http://127.0.0.1:${address.port}/api/workspaces/${workspaceId}${path}`,
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

async function getJson(url: string): Promise<JsonResponse> {
  const response = await fetch(url);
  const body = await response.json() as JsonResponse['body'];
  return { status: response.status, body };
}

function seedProfile(policy: PolicyRepository, workspaceId: string): { profileId: string; ruleIds: string[] } {
  const profile = policy.createProfile({
    id: createEntityId('policyProfile'), workspaceId, name: 'default',
    isDefault: true, createdAt: NOW, updatedAt: NOW,
  });
  const ruleA = policy.createRule({
    id: createEntityId('policyRule'), profileId: profile.id, action: 'provider.launch',
    selector: { permission: 'write' }, decision: 'require_approval',
    priority: 100, specificity: 1, createdAt: NOW,
  });
  const ruleB = policy.createRule({
    id: createEntityId('policyRule'), profileId: profile.id, action: 'provider.launch',
    selector: {}, decision: 'allow', priority: 0, specificity: 0, createdAt: NOW,
  });
  return { profileId: profile.id, ruleIds: [ruleA.id, ruleB.id] };
}

test('policy profile returns 404 POLICY_PROFILE_NOT_FOUND without seeding', async () => {
  await withServer(async ({ baseUrl, workspaceId, policy }) => {
    const response = await getJson(baseUrl('/policy/profile'));
    assert.equal(response.status, 404);
    assert.equal(response.body.code, 'POLICY_PROFILE_NOT_FOUND');
    assert.equal(policy.findDefaultProfile(workspaceId), undefined, 'read endpoint must not lazily seed');
  });
});

test('policy profile returns the default profile with enabled rules', async () => {
  await withServer(async ({ baseUrl, workspaceId, policy }) => {
    const seeded = seedProfile(policy, workspaceId);
    const response = await getJson(baseUrl('/policy/profile'));
    assert.equal(response.status, 200);
    const profile = response.body.profile as { id: string; isDefault: boolean; name: string };
    assert.equal(profile.id, seeded.profileId);
    assert.equal(profile.isDefault, true);
    const rules = response.body.rules as Array<{ id: string; decision: string; priority: number; specificity: number; selector: Record<string, unknown> }>;
    assert.deepEqual(rules.map(rule => rule.id), seeded.ruleIds);
    assert.equal(rules[0]!.decision, 'require_approval');
    assert.deepEqual(rules[0]!.selector, { permission: 'write' });
    assert.equal(rules[1]!.specificity, 0);
  });
});

test('policy decisions paginate newest-first with runId filter and limit cap', async () => {
  await withServer(async ({ baseUrl, workspaceId, policy }) => {
    const { profileId } = seedProfile(policy, workspaceId);
    const insert = (id: string, runId: string | undefined, evaluatedAt: string) => policy.insertDecision({
      id, workspaceId, runId, action: 'provider.launch', decision: 'require_approval',
      matchedRuleIds: ['rule-1'], profileId, evaluatedAt,
    });
    for (let index = 0; index < 5; index += 1) {
      insert(`decision-all-${index}`, undefined, `2026-09-12T10:30:0${index}.000Z`);
    }
    insert('decision-run-0', 'run-1', '2026-09-12T10:31:00.000Z');
    insert('decision-run-1', 'run-1', '2026-09-12T10:32:00.000Z');

    const page = await getJson(baseUrl('/policy-decisions'));
    assert.equal(page.status, 200);
    assert.equal(page.body.limit, 50);
    const decisions = page.body.decisions as Array<{ id: string }>;
    assert.equal(decisions.length, 7);
    assert.equal(decisions[0]!.id, 'decision-run-1', 'newest first');

    const filtered = await getJson(baseUrl('/policy-decisions?runId=run-1'));
    assert.deepEqual((filtered.body.decisions as Array<{ id: string }>).map(decision => decision.id),
      ['decision-run-1', 'decision-run-0']);

    const capped = await getJson(baseUrl('/policy-decisions?limit=500'));
    assert.equal(capped.status, 200);
    assert.equal(capped.body.limit, 200, 'limit above the cap is truncated');
    assert.equal((capped.body.decisions as unknown[]).length, 7);

    const limited = await getJson(baseUrl('/policy-decisions?limit=2&offset=1'));
    assert.deepEqual((limited.body.decisions as Array<{ id: string }>).map(decision => decision.id),
      ['decision-run-0', 'decision-all-4']);
  });
});

test('policy decisions rejects invalid paging params with POLICY_QUERY_INVALID', async () => {
  await withServer(async ({ baseUrl }) => {
    for (const query of ['limit=0', 'limit=abc', 'offset=-1', 'offset=1.5']) {
      const response = await getJson(baseUrl(`/policy-decisions?${query}`));
      assert.equal(response.status, 400, query);
      assert.equal(response.body.code, 'POLICY_QUERY_INVALID', query);
    }
  });
});

test('policy routes return 404 WORKSPACE_NOT_FOUND for unknown workspaces', async () => {
  await withServer(async ({ baseUrl }) => {
    for (const path of ['/policy/profile', '/policy-decisions']) {
      const response = await getJson(baseUrl(path, 'workspace-missing'));
      assert.equal(response.status, 404, path);
      assert.equal(response.body.code, 'WORKSPACE_NOT_FOUND', path);
    }
  });
});
