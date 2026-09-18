import type { Workspace } from '@agentos/shared';

interface WorkspaceListProps {
  workspaces: Workspace[];
  onOpen: (id: string) => void;
  onRemove: (id: string) => void;
}

export function WorkspaceList({ workspaces, onOpen, onRemove }: WorkspaceListProps) {
  if (workspaces.length === 0) return <div className="signal-empty px-5 py-12 text-center">
    <div className="relative z-10 mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-[var(--app-accent-soft)] text-xl ui-accent">⌂</div>
    <h3 className="relative z-10 mt-4 text-sm font-semibold ui-text">还没有工作区</h3>
    <p className="relative z-10 mx-auto mt-2 max-w-sm text-sm leading-6 ui-muted">新建或导入一个本地目录，AgentOS 会为它建立独立的协作上下文。</p>
  </div>;

  return <div className="space-y-2">
    {workspaces.map(workspace => <article key={workspace.id} data-workspace-id={workspace.id} className="signal-workspace-row group ui-panel p-4 sm:px-5">
      <button type="button" aria-label={`打开工作区 ${workspace.name}`} onClick={() => onOpen(workspace.id)} className="block w-full text-left">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
          <div className="flex min-w-0 items-center gap-3">
            <span className="signal-workspace-icon" aria-hidden="true">{workspace.name.slice(0, 1).toUpperCase()}</span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold ui-text">{workspace.name}</span>
              <span className="mt-1 block truncate text-xs ui-muted" title={workspace.rootPath}>{workspace.rootPath}</span>
            </span>
          </div>
          <span className="flex flex-wrap items-center gap-2 pl-[3.75rem] text-[11px] sm:justify-end sm:pl-0">
            <span className={`rounded-full border px-2 py-1 ${workspace.gitEnabled ? 'border-[color:var(--app-success)]/40 text-[var(--app-success)]' : 'ui-border ui-dim'}`}>Git {workspace.gitEnabled ? '已启用' : '未启用'}</span>
            <span className={`rounded-full border px-2 py-1 ${workspace.memoryEnabled ? 'border-[color:var(--app-success)]/40 text-[var(--app-success)]' : 'ui-border ui-dim'}`}>记忆 {workspace.memoryEnabled ? '已启用' : '未启用'}</span>
            <span className="rounded-full border ui-border px-2 py-1 ui-muted">{workspace.agents.length} 个 Agent</span>
          </span>
        </div>
      </button>
      <div className="mt-4 flex items-center justify-between border-t ui-border pt-3 pl-[3.75rem] text-[11px] sm:pl-0"><span className="ui-dim">最近打开：{new Date(workspace.lastOpenedAt).toLocaleString('zh-CN')}</span><button type="button" aria-label={`删除 ${workspace.name}`} onClick={() => onRemove(workspace.id)} className="ui-button-ghost rounded-lg px-2 py-1 text-xs hover:text-[var(--app-danger)]">删除</button></div>
    </article>)}
  </div>;
}
