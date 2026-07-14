import type { Workspace } from '@agentos/shared';

interface WorkspaceListProps {
  workspaces: Workspace[];
  onOpen: (id: string) => void;
  onRemove: (id: string) => void;
}

export function WorkspaceList({ workspaces, onOpen, onRemove }: WorkspaceListProps) {
  if (workspaces.length === 0) return <div className="rounded-xl border border-dashed ui-border px-5 py-12 text-center">
    <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-[var(--app-accent-soft)] text-xl ui-accent">⌂</div>
    <h3 className="mt-4 text-sm font-semibold ui-text">还没有工作区</h3>
    <p className="mx-auto mt-2 max-w-sm text-sm leading-6 ui-muted">新建或导入一个本地目录，AgentOS 会为它建立独立的协作上下文。</p>
  </div>;

  return <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
    {workspaces.map(workspace => <article key={workspace.id} className="group ui-panel rounded-xl border p-4 transition hover:-translate-y-0.5 hover:border-[var(--app-accent)]" onClick={() => onOpen(workspace.id)}>
      <div className="flex items-start justify-between gap-3">
        <button type="button" onClick={() => onOpen(workspace.id)} className="min-w-0 text-left">
          <div className="truncate text-sm font-semibold ui-text">{workspace.name}</div>
          <div className="mt-1 truncate text-xs ui-muted" title={workspace.rootPath}>{workspace.rootPath}</div>
        </button>
        <button type="button" aria-label={`删除 ${workspace.name}`} onClick={event => { event.stopPropagation(); onRemove(workspace.id); }} className="ui-button-ghost shrink-0 rounded-lg px-2 py-1 text-xs hover:text-[var(--app-danger)]">删除</button>
      </div>
      <div className="mt-5 flex flex-wrap gap-2 text-[11px]">
        <span className={`rounded-full border px-2 py-1 ${workspace.gitEnabled ? 'border-[color:var(--app-success)]/40 text-[var(--app-success)]' : 'ui-border ui-dim'}`}>Git {workspace.gitEnabled ? '已启用' : '未启用'}</span>
        <span className={`rounded-full border px-2 py-1 ${workspace.memoryEnabled ? 'border-[color:var(--app-success)]/40 text-[var(--app-success)]' : 'ui-border ui-dim'}`}>记忆 {workspace.memoryEnabled ? '已启用' : '未启用'}</span>
        <span className="rounded-full border ui-border px-2 py-1 ui-muted">{workspace.agents.length} 个 Agent</span>
      </div>
      <div className="mt-4 border-t ui-border pt-3 text-[11px] ui-dim">最近打开：{new Date(workspace.lastOpenedAt).toLocaleString('zh-CN')}</div>
    </article>)}
  </div>;
}
