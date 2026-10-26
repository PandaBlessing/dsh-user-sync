import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

import { MANIFEST_PATH, parseTarGz } from '../../src/archive.ts';

const PACKAGE_RE = /^dsh-user-sync-\d{8}-\d{4}-[a-z0-9]{6,16}\.tar\.gz$/;

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

/**
 * 内存假 API：按设计 §17.2 实现 auth / packages / quota。
 * 用于单测，不持久化、不联网。
 */
export async function startFakeApi({ quota = 10 * 1024 * 1024 } = {}) {
  const accounts = new Map(); // accountKey -> { token, packages: Map<id, {data, manifest}> }
  const tokens = new Map(); // token -> accountKey
  const failures = [];

  const send = (res, status, data) => {
    if (data === undefined) {
      res.writeHead(status);
      res.end();
      return;
    }
    if (Buffer.isBuffer(data)) {
      res.writeHead(status, { 'content-type': 'application/octet-stream' });
      res.end(data);
      return;
    }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  const authAccount = (req) => {
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) return undefined;
    const accountKey = tokens.get(header.slice(7));
    return accountKey ? accounts.get(accountKey) : undefined;
  };

  const server = createServer(async (req, res) => {
    if (failures.length > 0) {
      const status = failures.shift();
      return send(res, status, { error: 'injected-failure' });
    }

    const url = new URL(req.url, 'http://local');
    const path = url.pathname;
    const body = await readBody(req);

    try {
      if (req.method === 'POST' && path === '/v1/auth/register') {
        const { accountKey } = JSON.parse(body.toString() || '{}');
        if (!accountKey) return send(res, 400, { error: 'missing accountKey' });
        if (accounts.has(accountKey)) return send(res, 409, { error: 'already-registered' });
        const token = randomBytes(16).toString('hex');
        accounts.set(accountKey, { token, packages: new Map() });
        tokens.set(token, accountKey);
        return send(res, 201, { token });
      }

      if (req.method === 'POST' && path === '/v1/auth/login') {
        const { accountKey } = JSON.parse(body.toString() || '{}');
        const account = accounts.get(accountKey);
        if (!account) return send(res, 404, { error: 'not-registered' });
        return send(res, 200, { token: account.token });
      }

      if (req.method === 'POST' && path === '/v1/auth/reset') {
        const accountKey = tokens.get((req.headers.authorization ?? '').replace('Bearer ', ''));
        if (!accountKey) return send(res, 401, { error: 'unauthorized' });
        const account = accounts.get(accountKey);
        tokens.delete(account.token);
        accounts.delete(accountKey);
        return send(res, 204);
      }

      if (path === '/v1/quota' && req.method === 'GET') {
        const account = authAccount(req);
        if (!account) return send(res, 401, { error: 'unauthorized' });
        const used = [...account.packages.values()].reduce((sum, item) => sum + item.data.length, 0);
        return send(res, 200, { used, limit: quota });
      }

      if (path === '/v1/packages' && req.method === 'GET') {
        const account = authAccount(req);
        if (!account) return send(res, 401, { error: 'unauthorized' });
        const packages = [...account.packages.entries()].map(([id, item]) => ({
          id,
          size: item.data.length,
          createdAt: item.manifest?.createdAt ?? new Date().toISOString(),
          platform: item.manifest?.platform ?? null,
          deviceId: item.manifest?.deviceId ?? null,
        }));
        return send(res, 200, { packages });
      }

      if (path === '/v1/export' && req.method === 'GET') {
        const account = authAccount(req);
        if (!account) return send(res, 401, { error: 'unauthorized' });
        const items = [...account.packages.entries()];
        if (items.length === 0) return send(res, 404, { error: 'no-package' });
        return send(res, 200, items[0][1].data);
      }

      const match = path.match(/^\/v1\/packages\/([^/]+)(\/meta)?$/);
      if (match) {
        const id = decodeURIComponent(match[1]);
        const isMeta = Boolean(match[2]);
        if (!PACKAGE_RE.test(id)) return send(res, 400, { error: 'bad-package-id' });
        const account = authAccount(req);
        if (!account) return send(res, 401, { error: 'unauthorized' });
        const item = account.packages.get(id);

        if (req.method === 'GET' && isMeta) {
          if (!item) return send(res, 404, { error: 'not-found' });
          return send(res, 200, item.manifest);
        }
        if (req.method === 'GET') {
          if (!item) return send(res, 404, { error: 'not-found' });
          return send(res, 200, item.data);
        }
        if (req.method === 'PUT') {
          const used = [...account.packages.entries()].filter(([key]) => key !== id).reduce((sum, [, v]) => sum + v.data.length, 0);
          if (used + body.length > quota) return send(res, 413, { error: 'quota-exceeded' });
          let manifest = null;
          try {
            const entries = parseTarGz(body);
            manifest = JSON.parse(entries.find((entry) => entry.path === MANIFEST_PATH)?.data.toString('utf8') ?? 'null');
          } catch {
            return send(res, 400, { error: 'bad-archive' });
          }
          account.packages.set(id, { data: body, manifest });
          return send(res, 201, { id });
        }
        if (req.method === 'DELETE') {
          if (!item) return send(res, 404, { error: 'not-found' });
          account.packages.delete(id);
          return send(res, 204);
        }
      }

      return send(res, 404, { error: 'not-found' });
    } catch (error) {
      return send(res, 500, { error: error.message });
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
    /** 让接下来的 n 个请求返回指定状态码（测重试与 5xx）。 */
    failNext: (n, status = 500) => failures.push(...Array(n).fill(status)),
    packagesFor: (accountKey) => accounts.get(accountKey)?.packages ?? new Map(),
    hasAccount: (accountKey) => accounts.has(accountKey),
  };
}
