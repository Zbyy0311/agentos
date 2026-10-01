'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import type { MemoryEntryDto } from '@/lib/memoryEntries';
import {
  confirmedMemoryEntryLifecyclePayload,
  memoryDateTimeLocalValue,
  memoryDateTimeToIso,
  memoryEntryLifecyclePayload,
  type MemoryEntryLifecyclePayload,
  type MemoryEntryValidity,
  type MemoryLifecycleAction,
} from '@/lib/memoryManagement';

interface MemoryEntryLifecycleProps {
  readonly entry: MemoryEntryDto;
  readonly saving: boolean;
  onApply(payload: MemoryEntryLifecyclePayload): void;
}

type ConfirmableLifecycleAction = Exclude<MemoryLifecycleAction, 'set-validity'>;
type MemoryDateFields = { validFrom: string; validUntil: string; expiresAt: string };

const validityFields = [
  { key: 'validFrom', label: '生效时间' },
  { key: 'validUntil', label: '有效期至' },
  { key: 'expiresAt', label: '过期时间' },
] as const;

const actionLabels: Record<ConfirmableLifecycleAction, string> = {
  archive: '归档',
  restore: '恢复',
  delete: '软删除',
  revalidate: '重新验证',
};

const actionDescriptions: Record<ConfirmableLifecycleAction, string> = {
  archive: '记忆会从生效列表移入归档状态。',
  restore: '记忆会恢复为生效状态。',
  delete: '记忆会被软删除，记录仍保留在系统中。',
  revalidate: '记忆会重新验证并恢复为生效状态；现有有效期将保留。',
};

interface MemoryLifecycleActionConfirmationProps {
  readonly action: ConfirmableLifecycleAction;
  readonly title: string;
  readonly saving: boolean;
  readonly confirmRef: RefObject<HTMLButtonElement>;
  onConfirm(): void;
  onCancel(): void;
}

export function MemoryLifecycleActionConfirmation({ action, title, saving, confirmRef, onConfirm, onCancel }: MemoryLifecycleActionConfirmationProps) {
  const label = actionLabels[action];
  return <div role="group" aria-labelledby="memory-lifecycle-confirm-title" className="mt-3 rounded-xl border ui-border p-3" aria-live="polite">
    <p id="memory-lifecycle-confirm-title" className="text-sm font-medium ui-text">确认{label}“{title}”？</p>
    <p className="mt-1 text-xs leading-5 ui-dim">{actionDescriptions[action]}</p>
    <div className="mt-3 flex justify-end gap-2">
      <button type="button" disabled={saving} onClick={onCancel} className="ui-button-ghost rounded-lg px-3 py-2 text-xs disabled:opacity-50">取消</button>
      <button ref={confirmRef} type="button" disabled={saving} onClick={onConfirm} className={`${action === 'delete' ? 'border border-[var(--app-danger)]/40 text-[var(--app-danger)]' : 'ui-button-primary'} rounded-lg px-3 py-2 text-xs disabled:opacity-50`}>
        {saving ? '正在保存…' : `确认${label}`}
      </button>
    </div>
  </div>;
}

interface MemoryValidityConfirmationProps {
  readonly dates: MemoryDateFields;
  readonly saving: boolean;
  readonly confirmRef: RefObject<HTMLButtonElement>;
  onConfirm(): void;
  onEdit(): void;
}

export function MemoryValidityConfirmation({ dates, saving, confirmRef, onConfirm, onEdit }: MemoryValidityConfirmationProps) {
  return <div role="group" aria-labelledby="memory-validity-confirm-title" className="mt-4 rounded-xl border ui-border p-3" aria-live="polite">
    <p id="memory-validity-confirm-title" className="text-sm font-medium ui-text">确认更新有效期？留空的字段会被清除。</p>
    <dl className="mt-2 grid gap-2 text-xs sm:grid-cols-3">
      {validityFields.map(({ key, label }) => <div key={key}>
        <dt className="ui-dim">{label}</dt>
        <dd className="break-words ui-text-soft">{dates[key] || '清除此日期'}</dd>
      </div>)}
    </dl>
    <div className="mt-3 flex justify-end gap-2">
      <button type="button" disabled={saving} onClick={onEdit} className="ui-button-ghost rounded-lg px-3 py-2 text-xs disabled:opacity-50">返回修改</button>
      <button ref={confirmRef} type="button" disabled={saving} onClick={onConfirm} className="ui-button-primary rounded-lg px-3 py-2 text-xs disabled:opacity-50">
        {saving ? '正在保存…' : '确认更新有效期'}
      </button>
    </div>
  </div>;
}

export function MemoryEntryLifecycle({ entry, saving, onApply }: MemoryEntryLifecycleProps) {
  const [validityOpen, setValidityOpen] = useState(false);
  const [validityConfirming, setValidityConfirming] = useState(false);
  const [pendingAction, setPendingAction] = useState<ConfirmableLifecycleAction>();
  const [dates, setDates] = useState<MemoryDateFields>(() => ({
    validFrom: memoryDateTimeLocalValue(entry.validFrom),
    validUntil: memoryDateTimeLocalValue(entry.validUntil),
    expiresAt: memoryDateTimeLocalValue(entry.expiresAt),
  }));
  const [error, setError] = useState('');
  const actionConfirmRef = useRef<HTMLButtonElement>(null);
  const actionTriggerRef = useRef<HTMLButtonElement | null>(null);
  const pendingActionWasSet = useRef(false);
  const validityConfirmRef = useRef<HTMLButtonElement>(null);
  const validityTriggerRef = useRef<HTMLButtonElement>(null);
  const validityContinueRef = useRef<HTMLButtonElement>(null);
  const validityWasOpen = useRef(false);
  const validityWasConfirming = useRef(false);

  useEffect(() => {
    if (pendingAction) {
      pendingActionWasSet.current = true;
      actionConfirmRef.current?.focus();
    } else if (pendingActionWasSet.current) {
      pendingActionWasSet.current = false;
      actionTriggerRef.current?.focus();
    }
  }, [pendingAction]);

  useEffect(() => {
    if (validityConfirming) {
      validityWasConfirming.current = true;
      validityConfirmRef.current?.focus();
    } else if (validityWasConfirming.current) {
      validityWasConfirming.current = false;
      validityContinueRef.current?.focus();
    }
  }, [validityConfirming]);

  useEffect(() => {
    if (validityOpen) validityWasOpen.current = true;
    else if (validityWasOpen.current) {
      validityWasOpen.current = false;
      validityTriggerRef.current?.focus();
    }
  }, [validityOpen]);

  const validityPayload = (): MemoryEntryLifecyclePayload | undefined => {
    const validity: MemoryEntryValidity = {
      validFrom: memoryDateTimeToIso(dates.validFrom),
      validUntil: memoryDateTimeToIso(dates.validUntil),
      expiresAt: memoryDateTimeToIso(dates.expiresAt),
    };
    if (Object.values(validity).some(value => value === undefined)) {
      setError('请检查日期格式');
      return undefined;
    }
    return memoryEntryLifecyclePayload(entry, 'set-validity', validity);
  };

  const askForActionConfirmation = (action: ConfirmableLifecycleAction, trigger: HTMLButtonElement) => {
    setError('');
    actionTriggerRef.current = trigger;
    setPendingAction(action);
  };

  const confirmAction = () => {
    if (!pendingAction || saving) return;
    const payload = confirmedMemoryEntryLifecyclePayload(entry, pendingAction, true);
    if (payload) onApply(payload);
  };

  const beginValidityConfirmation = () => {
    setError('');
    if (validityPayload()) setValidityConfirming(true);
  };

  const confirmValidity = () => {
    if (saving) return;
    const payload = validityPayload();
    if (payload) onApply(payload);
  };

  const canRestore = entry.status === 'archived' || entry.status === 'deprecated' || entry.status === 'deleted';
  const lifecycleAllowed = entry.status !== 'deleted' && entry.status !== 'candidate' && entry.status !== 'conflicted';

  return <section aria-label="记忆生命周期" className="mt-5 border-t ui-border pt-4">
    <h4 className="mb-2 text-xs font-medium ui-muted">生命周期与有效期</h4>
    <dl className="mb-3 grid gap-2 text-xs sm:grid-cols-3">
      {validityFields.map(({ key, label }) => <div key={key}><dt className="ui-dim">{label}</dt><dd className="ui-text-soft">{entry[key] ?? '未设置'}</dd></div>)}
    </dl>
    <div className="flex flex-wrap gap-2">
      {entry.status === 'active' && <button type="button" disabled={saving || Boolean(pendingAction)} onClick={event => askForActionConfirmation('archive', event.currentTarget)} className="ui-button-ghost rounded-lg border ui-border px-3 py-2 text-xs disabled:opacity-50">归档</button>}
      {canRestore && <button type="button" disabled={saving || Boolean(pendingAction)} onClick={event => askForActionConfirmation('restore', event.currentTarget)} className="ui-button-ghost rounded-lg border ui-border px-3 py-2 text-xs disabled:opacity-50">恢复</button>}
      {lifecycleAllowed && <button type="button" disabled={saving || Boolean(pendingAction)} onClick={event => askForActionConfirmation('revalidate', event.currentTarget)} className="ui-button-ghost rounded-lg border ui-border px-3 py-2 text-xs disabled:opacity-50">重新验证</button>}
      {lifecycleAllowed && <button ref={validityTriggerRef} type="button" disabled={saving || Boolean(pendingAction)} onClick={() => { setError(''); setValidityConfirming(false); setValidityOpen(true); }} className="ui-button-ghost rounded-lg border ui-border px-3 py-2 text-xs disabled:opacity-50">设置有效期</button>}
      {lifecycleAllowed && <button type="button" disabled={saving || Boolean(pendingAction)} onClick={event => askForActionConfirmation('delete', event.currentTarget)} className="rounded-lg border border-[var(--app-danger)]/40 px-3 py-2 text-xs text-[var(--app-danger)] disabled:opacity-50">软删除</button>}
    </div>
    {pendingAction && <MemoryLifecycleActionConfirmation
      action={pendingAction}
      title={entry.title}
      saving={saving}
      confirmRef={actionConfirmRef}
      onConfirm={confirmAction}
      onCancel={() => setPendingAction(undefined)}
    />}
    {validityOpen && <div role="dialog" aria-modal="true" aria-labelledby="memory-validity-title" className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="ui-panel w-full max-w-lg rounded-2xl border p-5 shadow-xl">
        <h3 id="memory-validity-title" className="text-base font-semibold ui-text">设置记忆有效期</h3>
        <p className="mt-1 text-xs leading-5 ui-dim">留空会清除该日期。日期按当前时区解释并保存为 ISO 时间。</p>
        {!validityConfirming && <div className="mt-4 space-y-3">
          {validityFields.map(({ key, label }) => <label key={key} className="block text-xs ui-muted">{label}<input aria-label={label} type="datetime-local" value={dates[key]} onChange={event => {
            setDates(current => ({ ...current, [key]: event.target.value }));
            setError('');
          }} className="mt-1 w-full rounded-lg border ui-border bg-transparent px-3 py-2 text-sm ui-text" /></label>)}
        </div>}
        {error && <p role="alert" className="mt-3 text-xs text-[var(--app-danger)]">{error}</p>}
        {validityConfirming
          ? <MemoryValidityConfirmation
            dates={dates}
            saving={saving}
            confirmRef={validityConfirmRef}
            onConfirm={confirmValidity}
            onEdit={() => setValidityConfirming(false)}
          />
          : <div className="mt-5 flex justify-end gap-2">
            <button type="button" disabled={saving} onClick={() => setValidityOpen(false)} className="ui-button-ghost rounded-lg px-3 py-2 text-sm">取消</button>
          <button ref={validityContinueRef} type="button" disabled={saving} onClick={beginValidityConfirmation} className="ui-button-primary rounded-lg px-3 py-2 text-sm disabled:opacity-50">继续确认</button>
          </div>}
      </div>
    </div>}
  </section>;
}
