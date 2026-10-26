import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { applyEntries, planApply } from '../src/apply.ts';
import { hashBytes } from '../src/hash.ts';
import { restoreSnapshot } from '../src/state.ts';

const fileEntry = (path, text) => ({ path, type: 'file', mode: '100644', data: Buffer.from(text, 'utf8') });

test('APPLY-01 覆盖前快照保留原文件', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-apply-'));
  try {
    const target = join(root, 'home');
    const snapshot = join(root, 'snap');
    mkdirSync(join(target, 'profiles', 'desktop'), { recursive: true });
    writeFileSync(join(target, 'profiles', 'desktop', 'cordis.patch.yml'), 'old');

    applyEntries({ entries: [fileEntry('profiles/desktop/cordis.patch.yml', 'new')], targetRoot: target, preRestoreRoot: snapshot });

    assert.equal(readFileSync(join(target, 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8'), 'new');
    assert.equal(readFileSync(join(snapshot, 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8'), 'old');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('APPLY-02 原子写：目录里不残留 tmp 文件', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-apply-'));
  try {
    const target = join(root, 'home');
    const snapshot = join(root, 'snap');
    mkdirSync(target, { recursive: true });
    applyEntries({ entries: [fileEntry('a.txt', 'hello')], targetRoot: target, preRestoreRoot: snapshot });
    const leftovers = readdirSync(target).filter((name) => name.includes('.tmp-'));
    assert.deepEqual(leftovers, []);
    assert.equal(readFileSync(join(target, 'a.txt'), 'utf8'), 'hello');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('APPLY-03 写盘失败时整批还原', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-apply-'));
  try {
    const target = join(root, 'home');
    const snapshot = join(root, 'snap');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'b.txt'), 'original');
    // a.txt 在磁盘上是一个目录：写入必失败，用来触发回滚
    mkdirSync(join(target, 'a.txt'));

    assert.throws(() =>
      applyEntries({
        entries: [fileEntry('b.txt', 'changed'), fileEntry('a.txt', 'boom')],
        targetRoot: target,
        preRestoreRoot: snapshot,
      }),
    );
    assert.equal(readFileSync(join(target, 'b.txt'), 'utf8'), 'original', 'b.txt 应已还原');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('APPLY-04 dryRun 不写盘', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-apply-'));
  try {
    const target = join(root, 'home');
    mkdirSync(target, { recursive: true });
    const result = applyEntries({ entries: [fileEntry('a.txt', 'x')], targetRoot: target, preRestoreRoot: join(root, 'snap'), dryRun: true });
    assert.equal(result.written.length, 0);
    assert.ok(!existsSync(join(target, 'a.txt')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('APPLY-06 内容等价不写盘，mtime 不变', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-apply-'));
  try {
    const target = join(root, 'home');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'a.txt'), 'same');
    const before = statSync(join(target, 'a.txt')).mtimeMs;
    const result = applyEntries({ entries: [fileEntry('a.txt', 'same')], targetRoot: target, preRestoreRoot: join(root, 'snap') });
    assert.deepEqual(result.written, []);
    assert.deepEqual(result.skipped, ['a.txt']);
    assert.equal(statSync(join(target, 'a.txt')).mtimeMs, before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('APPLY-07 大小写冲突拒绝应用', () => {
  assert.throws(
    () =>
      applyEntries({
        entries: [fileEntry('skills/Foo/SKILL.md', 'a'), fileEntry('skills/foo/SKILL.md', 'b')],
        targetRoot: join(tmpdir(), 'unused'),
        preRestoreRoot: join(tmpdir(), 'unused-snap'),
      }),
    /大小写冲突/,
  );
});

test('planApply：新增 / 覆盖 / 跳过三态', () => {
  const plan = planApply({
    manifestFiles: [
      { path: 'a.txt', sha256: '1' },
      { path: 'b.txt', sha256: '2' },
      { path: 'c.txt', sha256: '3' },
    ],
    localFiles: new Map([['a.txt', '1'], ['b.txt', 'x']]),
  });
  assert.equal(plan.added.length, 1);
  assert.equal(plan.overwritten.length, 1);
  assert.equal(plan.skipped.length, 1);
});

test('APPLY-05 快照可整批还原', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-apply-'));
  try {
    const target = join(root, 'home');
    const snapshot = join(root, 'snap');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'a.txt'), 'old');
    applyEntries({ entries: [fileEntry('a.txt', 'new')], targetRoot: target, preRestoreRoot: snapshot });
    assert.equal(readFileSync(join(target, 'a.txt'), 'utf8'), 'new');
    restoreSnapshot({ snapshotRoot: snapshot, targetRoot: target });
    assert.equal(readFileSync(join(target, 'a.txt'), 'utf8'), 'old');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('LWW-06 文件只在包里 → 新增；LWW-07 文件只在本地 → 保留', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-apply-'));
  try {
    const target = join(root, 'home');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'local-only.txt'), 'keep me');
    const plan = planApply({ manifestFiles: [{ path: 'from-package.txt', sha256: 'a' }], localFiles: new Map() });
    assert.equal(plan.added.length, 1);

    applyEntries({ entries: [fileEntry('from-package.txt', 'pkg')], targetRoot: target, preRestoreRoot: join(root, 'snap') });
    assert.ok(existsSync(join(target, 'from-package.txt')));
    assert.equal(readFileSync(join(target, 'local-only.txt'), 'utf8'), 'keep me', '本地独有文件不应被删除');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
