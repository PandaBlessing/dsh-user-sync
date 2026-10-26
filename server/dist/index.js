import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { bearerOf, newToken } from './auth.js';
import { loadConfig } from './config.js';
import { readManifest } from './lib/archive.js';
import { createStore } from './store.js';
import { createLocal } from './storage/local.js';
import { createWebdav } from './storage/webdav.js';
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
const json = (res, status, data) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data));
};
const readBody = (req) => new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
});
function accountOf(req) {
    const token = bearerOf(req.headers);
    if (!token)
        return null;
    return store.findByToken(token);
}
function parseJson(body) {
    try {
        return JSON.parse(body.toString('utf8') || '{}');
    }
    catch {
        return null;
    }
}
const server = createServer(async (req, res) => {
    const started = Date.now();
    let action = 'unknown';
    let accountKey = null;
    try {
        const url = new URL(req.url ?? '/', 'http://local');
        const path = url.pathname;
        const body = await readBody(req);
        if (req.method === 'GET' && path === '/v1/health') {
            action = 'health';
            const storageTest = await storage.test();
            return json(res, 200, { ok: true, storage: storage.id, storageTest, webdav: Boolean(config.webdav) });
        }
        // 运营方监控：总占用与各账号占用（需 secrets.json 的 adminKey；未配置则关闭）
        if (req.method === 'GET' && path === '/v1/admin/usage') {
            action = 'admin-usage';
            if (!config.adminKey)
                return json(res, 404, { error: 'admin-disabled' });
            if (bearerOf(req.headers) !== config.adminKey)
                return json(res, 401, { error: 'unauthorized' });
            const usage = store.allUsage();
            const storageTest = await storage.test();
            return json(res, 200, {
                ok: true,
                storage: storage.id,
                storageTest,
                quotaPackageBytes: config.quotaPackageBytes,
                quotaTotalBytes: config.quotaTotalBytes,
                accounts: usage.accounts,
                totalBytes: usage.totalBytes,
                largest: usage.largest,
                webdav: Boolean(config.webdav),
            });
        }
        if (req.method === 'POST' && path === '/v1/auth/register') {
            action = 'register';
            const input = parseJson(body);
            const key = input?.accountKey;
            if (typeof key !== 'string' || !ACCOUNT_RE.test(key))
                return json(res, 400, { error: 'invalid-account-key' });
            if (store.getAccount(key))
                return json(res, 409, { error: 'already-registered' });
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
            if (typeof key !== 'string' || !ACCOUNT_RE.test(key))
                return json(res, 400, { error: 'invalid-account-key' });
            const account = store.getAccount(key);
            if (!account)
                return json(res, 404, { error: 'not-registered' });
            accountKey = key;
            store.audit({ action, accountHint: key.slice(0, 6), ok: true, ms: Date.now() - started });
            return json(res, 200, { token: account.token });
        }
        if (req.method === 'POST' && path === '/v1/auth/reset') {
            action = 'reset';
            const key = accountOf(req);
            if (!key)
                return json(res, 401, { error: 'unauthorized' });
            accountKey = key;
            for (const item of store.listPackages(key)) {
                await storage.remove(key, item.id).catch(() => { });
            }
            store.deleteAccount(key);
            store.audit({ action, accountHint: key.slice(0, 6), ok: true, ms: Date.now() - started });
            res.writeHead(204);
            return res.end();
        }
        if (req.method === 'GET' && path === '/v1/packages') {
            action = 'list';
            const key = accountOf(req);
            if (!key)
                return json(res, 401, { error: 'unauthorized' });
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
            if (!key)
                return json(res, 401, { error: 'unauthorized' });
            accountKey = key;
            return json(res, 200, { used: store.totalBytes(key), limit: config.quotaTotalBytes });
        }
        const match = path.match(/^\/v1\/packages\/([^/]+)(\/meta)?$/);
        if (match) {
            const id = decodeURIComponent(match[1]);
            const isMeta = Boolean(match[2]);
            if (!PACKAGE_RE.test(id))
                return json(res, 400, { error: 'bad-package-id' });
            const key = accountOf(req);
            if (!key)
                return json(res, 401, { error: 'unauthorized' });
            accountKey = key;
            if (req.method === 'GET' && isMeta) {
                action = 'meta';
                const meta = store.getPackageMeta(key, id);
                if (!meta)
                    return json(res, 404, { error: 'not-found' });
                return json(res, 200, meta.manifest);
            }
            if (req.method === 'GET') {
                action = 'get';
                const data = await storage.get(key, id);
                if (!data)
                    return json(res, 404, { error: 'not-found' });
                res.writeHead(200, { 'content-type': 'application/octet-stream' });
                return res.end(data);
            }
            if (req.method === 'PUT') {
                action = 'put';
                if (body.length > config.quotaPackageBytes)
                    return json(res, 413, { error: 'package-too-large' });
                const used = store.totalBytes(key) - (store.getPackageMeta(key, id)?.size ?? 0);
                if (used + body.length > config.quotaTotalBytes)
                    return json(res, 413, { error: 'quota-exceeded' });
                let manifest;
                try {
                    manifest = readManifest(body);
                }
                catch (error) {
                    return json(res, 400, { error: `bad-archive: ${error.message}` });
                }
                if (!manifest?.packageId)
                    return json(res, 400, { error: 'missing-manifest' });
                await storage.put(key, id, body);
                store.setPackage(key, id, {
                    size: body.length,
                    createdAt: new Date().toISOString(),
                    manifest: manifest,
                });
                // 设计约定「远端只保留 1 份」：新包写入后删除该账号的旧包
                for (const item of store.listPackages(key)) {
                    if (item.id === id)
                        continue;
                    await storage.remove(key, item.id).catch(() => { });
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
            if (!key)
                return json(res, 401, { error: 'unauthorized' });
            accountKey = key;
            const items = store.listPackages(key);
            const latest = items.sort((a, b) => ((a.createdAt ?? '') < (b.createdAt ?? '') ? 1 : -1))[0];
            if (!latest)
                return json(res, 404, { error: 'no-package' });
            const data = await storage.get(key, latest.id);
            if (!data)
                return json(res, 404, { error: 'no-package' });
            res.writeHead(200, {
                'content-type': 'application/octet-stream',
                'content-disposition': `attachment; filename="${latest.id}"`,
            });
            return res.end(data);
        }
        if (req.method === 'DELETE' && path === '/v1/me') {
            action = 'delete-me';
            const key = accountOf(req);
            if (!key)
                return json(res, 401, { error: 'unauthorized' });
            accountKey = key;
            for (const item of store.listPackages(key)) {
                await storage.remove(key, item.id).catch(() => { });
            }
            store.deleteAccount(key);
            res.writeHead(204);
            return res.end();
        }
        return json(res, 404, { error: 'not-found' });
    }
    catch (error) {
        store.audit({
            action,
            accountHint: accountKey?.slice(0, 6) ?? null,
            ok: false,
            detail: error.message,
            ms: Date.now() - started,
        });
        return json(res, 500, { error: error.message });
    }
});
server.listen(config.port, '127.0.0.1', () => {
    console.log(`[dsh-user-sync] listening on 127.0.0.1:${config.port}`);
    console.log(`[dsh-user-sync] storage=${storage.id} dataDir=${config.dataDir} webdav=${Boolean(config.webdav)}`);
});
