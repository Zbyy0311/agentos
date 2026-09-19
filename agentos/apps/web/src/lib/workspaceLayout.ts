export type WorkspaceLayoutPanel = 'workspace' | 'history' | 'inspector';
export type WorkspaceRailMode = 'full' | 'compact';

export interface WorkspaceLayoutPreferences {
  readonly version: 2;
  readonly workspaceMode: WorkspaceRailMode;
  readonly workspaceWidth: number;
  readonly historyOpen: boolean;
  readonly historyWidth: number;
  readonly inspectorOpen: boolean;
  readonly inspectorWidth: number;
  readonly focusMode: boolean;
  readonly focusRestore?: Omit<WorkspaceLayoutPreferences, 'focusMode' | 'focusRestore'>;
}

export interface EffectiveWorkspaceLayout {
  readonly workspaceMode: WorkspaceRailMode;
  readonly historyVisible: boolean;
  readonly inspectorVisible: boolean;
  readonly workspaceWidth: number;
  readonly historyWidth: number;
  readonly inspectorWidth: number;
  readonly chatWidth: number;
  readonly handleCount: number;
}

export const WORKSPACE_LAYOUT_STORAGE_VERSION = 2 as const;
export const WORKSPACE_LAYOUT_STORAGE_PREFIX = 'agentos:workspace-layout';

export const WORKSPACE_LAYOUT_WIDTHS = Object.freeze({
  workspace: Object.freeze({ min: 180, max: 300, default: 200 }),
  history: Object.freeze({ min: 180, max: 320, default: 220 }),
  inspector: Object.freeze({ min: 240, max: 400, default: 280 }),
  compactRail: 64,
  handle: 8,
} as const);

export const WORKSPACE_LAYOUT_THRESHOLDS = Object.freeze({
  workspaceCompact: 140,
  historyCollapse: 140,
  inspectorCollapse: 200,
  desktopChatMinimum: 640,
  compactViewport: 712,
} as const);

const DEFAULT_LAYOUT: WorkspaceLayoutPreferences = Object.freeze({
  version: WORKSPACE_LAYOUT_STORAGE_VERSION,
  workspaceMode: 'full',
  workspaceWidth: WORKSPACE_LAYOUT_WIDTHS.workspace.default,
  historyOpen: true,
  historyWidth: WORKSPACE_LAYOUT_WIDTHS.history.default,
  inspectorOpen: true,
  inspectorWidth: WORKSPACE_LAYOUT_WIDTHS.inspector.default,
  focusMode: false,
});

export const DEFAULT_WORKSPACE_LAYOUT = DEFAULT_LAYOUT;

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function modeValue(value: unknown, fallback: WorkspaceRailMode): WorkspaceRailMode {
  return value === 'compact' || value === 'full' ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeRestoredLayout(value: unknown): Omit<WorkspaceLayoutPreferences, 'focusMode' | 'focusRestore'> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Record<string, unknown>;
  return {
    version: WORKSPACE_LAYOUT_STORAGE_VERSION,
    workspaceMode: modeValue(input.workspaceMode, DEFAULT_LAYOUT.workspaceMode),
    workspaceWidth: clamp(finiteNumber(input.workspaceWidth, DEFAULT_LAYOUT.workspaceWidth), WORKSPACE_LAYOUT_WIDTHS.workspace.min, WORKSPACE_LAYOUT_WIDTHS.workspace.max),
    historyOpen: booleanValue(input.historyOpen, DEFAULT_LAYOUT.historyOpen),
    historyWidth: clamp(finiteNumber(input.historyWidth, DEFAULT_LAYOUT.historyWidth), WORKSPACE_LAYOUT_WIDTHS.history.min, WORKSPACE_LAYOUT_WIDTHS.history.max),
    inspectorOpen: booleanValue(input.inspectorOpen, DEFAULT_LAYOUT.inspectorOpen),
    inspectorWidth: clamp(finiteNumber(input.inspectorWidth, DEFAULT_LAYOUT.inspectorWidth), WORKSPACE_LAYOUT_WIDTHS.inspector.min, WORKSPACE_LAYOUT_WIDTHS.inspector.max),
  };
}

/** Normalize persisted UI state without allowing malformed values into layout math. */
export function normalizeWorkspaceLayout(value: unknown): WorkspaceLayoutPreferences {
  if (!value || typeof value !== 'object') return DEFAULT_LAYOUT;
  const input = value as Record<string, unknown>;
  const restored = normalizeRestoredLayout(input.focusRestore);
  return {
    version: WORKSPACE_LAYOUT_STORAGE_VERSION,
    workspaceMode: modeValue(input.workspaceMode, DEFAULT_LAYOUT.workspaceMode),
    workspaceWidth: clamp(finiteNumber(input.workspaceWidth, DEFAULT_LAYOUT.workspaceWidth), WORKSPACE_LAYOUT_WIDTHS.workspace.min, WORKSPACE_LAYOUT_WIDTHS.workspace.max),
    historyOpen: booleanValue(input.historyOpen, DEFAULT_LAYOUT.historyOpen),
    historyWidth: clamp(finiteNumber(input.historyWidth, DEFAULT_LAYOUT.historyWidth), WORKSPACE_LAYOUT_WIDTHS.history.min, WORKSPACE_LAYOUT_WIDTHS.history.max),
    inspectorOpen: booleanValue(input.inspectorOpen, DEFAULT_LAYOUT.inspectorOpen),
    inspectorWidth: clamp(finiteNumber(input.inspectorWidth, DEFAULT_LAYOUT.inspectorWidth), WORKSPACE_LAYOUT_WIDTHS.inspector.min, WORKSPACE_LAYOUT_WIDTHS.inspector.max),
    focusMode: booleanValue(input.focusMode, DEFAULT_LAYOUT.focusMode),
    ...(restored ? { focusRestore: restored } : {}),
  };
}

export function workspaceLayoutStorageKey(workspaceId: string): string {
  return `${WORKSPACE_LAYOUT_STORAGE_PREFIX}:v${WORKSPACE_LAYOUT_STORAGE_VERSION}:${workspaceId}`;
}

function chatWidthFor(input: {
  viewportWidth: number;
  workspaceMode: WorkspaceRailMode;
  workspaceWidth: number;
  historyVisible: boolean;
  historyWidth: number;
  inspectorVisible: boolean;
  inspectorWidth: number;
}): number {
  const widths = [
    input.workspaceMode === 'compact' ? WORKSPACE_LAYOUT_WIDTHS.compactRail : input.workspaceWidth,
    input.historyVisible ? input.historyWidth : 0,
    input.inspectorVisible ? input.inspectorWidth : 0,
  ];
  const panelCount = 1 + Number(input.historyVisible) + Number(input.inspectorVisible);
  return Math.max(0, input.viewportWidth - widths.reduce((sum, width) => sum + width, 0) - panelCount * WORKSPACE_LAYOUT_WIDTHS.handle);
}

/**
 * Resolve the docked layout from user preferences and the available shell width.
 * Temporary width pressure only suppresses panels for this render; preferences
 * stay intact so the panels can return when the window grows again.
 */
export function resolveEffectiveWorkspaceLayout(input: {
  viewportWidth: number;
  preferences: WorkspaceLayoutPreferences;
  historyAvailable: boolean;
}): EffectiveWorkspaceLayout {
  const viewportWidth = Math.max(0, Number.isFinite(input.viewportWidth) ? input.viewportWidth : 0);
  const preferences = normalizeWorkspaceLayout(input.preferences);
  let workspaceMode: WorkspaceRailMode = preferences.workspaceMode;
  let historyVisible = input.historyAvailable && preferences.historyOpen;
  let inspectorVisible = preferences.inspectorOpen;

  if (preferences.focusMode || viewportWidth < WORKSPACE_LAYOUT_THRESHOLDS.compactViewport) {
    workspaceMode = 'compact';
    historyVisible = false;
    inspectorVisible = false;
  } else {
    const canFitDesktopChat = () => chatWidthFor({
      viewportWidth,
      workspaceMode,
      workspaceWidth: preferences.workspaceWidth,
      historyVisible,
      historyWidth: preferences.historyWidth,
      inspectorVisible,
      inspectorWidth: preferences.inspectorWidth,
    }) >= WORKSPACE_LAYOUT_THRESHOLDS.desktopChatMinimum;

    if (!canFitDesktopChat() && inspectorVisible) inspectorVisible = false;
    if (!canFitDesktopChat() && historyVisible) historyVisible = false;
    if (!canFitDesktopChat()) workspaceMode = 'compact';
  }

  const chatWidth = chatWidthFor({
    viewportWidth,
    workspaceMode,
    workspaceWidth: preferences.workspaceWidth,
    historyVisible,
    historyWidth: preferences.historyWidth,
    inspectorVisible,
    inspectorWidth: preferences.inspectorWidth,
  });
  const handleCount = Number(historyVisible) + Number(inspectorVisible) + 1;

  return {
    workspaceMode,
    historyVisible,
    inspectorVisible,
    workspaceWidth: workspaceMode === 'compact' ? WORKSPACE_LAYOUT_WIDTHS.compactRail : preferences.workspaceWidth,
    historyWidth: preferences.historyWidth,
    inspectorWidth: preferences.inspectorWidth,
    chatWidth,
    handleCount,
  };
}

export function panelIsDocked(layout: EffectiveWorkspaceLayout, panel: WorkspaceLayoutPanel): boolean {
  if (panel === 'workspace') return layout.workspaceMode === 'full';
  if (panel === 'history') return layout.historyVisible;
  return layout.inspectorVisible;
}

export function panelCollapseThreshold(panel: WorkspaceLayoutPanel): number {
  if (panel === 'workspace') return WORKSPACE_LAYOUT_THRESHOLDS.workspaceCompact;
  if (panel === 'history') return WORKSPACE_LAYOUT_THRESHOLDS.historyCollapse;
  return WORKSPACE_LAYOUT_THRESHOLDS.inspectorCollapse;
}

export function panelWidthRange(panel: WorkspaceLayoutPanel): { min: number; max: number } {
  if (panel === 'workspace') return WORKSPACE_LAYOUT_WIDTHS.workspace;
  if (panel === 'history') return WORKSPACE_LAYOUT_WIDTHS.history;
  return WORKSPACE_LAYOUT_WIDTHS.inspector;
}
