import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { hashBytes, hashDirectory, hashFile } from '../src/hash.ts';

const fixtures = join(import.meta.dirname, 'fixtures');

test('HASH-01 CRLF 与 LF 同内容哈希相同', () => {
  const lf = Buffer.from('a: 1\nb: 2\n', 'utf8');
  const crlf = Buffer.from('a: 1\r\nb: 2\r\n', 'utf8');
  assert.equal(hashBytes(lf), hashBytes(crlf));
});

test('HASH-02 BOM 保留且参与哈希', () => {
  const plain = Buffer.from('Write-Host "hi"\n', 'utf8');
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), plain]);
  assert.notEqual(hashBytes(bom), hashBytes(plain));
});

test('HASH-03 删除所有 CR 后计算（与原型 tr -d 等价）', () => {
  const withCr = Buffer.from('x\r\ry\r\n', 'utf8');
  const withoutCr = Buffer.from('xy\n', 'utf8');
  assert.equal(hashBytes(withCr), hashBytes(withoutCr));
});

test('HASH-04 二进制按原始字节', () => {
  const bytes = Buffer.from([0x00, 0x0d, 0xff, 0x0a]);
  // 二进制同样删除 0x0D，保证与文本口径一致
  const expected = Buffer.from([0x00, 0xff, 0x0a]);
  assert.equal(hashBytes(bytes), hashBytes(expected));
});

test('HASH-05 目录聚合与文件顺序无关', () => {
  const a = { path: 'b.txt', sha256: '22' };
  const b = { path: 'a.txt', sha256: '11' };
  assert.equal(hashDirectory([a, b]), hashDirectory([b, a]));
  // 顺序不同的目录内容必须给出不同哈希
  const c = { path: 'a.txt', sha256: '22' };
  assert.notEqual(hashDirectory([a, b]), hashDirectory([a, c]));
});

test('HASH-06 路径分隔符归一化后哈希一致', () => {
  const win = [{ path: 'skills\\foo\\SKILL.md', sha256: 'aa' }];
  const posix = [{ path: 'skills/foo/SKILL.md', sha256: 'aa' }];
  assert.equal(hashDirectory(win), hashDirectory(posix));
});

test('fixture：fx-minimal 与 fx-crlf 删除 CR 后哈希一致，且 crlf 文件确含 CR', () => {
  const rel = join('dsh-home', 'AGENTS.md');
  const a = hashFile(join(fixtures, 'fx-minimal', rel));
  const b = hashFile(join(fixtures, 'fx-crlf', rel));
  assert.equal(a, b);
  assert.ok(readFileSync(join(fixtures, 'fx-crlf', rel)).includes(0x0d), 'fx-crlf 应含 CR');
});
