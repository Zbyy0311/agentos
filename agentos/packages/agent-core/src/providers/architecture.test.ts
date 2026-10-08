import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PROVIDER_ROOT = dirname(fileURLToPath(import.meta.url));

function providerImportGraph(): Map<string, string> {
  const graph = new Map<string, string>();
  const visit = (file: string): void => {
    if (graph.has(file)) return;
    const source = readFileSync(file, 'utf8');
    graph.set(file, source);
    for (const specifier of source.matchAll(/from\s+['"](\.\.?\/[^'"]+)['"]/g)) {
      const imported = specifier[1];
      if (!imported) continue;
      const candidate = resolve(dirname(file), imported.replace(/\.js$/u, '.ts'));
      try { visit(candidate); } catch { /* external or type-only declaration */ }
    }
  };
  visit(resolve(PROVIDER_ROOT, 'index.ts'));
  return graph;
}

describe('M4-P3 provider runtime boundary', () => {
  it('keeps the complete transitive Kimi adapter graph free of native child-process imports', () => {
    const graph = providerImportGraph();
    const source = [...graph.values()].join('\n');
    expect(source).not.toMatch(/node:child_process|\bspawn\s*\(|\bexec(?:File)?\s*\(/u);
    expect([...graph.keys()].some(file => file.endsWith('capabilityProbe.ts'))).toBe(false);
    expect([...graph.keys()].some(file => file.endsWith('kimiAdapter.ts'))).toBe(false);
  });

  it('leaves the native probe implementation in Process Runtime and wires server production through that port', () => {
    const processProbe = readFileSync(resolve(PROVIDER_ROOT, '../../../process-runtime/src/probe.ts'), 'utf8');
    const route = readFileSync(resolve(PROVIDER_ROOT, '../../../../apps/server/src/routes/providerConfigs.ts'), 'utf8');
    expect(processProbe).toMatch(/node:child_process/u);
    expect(route).toMatch(/@agentos\/agent-core\/providers/u);
    expect(route).toMatch(/NodeProcessProbePort/u);
    expect(route).not.toMatch(/runProbeCommand|capabilityProbe/u);
  });
});
