import assert from 'node:assert/strict';
import test from 'node:test';
import { EventRedactionService } from './EventRedactionService.js';
import {
  MEMORY_SECRET_DETECTED_CODE,
  MemorySecretDetectedError,
  assertNoMemorySecrets,
  detectMemorySecretViolations,
  formatMemorySecretDetail,
} from './MemorySecretGuard.js';

const WS = 'workspace-secret-test';
const KNOWN = 'sup3r-s3cret-valu3!'; // >= 8 chars, registered as a known secret

function detector(): EventRedactionService {
  const service = new EventRedactionService();
  service.registerSecrets(WS, [KNOWN, '', 'short', 'known2nd']);
  return service;
}

test('detects a registered known secret value in each text field', () => {
  const guard = detector();
  for (const field of ['title', 'summary', 'content'] as const) {
    const violations = detectMemorySecretViolations(guard, WS, { [field]: `prefix ${KNOWN} suffix` });
    assert.deepEqual(violations, [{ field, kind: 'known-value' }]);
  }
  const tagHit = detectMemorySecretViolations(guard, WS, { tags: ['ok', `tag-${KNOWN}`] });
  assert.deepEqual(tagHit, [{ field: 'tags', kind: 'known-value' }]);
});

test('detects generic secret shapes without any registered value', () => {
  const guard = new EventRedactionService();
  const cases = [
    'key: sk-abcdefghijklmnop1234',
    'aws: AKIA1234567890ABCDEF',
    'token: ghp_abcdefghij0123456789abcd',
    'auth: Bearer abcdef0123456789abcdef',
    '-----BEGIN PRIVATE KEY-----\nMIIB',
    'key: AIzaSyD4iE7xn0n0123456789abcd_-',
    'slack: xoxb-1234567890-abcdef',
  ];
  for (const text of cases) {
    const violations = detectMemorySecretViolations(guard, WS, { content: text });
    assert.equal(violations.length, 1, `expected hit for ${text.slice(0, 24)}`);
    assert.equal(violations[0]!.kind, 'generic-pattern');
  }
});

test('clean text and empty strings produce no violations', () => {
  const guard = detector();
  assert.deepEqual(detectMemorySecretViolations(guard, WS, {
    title: '项目决策', summary: '采用短期令牌轮换', content: '# 决策\n\n普通正文。', tags: ['auth', '轮换'],
  }), []);
  assert.deepEqual(detectMemorySecretViolations(guard, WS, { title: '', summary: '', content: '' }), []);
});

test('secrets registered for another workspace do not match', () => {
  const guard = detector();
  assert.deepEqual(detectMemorySecretViolations(guard, 'other-workspace', { content: KNOWN }), []);
});

test('assertNoMemorySecrets throws a coded error that never echoes the secret', () => {
  const guard = detector();
  assert.throws(
    () => assertNoMemorySecrets(guard, WS, { title: 't', summary: 's', content: `leak ${KNOWN}` }),
    (error: unknown) => {
      assert.ok(error instanceof MemorySecretDetectedError);
      assert.equal(error.code, MEMORY_SECRET_DETECTED_CODE);
      assert.equal(JSON.stringify(error.violations).includes(KNOWN), false);
      assert.equal(error.message.includes(KNOWN), false);
      return true;
    },
  );
});

test('formatMemorySecretDetail names only the field category', () => {
  const guard = detector();
  const violations = detectMemorySecretViolations(guard, WS, { content: KNOWN, title: 'sk-abcdefghijklmnop1234' });
  const detail = formatMemorySecretDetail(violations);
  assert.equal(detail, 'title/content 疑似包含密钥');
  assert.equal(detail.includes(KNOWN), false);
  assert.equal(detail.includes('sk-abcdefghijklmnop1234'), false);
});
