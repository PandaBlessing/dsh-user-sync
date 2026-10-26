import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadClientBundle } from './helpers/load-client.js';
import { createMiniReact } from './helpers/mini-react.js';

const jsonResponse = (data) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(data),
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup({ status = {}, scan = {}, config = {}, check = {}, install = {}, fetchOverride = null } = {}) {
  const calls = [];
  globalThis.fetch =
    fetchOverride ??
    (async (url, options = {}) => {
      calls.push({ url, options });
      if (url.endsWith('/status')) {
        return jsonResponse({
          installed: true,
          dshHome: 'C:/home',
          profile: 'desktop',
          transport: 'folder',
          transportSetting: 'folder',
          baseUrl: null,
          account: { hint: null, paired: false },
          consent: null,
          scheduler: {},
          ...status,
        });
      }
      if (url.endsWith('/scan')) {
        return jsonResponse({
          modules: ['skills', 'plugins', 'config', 'userMemory'],
          allModules: ['skills', 'plugins', 'config', 'userMemory', 'projectMemory', 'sessions'],
          counts: { skills: 2, plugins: 1, config: 1, userMemory: 1 },
          totalFiles: 5,
          totalBytes: 100,
          ...scan,
        });
      }
      if (url.endsWith('/consent')) return jsonResponse({ consent: { acceptedAt: '2026-10-23T10:00:00Z' } });
      if (url.endsWith('/config')) return jsonResponse({ modules: ['skills'], ...config });
      if (url.endsWith('/check')) {
        return jsonResponse({
          decision: { action: 'pull', reason: 'remote-newer' },
          latest: { name: 'dsh-user-sync-20261023-2000-aaaaaa.tar.gz' },
          meta: { createdAt: '2026-10-23T10:00:00Z' },
          plan: { added: [], overwritten: [], skipped: [] },
          plugins: { missing: [{ name: 'dsh-a', spec: '1.0.0' }], linkDeps: [] },
          ...check,
        });
      }
      if (url.endsWith('/install')) {
        return jsonResponse({ ok: true, results: [{ name: 'dsh-a', ok: true }], ...install });
      }
      return jsonResponse({});
    });
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };

  const mini = createMiniReact();
  const exported = loadClientBundle(mini.React);
  const registered = [];
  exported.apply({
    slots: {
      inject: (_name, callback) => callback(),
      register: (descriptor, component) => {
        registered.push({ descriptor, component });
        return () => {};
      },
    },
  });
  const view = mini.mount(registered[0].component);
  return { view, calls };
}

test('UI：初始渲染显示同意卡与四类默认勾选', async () => {
  const { view } = setup();
  await flush();
  assert.match(view.text(), /启用前请确认/);
  // 模块是按钮（aria-pressed），不是复选框；会话模块已隐藏，剩 5 个
  const moduleButtons = view.buttons().filter((button) => 'aria-pressed' in button.props);
  assert.equal(moduleButtons.length, 5);
  assert.equal(moduleButtons.filter((button) => button.props['aria-pressed']).length, 4, '四类用户级默认选中');
  // 只剩「自动检查远端」一个复选框
  assert.equal(view.checkboxes().length, 1);
});

test('UI：点击同意后同意卡消失（不依赖 status 刷新）', async () => {
  const { view, calls } = setup();
  await flush();
  assert.match(view.text(), /启用前请确认/);

  const button = view.button('同意并启用上传');
  assert.ok(button, '应找到同意按钮');
  button.props.onClick();
  await flush();

  assert.ok(calls.some((call) => call.url.endsWith('/consent')), '应发起 consent 请求');
  assert.ok(!view.text().includes('启用前请确认'), '同意后卡片应消失');
});

test('UI：勾选非用户级模块时弹出确认对话框', async () => {
  const { view, calls } = setup({ config: { warning: ['projectMemory'], note: '非用户级内容可能包含工作内容' } });
  await flush();

  const moduleButtons = view.buttons().filter((button) => 'aria-pressed' in button.props);
  const projectMemory = moduleButtons.find((button) => !button.props['aria-pressed']);
  assert.ok(projectMemory, '应有未选中的模块');
  projectMemory.props.onClick();
  await flush();

  assert.match(view.text(), /同步项目\/会话内容/, '应弹出确认对话框');
  assert.match(view.text(), /仍要同步/);

  // 点「仍要同步」→ 带 confirmNonUserLevel 重发
  view.button('仍要同步').props.onClick();
  await flush();
  const confirmCall = calls.filter((call) => call.url.endsWith('/config') && call.options.method === 'POST').pop();
  assert.match(String(confirmCall.options.body), /confirmNonUserLevel/);
  assert.ok(!view.text().includes('同步项目/会话内容'), '确认后对话框应关闭');

  // 取消场景：再点一个未选中的模块，弹窗后取消
  const another = view.buttons().find((button) => 'aria-pressed' in button.props && !button.props['aria-pressed']);
  if (another) {
    another.props.onClick();
    await flush();
    view.button('取消').props.onClick();
    await flush();
    assert.ok(!view.text().includes('同步项目/会话内容'), '取消后对话框应关闭');
  }
});

test('UI：修改间隔后自动保存（无保存按钮）', async () => {
  const { view, calls } = setup();
  await flush();
  assert.ok(!view.buttons().some((button) => String(button.children?.[0]?.text ?? '').includes('保存设置')), '不应再有保存设置按钮');

  // 找到「间隔（小时）」的 number 输入
  const intervalInput = (function find(node) {
    if (!node) return null;
    if (Array.isArray(node)) return node.map(find).find(Boolean) ?? null;
    if (node.type === 'input' && node.props.type === 'number') return node;
    return (node.children ?? []).map(find).find(Boolean) ?? null;
  })(view.tree);
  assert.ok(intervalInput, '应有间隔输入框');
  intervalInput.props.onChange({ target: { value: '12' } });
  await flush();

  // 防抖 600ms 后自动保存
  await new Promise((resolve) => setTimeout(resolve, 800));
  await flush();

  const configCall = calls.filter((call) => call.url.endsWith('/config') && call.options.method === 'POST').pop();
  assert.ok(configCall, '应自动发起 config 保存');
  const body = String(configCall.options.body);
  assert.match(body, /"intervalHours":12/);
  assert.match(body, /"autoCheck"/);
});

test('UI：status 失败时仍保留已同意状态（localStorage 兜底）', async () => {
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    text: async () => 'unauthorized',
  });
  globalThis.localStorage = { getItem: (key) => (key === 'dsh-user-sync:consent' ? '1' : null), setItem: () => {} };
  const mini = createMiniReact();
  const exported = loadClientBundle(mini.React);
  let component = null;
  exported.apply({
    slots: {
      inject: (_name, callback) => callback(),
      register: (_descriptor, registered) => {
        component = registered;
        return () => {};
      },
    },
  });
  const view = mini.mount(component);
  await flush();
  assert.ok(!view.text().includes('启用前请确认'), '本地已同意时不应再显示同意卡');
});

test('UI-15 服务端 500：状态卡显示接口错误', async () => {
  const { view } = setup({
    fetchOverride: async () => ({ ok: false, status: 500, text: async () => 'boom' }),
  });
  await flush();
  assert.match(view.text(), /接口/);
  assert.match(view.text(), /错误/);
});

test('UI-16 上传 502：显示操作失败与详情', async () => {
  const { view } = setup({
    fetchOverride: async (url) => {
      if (url.endsWith('/status')) {
        return jsonResponse({ installed: true, consent: { acceptedAt: '2026-10-23T10:00:00Z' }, transport: 'folder', transportSetting: 'folder', scheduler: {} });
      }
      if (url.endsWith('/scan')) {
        return jsonResponse({ modules: ['skills', 'plugins', 'config', 'userMemory'], allModules: ['skills', 'plugins', 'config', 'userMemory'], counts: {}, totalFiles: 1, totalBytes: 10 });
      }
      if (url.endsWith('/upload')) return { ok: false, status: 502, text: async () => 'bad gateway' };
      return jsonResponse({});
    },
  });
  await flush();
  view.button('上传用户配置').props.onClick();
  await flush();
  assert.match(view.text(), /上传失败|检查失败/);
  assert.match(view.text(), /bad gateway/);
});

test('UI-06 空态：扫描 0 文件时显示 0 个文件', async () => {
  const { view } = setup({ scan: { totalFiles: 0, totalBytes: 0, counts: {} } });
  await flush();
  assert.match(view.text(), /0 个文件/);
});

test('UI-24 模块文件清单可展开与收起', async () => {
  const { view } = setup({
    scan: {
      counts: { plugins: 2 },
      files: [
        { module: 'plugins', path: 'profiles/desktop/package.json' },
        { module: 'plugins', path: 'profiles/desktop/pnpm-lock.yaml' },
      ],
    },
  });
  await flush();
  assert.match(view.text(), /查看 2 个文件/);

  view.button('查看 2 个文件').props.onClick();
  await flush();
  assert.match(view.text(), /profiles\/desktop\/package\.json/);
  assert.match(view.text(), /profiles\/desktop\/pnpm-lock\.yaml/);
  assert.match(view.text(), /收起清单/);

  view.button('收起清单').props.onClick();
  await flush();
  assert.ok(!view.text().includes('profiles/desktop/package.json'), '收起后应隐藏文件清单');
});

test('UI-25 扫描行区分已选与全部，超限给警告', async () => {
  const { view } = setup({
    scan: {
      selectedFiles: 5,
      // 已选体积超 10 MiB，触发超限提示
      selectedBytes: 10 * 1024 * 1024 + 1,
      syncableFiles: 12,
      syncableBytes: 10 * 1024 * 1024 + 1,
    },
  });
  await flush();
  assert.match(view.text(), /已选 5 个文件/);
  assert.match(view.text(), /同步范围 12 个/);
  assert.match(view.text(), /超过 10 MiB/);
});

test('UI-29 自动保存不闪烁且给出提示', async () => {
  const { view } = setup({ status: { consent: { acceptedAt: '2026-10-24T00:00:00Z' } } });
  await flush();

  const autoCheck = (function find(node) {
    if (!node) return null;
    if (Array.isArray(node)) return node.map(find).find(Boolean) ?? null;
    if (node.type === 'input' && node.props.type === 'checkbox') return node;
    return (node.children ?? []).map(find).find(Boolean) ?? null;
  })(view.tree);
  assert.ok(autoCheck, '应有自动检查复选框');

  autoCheck.props.onChange({ target: { checked: false } });
  await flush();

  // 自动保存期间底部按钮不应被禁用（避免闪烁）
  const upload = view.button('上传用户配置');
  assert.equal(upload.props.disabled, false, '自动保存不应触发 busy');

  await new Promise((resolve) => setTimeout(resolve, 800));
  await flush();
  assert.match(view.text(), /自动检查设置已保存/, '保存后给出提示');

  // 提示 3 秒后自动消失
  await new Promise((resolve) => setTimeout(resolve, 3200));
  await flush();
  assert.ok(!view.text().includes('自动检查设置已保存'), '操作提示不应常驻');
});

test('UI-27 会话模块已从同步范围隐藏', async () => {
  const { view } = setup();
  await flush();
  const moduleButtons = view.buttons().filter((button) => 'aria-pressed' in button.props);
  assert.ok(!moduleButtons.some((button) => String(button.children?.[0]?.text ?? '').includes('会话')), '同步范围不应出现会话按钮');
});

test('UI-26 插件清单显示具体插件名', async () => {
  const { view } = setup({
    scan: {
      plugins: [
        { name: '@linxin666/dsh-ssh', spec: '^0.4.8' },
        { name: 'dsh-user-sync', spec: 'link:H:/work/dsh/dsh-user-sync' },
      ],
    },
  });
  await flush();
  assert.match(view.text(), /插件清单（2）/, '插件数来自 profile dependencies');
  view.button('查看 2 个插件').props.onClick();
  await flush();
  assert.match(view.text(), /@linxin666\/dsh-ssh@\^0\.4\.8/);
  assert.match(view.text(), /dsh-user-sync@link:/);
});

test('UI-23 真实宿主响应形状下显示模块计数', async () => {
  const { view } = setup({
    fetchOverride: async (url) => {
      if (url.endsWith('/status')) {
        return jsonResponse({
          installed: true,
          consent: { acceptedAt: '2026-10-23T14:24:00.000Z' },
          transport: 'api',
          transportSetting: 'api',
          baseUrl: 'https://dsh-user-sync-test.wenzhi.info',
          scheduler: {},
          probe: { totalFiles: 11, counts: { config: 2, plugins: 4, sessions: 5 }, errors: 0 },
        });
      }
      if (url.endsWith('/scan')) {
        return jsonResponse({
          modules: ['skills', 'plugins', 'config', 'userMemory'],
          allModules: ['skills', 'plugins', 'config', 'userMemory', 'projectMemory', 'sessions'],
          counts: { config: 2, plugins: 4, sessions: 5 },
          totalFiles: 11,
          totalBytes: 19329,
          errors: [],
          skipped: [],
        });
      }
      return jsonResponse({});
    },
  });
  await flush();
  assert.match(view.text(), /插件清单（4）/, '真实 probe/scan 数据应渲染出插件数量');
  assert.match(view.text(), /配置（2）/);
  assert.match(view.text(), /11 个文件/);
});

test('UI-22 /scan 失败时用 status.probe 计数', async () => {
  const { view } = setup({
    fetchOverride: async (url) => {
      if (url.endsWith('/status')) {
        return jsonResponse({
          installed: true,
          consent: { acceptedAt: '2026-10-23T10:00:00Z' },
          transport: 'folder',
          transportSetting: 'folder',
          scheduler: {},
          probe: { totalFiles: 6, counts: { config: 2, plugins: 4 } },
        });
      }
      if (url.endsWith('/scan')) return { ok: false, status: 401, text: async () => 'unauthorized' };
      return jsonResponse({});
    },
  });
  await flush();
  assert.match(view.text(), /插件清单（4）/, '应回退到宿主探针计数');
  assert.match(view.text(), /配置（2）/);
});

test('UI-19 加载态：status 未返回时显示加载中', () => {
  const { view } = setup();
  // 不 flush：初始渲染 status 为 null
  assert.match(view.text(), /加载中/);
});

test('UI-21 锁冲突错误显示错误卡与详情', async () => {
  const { view } = setup({
    check: { error: 'E_LOCKED', detail: '另一个同步任务正在运行（pid 1234）' },
  });
  await flush();
  view.button('从远端同步').props.onClick();
  await flush();
  assert.match(view.text(), /上传失败|检查失败/);
  assert.match(view.text(), /另一个同步任务/);
});

test('UI-05 校验失败错误码显示详情', async () => {
  const { view } = setup({
    check: { error: 'E_HASH_MISMATCH', detail: '包在第 3 个文件处校验失败，未写入任何内容' },
  });
  await flush();
  view.button('从远端同步').props.onClick();
  await flush();
  assert.match(view.text(), /上传失败|检查失败/);
  assert.match(view.text(), /校验失败/);
});

test('UI-30 远端更新时上传被拦下，确认后才带 force 覆盖', async () => {
  let uploadCount = 0;
  const { view, calls } = setup({
    fetchOverride: async (url, options = {}) => {
      if (url.endsWith('/status')) {
        return jsonResponse({
          installed: true,
          consent: { acceptedAt: '2026-10-23T10:00:00Z' },
          transport: 'api',
          transportSetting: 'api',
          baseUrl: 'https://dsh-user-sync-test.wenzhi.info',
          baseUrlSource: 'default',
          scheduler: {},
        });
      }
      if (url.endsWith('/scan')) {
        return jsonResponse({ modules: ['skills', 'plugins', 'config', 'userMemory'], allModules: ['skills'], counts: {}, totalFiles: 1, totalBytes: 10 });
      }
      if (url.endsWith('/upload')) {
        uploadCount += 1;
        calls.push({ url, options });
        if (uploadCount === 1) {
          return jsonResponse({
            ok: false,
            code: 'E_REMOTE_NEWER',
            detail: '远端有更新的包（dsh-user-sync-20261024-2200-aaaaaa.tar.gz，2026-10-24T14:00:00Z），确认后再用本机覆盖',
            remote: { name: 'dsh-user-sync-20261024-2200-aaaaaa.tar.gz', createdAt: '2026-10-24T14:00:00Z' },
          });
        }
        return jsonResponse({ ok: true, packageId: '20261024-2210-a1b2c3d4', size: 1024 });
      }
      return jsonResponse({});
    },
  });
  await flush();

  // 面板只读显示生效中的服务地址
  assert.match(view.text(), /服务地址/);
  assert.match(view.text(), /https:\/\/dsh-user-sync-test\.wenzhi\.info（内置）/);

  view.button('上传用户配置').props.onClick();
  await flush();
  assert.match(view.text(), /远端已有更新的包/);

  const overwrite = view.button('用本机覆盖远端');
  assert.ok(overwrite, '被拦下时应提供「用本机覆盖远端」按钮');
  overwrite.props.onClick();
  await flush();

  assert.equal(uploadCount, 2);
  assert.match(String(calls.at(-1).options.body), /"force":true/, '确认后应带 force 重试');
  assert.match(view.text(), /上传完成/);
});

test('UI-31 从远端同步发现更新时弹出覆盖确认', async () => {
  const calls = [];
  const { view } = setup({
    fetchOverride: async (url, options = {}) => {
      if (url.endsWith('/status')) {
        return jsonResponse({ installed: true, consent: { acceptedAt: '2026-10-23T10:00:00Z' }, transport: 'api', scheduler: {} });
      }
      if (url.endsWith('/scan')) {
        return jsonResponse({ modules: ['skills', 'plugins', 'config', 'userMemory'], allModules: ['skills'], counts: {}, totalFiles: 1, totalBytes: 10 });
      }
      if (url.endsWith('/check')) {
        return jsonResponse({
          decision: { action: 'pull', reason: 'remote-newer' },
          latest: { name: 'dsh-user-sync-20261024-2200-aaaaaa.tar.gz' },
          meta: { createdAt: '2026-10-24T14:00:00Z' },
          plan: { added: [], overwritten: [1, 2], skipped: [] },
        });
      }
      if (url.endsWith('/apply')) {
        calls.push({ url, options });
        return jsonResponse({ ok: true, written: [1], skipped: [], installed: [] });
      }
      return jsonResponse({});
    },
  });
  await flush();

  view.button('从远端同步').props.onClick();
  await flush();
  assert.match(view.text(), /用远端覆盖本机？/, '应弹出覆盖确认弹窗');

  view.button('用远端覆盖本机').props.onClick();
  await flush();
  assert.ok(calls.some((call) => call.url.endsWith('/apply')), '确认后应调用 apply');
});

test('UI-32 有新版本时顶部提示升级', async () => {
  const { view } = setup({
    fetchOverride: async (url) => {
      if (url.endsWith('/status')) {
        return jsonResponse({ installed: true, consent: { acceptedAt: '2026-10-23T10:00:00Z' }, transport: 'api', scheduler: {} });
      }
      if (url.endsWith('/scan')) {
        return jsonResponse({ modules: ['skills', 'plugins', 'config', 'userMemory'], allModules: ['skills'], counts: {}, totalFiles: 1, totalBytes: 10 });
      }
      if (url.endsWith('/update-check')) {
        return jsonResponse({ current: '1.0.8', latest: '1.0.9', available: true });
      }
      return jsonResponse({});
    },
  });
  await flush();
  assert.match(view.text(), /插件有新版本 v1\.0\.9/);
  assert.ok(view.button('更新插件'), '应提供「更新插件」按钮');
});

test('UI-33 点「更新插件」调 /update 并提示重启', async () => {
  const calls = [];
  const { view } = setup({
    fetchOverride: async (url, options = {}) => {
      if (url.endsWith('/status')) {
        return jsonResponse({ installed: true, consent: { acceptedAt: '2026-10-23T10:00:00Z' }, transport: 'api', scheduler: {} });
      }
      if (url.endsWith('/scan')) {
        return jsonResponse({ modules: ['skills', 'plugins', 'config', 'userMemory'], allModules: ['skills'], counts: {}, totalFiles: 1, totalBytes: 10 });
      }
      if (url.endsWith('/update-check')) {
        return jsonResponse({ current: '1.0.10', latest: '1.0.11', available: true });
      }
      if (url.endsWith('/update')) {
        calls.push({ url, options });
        return jsonResponse({ ok: true, version: '1.0.11', restartRequired: true });
      }
      return jsonResponse({});
    },
  });
  await flush();

  view.button('更新插件').props.onClick();
  await flush();

  const updateCall = calls.find((call) => call.url.endsWith('/update'));
  assert.ok(updateCall, '应调用 /update');
  assert.match(String(updateCall.options.body), /"version":"1\.0\.11"/);
  assert.match(view.text(), /已更新到 v1\.0\.11，请重启 DSH 生效/);
});

test('UI-34 上传晚于检查时不显示过期结论', async () => {
  const { view } = setup({
    status: {
      installed: true,
      consent: { acceptedAt: '2026-10-23T10:00:00Z' },
      transport: 'api',
      lastUploaded: { createdAt: '2026-10-25T04:05:00Z' },
      scheduler: { lastCheckAt: '2026-10-25T01:59:00Z', lastDecision: { action: 'pull' } },
    },
    scan: { modules: ['skills', 'plugins', 'config', 'userMemory'], allModules: ['skills'], counts: {}, totalFiles: 1, totalBytes: 10 },
  });
  await flush();
  const text = view.text();
  assert.match(text, /上次上传/);
  assert.match(text, /上次检查/);
  assert.ok(!text.includes('（发现更新）'), '检查结论早于上传时不应再显示');
});

test('PLUG-14 宿主报 duplicate factory registration 时不抛错（不拖垮 web boot）', () => {
  // 模拟旧 junction 与 npm 包并存：同一 client bundle 被两个 owner 各执行一次
  const duplicate = () => {
    throw new Error('client-modules: duplicate factory registration for "@pandablessing/dsh-user-sync" (bundle executed twice without invalidate?)');
  };
  const mini = createMiniReact();
  let thrown = null;
  try {
    loadClientBundle(mini.React, { loaderImpl: { load: duplicate } });
  } catch (error) {
    thrown = error;
  }
  assert.equal(thrown, null, '重复注册应被 client 入口吞掉，绝不能冒泡到 web boot');
});

test('PLUG-15 非 duplicate 的 loader 错误仍然抛出（不掩盖真实故障）', () => {
  const mini = createMiniReact();
  let thrown = null;
  try {
    loadClientBundle(mini.React, {
      loaderImpl: {
        load() {
          throw new Error('client-modules: boom');
        },
      },
    });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, '真实错误必须保留，否则会变成静默失效');
});
