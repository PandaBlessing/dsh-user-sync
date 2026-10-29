import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isPackageId } from '../archive.js';
const OFFICIAL_HOST = /(^|\.)deepseek\.com$/i;
export class ApiError extends Error {
    code;
    status;
    constructor(code, message, status) {
        super(message);
        this.code = code;
        this.status = status;
    }
}
/**
 * 运营方 API 传输（B 模型）。插件侧只持有用户自己的 token，不接触存储凭据。
 * 认证：register 首次建账号，login 取回同一 token；token 存 auth.json（0600）。
 */
export function createApiTransport({ baseUrl, authPath, token: initialToken, fetchImpl = globalThis.fetch, timeoutMs = 30_000, retries = 3, }) {
    if (!baseUrl)
        throw new Error('缺少 baseUrl');
    const host = new URL(baseUrl).hostname;
    if (OFFICIAL_HOST.test(host)) {
        throw new ApiError('E_OFFICIAL_HOST', `拒绝官方域名: ${host}`);
    }
    let token = initialToken ?? null;
    if (!token && authPath && existsSync(authPath)) {
        try {
            token = JSON.parse(readFileSync(authPath, 'utf8')).token ?? null;
        }
        catch {
            token = null;
        }
    }
    function persistAuth(next) {
        token = next.token;
        if (!authPath)
            return;
        mkdirSync(dirname(authPath), { recursive: true });
        writeFileSync(authPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    }
    function clearAuth() {
        token = null;
        if (authPath)
            rmSync(authPath, { force: true });
    }
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function request(method, path, { body, headers = {}, expectBytes = false } = {}) {
        const url = `${baseUrl.replace(/\/$/, '')}${path}`;
        let lastError;
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                const response = await fetchImpl(url, {
                    method,
                    headers: {
                        ...(token ? { authorization: `Bearer ${token}` } : {}),
                        ...(body && !expectBytes ? { 'content-type': 'application/json' } : {}),
                        ...headers,
                    },
                    body: body,
                    signal: AbortSignal.timeout(timeoutMs),
                });
                if (response.status === 401 || response.status === 403) {
                    throw new ApiError('E_REMOTE_AUTH', `认证失败（${response.status}）`, response.status);
                }
                if (response.status >= 400 && response.status < 500) {
                    const detail = await response.text().catch(() => '');
                    throw new ApiError(`E_HTTP_${response.status}`, detail.slice(0, 200) || `HTTP ${response.status}`, response.status);
                }
                if (!response.ok) {
                    throw new ApiError('E_REMOTE_5XX', `服务端错误（${response.status}）`, response.status);
                }
                return expectBytes ? Buffer.from(await response.arrayBuffer()) : response;
            }
            catch (error) {
                lastError = error;
                const retryable = !(error instanceof ApiError) || error.code === 'E_REMOTE_5XX';
                if (!retryable || attempt === retries)
                    throw error;
                await sleep(200 * 2 ** attempt);
            }
        }
        throw lastError;
    }
    const parseJson = async (response) => {
        const text = await response.text();
        return text ? JSON.parse(text) : null;
    };
    /**
     * 用同一 accountKey 取回同一个 token（不签发新 token）。
     * 抽成独立函数：register 里改走 login 时不依赖 `this`，解构调用也不会炸。
     */
    async function loginWith(accountKey) {
        const response = await request('POST', '/v1/auth/login', { body: JSON.stringify({ accountKey }) });
        const data = await parseJson(response);
        const token = String(data?.token ?? '');
        persistAuth({ token, accountKeyHint: accountKey.slice(0, 6), registeredAt: new Date().toISOString() });
        return { ok: true, token };
    }
    return {
        id: 'api',
        baseUrl,
        get token() {
            return token;
        },
        /** 首次注册；已存在（409）时改走 login，取回同一个 token。 */
        async register(accountKey) {
            try {
                const response = await request('POST', '/v1/auth/register', { body: JSON.stringify({ accountKey }) });
                const data = await parseJson(response);
                const token = String(data?.token ?? '');
                persistAuth({ token, accountKeyHint: accountKey.slice(0, 6), registeredAt: new Date().toISOString() });
                return { ok: true, token };
            }
            catch (error) {
                if (error.code === 'E_HTTP_409')
                    return loginWith(accountKey);
                throw error;
            }
        },
        login: loginWith,
        async reset() {
            await request('POST', '/v1/auth/reset');
            clearAuth();
            return { ok: true };
        },
        async test() {
            try {
                const response = await request('GET', '/v1/quota');
                const data = await parseJson(response);
                return { ok: true, detail: `配额 ${data?.used ?? 0}/${data?.limit ?? 0} 字节` };
            }
            catch (error) {
                return { ok: false, detail: error.message };
            }
        },
        async list() {
            const response = await request('GET', '/v1/packages');
            const data = await parseJson(response);
            return (data?.packages ?? []).map((item) => ({
                name: item.id,
                size: item.size,
                modifiedAt: item.createdAt,
            }));
        },
        async meta(id) {
            if (!isPackageId(id))
                throw new ApiError('E_BAD_NAME', `非法包名: ${id}`);
            const response = await request('GET', `/v1/packages/${encodeURIComponent(id)}/meta`);
            return parseJson(response);
        },
        async get(id) {
            if (!isPackageId(id))
                throw new ApiError('E_BAD_NAME', `非法包名: ${id}`);
            return request('GET', `/v1/packages/${encodeURIComponent(id)}`, { expectBytes: true });
        },
        async put(id, data) {
            if (!isPackageId(id))
                throw new ApiError('E_BAD_NAME', `非法包名: ${id}`);
            await request('PUT', `/v1/packages/${encodeURIComponent(id)}`, {
                body: data,
                expectBytes: true,
                headers: { 'content-type': 'application/octet-stream' },
            });
        },
        async post(path, body) {
            const response = await request('POST', path, {
                body: JSON.stringify(body ?? {}),
                headers: { 'content-type': 'application/json' },
            });
            const data = (await response.json().catch(() => ({})));
            if (!response.ok)
                throw Object.assign(new Error(String(data.error ?? 'post-failed')), { status: response.status, code: data.error });
            return data;
        },
        async remove(id) {
            if (!isPackageId(id))
                throw new ApiError('E_BAD_NAME', `非法包名: ${id}`);
            await request('DELETE', `/v1/packages/${encodeURIComponent(id)}`);
        },
        /** 导出我的全部数据（服务端打包当前包 + 元数据）。 */
        async exportPackage() {
            return request('GET', '/v1/export', { expectBytes: true });
        },
    };
}
