import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync } from 'node:fs';

import { bearerOf, newToken } from './auth.js';
import { loadConfig } from './config.js';
import { readManifest } from './lib/archive.js';
import { createStore } from './store.js';
import { createLocal } from './storage/local.js';
import { createWebdav } from './storage/webdav.js';
import { getAdminFile, getAdminPackage, listAdminPackages } from './admin.js';
import { buildCard, notifyNewFeedback } from './notify.js';
import { clientIp, deleteFeedback, deleteFeedbackBefore, feedbackStats, getFeedbackFile, hitRateLimit, listFeedback, submitFeedback, updateFeedbackStatus } from './feedback.js';

const PACKAGE_RE = /^dsh-user-sync-\d{8}-\d{4}-[a-z0-9]{6,16}\.tar\.gz$/;
const ACCOUNT_RE = /^[0-9a-f]{16}$/;

const baseDir = process.argv[2] || process.cwd();
const config = loadConfig(baseDir);
mkdirSync(config.dataDir, { recursive: true });
mkdirSync(config.logDir, { recursive: true });

const store = createStore(config.dataDir);
const storage = config.webdav
  ? createWebdav({
      baseUrl: config.webdav.baseUrl ?? config.webdav.url ?? '',
      username: config.webdav.username,
      password: config.webdav.password,
      root: config.webdav.root,
    })
  : createLocal(config.dataDir);

const json = (res: ServerResponse, status: number, data: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
};

const readBody = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });

function accountOf(req: IncomingMessage): string | null {
  const token = bearerOf(req.headers);
  if (!token) return null;
  return store.findByToken(token);
}

interface AccountInput {
  accountKey?: string;
}

function parseJson(body: Buffer): AccountInput | null {
  try {
    return JSON.parse(body.toString('utf8') || '{}');
  } catch {
    return null;
  }
}

const server = createServer(async (req, res) => {
  const started = Date.now();
  let action = 'unknown';
  let accountKey: string | null = null;
  try {
    const url = new URL(req.url ?? '/', 'http://local');
    const path = url.pathname;
    const body = await readBody(req);

    if (req.method === 'GET' && path === '/v1/health') {
      action = 'health';
      const storageTest = await storage.test();
      return json(res, 200, { ok: true, storage: storage.id, storageTest, webdav: Boolean(config.webdav) });
    }
    // 飞书卡片回调：按钮直接处理反馈（Verification Token 校验）
    if (req.method === 'POST' && path === '/feishu/card') {
      action = 'feishu-card';
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(body.toString('utf8') || '{}'); } catch { return json(res, 400, { error: 'invalid-json' }); }
      if (typeof payload.challenge === 'string') return json(res, 200, { challenge: payload.challenge });
      const header = payload.header as Record<string, unknown> | undefined;
      const token = typeof payload.token === 'string' ? payload.token : typeof header?.token === 'string' ? (header.token as string) : '';
      if (!config.feishu?.verificationToken || token !== config.feishu.verificationToken) {
        return json(res, 403, { error: 'invalid-token' });
      }
      const event = payload.event as Record<string, unknown> | undefined;
      const actionValue = (event?.action as Record<string, unknown> | undefined)?.value as Record<string, unknown> | undefined;
      const id = typeof actionValue?.id === 'string' ? (actionValue.id as string) : '';
      const target = typeof actionValue?.action === 'string' ? (actionValue.action as string) : '';
      if (!id || !['done', 'rejected', 'pending'].includes(target)) return json(res, 400, { error: 'invalid-action' });
      const result = await updateFeedbackStatus(storage, id, target, '', 'feishu');
      if (!result.ok || !result.item) return json(res, 400, { toast: { type: 'error', content: '处理失败' } });
      const label = target === 'done' ? '已标记完成' : target === 'rejected' ? '已拒绝' : '已重新打开';
      // 卡片 2.0 回调响应：card.data 直接放 2.0 卡片 JSON（不能再包一层 card，否则 200672）
      return json(res, 200, {
        toast: { type: 'success', content: label },
        card: { type: 'raw', data: JSON.parse(buildCard(result.item)) },
      });
    }

    if (req.method === 'POST' && path === '/v1/feedback') {
      action = 'feedback';
      const ip = clientIp(req.headers as Record<string, string | string[] | undefined>);
      if (hitRateLimit(ip)) return json(res, 429, { ok: false, error: 'rate-limited' });
      let input: Record<string, unknown> = {};
      try { input = JSON.parse(body.toString('utf8') || '{}'); } catch { return json(res, 400, { ok: false, error: 'invalid-json' }); }
      const accountKey = typeof (input.context as Record<string, unknown>)?.accountKey === 'string' ? (input.context as Record<string, unknown>).accountKey as string : '';
      const result = await submitFeedback(storage, input, {
        accountHint: accountKey.slice(0, 6),
        pluginVersion: typeof input.pluginVersion === 'string' ? input.pluginVersion : '',
        platform: typeof input.platform === 'string' ? input.platform : '',
      });
      if (result.ok && result.item) void notifyNewFeedback(result.item, config.feishu);
      return json(res, result.ok ? 200 : 400, result);
    }

    // 运营方监控：总占用与各账号占用（需 secrets.json 的 adminKey；未配置则关闭）
    if (req.method === 'GET' && path === '/v1/admin/usage') {
      action = 'admin-usage';
      if (!config.adminKey) return json(res, 404, { error: 'admin-disabled' });
      if (bearerOf(req.headers) !== config.adminKey) return json(res, 401, { error: 'unauthorized' });
      const usage = store.allUsage();
      const storageTest = await storage.test();
      return json(res, 200, {
        ok: true,
        storage: storage.id,
        storageTest,
        quotaPackageBytes: config.quotaPackageBytes,
        quotaTotalBytes: config.quotaTotalBytes,
        accounts: usage.accounts,
        uploaded: usage.uploaded,
        totalBytes: usage.totalBytes,
        largest: usage.largest,
        webdav: Boolean(config.webdav),
      });
    }

    // 运营方后台：同步包汇总与单包/单文件查看（adminKey 鉴权）
    if (req.method === 'GET' && path === '/v1/admin/packages') {
      action = 'admin-packages';
      if (!config.adminKey) return json(res, 404, { error: 'admin-disabled' });
      if (bearerOf(req.headers) !== config.adminKey) return json(res, 401, { error: 'unauthorized' });
      return json(res, 200, await listAdminPackages(store, storage));
    }

    if (req.method === 'GET' && path === '/v1/admin/package') {
      action = 'admin-package';
      if (!config.adminKey) return json(res, 404, { error: 'admin-disabled' });
      if (bearerOf(req.headers) !== config.adminKey) return json(res, 401, { error: 'unauthorized' });
      const accountKey = url.searchParams.get('account') ?? '';
      if (!accountKey) return json(res, 400, { error: 'missing-account' });
      return json(res, 200, await getAdminPackage(store, storage, accountKey));
    }

    if (req.method === 'GET' && path === '/v1/admin/package/file') {
      action = 'admin-package-file';
      if (!config.adminKey) return json(res, 404, { error: 'admin-disabled' });
      if (bearerOf(req.headers) !== config.adminKey) return json(res, 401, { error: 'unauthorized' });
      const accountKey = url.searchParams.get('account') ?? '';
      const filePath = url.searchParams.get('path') ?? '';
      if (!accountKey || !filePath) return json(res, 400, { error: 'missing-params' });
      return json(res, 200, await getAdminFile(store, storage, accountKey, filePath));
    }

    // 运营方后台：用户反馈
    if (req.method === 'GET' && path === '/v1/admin/feedback') {
      action = 'admin-feedback';
      if (!config.adminKey) return json(res, 404, { error: 'admin-disabled' });
      if (bearerOf(req.headers) !== config.adminKey) return json(res, 401, { error: 'unauthorized' });
      return json(res, 200, await listFeedback(storage));
    }

    if (req.method === 'GET' && path === '/v1/admin/feedback/file') {
      action = 'admin-feedback-file';
      if (!config.adminKey) return json(res, 404, { error: 'admin-disabled' });
      if (bearerOf(req.headers) !== config.adminKey) return json(res, 401, { error: 'unauthorized' });
      const id = url.searchParams.get('id') ?? '';
      const result = await getFeedbackFile(storage, id);
      return json(res, result.ok ? 200 : 404, result);
    }

    if (req.method === 'GET' && path === '/v1/admin/feedback/stats') {
      action = 'admin-feedback-stats';
      if (!config.adminKey) return json(res, 404, { error: 'admin-disabled' });
      if (bearerOf(req.headers) !== config.adminKey) return json(res, 401, { error: 'unauthorized' });
      return json(res, 200, await feedbackStats(storage));
    }

    if (req.method === 'POST' && path === '/v1/admin/feedback/delete') {
      action = 'admin-feedback-delete';
      if (!config.adminKey) return json(res, 404, { error: 'admin-disabled' });
      if (bearerOf(req.headers) !== config.adminKey) return json(res, 401, { error: 'unauthorized' });
      let input: Record<string, unknown> = {};
      try { input = JSON.parse(body.toString('utf8') || '{}'); } catch { return json(res, 400, { ok: false, error: 'invalid-json' }); }
      const id = typeof input.id === 'string' ? input.id : '';
      if (!id) return json(res, 400, { ok: false, error: 'missing-id' });
      const result = await deleteFeedback(storage, id);
      return json(res, result.ok ? 200 : 400, result);
    }

    if (req.method === 'POST' && path === '/v1/admin/feedback/delete-before') {
      action = 'admin-feedback-delete-before';
      if (!config.adminKey) return json(res, 404, { error: 'admin-disabled' });
      if (bearerOf(req.headers) !== config.adminKey) return json(res, 401, { error: 'unauthorized' });
      let input: Record<string, unknown> = {};
      try { input = JSON.parse(body.toString('utf8') || '{}'); } catch { return json(res, 400, { ok: false, error: 'invalid-json' }); }
      const before = typeof input.before === 'string' ? input.before : '';
      if (!before) return json(res, 400, { ok: false, error: 'missing-before' });
      const result = await deleteFeedbackBefore(storage, before);
      return json(res, result.ok ? 200 : 400, result);
    }

    if (req.method === 'POST' && path === '/v1/admin/feedback/status') {
      action = 'admin-feedback-status';
      if (!config.adminKey) return json(res, 404, { error: 'admin-disabled' });
      if (bearerOf(req.headers) !== config.adminKey) return json(res, 401, { error: 'unauthorized' });
      let input: Record<string, unknown> = {};
      try { input = JSON.parse(body.toString('utf8') || '{}'); } catch { return json(res, 400, { ok: false, error: 'invalid-json' }); }
      const id = typeof input.id === 'string' ? input.id : '';
      const status = typeof input.status === 'string' ? input.status : '';
      const note = typeof input.note === 'string' ? input.note : '';
      const operator = typeof input.operator === 'string' ? input.operator : 'admin';
      const result = await updateFeedbackStatus(storage, id, status, note, operator);
      return json(res, result.ok ? 200 : 404, result);
    }

    if (req.method === 'POST' && path === '/v1/auth/register') {
      action = 'register';
      const input = parseJson(body);
      const key = input?.accountKey;
      if (typeof key !== 'string' || !ACCOUNT_RE.test(key)) return json(res, 400, { error: 'invalid-account-key' });
      if (store.getAccount(key)) return json(res, 409, { error: 'already-registered' });
      const token = newToken();
      store.createAccount(key, token);
      accountKey = key;
      store.audit({ action, accountHint: key.slice(0, 6), ok: true, ms: Date.now() - started });
      return json(res, 201, { token });
    }

    if (req.method === 'POST' && path === '/v1/auth/login') {
      action = 'login';
      const input = parseJson(body);
      const key = input?.accountKey;
      if (typeof key !== 'string' || !ACCOUNT_RE.test(key)) return json(res, 400, { error: 'invalid-account-key' });
      const account = store.getAccount(key);
      if (!account) return json(res, 404, { error: 'not-registered' });
      accountKey = key;
      store.audit({ action, accountHint: key.slice(0, 6), ok: true, ms: Date.now() - started });
      return json(res, 200, { token: account.token });
    }

    if (req.method === 'POST' && path === '/v1/auth/reset') {
      action = 'reset';
      const key = accountOf(req);
      if (!key) return json(res, 401, { error: 'unauthorized' });
      accountKey = key;
      for (const item of store.listPackages(key)) {
        await storage.remove(key, item.id).catch(() => {});
      }
      store.deleteAccount(key);
      store.audit({ action, accountHint: key.slice(0, 6), ok: true, ms: Date.now() - started });
      res.writeHead(204);
      return res.end();
    }

    if (req.method === 'GET' && path === '/v1/packages') {
      action = 'list';
      const key = accountOf(req);
      if (!key) return json(res, 401, { error: 'unauthorized' });
      accountKey = key;
      const packages = store.listPackages(key).map((item) => ({
        id: item.id,
        size: item.size,
        createdAt: item.manifest?.createdAt ?? item.createdAt,
        platform: item.manifest?.platform ?? null,
        deviceId: item.manifest?.deviceId ?? null,
      }));
      return json(res, 200, { packages });
    }

    if (req.method === 'GET' && path === '/v1/quota') {
      action = 'quota';
      const key = accountOf(req);
      if (!key) return json(res, 401, { error: 'unauthorized' });
      accountKey = key;
      return json(res, 200, { used: store.totalBytes(key), limit: config.quotaTotalBytes });
    }

    const match = path.match(/^\/v1\/packages\/([^/]+)(\/meta)?$/);
    if (match) {
      const id = decodeURIComponent(match[1]);
      const isMeta = Boolean(match[2]);
      if (!PACKAGE_RE.test(id)) return json(res, 400, { error: 'bad-package-id' });
      const key = accountOf(req);
      if (!key) return json(res, 401, { error: 'unauthorized' });
      accountKey = key;

      if (req.method === 'GET' && isMeta) {
        action = 'meta';
        const meta = store.getPackageMeta(key, id);
        if (!meta) return json(res, 404, { error: 'not-found' });
        return json(res, 200, meta.manifest);
      }
      if (req.method === 'GET') {
        action = 'get';
        const data = await storage.get(key, id);
        if (!data) return json(res, 404, { error: 'not-found' });
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        return res.end(data);
      }
      if (req.method === 'PUT') {
        action = 'put';
        if (body.length > config.quotaPackageBytes) return json(res, 413, { error: 'package-too-large' });
        const used = store.totalBytes(key) - (store.getPackageMeta(key, id)?.size ?? 0);
        if (used + body.length > config.quotaTotalBytes) return json(res, 413, { error: 'quota-exceeded' });
        let manifest: Record<string, unknown> | null;
        try {
          manifest = readManifest(body);
        } catch (error) {
          return json(res, 400, { error: `bad-archive: ${(error as Error).message}` });
        }
        if (!manifest?.packageId) return json(res, 400, { error: 'missing-manifest' });
        await storage.put(key, id, body);
        store.setPackage(key, id, {
          size: body.length,
          createdAt: new Date().toISOString(),
          manifest: manifest as Record<string, unknown>,
        });
        // 设计约定「远端只保留 1 份」：新包写入后删除该账号的旧包
        for (const item of store.listPackages(key)) {
          if (item.id === id) continue;
          await storage.remove(key, item.id).catch(() => {});
          store.removePackage(key, item.id);
        }
        return json(res, 201, { id });
      }
      if (req.method === 'DELETE') {
        action = 'delete';
        await storage.remove(key, id);
        store.removePackage(key, id);
        res.writeHead(204);
        return res.end();
      }
    }

    if (req.method === 'GET' && path === '/v1/export') {
      action = 'export';
      const key = accountOf(req);
      if (!key) return json(res, 401, { error: 'unauthorized' });
      accountKey = key;
      const items = store.listPackages(key);
      const latest = items.sort((a, b) => ((a.createdAt ?? '') < (b.createdAt ?? '') ? 1 : -1))[0];
      if (!latest) return json(res, 404, { error: 'no-package' });
      const data = await storage.get(key, latest.id);
      if (!data) return json(res, 404, { error: 'no-package' });
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="${latest.id}"`,
      });
      return res.end(data);
    }

    if (req.method === 'DELETE' && path === '/v1/me') {
      action = 'delete-me';
      const key = accountOf(req);
      if (!key) return json(res, 401, { error: 'unauthorized' });
      accountKey = key;
      for (const item of store.listPackages(key)) {
        await storage.remove(key, item.id).catch(() => {});
      }
      store.deleteAccount(key);
      res.writeHead(204);
      return res.end();
    }

    return json(res, 404, { error: 'not-found' });
  } catch (error) {
    store.audit({
      action,
      accountHint: accountKey?.slice(0, 6) ?? null,
      ok: false,
      detail: (error as Error).message,
      ms: Date.now() - started,
    });
    return json(res, 500, { error: (error as Error).message });
  }
});

server.listen(config.port, '127.0.0.1', () => {
  console.log(`[dsh-user-sync] listening on 127.0.0.1:${config.port}`);
  console.log(`[dsh-user-sync] storage=${storage.id} dataDir=${config.dataDir} webdav=${Boolean(config.webdav)}`);
});
