'use client';

import { useState } from 'react';
import { useWorkspace } from '@/lib/useWorkspace';
import { WorkspaceList } from '@/components/workspace/WorkspaceList';
import { NewWorkspaceModal } from '@/components/workspace/NewWorkspaceModal';
import { useRouter } from 'next/navigation';

export default function Home() {
  const router = useRouter();
  const { workspaces, loading, error, createWorkspace, importWorkspace, removeWorkspace } = useWorkspace();
  const [showModal, setShowModal] = useState(false);
  const [importPath, setImportPath] = useState('');

  const handleOpen = (id: string) => {
    router.push(`/workspace/${id}`);
  };

  const handleImport = async () => {
    if (!importPath) return;
    const workspace = await importWorkspace(importPath);
    if (workspace) handleOpen(workspace.id);
  };

  return (
    <div className="min-h-screen bg-[#0f1117] text-slate-200">
      <header className="flex items-center justify-between px-6 py-4 border-b border-surface-700 bg-surface-800">
        <div className="flex items-center gap-3">
          <span className="text-xl font-bold bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent">
            AgentOS
          </span>
          <span className="text-xs text-slate-500">v0.2.0 — Workspace Edition</span>
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-6">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-lg font-semibold">Workspaces</h1>
          <button
            onClick={() => setShowModal(true)}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded text-sm font-medium"
          >
            + New Workspace
          </button>
        </div>

        <div className="flex gap-2 mb-6">
          <input
            type="text"
            value={importPath}
            onChange={e => setImportPath(e.target.value)}
            placeholder="Import existing directory..."
            className="flex-1 bg-surface-900 border border-surface-600 rounded px-3 py-2 text-sm outline-none focus:border-blue-500"
          />
          <button
            onClick={handleImport}
            disabled={!importPath}
            className="px-4 py-2 border border-surface-600 rounded text-sm hover:bg-surface-700 disabled:opacity-50"
          >
            Import
          </button>
        </div>

        {loading && <div className="text-slate-500 text-sm">Loading workspaces...</div>}
        {error && <div className="text-red-400 text-sm">{error}</div>}
        {!loading && !error && (
          <WorkspaceList workspaces={workspaces} onOpen={handleOpen} onRemove={removeWorkspace} />
        )}
      </main>

      {showModal && (
        <NewWorkspaceModal
          onClose={() => setShowModal(false)}
          onCreate={async (input) => {
            const workspace = await createWorkspace(input);
            if (workspace) handleOpen(workspace.id);
          }}
        />
      )}
    </div>
  );
}
