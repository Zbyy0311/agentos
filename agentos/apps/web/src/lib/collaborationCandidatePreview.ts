export type CollaborationCandidatePreviewFileStatus = 'added' | 'modified' | 'deleted' | 'renamed';
export const COLLABORATION_CANDIDATE_PREVIEW_PAGE_SIZE = 50;

export interface CollaborationCandidatePreviewFile {
  readonly fileIndex: number;
  readonly path: string;
  readonly oldPath?: string;
  readonly status: CollaborationCandidatePreviewFileStatus;
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly binary: boolean;
  readonly withheld: boolean;
  readonly binarySizeBytes?: number;
  readonly binarySha256?: string;
  readonly binarySha256Available?: boolean;
  readonly binaryGitObjectId?: string;
  readonly baseSizeBytes?: number;
  readonly baseSha256?: string;
  readonly baseSha256Available?: boolean;
  readonly baseGitObjectId?: string;
}

export interface CollaborationCandidatePreview {
  readonly workspaceId: string;
  readonly collaborationTaskId: string;
  readonly candidateId: string;
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly snapshotVersion: number;
  readonly diffHash: string;
  readonly contentHash: string;
  readonly offset: number;
  readonly nextOffset?: number;
  readonly totalFiles: number;
  readonly totalAdditions: number;
  readonly totalDeletions: number;
  readonly files: readonly CollaborationCandidatePreviewFile[];
  readonly withheldContent: boolean;
  readonly withheldReasons: readonly ('binary' | 'sensitive_path' | 'secret_value')[];
}

export interface CollaborationCandidatePreviewFileDiff {
  readonly workspaceId: string;
  readonly collaborationTaskId: string;
  readonly candidateId: string;
  readonly baseCommit: string;
  readonly diffHash: string;
  readonly contentHash: string;
  readonly fileIndex: number;
  readonly path: string;
  readonly diffText: string;
  readonly withheld: boolean;
  readonly withheldReason?: 'binary' | 'sensitive_path' | 'secret_value';
}

export interface CollaborationCandidatePreviewIdentity {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly candidateId: string;
  readonly baseCommit: string;
  readonly diffHash: string;
  readonly contentHash: string;
}

function collaborationCandidatePreviewBasePath(identity: CollaborationCandidatePreviewIdentity): string {
  return `/api/workspaces/${encodeURIComponent(identity.workspaceId)}/collaboration/tasks/${encodeURIComponent(identity.taskId)}`
    + `/candidates/${encodeURIComponent(identity.candidateId)}/preview`;
}

function identityQuery(identity: CollaborationCandidatePreviewIdentity, fields: Record<string, string>): string {
  const query = new URLSearchParams({ candidateBaseCommit: identity.baseCommit, candidateContentHash: identity.contentHash, ...fields });
  return query.toString();
}

export function collaborationCandidatePreviewPath(
  identity: CollaborationCandidatePreviewIdentity,
  page: { readonly offset?: number; readonly limit?: number } = {},
): string {
  return `${collaborationCandidatePreviewBasePath(identity)}?${identityQuery(identity, {
    offset: String(page.offset ?? 0), limit: String(page.limit ?? COLLABORATION_CANDIDATE_PREVIEW_PAGE_SIZE),
  })}`;
}

export function collaborationCandidatePreviewFilePath(identity: CollaborationCandidatePreviewIdentity, fileIndex: number): string {
  return `${collaborationCandidatePreviewBasePath(identity)}/files/${encodeURIComponent(String(fileIndex))}?${identityQuery(identity, {})}`;
}

export function collaborationCandidatePreviewKey(identity: CollaborationCandidatePreviewIdentity): string {
  return JSON.stringify([identity.workspaceId, identity.taskId, identity.candidateId, identity.baseCommit, identity.diffHash, identity.contentHash]);
}

export function collaborationCandidatePreviewMatches(
  identity: CollaborationCandidatePreviewIdentity,
  preview: Pick<CollaborationCandidatePreview, 'workspaceId' | 'collaborationTaskId' | 'candidateId' | 'baseCommit' | 'diffHash' | 'contentHash'>,
): boolean {
  return preview.workspaceId === identity.workspaceId && preview.collaborationTaskId === identity.taskId
    && preview.candidateId === identity.candidateId && preview.baseCommit === identity.baseCommit
    && preview.diffHash === identity.diffHash && preview.contentHash === identity.contentHash;
}

export function collaborationCandidatePreviewFileDiffMatches(
  identity: CollaborationCandidatePreviewIdentity,
  fileIndex: number,
  diff: CollaborationCandidatePreviewFileDiff,
): boolean {
  return collaborationCandidatePreviewMatches(identity, diff) && diff.fileIndex === fileIndex;
}

export async function fetchCollaborationCandidatePreview(
  apiBase: string,
  identity: CollaborationCandidatePreviewIdentity,
  signal: AbortSignal,
  page: { readonly offset?: number; readonly limit?: number } = {},
): Promise<CollaborationCandidatePreview> {
  const response = await fetch(`${apiBase}${collaborationCandidatePreviewPath(identity, page)}`, {
    method: 'GET', cache: 'no-store', signal,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { detail?: unknown; error?: unknown; title?: unknown };
    const message = typeof body.detail === 'string' ? body.detail
      : typeof body.error === 'string' ? body.error
        : typeof body.title === 'string' ? body.title : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return response.json() as Promise<CollaborationCandidatePreview>;
}

export async function fetchCollaborationCandidatePreviewFileDiff(
  apiBase: string,
  identity: CollaborationCandidatePreviewIdentity,
  fileIndex: number,
  signal: AbortSignal,
): Promise<CollaborationCandidatePreviewFileDiff> {
  const response = await fetch(`${apiBase}${collaborationCandidatePreviewFilePath(identity, fileIndex)}`, {
    method: 'GET', cache: 'no-store', signal,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { detail?: unknown; error?: unknown; title?: unknown };
    const message = typeof body.detail === 'string' ? body.detail
      : typeof body.error === 'string' ? body.error
        : typeof body.title === 'string' ? body.title : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return response.json() as Promise<CollaborationCandidatePreviewFileDiff>;
}
