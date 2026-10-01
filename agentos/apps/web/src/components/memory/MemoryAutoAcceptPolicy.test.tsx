import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryAutoAcceptPolicyCard } from './MemoryAutoAcceptPolicy.js';

function render(options: Partial<Parameters<typeof MemoryAutoAcceptPolicyCard>[0]> = {}): string {
  (globalThis as typeof globalThis & { React: typeof React }).React = React;
  return renderToStaticMarkup(<MemoryAutoAcceptPolicyCard
    policy={options.policy}
    loading={options.loading ?? false}
    busy={options.busy ?? false}
    error={options.error ?? ''}
    stale={options.stale ?? false}
    notice={options.notice ?? ''}
    onEnabledChange={options.onEnabledChange ?? (() => undefined)}
    onReload={options.onReload ?? (() => undefined)}
  />);
}

test('default policy version zero is shown as enabled with a bounded low-risk description', () => {
  const markup = render({ policy: { enabled: true, version: 0 } });
  assert.ok(markup.includes('checked=""'));
  assert.ok(markup.includes('系统默认策略 · v0'));
  assert.ok(markup.includes('白名单失败码、运行环境信息和测试结果'));
  assert.ok(markup.includes('来源验证通过且没有冲突时才自动接受'));
  assert.ok(markup.includes('其他事实或有冲突的事实仍进入候选审查'));
  assert.ok(markup.includes('不会改写现有记忆或历史快照'));
});

test('disabled policy is explicit that subsequent facts go to candidate review', () => {
  const markup = render({ policy: { enabled: false, version: 3 } });
  assert.ok(!markup.includes('checked=""'));
  assert.ok(markup.includes('已关闭'));
  assert.ok(markup.includes('新事实进入候选审查'));
  assert.ok(markup.includes('策略版本 v3'));
});

test('policy pending state keeps its scope description visible while loading', () => {
  const markup = render({ loading: true });
  assert.ok(markup.includes('正在读取自动接受策略'));
  assert.ok(markup.includes('仅限当前工作区'));
  assert.ok(!markup.includes('启用低风险事实自动接受'));
});

test('stale policy updates offer an explicit latest-version reload action', () => {
  const markup = render({ policy: { enabled: true, version: 2 }, error: '策略已更新。', stale: true });
  assert.ok(markup.includes('重新加载最新版本'));
  assert.ok(markup.includes('策略已更新。'));
});
