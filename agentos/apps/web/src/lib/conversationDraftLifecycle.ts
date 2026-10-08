import {
  createConversationDraftIdentityKey,
  type ConversationDraftIdentity,
  type SubmittedConversationDraft,
} from './conversationDraftState';

export interface DirectSubmissionLifecycle {
  readonly sourceIdentity: ConversationDraftIdentity;
  readonly submitted: SubmittedConversationDraft;
  readonly createdConversationIdentity?: ConversationDraftIdentity;
  readonly migrateTo: (
    target: ConversationDraftIdentity,
    source: ConversationDraftIdentity,
  ) => Promise<string | undefined>;
  readonly settleSubmission: (
    identity: ConversationDraftIdentity,
    submitted: SubmittedConversationDraft,
    outcome: 'committed' | 'ambiguous',
  ) => Promise<{ readonly warning?: string }>;
  readonly isCurrentScope: () => boolean;
  readonly onCurrentScopeSettled: () => void;
}

/** Settle the send owner regardless of the visible selection; gate UI selection separately. */
export async function completeDirectConversationSubmission(
  input: DirectSubmissionLifecycle,
): Promise<{ readonly warning?: string; readonly settledIdentityKey: string; readonly currentScope: boolean }> {
  const destination = input.createdConversationIdentity;
  const migratedKey = destination
    ? await input.migrateTo(destination, input.sourceIdentity)
    : undefined;
  const settledIdentity = destination && migratedKey ? destination : input.sourceIdentity;
  const settledIdentityKey = createConversationDraftIdentityKey(settledIdentity);
  const submitted = input.submitted.identityKey === settledIdentityKey
    ? input.submitted
    : { ...input.submitted, identityKey: settledIdentityKey };
  const result = await input.settleSubmission(settledIdentity, submitted, 'committed');
  const currentScope = input.isCurrentScope();
  if (currentScope) input.onCurrentScopeSettled();
  return { ...result, settledIdentityKey, currentScope };
}
