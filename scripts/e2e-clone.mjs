// 替代换机演练：A 机上传真实用户资产 → B 机清空为初始状态 → 从远端恢复。
// 默认**本地模式**：临时起一个 server（本地磁盘存储），不写入真实 WebDAV。
// 用法：
//   node scripts/e2e-clone.mjs              # 本地模式（推荐）
//   node scripts/e2e-clone.mjs --remote <baseUrl> [accountKey]   # 真实服务端（会在 WebDAV 留下测试账号目录）
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSync } from '../lib/sync.js';
import { createApiTransport } from '../lib/transport/api.js';

const args = process.argv.slice(2);
const remoteIndex = args.indexOf('--remote');
const remoteMode = remoteIndex >= 0;

const root = mkdtempSync(join(tmpdir(), 'dsh-e2e-clone-'));
const accountKey = (remoteMode ? args[remoteIndex + 2] : args[1]) ?? '0123456789abcdef';

let server = null;
let baseUrl = null;

async function startLocalServer() {
  const port = 19000 + Math.floor(Math.random() * 900);
  const dataDir = join(root, 'server-data');
  mkdirSync(dataDir, { recursive: true });
  server = spawn(process.execPath, [join(import.meta.dirname, '..', 'server', 'dist', 'index.js')], {
    env: { ...process.env, DSH_SYNC_PORT: String(port), DSH_SYNC_DATA: dataDir },
    stdio: 'ignore',
  });
  baseUrl = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 30; i++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    try {
      const response = await fetch(`${baseUrl}/v1/health`);
      if (response.ok) return;
    } catch {
      // 还没起来
    }
  }
  throw new Error('本地服务端启动超时');
}

if (remoteMode) {
  baseUrl = args[remoteIndex + 1];
  if (!baseUrl) {
    console.error('用法: node scripts/e2e-clone.mjs --remote <baseUrl> [accountKey]');
    process.exit(2);
  }
} else {
  await startLocalServer();
}
console.log(remoteMode ? `远端模式: ${baseUrl}` : `本地模式: ${baseUrl}（storage=local）`);

const realHome = join(homedir(), '.dsh');
const sourceHome = join(root, 'source');
const targetHome = join(root, 'target');
const sourceUserHome = join(root, 'user-home-a');
const targetUserHome = join(root, 'user-home-b');

const copy = (from, to) => {
  if (!existsSync(from)) return false;
  mkdirSync(join(to, '..'), { recursive: true });
  cpSync(from, to);
  return true;
};

// A 机：复制真实用户级资产（只读，不动真实目录）
const files = [
  ['AGENTS.md', 'AGENTS.md'],
  ['profiles/desktop/package.json', 'profiles/desktop/package.json'],
  ['profiles/desktop/cordis.patch.yml', 'profiles/desktop/cordis.patch.yml'],
  ['profiles/desktop/cordis.yml', 'profiles/desktop/cordis.yml'],
  ['profiles/desktop/pnpm-workspace.yaml', 'profiles/desktop/pnpm-workspace.yaml'],
  ['profiles/desktop/pnpm-lock.yaml', 'profiles/desktop/pnpm-lock.yaml'],
  ['memories/MEMORY.md', 'memories/MEMORY.md'],
];
const copied = files.filter(([rel]) => copy(join(realHome, rel), join(sourceHome, rel)));
console.log('A 机已复制', copied.length, '个文件');

const makeSync = (dshHome, userHome, transport, tag) =>
  createSync({
    dshHome,
    userHome,
    profileName: 'desktop',
    transport,
    statePath: join(root, `${tag}-state.json`),
    historyPath: join(root, `${tag}-history.jsonl`),
    lockPath: join(root, `${tag}-lock`),
    preRestoreRoot: join(root, `${tag}-pre-restore`),
  });

let failed = 0;
try {
  // A 机上传
  const transportA = createApiTransport({ baseUrl, authPath: join(root, 'a-auth.json') });
  const registered = await transportA.register(accountKey);
  console.log('A 注册/登录 ok, token:', registered.token.slice(0, 8) + '...');
  const syncA = makeSync(sourceHome, sourceUserHome, transportA, 'a');
  const uploaded = await syncA.upload();
  if (!uploaded.ok) throw new Error(`A 上传失败: ${JSON.stringify(uploaded).slice(0, 300)}`);
  console.log('A 上传 ok:', uploaded.packageId, 'files=', uploaded.manifest.files.length, 'bytes=', uploaded.size);

  // B 机：空目录（初始状态），只 login 取回同一 token
  mkdirSync(targetHome, { recursive: true });
  const transportB = createApiTransport({ baseUrl, authPath: join(root, 'b-auth.json') });
  const login = await transportB.login(accountKey);
  console.log('B 登录取回同一 token:', login.token === registered.token);
  const syncB = makeSync(targetHome, targetUserHome, transportB, 'b');
  const checked = await syncB.check();
  console.log('B 检查:', checked.decision.action, '/', checked.decision.reason, 'latest=', checked.latest?.name);
  if (checked.decision.action !== 'pull') throw new Error(`B 应判定为 pull，实际: ${checked.decision.action}`);

  const applied = await syncB.applyRemote(checked.latest.name);
  if (!applied.ok) throw new Error(`B 应用失败: ${JSON.stringify(applied).slice(0, 300)}`);
  console.log('B 应用 ok: 写入', applied.written.length, '跳过', applied.skipped.length);

  // 断言：关键文件在 B 机恢复且内容一致
  for (const [rel] of files) {
    const from = join(sourceHome, rel);
    if (!existsSync(from)) continue;
    const to = join(targetHome, rel);
    if (!existsSync(to)) {
      console.error('缺失:', rel);
      failed++;
      continue;
    }
    if (readFileSync(from, 'utf8') !== readFileSync(to, 'utf8')) {
      console.error('内容不一致:', rel);
      failed++;
    }
  }
  console.log(failed === 0 ? '断言通过：A 的资产已在 B 机按字节恢复' : `断言失败：${failed} 个文件`);
} finally {
  if (server) {
    server.kill();
  }
  rmSync(root, { recursive: true, force: true });
  if (remoteMode) {
    console.log('提示：远端模式会在 WebDAV 留下空账号目录（坚果云 DELETE 目录 403），需要手动清理。');
  }
}
process.exit(failed === 0 ? 0 : 1);
