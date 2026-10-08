import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { RuntimeApprovalCard } from './RuntimeApprovalPanel.js';

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
