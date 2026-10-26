import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createSync } from '../src/sync.ts';
import { createFolderTransport } from '../src/transport/folder.ts';

const fixtures = join(import.meta.dirname, 'fixtures');

function makeSync(home, remote, deviceId) {
  return createSync({
    dshHome: join(home, 'dsh-home'),
    userHome: join(home, 'user-home'),
    transport: createFolderTransport({ dir: remote }),
    deviceId,
  });
}

test('E2E-01 folder：A 打包上传 → B 检查并应用，四类资产齐全', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-e2e-'));
  try {
    const aHome = join(root, 'a');
    const bHome = join(root, 'b');
    cpSync(join(fixtures, 'fx-full'), aHome, { recursive: true });
    mkdirSync(bHome, { recursive: true });
    const remote = join(root, 'remote');

    const aSync = makeSync(aHome, remote, 'a1b2c3d4');
    const bSync = makeSync(bHome, remote, 'e5f6a7b8');

    const uploaded = await aSync.upload();
    assert.equal(uploaded.ok, true, JSON.stringify(uploaded));
    assert.ok(existsSync(join(remote, uploaded.name)));

    const checked = await bSync.check();
    assert.equal(checked.decision.action, 'pull');
    assert.equal(checked.meta.packageId, uploaded.packageId);

    const applied = await bSync.applyRemote(checked.latest.name);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.ok(existsSync(join(bHome, 'user-home', '.agents', 'skills', 'foo', 'SKILL.md')));
    assert.ok(existsSync(join(bHome, 'dsh-home', 'profiles', 'desktop', 'cordis.patch.yml')));
    assert.ok(existsSync(join(bHome, 'dsh-home', 'memories', 'MEMORY.md')));
    assert.ok(existsSync(join(bHome, 'dsh-home', 'AGENTS.md')));
    assert.equal(
      readFileSync(join(bHome, 'dsh-home', 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8'),
      readFileSync(join(fixtures, 'fx-full', 'dsh-home', 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8'),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('E2E-02 应用后再次检查为幂等跳过', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-e2e-'));
  try {
    const aHome = join(root, 'a');
    const bHome = join(root, 'b');
    cpSync(join(fixtures, 'fx-full'), aHome, { recursive: true });
    mkdirSync(bHome, { recursive: true });
    const remote = join(root, 'remote');

    const aSync = makeSync(aHome, remote, 'a1b2c3d4');
    const bSync = makeSync(bHome, remote, 'e5f6a7b8');
    const uploaded = await aSync.upload();
    const first = await bSync.check();
    const applied = await bSync.applyRemote(first.latest.name);
    assert.equal(applied.ok, true);

    const second = await bSync.check();
    assert.equal(second.decision.action, 'skip');
    assert.equal(second.decision.reason, 'in-sync');
    assert.equal(uploaded.packageId, second.meta.packageId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('上传后本机再检查为幂等跳过', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-e2e-'));
  try {
    const aHome = join(root, 'a');
    cpSync(join(fixtures, 'fx-full'), aHome, { recursive: true });
    const remote = join(root, 'remote');
    const aSync = makeSync(aHome, remote, 'a1b2c3d4');
    const uploaded = await aSync.upload();
    assert.equal(uploaded.ok, true, JSON.stringify(uploaded));
    const checked = await aSync.check();
    assert.equal(checked.decision.action, 'skip');
    assert.equal(checked.decision.reason, 'in-sync');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('G4 敏感数据命中时整包拒绝，不产生远端包', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-e2e-'));
  try {
    const aHome = join(root, 'a');
    cpSync(join(fixtures, 'fx-secret'), aHome, { recursive: true });
    const remote = join(root, 'remote');

    const aSync = makeSync(aHome, remote, 'a1b2c3d4');
    const uploaded = await aSync.upload();
    assert.equal(uploaded.ok, false);
    assert.equal(uploaded.code, 'E_SENSITIVE');
    assert.ok(uploaded.hits.length > 0);
    assert.ok(!existsSync(remote) || readdirNames(remote).length === 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ARCH-09 manifest 缺失时整包拒绝', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-e2e-'));
  try {
    const aHome = join(root, 'a');
    mkdirSync(join(aHome, 'dsh-home'), { recursive: true });
    const remote = join(root, 'remote');
    const aSync = makeSync(aHome, remote, 'a1b2c3d4');

    // 手工放一个没有 manifest 的 tar.gz 到远端
    const { buildTarGz } = await import('../src/archive.ts');
    const tar = buildTarGz([{ path: 'a.txt', data: Buffer.from('x') }]);
    mkdirSync(remote, { recursive: true });
    writeFileSync(join(remote, 'dsh-user-sync-20261023-2100-aaaaaa.tar.gz'), tar);

    const applied = await aSync.applyRemote('dsh-user-sync-20261023-2100-aaaaaa.tar.gz');
    assert.equal(applied.ok, false);
    assert.equal(applied.code, 'E_HASH_MISMATCH');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PLUG-06 应用后报告缺失的环境变量（只报名字）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-e2e-'));
  const envName = 'DSH_TEST_MISSING_ENV_X';
  const previous = process.env[envName];
  delete process.env[envName];
  try {
    const aHome = join(root, 'a');
    cpSync(join(fixtures, 'fx-minimal'), aHome, { recursive: true });
    const patchPath = join(aHome, 'dsh-home', 'profiles', 'desktop', 'cordis.patch.yml');
    writeFileSync(patchPath, `${readFileSync(patchPath, 'utf8')}\n- id: llm-x\n  config:\n    apiKeyEnv: ${envName}\n`);

    const remote = join(root, 'remote');
    const aSync = makeSync(aHome, remote, 'a1b2c3d4');
    const uploaded = await aSync.upload();
    assert.equal(uploaded.ok, true, JSON.stringify(uploaded));

    const bHome = join(root, 'b');
    mkdirSync(bHome, { recursive: true });
    const bSync = makeSync(bHome, remote, 'e5f6a7b8');
    const applied = await bSync.applyRemote(uploaded.name);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.ok(applied.missingEnv.includes(envName), '应报告缺失的环境变量名');
    // 只报名字，不返回值
    assert.ok(!JSON.stringify(applied.missingEnv).includes('='));
  } finally {
    if (previous !== undefined) process.env[envName] = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('UPL-01 上传前发现远端更新时拒绝覆盖，force 后才覆盖（G2）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-e2e-'));
  try {
    const aHome = join(root, 'a');
    const bHome = join(root, 'b');
    cpSync(join(fixtures, 'fx-full'), aHome, { recursive: true });
    cpSync(join(fixtures, 'fx-minimal'), bHome, { recursive: true });
    const remote = join(root, 'remote');

    const aSync = makeSync(aHome, remote, 'a1b2c3d4');
    const bSync = makeSync(bHome, remote, 'e5f6a7b8');

    // B 先上传一份：远端已有别的设备的包
    const bUploaded = await bSync.upload();
    assert.equal(bUploaded.ok, true, JSON.stringify(bUploaded));

    // A 从未上传过：默认不许直接覆盖远端
    const blocked = await aSync.upload();
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, 'E_REMOTE_NEWER');
    assert.ok(blocked.remote?.name, '应告知远端包名');

    // 用户确认后带 force 重试
    const forced = await aSync.upload({ force: true });
    assert.equal(forced.ok, true, JSON.stringify(forced));
    assert.notEqual(forced.packageId, bUploaded.packageId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('UPL-02 远端就是本机上次上传的包时不拦截重复上传', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-e2e-'));
  try {
    const aHome = join(root, 'a');
    cpSync(join(fixtures, 'fx-full'), aHome, { recursive: true });
    const remote = join(root, 'remote');
    const aSync = makeSync(aHome, remote, 'a1b2c3d4');

    const first = await aSync.upload();
    assert.equal(first.ok, true, JSON.stringify(first));
    const second = await aSync.upload();
    assert.equal(second.ok, true, JSON.stringify(second));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('APPLY-11 每次应用生成独立快照目录（不互相覆盖）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-e2e-'));
  try {
    const aHome = join(root, 'a');
    const bHome = join(root, 'b');
    cpSync(join(fixtures, 'fx-full'), aHome, { recursive: true });
    cpSync(join(fixtures, 'fx-minimal'), bHome, { recursive: true });
    const remote = join(root, 'remote');
    const aSync = makeSync(aHome, remote, 'a1b2c3d4');
    const bSync = makeSync(bHome, remote, 'e5f6a7b8');
    const uploaded = await aSync.upload();
    assert.equal(uploaded.ok, true, JSON.stringify(uploaded));

    const patchPath = join(bHome, 'dsh-home', 'profiles', 'desktop', 'cordis.patch.yml');
    writeFileSync(patchPath, '本地改动-1\n');
    const first = await bSync.applyRemote(uploaded.name);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.ok(first.snapshotPath, '首次覆盖应生成快照');

    writeFileSync(patchPath, '本地改动-2\n');
    const second = await bSync.applyRemote(uploaded.name);
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.ok(second.snapshotPath);
    assert.notEqual(second.snapshotPath, first.snapshotPath, '两次应用不能共用同一快照目录');
    assert.ok(existsSync(first.snapshotPath), '第一份快照应保留');
    // 快照里保留的是各自被覆盖前的本地内容
    assert.equal(readFileSync(join(second.snapshotPath, 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8'), '本地改动-2\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function readdirNames(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
