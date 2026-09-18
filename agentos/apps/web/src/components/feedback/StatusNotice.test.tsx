import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StatusNotice } from './StatusNotice.js';

test('error notices are alerts and non-errors are status messages', () => {
  const error = renderToStaticMarkup(<StatusNotice tone="error" title="执行失败">诊断摘要</StatusNotice>);
  const waiting = renderToStaticMarkup(<StatusNotice tone="waiting">等待 Agent</StatusNotice>);
  assert.match(error, /role="alert"/);
  assert.match(waiting, /role="status"/);
});
