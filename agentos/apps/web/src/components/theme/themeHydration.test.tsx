import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { ThemeProvider } from './ThemeProvider';
import { ThemeToggle } from './ThemeToggle';

test('keeps the server-rendered theme toggle stable before browser hydration', () => {
  const globalWithReact = globalThis as typeof globalThis & { React?: typeof React };
  const previousReact = globalWithReact.React;
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, 'React', { configurable: true, value: React });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage: { getItem: () => 'light' } },
  });

  try {
    const html = renderToString(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );

    assert.match(html, /☼/);
    assert.doesNotMatch(html, /◐/);
  } finally {
    Object.defineProperty(globalThis, 'React', {
      configurable: true,
      value: previousReact,
    });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: previousWindow,
    });
  }
});
