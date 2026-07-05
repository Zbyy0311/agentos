import { useState } from 'react';

interface NewWorkspaceModalProps {
  onClose: () => void;
  onCreate: (input: { name: string; rootPath: string; git: boolean; memory: boolean; readme: boolean; docs: boolean }) => Promise<void>;
}

export function NewWorkspaceModal({ onClose, onCreate }: NewWorkspaceModalProps) {
  const [name, setName] = useState('');
  const [rootPath, setRootPath] = useState('');
  const [git, setGit] = useState(true);
  const [memory, setMemory] = useState(true);
  const [readme, setReadme] = useState(true);
  const [docs, setDocs] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !rootPath) return;
    setSubmitting(true);
    await onCreate({ name, rootPath, git, memory, readme, docs });
    setSubmitting(false);
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-surface-800 border border-surface-600 rounded-lg w-[480px] p-6 shadow-xl">
        <h2 className="text-lg font-semibold mb-4">New Workspace</h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs text-slate-400 mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="my-project"
              className="w-full bg-surface-900 border border-surface-600 rounded px-3 py-2 text-sm outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Local Directory</label>
            <input
              type="text"
              value={rootPath}
              onChange={e => setRootPath(e.target.value)}
              placeholder="E:\\projects\\my-project"
              className="w-full bg-surface-900 border border-surface-600 rounded px-3 py-2 text-sm outline-none focus:border-blue-500"
            />
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={git} onChange={e => setGit(e.target.checked)} />
              Init Git
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={memory} onChange={e => setMemory(e.target.checked)} />
              Init agent-memory
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={readme} onChange={e => setReadme(e.target.checked)} />
              Create README
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={docs} onChange={e => setDocs(e.target.checked)} />
              Create docs/
            </label>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm border border-surface-600 rounded hover:bg-surface-700">Cancel</button>
            <button
              type="submit"
              disabled={submitting || !name || !rootPath}
              className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:bg-slate-600 rounded"
            >
              {submitting ? 'Creating...' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
