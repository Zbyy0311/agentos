import test from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalRegistry } from './ApprovalRegistry.js';

test('ApprovalRegistry resolves a request idempotently and rejects conflicting decisions', () => {
    const registry = new ApprovalRegistry();
    const request = registry.createRequest({ workspaceId: 'w', runId: 'r', executionId: 'e', agentId: 'a', provider: 'codex', sanitizedConfigHash: 'h', toolName: 'shell', actionFingerprint: 'f', riskLevel: 'high', affectedPaths: [] });
    registry.resolveRequest(request.id, 'allow_once');
    registry.resolveRequest(request.id, 'allow_once');
    assert.throws(() => registry.resolveRequest(request.id, 'deny'), /already resolved/);
});

test('ApprovalRegistry revokes grants idempotently', () => {
    const registry = new ApprovalRegistry();
    const grant = registry.createGrant({ workspaceId: 'w', conversationId: 'c', provider: 'codex', sanitizedConfigHash: 'h', toolPattern: 'shell', actionFingerprint: 'f', maximumRisk: 'medium', expiresAt: new Date(Date.now() + 1000).toISOString() });
    const revoked = registry.revokeGrant(grant.id);
    assert.ok(revoked.revokedAt);
    assert.equal(registry.revokeGrant(grant.id).revokedAt, revoked.revokedAt);
});
