import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryExtractor } from './MemoryExtractor.js';

test('extracts only explicit public candidate markers and validates their JSON shape', () => {
  const extractor = new MemoryExtractor();
  const result = extractor.extract({
    objective: '原始需求不应被当作候选正文', resultSummary: [
      '公开结果：已完成。',
      '```agentos-memory',
      JSON.stringify({ type: 'decision', title: '认证决策', summary: '使用短期令牌', content: '认证令牌必须短期有效。', confidence: 90 }),
      '```',
      '<!-- agentos-memory-candidate: {"type":"experience","title":"调试经验","summary":"先看日志","content":"先检查诊断日志再重试。","confidence":80} -->',
      '<!-- agentos-memory-candidate: {"type":"decision","title":"坏候选"} -->',
    ].join('\n'), fileChanges: [], visibleReplies: [],
  });
  assert.deepEqual(result.drafts.map(candidate => candidate.title), ['认证决策', '调试经验']);
  assert.equal(result.drafts[0]?.operation, 'create');
  assert.equal(result.reason, 'explicit_marker');
});

test('derives an experience candidate from file evidence without a hidden marker', () => {
  const result = new MemoryExtractor().extract({
    objective: '修复认证流程并补充测试',
    resultSummary: '已完成修复，验证测试通过。',
    fileChanges: [{ runId: 'run-a', path: 'apps/server/src/auth.ts', changeType: 'modified' }],
    visibleReplies: ['已完成公开说明。'],
  });

  assert.equal(result.reason, 'public_evidence');
  assert.equal(result.drafts.length, 1);
  assert.equal(result.drafts[0]?.type, 'experience');
  assert.match(result.drafts[0]?.content ?? '', /apps\/server\/src\/auth\.ts/);
});

test('derives decision and convention candidates from public evidence', () => {
  const result = new MemoryExtractor().extract({
    objective: '确定 API 方案和代码规范',
    resultSummary: '决定使用 REST 接口；约定所有事件必须持久化。',
    fileChanges: [],
    visibleReplies: [],
  });

  assert.equal(result.reason, 'public_evidence');
  assert.deepEqual(result.drafts.map(draft => draft.type), ['decision', 'convention']);
});

test('returns an explicit no-candidate reason for valueless short replies', () => {
  const result = new MemoryExtractor().extract({
    objective: '完成任务',
    resultSummary: '已完成',
    fileChanges: [],
    visibleReplies: ['好的'],
  });

  assert.deepEqual(result, { drafts: [], reason: 'no_valuable_public_evidence' });
});
