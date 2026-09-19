import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UI_LAYER, uiLayerClass } from './uiLayers.js';

test('UI layers keep overlays, context menus, dialogs, previews, and toasts in a stable order', () => {
  assert.ok(UI_LAYER.localMenu < UI_LAYER.workspaceOverlay);
  assert.ok(UI_LAYER.workspaceOverlay < UI_LAYER.contextMenu);
  assert.ok(UI_LAYER.contextMenu < UI_LAYER.runDetails);
  assert.ok(UI_LAYER.runDetails < UI_LAYER.workspaceSurface);
  assert.ok(UI_LAYER.workspaceSurface < UI_LAYER.editor);
  assert.ok(UI_LAYER.editor < UI_LAYER.confirmation);
  assert.ok(UI_LAYER.confirmation < UI_LAYER.mediaPreview);
  assert.ok(UI_LAYER.mediaPreview < UI_LAYER.toast);
  assert.equal(uiLayerClass('editor'), 'ui-layer-editor');
  assert.equal(uiLayerClass('toast'), 'ui-layer-toast');
});
