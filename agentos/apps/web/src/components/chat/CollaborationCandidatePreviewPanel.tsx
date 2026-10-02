'use client';

import { useEffect, useRef, useState } from 'react';
import {
  collaborationCandidatePreviewFileDiffMatches,
  collaborationCandidatePreviewKey,
  collaborationCandidatePreviewMatches,
  COLLABORATION_CANDIDATE_PREVIEW_PAGE_SIZE,
  fetchCollaborationCandidatePreview,
  fetchCollaborationCandidatePreviewFileDiff,
  type CollaborationCandidatePreview,
  type CollaborationCandidatePreviewFile,
  type CollaborationCandidatePreviewFileDiff,
  type CollaborationCandidatePreviewIdentity,
} from '@/lib/collaborationCandidatePreview';

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unit]}`;
}

const FILE_STATUS: Record<string, string> = { added: '新增', modified: '修改', deleted: '删除', renamed: '重命名' };
const WITHHELD_REASON: Record<string, string> = {
  binary: '二进制内容已隐藏；大小与 SHA-256 来自冻结候选清单。旧候选未留存的数据会明确标为不可得',
  sensitive_path: '敏感文件内容已隐藏',
  secret_value: '疑似凭据或密钥内容已隐藏',
};

function validatePage(identity: CollaborationCandidatePreviewIdentity, preview: CollaborationCandidatePreview, offset: number): void {
  const expectedNextOffset = offset + preview.files.length < preview.totalFiles ? offset + preview.files.length : undefined;
  if (!collaborationCandidatePreviewMatches(identity, preview) || preview.offset !== offset
    || !Number.isSafeInteger(preview.totalFiles) || preview.totalFiles < 0 || preview.totalFiles > 500
    || offset > preview.totalFiles || (preview.files.length === 0 && preview.totalFiles !== 0)
    || preview.files.length > COLLABORATION_CANDIDATE_PREVIEW_PAGE_SIZE
    || preview.files.some((file, index) => file.fileIndex !== offset + index)
    || preview.nextOffset !== expectedNextOffset) {
    throw new Error('服务返回的候选身份或文件页边界与当前冻结选择不一致');
  }
}

export function CollaborationCandidatePreviewPanel(props: {
  readonly apiBase: string;
  readonly identity: CollaborationCandidatePreviewIdentity;
  readonly onLoaded?: (key: string) => void;
}) {
  const key = collaborationCandidatePreviewKey(props.identity);
  const [state, setState] = useState<{ key: string; loading: boolean; preview?: CollaborationCandidatePreview; error?: string }>({ key, loading: true });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState('');
  const [openFileIndex, setOpenFileIndex] = useState<number | null>(null);
  const [fileDiffs, setFileDiffs] = useState<Record<number, CollaborationCandidatePreviewFileDiff>>({});
  const [fileLoadingIndex, setFileLoadingIndex] = useState<number | null>(null);
  const [fileError, setFileError] = useState('');
  const onLoadedRef = useRef(props.onLoaded);
  const fileDiffAbortRef = useRef<AbortController | null>(null);
  const nextPageAbortRef = useRef<AbortController | null>(null);
  const activeKeyRef = useRef(key);
  activeKeyRef.current = key;
  onLoadedRef.current = props.onLoaded;

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setState({ key, loading: true });
    setLoadingMore(false);
    setMoreError('');
    setOpenFileIndex(null);
    setFileDiffs({});
    setFileLoadingIndex(null);
    setFileError('');
    fileDiffAbortRef.current?.abort();
    nextPageAbortRef.current?.abort();
    void fetchCollaborationCandidatePreview(props.apiBase, props.identity, controller.signal)
      .then(preview => {
        if (!active || controller.signal.aborted) return;
        validatePage(props.identity, preview, 0);
        setState({ key, loading: false, preview });
        if (preview.nextOffset === undefined) onLoadedRef.current?.(key);
      })
      .catch(cause => {
        if (!active || controller.signal.aborted) return;
        setState({ key, loading: false, error: cause instanceof Error ? cause.message : '冻结候选预览加载失败' });
      });
    return () => {
      active = false;
      controller.abort();
      fileDiffAbortRef.current?.abort();
      nextPageAbortRef.current?.abort();
    };
  }, [key, props.apiBase, props.identity.candidateId, props.identity.diffHash, props.identity.taskId, props.identity.workspaceId]);

  const current = state.key === key ? state : { key, loading: true };
  const preview = current.preview;

  const loadNextPage = async () => {
    if (!preview || preview.nextOffset === undefined || loadingMore) return;
    const offset = preview.nextOffset;
    const controller = new AbortController();
    nextPageAbortRef.current?.abort();
    nextPageAbortRef.current = controller;
    setLoadingMore(true);
    setMoreError('');
    try {
      const page = await fetchCollaborationCandidatePreview(props.apiBase, props.identity, controller.signal, { offset });
      if (controller.signal.aborted || activeKeyRef.current !== key) return;
      validatePage(props.identity, page, offset);
      if (page.totalFiles !== preview.totalFiles || page.offset !== preview.files.length) {
        throw new Error('候选文件分页与已加载快照不连续，请刷新后重试');
      }
      setState(previous => {
        if (previous.key !== key || !previous.preview) return previous;
        const loaded = previous.preview.files.length;
        if (page.offset !== loaded) return { ...previous, error: '候选文件分页顺序发生变化，请刷新后重试' };
        const combined: CollaborationCandidatePreview = {
          ...page,
          offset: 0,
          files: [...previous.preview.files, ...page.files],
          withheldContent: previous.preview.withheldContent || page.withheldContent,
          withheldReasons: [...new Set([...previous.preview.withheldReasons, ...page.withheldReasons])],
        };
        return { key, loading: false, preview: combined };
      });
      if (page.nextOffset === undefined) onLoadedRef.current?.(key);
    } catch (cause) {
      if (!controller.signal.aborted && activeKeyRef.current === key) setMoreError(cause instanceof Error ? cause.message : '读取下一页候选文件失败');
    } finally {
      if (nextPageAbortRef.current === controller) {
        nextPageAbortRef.current = null;
        if (activeKeyRef.current === key) setLoadingMore(false);
      }
    }
  };

  const toggleFileDiff = async (file: CollaborationCandidatePreviewFile) => {
    if (openFileIndex === file.fileIndex) {
      setOpenFileIndex(null);
      return;
    }
    setOpenFileIndex(file.fileIndex);
    setFileError('');
    if (fileDiffs[file.fileIndex]) return;
    fileDiffAbortRef.current?.abort();
    const controller = new AbortController();
    fileDiffAbortRef.current = controller;
    setFileLoadingIndex(file.fileIndex);
    try {
      const diff = await fetchCollaborationCandidatePreviewFileDiff(props.apiBase, props.identity, file.fileIndex, controller.signal);
      if (controller.signal.aborted || activeKeyRef.current !== key) return;
      if (!collaborationCandidatePreviewFileDiffMatches(props.identity, file.fileIndex, diff) || diff.path !== file.path) {
        throw new Error('服务返回的文件差异不属于当前冻结候选');
      }
      setFileDiffs(previous => ({ ...previous, [file.fileIndex]: diff }));
    } catch (cause) {
      if (!controller.signal.aborted && activeKeyRef.current === key) setFileError(cause instanceof Error ? cause.message : '读取文本差异失败');
    } finally {
      if (!controller.signal.aborted && activeKeyRef.current === key) setFileLoadingIndex(null);
    }
  };

  if (current.loading) return <div role="status" className="mt-3 rounded-lg border ui-border px-3 py-3 text-xs ui-muted">正在读取冻结候选文件清单…</div>;
  if (current.error) return <div role="alert" className="mt-3 rounded-lg border border-[var(--app-danger)]/40 px-3 py-3 text-xs text-[var(--app-danger)]">{current.error}</div>;
  if (!preview) return null;

  const isComplete = preview.nextOffset === undefined && preview.files.length === preview.totalFiles;
  return <section className="mt-3 min-w-0 rounded-xl border ui-border bg-[var(--app-surface-soft)] p-3" aria-label="冻结候选文件预览" data-candidate-preview={preview.candidateId}>
    <header className="flex flex-wrap items-start justify-between gap-2 border-b ui-border pb-3">
      <div className="min-w-0">
        <h3 className="text-xs font-semibold ui-text">冻结候选预览</h3>
        <div className="mt-1 break-all text-[10px] ui-dim">Candidate {preview.candidateId} · snapshot v{preview.snapshotVersion}</div>
        <div className="mt-1 break-all text-[10px] ui-dim">内容 SHA-256 <code>{preview.contentHash}</code></div>
      </div>
      <div className="shrink-0 text-right text-[10px] ui-muted">基线 {preview.baseCommit.slice(0, 10)}<br />头提交 {preview.headCommit.slice(0, 10)}</div>
    </header>

    <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] ui-muted" aria-label="差异统计">
      <span>已加载 {preview.files.length}/{preview.totalFiles} 个文件</span>
      <span className="text-[var(--app-success)]">+{preview.totalAdditions}</span>
      <span className="text-[var(--app-danger)]">−{preview.totalDeletions}</span>
      {isComplete && <span className="text-[var(--app-success)]">文件清单已完整加载</span>}
    </div>

    {preview.withheldContent && <p role="status" className="mt-3 rounded-lg border border-[var(--app-warning)]/40 bg-[var(--app-warning)]/10 px-3 py-2 text-[11px] leading-5 ui-text-soft">
      {preview.withheldReasons.map(reason => WITHHELD_REASON[reason] ?? '部分内容已隐藏').join('；')}。
    </p>}

    <ul className="mt-3 grid gap-2" aria-label="候选文件清单">
      {preview.files.map(file => {
        const isOpen = openFileIndex === file.fileIndex;
        const fileDiff = fileDiffs[file.fileIndex];
        return <li key={file.fileIndex} className="min-w-0 rounded-lg border ui-border bg-[var(--app-surface)] px-3 py-2">
          <div className="flex flex-wrap items-start gap-x-2 gap-y-1 text-[11px]">
            <span className="shrink-0 rounded border ui-border px-1.5 py-0.5 ui-muted">{FILE_STATUS[file.status]}</span>
            <code className="min-w-0 break-all ui-text-soft">{file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}</code>
            {file.binary ? <span className="ml-auto shrink-0 ui-muted">二进制</span>
              : <span className="ml-auto shrink-0 ui-muted"><span className="text-[var(--app-success)]">+{file.additions ?? 0}</span> / <span className="text-[var(--app-danger)]">−{file.deletions ?? 0}</span></span>}
          </div>
          {file.binary && <div className="mt-2 break-all text-[10px] ui-dim">
            {file.status === 'deleted' ? '基线文件' : '候选文件'}：{file.binarySizeBytes === undefined ? '大小未知' : formatBytes(file.binarySizeBytes)}
            {file.binarySha256 ? <> · 文件 SHA-256 <code>{file.binarySha256}</code></> : file.binarySha256Available === false ? ' · 文件 SHA-256 未留存（旧候选不可得）' : null}
            {file.binaryGitObjectId && <> · Git blob ID <code>{file.binaryGitObjectId}</code></>}
            {(file.status === 'modified' || file.status === 'renamed') && <> · 基线 {file.baseSizeBytes === undefined ? '大小未留存（旧候选不可得）' : formatBytes(file.baseSizeBytes)}{file.baseSha256 ? <> · SHA-256 <code>{file.baseSha256}</code></> : file.baseSha256Available === false ? ' · SHA-256 未留存（旧候选不可得）' : null}{file.baseGitObjectId && <> · Git blob ID <code>{file.baseGitObjectId}</code></>}</>}
          </div>}
          {file.withheld && <div className="mt-2 text-[10px] text-[var(--app-warning)]">{file.binary ? WITHHELD_REASON.binary : '文件内容含有已隐藏部分'}</div>}
          {!file.binary && <><button type="button" className="ui-button-ghost mt-2 rounded-md px-2 py-1 text-[10px]" onClick={() => { void toggleFileDiff(file); }}>{isOpen ? '收起文本差异' : '按需加载文本差异'}</button>
            {isOpen && <div className="mt-2 min-w-0">
              {fileLoadingIndex === file.fileIndex && <div role="status" className="text-[10px] ui-muted">正在读取此文件的冻结差异…</div>}
              {fileError && <div role="alert" className="text-[10px] text-[var(--app-danger)]">{fileError}</div>}
              {fileDiff && <pre className="max-h-[50vh] overflow-auto rounded-lg border ui-border bg-[var(--app-surface-soft)] p-3 text-[11px] leading-5 ui-text-soft">{fileDiff.diffText}</pre>}
            </div>}
          </>}
        </li>;
      })}
    </ul>

    {preview.nextOffset !== undefined && <div className="mt-3">
      {moreError && <p role="alert" className="mb-2 text-[11px] text-[var(--app-danger)]">{moreError}</p>}
      <button type="button" disabled={loadingMore} className="ui-button-secondary rounded-lg px-3 py-2 text-xs disabled:opacity-50" onClick={() => { void loadNextPage(); }}>
        {loadingMore ? '正在加载…' : `按需加载接下来的 ${Math.min(COLLABORATION_CANDIDATE_PREVIEW_PAGE_SIZE, preview.totalFiles - preview.files.length)} 个文件`}
      </button>
    </div>}
  </section>;
}
