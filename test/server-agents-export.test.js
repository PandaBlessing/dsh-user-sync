// 服务端：导出所有账号 AGENTS.md（collectAgents + buildAgentsArchive）测试
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';

import { buildAgentsArchive, collectAgents } from '../server/src/agents-export.ts';
import { parseTarGz } from '../server/src/lib/archive.ts';
import { createStore } from '../server/src/store.ts';

/** 极简 tar.gz 构造（ustar + gzip），供测试造包。 */
function buildTarGz(files) {
  const chunks = [];
  for (const file of files) {
    const header = Buffer.alloc(512);
    Buffer.from(file.name, 'utf8').subarray(0, 100).copy(header, 0);
    header.write('0000644\0', 100, 8);
    header.write('0000000\0', 108, 8);
    header.write('0000000\0', 116, 8);
    header.write(`${file.data.length.toString(8).padStart(11, '0')}\0`, 124, 12);
    header.write('00000000000\0', 136, 12);
    header.write('        ', 148, 8);
    header.write('0', 156, 1);
    header.write('ustar  \0', 257, 8);
    let checksum = 0;
    for (let i = 0; i < 512; i += 1) checksum += header[i];
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8);
    chunks.push(header, file.data);
    const pad = (512 - (file.data.length % 512)) % 512;
    if (pad > 0) chunks.push(Buffer.alloc(pad));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { level: 9 });
}

function fakeStorage(getImpl) {
  return {
    id: 'local-test',
    async test() {
      return { ok: true, detail: 'ok' };
    },
    async put() {},
    async get(accountKey, id) {
      return getImpl(accountKey, id);
    },
    async remove() {},
    async list() {
      return [];
    },
  };
}

test('agents-export：有包时导出每个账号的 AGENTS.md', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-agents-export-'));
  try {
    const store = createStore(dir);
    const account = '5e15a3684105dfae';
    const pkgId = 'dsh-user-sync-20261030-0806-local0000.tar.gz';
    const tar = buildTarGz([
      { name: '.dsh-user-sync/manifest.json', data: Buffer.from('{"packageId":"x"}') },
      { name: 'AGENTS.md', data: Buffer.from('# 用户级约定\n\n内容') },
    ]);
    store.createAccount(account, 'token-test');
    store.setPackage(account, pkgId, {
      size: tar.length,
      createdAt: new Date().toISOString(),
      manifest: { packageId: 'x' },
    });
    const storage = fakeStorage(async (key, id) => (key === account && id === pkgId ? tar : null));

    const entries = await collectAgents(store, storage);
    assert.equal(entries.length, 1, '应导出 1 个账号的 AGENTS.md');
    assert.equal(entries[0].accountHint, '5e15a3');
    assert.match(entries[0].data.toString('utf8'), /用户级约定/);

    const archive = buildAgentsArchive(entries);
    const files = parseTarGz(archive);
    assert.equal(files.length, 1, '归档应含 1 个文件');
    assert.match(files[0].data.toString('utf8'), /用户级约定/);
    assert.match(files[0].path, /5e15a3/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('agents-export：无包时返回空归档（可解压）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-agents-export-empty-'));
  try {
    const store = createStore(dir);
    const storage = fakeStorage(async () => null);
    const entries = await collectAgents(store, storage);
    assert.equal(entries.length, 0);
    const archive = buildAgentsArchive(entries);
    assert.equal(parseTarGz(archive).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
