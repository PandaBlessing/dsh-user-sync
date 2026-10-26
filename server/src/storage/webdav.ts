import type { ServerStorage } from './types.ts';

/**
 * 坚果云 WebDAV 存储（服务端持有账号与应用密码，插件永不可见）。
 * 只依赖标准动词：MKCOL / PUT / GET / DELETE；目录创建后长期保留（DELETE 目录 403）。
 */
export function createWebdav({
  baseUrl,
  username,
  password,
  root = 'dsh-user-sync',
}: {
  baseUrl: string;
  username: string;
  password: string;
  root?: string;
}): ServerStorage {
  const auth = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const base = baseUrl.replace(/\/$/, '');

  async function request(
    method: string,
    path: string,
    { body, headers = {} }: { body?: Buffer; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    return fetch(`${base}${path}`, {
      method,
      headers: { authorization: auth, ...headers },
      body: body as unknown as RequestInit['body'],
      signal: AbortSignal.timeout(30_000),
    });
  }

  async function ensureCollection(path: string): Promise<void> {
    const response = await request('MKCOL', path);
    // 201 新建；405 已存在；409 父目录缺失（先建父再重试）
    if ([201, 405].includes(response.status)) return;
    if (response.status === 409) {
      const parent = path.slice(0, path.lastIndexOf('/'));
      if (parent) {
        await ensureCollection(parent);
        const retry = await request('MKCOL', path);
        if ([201, 405].includes(retry.status)) return;
      }
    }
    throw new Error(`MKCOL ${path} 失败: ${response.status}`);
  }

  return {
    id: 'webdav',

    async test() {
      try {
        const response = await request('PROPFIND', `/${root}/`, { headers: { depth: '0' } });
        if (response.status === 401) return { ok: false, detail: '认证失败（检查应用密码）' };
        return { ok: response.status < 500, detail: `PROPFIND ${response.status}` };
      } catch (error) {
        return { ok: false, detail: (error as Error).message };
      }
    },

    async put(accountKey: string, id: string, data: Buffer) {
      await ensureCollection(`/${root}`);
      await ensureCollection(`/${root}/${accountKey}`);
      const response = await request('PUT', `/${root}/${accountKey}/${id}`, {
        body: data,
        headers: { 'content-type': 'application/octet-stream' },
      });
      if (![200, 201, 204].includes(response.status)) throw new Error(`PUT 失败: ${response.status}`);
    },

    async get(accountKey: string, id: string) {
      const response = await request('GET', `/${root}/${accountKey}/${id}`);
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`GET 失败: ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    },

    async remove(accountKey: string, id: string) {
      const response = await request('DELETE', `/${root}/${accountKey}/${id}`);
      if (![200, 204, 404].includes(response.status)) throw new Error(`DELETE 失败: ${response.status}`);
    },
  };
}
