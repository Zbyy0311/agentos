import assert from 'node:assert/strict';
import test from 'node:test';
import {
  UI_BODY_CONTRAST_MIN,
  UI_COLUMNS,
  UI_COLOR_TOKENS,
  UI_COLUMN_WIDTHS,
  UI_FOCUS_RULES,
  UI_FONT_STACK,
  UI_LAYOUT_BREAKPOINTS,
  UI_RADIUS_TOKENS,
  UI_SPACING_BASE_PX,
  UI_STATUS_REQUIRES,
  UI_STATUS_TOKENS,
  UI_THEMES,
  UI_TYPE_SCALE,
  canvasWidthFor,
  contrastRatio,
  findContrastViolations,
  relativeLuminance,
  resolveLayoutMode,
  resolveMotionDuration,
  shouldAnimateTransform,
  spacingPx,
  uiCssVariables,
  columnWidthPx,
  visibleColumns,
} from './uiFoundation.js';

// UIF-01 — both themes define the same semantic token names.
test('UIF-01 both themes share semantic token names', () => {
  const darkKeys = Object.keys(UI_COLOR_TOKENS.dark).sort();
  const lightKeys = Object.keys(UI_COLOR_TOKENS.light).sort();
  assert.deepEqual(darkKeys, lightKeys);
  assert.deepEqual(Object.keys(UI_COLOR_TOKENS.dark.status).sort(), [...UI_STATUS_TOKENS].sort());
});

// UIF-02 — every color token is a valid opaque hex.
test('UIF-02 color tokens are valid hex', () => {
  for (const theme of UI_THEMES) {
    const tokens = UI_COLOR_TOKENS[theme] as unknown as Record<string, unknown>;
    for (const [name, value] of Object.entries(tokens)) {
      if (name === 'status') continue;
      assert.match(value as string, /^#[0-9a-f]{6}$/i, `${theme}.${name}`);
    }
    for (const [name, value] of Object.entries(UI_COLOR_TOKENS[theme].status)) {
      assert.match(value, /^#[0-9a-f]{6}$/i, `${theme}.status.${name}`);
    }
  }
});

// UIF-03 — body text meets the 4.5:1 contrast target in both themes.
test('UIF-03 body contrast meets 4.5:1 in both themes', () => {
  for (const theme of UI_THEMES) {
    assert.deepEqual(findContrastViolations(theme), [], theme);
  }
  assert.equal(UI_BODY_CONTRAST_MIN, 4.5);
});

// UIF-04 — contrast math is order-independent and symmetric.
test('UIF-04 contrast math', () => {
  assert.equal(contrastRatio('#ffffff', '#000000'), 21);
  assert.equal(contrastRatio('#000000', '#ffffff'), 21);
  assert.equal(contrastRatio('#777777', '#777777'), 1);
  assert.equal(relativeLuminance('#000000'), 0);
  assert.equal(relativeLuminance('#ffffff'), 1);
  assert.throws(() => relativeLuminance('not-a-color'), /UI_TOKEN_INVALID_COLOR/);
  assert.throws(() => relativeLuminance('#fff'), /UI_TOKEN_INVALID_COLOR/);
  assert.throws(() => relativeLuminance('#gggggg'), /UI_TOKEN_INVALID_COLOR/);
});

// UIF-05 — typography scale and font stacks.
test('UIF-05 typography scale and stacks', () => {
  assert.deepEqual(Object.keys(UI_TYPE_SCALE), ['display', 'title', 'heading', 'body', 'dense', 'caption', 'micro', 'code']);
  assert.ok(UI_TYPE_SCALE.display.sizePx > UI_TYPE_SCALE.body.sizePx);
  assert.ok(UI_FONT_STACK.ui.includes('Segoe UI'));
  assert.ok(UI_FONT_STACK.code.includes('Cascadia Code'));
  assert.ok(UI_FONT_STACK.code.includes('monospace'));
});

// UIF-06 — spacing uses a 4 px base and rejects out-of-range steps.
test('UIF-06 spacing scale', () => {
  assert.equal(UI_SPACING_BASE_PX, 4);
  assert.equal(spacingPx(0), 0);
  assert.equal(spacingPx(4), 16);
  assert.equal(spacingPx(12), 48);
  assert.throws(() => spacingPx(-1), /UI_SPACING_STEP_INVALID/);
  assert.throws(() => spacingPx(13), /UI_SPACING_STEP_INVALID/);
  assert.throws(() => spacingPx(1.5), /UI_SPACING_STEP_INVALID/);
});

// UIF-07 — radii stay bounded and ordered.
test('UIF-07 radius tokens', () => {
  assert.deepEqual(Object.keys(UI_RADIUS_TOKENS), ['input', 'row', 'card', 'panel', 'overlay']);
  const values = Object.values(UI_RADIUS_TOKENS);
  assert.deepEqual(values, [...values].sort((a, b) => a - b));
  assert.ok(Math.max(...values) <= 16);
});

// UIF-08 — four columns with the spec's width guidance.
test('UIF-08 four-column width guidance', () => {
  assert.deepEqual([...UI_COLUMNS], ['agents', 'conversations', 'canvas', 'inspector']);
  assert.deepEqual(UI_COLUMN_WIDTHS.agents, { min: 220, max: 300 });
  assert.deepEqual(UI_COLUMN_WIDTHS.conversations, { min: 240, max: 320 });
  assert.equal(UI_COLUMN_WIDTHS.canvas.min, 560);
  assert.deepEqual(UI_COLUMN_WIDTHS.inspector, { min: 300, max: 400 });
});

// UIF-09 — adaptive mode selection.
test('UIF-09 adaptive layout modes', () => {
  assert.equal(resolveLayoutMode(UI_LAYOUT_BREAKPOINTS.wide), 'wide');
  assert.equal(resolveLayoutMode(UI_LAYOUT_BREAKPOINTS.wide - 1), 'standard');
  assert.equal(resolveLayoutMode(UI_LAYOUT_BREAKPOINTS.standard), 'standard');
  assert.equal(resolveLayoutMode(UI_LAYOUT_BREAKPOINTS.standard - 1), 'compact');
  assert.equal(resolveLayoutMode(0), 'compact');
  assert.throws(() => resolveLayoutMode(Number.NaN), /UI_VIEWPORT_INVALID/);
  assert.throws(() => resolveLayoutMode(-1), /UI_VIEWPORT_INVALID/);
});

// UIF-10 — visible columns per mode always include the Canvas.
test('UIF-10 visible columns include canvas', () => {
  assert.deepEqual([...visibleColumns('wide')], ['agents', 'conversations', 'canvas', 'inspector']);
  assert.deepEqual([...visibleColumns('standard')], ['agents', 'conversations', 'canvas']);
  assert.deepEqual([...visibleColumns('compact')], ['agents', 'canvas']);
  for (const mode of ['wide', 'standard', 'compact'] as const) {
    assert.ok(visibleColumns(mode).includes('canvas'), mode);
  }
});

// UIF-11 — the Canvas is never squeezed below its minimum.
test('UIF-11 canvas keeps its minimum width', () => {
  assert.equal(canvasWidthFor(2000), 2000 - (220 + 240 + 300));
  assert.equal(canvasWidthFor(1200), 1200 - (220 + 240));
  // At 700 the compact layout leaves 480 for the Canvas, which is below its
  // floor, so the Canvas reports its minimum instead of being squeezed.
  assert.equal(canvasWidthFor(700), UI_COLUMN_WIDTHS.canvas.min);
  assert.equal(canvasWidthFor(600), UI_COLUMN_WIDTHS.canvas.min);
});

// UIF-12 — reduced motion collapses movement but keeps crossfade.
test('UIF-12 reduced motion', () => {
  assert.equal(resolveMotionDuration('panel', false), 240);
  assert.equal(resolveMotionDuration('panel', true), 0);
  assert.equal(resolveMotionDuration('micro', true), 0);
  assert.equal(resolveMotionDuration('press', true), 0);
  assert.equal(resolveMotionDuration('crossfade', true), 180);
  assert.equal(shouldAnimateTransform(false), true);
  assert.equal(shouldAnimateTransform(true), false);
});

// UIF-13 — status is never color-only and focus stays visible.
test('UIF-13 accessibility rules', () => {
  assert.equal(UI_STATUS_REQUIRES.colorOnly, false);
  assert.equal(UI_STATUS_REQUIRES.icon, true);
  assert.equal(UI_STATUS_REQUIRES.text, true);
  assert.equal(UI_STATUS_REQUIRES.accessibleName, true);
  assert.equal(UI_FOCUS_RULES.visibleRing, true);
  assert.equal(UI_FOCUS_RULES.logicalOrder, true);
  assert.equal(UI_FOCUS_RULES.restoreAfterClose, true);
  assert.equal(UI_FOCUS_RULES.streamStealsFocus, false);
  assert.equal(UI_FOCUS_RULES.modalTrapOnlyForBlocking, true);
});

// UIF-14 — the CSS-variable bridge flattens every semantic token without omission.
test('UIF-14 uiCssVariables flattens all semantic tokens', () => {
  const dark = uiCssVariables('dark');
  assert.equal(dark['--surface-base'], UI_COLOR_TOKENS.dark.surfaceBase);
  assert.equal(dark['--text-primary'], UI_COLOR_TOKENS.dark.textPrimary);
  assert.equal(dark['--focus-ring'], UI_COLOR_TOKENS.dark.focusRing);
  assert.equal(dark['--accent-default'], UI_COLOR_TOKENS.dark.accentDefault);
  for (const status of UI_STATUS_TOKENS) {
    assert.equal(dark[`--status-${status}`], UI_COLOR_TOKENS.dark.status[status]);
  }
  assert.equal(dark['--status-running'], UI_COLOR_TOKENS.dark.status.running);
  // both themes produce the same key set
  assert.deepEqual(Object.keys(uiCssVariables('light')).sort(), Object.keys(dark).sort());
});

// UIF-15 — column widths clamp to guidance and report 0 for a hidden column.
test('UIF-15 columnWidthPx follows guidance and visibility', () => {
  assert.equal(columnWidthPx('agents', 'wide'), UI_COLUMN_WIDTHS.agents.min);
  assert.equal(columnWidthPx('conversations', 'wide'), UI_COLUMN_WIDTHS.conversations.min);
  assert.equal(columnWidthPx('inspector', 'wide'), UI_COLUMN_WIDTHS.inspector.min);
  assert.equal(columnWidthPx('canvas', 'wide'), UI_COLUMN_WIDTHS.canvas.min);
  // standard collapses the Inspector
  assert.equal(columnWidthPx('inspector', 'standard'), 0);
  // compact collapses Conversations and Inspector
  assert.equal(columnWidthPx('conversations', 'compact'), 0);
  assert.equal(columnWidthPx('inspector', 'compact'), 0);
  assert.equal(columnWidthPx('canvas', 'compact'), UI_COLUMN_WIDTHS.canvas.min);
  assert.throws(() => columnWidthPx('bogus' as never, 'wide'), /UI_COLUMN_INVALID/);
});
