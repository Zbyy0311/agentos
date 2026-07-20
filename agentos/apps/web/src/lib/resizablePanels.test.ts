import test from 'node:test';
import assert from 'node:assert/strict';
import { clampPanelWidth, getResizablePanelWidth } from './resizablePanels.ts';

test('clamps a panel width to its configured range', () => {
  assert.equal(clampPanelWidth(120, { min: 180, max: 360 }), 180);
  assert.equal(clampPanelWidth(500, { min: 180, max: 360 }), 360);
});

test('keeps the chat area above its minimum while resizing', () => {
  assert.equal(getResizablePanelWidth({ proposed: 420, panelMin: 180, panelMax: 420, availableWidth: 1016, otherPanelWidth: 256, handleWidth: 8, chatMinWidth: 420 }), 332);
});

test('keeps an in-range width unchanged', () => {
  assert.equal(getResizablePanelWidth({ proposed: 280, panelMin: 180, panelMax: 360, availableWidth: 980, otherPanelWidth: 256, handleWidth: 8, chatMinWidth: 420 }), 280);
});
