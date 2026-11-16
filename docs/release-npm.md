# npm 发布流程

本文记录 `@pandablessing/dsh-user-sync` 的实际发布步骤（以 1.0.36 为参照），以后按此执行。
最后一步 `npm publish` 由助手执行、验证码由用户提供。

## 0. 环境前提

- 必须用 `npm.cmd`，不能直接 `npm`：PowerShell 执行策略禁止运行 `G:\Program Files (x86)\Nodejs\npm.ps1`。
  统一写成：`& "G:\Program Files (x86)\Nodejs\npm.cmd" <命令>`。
- `H:\work\token\npm_token.txt`、`H:\work\dsh\npm-token.txt` 里的 token 是**受限 token**：
  能 `whoami`、能改 `dist-tag`，但 `npm publish` 恒返回 `404 Not Found - PUT https://registry.npmjs.org/@pandablessing%2fdsh-user-sync`。
  发布必须走交互登录会话（第 5 步）。

## 1. 改版本号与文档

| 文件 | 改什么 |
|---|---|
| `package.json` | `version` 改为新版本，例如 `1.0.36` |
| `docs/updates.md` | 顶部「当前线上版本：**x.y.z**」同步改；在上一版段落前插入新版段 |
| `CHANGELOG.md` | 同上，插入 `### x.y.z（日期）` 段 |

## 2. 构建

```powershell
cd H:\work\dsh\dsh-user-sync
node node_modules/typescript/bin/tsc -p tsconfig.json
corepack pnpm run build:client
```

- `tsc` 产出 `lib/`（DSH 实际加载 `exports["./client"] = "./lib/client.js"`）；
- `build:client`（tsdown）产出 `client/client.js`。

## 3. 跑测试

```powershell
node --test test/plugins-sync.test.js test/sync.test.js test/pnpm.test.js test/plugins.test.js test/client-ui-actions.test.js
```

1.0.36 实测 68 项全通过。若改动涉及服务端，另跑 `node node_modules/typescript/bin/tsc -p server/tsconfig.json`。

## 4. 生成可发布产物并预演

```powershell
& "G:\Program Files (x86)\Nodejs\npm.cmd" pack
& "G:\Program Files (x86)\Nodejs\npm.cmd" publish ./pandablessing-dsh-user-sync-<版本>.tgz --access public --dry-run
```

记录输出里的 `package size` / `unpacked size` / `shasum` / `integrity` / `total files`。
`--dry-run` 返回 exit code 1 属正常（只预演不发布）。

## 5. 交互登录（每次发布前都要做）

```powershell
& "G:\Program Files (x86)\Nodejs\npm.cmd" login --auth-type=web
```

命令会打印一次性链接：

```
Login at:
https://www.npmjs.com/login?next=/login/cli/<uuid>
```

把链接发给用户，用户在浏览器点确认；命令输出 `Logged in on https://registry.npmjs.org/.` 即成功
（该命令常以 exit code 1 结束，看输出为准）。随后 `npm whoami` 应返回 `pandablessing`。

## 6. 发布（用户提供验证码）

```powershell
& "G:\Program Files (x86)\Nodejs\npm.cmd" publish ./pandablessing-dsh-user-sync-<版本>.tgz --access public --otp=<用户给的 6 位码>
```

- OTP 30 秒有效：拿到码立刻执行，不要先做别的。
- 成功输出 `+ @pandablessing/dsh-user-sync@<版本>`，随后是
  `Your package is being processed and may take a few minutes to become available.`
  **此时 registry 还没更新，属正常**；命令可能以 exit code 1 结束，不代表失败。
- 同一版本重复发布返回 `E409`，说明已成功。

## 7. 验证发布结果

发布后 1–3 分钟再查（立即查必然还是旧版本）：

```powershell
& "G:\Program Files (x86)\Nodejs\npm.cmd" view @pandablessing/dsh-user-sync version
& "G:\Program Files (x86)\Nodejs\npm.cmd" view @pandablessing/dsh-user-sync dist-tags --json
```

或直查 registry：

```powershell
(Invoke-WebRequest -UseBasicParsing -Uri "https://registry.npmjs.org/@pandablessing%2Fdsh-user-sync" -TimeoutSec 30).Content
```

确认 `dist-tags.latest` 指向新版本，且 `versions` 列表末尾出现新版本号。

## 8. 清理无效 dist-tag

测试期可能留下 `probe` 之类的标签（例如 `probe: 1.0.34`）：

```powershell
& "G:\Program Files (x86)\Nodejs\npm.cmd" dist-tag rm @pandablessing/dsh-user-sync probe --otp=<验证码>
```

输出 `-probe: @pandablessing/dsh-user-sync@<版本>` 即删除成功。最终只应保留 `latest`。

## 9. 提交与同步仓库

```powershell
git add package.json docs/updates.md CHANGELOG.md lib client src
git commit -m "chore(release): <版本>"     # 提交前需用户确认
git push origin master                      # Gitee：gray-panda/dsh-user-sync
```

GitHub 镜像（`PandaBlessing/dsh-user-sync`）不能直接 `git push`（会被重置），用脚本按 API 同步：

```powershell
node "$env:TEMP\dsh-asar\sync-github.mjs"
```

脚本会：读 `git ls-files` 全量上传 blobs → 建 tree → 以 GitHub main 为 parent 提交 → 更新 main。

## 10. 踩坑记录

| 现象 | 原因 / 处理 |
|---|---|
| `npm : 无法加载文件 ... npm.ps1，因为在此系统上禁止运行脚本` | 用 `npm.cmd` 全路径调用 |
| `E404 Not Found - PUT https://registry.npmjs.org/@pandablessing%2fdsh-user-sync` | 当前是受限 token；改为 `npm login --auth-type=web` 会话 |
| 发布返回 `+ 包@版本` 但 `npm view version` 仍是旧版 | registry 异步处理，等 1–3 分钟 |
| `EOTP` | 验证码过期或没传；重新要码 |
| `E409` | 该版本已发布成功 |
