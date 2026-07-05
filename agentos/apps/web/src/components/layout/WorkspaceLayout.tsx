import { ReactNode } from 'react';

interface WorkspaceLayoutProps {
  children: ReactNode;
  sidebar?: ReactNode;
  rightPanel?: ReactNode;
}

export function WorkspaceLayout({ children, sidebar, rightPanel }: WorkspaceLayoutProps) {
  return (
    <div className="flex flex-col h-screen bg-[#0f1117] text-slate-200 overflow-hidden">
      {children}
      {rightPanel}
    </div>
  );
}

export function ThreeColumnLayout({ children, sidebar, rightPanel }: WorkspaceLayoutProps) {
  return (
    <div className="flex flex-1 overflow-hidden">
      {sidebar}
      <div className="flex-1 flex flex-col overflow-hidden">{children}</div>
      {rightPanel}
    </div>
  );
}
