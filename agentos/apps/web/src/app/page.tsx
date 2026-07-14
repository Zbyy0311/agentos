'use client';

import { useState } from 'react';
import { useWorkspace } from '@/lib/useWorkspace';
import { WorkspaceList } from '@/components/workspace/WorkspaceList';
import { NewWorkspaceModal } from '@/components/workspace/NewWorkspaceModal';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { useRouter } from 'next/navigation';

export default function Home() {
  const router = useRouter();
  const { workspaces, loading, error, createWorkspace, importWorkspace, removeWorkspace } = useWorkspace();
  const [showModal, setShowModal] = useState(false);
  const [importPath, setImportPath] = useState('');

  const handleOpen = (id: string) => router.push(`/workspace/${id}`);

  const handleImport = async () => {
    if (!importPath.trim()) return;
    const workspace = await importWorkspace(importPath.trim());
    if (workspace) handleOpen(workspace.id);
  };

  return <div className="app-shell min-h-screen">
    <header className="ui-panel flex items-center justify-between border-b px-6 py-4 sm:px-8">
      <div className="flex items-center gap-3">
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-[var(--app-accent)] text-sm font-bold text-white">A/</span>
        <div>
          <div className="text-base font-semibold tracking-tight ui-text">AgentOS</div>
          <div className="text-[11px] ui-dim">本地多 Agent 工作台</div>
        </div>
      </div>
      <ThemeToggle />
    </header>

    <main className="mx-auto max-w-6xl px-6 py-10 sm:px-8 lg:py-14">
      <section className="mb-10 flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
        <div className="max-w-xl">
          <p className="mb-3 text-xs font-medium tracking-[0.18em] ui-accent">WORKSPACE INDEX</p>
          <h1 className="text-3xl font-semibold tracking-[-0.03em] ui-text sm:text-4xl">把每个项目，整理成一个可以工作的空间。</h1>
          <p className="mt-4 max-w-lg text-sm leading-6 ui-muted">从本地目录进入项目，管理 Agent、会话和执行状态。所有工作区都保留在当前环境中。</p>
        </div>
        <button type="button" onClick={() => setShowModal(true)} className="ui-button-primary inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium">
          <span className="text-lg leading-none">+</span>
          新建工作区
        </button>
      </section>

      <section className="ui-panel-raised rounded-2xl border p-5 sm:p-6">
        <div className="mb-5 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold ui-text">工作区</h2>
            <p className="mt-1 text-xs ui-muted">打开一个工作区，继续上次的协作上下文。</p>
          </div>
          <span className="text-xs ui-dim">{workspaces.length} 个已连接</span>
        </div>

        <div className="mb-6 flex flex-col gap-2 sm:flex-row">
          <input type="text" value={importPath} onChange={event => setImportPath(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void handleImport(); }} placeholder="输入本地目录路径以导入…" className="ui-input min-w-0 flex-1 rounded-xl px-3.5 py-2.5 text-sm outline-none" />
          <button type="button" onClick={() => void handleImport()} disabled={!importPath.trim()} className="ui-button-secondary rounded-xl px-4 py-2.5 text-sm disabled:cursor-not-allowed disabled:opacity-40">导入目录</button>
        </div>

        {loading && <div className="rounded-xl border border-dashed ui-border px-4 py-10 text-center text-sm ui-muted">正在读取工作区…</div>}
        {error && <div role="alert" className="ui-error rounded-xl border px-4 py-3 text-sm">{error}</div>}
        {!loading && !error && <WorkspaceList workspaces={workspaces} onOpen={handleOpen} onRemove={removeWorkspace} />}
      </section>
    </main>

    {showModal && <NewWorkspaceModal onClose={() => setShowModal(false)} onCreate={async input => { const workspace = await createWorkspace(input); if (workspace) handleOpen(workspace.id); }} />}
  </div>;
}
