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
