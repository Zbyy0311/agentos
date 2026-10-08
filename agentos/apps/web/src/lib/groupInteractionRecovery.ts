export interface GroupRecoveryContext {
  readonly workspaceId: string;
  readonly interactionId: string;
  readonly interactionVersion: number;
  readonly ownerEpoch: number;
}

function stableIntentHash(value: string): string {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function groupInteractionRecoveryPath(workspaceId: string, interactionId: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/runtime/interactions/${encodeURIComponent(interactionId)}/recover`;
}

export function groupInteractionRecoveryRequest(
  context: GroupRecoveryContext,
  content: string,
): { readonly method: 'POST'; readonly body: { readonly expectedVersion: number; readonly expectedOwnerEpoch: number; readonly content: string }; readonly headers: { readonly 'Idempotency-Key': string } } {
  const intent = [context.workspaceId, context.interactionId, context.interactionVersion, context.ownerEpoch].join(':');
  return {
    method: 'POST',
    body: { expectedVersion: context.interactionVersion, expectedOwnerEpoch: context.ownerEpoch, content },
    headers: { 'Idempotency-Key': `p2-group-recovery-${stableIntentHash(intent)}` },
  };
}
