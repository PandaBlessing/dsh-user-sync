import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { isBlockedName, SAMPLE_THRESHOLD, scanBuffer, scanText } from '../src/secret.ts';

const fixtures = join(import.meta.dirname, 'fixtures');

test('SEC-01 文件名黑名单', () => {
  assert.equal(isBlockedName('.credentials.yaml'), true);
  assert.equal(isBlockedName('profiles/desktop/.credentials.yml'), true);
  assert.equal(isBlockedName('a/b/id_rsa'), true);
  assert.equal(isBlockedName('x.key'), true);
  assert.equal(isBlockedName('github.token'), true);
  assert.equal(isBlockedName('.netrc'), true);
  assert.equal(isBlockedName('cordis.patch.yml'), false);
  assert.equal(isBlockedName('SKILL.md'), false);
});

test('SEC-02 sk- 密钥命中后给出文件与行号', () => {
  const text = 'a: 1\napiKey: "sk-abcdefghijklmnop1234567890"\n';
  const hits = scanText(text, 'cordis.patch.yml');
  assert.ok(hits.length > 0);
  assert.equal(hits[0].file, 'cordis.patch.yml');
  assert.equal(hits[0].line, 2);
  assert.ok(hits.some((h) => h.pattern === 'sk-密钥'));
});

test('SEC-03 通用密钥字段命中', () => {
  const hits = scanText('token: "abcdefghijklmnopqrstu12345"\n', 'x.yml');
  assert.ok(hits.some((h) => h.pattern === '通用密钥字段'));
});

test('SEC-04 Bearer / GitHub / 云厂商 AK / 私钥 / npm 凭据', () => {
  assert.ok(scanText('Authorization: Bearer abcdefghijklmnopqrstuvwxyz', 'a').some((h) => h.pattern === 'Bearer'));
  assert.ok(scanText('ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'b').some((h) => h.pattern === 'GitHub token'));
  assert.ok(scanText('AKIAABCDEFGHIJKLMNOP', 'c').some((h) => h.pattern === '云厂商 AK'));
  assert.ok(scanText('-----BEGIN RSA PRIVATE KEY-----', 'd').some((h) => h.pattern === '私钥'));
  assert.ok(scanText('//registry.npmjs.org/:_authToken=abc', 'e').some((h) => h.pattern === 'npm 凭据'));
});

test('SEC-05 大文件抽样，尾部命中也能发现', () => {
  const head = Buffer.alloc(SAMPLE_THRESHOLD + 1024, 0x61); // 'a'，超过阈值
  const tail = Buffer.from('secret: "abcdefghijklmnopqrstu12345"', 'utf8');
  const buf = Buffer.concat([head, tail]);
  const { hits, sampled } = scanBuffer(buf, 'big.bin');
  assert.equal(sampled, true);
  assert.ok(hits.some((h) => h.pattern === '通用密钥字段'));
});

test('SEC-06 只返回模式名与位置，不返回值', () => {
  const hits = scanText('apiKey: "sk-abcdefghijklmnop1234567890"', 'x.yml');
  assert.ok(hits.length > 0);
  const known = new Set(['sk-密钥', '通用密钥字段', 'Bearer', 'GitHub token', '云厂商 AK', '私钥', 'npm 凭据']);
  for (const hit of hits) {
    assert.ok(known.has(hit.pattern), `未知模式名: ${hit.pattern}`);
    assert.ok(!JSON.stringify(hit).includes('abcdefghijklmnop'), '回报里不应出现密钥值');
  }
});

test('fixture fx-secret 的三类命中', () => {
  const patch = readFileSync(join(fixtures, 'fx-secret', 'dsh-home', 'profiles', 'desktop', 'cordis.patch.yml'));
  assert.ok(scanBuffer(patch, 'cordis.patch.yml').hits.length > 0);
  assert.equal(isBlockedName('.credentials.yaml'), true);
  assert.equal(isBlockedName('id_rsa'), true);
});
