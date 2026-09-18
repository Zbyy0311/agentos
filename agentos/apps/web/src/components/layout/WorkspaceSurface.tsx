'use client';

import type { ReactNode } from 'react';
import { WorkbenchShell } from './WorkbenchShell';
import type { UiTheme } from '@/lib/uiFoundation';
import type { UiColumn } from '@/lib/uiFoundation';

/** Shared UI contract used by both the branded workspace and forward runtime. */
export interface WorkspaceSurfaceModel {
  readonly theme: UiTheme;
  readonly viewportWidth: number;
  readonly agents: ReactNode;
  readonly conversations: ReactNode;
  readonly canvas: ReactNode;
  readonly inspector: ReactNode;
  readonly toolbar?: ReactNode;
  readonly reducedMotion?: boolean;
}

export interface WorkspaceSurfaceActions {
  readonly onToggleColumn?: (column: UiColumn) => void;
}

export interface WorkspaceSurfaceProps {
  readonly model: WorkspaceSurfaceModel;
  readonly actions?: WorkspaceSurfaceActions;
}

/**
 * One visual shell for every runtime data adapter. The adapters remain free to
 * use different clients; layout, theme tokens, drawers and landmarks do not.
 */
export function WorkspaceSurface({ model, actions }: WorkspaceSurfaceProps) {
  return (
    <div data-agentos="workspace-surface" className="workspace-surface min-w-0 h-full">
      <WorkbenchShell
        theme={model.theme}
        viewportWidth={model.viewportWidth}
        {...(model.reducedMotion === undefined ? {} : { reducedMotion: model.reducedMotion })}
        {...(model.toolbar === undefined ? {} : { toolbar: model.toolbar })}
        {...(actions?.onToggleColumn === undefined ? {} : { onToggleColumn: actions.onToggleColumn })}
        agents={model.agents}
        conversations={model.conversations}
        canvas={model.canvas}
        inspector={model.inspector}
      />
    </div>
  );
}
