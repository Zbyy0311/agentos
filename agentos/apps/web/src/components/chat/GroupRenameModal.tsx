import { useState } from 'react';

interface GroupRenameModalProps {
  title: string;
  saving: boolean;
  entityLabel?: string;
  onClose(): void;
  onSave(title: string): void;
}

export function GroupRenameModal({ title: initialTitle, saving, entityLabel = '群聊', onClose, onSave }: GroupRenameModalProps) {
  const [title, setTitle] = useState(initialTitle);
  return <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/70 p-6 backdrop-blur-sm">
    <form onSubmit={event => { event.preventDefault(); onSave(title); }} className="w-full max-w-md rounded-2xl border border-slate-700 bg-[#121a25] p-6 shadow-2xl">
      <div className="mb-5 flex items-center justify-between"><h2 className="text-lg font-semibold text-slate-100">编辑{entityLabel}名称</h2><button type="button" onClick={onClose} className="text-sm text-slate-500 hover:text-slate-200">关闭</button></div>
      <label className="block text-sm text-slate-300">{entityLabel}名称<input autoFocus value={title} onChange={event => setTitle(event.target.value)} className="mt-2 w-full rounded-lg border border-slate-700 bg-[#0d131b] px-3 py-2 text-slate-100 outline-none focus:border-blue-500" /></label>
      <div className="mt-6 flex justify-end gap-3"><button type="button" onClick={onClose} className="px-4 py-2 text-sm text-slate-400">取消</button><button disabled={saving || !title.trim()} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:bg-slate-700">{saving ? '保存中…' : '保存'}</button></div>
    </form>
  </div>;
}
