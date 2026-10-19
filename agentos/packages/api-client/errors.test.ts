import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentOSError, isAgentOSError, normalizeError } from './src/errors.ts';

test('normalizes application/problem+json into a typed error', async () => {
  const response = new Response(JSON.stringify({
    type: 'urn:agentos:policy:approval-expired',
    title: 'Approval expired',
    status: 409,
    detail: 'approval no longer pending',
  }), { status: 409, headers: { 'Content-Type': 'application/problem+json' } });
  const error = await normalizeError(response);
  assert.ok(error instanceof AgentOSError);
  assert.equal(error.status, 409);
  assert.equal(error.code, 'CONFLICT');
  assert.equal(error.message, 'approval no longer pending');
  assert.equal(error.title, 'Approval expired');
  assert.equal(error.type, 'urn:agentos:policy:approval-expired');
  assert.equal(error.problem?.status, 409);
});

test('normalizes the legacy error envelope and prefers detail', async () => {
  const response = new Response(JSON.stringify({ error: 'old', detail: 'WORKSPACE_NOT_FOUND', code: 'W1' }), { status: 404 });
  const error = await normalizeError(response);
  assert.equal(error.message, 'WORKSPACE_NOT_FOUND');
  assert.equal(error.status, 404);
  assert.equal(error.code, 'NOT_FOUND');
  assert.equal(error.detail, 'WORKSPACE_NOT_FOUND');
});

test('falls back to HTTP status text for non-JSON bodies', async () => {
  const response = new Response('oops', { status: 502, statusText: 'Bad Gateway' });
  const error = await normalizeError(response);
  assert.equal(error.message, 'Bad Gateway');
  assert.equal(error.status, 502);
  assert.equal(error.code, 'UNKNOWN');
});

test('maps known statuses to stable codes and unknown ones to UNKNOWN', async () => {
  assert.equal((await normalizeError(new Response('x', { status: 403 }))).code, 'FORBIDDEN');
  assert.equal((await normalizeError(new Response('x', { status: 412 }))).code, 'PRECONDITION_FAILED');
  assert.equal((await normalizeError(new Response('x', { status: 429 }))).code, 'RATE_LIMITED');
  assert.equal((await normalizeError(new Response('x', { status: 418 }))).code, 'UNKNOWN');
});

test('isAgentOSError narrows unknown thrown values', async () => {
  assert.equal(isAgentOSError(new AgentOSError('x', { status: 500 })), true);
  assert.equal(isAgentOSError(new Error('x')), false);
  assert.equal(isAgentOSError(undefined), false);
});
