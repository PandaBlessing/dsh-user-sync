# dsh-user-sync

**换机、多台电脑用 DSH，不用再手动拷 `~/.dsh`。**

DeepSeek Harness（DSH）的**用户级配置同步插件**：把技能、插件清单、配置、记忆在设备间对齐——新机器装一次、点一下，环境和老机器一致。

[![npm](https://img.shields.io/npm/v/@pandablessing/dsh-user-sync)](https://www.npmjs.com/package/@pandablessing/dsh-user-sync)
[![license](https://img.shields.io/badge/license-MulanPSL--2.0-blue)](LICENSE)

## 前置条件

- DSH `>= 0.2.0-rc.2`（Node `>= 22`）；
- 一个可用的 DeepSeek 账号（用于自动配对，不需要注册任何运营方账号）；
- 桌面端：Windows / macOS 已验证，Linux 未验证。

## 30 秒上手

**方式一：DSH 界面安装**

1. 打开 DSH → **设置 → 内置插件** → 「安装插件」→ 输入 `@pandablessing/dsh-user-sync`；
2. **重启 DSH** → 设置 → 设置同步 → 同意并启用 → 上传用户配置。

**方式二：命令行安装**

```bash
cd ~/.dsh/profiles/desktop
pnpm add @pandablessing/dsh-user-sync
# 重启 DSH → 设置 → 设置同步 → 同意并启用 → 上传用户配置
```

换到新机器，同样装一次 → 设置同步 → **从远端同步**。

> 包名必须用 `@pandablessing/dsh-user-sync`；若装过旧名 `dsh-user-sync`，先删掉旧条目（junction / dependencies / bundles）再装，否则会重复注册面板。

## 它能解决什么

| 痛点 | 以前 | 现在 |
|---|---|---|
| 换台电脑，DSH 环境全空 | 手动 `scp -r ~/.dsh`，漏文件、带错配置 | 点「从远端同步」，覆盖前弹窗确认 |
| 插件装不回来 | 一个个翻 `package.json` 重新 `pnpm add` | 按远端清单**自动装回**，失败项单独列出 |
| 配置改乱了想回滚 | 无备份 | 每次应用前生成 `pre-restore` 快照 |
| 担心密钥被传走 | —— | 文件名黑名单 + 内容模式扫描，命中直接拒绝打包 |

**同步范围（四类用户级）：** 技能 `~/.agents/skills`、插件清单（profile 声明与锁文件）、配置 `cordis.patch.yml`（含自定义 agent 预设）、用户记忆 `AGENTS.md` + `memories/`。项目记忆默认不选，会话不参与同步。

## 功能细节

- **四类用户级资产**：技能、插件清单、配置（`cordis.patch.yml`，含自定义 agent 预设）、用户记忆；项目记忆默认不选，会话不参与同步。
- **包级新覆盖旧**：按 `createdAt` 比较，覆盖前弹窗确认，先快照再写盘。
- **敏感数据硬拒绝**：文件名黑名单 + 内容模式，命中即拒绝打包并列出文件与行号。
- **官方账号自动配对**：用 `deepseekAccount` 派生 `accountKey` 自动换 token，无需运营方登录。
- **缺插件自动装回**：应用远端包后按 `manifest.dependencies` 自动安装，结果列出已装 / 失败 / 需手动放回（`link:` 依赖）。
- **自动检查 + 更新提示**：启动 + 每 6 小时（可配）只读远端元数据；发现 npm 新版本时面板顶部给出「更新插件」按钮，完成后弹窗提示重启。
- **用户反馈**：面板「自动检查」卡片右侧「反馈」按钮，可提交设计建议 / 功能建议 / 问题，成功显示反馈编号，未提交内容自动存草稿。
## 更新插件

面板发现 npm 上有新版本时，顶部会出现「**更新插件**」按钮：点击后自动安装并提示重启 DSH。

也可以手动更新：

```bash
cd ~/.dsh/profiles/desktop
pnpm add @pandablessing/dsh-user-sync@latest
```

> 开发安装（junction/link）下「更新插件」按钮会提示「请重启 DSH 加载最新代码」，不会执行 pnpm add。

## 使用

- 「上传用户配置」→ 打包并上传（远端更新时先确认再用本机覆盖）；
- 「从远端同步」→ 检查远端，覆盖前弹窗确认；
- 「反馈」→ 提交设计建议 / 功能建议 / 问题。

服务地址内置（`https://dsh-user-sync-test.wenzhi.info`），传输固定走运营方 API；需要自建服务时在 `state.json` 写 `baseUrl` 覆盖。
## 卸载与回滚

**卸载**：

```bash
cd ~/.dsh/profiles/desktop
pnpm remove @pandablessing/dsh-user-sync
# 重启 DSH 后面板消失；本地状态在 ~/.dsh/user-sync/（可保留或手动删除）
```

开发安装用 `scripts\uninstall-dev.cmd` 回滚。

**回滚到应用前**：每次「从远端同步」前都会生成 `pre-restore` 快照（`~/.dsh/user-sync/pre-restore/`），把快照里的文件拷回即可恢复；也可以从远端重新应用一份更早的包。

## 错误码排查

| 错误码 | 含义 | 处理 |
|---|---|---|
| `E_REMOTE_NEWER` | 远端包比本机新（别的设备上传过） | 确认后用本机覆盖，或先「从远端同步」 |
| `E_QUOTA_EXCEEDED` | 超出配额（单包 10MB / 总 50MB） | 清理远端旧包或联系维护者扩容 |
| `E_LOCKED` | 有另一个同步操作正在进行 | 等它结束后重试 |
| `E_BAD_NAME` | 包名/标识非法 | 重新打包上传 |
| `E_DEV_LINK` | 开发安装（junction）不支持「更新插件」 | 重启 DSH 加载最新代码 |

## 架构

```text
插件（HTTP 客户端） ──HTTPS──▶ 运营方 API ──WebDAV──▶ 坚果云
      │                          │
      └─ 本地 state.json          └─ 鉴权 / 配额 / 隔离 / 审计 / 反馈
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

## 常见问题（FAQ）

**换机后插件没自动装回？** 看应用结果里的失败清单；`link:` 本地依赖需要手工把目标目录放回再装。

**上传被拒？** 命中敏感文件规则（文件名黑名单 / 内容模式），按提示移除或改到不同步的目录。

**面板改了没生效？** host 代码热重载即可；client（面板 UI）需要重启 DSH。

**配对失败？** 检查网络与 DeepSeek 账号状态；自动配对用官方账号 id 派生 key，不需要任何运营方登录。

**同步后配置没生效？** 重启 DSH（config 是启动时加载的）。

## 已知限制

- 桌面端整机验证以 Windows / macOS 为主，Linux 未验证。
- `link:` 本地依赖需要手工放回目标机。
- 远端只保留 1 份包，回滚依赖本地 `pre-restore` 快照。
- 多机用户记忆目前是包级覆盖（不做合并）。
- **每账号只保留 1 份包**，单包上限 **10 MB**（即每账号上限 10 MB）；
- 坚果云单账号有流量配额，频繁上传/下载可能触发限流；服务端单节点，反馈接口有内存限流。

## 更新日志

- **使用者视角**（讲你能感知的变化）：[docs/updates.md](docs/updates.md)；
- **技术变更记录**（接口/实现细节，给开发看）：[CHANGELOG.md](CHANGELOG.md)。

## 仓库结构

```text
docs/                   设计 / 用例 / 部署 / 更新日志 / 测试结果
lib/                    插件（宿主 + client + 传输 + 同步编排）
server/                 运营方 API（纯 node:http）+ 反馈
scripts/                安装 / 卸载 / 冒烟 / 换机演练 / 发布 / npm 安装冒烟
test/                   单元、组件、时序测试与 fixtures
legacy/                 需求稿与原型脚本
```

## License

[Mulan PSL v2](LICENSE)

## 赞赏

插件免费开源（MulanPSL-2.0）。如果它帮你省过换机时间，欢迎小额赞赏，用于服务端坚果云空间与持续维护。赞赏自愿，不影响功能与权益。

![微信赞赏码](docs/assets/sponsor-wechat.jpg)
