import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { apply, DEFAULT_BASE_URL, inject, name } from '../src/index.ts';

function mockCtx({
  profileContext = { home: join(tmpdir(), 'dsh-home'), name: 'desktop' },
  connection,
  pluginManager,
} = {}) {
  const routes = [];
  const effects = [];
  return {
    routes,
    effects,
    ctx: {
      get: (key, fallback) => {
        if (key === 'profileContext') return profileContext;
        if (key === 'connection') return connection;
        if (key === 'pluginManager') return pluginManager;
        return fallback;
      },
      inject: (deps, callback) => {
        if (deps.includes('connection')) {
          callback({
            get: (key) => (key === 'connection' ? connection : undefined),
            effect: (fn, label) => {
              effects.push({ label, disposer: fn() });
            },
          });
        } else if (deps.includes('pluginManager')) {
          callback({ get: (key) => (key === 'pluginManager' ? pluginManager : undefined), effect: () => {} });
        } else {
          callback({ get: () => undefined, effect: () => {} });
        }
      },
      effect: (fn, label) => {
        effects.push({ label, disposer: fn() });
      },
      logger: () => ({ info: () => {} }),
    },
  };
}

test('宿主入口：导出 name/inject，apply 注册全部路由', () => {
  assert.equal(name, 'dsh-user-sync');
  assert.deepEqual(inject, []);

  const { ctx, routes } = mockCtx({ connection: { fetch: { register: (route) => (routes.push(route), () => {}) } } });
  const result = apply(ctx);
  assert.ok(result?.paths?.dshHome);
  assert.equal(result.paths.profileName, 'desktop');
  assert.deepEqual(routes.map((route) => route.path).sort(), [
    '/api/dsh-user-sync/apply',
    '/api/dsh-user-sync/check',
    '/api/dsh-user-sync/config',
    '/api/dsh-user-sync/consent',
    '/api/dsh-user-sync/feedback',
    '/api/dsh-user-sync/install',
    '/api/dsh-user-sync/ping',
    '/api/dsh-user-sync/scan',
    '/api/dsh-user-sync/status',
    '/api/dsh-user-sync/switch-env',
    '/api/dsh-user-sync/update',
    '/api/dsh-user-sync/update-check',
    '/api/dsh-user-sync/upload',
  ]);
  const status = routes.find((route) => route.path === '/api/dsh-user-sync/status');
  assert.deepEqual(status.methods, ['GET']);
});

test('路由在 connection 服务晚到时才注册（回归：服务未就绪不应静默失败）', () => {
  const tmpHome = mkdtempSync(join(tmpdir(), 'dsh-timing-'));
  const routes = [];
  const effects = [];
  let deliverConnection = null;
  const ctx = {
    get: (key, fallback) => (key === 'profileContext' ? { home: tmpHome, name: 'desktop' } : fallback),
    inject: (deps, callback) => {
      if (deps.includes('connection')) {
        deliverConnection = callback; // 模拟「服务尚未就绪」：先不回调
        return;
      }
      callback({ get: () => undefined, effect: () => {} });
    },
    effect: (fn, label) => {
      effects.push({ label, disposer: fn() });
    },
    logger: () => ({ info: () => {} }),
  };

  apply(ctx);
  assert.equal(routes.length, 0, '服务未就绪时不应注册路由');
  assert.ok(deliverConnection, '应通过 ctx.inject 等待 connection');

  deliverConnection({
    get: (key) => (key === 'connection' ? { fetch: { register: (route) => (routes.push(route), () => {}) } } : undefined),
    effect: (fn) => fn(),
  });
  assert.equal(routes.length, 13, '服务出现后应注册全部路由');

  rmSync(tmpHome, { recursive: true, force: true });
});

test('status 路由返回安装信息与模块列表', async () => {
  const { ctx, routes } = mockCtx({ connection: { fetch: { register: (route) => (routes.push(route), () => {}) } } });
  apply(ctx);
  const status = routes.find((route) => route.path === '/api/dsh-user-sync/status');
  const body = await status.fetch().json();
  assert.equal(body.installed, true);
  // 默认走运营方 API（内置服务地址），不再因为没配 baseUrl 就落到本地目录
  assert.equal(body.transport, 'api');
  assert.ok(Array.isArray(body.modules));
});

test('config 路由拒绝空模块列表', async () => {
  const { ctx, routes } = mockCtx({ connection: { fetch: { register: (route) => (routes.push(route), () => {}) } } });
  apply(ctx);
  const config = routes.find((route) => route.path === '/api/dsh-user-sync/config');
  const response = await config.fetch(new Request('http://local/api/dsh-user-sync/config', { method: 'POST', body: JSON.stringify({ modules: [] }) }));
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error, 'E_NO_VALID_MODULE');
});

test('未同意隐私说明时上传被拒绝（E_CONSENT_REQUIRED）', async () => {
  const { ctx, routes } = mockCtx({ connection: { fetch: { register: (route) => (routes.push(route), () => {}) } } });
  apply(ctx);
  const upload = routes.find((route) => route.path === '/api/dsh-user-sync/upload');
  const response = await upload.fetch(new Request('http://local/api/dsh-user-sync/upload', { method: 'POST' }));
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.code, 'E_CONSENT_REQUIRED');
});

test('install 路由调用 pluginManager.installBundle 并逐项返回', async () => {
  const calls = [];
  const pluginManager = {
    listBundles: async () => [],
    installBundle: async (spec) => {
      calls.push(spec);
    },
  };
  const { ctx, routes } = mockCtx({
    connection: { fetch: { register: (route) => (routes.push(route), () => {}) } },
    pluginManager,
  });
  apply(ctx);
  const install = routes.find((route) => route.path === '/api/dsh-user-sync/install');
  const response = await install.fetch(
    new Request('http://local/api/dsh-user-sync/install', {
      method: 'POST',
      body: JSON.stringify({ packages: [{ name: 'dsh-x', spec: '^1.0.0' }] }),
    }),
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.deepEqual(calls, ['dsh-x@^1.0.0']);
});

test('install 路由在 pluginManager 缺失时返回 503', async () => {
  const { ctx, routes } = mockCtx({ connection: { fetch: { register: (route) => (routes.push(route), () => {}) } } });
  apply(ctx);
  const install = routes.find((route) => route.path === '/api/dsh-user-sync/install');
  const response = await install.fetch(new Request('http://local/api/dsh-user-sync/install', { method: 'POST', body: '{}' }));
  assert.equal(response.status, 503);
});

test('无 connection 服务时只挂载生命周期，不抛错', () => {
  const { ctx, routes, effects } = mockCtx();
  const result = apply(ctx);
  assert.ok(result);
  assert.equal(routes.length, 0);
  assert.ok(effects.some((effect) => effect.label === 'dsh-user-sync: lifecycle'));
});

test('插件自身错误写入 plugin-error.log 且不向外抛', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-plugin-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const ctx = {
      get: (key, fallback) => (key === 'profileContext' ? { home, name: 'desktop' } : fallback),
      effect: () => {
        throw new Error('boom-effect');
      },
      logger: undefined,
    };
    assert.doesNotThrow(() => apply(ctx));
    const logPath = join(home, 'user-sync', 'plugin-error.log');
    assert.ok(existsSync(logPath), '应写入 plugin-error.log');
    assert.match(readFileSync(logPath, 'utf8'), /boom-effect/);
  } finally {
    process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test('scan 路由计数覆盖全部模块（未勾选也显示数量）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-scan-'));
  try {
    const profileDir = join(home, 'profiles', 'desktop');
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(join(profileDir, 'package.json'), '{}');
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]');

    const { ctx, routes } = mockCtx({
      profileContext: { home, name: 'desktop' },
      connection: { fetch: { register: (route) => (routes.push(route), () => {}) } },
    });
    apply(ctx);
    const scan = routes.find((route) => route.path === '/api/dsh-user-sync/scan');
    const body = await (await scan.fetch()).json();
    assert.ok(body.counts.plugins >= 1, '未勾选插件清单时也应统计数量');
    assert.ok(body.counts.config >= 1, '配置模块数量');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('PLUG-09 所有 Fetch 路由声明 requestBody: buffered', () => {
  const { ctx, routes } = mockCtx({ connection: { fetch: { register: (route) => (routes.push(route), () => {}) } } });
  apply(ctx);
  assert.ok(routes.length > 0);
  for (const route of routes) {
    // 缺省会走 streaming 分支，GET 请求被 web 层转成 400 空响应（2026-10-23 事故）
    assert.equal(route.requestBody, 'buffered', `${route.path} 缺少 requestBody: 'buffered'`);
  }
});

test('PLUG-10 组合包 patch 的 name 与 package.json 包名一致', () => {
  const root = join(import.meta.dirname, '..');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8');
  const match = patch.match(/^\s*name:\s*"?([^"\n]+)"?\s*$/m);
  assert.ok(match, 'cordis.patch.yml 应有 name 条目');
  assert.equal(match[1].trim(), pkg.name, 'patch 的 name 必须与 package.json 的 name 一致（否则安装后 ERR_MODULE_NOT_FOUND）');
});

test('PLUG-11 未配置地址时使用内置服务地址（默认走 api 传输）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-default-url-'));
  try {
    const { ctx, routes } = mockCtx({
      profileContext: { home, name: 'desktop' },
      connection: { fetch: { register: (route) => (routes.push(route), () => {}) } },
    });
    apply(ctx);
    const status = routes.find((route) => route.path === '/api/dsh-user-sync/status');
    const body = await (await status.fetch()).json();
    // 全新机器没有 state.baseUrl：必须落到内置地址，而不是本地目录（否则永远不配对）
    assert.equal(body.baseUrl, DEFAULT_BASE_URL);
    assert.equal(body.baseUrlSource, 'default');
    assert.equal(body.transport, 'api');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('PLUG-12 state.baseUrl 覆盖内置地址', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-custom-url-'));
  try {
    mkdirSync(join(home, 'user-sync'), { recursive: true });
    writeFileSync(join(home, 'user-sync', 'state.json'), JSON.stringify({ baseUrl: 'https://sync.example.com' }));
    const { ctx, routes } = mockCtx({
      profileContext: { home, name: 'desktop' },
      connection: { fetch: { register: (route) => (routes.push(route), () => {}) } },
    });
    apply(ctx);
    const status = routes.find((route) => route.path === '/api/dsh-user-sync/status');
    const body = await (await status.fetch()).json();
    assert.equal(body.baseUrl, 'https://sync.example.com');
    assert.equal(body.baseUrlSource, 'user');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('PLUG-13 client bundle 的注册 id 等于 npm 包名（module-loader 契约）', () => {
  const root = join(import.meta.dirname, '..');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const source = readFileSync(join(root, 'src', 'client.ts'), 'utf8');
  const match = source.match(/const PACKAGE_NAME = '([^']+)'/);
  assert.ok(match, 'src/client.ts 应声明 PACKAGE_NAME 常量');
  assert.equal(match[1], pkg.name, '注册 id 与包名不一致会导致面板加载失败或与旧名冲突');
  assert.ok(source.includes('duplicate factory registration'), 'client 入口应对重复注册做容错');
});
