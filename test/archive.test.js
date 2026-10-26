import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  buildManifest,
  buildTar,
  buildTarGz,
  MANIFEST_PATH,
  normalizeManifest,
  parseTar,
  parseTarGz,
  isPackageId,
} from '../src/archive.ts';
import { hashBytes } from '../src/hash.ts';

const fixtures = join(import.meta.dirname, 'fixtures');

const file = (path, text, mode = '100644') => ({ path, data: Buffer.from(text, 'utf8'), mode });

test('ARCH-01 manifest 是首条目', () => {
  const manifest = buildManifest([{ path: 'a.txt', sha256: 'aa', size: 1, mode: '100644' }], {
    packageId: '20261023-0900-a1b2c3d4',
    createdAt: '2026-10-23T01:02:03Z',
  });
  const gz = buildTarGz([{ path: MANIFEST_PATH, data: Buffer.from(JSON.stringify(manifest)) }, file('a.txt', 'x')]);
  const entries = parseTarGz(gz);
  assert.equal(entries[0].path, MANIFEST_PATH);
  assert.equal(JSON.parse(entries[0].data.toString('utf8')).packageId, '20261023-0900-a1b2c3d4');
});

test('ARCH-02 篡改文件后哈希不符', () => {
  const original = file('a.txt', 'hello');
  const hash = hashBytes(original.data);
  const tampered = Buffer.from(original.data);
  tampered[0] ^= 0xff;
  assert.notEqual(hashBytes(tampered), hash);
});

test('ARCH-03 v2 包兼容：name 映射为 path', () => {
  const raw = JSON.parse(readFileSync(join(fixtures, 'fx-v2', 'manifest.json'), 'utf8'));
  const manifest = normalizeManifest(raw);
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.files[0].path, 'package.json');
  assert.equal(manifest.files[1].path, 'cordis.patch.yml');
  assert.deepEqual(manifest.modules, ['plugins', 'config']);
});

test('ARCH-04 v2 无 createdAt 时回退 exportedAt', () => {
  const raw = JSON.parse(readFileSync(join(fixtures, 'fx-v2', 'manifest.json'), 'utf8'));
  const manifest = normalizeManifest(raw);
  assert.equal(manifest.createdAt, '2026-10-14 12:00:00');
});

test('ARCH-05 长路径用 ustar prefix 往返', () => {
  const longPath = `${'p'.repeat(100)}/${'n'.repeat(20)}.md`;
  const gz = buildTarGz([file(longPath, 'data')]);
  const entries = parseTarGz(gz);
  assert.equal(entries[0].path, longPath);
  assert.equal(entries[0].data.toString('utf8'), 'data');
});

test('ARCH-06 权限位往返', () => {
  const gz = buildTarGz([
    file('a.txt', 'a', '100644'),
    file('run.sh', '#!/bin/sh\n', '100755'),
    { path: 'link.txt', mode: '120000', linkTarget: '../target' },
  ]);
  const entries = parseTarGz(gz);
  assert.equal(entries[0].mode, '100644');
  assert.equal(entries[1].mode, '100755');
  assert.equal(entries[2].mode, '120000');
  assert.equal(entries[2].linkTarget, '../target');
});

test('ARCH-07 包名正则', () => {
  assert.equal(isPackageId('dsh-user-sync-20261023-0900-a1b2c3d4.tar.gz'), true);
  assert.equal(isPackageId('dsh-user-sync-20261023-0900.tar.gz'), false);
  assert.equal(isPackageId('evil-20261023-0900-a1b2c3d4.tar.gz'), false);
  assert.equal(isPackageId('dsh-user-sync-20261023-0900-A1B2C3D4.tar.gz'), false);
});

test('tar 校验和损坏时抛错', () => {
  const tar = buildTar([file('a.txt', 'hello')]);
  tar[0] ^= 0xff; // 破坏 name 字段
  assert.throws(() => parseTar(tar), /tar 头校验失败/);
});
