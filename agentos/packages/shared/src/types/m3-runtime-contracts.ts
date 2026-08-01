export const V2_RUN_REASONS = Object.freeze([
  'initial',
  'retry',
  'resume-fallback',
  'review-fix',
  'provider-comparison',
  'manual',
] as const);

export type V2RunReason = (typeof V2_RUN_REASONS)[number];

export const WORKTREE_MODES = Object.freeze([
  'required',
  'preferred',
  'disabled',
] as const);

export type WorktreeMode = (typeof WORKTREE_MODES)[number];
