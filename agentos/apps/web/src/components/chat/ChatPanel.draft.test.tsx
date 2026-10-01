import assert from 'node:assert/strict';
import test from 'node:test';
import React, { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatPanel } from './ChatPanel';
import type { GroupInteraction } from '../../lib/groupConversationClient';

// Match the existing Node/tsx SSR fixtures (Next compiles JSX automatically).
(globalThis as typeof globalThis & { React: typeof React }).React = React;

function props(overrides: Partial<ComponentProps<typeof ChatPanel>> = {}): ComponentProps<typeof ChatPanel> {
  return {
    agentName: 'Fixture Agent', agents: [], messages: [], draft: 'memory draft', attachments: [], attachmentError: '',
    streamingContent: '', activeEvents: [], error: '', sending: false, queuedMessageCount: 0,
    modelOptions: [], composerThinkingEffort: 'auto', composerThinkingEfforts: ['auto'],
    onDraftChange: () => undefined, onFiles: () => undefined, onRemoveAttachment: () => undefined,
    onComposerModelChange: () => undefined, onComposerThinkingEffortChange: () => undefined,
    onSend: () => undefined, onCancel: () => undefined,
    ...overrides,
  };
}

test('rendered Composer disables input and send until its identity draft is ready', () => {
  const markup = renderToStaticMarkup(createElement(ChatPanel, props({ draftReady: false })));
  assert.match(markup, /<textarea[^>]*aria-label="消息输入框"[^>]*disabled/);
  assert.match(markup, /<button[^>]*disabled[^>]*aria-label="发送消息"/);
  assert.match(markup, /正在恢复此会话草稿/);
});

test('rendered Composer keeps memory text and visibly warns about persistence risk', () => {
  const markup = renderToStaticMarkup(createElement(ChatPanel, props({
    draftReady: true, draftPersistenceWarning: '图片存储失败；刷新可能丢失。',
  })));
  assert.match(markup, /memory draft<\/textarea>/);
  assert.match(markup, /role="status"[^>]*>图片存储失败；刷新可能丢失。/);
});

test('sending still permits selecting a new image without clearing the submitted image', () => {
  const markup = renderToStaticMarkup(createElement(ChatPanel, props({
    draftReady: true, sending: true,
    attachments: [{ id: 'submitted', name: 'submitted.png', mimeType: 'image/png', size: 1, previewUrl: 'blob:submitted' }],
  })));
  const button = markup.match(/<button[^>]*aria-label="添加图片"[^>]*>/)?.[0];
  assert.ok(button);
  assert.equal(/\sdisabled(?:=|\s|>)/.test(button), false);
  assert.match(markup, /submitted.png/);
});

function activeGroup(): GroupInteraction {
  return { id: 'interaction-a', conversationId: 'group-a', sourceMessageId: 'source-a', status: 'active',
    stopReason: null, loopGuardSignal: null, replyCount: 1, hopCount: 0, version: 3,
    maxAgentsPerTurn: 3, maxRepliesPerAgent: 1, maxTotalReplies: 3, maxAgentHops: 3 };
}

test('unusable active group displays interruption reason rather than a running speaker', () => {
  const groupInteraction = Object.assign(activeGroup(), { integrityStatus: 'unusable' as const, integrityReason: 'execution-owner-unknown-after-restart' });
  const markup = renderToStaticMarkup(createElement(ChatPanel, props({
    isGroup: true, groupName: 'Group A', groupInteraction, groupSpeakingAgentName: 'Old speaker', sending: true,
    activeStatus: 'running_cli', streamingContent: 'Historical partial response', queuedMessageCount: 1,
    onResumeQueue: () => undefined, groupDiscussionError: 'Original response requires checking',
  })));
  assert.match(markup, /讨论已中断 · 等待处理/);
  assert.match(markup, /execution-owner-unknown-after-restart/);
  assert.doesNotMatch(markup, /正在发言|正在准备下一位 Agent|正在调用 Agent CLI|正在等待 Agent 返回第一个执行阶段/);
  assert.match(markup, /Historical partial response/);
  for (const label of ['停止讨论', '发送消息']) {
    const buttons = [...markup.matchAll(/<button\b[^>]*>/g)].map(match => match[0]).filter(button => button.includes(`aria-label="${label}"`));
    assert.ok(buttons.length > 0, `${label} remains explained, not silently actionable`);
    assert.ok(buttons.every(button => /\sdisabled(?:=|\s|>)/.test(button)), `${label} must be disabled`);
  }
  assert.match(markup, /<button[^>]*disabled[^>]*>核对后恢复原发送/);
});

test('unusable completed group is not advertised as a successfully completed discussion', () => {
  const groupInteraction = Object.assign(activeGroup(), { status: 'completed' as const, integrityStatus: 'unusable' as const, integrityReason: 'reply-ledger-invalid' });
  const markup = renderToStaticMarkup(createElement(ChatPanel, props({ isGroup: true, groupName: 'Group A', groupInteraction })));
  assert.match(markup, /等待处理/); assert.match(markup, /reply-ledger-invalid/);
  assert.doesNotMatch(markup, /讨论已完成/);
});

test('valid active group retains its speaker and enabled stop action', () => {
  const groupInteraction = Object.assign(activeGroup(), { integrityStatus: 'valid' as const, integrityReason: null });
  const markup = renderToStaticMarkup(createElement(ChatPanel, props({ isGroup: true, groupName: 'Group A', groupInteraction, sending: true, groupSpeakingAgentName: 'Current speaker' })));
  assert.match(markup, /正在发言：Current speaker/);
  const stop = markup.match(/<button[^>]*aria-label="停止讨论"[^>]*>/)?.[0];
  assert.ok(stop); assert.equal(/\sdisabled(?:=|\s|>)/.test(stop), false);
});
