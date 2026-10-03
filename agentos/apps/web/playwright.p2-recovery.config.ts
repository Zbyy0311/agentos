import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverPort = process.env.P2_RECOVERY_SERVER_PORT ?? '3240';
const webPort = process.env.P2_RECOVERY_WEB_PORT ?? '3241';
const serverBaseURL = `http://127.0.0.1:${serverPort}`;
const webRoot = dirname(fileURLToPath(import.meta.url));
const nextConfigPath = resolve(webRoot, 'tsconfig.json');
const nextDistDir = process.env.P2_RECOVERY_NEXT_DIST_DIR ?? '.next-p2-group-recovery-e2e';
const nextDistPath = resolve(webRoot, nextDistDir);
const relativeNextDistPath = relative(webRoot, nextDistPath);
if (isAbsolute(nextDistDir) || relativeNextDistPath === '..' || relativeNextDistPath.startsWith(`..${sep}`)) {
  throw new Error('P2 recovery Next dist must stay inside the Web workspace.');
}
const projectRoot = mkdtempSync(join(tmpdir(), 'agentos-p2-recovery-project-'));
const resultsRoot = mkdtempSync(join(tmpdir(), 'agentos-p2-group-recovery-results-'));
const tsconfigRootPrefix = 'agentos-p2-group-recovery-tsconfig-';
const tsconfigRoot = mkdtempSync(join(tmpdir(), tsconfigRootPrefix));
const tempTsconfigPath = resolve(tsconfigRoot, 'tsconfig.json');
writeFileSync(tempTsconfigPath, JSON.stringify({
  extends: nextConfigPath,
  include: [
    resolve(webRoot, 'next-env.d.ts'),
    resolve(webRoot, 'src/**/*.ts'),
    resolve(webRoot, 'src/**/*.tsx'),
    resolve(nextDistPath, 'types/**/*.ts'),
  ],
  exclude: [resolve(webRoot, 'node_modules')],
}, null, 2) + '\n', 'utf8');

function removeOwnedTempDirectory(path: string, expectedPrefix: string) {
  try {
    const tempRoot = realpathSync(tmpdir());
    const verifiedPath = realpathSync(path);
    if (dirname(verifiedPath) !== tempRoot || !basename(verifiedPath).startsWith(expectedPrefix)) return;
    rmSync(verifiedPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch { /* preserve uncertain paths; never widen cleanup */ }
}

process.once('exit', () => {
  removeOwnedTempDirectory(projectRoot, 'agentos-p2-recovery-project-');
  removeOwnedTempDirectory(tsconfigRoot, tsconfigRootPrefix);
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
        AGENTOS_NEXT_DIST_DIR: relativeNextDistPath,
        AGENTOS_NEXT_TSCONFIG_PATH: tempTsconfigPath,
        NEXT_PUBLIC_API_URL: serverBaseURL,
      },
    },
  ],
  projects: [{ name: 'p2-recovery-desktop', use: { viewport: { width: 1280, height: 800 } } }],
});
