import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { RuntimeApprovalCard } from './RuntimeApprovalPanel.js';
import type { PolicyDecision } from '@/lib/policyDecisions.js';

const REQUEST = {
  id: 'approval-1',
  workspaceId: 'workspace-1',
  runId: 'run-1',
  stageId: null,
  status: 'pending' as const,
  version: 4,
  title: '需要确认写入操作',
  description: '该动作将修改工作区文件。',
  actionFingerprint: 'sha256:action-1',
  snapshotHash: 'sha256:snapshot-1',
  policyVersion: 'lite-v1',
  resolution: null,
  expiresAt: '2030-01-02T03:04:05.000Z',
  decidedBy: null,
};

test('S3 approval card exposes the persisted action evidence and both decisions', () => {
  const markup = renderToStaticMarkup(<RuntimeApprovalCard request={REQUEST} busy={false} onDecision={() => {}} />);

  assert.ok(markup.includes('需要确认写入操作'));
  assert.ok(markup.includes('sha256:action-1'));
  assert.ok(markup.includes('lite-v1'));
  assert.ok(markup.includes('批准本次执行'));
  assert.ok(markup.includes('拒绝执行'));
  assert.equal((markup.match(/disabled=""/g) ?? []).length, 0);
});

test('S3 approval card disables both decisions while a persisted decision is in flight', () => {
  const markup = renderToStaticMarkup(<RuntimeApprovalCard request={REQUEST} busy onDecision={() => {}} />);

  assert.equal((markup.match(/disabled=""/g) ?? []).length, 2);
});

const POLICY_DECISION: PolicyDecision = {
  id: 'decision-1',
  workspaceId: 'workspace-1',
  runId: 'run-1',
  stageId: null,
  action: 'provider.launch',
  fingerprint: null,
  decision: 'require_approval',
  matchedRuleIds: ['policyRule-aaa', 'policyRule-bbb'],
  profileId: 'policyProfile-1234567890',
  evaluatedAt: '2026-09-12T10:30:00.000Z',
};

test('S3 approval card renders the read-only policy decision provenance row', () => {
  const markup = renderToStaticMarkup(
    <RuntimeApprovalCard request={REQUEST} busy={false} policyDecision={POLICY_DECISION} onDecision={() => {}} />,
  );

  assert.ok(markup.includes('决策来源'));
  assert.ok(markup.includes('require_approval'));
  assert.ok(markup.includes('命中'));
  assert.ok(markup.includes('条规则'));
  assert.ok(markup.includes('profile '));
  assert.ok(markup.includes('policyProfil'));
  assert.ok(markup.includes('policy-decision-source'));
});

test('S3 approval card silently degrades when no policy decision is available', () => {
  const markup = renderToStaticMarkup(
    <RuntimeApprovalCard request={REQUEST} busy={false} onDecision={() => {}} />,
  );

  assert.ok(!markup.includes('决策来源'));
  assert.ok(!markup.includes('policy-decision-source'));
  assert.ok(markup.includes('批准本次执行'), 'approval flow itself is untouched');
});
