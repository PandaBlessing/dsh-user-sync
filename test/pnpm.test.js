import assert from 'node:assert/strict';
import { test } from 'node:test';

import { entryPackageName, sanitizePnpmWorkspace } from '../src/pnpm.ts';

test('entryPackageName：普通包名@版本', () => {
  assert.equal(entryPackageName('dshmarket@1.73.12'), 'dshmarket');
  assert.equal(entryPackageName("'dsh-context@0.82.1'"), 'dsh-context');
});

test('entryPackageName：scoped 包名@版本', () => {
  assert.equal(entryPackageName("'@aiwayds/dsh-feishu@0.17.0'"), '@aiwayds/dsh-feishu');
  assert.equal(entryPackageName('@pandablessing/dsh-user-sync@1.0.34'), '@pandablessing/dsh-user-sync');
});

test('entryPackageName：带 || 的版本范围取第一段', () => {
  assert.equal(entryPackageName("'dshmarket@1.73.12 || 1.73.18'"), 'dshmarket');
  assert.equal(entryPackageName('dshmarket@1.73.12 || 1.73.18'), 'dshmarket');
});

test('entryPackageName：无版本号时整段为包名', () => {
  assert.equal(entryPackageName('some-plugin'), 'some-plugin');
  assert.equal(entryPackageName("'@scope/name'"), '@scope/name');
});

test('sanitizePnpmWorkspace：删除已卸载插件条目，保留仍依赖的条目', () => {
  const text = [
    'packages:',
    '  - .',
    '',
    'minimumReleaseAgeExclude:',
    "  - '@aiwayds/dsh-feishu@0.17.0'",
    '  - dsh-context@0.82.1',
    '  - dshmarket@1.73.12 || 1.73.18',
    '  - dsh-vscode-mode@0.29.1',
    '',
    'allowBuilds:',
    '  cpu-features: true',
    '  ssh2: true',
    '',
  ].join('\n');
  const clean = sanitizePnpmWorkspace(text, {
    dshmarket: '1.73.18',
    'dsh-context': '0.83.1',
    '@aiwayds/dsh-feishu': '0.17.0',
  });
  assert.ok(!clean.includes('dsh-vscode-mode'), '已卸载插件条目应被删除');
  assert.ok(clean.includes("'@aiwayds/dsh-feishu@0.17.0'"));
  assert.ok(clean.includes('dsh-context@0.82.1'));
  assert.ok(clean.includes('dshmarket@1.73.12 || 1.73.18'));
  // allowBuilds 段原样保留（间接依赖不能被 dependencies 过滤误删）
  assert.ok(clean.includes('allowBuilds:'));
  assert.ok(clean.includes('cpu-features: true'));
  assert.ok(clean.includes('ssh2: true'));
});

test('sanitizePnpmWorkspace：dependencies 为空时原文返回', () => {
  const text = 'minimumReleaseAgeExclude:\n  - dsh-vscode-mode@0.29.1\n';
  assert.equal(sanitizePnpmWorkspace(text, {}), text);
});

test('sanitizePnpmWorkspace：条目全被删时改为空列表', () => {
  const text = 'minimumReleaseAgeExclude:\n  - dsh-vscode-mode@0.29.1\n\nallowBuilds:\n  ssh2: true\n';
  const clean = sanitizePnpmWorkspace(text, { other: '1.0.0' });
  assert.ok(clean.includes('minimumReleaseAgeExclude: []'));
  assert.ok(!clean.includes('dsh-vscode-mode'));
  assert.ok(clean.includes('allowBuilds:'));
});

test('sanitizePnpmWorkspace：文件末尾即段结束时也处理', () => {
  const text = 'minimumReleaseAgeExclude:\n  - dsh-vscode-mode@0.29.1';
  const clean = sanitizePnpmWorkspace(text, { other: '1.0.0' });
  assert.equal(clean, 'minimumReleaseAgeExclude: []');
});

test('sanitizePnpmWorkspace：保留 CRLF 行尾', () => {
  const text = 'minimumReleaseAgeExclude:\r\n  - dsh-vscode-mode@0.29.1\r\n  - dsh-context@0.82.1\r\n';
  const clean = sanitizePnpmWorkspace(text, { 'dsh-context': '0.83.1' });
  assert.ok(clean.includes('\r\n'));
  assert.ok(!clean.includes('dsh-vscode-mode'));
  assert.ok(clean.includes('dsh-context@0.82.1'));
});

test('entryPackageName：行尾注释；空串与纯空白返回 null', () => {
  assert.equal(entryPackageName('dshmarket@1.73.18 # pinned'), 'dshmarket');
  assert.equal(entryPackageName("'@scope/name@1.0.0'  # 注释"), '@scope/name');
  assert.equal(entryPackageName(''), null);
  assert.equal(entryPackageName('   '), null);
});
