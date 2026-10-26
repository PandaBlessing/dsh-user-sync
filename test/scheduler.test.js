import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createScheduler } from '../src/scheduler.ts';
import { loadState, saveState } from '../src/state.ts';

function tmpState() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sched-'));
  return { dir, statePath: join(dir, 'state.json') };
}

test('SCHED-01 启动检查一次并记录 lastCheckAt / lastDecision', async () => {
  const { dir, statePath } = tmpState();
  try {
    const sync = { check: async () => ({ decision: { action: 'pull', reason: 'remote-newer' }, latest: { name: 'pkg.tar.gz' }, meta: { createdAt: '2026-10-23T10:00:00Z' } }) };
    const scheduler = createScheduler({ sync, statePath });
    const result = await scheduler.runOnce();
    assert.equal(result.decision.action, 'pull');

    const state = loadState(statePath);
    assert.ok(state.lastCheckAt);
    assert.equal(state.lastDecision.action, 'pull');
    assert.equal(state.lastDecision.packageId, 'pkg.tar.gz');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SCHED-02 到点判断：未检查、刚检查、过期', () => {
  const { dir, statePath } = tmpState();
  try {
    const scheduler = createScheduler({ sync: { check: async () => ({}) }, statePath, intervalHours: 6, now: () => 10 * 3_600_000 });
    assert.equal(scheduler.isDue(), true, '从未检查应到点');

    saveState(statePath, { lastCheckAt: new Date(10 * 3_600_000 - 1000).toISOString() });
    assert.equal(scheduler.isDue(), false, '刚检查不应到点');

    saveState(statePath, { lastCheckAt: new Date(10 * 3_600_000 - 7 * 3_600_000).toISOString() });
    assert.equal(scheduler.isDue(), true, '超过间隔应到点');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SCHED-03 autoCheck 关闭时不检查', () => {
  const { dir, statePath } = tmpState();
  try {
    saveState(statePath, { autoCheck: false });
    const scheduler = createScheduler({ sync: { check: async () => ({}) }, statePath, now: () => 0 });
    assert.equal(scheduler.isDue(), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SCHED-04 检查失败记录 lastCheckError 且不抛出', async () => {
  const { dir, statePath } = tmpState();
  try {
    const sync = { check: async () => { throw new Error('network down'); } };
    const scheduler = createScheduler({ sync, statePath });
    const result = await scheduler.runOnce();
    assert.equal(result.error, 'network down');
    const state = loadState(statePath);
    assert.equal(state.lastCheckError, 'network down');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SCHED-05 并发 runOnce 只跑一次', async () => {
  const { dir, statePath } = tmpState();
  try {
    let calls = 0;
    const sync = { check: async () => { calls++; return { decision: { action: 'skip' } }; } };
    const scheduler = createScheduler({ sync, statePath });
    await Promise.all([scheduler.runOnce(), scheduler.runOnce()]);
    assert.equal(calls, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SCHED-06 state 损坏时 scheduler 仍可运行', async () => {
  const { dir, statePath } = tmpState();
  try {
    writeFileSync(statePath, '{broken');
    const sync = { check: async () => ({ decision: { action: 'skip' } }) };
    const scheduler = createScheduler({ sync, statePath });
    const result = await scheduler.runOnce();
    assert.equal(result.decision.action, 'skip');
    assert.ok(loadState(statePath).lastCheckAt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
