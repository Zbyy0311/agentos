import { defineConfig, devices } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The owner starts an isolated Web instance. This config never starts API/Web
// and every API request in the Phase E fixture is intercepted by the test.
const baseURL = process.env.AGENTOS_PHASE_E_WEB_URL;
if (!baseURL) throw new Error('Set AGENTOS_PHASE_E_WEB_URL to the owner-started isolated Web URL; no default business instance is allowed.');

export default defineConfig({
  testDir: './e2e', testMatch: ['workspace-identity.spec.ts', 'collaboration-workbench.spec.ts'], workers: 1,
  timeout: 45_000,
  outputDir: process.env.AGENTOS_PHASE_E_OUTPUT_DIR || join(tmpdir(), 'agentos-phase-e-playwright'),
  use: { baseURL, channel: 'chrome', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'phase-e-desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
});
