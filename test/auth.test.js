import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { deriveAccountKey } from '../src/auth.ts';

test('accountKey = sha256(账号 id) 前 16 位十六进制', () => {
  const id = '9f2c1a4b-7d3e-4a5b-8c6d-1e2f3a4b5c6d';
  const expected = createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 16);
  assert.equal(deriveAccountKey(id), expected);
  assert.match(deriveAccountKey(id), /^[0-9a-f]{16}$/);
});

test('同账号不同环境得到同一 accountKey，不同账号不同', () => {
  const a1 = deriveAccountKey('account-a');
  const a2 = deriveAccountKey('account-a');
  const b = deriveAccountKey('account-b');
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
});

test('缺少 id 时返回 null（未登录 / 平台未返回）', () => {
  assert.equal(deriveAccountKey(null), null);
  assert.equal(deriveAccountKey(undefined), null);
  assert.equal(deriveAccountKey(''), null);
});
