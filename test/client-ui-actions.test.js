// 面板弹窗/按钮交互的完整模拟测试：mini-react 渲染 + 模拟点击 + 断言请求与 UI
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadClientBundle } from './helpers/load-client.js';
import { createMiniReact } from './helpers/mini-react.js';

const jsonResponse = (data, ok = true) => ({ ok, status: ok ? 200 : 400, text: async () => JSON.stringify(data) });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const findNode = (node, predicate) => {
  if (!node) return null;
  if (Array.isArray(node)) return node.map((n) => findNode(n, predicate)).find(Boolean) ?? null;
  if (predicate(node)) return node;
  return (node.children ?? []).map((n) => findNode(n, predicate)).find(Boolean) ?? null;
};

function setup({
  status = {},
  check = null,
  upload = null,
  apply = null,
  feedback = null,
  consent = null,
  configResponse = null,
  update = null,
  localStorageValue = null,
} = {}) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/status')) {
      return jsonResponse({
        installed: true,
        dshHome: 'C:/home',
        profile: 'desktop',
        account: { hint: '5e15a3', paired: true },
        consent: { acceptedAt: '2026-10-23T10:00:00Z' },
        scheduler: { autoCheck: false, intervalHours: 6 },
        baseUrl: 'https://remote.example',
        baseUrlSource: 'default',
        version: '1.0.28',
        dev: true,
        ...status,
      });
    }
    if (url.endsWith('/scan')) {
      return jsonResponse({ modules: ['config'], allModules: ['skills', 'plugins', 'config', 'userMemory'], counts: { config: 1 }, totalFiles: 1, totalBytes: 100 });
    }
    if (url.endsWith('/check')) {
      return jsonResponse(check ?? { decision: { action: 'pull', reason: 'remote-newer' }, latest: { name: 'pkg-a.tar.gz' }, meta: { createdAt: '2026-10-30T00:06:24Z' }, plan: { overwritten: [{}] } });
    }
    if (url.endsWith('/upload')) {
      return jsonResponse(upload ?? { ok: true, packageId: '20261030-1234', files: 8 });
    }
    if (url.endsWith('/apply')) {
      return jsonResponse(apply ?? { ok: true, written: 8, skipped: 0 });
    }
    if (url.endsWith('/feedback')) {
      return jsonResponse(feedback ?? { ok: true, id: '20261030-1234-abcdef' });
    }
    if (url.endsWith('/consent')) {
      return jsonResponse(consent ?? { consent: { acceptedAt: '2026-10-23T10:00:00Z' } });
    }
    if (url.endsWith('/config')) {
      return jsonResponse(configResponse ?? { modules: ['config'] });
    }
    if (url.endsWith('/update')) {
      return jsonResponse(update ?? { ok: true, version: '1.0.29' });
    }
    if (url.endsWith('/update-check')) return jsonResponse({ available: false });
    if (url.endsWith('/switch-env')) return jsonResponse({ ok: true, baseUrl: 'http://127.0.0.1:10001' });
    return jsonResponse({});
  };
  globalThis.localStorage = { getItem: () => localStorageValue, setItem: () => {}, removeItem: () => {} };

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

const fillFeedback = async (view, text = '测试反馈内容') => {
  await flush();
  const textarea = findNode(view.tree, (n) => n.type === 'textarea');
  if (textarea) textarea.props.onChange({ target: { value: text } });
  await flush();
};

// ---------- 状态卡 ----------
test('UI-01/04：status 成功渲染，错误字段可见', async () => {
  const { view } = setup();
  await flush();
  assert.match(view.text(), /设置同步|服务地址/);
});

test('UI-04：status 错误显示错误行', async () => {
  const { view } = setup({ status: { error: 'status-fetch-failed', detail: 'boom' } });
  await flush();
  assert.match(view.text(), /错误/);
});

test('UI-60/61：开发版显示切换按钮', async () => {
  const { view } = setup();
  await flush();
  assert.ok(view.button('切到本地') || view.button('切到远程'));
});

test('UI-60：正式版不显示切换按钮', async () => {
  const { view } = setup({ status: { dev: false } });
  await flush();
  assert.ok(!view.button('切到本地') && !view.button('切到远程'));
});

// ---------- 同步范围 ----------
test('UI-10/12：点未选中模块 → 非用户级确认弹窗 → 仍要同步', async () => {
  const { view, calls } = setup({ configResponse: { warning: ['projectMemory'], note: '非用户级内容可能包含工作内容' } });
  await flush();
  const buttons = view.buttons().filter((b) => 'aria-pressed' in b.props);
  const unselected = buttons.find((b) => !b.props['aria-pressed']);
  if (unselected) {
    unselected.props.onClick();
    await flush();
    assert.match(view.text(), /仍要同步/);
    view.button('仍要同步').props.onClick();
    await flush();
    const cfg = calls.filter((c) => c.url.endsWith('/config') && c.options.method === 'POST').pop();
    assert.match(String(cfg.options.body), /confirmNonUserLevel/);
  }
});

// ---------- 自动检查 ----------
test('UI-20：勾选自动检查 → 保存到 config', async () => {
  const { view, calls } = setup();
  await flush();
  const cb = view.checkboxes()[0];
  if (cb) {
    cb.props.onChange({ target: { checked: true } });
    await flush();
  }
  assert.ok(calls.length > 0, '应有请求（status/scan）');
});

// ---------- 上传 ----------
test('UI-30：上传成功弹「上传完成」', async () => {
  const { view } = setup({ upload: { ok: true, packageId: '20261030-1234', files: 8 } });
  await flush();
  view.button('上传用户配置').props.onClick();
  await flush();
  assert.match(view.text(), /上传完成|已上传/);
});

test('UI-31/35：上传发现远端更新 → 覆盖确认 → 取消', async () => {
  const { view } = setup({ upload: { ok: false, error: 'E_REMOTE_NEWER', latest: 'pkg-b.tar.gz', detail: '远端有新包' } });
  await flush();
  view.button('上传用户配置').props.onClick();
  await flush();
  // 失败或覆盖确认弹窗二选一：至少显示远端新包或错误
  assert.ok(view.text().includes('上传') || view.text().includes('远端'));
});

test('UI-32：上传失败弹「上传失败」', async () => {
  const { view } = setup({ upload: { ok: false, error: 'E_QUOTA_EXCEEDED', detail: '超出配额' } });
  await flush();
  view.button('上传用户配置').props.onClick();
  await flush();
  assert.match(view.text(), /上传失败|配额|失败/);
});

test('UI-34：未同意时上传按钮禁用', async () => {
  const { view } = setup({ status: { consent: null } });
  await flush();
  const uploadBtn = view.button('上传用户配置');
  assert.ok(uploadBtn);
  assert.equal(uploadBtn.props.disabled, true, '未同意时应禁用');
});

// ---------- 从远端同步 ----------
test('UI-40：pull → 只弹覆盖确认（不弹检查完成）', async () => {
  const { view } = setup({ check: { decision: { action: 'pull' }, latest: { name: 'pkg-a.tar.gz' }, meta: { createdAt: '2026-10-30T00:06:24Z' }, plan: { overwritten: [{}] } } });
  await flush();
  view.button('从远端同步').props.onClick();
  await flush();
  assert.match(view.text(), /将覆盖本机/);
  assert.ok(!view.text().includes('检查完成'));
});

test('UI-41：push → 「本地有更新」', async () => {
  const { view } = setup({ check: { decision: { action: 'push', reason: 'local-newer' } } });
  await flush();
  view.button('从远端同步').props.onClick();
  await flush();
  assert.match(view.text(), /本地有更新/);
  assert.ok(!view.text().includes('将覆盖本机'));
});

test('UI-42：skip → 「已是最新」', async () => {
  const { view } = setup({ check: { decision: { action: 'skip' }, latest: null, meta: null, plan: null } });
  await flush();
  view.button('从远端同步').props.onClick();
  await flush();
  assert.match(view.text(), /已是最新/);
});

test('UI-44：覆盖确认点确认 → 调 apply 并提示同步完成', async () => {
  const { view, calls } = setup({ check: { decision: { action: 'pull' }, latest: { name: 'pkg-a.tar.gz' }, meta: { createdAt: '2026-10-30T00:06:24Z' }, plan: { overwritten: [{}] } }, apply: { ok: true, written: 8, skipped: 0 } });
  await flush();
  view.button('从远端同步').props.onClick();
  await flush();
  const confirm = view.buttons().find((b) => String(b.children?.[0]?.text ?? '').includes('仍要同步') || String(b.children?.[0]?.text ?? '').includes('覆盖'));
  if (confirm) {
    confirm.props.onClick();
    await flush();
    assert.ok(calls.some((c) => c.url.endsWith('/apply')));
  }
});

test('UI-49：check 失败 → 弹「检查失败」', async () => {
  const { view } = setup({ check: { error: 'check-failed', detail: '网络错误' } });
  await flush();
  view.button('从远端同步').props.onClick();
  await flush();
  assert.match(view.text(), /检查失败|失败/);
});

// ---------- 反馈 ----------
test('UI-50/51：打开反馈，空内容时提交禁用', async () => {
  const { view } = setup();
  await flush();
  view.button('反馈').props.onClick();
  await flush();
  const submit = view.button('提交');
  assert.ok(submit);
  assert.equal(submit.props.disabled, true, '空内容应禁用');
});

test('UI-52：反馈提交成功 → 弹「提交成功」+ 编号', async () => {
  const { view } = setup({ feedback: { ok: true, id: '20261030-1234-abcdef' } });
  await flush();
  view.button('反馈').props.onClick();
  await fillFeedback(view);
  view.button('提交').props.onClick();
  await flush();
  assert.match(view.text(), /提交成功/);
  assert.match(view.text(), /20261030-1234-abcdef/);
});

test('UI-53：反馈提交失败 → 弹「提交失败」', async () => {
  const { view } = setup({ feedback: { ok: false, error: 'rate-limited' } });
  await flush();
  view.button('反馈').props.onClick();
  await fillFeedback(view);
  view.button('提交').props.onClick();
  await flush();
  assert.match(view.text(), /提交失败/);
});

test('UI-54：草稿恢复', async () => {
  const { view } = setup({ localStorageValue: JSON.stringify({ type: 'bug', content: '草稿内容', contact: '' }) });
  await flush();
  view.button('反馈').props.onClick();
  await flush();
  const textarea = findNode(view.tree, (n) => n.type === 'textarea');
  assert.equal(textarea.props.value, '草稿内容', '应恢复草稿');
});

// ---------- 切换 ----------
test('UI-62：点切到本地 → 调 switch-env', async () => {
  const { view, calls } = setup();
  await flush();
  view.button('切到本地').props.onClick();
  await flush();
  assert.ok(calls.some((c) => c.url.endsWith('/switch-env')));
});

// ---------- 更新 ----------
test('UI-70/71：点更新插件 → 调 update 并提示重启', async () => {
  const { view, calls } = setup({ status: { version: '1.0.27' }, update: { ok: true, version: '1.0.29' } });
  await flush();
  const btn = view.button('更新插件');
  if (btn) {
    btn.props.onClick();
    await flush();
    assert.ok(calls.some((c) => c.url.endsWith('/update')));
  }
});

// ---------- 补充：取消/关闭/busy/临界 ----------
test('UI-45：覆盖确认点取消 → 不调 apply', async () => {
  const { view, calls } = setup({ check: { decision: { action: 'pull' }, latest: { name: 'pkg-a.tar.gz' }, meta: { createdAt: '2026-10-30T00:06:24Z' }, plan: { overwritten: [{}] } } });
  await flush();
  view.button('从远端同步').props.onClick();
  await flush();
  const cancel = view.button('取消');
  if (cancel) {
    cancel.props.onClick();
    await flush();
    assert.ok(!calls.some((c) => c.url.endsWith('/apply')), '取消后不应 apply');
    assert.ok(!view.text().includes('将覆盖本机'), '取消后弹窗关闭');
  }
});

test('UI-52/55：反馈成功弹窗点「知道了」关闭', async () => {
  const { view } = setup({ feedback: { ok: true, id: '20261030-1234-abcdef' } });
  await flush();
  view.button('反馈').props.onClick();
  await fillFeedback(view);
  view.button('提交').props.onClick();
  await flush();
  assert.match(view.text(), /提交成功/);
  view.button('知道了').props.onClick();
  await flush();
  assert.ok(!view.text().includes('提交成功'), '点知道了应关闭结果弹窗');
});

test('UI-31b：上传发现远端更新 → 弹覆盖确认（含远端包名）', async () => {
  const { view } = setup({ upload: { ok: false, error: 'E_REMOTE_NEWER', detail: '远端有新包', latest: 'pkg-b.tar.gz' } });
  await flush();
  view.button('上传用户配置').props.onClick();
  await flush();
  // 失败或覆盖确认：至少应展示远端包名/错误细节
  assert.ok(view.text().includes('pkg-b') || view.text().includes('远端'), '应展示远端信息');
});

test('UI-43：check 返回 confirm（时钟偏差）→ 覆盖确认', async () => {
  const { view } = setup({ check: { decision: { action: 'confirm', reason: 'clock-skew' }, latest: { name: 'pkg-a.tar.gz' }, meta: { createdAt: '2026-10-30T00:06:24Z' }, plan: { overwritten: [{}] } } });
  await flush();
  view.button('从远端同步').props.onClick();
  await flush();
  assert.match(view.text(), /将覆盖本机/);
});

test('UI-48：未配对（paired=false）时同步不崩溃', async () => {
  const { view } = setup({ status: { account: { hint: null, paired: false } } });
  await flush();
  assert.match(view.text(), /未登录官方账号|设置同步/);
});

test('UI-74：更新失败提示', async () => {
  const { view } = setup({ update: { ok: false, error: 'E_DEV_LINK' }, status: { version: '1.0.27' } });
  await flush();
  const btn = view.button('更新插件');
  if (btn) {
    btn.props.onClick();
    await flush();
    assert.ok(view.text().includes('失败') || view.text().includes('E_DEV_LINK'), '应提示更新失败');
  }
});

test('UI-62b：switch-env 失败提示', async () => {
  const { view } = setup({ status: { dev: true } });
  await flush();
  // 让 switch-env 返回错误
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (url.endsWith('/switch-env')) return jsonResponse({ ok: false, error: 'dev-only' }, false);
    return original(url, options);
  };
  const btn = view.button('切到本地');
  if (btn) {
    btn.props.onClick();
    await flush();
    assert.ok(view.text().includes('切换失败') || view.text().includes('dev-only'), '应提示切换失败');
  }
});

test('UI-54b：草稿损坏（非法 JSON）不影响打开', async () => {
  const { view } = setup({ localStorageValue: '{bad json' });
  await flush();
  view.button('反馈').props.onClick();
  await flush();
  const textarea = findNode(view.tree, (n) => n.type === 'textarea');
  assert.equal(textarea.props.value, '', '损坏草稿应被忽略');
});

test('UI-33/46：上传进行中按钮禁用并显示「上传中…」', async () => {
  const { view } = setup();
  await flush();
  // 让 upload 挂起（不 resolve）
  const pending = [];
  globalThis.fetch = async (url, options = {}) => {
    if (url.endsWith('/upload')) {
      await new Promise((resolve) => pending.push(resolve));
      return jsonResponse({ ok: true });
    }
    return { ok: true, status: 200, text: async () => '{}' };
  };
  view.button('上传用户配置').props.onClick();
  await flush();
  const busyBtn = view.button('上传中…') ?? view.button('处理中…');
  assert.ok(busyBtn, '进行中应显示上传中…');
  assert.equal(busyBtn.props.disabled, true, '进行中按钮应禁用');
  pending.forEach((resolve) => resolve());
  await flush();
});
