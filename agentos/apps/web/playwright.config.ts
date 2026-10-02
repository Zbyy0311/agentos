import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const e2eProjectRoot = mkdtempSync(join(tmpdir(), 'agentos-playwright-project-'));
process.once('exit', () => {
  try {
    rmSync(e2eProjectRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch { /* best-effort cleanup after the test server exits */ }
});

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:3201', channel: 'chrome', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: [
    { command: 'pnpm.cmd --filter @agentos/server dev:stable', port: 3200, reuseExistingServer: true, env: { PORT: '3200', AGENTOS_SERVER_HOST: '127.0.0.1', AGENTOS_PROJECT_ROOT: e2eProjectRoot } },
    { command: 'pnpm.cmd --filter @agentos/web exec next dev -p 3201', port: 3201, reuseExistingServer: true },
  ],
  projects: [
    { name: 'desktop-1280', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 720 } } },
    { name: 'mobile-440', use: { ...devices['Desktop Chrome'], viewport: { width: 440, height: 900 } } },
    { name: 'desktop-920', use: { ...devices['Desktop Chrome'], viewport: { width: 920, height: 1080 } } },
  ],
});
