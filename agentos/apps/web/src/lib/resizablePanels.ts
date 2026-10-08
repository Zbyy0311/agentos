import { WORKSPACE_LAYOUT_THRESHOLDS } from './workspaceLayout';

export interface PanelWidthRange {
  min: number;
  max: number;
}

export interface ResizablePanelWidthInput {
  proposed: number;
  panelMin: number;
  panelMax: number;
  availableWidth: number;
  otherPanelWidth: number;
  handleWidth: number;
  chatMinWidth: number;
}

export function clampPanelWidth(value: number, range: PanelWidthRange): number {
  return Math.min(range.max, Math.max(range.min, value));
}

export function getResizablePanelWidth({ proposed, panelMin, panelMax, availableWidth, otherPanelWidth, handleWidth, chatMinWidth }: ResizablePanelWidthInput): number {
  const maxForChat = availableWidth - otherPanelWidth - handleWidth - chatMinWidth;
  const effectiveMax = Math.max(panelMin, Math.min(panelMax, maxForChat));
  return Math.min(effectiveMax, Math.max(panelMin, proposed));
}

/** Inspector drag floor: the narrowest width shown while dragging before collapse. */
export const INSPECTOR_DRAG_FLOOR = WORKSPACE_LAYOUT_THRESHOLDS.inspectorCollapse;

/** Release the inspector drag below this width and the panel collapses. */
export const INSPECTOR_COLLAPSE_THRESHOLD = WORKSPACE_LAYOUT_THRESHOLDS.inspectorCollapse;

export function shouldCollapseInspector(proposedWidth: number): boolean {
  return proposedWidth < INSPECTOR_COLLAPSE_THRESHOLD;
}

/** Inspector sits on the right edge: dragging left widens it, so the delta is inverted. */
export function getInspectorProposedWidth(startWidth: number, startX: number, clientX: number): number {
  return startWidth - (clientX - startX);
}
