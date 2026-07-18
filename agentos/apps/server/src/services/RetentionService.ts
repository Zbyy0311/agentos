import { SqliteStore } from '../store/SqliteStore.js';

export interface RetentionPolicy {
  reviewedMemoryCandidateDays: number;
  reviewedMemoryCandidateMinimum: number;
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  reviewedMemoryCandidateDays: 90,
  reviewedMemoryCandidateMinimum: 200,
};

export interface RetentionResult {
  reviewedMemoryCandidatesDeleted: number;
}

export class RetentionService {
  constructor(
    private readonly store: SqliteStore,
    private readonly policy: RetentionPolicy = DEFAULT_RETENTION_POLICY,
    private readonly onError: (error: unknown) => void = () => {},
  ) {}

  run(now = new Date()): RetentionResult {
    const cutoff = new Date(now.getTime() - this.policy.reviewedMemoryCandidateDays * 24 * 60 * 60 * 1000).toISOString();
    return {
      reviewedMemoryCandidatesDeleted: this.store.pruneReviewedMemoryCandidates(cutoff, this.policy.reviewedMemoryCandidateMinimum),
    };
  }

  start(intervalMs = 24 * 60 * 60 * 1000): () => void {
    const timer = setInterval(() => {
      try {
        this.run();
      } catch (error) {
        this.onError(error);
      }
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }
}
