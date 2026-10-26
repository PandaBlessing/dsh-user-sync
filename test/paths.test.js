import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { join } from 'node:path';

import {
  DEFAULT_PROFILE,
  isInside,
  isUnsafeRelPath,
  resolveInside,
  resolvePaths,
  toLongPath,
  toPosix,
} from '../src/paths.ts';

const userHome = join('C:', 'Users', 'tester');

test('PATH-01 profileContext.home 优先于 DSH_HOME', () => {
  const paths = resolvePaths({
    profileContext: { home: join('D:', 'custom-home'), name: 'desktop' },
    env: { DSH_HOME: join('E:', 'env-home') },
    userHome,
  });
  assert.equal(paths.dshHome, join('D:', 'custom-home'));
  assert.equal(paths.resolvedBy, 'profileContext');
});

test('PATH-02 profileContext.name 优先，缺省为 desktop', () => {
  const named = resolvePaths({ profileContext: { home: userHome, name: 'work' }, env: {}, userHome });
  assert.equal(named.profileName, 'work');
  assert.equal(named.profileDir, join(userHome, 'profiles', 'work'));

  const unnamed = resolvePaths({ profileContext: { home: userHome }, env: {}, userHome });
  assert.equal(unnamed.profileName, DEFAULT_PROFILE);
});

test('PATH-03 无 profileContext 时回退 DSH_HOME', () => {
  const paths = resolvePaths({ env: { DSH_HOME: join('E:', 'env-home') }, userHome });
  assert.equal(paths.dshHome, join('E:', 'env-home'));
  assert.equal(paths.resolvedBy, 'fallback');
});

test('PATH-04 全部缺失时回退 ~/.dsh 与 desktop', () => {
  const paths = resolvePaths({ env: {}, userHome });
  assert.equal(paths.dshHome, join(userHome, '.dsh'));
  assert.equal(paths.profileName, 'desktop');
  assert.equal(paths.resolvedBy, 'default');
});

test('PATH-05 技能根取 userHome 下，跨两个根', () => {
  const paths = resolvePaths({ profileContext: { home: join('D:', 'dsh-home'), name: 'desktop' }, userHome });
  assert.equal(paths.skillsRoot, join(userHome, '.agents', 'skills'));
  assert.ok(!paths.skillsRoot.startsWith(paths.dshHome));
});

test('toPosix 把反斜杠归一化为斜杠', () => {
  assert.equal(toPosix('skills\\foo\\SKILL.md'), 'skills/foo/SKILL.md');
  assert.equal(toPosix('skills/foo/SKILL.md'), 'skills/foo/SKILL.md');
});

test('isInside 判断包含关系', () => {
  assert.equal(isInside(join('C:', 'a'), join('C:', 'a', 'b')), true);
  assert.equal(isInside(join('C:', 'a'), join('C:', 'a')), true);
  assert.equal(isInside(join('C:', 'a'), join('C:', 'ab')), false);
});

test('resolveInside 越界时抛错', () => {
  if (process.platform === 'win32') {
    // Windows 的 `..\\b` 是合法分隔符写法，直接验证反斜杠形态
    assert.throws(() => resolveInside(join('C:', 'a'), '..\\b'), /路径越界/);
  }
  // 平台无关：用真实临时目录验证 ../ 越界（`C:` 前缀在 POSIX 上不是绝对路径，不能复用）
  const root = mkdtempSync(join(tmpdir(), 'dsh-paths-'));
  try {
    assert.throws(() => resolveInside(root, '../b'), /路径越界/);
    assert.equal(resolveInside(root, 'b/c.txt'), join(root, 'b', 'c.txt'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('toLongPath 在 Windows 上加 \\\\?\\ 前缀', () => {
  if (process.platform !== 'win32') return;
  const abs = join('C:', 'a', 'b');
  assert.ok(toLongPath(abs).startsWith('\\\\?\\'));
  assert.equal(toLongPath('\\\\?\\C:\\a'), '\\\\?\\C:\\a');
});

test('ARCH-08 包内路径穿越与危险字符', () => {
  assert.equal(isUnsafeRelPath('skills/foo/SKILL.md'), false);
  assert.equal(isUnsafeRelPath('../x'), true);
  assert.equal(isUnsafeRelPath('skills/../../x'), true);
  assert.equal(isUnsafeRelPath('skills\\foo'), true);
  assert.equal(isUnsafeRelPath('skills//foo'), true);
  assert.equal(isUnsafeRelPath(''), true);
  assert.equal(isUnsafeRelPath('a\u0000b'), true);
});
