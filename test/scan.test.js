import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { isExcluded, isReservedName, MAX_FILE_BYTES, scanAssets } from '../src/scan.ts';

const fixtures = join(import.meta.dirname, 'fixtures');
const fx = (name) => join(fixtures, name);
const scanFx = (name, options = {}) =>
  scanAssets({ dshHome: join(fx(name), 'dsh-home'), userHome: join(fx(name), 'user-home'), ...options });

function tempTree() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-user-sync-'));
  const dshHome = join(root, 'dsh-home');
  const userHome = join(root, 'user-home');
  mkdirSync(join(dshHome, 'profiles', 'desktop'), { recursive: true });
  mkdirSync(join(userHome, '.agents', 'skills'), { recursive: true });
  return { root, dshHome, userHome };
}

test('SCAN-01 默认选中集不含 sessions / projects / daily', () => {
  const { entries } = scanFx('fx-full');
  const paths = entries.map((e) => e.path);
  assert.ok(paths.some((p) => p.startsWith('skills/')));
  assert.ok(paths.some((p) => p === 'profiles/desktop/cordis.patch.yml'));
  assert.ok(paths.some((p) => p === 'memories/MEMORY.md'));
  assert.ok(!paths.some((p) => p.startsWith('sessions/')));
  assert.ok(!paths.some((p) => p.startsWith('memories/projects/')));
  assert.ok(!paths.some((p) => p.startsWith('memories/daily/')));
});

test('SCAN-02 白名单命中：profile 声明文件与 AGENTS.md', () => {
  const { entries } = scanFx('fx-minimal');
  const paths = entries.map((e) => e.path).sort();
  assert.deepEqual(paths, [
    'AGENTS.md',
    'memories/MEMORY.md',
    'profiles/desktop/cordis.patch.yml',
    'profiles/desktop/cordis.yml',
    'profiles/desktop/package.json',
    'profiles/desktop/pnpm-workspace.yaml',
  ]);
});

test('SCAN-03 .npmrc 不收录且不报错', () => {
  const { root, dshHome, userHome } = tempTree();
  try {
    writeFileSync(join(dshHome, 'profiles', 'desktop', 'package.json'), '{}');
    writeFileSync(join(dshHome, 'profiles', 'desktop', '.npmrc'), 'registry=https://example.invalid/');
    const { entries, errors } = scanAssets({ dshHome, userHome });
    assert.ok(!entries.some((e) => e.path.endsWith('.npmrc')));
    assert.equal(errors.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SCAN-04 忽略规则：node_modules / *.map / *.bak-* / .DS_Store', () => {
  const { root, dshHome, userHome } = tempTree();
  try {
    const skill = join(userHome, '.agents', 'skills', 'foo');
    mkdirSync(join(skill, 'node_modules'), { recursive: true });
    writeFileSync(join(skill, 'SKILL.md'), '# foo\n');
    writeFileSync(join(skill, 'node_modules', 'x.js'), 'x');
    writeFileSync(join(skill, 'a.map'), 'm');
    writeFileSync(join(skill, 'a.yml.bak-20261023'), 'b');
    writeFileSync(join(skill, '.DS_Store'), 'd');
    const { entries } = scanAssets({ dshHome, userHome });
    const paths = entries.map((e) => e.path);
    assert.ok(paths.includes('skills/foo/SKILL.md'));
    assert.ok(!paths.some((p) => p.includes('node_modules')));
    assert.ok(!paths.some((p) => p.endsWith('.map')));
    assert.ok(!paths.some((p) => p.includes('.bak-')));
    assert.ok(!paths.some((p) => p.endsWith('.DS_Store')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SCAN-05 单文件超过 8 MiB 拒绝并列出', () => {
  const { root, dshHome, userHome } = tempTree();
  try {
    const skill = join(userHome, '.agents', 'skills', 'big');
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, 'SKILL.md'), '# big\n');
    writeFileSync(join(skill, 'blob.bin'), Buffer.alloc(MAX_FILE_BYTES + 1));
    const { errors } = scanAssets({ dshHome, userHome });
    assert.ok(errors.some((e) => e.code === 'E_FILE_TOO_LARGE' && e.path === 'skills/big/blob.bin'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SCAN-06 包总量超过 10 MiB 拒绝', () => {
  const { root, dshHome, userHome } = tempTree();
  try {
    const skill = join(userHome, '.agents', 'skills', 'huge');
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, 'SKILL.md'), '# huge\n');
    writeFileSync(join(skill, 'a.bin'), Buffer.alloc(6 * 1024 * 1024));
    writeFileSync(join(skill, 'b.bin'), Buffer.alloc(6 * 1024 * 1024));
    const { errors } = scanAssets({ dshHome, userHome });
    assert.ok(errors.some((e) => e.code === 'E_TOTAL_TOO_LARGE'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SCAN-07 符号链接不跟随，记录 mode 与目标', (t) => {
  const { root, dshHome, userHome } = tempTree();
  try {
    const skill = join(userHome, '.agents', 'skills', 'linked');
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, 'SKILL.md'), '# linked\n');
    const target = join(root, 'outside.txt');
    writeFileSync(target, 'outside');
    try {
      symlinkSync(target, join(skill, 'link.txt'), 'file');
    } catch {
      t.skip('当前环境不允许创建符号链接');
      return;
    }
    const { entries } = scanAssets({ dshHome, userHome });
    const link = entries.find((e) => e.path === 'skills/linked/link.txt');
    assert.ok(link);
    assert.equal(link.mode, '120000');
    assert.ok(link.linkTarget.includes('outside.txt'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SCAN-09 模块互斥：每个路径只出现一次', () => {
  const { entries } = scanFx('fx-full', { modules: ['skills', 'plugins', 'config', 'userMemory', 'projectMemory', 'sessions'] });
  const paths = entries.map((e) => e.path);
  assert.equal(new Set(paths).size, paths.length);
});

test('SCAN-10 daily 归 projectMemory，且勾选后才收录', () => {
  const withProject = scanFx('fx-full', { modules: ['skills', 'plugins', 'config', 'userMemory', 'projectMemory'] });
  const daily = withProject.entries.find((e) => e.path === 'memories/daily/2026-10-23.md');
  assert.ok(daily);
  assert.equal(daily.module, 'projectMemory');
  const defaultScan = scanFx('fx-full');
  assert.ok(!defaultScan.entries.some((e) => e.path.startsWith('memories/daily/')));
});

test('SCAN-11 永不收录 storages 与凭据文件', () => {
  const { entries } = scanFx('fx-full', {
    modules: ['skills', 'plugins', 'config', 'userMemory', 'projectMemory', 'sessions'],
  });
  assert.ok(!entries.some((e) => e.path.startsWith('storages/')));
  assert.ok(!entries.some((e) => e.path.endsWith('.credentials.yaml')));
});

test('SCAN-12 技能根不存在时为空，不报错', () => {
  const { entries, errors } = scanFx('fx-minimal');
  assert.ok(!entries.some((e) => e.path.startsWith('skills/')));
  assert.equal(errors.length, 0);
});

test('SCAN-13 Windows 保留名与尾部点/空格', () => {
  assert.equal(isReservedName('CON'), true);
  assert.equal(isReservedName('con.txt'), true);
  assert.equal(isReservedName('LPT9.md'), true);
  assert.equal(isReservedName('name.'), true);
  assert.equal(isReservedName('name '), true);
  assert.equal(isReservedName('console.md'), false);
});

test('SCAN-14 排除模式（glob）生效', () => {
  assert.equal(isExcluded('skills/foo/secret.txt', ['skills/foo/*.txt']), true);
  assert.equal(isExcluded('skills/foo/secret.txt', ['*.txt']), true);
  assert.equal(isExcluded('skills/foo/keep.md', ['*.txt']), false);
  const { entries } = scanFx('fx-full', { excludeGlobs: ['skills/foo/*'] });
  assert.ok(!entries.some((e) => e.path.startsWith('skills/foo/')));
});

test('SCAN-17 空会话（只有元数据）不纳入同步', () => {
  const { root, dshHome, userHome } = tempTree();
  try {
    const workspaceDir = '--H-work-demo--';
    const emptyId = 'session-cccccccc-1111-2222-3333-444444444444';
    const normalId = 'session-dddddddd-1111-2222-3333-444444444444';
    const emptyDir = join(dshHome, 'sessions', workspaceDir, emptyId);
    mkdirSync(emptyDir, { recursive: true });
    writeFileSync(join(emptyDir, 'session.v4.jsonl.zstd'), 'x'); // 324B 量级的空会话
    const normalDir = join(dshHome, 'sessions', workspaceDir, normalId);
    mkdirSync(normalDir, { recursive: true });
    writeFileSync(join(normalDir, 'session.v4.jsonl.zstd'), 'y'.repeat(4096));

    const { entries, skipped } = scanAssets({ dshHome, userHome, modules: ['sessions'] });
    assert.ok(!entries.some((entry) => entry.path.includes(emptyId)), '空会话不应被收录');
    assert.ok(skipped.some((item) => item.reason === 'empty-session'));
    assert.equal(entries.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SCAN-16 会话排除归档并带标题', () => {
  const { root, dshHome, userHome } = tempTree();
  try {
    const workspaceDir = '--H-work-demo--';
    const archivedId = 'session-aaaaaaaa-1111-2222-3333-444444444444';
    const normalId = 'session-bbbbbbbb-1111-2222-3333-444444444444';
    for (const sid of [archivedId, normalId]) {
      const dir = join(dshHome, 'sessions', workspaceDir, sid);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'session.v4.jsonl.zstd'), 'z'.repeat(4096));
    }
    // 工作区注册表：archivedId 已归档，normalId 属于 demo 工作区
    mkdirSync(join(dshHome, 'storages', 'session_projcache', 'sessions'), { recursive: true });
    writeFileSync(
      join(dshHome, 'storages', 'workspace.json'),
      JSON.stringify({
        global: { archivedSessionIds: [archivedId] },
        tables: { workspaces: { ws1: { title: 'demo', sessionIds: [normalId, archivedId] } } },
      }),
    );
    // 会话投影缓存：normalId 有标题
    writeFileSync(
      join(dshHome, 'storages', 'session_projcache', 'sessions', `${normalId}.json`),
      JSON.stringify({ record: { rows: { title: { val: '测试会话标题' } } } }),
    );

    const { entries, skipped } = scanAssets({ dshHome, userHome, modules: ['sessions'] });
    assert.ok(!entries.some((entry) => entry.path.includes(archivedId)), '归档会话不应被收录');
    assert.ok(skipped.some((item) => item.reason === 'archived'), '归档会话应记 skipped');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].title, '测试会话标题');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
