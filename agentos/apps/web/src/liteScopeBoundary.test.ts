/**
 * LITE-12-016: the Lite UI must not present a Worktree manager, a full Policy
 * editor, or Provider Comparison. Those are explicit Deferred / Non-Goals, so
 * their absence from the product surface is worth asserting rather than taking
 * on trust.
 *
 * Scope note: the requirement is about the deferred PRODUCT SURFACES. The
 * server legitimately owns a Worktree runtime (06-Worktree-Runtime) and a Policy
 * runtime (08-Policy-Runtime); what must not exist is a UI that manages them.
 * The scan is therefore limited to the web app.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const webSrc = resolve(dirname(fileURLToPath(import.meta.url)));

function walk(directory: string, files: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) walk(path, files);
    else files.push(path);
  }
  return files;
}

/** The deferred product surfaces, matched against route and module names. */
const DEFERRED_SURFACES = [
  { label: 'Worktree manager UI', pattern: /worktree[-_.]?(manager|view|panel)/i },
  { label: 'full Policy editor', pattern: /policy[-_.]?(editor|builder|dsl)/i },
  { label: 'Provider Comparison', pattern: /provider[-_.]?comparison/i },
];

test('LITE-12-016 the UI ships only the Lite route surface', () => {
  const appDir = join(webSrc, 'app');
  const routes = walk(appDir)
    .filter(file => /(^|[\\/])page\.tsx?$/.test(file))
    .map(file => relative(appDir, file).replaceAll('\\', '/'))
    .sort();
  // The complete Lite route surface. A fourth page means a new product area.
  assert.deepEqual(routes, ['page.tsx', 'workspace/[id]/page.tsx', 'workspace/[id]/runtime/page.tsx']);
  for (const route of routes) {
    for (const surface of DEFERRED_SURFACES) {
      assert.equal(surface.pattern.test(route), false, `${surface.label} must not be a route: ${route}`);
    }
  }
});

test('LITE-12-016 no web module implements a deferred product surface', () => {
  const offenders: string[] = [];
  for (const file of walk(webSrc)) {
    const relativePath = relative(webSrc, file).replaceAll('\\', '/');
    if (/\.test\.tsx?$/.test(relativePath)) continue;
    for (const surface of DEFERRED_SURFACES) {
      if (surface.pattern.test(relativePath)) offenders.push(`${surface.label}: ${relativePath}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('LITE-12-016 the workspace shells expose no deferred product entry point', () => {
  // The shells are where a deferred product would surface as navigation or a
  // panel. They may mention the words in copy, but must not link to such a view.
  for (const file of [
    join(webSrc, 'components', 'layout', 'WorkbenchShell.tsx'),
    join(webSrc, 'components', 'chat', 'ConversationRuntimeView.tsx'),
  ]) {
    const source = readFileSync(file, 'utf8');
    for (const surface of DEFERRED_SURFACES) {
      assert.equal(
        surface.pattern.test(source),
        false,
        `${surface.label} must not appear in ${relative(webSrc, file)}`,
      );
    }
  }
});

