// npm 发布脚本：token 只从环境变量、本地 .env.local 或固定 token 文件读取，不进命令行、不进仓库。
//
// 用法：
//   node scripts/publish.mjs --dry-run            # 只打包校验，不真正发布
//   node scripts/publish.mjs --otp=123456         # 账号开了 2FA 时传当次验证码
//   npm run publish:npm -- --otp=123456
//   NPM_TOKEN=xxx node scripts/publish.mjs        # CI 里用环境变量
//
// token 优先级：NPM_TOKEN 环境变量 → .env.local → H:/work/dsh/npm-token.txt（可用 DSH_NPM_TOKEN_FILE 覆盖）。
//
// 发布策略（避免「一次发两个版本」）：
//   1. 优先用 npm-cli 直发（pnpm publish 在 2FA 账号下只暂存不确认，会阻塞同版本重发）；
//   2. 发布后轮询 registry，确认 dist-tags[tag] 指向本次版本才算成功；
//   3. 遇到 E409（版本已被暂存）时明确提示去网页确认，不建议直接换版本号。
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const root = join(import.meta.dirname, '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const otp = args.find((arg) => arg.startsWith('--otp='))?.slice('--otp='.length) ?? process.env.NPM_OTP;
const tag = args.find((arg) => arg.startsWith('--tag='))?.slice('--tag='.length) ?? 'latest';

/** 解析 KEY=VALUE 形式的本地环境文件；缺文件时返回空对象，不报错。 */
function readLocalEnv(path) {
  const values = {};
  if (!existsSync(path)) return values;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

const localEnv = readLocalEnv(join(root, '.env.local'));
const tokenFile = process.env.DSH_NPM_TOKEN_FILE || 'H:/work/dsh/npm-token.txt';
function readTokenFile(path) {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return '';
  }
}
const token = process.env.NPM_TOKEN || localEnv.NPM_TOKEN || readTokenFile(tokenFile) || '';
const registry = process.env.NPM_REGISTRY || localEnv.NPM_REGISTRY || 'https://registry.npmjs.org/';
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

if (!token) {
  console.error(`缺少 npm token：请设置 NPM_TOKEN，或在仓库根 .env.local 写入 NPM_TOKEN，或提供 ${tokenFile}。`);
  console.error('模板见 .env.local.example（.env.local 已被 .gitignore 忽略）。');
  process.exit(1);
}
if (!pkg.name || !pkg.version) {
  console.error('package.json 缺少 name/version，拒绝发布。');
  process.exit(1);
}

// 临时 userconfig：token 只落在 0600 的临时文件里，发布结束立即删除
const configDir = mkdtempSync(join(tmpdir(), 'dsh-publish-'));
const configPath = join(configDir, '.npmrc');
const host = new URL(registry).host;
writeFileSync(configPath, `registry=${registry}\n//${host}/:_authToken=${token}\n`, { mode: 0o600 });

console.log(`发布 ${pkg.name}@${pkg.version} → ${registry}（tag: ${tag}${dryRun ? '，dry-run' : ''}）`);
console.log(otp ? '已提供 OTP（有效期约 30 秒）' : '未提供 OTP：账号若开了 2FA 会返回 EOTP，用 --otp=<6 位码> 重试');

/** 优先用 npm-cli 直发（pnpm publish 在 2FA 下只暂存不确认）；找不到 npm 时才回退 pnpm。 */
function resolvePublishCommand() {
  const candidates = [
    process.env.npm_execpath,
    'C:/Program Files (x86)/Nodejs/node_modules/npm/bin/npm-cli.js',
    'C:/Program Files/Nodejs/node_modules/npm/bin/npm-cli.js',
    'G:/Program Files (x86)/Nodejs/node_modules/npm/bin/npm-cli.js',
    'G:/Program Files/Nodejs/node_modules/npm/bin/npm-cli.js',
    join(process.env.ProgramFiles ?? 'C:/Program Files', 'nodejs/node_modules/npm/bin/npm-cli.js'),
    join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'nodejs/node_modules/npm/bin/npm-cli.js'),
  ];
  for (const candidate of candidates) {
    if (candidate && candidate.endsWith('npm-cli.js') && existsSync(candidate)) {
      return { command: process.execPath, prefix: [candidate], pnpm: false };
    }
  }
  const pnpmCjs = join(dirname(process.execPath), '..', '..', 'pnpm', 'bin', 'pnpm.cjs');
  if (existsSync(pnpmCjs)) return { command: process.execPath, prefix: [pnpmCjs], pnpm: true };
  return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', prefix: [], pnpm: false };
}

const { command, prefix, pnpm } = resolvePublishCommand();
const argsList = ['publish', '--registry', registry, '--tag', tag];
if (otp) argsList.push('--otp', otp);
if (dryRun) argsList.push('--dry-run');
if (pnpm) argsList.push('--no-git-checks');
const child = spawn(command, [...prefix, ...argsList], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, npm_config_userconfig: configPath },
});
const code = await new Promise((resolve) => child.on('close', resolve));
rmSync(configDir, { recursive: true, force: true });

if (dryRun) {
  process.exit(code ?? 1);
}
if (code !== 0) {
  console.error(`\n发布失败（退出码 ${code}）。若报 EOTP，需要 2FA 验证码：node scripts/publish.mjs --otp=<6 位码>`);
  console.error('若报 409 / previously staged：该版本已被暂存，请到 npm 网页确认或删除，不要直接换版本号发布。');
  process.exit(code ?? 1);
}

/** 发布后验证：轮询 registry，直到 dist-tags[tag] 指向本次版本（最多 ~120 秒）。 */
async function verifyPublished() {
  const scopeName = pkg.name.replace('/', '%2F');
  const metaUrl = `${registry.replace(/\/$/, '')}/${scopeName}`;
  for (let i = 0; i < 12; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    try {
      const res = await fetch(`${metaUrl}?t=${Date.now()}`);
      const data = await res.json();
      const current = data?.['dist-tags']?.[tag];
      if (current === pkg.version) return true;
      console.log(`等待 registry 生效…（第 ${i + 1} 次，latest=${current ?? '未知'}）`);
    } catch {
      console.log(`registry 暂不可达（第 ${i + 1} 次）`);
    }
  }
  return false;
}

const verified = await verifyPublished();
if (!verified) {
  console.error('\n发布命令返回成功，但 registry 上 dist-tags 未指向本次版本（可能仍处于 staged 待确认）。');
  console.error('请到 npm 网页确认该版本，确认后再检查 registry；不要换版本号重发。');
  process.exit(1);
}
console.log(`\n确认完成：${pkg.name}@${pkg.version} 已是 ${tag}（registry 验证通过）。`);
process.exit(0);
