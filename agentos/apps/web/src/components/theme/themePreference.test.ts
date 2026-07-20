import test from 'node:test';
import assert from 'node:assert/strict';
import { readStoredTheme } from './themePreference';

test('reads the saved theme before the first render', () => {
  assert.equal(readStoredTheme({ getItem: () => 'light' }), 'light');
  assert.equal(readStoredTheme({ getItem: () => 'dark' }), 'dark');
});

test('falls back to dark when no valid preference is saved', () => {
  assert.equal(readStoredTheme({ getItem: () => null }), 'dark');
  assert.equal(readStoredTheme({ getItem: () => 'blue' }), 'dark');
});
