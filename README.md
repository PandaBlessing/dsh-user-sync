# dsh-user-sync

**换机、多台电脑用 DSH，不用再手动拷 `~/.dsh`。**

DeepSeek Harness（DSH）的**用户级配置同步插件**：把技能、插件清单、配置、记忆在设备间对齐——新机器装一次、点一下，环境和老机器一致。

[![npm](https://img.shields.io/npm/v/@pandablessing/dsh-user-sync)](https://www.npmjs.com/package/@pandablessing/dsh-user-sync)
[![license](https://img.shields.io/badge/license-MulanPSL--2.0-blue)](LICENSE)

## 30 秒上手

```bash
cd ~/.dsh/profiles/desktop
pnpm add @pandablessing/dsh-user-sync
# 重启 DSH → 设置 → 设置同步 → 同意并启用 → 上传用户配置
```

换到新机器，同样装一次 → 设置同步 → **从远端同步**。

## 它能解决什么

| 痛点 | 以前 | 现在 |
|---|---|---|
| 换台电脑，DSH 环境全空 | 手动 `scp -r ~/.dsh`，漏文件、带错配置 | 点「从远端同步」，覆盖前弹窗确认 |
| 插件装不回来 | 一个个翻 `package.json` 重新 `pnpm add` | 按远端清单**自动装回**，失败项单独列出 |
| 配置改乱了想回滚 | 无备份 | 每次应用前生成 `pre-restore` 快照 |
| 担心密钥被传走 | —— | 文件名黑名单 + 内容模式扫描，命中直接拒绝打包 |

**同步范围（默认四类用户级）：** 技能 `~/.agents/skills`、插件清单（profile 声明与锁文件）、配置 `cordis.patch.yml`（含自定义 agent 预设）、用户记忆 `AGENTS.md` + `memories/`。

## 截图

> 面板截图放在 `docs/assets/`，欢迎 PR 补充（设置同步面板 / 恢复结果 / 运营监控页）。

## 和「手动拷 .dsh」/ 其他同类的差别

| | 手动拷 `.dsh` | 本插件 |
|---|---|---|
| 跨机恢复 | 整目录搬，容易带错机器专属状态 | 只同步四类用户级资产，会话/项目记忆不参与 |
| 插件 | 手动重装 | 自动装回，失败清单可见 |
| 覆盖安全 | 无确认 | 弹窗确认 + 快照回滚 + 远端新包拦截（`E_REMOTE_NEWER`） |
| 隐私 | 全量拷贝 | 敏感文件硬拒绝（黑名单 + 内容模式） |
| 登录 | —— | 用官方账号 id 自动派生 key，**没有运营方登录入口** |

> 同类项目还有 [dsh-sync](https://awesome-dsh-plugin.com/zh/p/huangfuren/dsh-sync/) 等；本插件侧重「自动装回插件 + 敏感数据硬拒绝 + 可自建服务端」。

## 安全与数据

- 存储凭据只在运营方服务端，插件包内不含任何存储口令；
- 上传内容经 HTTPS 到运营方 API，再落到坚果云 WebDAV；**远端只保留 1 份包，上传即覆盖**；
- 想自建：服务端是纯 `node:http` 零依赖，见 [docs/deploy.md](docs/deploy.md)，在 `state.json` 写 `baseUrl` 即可指向自己的服务。

## 功能细节

- **四类用户级资产**：技能、插件清单、配置（`cordis.patch.yml`，含自定义 agent 预设）、用户记忆；项目记忆默认不选，会话不参与同步。
- **新覆盖旧**：包级 `createdAt` 比较，不做合并；覆盖前弹窗确认，先快照再写盘。
- **上传前查远端**：远端已被别的设备更新时先拦下（`E_REMOTE_NEWER`），确认后才用本机覆盖。
- **敏感数据硬拒绝**：文件名黑名单 + 内容模式，命中即拒绝打包并列出文件与行号。
- **官方账号自动配对**：用 `deepseekAccount` 派生 `accountKey` 自动换 token，无需运营方登录。
- **缺插件自动装回**：应用远端包后按 `manifest.dependencies` 自动安装，结果列出已装 / 失败 / 需手动放回（`link:` 依赖）。
- **自动检查**：启动 + 每 6 小时（可配）只读远端元数据，发现更新只提示、不自动应用。
- **更新提示**：发现 npm 上有新版本时面板顶部给出「更新插件」按钮，完成后弹窗提示重启。

## 安装

### 从 npm

```bash
cd ~/.dsh/profiles/desktop
pnpm add @pandablessing/dsh-user-sync
```

profile 的 `package.json` 与 `cordis.patch.yml` 里必须使用 npm 包名 `@pandablessing/dsh-user-sync`；若此前用旧名 `dsh-user-sync` 装过，先删掉旧条目（junction / `dependencies` / bundles）再装，否则会重复注册面板。

安装后重启 DSH，在设置页启用「设置同步」。

### 开发期（junction 到本仓库）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-dev.ps1   # 装进 desktop profile
scripts\uninstall-dev.cmd                                                     # 回滚
```

## 使用

1. 设置 → 设置同步 → 首次点「同意并启用上传」；
2. 勾选同步范围（默认四类用户级）；
3. 「上传用户配置」→ 打包并上传（远端更新时先确认再用本机覆盖）；
4. 「从远端同步」→ 检查远端，覆盖前弹窗确认。

服务地址内置（`https://dsh-user-sync-test.wenzhi.info`），传输固定走运营方 API；需要自建服务时在 `state.json` 写 `baseUrl` 覆盖。

## 架构

```text
插件（HTTP 客户端） ──HTTPS──▶ 运营方 API ──WebDAV──▶ 坚果云
      │                          │
      └─ 本地 state.json          └─ 鉴权 / 配额 / 隔离 / 审计
```

- 插件侧只实现 `api` 传输；`folder` 仅用于本机调试。
- 存储凭据只在服务端，插件包内不含任何存储口令。
- 身份：官方账号 id → `accountKey`（sha256 前 16 位）→ 服务端分区。
- 远端只保留 1 份包，上传即覆盖；每次应用在本地生成 `pre-restore` 快照。

## 构建与测试

源码是 TypeScript，构建产物 `lib/` 与 `server/dist/` 已提交（junction 安装与部署直接用）。

```powershell
pnpm install
pnpm run build          # 插件：src/*.ts → lib/*.js
pnpm run build:server   # 服务端：server/src/*.ts → server/dist/*.js
pnpm test               # 单元 / 组件 / 时序（直接跑源码）
node scripts/audit-cases.mjs         # 用例清单与结果记录一致性审计
node scripts/e2e-clone.mjs           # 替代换机演练（本地模式，不写真实 WebDAV）
node scripts/verify-npm-install.mjs  # npm 安装冒烟（临时 profile，用完即删）
powershell -File scripts/smoke.ps1   # 真实 DSH 路由冒烟
```

## 开发与真实环境

- **日常开发（junction）**：`install-dev.ps1` 把仓库 link 进 profile，改源码 → `pnpm run build` → 热重载生效。
- **验证真实安装**：`verify-npm-install.mjs` 在临时 profile 里 `pnpm add` 已发布版本，校验 patch 名、宿主/client 入口与资源文件。
- 两者互不干扰：npm 安装的是编译产物副本，改源码不会生效，所以开发用 link、验证用临时 profile。

## 发布

发布时机由维护者决定（`scripts/publish.mjs` 只手动执行，agent 不自动发布）。

```bash
cp .env.local.example .env.local && chmod 600 .env.local   # 填 NPM_TOKEN
node scripts/publish.mjs --dry-run                         # 先看打包内容
node scripts/publish.mjs --otp=123456                      # 2FA 时带当次验证码
```

token 只写进 `0600` 临时 npmrc、发布后删除，不进命令行与 git；CI 可用 `NPM_TOKEN` 环境变量。发布前先 `pnpm run build && pnpm run build:server`。

## 已知限制

- 桌面端整机验证以 Windows / macOS 为主，Linux 未验证。
- 服务端单节点，未做限流与多副本；坚果云单账号有流量配额。
- `link:` 本地依赖需要手工放回目标机。
- 远端只保留 1 份包，回滚依赖本地 `pre-restore` 快照。

## 赞赏

插件免费开源（MulanPSL-2.0）。如果它帮你省过换机时间，欢迎小额赞赏，用于服务端坚果云空间与持续维护。赞赏自愿，不影响功能与权益。

![微信赞赏码](docs/assets/sponsor-wechat.jpg)

## 仓库结构

```text
docs/                   设计 / 用例 / 部署 / 测试结果
lib/                    插件（宿主 + client + 传输 + 同步编排）
server/                 运营方 API（纯 node:http）
scripts/                安装 / 卸载 / 冒烟 / 换机演练 / 发布 / npm 安装冒烟
test/                   单元、组件、时序测试与 fixtures
legacy/                 需求稿与原型脚本
```

## License

[Mulan PSL v2](LICENSE)
