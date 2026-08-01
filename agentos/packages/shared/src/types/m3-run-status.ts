export const V2_RUN_STATUSES = Object.freeze([
  'queued',
  'starting',
  'running',
  'waiting_approval',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const);

export type V2RunStatus = (typeof V2_RUN_STATUSES)[number];

export const M3_RUN_STATUSES = V2_RUN_STATUSES;

export type M3RunStatus = V2RunStatus;
