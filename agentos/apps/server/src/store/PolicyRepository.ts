import { inTransaction, isTransactionActive, type TransactionDatabase } from './Transaction.js';

/**
 * Persistence for the Policy Runtime core (migration 055; Runtime
 * Specification 10 §51-53 skeleton). Profiles are per-workspace named rule
 * sets, rules are ordered selector → decision rows, and decisions are the
 * immutable audit trail produced by the PolicyEngine.
 */
export class PolicyRepositoryError extends Error {
  constructor(readonly code: 'INPUT_INVALID' | 'PERSISTENCE_FAILED' | 'READ_FAILED' | 'NOT_FOUND', message: string) {
    super(code === 'READ_FAILED' || code === 'PERSISTENCE_FAILED' ? code : code + ': ' + message);
    this.name = 'PolicyRepositoryError';
  }
}

export class PolicyProfileIncompleteError extends Error {
  readonly code = 'POLICY_PROFILE_INCOMPLETE';

  constructor() {
    super('POLICY_PROFILE_INCOMPLETE');
    this.name = 'POLICY_PROFILE_INCOMPLETE';
  }
}

export type PolicyDecisionValue = 'allow' | 'deny' | 'require_approval';
export type PolicyActionValue = 'provider.launch';

export interface PolicyRuleSelector {
  /** Reserved: no evaluation input carries an agent id yet. */
  readonly agentId?: string;
  readonly providerType?: string;
  /** Matches when the evaluating agent's permissions include this value. */
  readonly permission?: string;
  /** Reserved: no evaluation input carries a risk level yet. */
  readonly risk?: string;
}

export interface PolicyProfileRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly rulesVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PolicyRuleRecord {
  readonly id: string;
  readonly profileId: string;
  readonly action: PolicyActionValue;
  readonly selector: PolicyRuleSelector;
  readonly decision: PolicyDecisionValue;
  readonly priority: number;
  readonly specificity: number;
  readonly enabled: boolean;
  readonly createdAt: string;
}

export interface PolicyDecisionRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly stageId: string | null;
  readonly action: PolicyActionValue;
  readonly fingerprint: string | null;
  readonly decision: PolicyDecisionValue;
  readonly matchedRuleIds: string[];
  readonly profileId: string | null;
  readonly evaluatedAt: string;
}

export interface CreatePolicyProfileInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly isDefault?: boolean;
  readonly rulesVersion?: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreatePolicyRuleInput {
  readonly id: string;
  readonly profileId: string;
  readonly action: PolicyActionValue;
  readonly selector: PolicyRuleSelector;
  readonly decision: PolicyDecisionValue;
  readonly priority: number;
  readonly specificity?: number;
  readonly enabled?: boolean;
  readonly createdAt: string;
}

export interface EnsureDefaultPolicyProfileInput {
  readonly profile: CreatePolicyProfileInput;
  readonly rules: readonly Omit<CreatePolicyRuleInput, 'profileId'>[];
}

export interface InsertPolicyDecisionInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly runId?: string;
  readonly stageId?: string;
  readonly action: PolicyActionValue;
  readonly fingerprint?: string;
  readonly decision: PolicyDecisionValue;
  readonly matchedRuleIds: string[];
  readonly profileId?: string;
  readonly evaluatedAt: string;
}

export interface ListPolicyDecisionsQuery {
  readonly runId?: string;
  readonly limit?: number;
  readonly offset?: number;
  /** evaluated_at ordering; newest-first read APIs pass 'desc'. Default 'asc'. */
  readonly order?: 'asc' | 'desc';
}

const ACTIONS = new Set<string>(['provider.launch']);
const DECISIONS = new Set<string>(['allow', 'deny', 'require_approval']);

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseSelector(json: string): PolicyRuleSelector {
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function toProfileRecord(row: Record<string, unknown>): PolicyProfileRecord {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    name: row.name as string,
    isDefault: row.is_default === 1,
    rulesVersion: Number(row.rules_version),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function toRuleRecord(row: Record<string, unknown>): PolicyRuleRecord {
  return {
    id: row.id as string,
    profileId: row.profile_id as string,
    action: row.action as PolicyActionValue,
    selector: parseSelector(row.selector_json as string),
    decision: row.decision as PolicyDecisionValue,
    priority: Number(row.priority),
    specificity: Number(row.specificity),
    enabled: row.enabled === 1,
    createdAt: row.created_at as string,
  };
}

function toDecisionRecord(row: Record<string, unknown>): PolicyDecisionRecord {
  let matchedRuleIds: string[] = [];
  try {
    const parsed = JSON.parse(row.matched_rule_ids_json as string);
    if (Array.isArray(parsed)) matchedRuleIds = parsed.filter((id): id is string => typeof id === 'string');
  } catch {
    matchedRuleIds = [];
  }
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    runId: (row.run_id as string | null) ?? null,
    stageId: (row.stage_id as string | null) ?? null,
    action: row.action as PolicyActionValue,
    fingerprint: (row.fingerprint as string | null) ?? null,
    decision: row.decision as PolicyDecisionValue,
    matchedRuleIds,
    profileId: (row.profile_id as string | null) ?? null,
    evaluatedAt: row.evaluated_at as string,
  };
}

function selectorsEqual(left: PolicyRuleSelector, right: PolicyRuleSelector): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index]
      && (left as Record<string, unknown>)[key] === (right as Record<string, unknown>)[key]);
}

function isOriginalDefaultRule(
  rule: PolicyRuleRecord,
  definition: Omit<CreatePolicyRuleInput, 'profileId'>,
  originalCreatedAt: string,
): boolean {
  return rule.action === definition.action
    && selectorsEqual(rule.selector, definition.selector)
    && rule.decision === definition.decision
    && rule.priority === definition.priority
    && rule.specificity === (definition.specificity ?? 0)
    && rule.enabled === (definition.enabled !== false)
    && rule.createdAt === originalCreatedAt;
}

export class PolicyRepository {
  constructor(private readonly db: TransactionDatabase) {}

  /**
   * Create the workspace default profile and its seed rules atomically. A
   * narrowly recognizable partial seed from the original non-atomic path is
   * repaired in the same transaction; customized and disabled rules are
   * retained as-is.
   */
  ensureDefaultProfile(input: EnsureDefaultPolicyProfileInput): PolicyProfileRecord {
    return this.atomically(() => {
      const existing = this.findDefaultProfile(input.profile.workspaceId);
      if (existing === undefined) {
        const profile = this.createProfile(input.profile);
        for (const rule of input.rules) {
          this.createRule({ ...rule, profileId: profile.id });
        }
        return profile;
      }

      const physicalRules = this.findAllRulesByProfile(existing.id);
      if (physicalRules.length === 0) throw new PolicyProfileIncompleteError();

      const repairableProfile = existing.name === input.profile.name
        && existing.isDefault
        && existing.rulesVersion === 1
        && existing.createdAt === existing.updatedAt;
      if (!repairableProfile || physicalRules.length >= input.rules.length) return existing;

      const missingRules = [...input.rules];
      for (const rule of physicalRules) {
        const matchingIndex = missingRules.findIndex(definition =>
          isOriginalDefaultRule(rule, definition, existing.createdAt));
        if (matchingIndex < 0) return existing;
        missingRules.splice(matchingIndex, 1);
      }
      if (missingRules.length === 0) return existing;

      for (const rule of missingRules) {
        this.createRule({ ...rule, profileId: existing.id, createdAt: existing.createdAt });
      }
      return this.touchProfile(input.profile.workspaceId, existing.id, input.profile.updatedAt);
    });
  }

  createProfile(input: CreatePolicyProfileInput): PolicyProfileRecord {
    if (!nonBlank(input.id) || !nonBlank(input.workspaceId) || !nonBlank(input.name)
      || !nonBlank(input.createdAt) || !nonBlank(input.updatedAt)) {
      throw new PolicyRepositoryError('INPUT_INVALID', 'a required profile field is missing or blank');
    }
    const rulesVersion = input.rulesVersion ?? 1;
    if (!Number.isSafeInteger(rulesVersion) || rulesVersion < 1) {
      throw new PolicyRepositoryError('INPUT_INVALID', 'rulesVersion must be an integer >= 1');
    }
    try {
      this.db.prepare(
        'INSERT INTO policy_profiles (id, workspace_id, name, is_default, rules_version, created_at, updated_at)'
          + ' VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(input.id, input.workspaceId, input.name, input.isDefault === true ? 1 : 0,
        rulesVersion, input.createdAt, input.updatedAt);
    } catch (error) {
      throw new PolicyRepositoryError('PERSISTENCE_FAILED', error instanceof Error ? error.message : 'policy profile could not be persisted');
    }
    const record = this.findProfileById(input.workspaceId, input.id);
    if (record === undefined) {
      throw new PolicyRepositoryError('PERSISTENCE_FAILED', 'profile row not readable after write: ' + input.id);
    }
    return record;
  }

  findProfileById(workspaceId: string, id: string): PolicyProfileRecord | undefined {
    if (!nonBlank(workspaceId) || !nonBlank(id)) return undefined;
    try {
      const row = this.db.prepare(
        'SELECT * FROM policy_profiles WHERE workspace_id = ? AND id = ?',
      ).get(workspaceId, id) as Record<string, unknown> | undefined;
      return row === undefined ? undefined : toProfileRecord(row);
    } catch (error) {
      throw new PolicyRepositoryError('READ_FAILED', error instanceof Error ? error.message : 'read failed');
    }
  }

  findDefaultProfile(workspaceId: string): PolicyProfileRecord | undefined {
    if (!nonBlank(workspaceId)) return undefined;
    try {
      const row = this.db.prepare(
        'SELECT * FROM policy_profiles WHERE workspace_id = ? AND is_default = 1 ORDER BY created_at ASC, id ASC LIMIT 1',
      ).get(workspaceId) as Record<string, unknown> | undefined;
      return row === undefined ? undefined : toProfileRecord(row);
    } catch (error) {
      throw new PolicyRepositoryError('READ_FAILED', error instanceof Error ? error.message : 'read failed');
    }
  }

  listProfiles(workspaceId: string): PolicyProfileRecord[] {
    if (!nonBlank(workspaceId)) return [];
    try {
      const rows = this.db.prepare(
        'SELECT * FROM policy_profiles WHERE workspace_id = ? ORDER BY created_at ASC, id ASC',
      ).all(workspaceId) as Array<Record<string, unknown>>;
      return rows.map(toProfileRecord);
    } catch (error) {
      throw new PolicyRepositoryError('READ_FAILED', error instanceof Error ? error.message : 'read failed');
    }
  }

  /** Bump rules_version to mark the compiled rule set as changed. */
  touchProfile(workspaceId: string, id: string, updatedAt: string): PolicyProfileRecord {
    if (!nonBlank(workspaceId) || !nonBlank(id) || !nonBlank(updatedAt)) {
      throw new PolicyRepositoryError('INPUT_INVALID', 'a required field is missing or blank');
    }
    try {
      this.db.prepare(
        'UPDATE policy_profiles SET rules_version = rules_version + 1, updated_at = ? WHERE workspace_id = ? AND id = ?',
      ).run(updatedAt, workspaceId, id);
    } catch (error) {
      throw new PolicyRepositoryError('PERSISTENCE_FAILED', error instanceof Error ? error.message : 'policy profile could not be updated');
    }
    const record = this.findProfileById(workspaceId, id);
    if (record === undefined) throw new PolicyRepositoryError('NOT_FOUND', 'policy profile not found: ' + id);
    return record;
  }

  createRule(input: CreatePolicyRuleInput): PolicyRuleRecord {
    if (!nonBlank(input.id) || !nonBlank(input.profileId) || !nonBlank(input.createdAt)) {
      throw new PolicyRepositoryError('INPUT_INVALID', 'a required rule field is missing or blank');
    }
    if (!ACTIONS.has(input.action)) {
      throw new PolicyRepositoryError('INPUT_INVALID', 'unknown action: ' + String(input.action));
    }
    if (!DECISIONS.has(input.decision)) {
      throw new PolicyRepositoryError('INPUT_INVALID', 'unknown decision: ' + String(input.decision));
    }
    if (!Number.isSafeInteger(input.priority)) {
      throw new PolicyRepositoryError('INPUT_INVALID', 'priority must be a safe integer');
    }
    const specificity = input.specificity ?? 0;
    if (!Number.isSafeInteger(specificity)) {
      throw new PolicyRepositoryError('INPUT_INVALID', 'specificity must be a safe integer');
    }
    try {
      this.db.prepare(
        'INSERT INTO policy_rules (id, profile_id, action, selector_json, decision, priority, specificity, enabled, created_at)'
          + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(input.id, input.profileId, input.action, JSON.stringify(input.selector ?? {}),
        input.decision, input.priority, specificity, input.enabled === false ? 0 : 1, input.createdAt);
    } catch (error) {
      throw new PolicyRepositoryError('PERSISTENCE_FAILED', error instanceof Error ? error.message : 'policy rule could not be persisted');
    }
    const record = this.findRuleById(input.id);
    if (record === undefined) {
      throw new PolicyRepositoryError('PERSISTENCE_FAILED', 'rule row not readable after write: ' + input.id);
    }
    return record;
  }

  findRuleById(id: string): PolicyRuleRecord | undefined {
    if (!nonBlank(id)) return undefined;
    try {
      const row = this.db.prepare('SELECT * FROM policy_rules WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      return row === undefined ? undefined : toRuleRecord(row);
    } catch (error) {
      throw new PolicyRepositoryError('READ_FAILED', error instanceof Error ? error.message : 'read failed');
    }
  }

  /** Enabled rules of a profile, most specific / highest priority first. */
  findRulesByProfile(profileId: string): PolicyRuleRecord[] {
    if (!nonBlank(profileId)) return [];
    try {
      const rows = this.db.prepare(
        'SELECT * FROM policy_rules WHERE profile_id = ? AND enabled = 1 ORDER BY specificity DESC, priority DESC, id ASC',
      ).all(profileId) as Array<Record<string, unknown>>;
      return rows.map(toRuleRecord);
    } catch (error) {
      throw new PolicyRepositoryError('READ_FAILED', error instanceof Error ? error.message : 'read failed');
    }
  }

  /** All physical rules for a profile, including disabled rules. */
  findAllRulesByProfile(profileId: string): PolicyRuleRecord[] {
    if (!nonBlank(profileId)) return [];
    try {
      const rows = this.db.prepare(
        'SELECT * FROM policy_rules WHERE profile_id = ? ORDER BY specificity DESC, priority DESC, id ASC',
      ).all(profileId) as Array<Record<string, unknown>>;
      return rows.map(toRuleRecord);
    } catch (error) {
      throw new PolicyRepositoryError('READ_FAILED', error instanceof Error ? error.message : 'read failed');
    }
  }

  setRuleEnabled(id: string, enabled: boolean): PolicyRuleRecord {
    if (!nonBlank(id)) throw new PolicyRepositoryError('INPUT_INVALID', 'rule id is missing or blank');
    try {
      this.db.prepare('UPDATE policy_rules SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    } catch (error) {
      throw new PolicyRepositoryError('PERSISTENCE_FAILED', error instanceof Error ? error.message : 'policy rule could not be updated');
    }
    const record = this.findRuleById(id);
    if (record === undefined) throw new PolicyRepositoryError('NOT_FOUND', 'policy rule not found: ' + id);
    return record;
  }

  insertDecision(input: InsertPolicyDecisionInput): PolicyDecisionRecord {
    if (!nonBlank(input.id) || !nonBlank(input.workspaceId) || !nonBlank(input.action)
      || !nonBlank(input.evaluatedAt)) {
      throw new PolicyRepositoryError('INPUT_INVALID', 'a required decision field is missing or blank');
    }
    if (!ACTIONS.has(input.action)) {
      throw new PolicyRepositoryError('INPUT_INVALID', 'unknown action: ' + String(input.action));
    }
    if (!DECISIONS.has(input.decision)) {
      throw new PolicyRepositoryError('INPUT_INVALID', 'unknown decision: ' + String(input.decision));
    }
    try {
      this.db.prepare(
        'INSERT INTO policy_decisions (id, workspace_id, run_id, stage_id, action, fingerprint, decision, matched_rule_ids_json, profile_id, evaluated_at)'
          + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(input.id, input.workspaceId, input.runId ?? null, input.stageId ?? null,
        input.action, input.fingerprint ?? null, input.decision,
        JSON.stringify(input.matchedRuleIds), input.profileId ?? null, input.evaluatedAt);
    } catch (error) {
      throw new PolicyRepositoryError('PERSISTENCE_FAILED', error instanceof Error ? error.message : 'policy decision could not be persisted');
    }
    const record = this.findDecisionById(input.workspaceId, input.id);
    if (record === undefined) {
      throw new PolicyRepositoryError('PERSISTENCE_FAILED', 'decision row not readable after write: ' + input.id);
    }
    return record;
  }

  private atomically<T>(fn: () => T): T {
    return isTransactionActive(this.db) ? fn() : inTransaction(this.db, fn);
  }

  findDecisionById(workspaceId: string, id: string): PolicyDecisionRecord | undefined {
    if (!nonBlank(workspaceId) || !nonBlank(id)) return undefined;
    try {
      const row = this.db.prepare(
        'SELECT * FROM policy_decisions WHERE workspace_id = ? AND id = ?',
      ).get(workspaceId, id) as Record<string, unknown> | undefined;
      return row === undefined ? undefined : toDecisionRecord(row);
    } catch (error) {
      throw new PolicyRepositoryError('READ_FAILED', error instanceof Error ? error.message : 'read failed');
    }
  }

  listDecisions(workspaceId: string, query: ListPolicyDecisionsQuery = {}): PolicyDecisionRecord[] {
    if (!nonBlank(workspaceId)) return [];
    try {
      const clauses = ['workspace_id = ?'];
      const params: unknown[] = [workspaceId];
      if (query.runId !== undefined) {
        clauses.push('run_id = ?');
        params.push(query.runId);
      }
      let sql = `SELECT * FROM policy_decisions WHERE ${clauses.join(' AND ')} ORDER BY evaluated_at ${query.order === 'desc' ? 'DESC' : 'ASC'}, id ${query.order === 'desc' ? 'DESC' : 'ASC'}`;
      if (query.limit !== undefined) {
        if (!Number.isSafeInteger(query.limit) || query.limit < 1) {
          throw new PolicyRepositoryError('INPUT_INVALID', 'limit must be an integer >= 1');
        }
        sql += ' LIMIT ?';
        params.push(query.limit);
        if (query.offset !== undefined) {
          if (!Number.isSafeInteger(query.offset) || query.offset < 0) {
            throw new PolicyRepositoryError('INPUT_INVALID', 'offset must be an integer >= 0');
          }
          sql += ' OFFSET ?';
          params.push(query.offset);
        }
      }
      const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
      return rows.map(toDecisionRecord);
    } catch (error) {
      if (error instanceof PolicyRepositoryError) throw error;
      throw new PolicyRepositoryError('READ_FAILED', error instanceof Error ? error.message : 'read failed');
    }
  }
}
