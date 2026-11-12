import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isVersionNewer, planPluginSync, versionBase } from '../src/plugins-sync.ts';

test('planPluginSync：缺失的依赖需要安装', () => {
  const plan = planPluginSync({ dependencies: { 'dsh-feishu': '^0.17.0' }, installed: {} });
  assert.deepEqual(plan.install, [{ name: 'dsh-feishu', spec: '^0.17.0', reason: 'missing' }]);
  assert.deepEqual(plan.remove, []);
  assert.deepEqual(plan.managed, ['dsh-feishu']);
});

test('planPluginSync：已装版本满足声明时不重装', () => {
  const plan = planPluginSync({ dependencies: { 'dsh-feishu': '^0.17.0' }, installed: { 'dsh-feishu': '0.17.0' } });
  assert.deepEqual(plan.install, []);
});

test('planPluginSync：已装版本落后时标记 outdated', () => {
  const plan = planPluginSync({ dependencies: { 'dsh-feishu': '^0.18.0' }, installed: { 'dsh-feishu': '0.17.0' } });
  assert.deepEqual(plan.install, [{ name: 'dsh-feishu', spec: '^0.18.0', reason: 'outdated', installed: '0.17.0' }]);
});

test('planPluginSync：link/file 依赖只提示，不安装也不纳入管理', () => {
  const plan = planPluginSync({
    dependencies: { 'dsh-user-sync': 'link:../dsh-user-sync', 'dsh-feishu': 'file:./feishu.tgz' },
    installed: {},
  });
  assert.deepEqual(plan.install, []);
  assert.deepEqual(plan.managed, []);
  assert.deepEqual(plan.linkDeps.map((item) => item.name), ['dsh-user-sync', 'dsh-feishu']);
});

test('planPluginSync：有历史管理记录时移除本次不再声明的插件', () => {
  const plan = planPluginSync({
    dependencies: { 'dsh-feishu': '^0.17.0' },
    installed: { 'dsh-feishu': '0.17.0' },
    managed: ['dsh-feishu', 'dsh-vscode-mode'],
  });
  assert.deepEqual(plan.remove, ['dsh-vscode-mode']);
});

test('planPluginSync：首次同步（无管理记录）不执行移除', () => {
  const plan = planPluginSync({ dependencies: { 'dsh-feishu': '^0.17.0' }, installed: { 'dsh-feishu': '0.17.0' }, managed: null });
  assert.deepEqual(plan.remove, []);
});

test('planPluginSync：历史记录里的本地链接依赖不会被移除', () => {
  const plan = planPluginSync({
    dependencies: { 'dsh-user-sync': 'link:../dsh-user-sync' },
    installed: { 'dsh-user-sync': '1.0.34' },
    managed: ['dsh-user-sync'],
  });
  assert.deepEqual(plan.remove, []);
});

test('planPluginSync：声明无法解析出版本时不判定落后', () => {
  const plan = planPluginSync({ dependencies: { 'dsh-feishu': 'latest' }, installed: { 'dsh-feishu': '0.1.0' } });
  assert.deepEqual(plan.install, []);
});

test('versionBase：从范围里取版本基线', () => {
  assert.equal(versionBase('^0.31.1'), '0.31.1');
  assert.equal(versionBase('~1.2.3'), '1.2.3');
  assert.equal(versionBase('1.2.3 || 1.2.4'), '1.2.3');
  assert.equal(versionBase('latest'), null);
});

test('isVersionNewer：比较 x.y.z 数字段', () => {
  assert.equal(isVersionNewer('0.18.0', '0.17.0'), true);
  assert.equal(isVersionNewer('0.17.0', '0.17.0'), false);
  assert.equal(isVersionNewer('1.0.0', '0.99.99'), true);
});
