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

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !rootPath.trim()) return;
    setSubmitting(true);
    await onCreate({ name: name.trim(), rootPath: rootPath.trim(), git, memory, readme, docs });
    setSubmitting(false);
    onClose();
  };

  return <div className="fixed inset-0 z-50 grid place-items-center bg-[var(--app-overlay)] p-4 backdrop-blur-sm sm:p-6">
    <form onSubmit={handleSubmit} className="ui-panel-raised w-full max-w-lg rounded-2xl border p-5 shadow-[var(--app-shadow)] sm:p-6">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div><p className="text-xs font-medium tracking-[0.16em] ui-accent">NEW WORKSPACE</p><h2 className="mt-2 text-xl font-semibold ui-text">建立一个新的工作区</h2><p className="mt-1 text-sm ui-muted">为本地项目准备独立的 Agent 上下文。</p></div>
        <button type="button" onClick={onClose} className="ui-button-ghost rounded-lg px-2 py-1 text-sm">关闭</button>
      </div>
      <div className="space-y-4">
        <label className="block text-sm ui-text-soft">名称<input autoFocus type="text" value={name} onChange={event => setName(event.target.value)} placeholder="例如：agentos" className="ui-input mt-2 w-full rounded-xl px-3 py-2.5 text-sm outline-none" /></label>
        <label className="block text-sm ui-text-soft">本地目录<input type="text" value={rootPath} onChange={event => setRootPath(event.target.value)} placeholder="E:\\projects\\my-project" className="ui-input mt-2 w-full rounded-xl px-3 py-2.5 text-sm outline-none" /></label>
        <fieldset>
          <legend className="mb-2 text-sm ui-text-soft">初始化内容</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {[[git, setGit, '初始化 Git'], [memory, setMemory, '初始化 agent-memory'], [readme, setReadme, '创建 README'], [docs, setDocs, '创建 docs/']].map(([checked, setChecked, label]) => <label key={label as string} className="ui-panel rounded-xl border px-3 py-2.5 text-sm ui-text-soft"><input type="checkbox" checked={checked as boolean} onChange={event => (setChecked as (value: boolean) => void)(event.target.checked)} className="mr-2 accent-[var(--app-accent)]" />{label as string}</label>)}
          </div>
        </fieldset>
      </div>
      <div className="mt-7 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="ui-button-secondary rounded-xl px-4 py-2.5 text-sm">取消</button>
        <button type="submit" disabled={submitting || !name.trim() || !rootPath.trim()} className="ui-button-primary rounded-xl px-4 py-2.5 text-sm font-medium">{submitting ? '创建中…' : '创建工作区'}</button>
      </div>
    </form>
  </div>;
}
