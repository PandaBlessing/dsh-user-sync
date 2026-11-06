// 服务端：空包判定（manifestFileCount）与上传拒绝行为测试
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildManifest } from '../src/archive.ts';
import { manifestFileCount } from '../server/src/lib/archive.ts';

test('manifestFileCount：正常包返回文件数', () => {
  const manifest = buildManifest(
    [{ path: 'a.txt', sha256: 'x'.repeat(64), size: 1, mode: '100644' }],
    { packageId: 'p1', createdAt: '2026-10-30T00:00:00Z' },
  );
  assert.equal(manifestFileCount(manifest), 1);
});

test('manifestFileCount：空包返回 0（触发 E_EMPTY_PACKAGE）', () => {
  const manifest = buildManifest([], { packageId: 'p2', createdAt: '2026-10-30T00:00:00Z' });
  assert.equal(manifestFileCount(manifest), 0);
});

test('manifestFileCount：缺字段/null 视为 0', () => {
  assert.equal(manifestFileCount(null), 0);
  assert.equal(manifestFileCount(undefined), 0);
  assert.equal(manifestFileCount({ files: null }), 0);
});

test('manifestFileCount：files 非数组时视为 0', () => {
  assert.equal(manifestFileCount({ files: 'nope' }), 0);
});
