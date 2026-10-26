import assert from 'node:assert/strict';
import { test } from 'node:test';

import { installMissing, planPluginRecovery } from '../src/plugins.ts';

test('PLUG-01/02 缺失 bundle 进安装清单，非 bundle 不在 dependencies 里', () => {
  const plan = planPluginRecovery({
    dependencies: {
      '@deepseek-ai/dsh-base': '0.2.1-rc.2',
      'dsh-user-sync': '0.1.0',
    },
    installed: ['@deepseek-ai/dsh-base'],
  });
  assert.deepEqual(plan.missing, [{ name: 'dsh-user-sync', spec: '0.1.0' }]);
  assert.equal(plan.linkDeps.length, 0);
});

test('PLUG-03 link: 与 file: 本地依赖列入手工清单，不自动安装', () => {
  const plan = planPluginRecovery({
    dependencies: {
      '@local/dsh-xiaoai-preset': 'link:C:/Users/xiaoai-preset',
      'local-pkg': 'file:../local-pkg',
    },
    installed: [],
  });
  assert.equal(plan.missing.length, 0);
  assert.deepEqual(plan.linkDeps.map((dep) => dep.name), ['@local/dsh-xiaoai-preset', 'local-pkg']);
});

test('PLUG-01 逐个调用 installBundle，参数为 name@spec', async () => {
  const calls = [];
  const results = await installMissing({
    plan: { missing: [{ name: 'dsh-a', spec: '^1.0.0' }, { name: 'dsh-b', spec: '2.0.0' }], linkDeps: [] },
    installBundle: async (spec) => {
      calls.push(spec);
    },
  });
  assert.deepEqual(calls, ['dsh-a@^1.0.0', 'dsh-b@2.0.0']);
  assert.ok(results.every((item) => item.ok));
});

test('PLUG-04 单个安装失败不阻塞其余，结果逐项记录', async () => {
  const results = await installMissing({
    plan: { missing: [{ name: 'bad', spec: '1' }, { name: 'good', spec: '1' }], linkDeps: [] },
    installBundle: async (spec) => {
      if (spec.startsWith('bad')) throw new Error('not-bundle');
    },
  });
  assert.equal(results[0].ok, false);
  assert.match(results[0].error, /not-bundle/);
  assert.equal(results[1].ok, true);
});

test('PLUG-05 已安装且 spec 一致的包不重复安装', () => {
  const plan = planPluginRecovery({
    dependencies: { 'dsh-user-sync': '0.1.0' },
    installed: ['dsh-user-sync'],
  });
  assert.equal(plan.missing.length, 0);
});

test('空 dependencies 返回空计划', () => {
  const plan = planPluginRecovery({ dependencies: {}, installed: [] });
  assert.deepEqual(plan, { missing: [], linkDeps: [] });
});
