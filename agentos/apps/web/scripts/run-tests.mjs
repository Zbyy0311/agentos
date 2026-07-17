import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));

async function collectTests(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectTests(path));
    } else if (/\.test\.tsx?$/.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

const files = (await collectTests(sourceRoot)).sort();
if (files.length === 0) {
  console.error('No web tests found under src/**/*.test.ts(x)');
  process.exitCode = 1;
} else {
  const child = spawn(process.execPath, ['--import', 'tsx', '--test', ...files], {
    cwd: resolve(packageRoot),
    stdio: 'inherit',
    shell: false,
  });
  child.on('exit', code => { process.exitCode = code ?? 1; });
  child.on('error', error => {
    console.error(`Failed to start web tests: ${error.message}`);
    process.exitCode = 1;
  });
}
