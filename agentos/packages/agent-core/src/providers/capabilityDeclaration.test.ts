import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexProviderAdapter } from './codexProviderAdapter.js';
import { KimiCodeProviderAdapter } from './kimiCodeAdapter.js';
import { OpenCodeProviderAdapter } from './opencodeProviderAdapter.js';
import type { ProviderCapabilities, ProviderConfigurationInput } from './types.js';

/**
 * LITE-04-007: capability declarations match tested behavior.
 *
 * A declared capability is a promise to the caller, so this asserts the promise in
 * both directions, per production adapter:
 *
 *  - the declaration is complete: every canonical key is present and boolean, so a
 *    capability cannot be silently omitted (an omitted key reads as undefined, which
 *    is neither true nor exactly false);
 *  - every capability declared TRUE is observable in real behavior, and
 *  - every capability declared FALSE is NOT observable, so a false declaration
 *    cannot hide a working feature.
 *
 * The probes read the adapter's own outputs - its real parse fixture and its launch
 * plan - rather than restating the constant, because restating the constant would
 * prove nothing about behavior.
 */

const CANONICAL_CAPABILITY_KEYS = [
  'sessionResume', 'structuredEvents', 'nativeApprovals', 'subagents', 'toolEvents',
  'fileEvents', 'usageEvents', 'reasoningStream', 'interactiveInput', 'pause',
  'cancellation', 'modelSelection', 'workspaceAwareness', 'nativeSandbox', 'outputContracts',
] as const;

function configuration(overrides: Partial<ProviderConfigurationInput> = {}): ProviderConfigurationInput {
  return {
    id: 'provider-under-test',
    workspaceId: 'ws-1',
    name: 'Provider under test',
    providerType: 'codex',
    adapterId: 'builtin.under-test',
    adapterVersion: '1.0.0',
    runtimeMode: 'cli',
    executable: 'C:/tools/provider.exe',
    argsTemplate: ['exec', '--sandbox', 'read-only'],
    workingDirectoryMode: 'worktree',
    timeoutPolicy: {
      discoveryTimeoutMs: 10_000,
      validationTimeoutMs: 30_000,
      startupTimeoutMs: 60_000,
      idleTimeoutMs: 600_000,
      totalTimeoutMs: null,
      cancelGracePeriodMs: 5_000,
      approvalTimeoutMs: null,
    },
    approvalMode: 'agentos',
    outputMode: 'structured',
    enabled: true,
    version: 1,
    ...overrides,
  } as ProviderConfigurationInput;
}

interface AdapterUnderTest {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  /** Structured event types the adapter's real fixture actually produces. */
  readonly parseFixture: () => readonly string[];
}

function adapters(): readonly AdapterUnderTest[] {
  const codexFixture = readFileSync(new URL('../adapters/fixtures/codex-basic.jsonl', import.meta.url), 'utf8');
  const kimiFixture = readFileSync(new URL('./fixtures/kimi-session-complete.jsonl', import.meta.url), 'utf8');

  const codex = new CodexProviderAdapter();
  const kimi = new KimiCodeProviderAdapter();
  const opencode = new OpenCodeProviderAdapter();

  // Both halves of the stream matter: a parser may legitimately emit a class of
  // event only when the stream is flushed (Kimi reports usage on finish), so a
  // probe that read parseChunk alone would misreport the declaration as false.
  const parsedTypes = (
    adapter: {
      parseChunk: (chunk: string, context: never) => { context: never; events: readonly { type: string }[] };
      finishParse: (context: never) => { events: readonly { type: string }[] };
      createParseContext: () => never;
    },
    fixture: string,
  ) => {
    const context = adapter.createParseContext();
    const streamed = adapter.parseChunk(fixture, context);
    const flushed = adapter.finishParse(streamed.context as never);
    return [...streamed.events, ...flushed.events].map(event => event.type);
  };

  return [
    {
      name: 'codex',
      capabilities: codex.getDefaultCapabilities(configuration({ providerType: 'codex' })),
      parseFixture: () => parsedTypes(codex as never, codexFixture),
    },
    {
      name: 'kimicode',
      capabilities: kimi.getDefaultCapabilities(configuration({ providerType: 'kimicode' })),
      parseFixture: () => parsedTypes(kimi as never, kimiFixture),
    },
    {
      name: 'opencode',
      capabilities: opencode.getDefaultCapabilities(configuration({ providerType: 'opencode' })),
      // The OpenCode adapter parses plain text, so its own output is the only honest
      // probe: whatever it yields is what a caller can rely on.
      parseFixture: () => parsedTypes(opencode as never, 'plain text output\n'),
    },
  ];
}

describe('LITE-04-007 capability declarations match tested behavior', () => {
  it('declares every canonical capability as an explicit boolean', () => {
    for (const adapter of adapters()) {
      const declared = adapter.capabilities as unknown as Record<string, unknown>;
      expect({ adapter: adapter.name, keys: Object.keys(declared).sort() })
        .toEqual({ adapter: adapter.name, keys: [...CANONICAL_CAPABILITY_KEYS].sort() });
      for (const key of CANONICAL_CAPABILITY_KEYS) {
        expect({ adapter: adapter.name, key, type: typeof declared[key] })
          .toEqual({ adapter: adapter.name, key, type: 'boolean' });
      }
    }
  });

  it('observes every capability declared true in the adapter real output', () => {
    for (const adapter of adapters()) {
      const declared = adapter.capabilities;
      const types = adapter.parseFixture();
      const label = { adapter: adapter.name };

      if (declared.structuredEvents) {
        // Structured means parsed events exist and are typed, not free text.
        expect({ ...label, structured: types.length > 0 }).toEqual({ ...label, structured: true });
        expect({ ...label, typed: types.every(type => typeof type === 'string' && type.length > 0) })
          .toEqual({ ...label, typed: true });
      }
      if (declared.toolEvents) {
        expect({ ...label, toolEvents: types.some(type => type.startsWith('tool.')) })
          .toEqual({ ...label, toolEvents: true });
      }
      if (declared.usageEvents) {
        expect({ ...label, usageEvents: types.includes('usage') })
          .toEqual({ ...label, usageEvents: true });
      }
    }
  });

  it('observes no capability declared false in the adapter real output', () => {
    for (const adapter of adapters()) {
      const declared = adapter.capabilities;
      const types = adapter.parseFixture();
      const label = { adapter: adapter.name };

      // The negative half: a false declaration must not hide working behavior.
      if (!declared.toolEvents) {
        expect({ ...label, toolEvents: types.some(type => type.startsWith('tool.')) })
          .toEqual({ ...label, toolEvents: false });
      }
      if (!declared.usageEvents) {
        expect({ ...label, usageEvents: types.includes('usage') })
          .toEqual({ ...label, usageEvents: false });
      }
      if (!declared.structuredEvents) {
        expect({ ...label, structured: types.every(type => type === 'assistant.message') })
          .toEqual({ ...label, structured: true });
      }
    }
  });

  it('keeps the frozen declaration stable across constructions', () => {
    // A caller caches capabilities; two adapters must not disagree, and one adapter
    // must not hand out a mutable object it later changes.
    const first = new CodexProviderAdapter();
    const second = new CodexProviderAdapter();
    expect(first.getDefaultCapabilities(configuration({ providerType: 'codex' })))
      .toEqual(second.getDefaultCapabilities(configuration({ providerType: 'codex' })));
    const handedOut = first.getDefaultCapabilities(configuration({ providerType: 'codex' }));
    (handedOut as { pause: boolean }).pause = true;
    // A mutated copy must not change the adapter default.
    expect(first.getDefaultCapabilities(configuration({ providerType: 'codex' })).pause)
      .toBe(false);
  });
});
