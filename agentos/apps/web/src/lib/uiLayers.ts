export const UI_LAYER = {
  content: 10,
  localMenu: 50,
  workspaceOverlay: 80,
  contextMenu: 85,
  runDetails: 90,
  workspaceSurface: 95,
  editor: 105,
  confirmation: 110,
  mediaPreview: 120,
  toast: 130,
} as const;

const UI_LAYER_CLASS = {
  content: 'ui-layer-content',
  localMenu: 'ui-layer-local-menu',
  workspaceOverlay: 'ui-layer-workspace-overlay',
  contextMenu: 'ui-layer-context-menu',
  runDetails: 'ui-layer-run-details',
  workspaceSurface: 'ui-layer-workspace-surface',
  editor: 'ui-layer-editor',
  confirmation: 'ui-layer-confirmation',
  mediaPreview: 'ui-layer-media-preview',
  toast: 'ui-layer-toast',
} as const satisfies Record<keyof typeof UI_LAYER, string>;

export function uiLayerClass(layer: keyof typeof UI_LAYER): string {
  return UI_LAYER_CLASS[layer];
}

export const UI_LAYER_ORDER = Object.entries(UI_LAYER).map(([name, value]) => ({ name, value }));
