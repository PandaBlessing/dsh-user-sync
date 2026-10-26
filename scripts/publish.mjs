// npm 发布脚本：token 只从环境变量或本地 .env.local 读取，不进命令行、不进仓库。
//
// 用法：
//   node scripts/publish.mjs --dry-run            # 只打包校验，不真正发布
//   node scripts/publish.mjs --otp=123456         # 账号开了 2FA 时传当次验证码
//   npm run publish:npm -- --otp=123456
//   NPM_TOKEN=xxx node scripts/publish.mjs        # CI 里用环境变量，优先级高于 .env.local
//
// token 存放位置与约定见 .env.local.example（第一行顶部注释）。
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
const token = process.env.NPM_TOKEN || localEnv.NPM_TOKEN || '';
const registry = process.env.NPM_REGISTRY || localEnv.NPM_REGISTRY || 'https://registry.npmjs.org/';
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

if (!token) {
  console.error('缺少 npm token：请在仓库根创建 .env.local 并写入 NPM_TOKEN，或设置 NPM_TOKEN 环境变量。');
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

// pnpm 默认要求 git 干净；发布脚本允许在本地先 dry-run 校验，故显式关闭 git 检查
const npmArgs = ['publish', '--registry', registry, '--tag', tag, '--no-git-checks'];
if (otp) npmArgs.push('--otp', otp);
if (dryRun) npmArgs.push('--dry-run');

console.log(`发布 ${pkg.name}@${pkg.version} → ${registry}（tag: ${tag}${dryRun ? '，dry-run' : ''}）`);
console.log(otp ? '已提供 OTP（有效期约 30 秒）' : '未提供 OTP：账号若开了 2FA 会返回 EOTP，用 --otp=<6 位码> 重试');

/** 选发布命令：优先 DSH 运行时自带的 pnpm（Windows 上通常没装 npm），其次 npm_execpath，最后 PATH 里的 npm/pnpm。 */
function resolvePublishCommand() {
  const pnpmCjs = join(dirname(process.execPath), '..', '..', 'pnpm', 'bin', 'pnpm.cjs');
  if (existsSync(pnpmCjs)) return { command: process.execPath, prefix: [pnpmCjs] };
  if (process.env.npm_execpath && existsSync(process.env.npm_execpath)) {
    return { command: process.execPath, prefix: [process.env.npm_execpath] };
  }
  return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', prefix: [] };
}

const { command, prefix } = resolvePublishCommand();
const child = spawn(command, [...prefix, ...npmArgs], {
  cwd: root,
  stdio: 'inherit',
  // pnpm 只认环境变量形式的 userconfig（没有 --userconfig 选项）
  env: { ...process.env, npm_config_userconfig: configPath },
});
const code = await new Promise((resolve) => child.on('close', resolve));
rmSync(configDir, { recursive: true, force: true });

if (code !== 0) {
  console.error(`\n发布失败（退出码 ${code}）。若报 EOTP，说明需要 2FA 验证码：npm run publish:npm -- --otp=<6 位码>`);
}
process.exit(code ?? 1);
