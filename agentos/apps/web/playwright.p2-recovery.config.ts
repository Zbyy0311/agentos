import { defineConfig, devices } from '@playwright/test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const serverPort = process.env.P2_RECOVERY_SERVER_PORT ?? '3240';
const webPort = process.env.P2_RECOVERY_WEB_PORT ?? '3241';
const serverBaseURL = `http://127.0.0.1:${serverPort}`;
const recoveryFixtureWorkspaceId = 'p2-browser-fixture';
const webRoot = resolve(process.cwd());
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
// Next 14 joins tsconfigPath with the app root, including absolute paths.
// Keep it on the checkout drive and outside dist, which Next clears on startup.
const generatedConfigRoot = join(webRoot, '.next-p2-group-recovery-config');
mkdirSync(generatedConfigRoot, { recursive: true });
const tsconfigRoot = mkdtempSync(join(generatedConfigRoot, tsconfigRootPrefix));
const tempTsconfigPath = resolve(tsconfigRoot, 'tsconfig.json');
const nextTsconfigPath = relative(webRoot, tempTsconfigPath);
writeFileSync(tempTsconfigPath, JSON.stringify({
  extends: nextConfigPath,
  compilerOptions: { baseUrl: webRoot },
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

function removeOwnedGeneratedTsconfigDirectory() {
  try {
    const verifiedPath = realpathSync(tsconfigRoot);
    if (dirname(verifiedPath) !== realpathSync(generatedConfigRoot)
      || !basename(verifiedPath).startsWith(tsconfigRootPrefix)) return;
    rmSync(verifiedPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch { /* preserve uncertain paths */ }
}

process.once('exit', () => {
  removeOwnedTempDirectory(projectRoot, 'agentos-p2-recovery-project-');
  removeOwnedGeneratedTsconfigDirectory();
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
      url: `http://127.0.0.1:${webPort}/workspace/${recoveryFixtureWorkspaceId}`,
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        AGENTOS_NEXT_DIST_DIR: relativeNextDistPath,
        AGENTOS_NEXT_TSCONFIG_PATH: nextTsconfigPath,
        NEXT_PUBLIC_API_URL: serverBaseURL,
      },
    },
  ],
  projects: [{ name: 'p2-recovery-desktop', use: { viewport: { width: 1280, height: 800 } } }],
});
