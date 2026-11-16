# 项目约定

## npm 发布

完整步骤与踩坑见 [`docs/release-npm.md`](docs/release-npm.md)。执行要点：

1. 改版本号（`package.json`）、`docs/updates.md`、`CHANGELOG.md`；
2. 构建（`tsc -p tsconfig.json` + `corepack pnpm run build:client`）并跑测试；
3. `npm pack` 生成 `pandablessing-dsh-user-sync-<版本>.tgz`，再 `--dry-run` 预演；
4. `npm login --auth-type=web`，把打印的登录链接发给用户，等其在浏览器确认；
5. 用户提供 6 位验证码后，由助手执行：

   ```bash
   npm publish ./pandablessing-dsh-user-sync-<版本>.tgz --access public --otp=<验证码>
   ```

6. 等 1–3 分钟查 registry，确认 `dist-tags.latest` 已指向新版本；顺带清理无效 dist-tag。

注意：

- 一律用 `npm.cmd` 全路径（PowerShell 禁止运行 `npm.ps1`）；
- 仓库里的受限 token（`H:\work\token\npm_token.txt`、`H:\work\dsh\npm-token.txt`）不能发布，`npm publish` 会返回 404，必须走第 4 步的交互登录；
- 发布命令以 exit code 1 结束、或提示「being processed」都不代表失败，以 registry 校验为准。
