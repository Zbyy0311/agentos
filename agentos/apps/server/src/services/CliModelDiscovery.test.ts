import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentModelOption, AgentRole } from '@agentos/shared';
import { CliModelDiscovery, normalizeModelOption } from './CliModelDiscovery.js';

function createFixtureRoot(): string {
  return mkdtempSync(join(tmpdir(), 'agentos-model-discovery-'));
}

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

function fallbackModel(id = 'fallback/model'): AgentModelOption {
  return {
    id,
    label: id,
    thinkingEfforts: ['auto'],
    defaultThinkingEffort: 'auto',
  };
}

function discoveryInput(cliCommand: string, role: AgentRole, fallbackModels = [fallbackModel()]) {
  return {
    cliCommand,
    role,
    fallbackModels,
    fallbackThinkingEfforts: ['auto'] as const,
  };
}

test('normalizes a model option without exposing unsupported thinking levels', () => {
  const result = normalizeModelOption({
    id: 'gpt-5.6-luna',
    label: 'GPT-5.6 Luna',
    thinkingEfforts: ['low', 'medium', 'high', 'xhigh'],
  });

  assert.deepEqual(result.thinkingEfforts, ['auto', 'low', 'medium', 'high']);
  assert.equal(result.defaultThinkingEffort, 'medium');
});

test('reads visible Codex models from models_cache.json', async () => {
  const root = createFixtureRoot();
  try {
    writeFileSync(join(root, 'models_cache.json'), JSON.stringify({
      models: [
        { slug: 'gpt-5.5', display_name: 'GPT-5.5', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }] },
        { slug: 'gpt-5.6-luna', display_name: 'GPT-5.6 Luna', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }] },
        { slug: 'hidden-model', display_name: 'Hidden', visibility: 'hidden' },
      ],
    }), 'utf8');

    const result = await new CliModelDiscovery({ env: { CODEX_HOME: root } }).discover(
      discoveryInput('codex', 'codex'),
    );

    assert.equal(result.source, 'cache');
    assert.deepEqual(result.models.map(model => model.id), ['gpt-5.5', 'gpt-5.6-luna']);
    assert.deepEqual(result.models[0].thinkingEfforts, ['auto', 'low', 'medium', 'high']);
  } finally {
    cleanup(root);
  }
});

test('uses cached discovery until forceRefresh is requested', async () => {
  const root = createFixtureRoot();
  try {
    const cacheFile = join(root, 'models_cache.json');
    writeFileSync(cacheFile, JSON.stringify({ models: [{ slug: 'gpt-old', display_name: 'Old' }] }), 'utf8');
    const discovery = new CliModelDiscovery({ env: { CODEX_HOME: root }, cacheTtlMs: 60_000 });

    const first = await discovery.discover(discoveryInput('codex', 'codex'));
    writeFileSync(cacheFile, JSON.stringify({ models: [{ slug: 'gpt-new', display_name: 'New' }] }), 'utf8');
    const cached = await discovery.discover(discoveryInput('codex', 'codex'));
    const refreshed = await discovery.discover({ ...discoveryInput('codex', 'codex'), forceRefresh: true });

    assert.deepEqual(first.models.map(model => model.id), ['gpt-old']);
    assert.deepEqual(cached.models.map(model => model.id), ['gpt-old']);
    assert.deepEqual(refreshed.models.map(model => model.id), ['gpt-new']);
  } finally {
    cleanup(root);
  }
});

test('reads Kimi model aliases from config.toml without reading credentials', async () => {
  const root = createFixtureRoot();
  try {
    writeFileSync(join(root, 'config.toml'), [
      'default_model = "kimi-code/kimi-for-coding"',
      '[models."kimi-code/kimi-for-coding"]',
      'display_name = "Kimi For Coding"',
      '[models."kimi-code/kimi-for-coding-highspeed"]',
      'display_name = "Kimi Highspeed"',
    ].join('\n'), 'utf8');
    writeFileSync(join(root, 'credentials'), 'DO_NOT_READ_THIS_SECRET', 'utf8');

    const result = await new CliModelDiscovery({ env: { KIMI_CODE_HOME: root } }).discover(
      discoveryInput('kimi', 'kimi'),
    );

    assert.equal(result.source, 'config');
    assert.deepEqual(result.models.map(model => model.id), [
      'kimi-code/kimi-for-coding',
      'kimi-code/kimi-for-coding-highspeed',
    ]);
    assert.ok(result.models.every(model => model.thinkingEfforts.length === 1 && model.thinkingEfforts[0] === 'auto'));
  } finally {
    cleanup(root);
  }
});

test('reads OpenCode provider models from a JSON config fixture', async () => {
  const root = createFixtureRoot();
  try {
    const configFile = join(root, 'opencode.json');
    writeFileSync(configFile, JSON.stringify({
      provider: {
        openai: { models: { 'gpt-5.6': { name: 'GPT-5.6' } } },
        kimi: { models: { 'kimi-k2': { displayName: 'Kimi K2' } } },
      },
    }), 'utf8');

    const result = await new CliModelDiscovery({ env: { AGENTOS_OPENCODE_MODELS_FILE: configFile } }).discover(
      discoveryInput('opencode', 'opencode'),
    );

    assert.equal(result.source, 'config');
    assert.deepEqual(result.models.map(model => model.id), ['openai/gpt-5.6', 'kimi/kimi-k2']);
    assert.equal(result.models[0].label, 'GPT-5.6');
  } finally {
    cleanup(root);
  }
});

test('reads OpenCode CLI JSON array output', async () => {
  const root = createFixtureRoot();
  try {
    const result = await new CliModelDiscovery({
      env: { AGENTOS_OPENCODE_MODELS_FILE: join(root, 'missing-opencode.json') },
      execFile: async () => ({
        stdout: JSON.stringify([{ id: 'openai/gpt-5.5', name: 'GPT-5.5' }]),
        stderr: '',
      }),
    }).discover(discoveryInput('opencode', 'opencode'));

    assert.equal(result.source, 'live');
    assert.deepEqual(result.models.map(model => model.id), ['openai/gpt-5.5']);
  } finally {
    cleanup(root);
  }
});

test('reads the plain model listing emitted by OpenCode 1.17', async () => {
  const root = createFixtureRoot();
  try {
    const result = await new CliModelDiscovery({
      env: { AGENTOS_OPENCODE_MODELS_FILE: join(root, 'missing-opencode.json') },
      execFile: async (_command, args) => {
        if (args.includes('--json')) throw new Error('unknown option --json');
        return { stdout: 'opencode/big-pickle\nkimi-for-coding/k2p6\n', stderr: '' };
      },
    }).discover(discoveryInput('opencode', 'opencode'));

    assert.equal(result.source, 'live');
    assert.deepEqual(result.models.map(model => model.id), ['opencode/big-pickle', 'kimi-for-coding/k2p6']);
  } finally {
    cleanup(root);
  }
});

test('returns fallback when OpenCode is unavailable', async () => {
  const root = createFixtureRoot();
  try {
    const result = await new CliModelDiscovery({ env: { USERPROFILE: root, PATH: '' } }).discover({
      ...discoveryInput('opencode', 'opencode'),
      fallbackModels: [fallbackModel('fallback/opencode')],
    });

    assert.equal(result.source, 'fallback');
    assert.equal(result.stale, true);
    assert.equal(result.models[0].id, 'fallback/opencode');
    assert.match(result.warning ?? '', /OpenCode/i);
  } finally {
    cleanup(root);
  }
});
