import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const serverPort = process.env.P2_RECOVERY_SERVER_PORT ?? '3240';
const webPort = process.env.P2_RECOVERY_WEB_PORT ?? '3241';
const serverBaseURL = `http://127.0.0.1:${serverPort}`;
const projectRoot = mkdtempSync(join(tmpdir(), 'agentos-p2-recovery-project-'));
const resultsRoot = mkdtempSync(join(tmpdir(), 'agentos-p2-group-recovery-results-'));
process.once('exit', () => {
  try { rmSync(projectRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* best effort */ }
});

export default defineConfig({
  testDir: './e2e',
  testMatch: 'p2-group-recovery.spec.ts',
  outputDir: resultsRoot,
  timeout: 45_000,
  retries: 0,
  workers: 1,
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${webPort}`,
    channel: 'chrome',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'pnpm.cmd --filter @agentos/server dev:stable',
      url: `${serverBaseURL}/api/health`,
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        PORT: serverPort,
        AGENTOS_SERVER_HOST: '127.0.0.1',
        AGENTOS_PROJECT_ROOT: projectRoot,
      },
    },
    {
      command: `pnpm.cmd --filter @agentos/web exec next dev -p ${webPort}`,
      url: `http://127.0.0.1:${webPort}`,
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        AGENTOS_NEXT_DIST_DIR: '.next-p2-group-recovery-e2e',
        NEXT_PUBLIC_API_URL: serverBaseURL,
      },
    },
  ],
  projects: [{ name: 'p2-recovery-desktop', use: { viewport: { width: 1280, height: 800 } } }],
});
