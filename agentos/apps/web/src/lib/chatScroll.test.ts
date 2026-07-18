import assert from 'node:assert/strict';
import test from 'node:test';
import { isNearBottom, shouldKeepChatAnchor } from './chatScroll.js';

test('detects whether the chat viewport is close to the bottom', () => {
  assert.equal(isNearBottom({ scrollTop: 800, clientHeight: 400, scrollHeight: 1200 }), true);
  assert.equal(isNearBottom({ scrollTop: 700, clientHeight: 400, scrollHeight: 1200 }), false);
});

test('only auto-anchors an already-following stream', () => {
  assert.equal(shouldKeepChatAnchor({ userInitiated: false, wasNearBottom: true }), true);
  assert.equal(shouldKeepChatAnchor({ userInitiated: true, wasNearBottom: true }), false);
  assert.equal(shouldKeepChatAnchor({ userInitiated: false, wasNearBottom: false }), false);
});

