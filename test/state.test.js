import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  acquireLock,
  appendHistory,
  cleanupPackages,
  heartbeatLock,
  HISTORY_LIMIT,
  loadState,
  releaseLock,
  saveState,
} from '../src/state.ts';

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'dsh-state-'));
}

test('LOCK-01 活锁拒绝', () => {
  const root = tempRoot();
  try {
    const lockPath = join(root, 'lock');
    const first = acquireLock({ lockPath, pid: 100, now: 1000 });
    assert.equal(first.acquired, true);
    const second = acquireLock({ lockPath, pid: 200, now: 1001 });
    assert.equal(second.acquired, false);
    assert.equal(second.holder.pid, 100);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('LOCK-02 心跳超 90 秒视为僵死，允许抢占并标注', () => {
  const root = tempRoot();
  try {
    const lockPath = join(root, 'lock');
    acquireLock({ lockPath, pid: 100, now: 0 });
    const stolen = acquireLock({ lockPath, pid: 200, now: 90_000 });
    assert.equal(stolen.acquired, true);
    assert.equal(stolen.stolen, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('LOCK-03 心跳写入与释放只影响自己的锁', () => {
  const root = tempRoot();
  try {
    const lockPath = join(root, 'lock');
    acquireLock({ lockPath, pid: 100, now: 0 });
    assert.equal(heartbeatLock({ lockPath, pid: 100, now: 30_000 }), true);
    const raw = JSON.parse(readFileSync(lockPath, 'utf8'));
    assert.equal(raw.heartbeat, 30_000);
    assert.equal(releaseLock({ lockPath, pid: 999 }), false);
    assert.equal(releaseLock({ lockPath, pid: 100 }), true);
    assert.ok(!existsSync(lockPath));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('LOCK-04 锁文件损坏时视为僵死', () => {
  const root = tempRoot();
  try {
    const lockPath = join(root, 'lock');
    writeFileSync(lockPath, 'not-json');
    const result = acquireLock({ lockPath, pid: 200, now: 0 });
    assert.equal(result.acquired, true);
    assert.equal(result.stolen, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('state 读写往返，损坏时回退空状态', () => {
  const root = tempRoot();
  try {
    const statePath = join(root, 'state.json');
    saveState(statePath, { deviceId: 'a1b2c3d4', files: { 'a.txt': { sha256: 'x' } } });
    const state = loadState(statePath);
    assert.equal(state.deviceId, 'a1b2c3d4');
    assert.equal(state.files['a.txt'].sha256, 'x');
    writeFileSync(statePath, '{broken');
    assert.equal(loadState(statePath).deviceId, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('APPLY-08 审计只保留最近 200 行', () => {
  const root = tempRoot();
  try {
    const historyPath = join(root, 'history.jsonl');
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) {
      appendHistory(historyPath, { at: i, action: 'backup' });
    }
    const lines = readFileSync(historyPath, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, HISTORY_LIMIT);
    assert.equal(JSON.parse(lines[0]).at, 5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('APPLY-09 清理只删自己的包，keep<=0 不清理', () => {
  const root = tempRoot();
  try {
    const dir = join(root, 'packages');
    mkdirSync(dir, { recursive: true });
    const d = 'a1b2c3d4';
    writeFileSync(join(dir, `dsh-user-sync-20261001-0900-${d}.tar.gz`), 'a');
    writeFileSync(join(dir, `dsh-user-sync-20261002-0900-${d}.tar.gz`), 'b');
    writeFileSync(join(dir, `dsh-user-sync-20261003-0900-${d}.tar.gz`), 'c');
    writeFileSync(join(dir, 'other.tar.gz'), 'x');

    const now = Date.now() / 1000;
    utimesSync(join(dir, `dsh-user-sync-20261001-0900-${d}.tar.gz`), now - 300, now - 300);
    utimesSync(join(dir, `dsh-user-sync-20261002-0900-${d}.tar.gz`), now - 200, now - 200);
    utimesSync(join(dir, `dsh-user-sync-20261003-0900-${d}.tar.gz`), now - 100, now - 100);

    const keepOne = cleanupPackages({ dir, deviceId: d, keep: 1 });
    assert.deepEqual(keepOne.removed.sort(), [
      `dsh-user-sync-20261001-0900-${d}.tar.gz`,
      `dsh-user-sync-20261002-0900-${d}.tar.gz`,
    ]);
    assert.ok(existsSync(join(dir, `dsh-user-sync-20261003-0900-${d}.tar.gz`)));
    assert.ok(existsSync(join(dir, 'other.tar.gz')));

    cleanupPackages({ dir, deviceId: d, keep: 0 });
    assert.ok(existsSync(join(dir, `dsh-user-sync-20261003-0900-${d}.tar.gz`)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
