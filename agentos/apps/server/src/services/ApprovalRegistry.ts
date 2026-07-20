import { randomUUID } from 'node:crypto';
import type { ApprovalDecision, ApprovalGrant, ToolApprovalRequest } from '@agentos/shared';

export class ApprovalRegistry {
  private readonly requests = new Map<string, ToolApprovalRequest>();
  private readonly decisions = new Map<string, ApprovalDecision>();
  private readonly grants = new Map<string, ApprovalGrant>();

  createRequest(input: Omit<ToolApprovalRequest, 'id' | 'createdAt'> & { id?: string; createdAt?: string }): ToolApprovalRequest {
    const request = { ...input, id: input.id ?? randomUUID(), createdAt: input.createdAt ?? new Date().toISOString() };
    this.requests.set(request.id, request);
    return request;
  }

  getRequest(id: string): ToolApprovalRequest | undefined { return this.requests.get(id); }
  getDecision(id: string): ApprovalDecision | undefined { return this.decisions.get(id); }

  resolveRequest(id: string, decision: ApprovalDecision): ToolApprovalRequest {
    if (!this.requests.has(id)) throw new Error('Approval request not found');
    const previous = this.decisions.get(id);
    if (previous && previous !== decision) throw new Error('Approval request already resolved');
    this.decisions.set(id, decision);
    return this.requests.get(id)!;
  }

  createGrant(input: Omit<ApprovalGrant, 'id' | 'createdAt'> & { id?: string; createdAt?: string }): ApprovalGrant {
    const grant = { ...input, id: input.id ?? randomUUID(), createdAt: input.createdAt ?? new Date().toISOString() };
    this.grants.set(grant.id, grant);
    return grant;
  }

  getGrant(id: string): ApprovalGrant | undefined { return this.grants.get(id); }
  listGrants(workspaceId: string): ApprovalGrant[] { return [...this.grants.values()].filter(grant => grant.workspaceId === workspaceId); }
  revokeGrant(id: string): ApprovalGrant {
    const grant = this.grants.get(id);
    if (!grant) throw new Error('Approval grant not found');
    if (grant.revokedAt) return grant;
    const next = { ...grant, revokedAt: new Date().toISOString() };
    this.grants.set(id, next);
    return next;
  }
}
