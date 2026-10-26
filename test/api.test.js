import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildManifest, buildTarGz, MANIFEST_PATH } from '../src/archive.ts';
import { hashBytes } from '../src/hash.ts';
import { createApiTransport } from '../src/transport/api.ts';
import { startFakeApi } from './helpers/fake-api.js';

const PKG = 'dsh-user-sync-20261023-1800-aaaaaa.tar.gz';

function makePackage(packageId = PKG) {
  const body = Buffer.from('hello');
  const manifest = buildManifest(
    [{ path: 'a.txt', sha256: hashBytes(body), size: body.length, mode: '100644' }],
    { packageId: packageId.replace(/^dsh-user-sync-/, '').replace(/\.tar\.gz$/, ''), createdAt: '2026-10-23T10:00:00Z' },
  );
  return buildTarGz([
    { path: MANIFEST_PATH, data: Buffer.from(JSON.stringify(manifest)) },
    { path: 'a.txt', data: body },
  ]);
}

test('API-01 首次注册建账号，再次注册自动登录取回同一 token', async () => {
  const api = await startFakeApi();
  const authPath = join(mkdtempSync(join(tmpdir(), 'dsh-api-')), 'auth.json');
  try {
    const transport = createApiTransport({ baseUrl: api.url, authPath });
    const first = await transport.register('account-aaaa');
    assert.equal(first.ok, true);
    assert.ok(first.token);

    const second = createApiTransport({ baseUrl: api.url, authPath: join(authPath, '..', 'auth2.json') });
    const again = await second.register('account-aaaa');
    assert.equal(again.token, first.token, '同一 accountKey 应取回同一 token');
  } finally {
    await api.close();
  }
});

test('API-02 login 取回同一 token', async () => {
  const api = await startFakeApi();
  const authPath = join(mkdtempSync(join(tmpdir(), 'dsh-api-')), 'auth.json');
  try {
    const transport = createApiTransport({ baseUrl: api.url, authPath });
    const registered = await transport.register('account-bbbb');
    const login = await createApiTransport({ baseUrl: api.url, authPath: join(authPath, '..', 'auth2.json') }).login('account-bbbb');
    assert.equal(login.token, registered.token);
  } finally {
    await api.close();
  }
});

test('API-03 reset 后旧 token 返回 401', async () => {
  const api = await startFakeApi();
  const authPath = join(mkdtempSync(join(tmpdir(), 'dsh-api-')), 'auth.json');
  try {
    const transport = createApiTransport({ baseUrl: api.url, authPath });
    await transport.register('account-cccc');
    const oldToken = transport.token;
    await transport.reset();

    const stale = createApiTransport({ baseUrl: api.url, authPath: join(authPath, '..', 'stale.json'), token: oldToken });
    await assert.rejects(() => stale.list(), (error) => error.code === 'E_REMOTE_AUTH');
  } finally {
    await api.close();
  }
});

test('API-04 隔离：B 的 token 读不到 A 的包', async () => {
  const api = await startFakeApi();
  const dir = mkdtempSync(join(tmpdir(), 'dsh-api-'));
  try {
    const a = createApiTransport({ baseUrl: api.url, authPath: join(dir, 'a.json') });
    const b = createApiTransport({ baseUrl: api.url, authPath: join(dir, 'b.json') });
    await a.register('account-dddd');
    await b.register('account-eeee');
    await a.put(PKG, makePackage());

    const listB = await b.list();
    assert.equal(listB.length, 0);
    await assert.rejects(() => b.meta(PKG), (error) => error.code === 'E_HTTP_404');
  } finally {
    await api.close();
  }
});

test('API-05 上传幂等：重复 PUT 同一 id 不产生重复', async () => {
  const api = await startFakeApi();
  const dir = mkdtempSync(join(tmpdir(), 'dsh-api-'));
  try {
    const transport = createApiTransport({ baseUrl: api.url, authPath: join(dir, 'a.json') });
    await transport.register('account-ffff');
    await transport.put(PKG, makePackage());
    await transport.put(PKG, makePackage());
    const list = await transport.list();
    assert.equal(list.length, 1);
  } finally {
    await api.close();
  }
});

test('API-06 配额超限拒绝上传', async () => {
  const api = await startFakeApi({ quota: 100 });
  const dir = mkdtempSync(join(tmpdir(), 'dsh-api-'));
  try {
    const transport = createApiTransport({ baseUrl: api.url, authPath: join(dir, 'a.json') });
    await transport.register('account-gggg');
    const big = Buffer.concat([makePackage(), Buffer.alloc(200)]);
    await assert.rejects(() => transport.put(PKG, big), (error) => error.code === 'E_HTTP_413');
  } finally {
    await api.close();
  }
});

test('API-07 5xx 重试后成功，4xx 不重试', async () => {
  const api = await startFakeApi();
  const dir = mkdtempSync(join(tmpdir(), 'dsh-api-'));
  try {
    const transport = createApiTransport({ baseUrl: api.url, authPath: join(dir, 'a.json'), retries: 3 });
    await transport.register('account-hhhh');

    api.failNext(2, 500);
    const list = await transport.list();
    assert.ok(Array.isArray(list), '两次 500 后第三次应成功');

    api.failNext(1, 404);
    await assert.rejects(() => transport.list(), (error) => error.code === 'E_HTTP_404');
    // 4xx 不重试：失败后队列应已清空，下一次请求直接成功
    const after = await transport.list();
    assert.ok(Array.isArray(after));
  } finally {
    await api.close();
  }
});

test('API-08 包名不合法时请求前拒绝', async () => {
  const api = await startFakeApi();
  const dir = mkdtempSync(join(tmpdir(), 'dsh-api-'));
  try {
    const transport = createApiTransport({ baseUrl: api.url, authPath: join(dir, 'a.json') });
    await transport.register('account-iiii');
    await assert.rejects(() => transport.get('evil.tar.gz'), (error) => error.code === 'E_BAD_NAME');
    await assert.rejects(() => transport.put('x/y.tar.gz', Buffer.alloc(1)), (error) => error.code === 'E_BAD_NAME');
  } finally {
    await api.close();
  }
});

test('API-09 meta 只读 manifest，get 下载字节', async () => {
  const api = await startFakeApi();
  const dir = mkdtempSync(join(tmpdir(), 'dsh-api-'));
  try {
    const transport = createApiTransport({ baseUrl: api.url, authPath: join(dir, 'a.json') });
    await transport.register('account-jjjj');
    const bytes = makePackage();
    await transport.put(PKG, bytes);

    const meta = await transport.meta(PKG);
    assert.equal(meta.schemaVersion, 3);
    assert.equal(meta.files[0].path, 'a.txt');

    const downloaded = await transport.get(PKG);
    assert.equal(downloaded.length, bytes.length);
  } finally {
    await api.close();
  }
});

test('API-10 删除包后列表为空', async () => {
  const api = await startFakeApi();
  const dir = mkdtempSync(join(tmpdir(), 'dsh-api-'));
  try {
    const transport = createApiTransport({ baseUrl: api.url, authPath: join(dir, 'a.json') });
    await transport.register('account-kkkk');
    await transport.put(PKG, makePackage());
    await transport.remove(PKG);
    assert.equal((await transport.list()).length, 0);
  } finally {
    await api.close();
  }
});

test('G3 官方域名在构造时拒绝', () => {
  assert.throws(() => createApiTransport({ baseUrl: 'https://api.deepseek.com' }), (error) => error.code === 'E_OFFICIAL_HOST');
  assert.doesNotThrow(() => createApiTransport({ baseUrl: 'https://sync.example.com' }));
});

test('BOUND-04 删除 auth.json 后 token 为 null，请求返回 401', async () => {
  const api = await startFakeApi();
  const dir = mkdtempSync(join(tmpdir(), 'dsh-api-'));
  try {
    const authPath = join(dir, 'auth.json');
    const transport = createApiTransport({ baseUrl: api.url, authPath });
    await transport.register('account-mmmm');
    assert.ok(transport.token);

    rmSync(authPath, { force: true });
    const fresh = createApiTransport({ baseUrl: api.url, authPath });
    assert.equal(fresh.token, null, '删除 auth.json 后应视为未登录');
    await assert.rejects(() => fresh.list(), (error) => error.code === 'E_REMOTE_AUTH');
  } finally {
    await api.close();
  }
});

test('API-11 export 返回当前包字节', async () => {
  const api = await startFakeApi();
  const dir = mkdtempSync(join(tmpdir(), 'dsh-api-'));
  try {
    const transport = createApiTransport({ baseUrl: api.url, authPath: join(dir, 'a.json') });
    await transport.register('account-nnnn');
    const bytes = makePackage();
    await transport.put(PKG, bytes);
    const exported = await transport.exportPackage();
    assert.equal(exported.length, bytes.length);
  } finally {
    await api.close();
  }
});
