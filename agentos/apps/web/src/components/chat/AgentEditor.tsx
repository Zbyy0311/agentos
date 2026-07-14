import { useState } from 'react';
import type { AgentModelOption, AgentPermission, AgentProfile, ModelDiscoverySource, ThinkingEffort } from '@agentos/shared';

interface AgentEditorProps {
  agent: AgentProfile;
  saving: boolean;
  refreshingModels?: boolean;
  onClose(): void;
  onRefreshModels?(): void;
  onSave(update: Pick<AgentProfile, 'roleTitle' | 'systemPrompt' | 'permissions' | 'enabled'> & Partial<Pick<AgentProfile, 'name' | 'model'>> & { thinkingEffort: ThinkingEffort }): void;
}

const permissionOptions: Array<{ value: AgentPermission; label: string }> = [
  { value: 'read', label: '读取项目文件' },
  { value: 'write', label: '修改项目文件' },
  { value: 'review', label: '代码审查' },
];

const effortLabels: Record<ThinkingEffort, string> = { auto: '自动（默认）', low: '低', medium: '中', high: '高' };
const sourceLabels: Record<ModelDiscoverySource, string> = { live: 'CLI 实时读取', cache: 'CLI 本地缓存', config: 'CLI 配置文件', fallback: '静态回退' };

export function AgentEditor({ agent, saving, refreshingModels = false, onClose, onRefreshModels, onSave }: AgentEditorProps) {
  const modelOptions: AgentModelOption[] = agent.capability?.modelOptions ?? (agent.capability?.models ?? []).map(id => ({ id, label: id, thinkingEfforts: agent.capability?.thinkingEfforts ?? ['auto'], defaultThinkingEffort: agent.capability?.defaultThinkingEffort ?? 'auto' }));
  const models = modelOptions.map(model => model.id);
  const knownModel = !agent.model || models.includes(agent.model);
  const [name, setName] = useState(agent.name);
  const [roleTitle, setRoleTitle] = useState(agent.roleTitle);
  const [systemPrompt, setSystemPrompt] = useState(agent.systemPrompt);
  const [modelChoice, setModelChoice] = useState(knownModel ? agent.model ?? '' : '__custom__');
  const [customModel, setCustomModel] = useState(knownModel ? '' : agent.model ?? '');
  const selectedModelOption = modelOptions.find(model => model.id === modelChoice);
  const availableThinkingEfforts = selectedModelOption?.thinkingEfforts ?? agent.capability?.thinkingEfforts ?? ['auto'];
  const savedThinkingEffort = agent.thinkingEffort ?? agent.capability?.defaultThinkingEffort ?? 'auto';
  const [thinkingEffort, setThinkingEffort] = useState<ThinkingEffort>(availableThinkingEfforts.includes(savedThinkingEffort) ? savedThinkingEffort : selectedModelOption?.defaultThinkingEffort ?? 'auto');
  const [enabled, setEnabled] = useState(agent.enabled);
  const [permissions, setPermissions] = useState<AgentPermission[]>(agent.permissions);

  const submit = () => {
    const selectedModel = modelChoice === '__custom__' ? customModel.trim() : modelChoice.trim();
    onSave({ name, roleTitle, systemPrompt, model: selectedModel, thinkingEffort, enabled, permissions });
  };

  const togglePermission = (permission: AgentPermission) => setPermissions(current => current.includes(permission) ? current.filter(item => item !== permission) : [...current, permission]);
  const source = agent.capability?.modelSource;

  return <div className="fixed inset-0 z-50 grid place-items-center bg-[var(--app-overlay)] p-4 backdrop-blur-sm sm:p-6">
    <form onSubmit={event => { event.preventDefault(); submit(); }} className="ui-panel-raised max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-2xl border p-5 shadow-[var(--app-shadow)] sm:p-6">
      <div className="mb-6 flex items-start justify-between gap-4"><div><p className="text-xs font-medium tracking-[0.16em] ui-accent">AGENT PROFILE</p><h2 className="mt-2 text-lg font-semibold ui-text">编辑 Agent 身份</h2><p className="mt-1 text-sm ui-muted">默认模型用于未指定单次覆盖的消息。</p></div><button type="button" onClick={onClose} className="ui-button-ghost rounded-lg px-2 py-1 text-sm">关闭</button></div>
      <div className="space-y-4">
        <label className="block text-sm ui-text-soft">显示名称<input value={name} onChange={event => setName(event.target.value)} className="ui-input mt-2 w-full rounded-xl px-3 py-2.5 outline-none" /></label>
        <label className="block text-sm ui-text-soft">职责<input value={roleTitle} onChange={event => setRoleTitle(event.target.value)} className="ui-input mt-2 w-full rounded-xl px-3 py-2.5 outline-none" /></label>
        <label className="block text-sm ui-text-soft">系统提示<textarea value={systemPrompt} onChange={event => setSystemPrompt(event.target.value)} className="ui-input mt-2 h-24 w-full resize-none rounded-xl px-3 py-2.5 outline-none" /></label>
        <label className="block text-sm ui-text-soft">默认模型<select value={modelChoice} onChange={event => { const nextChoice = event.target.value; const nextOption = modelOptions.find(model => model.id === nextChoice); setModelChoice(nextChoice); if (nextChoice !== '__custom__') setCustomModel(''); if (nextOption && !nextOption.thinkingEfforts.includes(thinkingEffort)) setThinkingEffort(nextOption.defaultThinkingEffort); }} className="ui-input mt-2 w-full rounded-xl px-3 py-2.5 outline-none"><option value="">使用 CLI 默认模型</option>{modelOptions.map(model => <option key={model.id} value={model.id}>{model.label}{model.label !== model.id ? ` · ${model.id}` : ''}</option>)}<option value="__custom__">自定义模型</option></select>{source && <span className="mt-2 flex items-center justify-between text-xs ui-muted"><span>来源：{sourceLabels[source]}</span>{onRefreshModels && <button type="button" onClick={onRefreshModels} disabled={refreshingModels} className="ui-accent disabled:opacity-50">{refreshingModels ? '刷新中…' : '刷新模型列表'}</button>}</span>}{agent.capability?.modelSourceWarning && <span className="mt-1 block text-xs text-[var(--app-warning)]">{agent.capability.modelSourceWarning}</span>}</label>
        {modelChoice === '__custom__' && <label className="block text-sm ui-text-soft">自定义模型标识<input value={customModel} onChange={event => setCustomModel(event.target.value)} placeholder="例如 provider/model-name" className="ui-input mt-2 w-full rounded-xl px-3 py-2.5 outline-none" /></label>}
        <label className="block text-sm ui-text-soft">默认思考强度<select value={thinkingEffort} onChange={event => setThinkingEffort(event.target.value as ThinkingEffort)} className="ui-input mt-2 w-full rounded-xl px-3 py-2.5 outline-none">{availableThinkingEfforts.map(effort => <option key={effort} value={effort}>{effortLabels[effort]}</option>)}</select>{availableThinkingEfforts.length === 1 && <span className="mt-1 block text-xs ui-muted">当前模型或 CLI 不支持可调思考强度。</span>}</label>
        <fieldset><legend className="mb-2 text-sm ui-text-soft">权限</legend><div className="flex flex-wrap gap-2">{permissionOptions.map(option => <label key={option.value} className={`cursor-pointer rounded-xl border px-3 py-2 text-xs transition ${permissions.includes(option.value) ? 'border-[var(--app-accent)] bg-[var(--app-accent-soft)] ui-text' : 'ui-border ui-muted hover:border-[var(--app-border-strong)]'}`}><input className="sr-only" type="checkbox" checked={permissions.includes(option.value)} onChange={() => togglePermission(option.value)} />{option.label}</label>)}</div></fieldset>
        <label className="ui-panel flex items-center justify-between rounded-xl border px-3 py-3 text-sm ui-text-soft"><span>启用此 Agent</span><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} className="accent-[var(--app-accent)]" /></label>
      </div>
      <div className="mt-6 flex justify-end gap-3"><button type="button" onClick={onClose} className="ui-button-secondary rounded-xl px-4 py-2 text-sm">取消</button><button disabled={saving || !roleTitle.trim() || !systemPrompt.trim() || permissions.length === 0} className="ui-button-primary rounded-xl px-4 py-2 text-sm font-medium disabled:cursor-not-allowed">{saving ? '保存中…' : '保存'}</button></div>
    </form>
  </div>;
}
