// npm 安装冒烟：在临时 profile 里真实安装已发布的包，校验「用户安装路径」是否可用。
//
// 用途：日常开发用 junction（install-dev.ps1，改源码 + tsc + 热重载即生效）；
// 发布后用本脚本在干净目录验证 npm 包能被 DSH 正常解析与加载，两者互不干扰。
//
// 用法（跨平台，Node 直接跑）：
//   node scripts/verify-npm-install.mjs                    # 验证 latest
//   node scripts/verify-npm-install.mjs --version 1.0.7    # 验证指定版本
//   node scripts/verify-npm-install.mjs --registry https://registry.npmjs.org/
//   node scripts/verify-npm-install.mjs --keep             # 保留临时目录便于排查
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PACKAGE = '@pandablessing/dsh-user-sync';

const args = process.argv.slice(2);
const valueOf = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
};
const version = valueOf('--version', 'latest');
const registry = valueOf('--registry', 'https://registry.npmjs.org/');
const keep = args.includes('--keep');

/** 定位 DSH 运行时自带的 node/pnpm（没有就回退 PATH 上的 pnpm）。 */
function resolveToolchain() {
  const runtimeRoot = join(homedir(), '.dsh', 'dsh-runtimes');
  const candidates = [];
  if (existsSync(runtimeRoot)) {
    for (const name of ['dsh-primary-runtime']) {
      candidates.push(join(runtimeRoot, name, 'dependencies'));
    }
  }
  for (const dependencies of candidates) {
    const node = process.platform === 'win32' ? join(dependencies, 'node', 'bin', 'node.exe') : join(dependencies, 'node', 'bin', 'node');
    const pnpmCjs = join(dependencies, 'pnpm', 'bin', 'pnpm.cjs');
    if (existsSync(node) && existsSync(pnpmCjs)) return { node, pnpmCjs };
  }
  return null;
}

function run(command, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { stdio: 'inherit', ...options });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`命令失败（退出码 ${code}）：${command} ${commandArgs.join(' ')}`))));
  });
}

/** 从 registry 解析要验证的精确版本（pnpm 的元数据缓存可能把 latest 解析成旧版）。 */
async function resolveVersion() {
  if (version !== 'latest') return version;
  const encoded = encodeURIComponent(PACKAGE).replace('%2F', '%2f');
  const response = await fetch(`https://registry.npmjs.org/-/package/${encoded}/dist-tags`);
  if (!response.ok) throw new Error(`查询 dist-tags 失败：HTTP ${response.status}`);
  const tags = await response.json();
  return tags.latest;
}

const failures = [];
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

const root = mkdtempSync(join(tmpdir(), 'dsh-npm-smoke-'));
const profileDir = join(root, 'profiles', 'desktop');
let currentNode = process.execPath;
let pnpmCjs = null;

try {
  const toolchain = resolveToolchain();
  if (toolchain) {
    currentNode = toolchain.node;
    pnpmCjs = toolchain.pnpmCjs;
  }

  mkdirSync(profileDir, { recursive: true });
  // 最小 profile：只声明空 bundles，模拟用户新机
  writeFileSync(
    join(profileDir, 'package.json'),
    `${JSON.stringify({ name: 'profile-desktop', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2)}\n`,
    'utf8',
  );

  console.log(`临时 profile: ${profileDir}`);
  console.log(`安装 ${PACKAGE}@${version}（registry: ${registry}）`);
  const resolved = await resolveVersion();
  if (resolved !== version) console.log(`registry latest = ${resolved}`);
  const spec = `${PACKAGE}@${resolved}`;
  if (pnpmCjs) {
    await run(currentNode, [pnpmCjs, 'add', spec, '--registry', registry, '--config.minimumReleaseAge=0'], { cwd: profileDir });
  } else {
    await run('pnpm', ['add', spec, '--registry', registry, '--config.minimumReleaseAge=0'], { cwd: profileDir });
  }

  const requireFromProfile = createRequire(join(profileDir, 'package.json'));
  const pkgRoot = join(profileDir, 'node_modules', PACKAGE);
  const installed = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
  check('包已安装', true, `${installed.name}@${installed.version}`);
  check('未标记 private', installed.private !== true);
  check('含 dsh.bundle 声明', Boolean(installed.dsh?.bundle?.patch), String(installed.dsh?.bundle?.patch));
  check('含 dsh.client 声明', Boolean(installed.dsh?.client), JSON.stringify(installed.dsh?.client ?? null));

  // 契约 1：patch 的 name 必须等于包名（否则 DSH 解析不到 → ERR_MODULE_NOT_FOUND）
  const patch = readFileSync(join(pkgRoot, 'cordis.patch.yml'), 'utf8');
  const patchName = patch.match(/^\s*name:\s*"?([^"\n]+)"?\s*$/m)?.[1]?.trim() ?? '';
  check('patch name 与包名一致', patchName === installed.name, patchName);

  // 契约 2：宿主入口可解析且可导入
  const hostEntry = requireFromProfile.resolve(PACKAGE);
  const hostModule = await import(pathToFileURL(hostEntry).href);
  check('宿主入口可导入', typeof hostModule.apply === 'function', `exports: ${Object.keys(hostModule).join(',')}`);
  check('宿主入口导出 inject 数组', Array.isArray(hostModule.inject), JSON.stringify(hostModule.inject));

  // 契约 3：client 入口可解析，且在 Node 侧预检 import 不抛错（window is not defined 会导致 web boot 失败）
  const clientEntry = requireFromProfile.resolve(`${PACKAGE}/client`);
  let clientOk = false;
  try {
    await import(pathToFileURL(clientEntry).href);
    clientOk = true;
  } catch (error) {
    check('client 入口 Node 侧可导入', false, error.message.split('\n')[0]);
  }
  if (clientOk) check('client 入口 Node 侧可导入', true);

  // 契约 4：资源文件随包发布
  for (const file of ['locale/zh.json', 'cordis.patch.yml']) {
    check(`包含 ${file}`, existsSync(join(pkgRoot, file)));
  }
} catch (error) {
  console.error(`\n冒烟失败：${error.message}`);
  failures.push('执行过程');
} finally {
  if (keep) {
    console.log(`\n保留临时目录：${root}`);
  } else {
    rmSync(root, { recursive: true, force: true });
  }
}

if (failures.length === 0) {
  console.log('\n✅ npm 安装冒烟通过：该版本可以在干净环境安装并被 DSH 加载');
  process.exit(0);
}
console.error(`\n❌ 冒烟失败 ${failures.length} 项：${failures.join('、')}`);
process.exit(1);
