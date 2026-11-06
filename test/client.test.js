import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const clientPath = join(import.meta.dirname, '..', 'lib', 'client.js');
const packageName = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')).name;

/** 在 Node 里模拟 window.__ModuleLoader__，捕获 client bundle 的导出。 */
function loadClientBundle() {
  const source = readFileSync(clientPath, 'utf8');
  let exported;
  const fakeWindow = {
    __ModuleLoader__: {
      load({ id, factory }) {
        const module = { exports: {} };
        const require = (name) => {
          if (name === 'react') {
            return { createElement: (...args) => ({ type: args[0], props: args[1], children: args.slice(2) }) };
          }
          throw new Error(`unexpected require: ${name}`);
        };
        exported = factory(require);
        // module-loader 契约：注册 id 必须等于 npm 包名
        assert.equal(id, packageName);
      },
    },
  };
  // client.js 是普通脚本（非 ESM），用 Function 注入 window
  const run = new Function('window', source);
  run(fakeWindow);
  return exported;
}

test('client bundle 导出 apply 与 inject，inject 是服务名 slots', () => {
  const exported = loadClientBundle();
  assert.equal(typeof exported.apply, 'function');
  assert.deepEqual(exported.inject, ['slots']);
});

test('client apply 注册 settings.section 面板', () => {
  const exported = loadClientBundle();
  const registered = [];
  const slots = {
    inject: (name, callback) => {
      assert.ok(['settings.section', 'plugins.bundle.config'].includes(name), name);
      callback();
    },
    register: (descriptor, component) => {
      registered.push({ descriptor, component });
      return () => {};
    },
  };
  const ctx = { slots };
  exported.apply(ctx);
  assert.equal(registered.length, 2, '设置面板 + 详情页配置卡片');
  const byName = (name) => registered.find((item) => item.descriptor.name === name);
  assert.ok(byName('settings.section'), '设置面板');
  assert.ok(byName('plugins.bundle.config'), '详情页配置卡片');
  assert.equal(registered[0].descriptor.id, 'user-sync');
  assert.equal(registered[0].descriptor.order, 50);
  assert.equal(typeof registered[0].component, 'function');
});

test('client apply 在缺少 slots 服务时不抛错，只记录（不拖垮 web boot）', () => {
  const exported = loadClientBundle();
  const original = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args);
  try {
    assert.doesNotThrow(() => exported.apply({}));
  } finally {
    console.error = original;
  }
  assert.ok(errors.length > 0, '应记录错误');
});
