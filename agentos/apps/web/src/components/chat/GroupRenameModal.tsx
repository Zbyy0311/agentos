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
  return <div className="fixed inset-0 z-50 grid place-items-center bg-[var(--app-overlay)] p-4 backdrop-blur-sm sm:p-6">
    <form onSubmit={event => { event.preventDefault(); onSave(title); }} className="ui-panel-raised w-full max-w-md rounded-2xl border p-5 shadow-[var(--app-shadow)] sm:p-6">
      <div className="mb-5 flex items-start justify-between"><div><p className="text-xs font-medium tracking-[0.16em] ui-accent">RENAME</p><h2 className="mt-2 text-lg font-semibold ui-text">编辑{entityLabel}名称</h2></div><button type="button" onClick={onClose} className="ui-button-ghost rounded-lg px-2 py-1 text-sm">关闭</button></div>
      <label className="block text-sm ui-text-soft">{entityLabel}名称<input autoFocus value={title} onChange={event => setTitle(event.target.value)} className="ui-input mt-2 w-full rounded-xl px-3 py-2 outline-none" /></label>
      <div className="mt-6 flex justify-end gap-3"><button type="button" onClick={onClose} className="ui-button-secondary rounded-xl px-4 py-2 text-sm">取消</button><button disabled={saving || !title.trim()} className="ui-button-primary rounded-xl px-4 py-2 text-sm font-medium disabled:cursor-not-allowed">{saving ? '保存中…' : '保存'}</button></div>
    </form>
  </div>;
}
