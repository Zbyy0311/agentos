import { Bot } from 'lucide-react';

export default function Header() {
  return (
    <header className="bg-slate-900 text-white px-6 py-4 flex items-center gap-3 shadow">
      <Bot className="w-7 h-7 text-indigo-400" />
      <div>
        <h1 className="text-lg font-bold">Multi-Agent 协作系统 v1.0</h1>
        <p className="text-xs text-slate-400">总指挥 Codex · 实时协同 · 可视化工作区</p>
      </div>
    </header>
  );
}
