import { createEntityId } from '../../store/Identity.js';
import {
  PolicyRepository,
  type PolicyActionValue,
  type PolicyDecisionValue,
  type PolicyProfileRecord,
  type PolicyRuleRecord,
  type PolicyRuleSelector,
  type EnsureDefaultPolicyProfileInput,
} from '../../store/PolicyRepository.js';

export const DEFAULT_POLICY_PROFILE_NAME = 'default';

export interface PolicyEvaluationInput {
  readonly workspaceId: string;
  readonly action: PolicyActionValue;
  readonly agentPermissions: string[];
  readonly providerType?: string;
  readonly runId?: string;
  readonly stageId?: string;
  readonly fingerprint?: string;
}

export interface PolicyEvaluation {
  readonly decision: PolicyDecisionValue;
  readonly matchedRuleIds: string[];
  readonly profileId: string;
  readonly evaluatedAt: string;
}

export interface PolicyEngineStore {
  ensureDefaultProfile(input: EnsureDefaultPolicyProfileInput): PolicyProfileRecord;
  findRulesByProfile(profileId: string): PolicyRuleRecord[];
}

const DECISION_RANK: Record<PolicyDecisionValue, number> = {
  deny: 0,
  require_approval: 1,
  allow: 2,
};

function selectorMatches(selector: PolicyRuleSelector, input: PolicyEvaluationInput): boolean {
  if (selector.providerType !== undefined && selector.providerType !== input.providerType) return false;
  if (selector.permission !== undefined && !input.agentPermissions.includes(selector.permission)) return false;
  // agentId / risk selectors are accepted but nothing in the evaluation input
  // carries those dimensions yet, so a rule requiring them never matches.
  if (selector.agentId !== undefined) return false;
  if (selector.risk !== undefined) return false;
  return true;
}

function compareRules(a: PolicyRuleRecord, b: PolicyRuleRecord): number {
  return DECISION_RANK[a.decision] - DECISION_RANK[b.decision]
    || b.specificity - a.specificity
    || b.priority - a.priority
    || a.id.localeCompare(b.id);
}

/**
 * Pure policy decision engine (Runtime Specification 08 §11-18, §27 skeleton).
 * Evaluation loads the workspace default profile, lazily seeding it on first
 * use, matches enabled rules, and applies precedence deny >
 * require_approval > allow with specificity then priority tie-breaks.
 *
 * The engine never persists decisions; callers own audit persistence via
 * PolicyRepository.insertDecision. Engine errors propagate to the caller by
 * design: enforcement points must fail closed (treat an evaluation failure as
 * deny / require_approval), never as allow.
 *
 * The default profile is seeded lazily here rather than in migration 055 so
 * the migration does not have to enumerate existing workspaces; the
 * UNIQUE(workspace_id, name) constraint makes concurrent seeding idempotent.
 */
export class PolicyEngine {
  private readonly now: () => string;

  constructor(
    private readonly store: PolicyEngineStore,
    options: { now?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  evaluate(input: PolicyEvaluationInput): PolicyEvaluation {
    const evaluatedAt = this.now();
    const profile = this.ensureDefaultProfile(input.workspaceId, evaluatedAt);
    const matched = this.store.findRulesByProfile(profile.id)
      .filter(rule => rule.action === input.action && selectorMatches(rule.selector, input))
      .sort(compareRules);
    const decision: PolicyDecisionValue = matched.length === 0 ? 'allow' : matched[0]!.decision;
    return {
      decision,
      matchedRuleIds: matched.map(rule => rule.id),
      profileId: profile.id,
      evaluatedAt,
    };
  }

  /**
   * Default-profile seeding, equivalent to the pre-policy heuristic in
   * RuntimeApprovalGate (write permission → approval, otherwise allow):
   * a require_approval rule on selector { permission: 'write' } plus an
   * allow fallback with an empty selector.
   */
  private ensureDefaultProfile(workspaceId: string, now: string): PolicyProfileRecord {
    return this.store.ensureDefaultProfile({
      profile: {
        id: createEntityId('policyProfile'), workspaceId, name: DEFAULT_POLICY_PROFILE_NAME,
        isDefault: true, createdAt: now, updatedAt: now,
      },
      rules: [
        {
          id: createEntityId('policyRule'), action: 'provider.launch',
          selector: { permission: 'write' }, decision: 'require_approval',
          priority: 100, specificity: 1, createdAt: now,
        },
        {
          id: createEntityId('policyRule'), action: 'provider.launch',
          selector: {}, decision: 'allow', priority: 0, specificity: 0, createdAt: now,
        },
      ],
    });
  }
}
