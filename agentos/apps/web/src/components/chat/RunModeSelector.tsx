import type { RunIntent } from '@agentos/shared';
import { Picker } from './Picker';

interface RunModeSelectorProps {
  value: RunIntent;
  disabled: boolean;
  onChange(value: RunIntent): void;
}

const labels: Record<RunIntent, string> = { ask: '询问', execute: '执行', review: '审查' };

const descriptions: Record<RunIntent, string> = {
  ask: '只读回答，不修改文件',
  execute: '执行任务，可写入工作区',
  review: '只读审查，给出结论与建议',
};

export function RunModeSelector({ value, disabled, onChange }: RunModeSelectorProps) {
  const options = (Object.keys(labels) as RunIntent[]).map(intent => ({ value: intent, label: labels[intent], detail: descriptions[intent] }));
  return <Picker label="模式" ariaLabel="运行模式" value={value} displayValue={labels[value]} options={options} disabled={disabled} widthClass="max-w-[8rem]" menuWidthClass="w-56" onChange={next => onChange(next as RunIntent)} />;
}
