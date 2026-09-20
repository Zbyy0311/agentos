import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GLASS_SURFACE_SPECS, glassOptionsFor, type GlassSurfaceKind } from './glass.js';

test('GLASS-01 every surface kind has both theme specs', () => {
  const kinds: GlassSurfaceKind[] = ['composer', 'chat-header', 'page-header', 'modal', 'toast'];
  for (const kind of kinds) {
    assert.ok(GLASS_SURFACE_SPECS[kind].dark, kind + ' dark spec');
    assert.ok(GLASS_SURFACE_SPECS[kind].light, kind + ' light spec');
  }
});

test('GLASS-02 tintTone follows the theme and material carries refraction', () => {
  const dark = glassOptionsFor('composer', 'dark');
  assert.equal(dark.tintTone, 'dark');
  assert.equal(dark.tint, GLASS_SURFACE_SPECS.composer.dark.tint);
  assert.equal(dark.frost, GLASS_SURFACE_SPECS.composer.dark.frost);
  assert.equal(dark.material?.refraction, GLASS_SURFACE_SPECS.composer.dark.refraction);
  const light = glassOptionsFor('composer', 'light');
  assert.equal(light.tintTone, 'light');
});

test('GLASS-03 dpr is capped and extras merge through', () => {
  const options = glassOptionsFor('toast', 'dark', { targets: '.toast-item' });
  assert.equal(options.maxDpr, 2);
  assert.equal(options.targets, '.toast-item');
  assert.equal(options.fallback, 'css');
  assert.equal(options.live, 'auto');
  assert.equal(options.respectReducedTransparency, true);
  assert.equal(options.zIndex, -1);
});
