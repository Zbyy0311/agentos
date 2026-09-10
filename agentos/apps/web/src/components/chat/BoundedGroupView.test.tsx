import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

async function render(overrides: Record<string, unknown> = {}): Promise<string> {
  (globalThis as typeof globalThis & { React: typeof React }).React = React;
  const { BoundedGroupView } = await import('./BoundedGroupView.js');
  return renderToStaticMarkup(
    <BoundedGroupView
      theme="dark"
      interaction={{ id: 'gi_1', status: 'active', stopReason: null, loopGuardSignal: null }}
      budget={{ repliesUsed: 2, repliesRemaining: 3, hopsUsed: 1, hopsRemaining: 3, distinctAgents: 2, agentsRemaining: 1 }}
      replies={[
        { id: 'r1', agentId: 'codex', messageId: 'm1', hopFromAgentId: null, hopOrder: 0 },
        { id: 'r2', agentId: 'kimi', messageId: 'm2', hopFromAgentId: 'codex', hopOrder: 1 },
      ]}
      stopping={false}
      onStop={() => {}}
      {...overrides}
    />,
  );
}

test('GRP-01 the interaction is visibly bounded with progress meters', async () => {
  const markup = await render();
  assert.ok(markup.includes('data-agentos="bounded-group-view"'));
  assert.ok(markup.includes('role="progressbar"'));
  assert.ok(markup.includes('2 / 5'));
  assert.ok(markup.includes('1 / 4'));
  assert.ok(markup.includes('2 / 3'));
});

test('GRP-02 the hop chain and per-Agent attribution are explicit', async () => {
  const markup = await render();
  assert.ok(markup.includes('codex'));
  assert.ok(markup.includes('kimi'));
  assert.ok(markup.includes('codex ← kimi') || markup.includes('kimi ← codex'));
  assert.ok(markup.includes('>#0<'));
  assert.ok(markup.includes('>#1<'));
});

test('GRP-03 an active interaction shows a Stop control that does not cancel a Run', async () => {
  const markup = await render();
  assert.ok(markup.includes('data-agentos="group-stop"'));
  assert.ok(markup.includes('Stop interaction'));
});

test('GRP-04 a stopped interaction hides Stop and names the stop reason', async () => {
  const markup = await render({ interaction: { id: 'gi_1', status: 'stopped', stopReason: 'user-stop', loopGuardSignal: null } });
  assert.ok(!markup.includes('data-agentos="group-stop"'));
  assert.ok(markup.includes('user-stop'));
  assert.ok(markup.includes('data-status="stopped"'));
});

test('GRP-05 a loop-guard termination shows the signal as an alert', async () => {
  const markup = await render({ interaction: { id: 'gi_1', status: 'exhausted', stopReason: 'loop-guard', loopGuardSignal: 'repeated-content' } });
  assert.ok(markup.includes('role="alert"'));
  assert.ok(markup.includes('repeated-content'));
  assert.ok(markup.includes('loop-guard'));
});

