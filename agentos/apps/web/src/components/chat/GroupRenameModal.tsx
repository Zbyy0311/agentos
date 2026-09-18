import { useState } from 'react';
import { ModalShell } from '@/components/feedback/ModalShell';

interface GroupRenameModalProps {
  title: string;
  saving: boolean;
  entityLabel?: string;
  onClose(): void;
  onSave(title: string): void;
}

export function GroupRenameModal({ title: initialTitle, saving, entityLabel = '群聊', onClose, onSave }: GroupRenameModalProps) {
  const [title, setTitle] = useState(initialTitle);
  return <ModalShell title={`编辑${entityLabel}名称`} eyebrow="RENAME" onClose={onClose} size="sm" footer={<div className="flex justify-end gap-3"><button type="button" onClick={onClose} className="ui-button-secondary rounded-xl px-4 py-2 text-sm">取消</button><button type="submit" form="rename-form" disabled={saving || !title.trim()} className="ui-button-primary rounded-xl px-4 py-2 text-sm font-medium disabled:cursor-not-allowed">{saving ? '保存中…' : '保存'}</button></div>}>
    <form id="rename-form" onSubmit={event => { event.preventDefault(); onSave(title); }}>
      <label className="block text-sm ui-text-soft">{entityLabel}名称<input autoFocus value={title} onChange={event => setTitle(event.target.value)} className="ui-input mt-2 w-full rounded-xl px-3 py-2 outline-none" /></label>
    </form>
  </ModalShell>;
}
