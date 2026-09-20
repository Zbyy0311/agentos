import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_WORKSPACE_LAYOUT,
  WORKSPACE_LAYOUT_THRESHOLDS,
  normalizeWorkspaceLayout,
  panelCollapseThreshold,
  resolveEffectiveWorkspaceLayout,
  workspaceLayoutStorageKey,
} from './workspaceLayout.ts';

test('keeps all four docked panels when the canvas has the desktop minimum', () => {
  const layout = resolveEffectiveWorkspaceLayout({
    viewportWidth: 1364,
    preferences: DEFAULT_WORKSPACE_LAYOUT,
    historyAvailable: true,
  });

  assert.equal(layout.workspaceMode, 'full');
  assert.equal(layout.historyVisible, true);
  assert.equal(layout.inspectorVisible, true);
  assert.equal(layout.chatWidth, WORKSPACE_LAYOUT_THRESHOLDS.desktopChatMinimum);
});

test('drops the Inspector before the conversation list when space is tight', () => {
  const layout = resolveEffectiveWorkspaceLayout({
    viewportWidth: 1260,
    preferences: DEFAULT_WORKSPACE_LAYOUT,
    historyAvailable: true,
  });

  assert.equal(layout.historyVisible, true);
  assert.equal(layout.inspectorVisible, false);
  assert.equal(layout.chatWidth, 824);
});

test('drops the conversation list before compacting the Agent rail', () => {
  const layout = resolveEffectiveWorkspaceLayout({
    viewportWidth: 1014,
    preferences: DEFAULT_WORKSPACE_LAYOUT,
    historyAvailable: true,
  });

  assert.equal(layout.workspaceMode, 'full');
  assert.equal(layout.historyVisible, false);
  assert.equal(layout.inspectorVisible, false);
  assert.equal(layout.chatWidth, 806);
});

test('keeps only the icon rail on compact viewports', () => {
  const layout = resolveEffectiveWorkspaceLayout({
    viewportWidth: 617,
    preferences: DEFAULT_WORKSPACE_LAYOUT,
    historyAvailable: true,
  });

  assert.equal(layout.workspaceMode, 'compact');
  assert.equal(layout.historyVisible, false);
  assert.equal(layout.inspectorVisible, false);
  assert.equal(layout.chatWidth, 545);
});

test('preserves independent user choices while resolving temporary width pressure', () => {
  const preferences = {
    ...DEFAULT_WORKSPACE_LAYOUT,
    workspaceMode: 'compact' as const,
    historyOpen: false,
    inspectorOpen: true,
  };
  const layout = resolveEffectiveWorkspaceLayout({ viewportWidth: 1260, preferences, historyAvailable: true });

  assert.equal(layout.workspaceMode, 'compact');
  assert.equal(layout.historyVisible, false);
  assert.equal(layout.inspectorVisible, true);
  assert.equal(layout.chatWidth, 900);
});

test('group layouts do not consume a conversation column but keep its preference', () => {
  const layout = resolveEffectiveWorkspaceLayout({ viewportWidth: 1440, preferences: DEFAULT_WORKSPACE_LAYOUT, historyAvailable: false });
  assert.equal(layout.historyVisible, false);
  assert.equal(layout.inspectorVisible, true);
  assert.equal(layout.chatWidth, 944);
});

test('normalizes malformed local layout state and keeps the storage key versioned', () => {
  const normalized = normalizeWorkspaceLayout({ version: 2, workspaceWidth: 9999, historyOpen: 'yes', inspectorWidth: 1, focusMode: true });
  assert.equal(normalized.workspaceWidth, 300);
  assert.equal(normalized.historyOpen, true);
  assert.equal(normalized.inspectorWidth, 240);
  assert.equal(normalized.focusMode, false);
  assert.equal(workspaceLayoutStorageKey('ws/a'), 'agentos:workspace-layout:v2:ws/a');
});

test('rejects stale versions and malformed focus snapshots without trapping the layout', () => {
  assert.deepEqual(normalizeWorkspaceLayout({ version: 1, workspaceMode: 'compact' }), DEFAULT_WORKSPACE_LAYOUT);
  assert.equal(normalizeWorkspaceLayout({ version: 2, focusMode: true, focusRestore: 'broken' }).focusMode, false);
  assert.equal(normalizeWorkspaceLayout({ version: 2, focusMode: true, focusRestore: { workspaceWidth: 220 } }).focusMode, true);
});

test('uses independent collapse thresholds for the three user-controlled panels', () => {
  assert.equal(panelCollapseThreshold('workspace'), 140);
  assert.equal(panelCollapseThreshold('history'), 140);
  assert.equal(panelCollapseThreshold('inspector'), 200);
});
