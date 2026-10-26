import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decide, detectLocalChanges } from '../src/lww.ts';

const T = (minute) => new Date(Date.UTC(2026, 9, 23, 1, minute)).toISOString();

test('LWW-01 远端更新且本地无改动 → pull', () => {
  const result = decide({ remote: { createdAt: T(10) }, lastApplied: { createdAt: T(0) } });
  assert.equal(result.action, 'pull');
  assert.equal(result.reason, 'remote-newer');
});

test('LWW-02 本地有改动且远端未更新 → push', () => {
  const result = decide({
    remote: { createdAt: T(0) },
    lastApplied: { createdAt: T(0) },
    localFiles: new Map([['a.txt', 'new']]),
    appliedFiles: new Map([['a.txt', 'old']]),
  });
  assert.equal(result.action, 'push');
  assert.equal(result.localChanged, true);
});

test('LWW-03 两侧都有更新且相差超过 5 分钟 → 较新者胜', () => {
  const result = decide({
    remote: { createdAt: T(20) },
    lastApplied: { createdAt: T(0) },
    lastUploaded: { createdAt: T(5) },
    localFiles: new Map([['a.txt', 'new']]),
    appliedFiles: new Map([['a.txt', 'old']]),
  });
  assert.equal(result.action, 'pull');
  assert.equal(result.reason, 'remote-newer');
});

test('LWW-04 两侧都有更新且相差 ≤ 5 分钟 → 转人工确认', () => {
  const result = decide({
    remote: { createdAt: T(10) },
    lastApplied: { createdAt: T(0) },
    lastUploaded: { createdAt: T(8) },
    localFiles: new Map([['a.txt', 'new']]),
    appliedFiles: new Map([['a.txt', 'old']]),
  });
  assert.equal(result.action, 'confirm');
  assert.equal(result.reason, 'clock-skew');
  assert.equal(result.skewMs, 2 * 60 * 1000);
});

test('LWW-05 内容一致 → 幂等跳过', () => {
  const result = decide({
    remote: { createdAt: T(0) },
    lastApplied: { createdAt: T(0) },
    localFiles: new Map([['a.txt', 'same']]),
    appliedFiles: new Map([['a.txt', 'same']]),
  });
  assert.equal(result.action, 'skip');
  assert.equal(result.reason, 'in-sync');
});

test('decide：无远端包时走首次上传', () => {
  const result = decide({ remote: null });
  assert.equal(result.action, 'push');
  assert.equal(result.reason, 'remote-missing');
});

test('LWW-09 远端旧包不能覆盖本机新数据', () => {
  const result = decide({
    remote: { createdAt: T(4) },
    lastApplied: { createdAt: T(0) },
    lastUploaded: { createdAt: T(10) },
    localFiles: new Map([['a.txt', 'new']]),
    appliedFiles: new Map([['a.txt', 'old']]),
  });
  assert.equal(result.action, 'push');
  assert.equal(result.reason, 'local-newer');
});

test('LWW-10 远端就是本机上次上传的包：无改动跳过，有改动推动上传', () => {
  const base = {
    remote: { packageId: 'p1', createdAt: T(10) },
    lastUploaded: { packageId: 'p1', createdAt: T(10) },
  };
  const unchanged = decide({ ...base, localFiles: new Map([['a.txt', '1']]), appliedFiles: new Map([['a.txt', '1']]) });
  assert.equal(unchanged.action, 'skip');
  assert.equal(unchanged.reason, 'in-sync');
  const changed = decide({ ...base, localFiles: new Map([['a.txt', '2']]), appliedFiles: new Map([['a.txt', '1']]) });
  assert.equal(changed.action, 'push');
  assert.equal(changed.reason, 'local-changed-since-upload');
});

test('detectLocalChanges：新增、删除、内容变化都算改动', () => {
  const applied = new Map([['a', '1'], ['b', '2']]);
  assert.equal(detectLocalChanges(new Map([['a', '1'], ['b', '2']]), applied), false);
  assert.equal(detectLocalChanges(new Map([['a', '9'], ['b', '2']]), applied), true);
  assert.equal(detectLocalChanges(new Map([['a', '1'], ['b', '2'], ['c', '3']]), applied), true);
  assert.equal(detectLocalChanges(new Map([['a', '1']]), applied), true);
  assert.equal(detectLocalChanges(undefined, applied), false);
});
