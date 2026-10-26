# dsh-user-sync 设计文档

> 状态：**草稿 v1.4（M0 收口：宿主事实核实 + 插件恢复路径 + 配置落盘修正）**
> 目标内核：DeepSeek Harness `0.2.1-rc.2`（本机实测）／Node `24.21.0`
> 初稿：2026-10-23
> 本文只写「要做成什么样、边界在哪」；实现细节随代码演进，不回填过程踩坑史。

---

## 1. 需求来源

| 来源 | 位置 | 结论摘录 |
|---|---|---|
| 官方反馈稿 | [需求反馈稿](../legacy/requirements.md) | 同一账号多设备（mac 配置、Windows 使用）插件与偏好全缺失；官方无账号级同步；桌面 profile 被 Electron 独占，CLI 无法代管 |
| 会话确认（2026-10-23） | 本会话 | 八条设计目标，见 §3（G1–G8） |
| 既有原型 | [dsh-profile-sync.ps1](../legacy/dsh-profile-sync.ps1) / [dsh-profile-sync.sh](../legacy/dsh-profile-sync.sh) | 只同步 profile 声明四件套；manifest v2；**删 CR 后算 SHA-256**；导入先校验 → 差异预览 → 自动备份 → 仅改写确有差异的文件 |

**本插件与原型的关系**：不是重写，是把「声明文件同步」升级为「四类用户资产同步」——增加技能、记忆两个真实资产根，增加载体抽象、新覆盖旧判定、设置面板。原型的 manifest v2 保持可读。

---

## 2. 已核实事实（决定设计的硬约束）

| # | 事实 | 来源 | 对设计的影响 |
|---|---|---|---|
| 1 | 用户是 `0.2.1-rc.2`，内置 Node `24.21.0`、pnpm `11.28.5` | `dsh --version`、[versions.json](file:///G:/Program%20Files%20%28x86%29/DeepSeek%20Harness/resources/runtime/versions.json) | `engines.node: ">=22"` 成立 |
| 2 | profile 可移植部分 = `package.json` + `cordis.patch.yml` + `cordis.yml` + `pnpm-workspace.yaml` + `node_modules` | `~/.dsh/profiles/desktop` 实测 | `node_modules` 不进包，按声明重装 |
| 3 | `desktop` profile 由 Electron 独占，`dsh plugin --profile desktop` 被拒 | 本机 CLI 输出 `profile "desktop" is managed exclusively by the Electron application` | 安装与配置入口必须在 GUI；插件自己的 CLI（可选）只做诊断 |
| 4 | 宿主只读 `engines.dsh` 与 `peerDependencies` 做兼容判定 | `dsh-plugin-manager/lib/types/operations.js:166`、`typert.host.js` 的 `requirements` 描述 | 不写 `dsh.compatibility`（宿主不读）；用 `engines.dsh` 范围声明 |
| 5 | 客户端 bundle 是手写 CJS：`window.__ModuleLoader__.load({ id, factory })`，`id` 必须等于包名 | [module-loader-contract.md](https://github.com/Arlenman/dsh-backup-sync/blob/main/docs/notes/module-loader-contract.md) | 不引入打包器、不写 JSX |
| 6 | `settings.section` 内容宽 **564px**（实测 559px），滚动由外壳负责 | [settings-section-contract.md](https://github.com/Arlenman/dsh-backup-sync/blob/main/docs/notes/settings-section-contract.md) | 面板单列布局，根节点不写 `height/overflow` |
| 7 | 路径权威来源是 `profileContext` 服务（`home` / `name` / `dir` / `patchPath` / `installAnchor`）；`launchEnvironment` 只是环境变量快照（`get('DSH_HOME')`），不是路径属性服务；宿主进程里没有 `DSH_PROFILE` | `dsh/lib/profile-boot-C14i-8IN.js:290-301`（asar 内）、`dsh-launch-environment/README.zh.md` | 禁止直接读 `process.env` 定位目录；主源用 `profileContext.home` |
| 8 | 技能库在 `<userHome>/.agents/skills`，**不在** `~/.dsh` 下 | 同上；本机两个目录当前都不存在（尚未装技能） | 数据面必须跨两个根 |
| 9 | 用户级记忆当前落在 `~/.dsh/AGENTS.md`（12.5 KB），`~/.dsh/memories/` 尚不存在 | 本机目录实测 | 记忆模块要同时认 AGENTS.md 与 memories/ |
| 10 | 账号有稳定 id：`deepseekAccount.getProfile()` 返回 `value.id`（可能为 `null`），跨设备一致；另有 `deviceId` 与匿名 id 两种标识，语义不同 | `dsh-deepseek-account-platform/lib/index.js:628-780`、`dsh-api-account-controller/lib/typert.host.js:61-72` | 可用账号 id 派生 `accountKey` 做远端分区；不能用匿名 id 认账号 |
| 11 | 官方账号 API 只有 10 个方法（getState/getProfile/getBalance/getUnnotifiedBonuses/ackBonusNotified/startSignIn/cancelSignIn/hasRunningAccountTasks/signOut/watch），**没有 sync/storage/upload**；`dsh-storage*` 是本地 KV（JSON 文件后端），不是云端 | `dsh-api-account-controller/lib/typert.host.js` 方法名提取；`dsh-storage/package.json` | 账号可作为**归属键**，但官方不提供同步存储；数据通道必须由用户自备 |
| 12 | 坚果云 WebDAV 实测（2026-10-23）：`PROPFIND` 207、`MKCOL` 201、`PUT` 201、`GET` 200、`DELETE` 文件 204、**`DELETE` 目录 403** | 本机 `curl.exe` 对 `https://dav.jianguoyun.com/dav/` 实测 | 清理策略只删文件、不删目录；目录创建后保留 |
| 13 | 第三方插件经 `ctx.inject(['deepseekAccount'], cb)` 可拿到账号服务；`getProfile()` 返回 `ready` 与 36 字符 id；`ctx.get('deepseekAccount')` 立即取为 `undefined`（加载时序） | 临时 profile + 探针插件实测（2026-10-23，已清理） | 实现必须用 `ctx.inject` 等待；`getProfile` 需联网，离线/未登录返回 `null` |
| 14 | `settings.yaml` 是**旧版遗留格式**：`dsh-settings` 启动后把 harness home 里的 `settings.yaml` 一次性导入同名 entry（`ui-developer-tools` → `ui-settings` 等），新版设置写在 profile 的 `cordis.patch.yml` | `dsh-settings/README.zh.md:35`、`dsh-settings/lib/index.js:343-348`（asar 内） | `config` 模块不收录 `settings.yaml`；本机 `<dshHome>` 下也确实没有该文件 |
| 15 | 插件依赖的官方安装入口是 `pluginManager` 服务（`TypertRemoteService`，服务名 `pluginManager`），方法 `listBundles` / `installBundle` / `removeBundle`；第三方插件可 `ctx.inject(['pluginManager'])` 注入后直接调用（无沙箱门槛，门槛只在 agent 工具层） | `dsh-plugin-manager/lib/index.js:1404-1605,1681-2140`、`lib/typert.host.js:929-985`（asar 内） | 目标机插件恢复由插件调用 `installBundle` 完成，不需要用户逐个手动安装 |
| 16 | `installBundle` **只接受组合包**（manifest 有 `dsh.bundle`），非 bundle 包抛 `not-bundle` 并回滚 `package.json` / `pnpm-lock.yaml`；宿主**启动时不做安装**，缺失或不可读的 bundle 进 `skippedBundles` 并在 stderr 报告 | `dsh-plugin-manager/lib/index.js:2074`、`dsh-app-boot/lib/index.js:533-538,741-743`（asar 内） | 「插件」模块恢复时必须按 bundle 逐个安装；`link:` 本地包需要单独处理（见 §7.8） |
| 17 | profile 的 `package.json` 由宿主 `JSON.parse` 读取，**带 UTF-8 BOM 会直接导致 `DesktopHostFatalError`、DSH 无法启动**（2026-10-23 实测事故）；启动失败后的「禁用插件」恢复调用 `disableAllPlugins()` → `sanitizeProfile(..., WEB_PROFILE.bundles)`，把 `bundles` 重置为 web 模板，第三方 bundle 被移除、只保留 `dependencies` 里已安装的包 | `dsh-app-boot/lib/index.js:835`、`lib/main.js:3531-3587`（asar 内） | 写 profile 的 JSON 文件必须无 BOM；安装脚本写后自检与自动回滚；恢复动作会丢 bundle，需向用户说明（见 §10.7） |
| 18 | `connection.fetch.register` 的路由**必须声明 `requestBody`**：省略时 `requestBodyMode` 返回 `undefined`，bridge 走 streaming 分支（`Readable.toWeb(req)` + `duplex: 'half'`），**GET 请求在该分支抛错并被 web 层转成 400 空响应**（无 body、无插件日志，极易误判为鉴权或扫描问题）；POST 路由因带 body 侥幸正常 | `dsh-client-connection/lib/index.js:822-831,40-88`（asar 内），2026-10-23 实测：缺省时 `GET /api/dsh-user-sync/status` 恒 400，补 `requestBody: 'buffered'` 后 200 | 所有路由统一写 `requestBody: 'buffered'`；GET 路由缺省会“静默 400” |

**尚未核实**（评审时需注意，不要当成结论）：
- 桌面版 Electron 的 `dsh-app://` 协议是否替渲染进程注入鉴权 cookie（来源是第三方 README 陈述）。
- 客户端平台种子词完整清单（只确认 `react` 在内）。
- WebDAV 服务端方言差异：坚果云已实测（§2 第 12 条）；群晖/Nextcloud 的 `PROPFIND` 深度与 `DELETE` 目录语义未测。

---

## 3. 设计目标（用户确认，2026-10-23）

> 以下八条是验收口径；工程细节（§5–§12）都必须能回溯到其中一条。

| # | 目标 | 落地要点 | 验收 |
|---|---|---|---|
| G1 | 备份范围**至少是用户级**，不含项目记忆、会话等非用户级内容；资产可自定义勾选，但**非用户级默认不选中** | 数据面分三级：用户级（默认 ✅）、项目级（默认 ⬜）、会话级（默认 ⬜）；见 §5.1 | 默认选中集里不出现 `sessions/`、`memories/projects/` |
| G2 | 启用后**自动同步远端配置**；本地已有插件内容时，由**用户确认**是否覆盖 | 启动时 + 定时拉取；覆盖前弹确认，列出将覆盖的文件；见 §7.3、§9.3 | 覆盖动作 100% 经过确认；无确认不写盘 |
| G3 | 数据只存**第三方云端**，不落 DSH 官方服务器 | 经运营方 API 中转，落在运营方指定的第三方存储；不指向 DSH 官方域名；见 §6、§17 | 请求目标域名不在官方域名白名单内；存储凭据不在插件内 |
| G4 | 包内**不允许含敏感数据** | 扫描命中即**拒绝打包/上传**（不是警告、不是跳过）；见 §5.4、§8 | 含 token/私钥的样本包打包失败并列出文件 |
| G5 | 使用**官方账号 id**，所有环境保持一致 | `accountKey = sha256(profile.value.id)[0..15]`；与 profile 名、设备无关；见 §4.1、§6.2 | 同账号两台设备得到同一 `accountKey`；换 profile 不变 |
| G6 | 插件**安装完成后，判断是否需要同步配置** | 首次启动：读远端同 `accountKey` 的包 → 有且更新 → 引导同步；无 → 引导首次备份；见 §11 | 装完重启后出现「发现远端备份」或「创建首个备份」引导 |
| G7 | 同步只能**新数据覆盖旧数据** | 包级 LWW：按包 `createdAt` 比较；不做三方合并、不做字段级合并；见 §7.3 | 较新包覆盖较旧包；反方向被拒绝；代码里没有合并路径 |
| G8 | 提供显式的**「上传用户配置」按钮**，用户可随时主动同步到远端 | 概览页固定主按钮；一键完成「勾选模块 → 打包 → 上传」；复用 G2 的覆盖确认；见 §9.2、§9.3 | 概览页可见按钮；点击后完成打包与上传并给出结果卡 |

### 3.1 由目标推导的边界（非目标）

- 不做合并式同步：不引入基线三方合并、不做 YAML/JSON 字段级合并（G7）。
- 不默认同步项目级与会话级内容：项目记忆、项目待办、`sessions/` 默认不选（G1）。
- 不把数据存进 DSH 官方云端：官方账号 API 无同步存储（§2 第 11 条），通道是运营方 API 中转（G3、§17）。
- 不自建 **DSH 官方**账号体系、不复用官方账号 token；运营方账号只用于自己的鉴权与配额（G5、§17）。
- 不静默覆盖：任何覆盖动作都必须先确认（G2）。
- 包加密（P2，AES-256-GCM + 口令或 DPAPI）。
- 实时文件监听（避免半新半旧状态与竞态）。

### 3.2 「账号级同步」与「官方云端同步」是两层

| 层 | 归属 | 现状 | 本插件 |
|---|---|---|---|
| 身份 | 官方账号 | 有 `account id`（跨设备一致） | 用它派生 `accountKey`，做账号级配对 |
| 通道 | 传输协议 | 官方无同步 API | 运营方 API 中转（插件只连运营方） |
| 存储 | 云端落盘 | **官方无同步存储** | 用户自己的网盘 / 仓库 |

结论：**账号级同步是目标**（同一账号的设备自动对齐）；「把数据存进 DSH 官方服务器」不是本插件能做的事，需要官方开放同步存储——这正是需求反馈稿 P1/P2 提给官方的部分。两者不冲突：身份用官方的，通道用用户的。

---

## 4. 术语与边界

- **用户级资产**：`<dshHome>`（默认 `~/.dsh`）下的 profile 声明、配置、记忆，加上 `<userHome>/.agents/skills`。它跨 profile，不随某个 profile 走。
- **安装面仍是 profile 级**：插件装进 `profiles/<name>/node_modules` 并由该 profile 的 `bundles` 挂载。有几个 profile 就要装几次；这是 DSH 的形态，不是本插件的缺陷。
- **设备**：一份 `DSH_HOME` + 一个 `deviceId`。双机演练只需两份 `DSH_HOME`（`DSH_HOME` 可整体覆盖）。

### 4.1 身份与设备标识（三套 id，别混用）

| id | 来源 | 作用域 | 跨设备一致 | 本插件用途 |
|---|---|---|---|---|
| 账号 id | `deepseekAccount.getProfile()` → `value.id`；缺省时走 `/api/account` 的 profile 接口 | 平台账号 | ✅ | 派生 `accountKey`，远端按账号分区 |
| 设备 id | `deepseekAccount.getDeviceIdentity()` → `deviceId`（登录后才有） | 平台设备记录 | ❌ | 包名里的设备标识；缺失时回退本地 UUID |
| 匿名 id | `~/.dsh/.anonymous-user-id`（`dsh-anonymous-user-id` 包） | **单份 `DSH_HOME`**，删文件即换新身份 | ❌ | **不用**；它只服务遥测与反馈 |

边界：

- `value.id` 可能为 `null`（未登录、平台未返回、凭据过期）。此时**无法注册到运营方、也无法跨机同步**：插件进入本地模式（只做打包与本机应用），UI 标注「未登录官方账号，云端同步不可用」；只有 folder 调试模式才退化为 `_local/` 目录。
- 包内与远端**只写派生值**：`accountKey = sha256(accountId)[0..15]`。不写原始账号 id、`name`、`contact`、`avatarUrl`。
- 设备 id 只用于区分包来源，不是安全凭据；日志与 UI 可显示前 6 位。
- 不读 `credentials` 里的 token：`getPlatformSession()` 明确面向 Host 消费者（源码注释 "only Host consumers can obtain a request credential"），第三方插件不越界。

**获取路径（2026-10-23 实测）**：

```js
ctx.inject(['deepseekAccount'], (c) => {
  const acct = c.get('deepseekAccount');          // 立即 ctx.get 会得到 undefined
  acct.getProfile({ version, locale, timezoneOffsetSeconds: 0 })
    .then((p) => (p?.status === 'ready' ? p.value.id : null));
});
```

- 必须用 `ctx.inject` 等待服务：账号插件初始化晚于普通插件，`ctx.get` 立即取是 `undefined`。
- 不要用 `getDeviceIdentity().userId` 取账号 id：首次调用时为 `null`（缓存未热）。
- `getProfile` 会联网；离线或未登录返回 `null`，按「本地模式」降级。


---

## 5. 数据面规格

### 5.1 资产分级与模块表

**判据**：一条资产算「用户级」，要同时满足——作用域跨项目、随账号走、换机器后仍然有意义、不包含具体项目的工作内容。

| id | 级别 | 根 | 收录 | 默认 | 计数单位 |
|---|---|---|---|---|---|
| `skills` | 用户级 | `<userHome>/.agents/skills` | 整棵技能树（`*/SKILL.md` 及附属文件） | ✅ | 技能目录 |
| `plugins` | 用户级 | `<dshHome>/profiles/<profile>/` | `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`cordis.yml`（`.npmrc` 固定不纳入，见 5.4） | ✅ | 文件 |
| `config` | 用户级 | `<dshHome>/profiles/<profile>/` | `cordis.patch.yml`（`settings.yaml` 不收录，见 §2 第 14 条） | ✅ | 文件 |
| `userMemory` | 用户级 | `<dshHome>/` 根 + `memories/` 根下（不含 `projects/`、`daily/`） | `AGENTS.md`（DSH 的用户级记忆主文件）、`memories/MEMORY.md`、`USER.md`、`KEY.md` | ✅ | 文件 |
| `projectMemory` | 项目级 | `<dshHome>/memories/projects/<hash>/` + `memories/daily/` | 项目记忆、项目待办（`TODOS.md` 等）、按日记录 | ⬜ | 文件 |
| `sessions` | 会话级 | `<dshHome>/sessions/` | 全部会话日志 | ⬜ | 会话目录 |

四条落地说明：

- **`plugins` 为什么算用户级**：它是这台机器的「个人环境声明」（插件栈 + 版本锁），不是某个项目的产物；换机器后必须仍然有意义。
- **项目内 `AGENTS.md` / `CLAUDE.md` 天然不进包**：它们不在 `<dshHome>` 下，属于项目仓库，由各自的 git 管理。
- **非用户级默认不选**：勾选状态持久化在设置里；用户首次勾选 `projectMemory` 时，弹一次提示「该内容属于项目级，可能包含工作内容，确认要跨机器同步吗？」。取消勾选不会删除已同步的远端内容。**会话不参与同步**（2026-10-24 决定：体积大且不跨机，面板不展示该模块，`sync.getModules` 过滤 `sessions`）。
- **永不收录**：`storages/`（本机 KV 状态，含会话投影缓存）、`.credentials.yaml`、`.anonymous-user-id`、`lock` 与 `pre-restore-*` 快照。它们不在任何模块的白名单里，也不允许被排除模式反向纳入。

**为什么 `AGENTS.md` 归入用户记忆**（2026-10-24 调整）：DSH 把用户级记忆与跨项目指令都写在 `<dshHome>/AGENTS.md`，而 `memories/` 目录当前并不存在；用户视角它就是「我的记忆」，因此归 `userMemory`，`config` 只保留 `cordis.patch.yml`。扫描同时认 `memories/MEMORY.md` 等白名单文件（若将来出现）。

**记忆与待办的切分**：`memories/` 下按路径互斥——`TODOS-*.md`、`*.todo.md`、`projects/*/TODOS.md` 归待办，其余归记忆。`userMemory` 与 `projectMemory` 的分界是路径里是否含 `projects/<hash>/` 或 `daily/`；**`daily/` 归项目级、默认不选**（2026-10-23 决定：按日期记录的记忆可能混有具体项目内容）。每个路径必须恰好属于一个模块（单测钉住）。

### 5.2 收录规则

- **白名单优先**：只收模块表列出的文件/后缀；不做「整目录递归复制」。
- **符号链接**：不跟随；记录为链接条目（`mode: 120000` + 目标），应用时按原样重建，目标越出根则拒绝。
- **忽略**：`node_modules`、`.git`、`*.map`、`*.bak-*`、`.DS_Store`、`Thumbs.db`、`desktop.ini`。
- **大小闸**：单文件 > 8 MiB 时拒绝打包并列出文件（技能包里的大模型权重等不该进同步包；不静默跳过）。
- **总量闸**：包总量 > 10 MiB 时拒绝打包（与远端配额一致；提示用户剔除大文件）。

### 5.3 规范哈希（跨平台稳定的关键）

| 类型 | 规则 |
|---|---|
| 文本（`.md` `.yml` `.yaml` `.json` `.js` `.ts` `.sh` `.ps1`） | 删除所有 `0x0D` 字节后算 SHA-256（与原型脚本 `tr -d '\r'` 逐字节等价）；**保留 BOM**（BOM 对 `.ps1` 有语义） |
| 二进制 | 原始字节 SHA-256 |
| 目录（技能） | 按 POSIX 相对路径排序后，逐文件 `path[:sha256]` 拼接再哈希 |

路径统一归一化为 POSIX 形式（`/`）后参与比对；读取时再按平台还原。

### 5.4 敏感数据（硬拒绝，不警告、不跳过）

G4 要求包内不允许含敏感数据，所以这里的动作是**整包拒绝**，不是「跳过该文件继续打包」——静默跳过会让用户误以为已同步。

**文件名黑名单**（出现在待打包清单里即拒绝）：

```text
.credentials.yaml  .credentials.yml  credentials.json  *.token  *.key
cloud-credentials.json  github.token  .npmrc.auth  .netrc  id_rsa  id_ed25519
```

**内容模式**（任一命中即拒绝，逐文件列出命中位置；日志与 UI 只显示模式名，不显示值）：

| 模式 | 匹配 |
|---|---|
| `sk-…` | `sk-[A-Za-z0-9]{16,}` |
| 通用密钥字段 | `(api[_-]?key\|token\|secret\|password\|passwd)[\"'\s:=-]+[A-Za-z0-9_\-]{20,}` |
| Bearer | `Bearer\s+[A-Za-z0-9._\-]{20,}` |
| GitHub token | `gh[pousr]_[A-Za-z0-9]{30,}` / `github_pat_[A-Za-z0-9_]{30,}` |
| 云厂商 AK | `LTAI[A-Za-z0-9]{12,}`（阿里云）/ `AKIA[0-9A-Z]{16}`（AWS） |
| 私钥 | `-----BEGIN [A-Z ]*PRIVATE KEY-----` |
| npm 凭据 | `_authToken\s*=` / `_auth\s*=` |

**处理路径**：打包失败 → UI 列出「文件 + 行号 + 模式名」→ 三个动作：从勾选中移除该文件 / 去源文件里删掉密钥后重试 / 取消。**没有「仍然打包」按钮。**

**`.npmrc` 固定不纳入**：不进勾选列表、不进包、不报错（2026-10-23 决定）。镜像源配置需在新机器手配一次；凭据绝不因它进入包。

**明文 provider key**：`cordis.patch.yml` 里出现 `apiKey: "sk-…"` 这类明文，拒绝并提示改用 `apiKeyEnv` 引用环境变量（本机现状就是这样，见 `cordis.patch.yml` 的 `apiKeyEnv: CODINGPLAN_API_KEY`）。旧版遗留的 `settings.yaml` 若存在，同样扫描但本身不收录。

**大文件抽样**：单文件 > 1 MiB 时只扫前 64 KiB + 后 64 KiB，UI 标注「抽样扫描」，漏检风险由用户承担；单文件 > 8 MiB 直接拒绝（见 5.2）。

### 5.5 跨平台边界

- Windows 保留名（`CON`、`PRN`、`AUX`、`NUL`、`COM1-9`、`LPT1-9`）与尾部点/空格：打包时检测，冲突则报错而不是静默改名。
- 长路径：Windows 侧用 `\\?\` 前缀绕过 260 字符限制。
- 大小写：macOS/Windows 默认不区分大小写。若包内出现仅大小写不同的两个路径，**拒绝应用**并列出冲突，不做自动去重。

---

## 6. 传输面规格

> B 模型下，插件侧只有一种公开 Transport：`api`（HTTP 客户端，见 §17.2）。下面的 `folder` / `webdav` 保留给自用模式与服务端内部实现，不暴露给多用户安装的配置界面。

### 6.1 统一接口

```ts
interface Transport {
  readonly id: 'api' | 'folder' | 'webdav' | 'git';
  test(): Promise<{ ok: boolean; detail: string }>;
  list(): Promise<RemoteEntry[]>;                  // name, size, modifiedAt
  meta(name: string): Promise<PackageMeta | null>; // 只读 manifest，不下载整包（§11 自动检查）
  get(name: string): Promise<Buffer>;
  put(name: string, data: Buffer): Promise<void>;
  remove(name: string): Promise<void>;
}
```

插件侧只实现 `api`；`folder` / `webdav` / `git` 是自用模式与服务端内部实现。

### 6.2 自用/调试：同步目录（`folder`）

- 目录由用户指定（OneDrive / 坚果云同步文件夹 / U 盘 / 局域网共享）。
- 布局：`<dir>/dsh-user-sync/<accountKey>/<stamp>-<deviceId>.tar.gz` + 同名 `.sha256`。
- 有账号 id 时按 `accountKey` 分区：新设备登录同一账号即可看到同账号的包，无需手填配对。
- 未登录时落在 `<dir>/dsh-user-sync/_local/`，UI 标注「未登录，无法自动配对账号」。
- **G3 宿主域名限制**：WebDAV / git 的 host 命中官方域名（`deepseek.com` 及其子域）即拒绝。同步目录没有主机概念，不做该校验。
- `list()` 只读文件名与大小，不解析内容。
- 跨机由网盘客户端负责；插件不假设目录已同步完成（`get` 后必须校验 sha256）。

### 6.3 服务端可选后端：WebDAV

- 只依赖标准动词：`OPTIONS` / `PROPFIND` / `MKCOL` / `PUT` / `GET` / `DELETE`，Basic 认证。
- 口令单独存 `<dshHome>/user-sync/webdav.json`（`0600`），不进设置文件、不进日志、界面读不回来。
- 超时 30 s；重试上限 3 次，仅对网络错误，指数退避；4xx 不重试。
- 远端目录首次上传自动创建。
- **坚果云实测（2026-10-23）**：`PROPFIND` 207 / `MKCOL` 201 / `PUT` 201 / `GET` 200 / `DELETE` 文件 204；**`DELETE` 目录 403**。所以清理策略只删文件，`accountKey` 目录创建后长期保留，不依赖删除目录。
- 目录删除能力差异按服务商处理：`DELETE` 目录失败（403/405）不视为错误，只记一条信息日志。

### 6.4 包命名与防穿越

```text
^dsh-user-sync-\d{8}-\d{4}-[a-z0-9]{6,16}\.tar\.gz$
```

不匹配一律拒绝；拒绝发生在发请求之前。`/`、`\`、`..`、控制字符在 `get/put/remove` 入口统一校验。

---

## 7. 同步规格（新覆盖旧）

> G7：只允许「新数据覆盖旧数据」。没有合并路径——不做三方合并、不做字段级合并、不做行级合并。

### 7.1 包格式

manifest 首条目，`.dsh-user-sync/manifest.json`：

```json
{
  "schemaVersion": 3,
  "format": "dsh-user-sync/1",
  "hashMode": "lf",
  "packageId": "20261023-0900-a1b2c3d4",
  "createdAt": "2026-10-23T01:02:03Z",
  "deviceId": "a1b2c3d4",
  "platform": "win32",
  "arch": "x64",
  "dshVersion": "0.2.1-rc.2",
  "profile": "desktop",
  "modules": ["skills", "plugins", "config", "userMemory"],
  "bundles": ["@deepseek-ai/dsh-base", "..."],
  "dependencies": { "@local/dsh-xiaoai-preset": "link:..." },
  "files": [
    { "path": "skills/foo/SKILL.md", "sha256": "…", "size": 123, "mode": "100644" }
  ]
}
```

- `packageId` = `<stamp>-<deviceId>`，与文件名一致，全局唯一。
- **包内不写 `accountKey`**：分区由服务端按 token 解析，避免包一旦外泄就等于泄露访问键（见 §17.5）。
- **兼容 v2**：原型脚本的包（`schemaVersion: 2`、无 `modules`/`deviceId`）仍可读取并应用，按「只有 plugins+config 模块」处理。字段映射：v2 的 `files[].name` → v3 的 `path`；v2 没有 `createdAt`，LWW 比较回退到 `exportedAt`（[原型 manifest](../legacy/dsh-profile-sync.ps1#L119-L134)）。
- **校验**：边写边算，任一文件哈希不符即整包拒绝（不留半截）。

### 7.2 同步状态

`<dshHome>/user-sync/state.json`（原名「基线库」；LWW 不需要多份基线）：

```json
{
  "deviceId": "a1b2c3d4",
  "auth": { "accountKeyHint": "9f2c1a", "registeredAt": "2026-10-23T00:30:00Z" },
  "lastApplied":  { "packageId": "20261023-0830-b2c3d4e5", "createdAt": "2026-10-23T00:30:00Z" },
  "lastUploaded": { "packageId": "20261023-0900-a1b2c3d4", "createdAt": "2026-10-23T01:00:00Z" },
  "files": { "profiles/desktop/cordis.patch.yml": { "sha256": "…", "size": 1556, "appliedAt": "…" } }
}
```

- `lastApplied`：判断「远端是否有比本机更新的包」。
- `lastUploaded`：判断「本机改动是否已推送」。
- `files`：应用后各文件的哈希，用于幂等（内容一致不写盘）。
- `auth`：只存提示信息，**不存 token**；token 单独放在 `user-sync/auth.json`（`0600`），删除该文件即登出。同一账号的所有设备持有同一个 token（§17.2 账号模型）。

### 7.3 判定表（LWW，包级时间）

| 情况 | 动作 |
|---|---|
| 远端最新包 `createdAt` > `lastApplied.createdAt` | 远端更新 → 拉取；**列出将变化的文件 → 用户确认 → 应用** |
| 本机文件哈希 ≠ `lastApplied` 时的状态 | 本地有改动 → 打包并上传新包（上传前展示「将覆盖远端」的文件清单并确认） |
| 两侧都有更新 | 比较两个包的 `createdAt`，较新者胜；相差 ≤ 5 分钟视为并发，强制确认并显示两侧时间 |
| 包内容与本地哈希完全一致 | 幂等跳过（不写盘、不打扰） |
| 文件只在包里、本地没有 | 视为「新数据」→ 添加 |
| 文件只在本地、包里没有 | 保留本地（**删除不传播**） |
| 包校验失败 / 含敏感数据 | 整包拒绝，不写盘 |

口径说明：

- **「新」只看包级 `createdAt`**，不看文件 mtime（复制会改 mtime）。文件按包整体覆盖，避免半新半旧。
- **两侧相差 ≤ 5 分钟**：视为并发，不自动判定，转人工确认（设备时钟不可靠时不给结论）；相差 > 5 分钟才按时间自动判定。
- **删除不是新数据**：包侧删除不传播到本地；本地删除也不推送到包。要删远端就手动删包。

### 7.4 覆盖单位

| 模块 | 单位 | 说明 |
|---|---|---|
| 技能 | 整个技能目录 | 同一技能不混用两版文件 |
| 配置 | 整个文件 | `cordis.patch.yml` 整文件替换，不逐键合并 |
| 插件清单 | 整个文件 | `package.json` + `pnpm-lock.yaml` 成组替换，不做字段合并 |
| 记忆 | 整个文件 | 不做行级合并 |
| 会话 | 整个文件 | 不参与同步（模块已从面板移除） |

### 7.5 幂等与原子性

1. 内容等价 → 不写盘、不改 mtime、不计入「已应用」。
2. 写盘：同目录 `*.tmp-<rand>` → `fsync` → `rename`；失败清理临时文件。
3. 覆盖前快照：`<dshHome>/user-sync/pre-restore-<时间戳>-<随机>/`，保存将被覆盖的原文件（保持相对路径）；**每次应用生成独立目录**，同进程连续应用不互相覆盖。
4. 单实例锁：`<dshHome>/user-sync/lock`（`pid` + `startedAt` + 每 30 s 心跳）；心跳超 90 s 视为僵死，允许抢占并在结果里标注。
5. 应用阶段可中断：按文件粒度提交，中断后 `pre-restore` 可整批还原。

### 7.6 审计

`<dshHome>/user-sync/history.jsonl`，每次操作一行：

```json
{"at":"2026-10-23T01:02:03Z","action":"backup","modules":["skills","plugins","config","memory"],"files":42,"bytes":184320,"warnings":1,"ok":true,"ms":812}
```

不记录文件内容、不记录凭据路径的完整值。保留最近 200 行。

### 7.7 跨平台与版本兼容

**跨平台覆盖**：

- manifest 记录 `platform` / `arch`；覆盖确认里显示「来自 win32 的包」这类来源标注。
- 平台特定文件给**警告不阻止**（G7 覆盖仍可进行）：`*.ps1`、`*.cmd`、`*.sh`、`.DS_Store`、`Library/`、`Thumbs.db`。
- 警告文案：「该包含 3 个 Windows 专用文件，在 macOS 上不会被使用」。

**DSH 版本兼容**（包内 `dshVersion` 与本机比较）：

| 情况 | 处理 |
|---|---|
| 同 `major.minor` | 不提示 |
| 包版本 < 本机 | 提示「包来自旧版 DSH，插件清单可能缺新内置 bundle」 |
| 包版本 > 本机 | 强提示「包来自更新版本，可能包含本机不认识的插件」，需二次确认 |
| 无法解析 | 只提示，不判断 |

版本判断**不阻止覆盖**：用户对自己的环境负责，提示只降低误操作概率。

### 7.8 目标机插件恢复

> 依据 §2 第 15、16 条：宿主启动**不装依赖**，缺失 bundle 只会被跳过；官方安装入口是 `pluginManager.installBundle`。

覆盖 `package.json` 只改声明，装回 `node_modules` 是独立一步：

1. 比对包里 `dependencies` 与本机 `pluginManager.listBundles()`（`installed` 字段），得出「缺失 / 版本不同 / 已一致」三态，进覆盖确认清单。
2. 用户确认应用后，逐个调用 `installBundle('<name>@<version>')`；每个调用独立，单个失败不阻塞其余。
3. 安装完成后再写 `cordis.patch.yml`，最后统一提示「重启 DSH 生效」（宿主半边不热重载，见 §10.5）。

约束：

- **只接受组合包**：`installBundle` 对没有 `dsh.bundle` 的包抛 `not-bundle` 并回滚清单。普通 npm 依赖不进「插件」模块（它们属于插件自己的依赖，由 pnpm 随插件安装）。
- **`link:` 依赖不可跨机**：本机 `@local/dsh-xiaoai-preset` 指向 `link:C:/Users/panda/...`，目标机没有该目录。恢复时列为「无法自动安装，需手工放回本地包」，不阻塞其余插件。若该本地包本身是可同步资产（技能/预设），由用户在源机决定是否把它作为普通资产同步。
- **幂等**：`listBundles` 显示已安装且 spec 一致时跳过，不重复调用。
- **环境变量提示**：应用 `cordis.patch.yml` 后扫描 `apiKeyEnv` 引用的变量，本机缺失则在结果卡列出「插件已装，但缺少环境变量 `X`，需自行配置」；**只报变量名，不报值**（需求稿 §四「插件装了但用不了」）。
- **凭据**：安装不涉及任何 registry 凭据；私有源由 pnpm 自身配置承担，插件不记录、不传递。

---

## 8. 安全规格

| 面 | 规则 |
|---|---|
| 敏感数据 | 5.4 的文件名黑名单 + 内容模式，打包与应用两侧各扫一次；**命中即整包拒绝**（G4），UI 列出文件与行号，无「仍然继续」入口 |
| 凭据 | `.credentials.yaml` 永不进包、进日志、进提示词；云端口令单独 0600 文件、写入后不可回读 |
| 凭据输入 | **只经设置页输入**：不进对话、不进工具参数、不进模型上下文；插件不提供任何接受凭据参数的 agent 工具。口令框不回显、保存后只显示「已保存」 |
| 信任边界 | B 模型下运营方 API 能读到全部用户数据：最小权限、按 `userId` 隔离、审计日志、HTTPS；插件侧**永不持有存储凭据**，只持有用户自己的 API token |
| 官方服务器 | API 地址 host 命中 `deepseek.com` 及子域即拒绝（G3）；自用模式无主机概念，不校验 |
| 包内容 | 明文。UI 在「同步」页签常驻：远端目录必须私有。P2 提供 AES-256-GCM 可选加密（口令或 DPAPI） |
| git（P2） | token 走 `GIT_ASKPASS` 环境变量，不进 argv（`ps` 全机可见）；拒绝推送到公共仓库（API 校验失败则要求显式确认） |
| WebDAV | 拒绝把口令写进 URL；默认要求 HTTPS 或回环/局域网地址，公网 HTTP 需显式确认 |
| 覆盖确认 | 任何覆盖动作先列出「将变化的文件（按模块分组、带大小与两侧时间）」并等用户确认（G2）；确认按钮写具体动作名 |
| 操作可见 | 每次同步在 UI 展示：模块、文件数、字节数、跳过数、耗时 |
| 删除 | 删除不传播（G7：删除不是新数据）；只保留本地/远端各自的状态 |

---

## 9. UI 规格

### 9.1 注册

```js
ctx.slots.inject('settings.section', () =>
  ctx.slots.register(
    {
      name: 'settings.section',
      id: 'user-sync',
      order: 50,
      label: '设置同步',          // 也可写成 () => t('nav')，由外壳 resolveSlotLabel 解析
      // locale / inject / children 按需；第一版右侧无子 slot，省略 children
    },
    UserSyncSection,
  ),
);
```

- 与官方同款写法：`dsh-client-ui-settings-general/lib/client.js:1293`、`dsh-client-ui-settings-plugins/lib/client.js:201`（asar 内）；`register` 返回 disposer，由 `ctx.slots.inject` 的回调作用域管理。
- **client 半边的 `inject` 是服务名数组**（`['slots']`，官方为 `['slots', 'locale']`），不是包名；`package.json` 的 `dsh.client.inject` 才是包名数组。不声明 `slots` 时 `ctx.slots` 为 undefined，client `apply` 抛 TypeError，web boot 报 `<包名>: failed`、DSH 无法启动（2026-10-23 实测事故）。
- `order: 50` 落在「通知提醒」与「皮肤」之间（见契约文档实测表）。
- 图标由外壳按 `id` 查表，未知 id 回退齿轮；**不要试图塞自定义图标**。
- **`__ModuleLoader__.load({ id })` 的 `id` 必须等于 npm 包名**（2026-10-24 事故）：写成旧名 `dsh-user-sync` 时，profile 里一旦同时存在旧 junction 与 npm 包（或同一 bundle 被两个 owner 加载），同一 id 注册两次，`client-modules` 直接抛 `duplicate factory registration` 并让 `web boot` 失败（DSH 随后把 profile bundles 重置为 web 模板）。client 入口除对齐 id 外，还必须对该错误做容错：只记 warn、不冒泡。
- 面板只在被选中时挂载：任何一次性初始化放组件挂载时，不依赖后台常驻。

### 9.2 布局

```text
┌──────────────────────────────────────────────┐
│ 设置同步                                      │ 54px 头部
├──────────────────────────────────────────────┤
│ [概览] [备份] [同步] [设置]                     │ 页签
├──────────────────────────────────────────────┤
│ [上传用户配置]   [从远端同步]                   │ 主操作
├──────────────────────────────────────────────┤
│ 模块行：✓ 技能     ~/.agents/skills      12 项 │
│         ✓ 插件     profile 依赖清单      4 文件 │
│         ✓ 配置     cordis.patch.yml…    3 文件 │
│         ✓ 用户记忆 memories/（全局）     2 文件 │
│         □ 项目记忆 memories/projects/（项目级） │
│         □ 会话     sessions/（会话级）         │
├──────────────────────────────────────────────┤
│ 上次：2026-10-23 09:00 · 2 MB                  │
│ ▓▓▓▓▓▓▓░░░  正在写入 42/61 文件…              │
└──────────────────────────────────────────────┘
```

- 内容宽 564px，单列；**根节点不写 `height:100%` / `overflow-y:auto`**（外壳负责滚动）。
- 不用视口媒体查询（设置弹窗内视口仍是 1920px）；不做容器查询（会改 `position:fixed` 包含块）。

### 9.3 交互流

**首次同意（隐私）**：第一次拿到官方账号 id 时弹出说明——上传哪些目录、存在运营方账号（非官方服务器）、保留 1 份且上传即覆盖——勾选「同意」后才允许上传；拒绝则保持本地模式，随时可在设置里重新同意。

**首次启用（安装后，G6）**：插件用官方账号**自动配对**（`ctx.inject(['deepseekAccount'])` → `accountKey` → 服务端 `register`（首次，409 自动转 `login`）→ 拿到 token；服务地址默认内置，**用户无需注册或登录运营方账号**）→ 「检查远端」→ 三条分支：

- 远端无同账号包 → 引导「创建首个备份」：勾模块 → 打包 → 上传。
- 远端有包且比本机新 → 显示「包时间 / 来源设备 / 模块 / 文件数」→ 点「同步到本机」进入覆盖确认（含「缺失插件」清单，确认后按 §7.8 自动装回）。
- 远端有包但不比本机新 → 显示「本机已是最新」，不写盘、不打扰。

**自动同步（G2）**：启动后检查一次，之后每 N 小时（默认 6）检查。**只读远端元数据**（列表 + manifest），不下载、不写盘。发现远端更新时，在设置页与对话页顶部各出一条提示；点提示进入覆盖确认。**自动同步不自动应用。**

**覆盖确认（G2 + G7）**：列出将变化的文件，按模块分组，显示「新增 / 覆盖 / 跳过」与两侧时间、大小；两个按钮：「用远端覆盖本机」/「取消」。确认后先快照（§7.5），再应用，结果卡给出应用数、跳过数、快照路径与重启提示。

**上传用户配置（G8）**：概览页固定主按钮。点击后一键完成「当前勾选模块 → 打包 → 上传」，进度显示文件计数；结果卡给包 ID、大小、文件数。若远端已有更新的包 → 先提示「远端更新，是否用本机覆盖远端？」（G2）；若扫描命中敏感模式 → 拒绝打包并列出文件（G4）。

**计数语义**：同步范围按钮上的数量始终按全部模块的真实扫描结果显示；勾选只决定打包范围，取消勾选不会让计数变成 0（否则用户无法判断某类资产是否存在）。

**设置**：配对状态（已配对 · `accountKey` 前 6 位 / 未登录官方账号）、设备 ID（只读 + 可重置）、服务地址（可选，默认内置）、自动同步开关（默认开）+ 间隔、模块勾选、排除模式（glob，逗号分隔）。**没有注册/登录按钮**：配对由官方账号自动完成，用户只在未登录官方账号时看到「请先登录 DSH 账号」。这些偏好存本地 `user-sync/state.json`，**不写 `cordis.patch.yml`、不跨机**（理由见 §10.6）。

### 9.4 状态与错误

| 错误码 | 触发 | 文案方向 |
|---|---|---|
| `E_LOCKED` | 另一实例持锁 | 「另一个同步任务正在运行（pid 1234，已 12s），可等待或强制抢占」 |
| `E_HASH_MISMATCH` | 包内文件校验失败 | 「包在第 N 个文件处校验失败，未写入任何内容」 |
| `E_SENSITIVE` | 命中敏感模式（G4） | 「拒绝打包：2 个文件含疑似密钥（cordis.patch.yml:37、settings.yaml:12），请移除或到源文件删除后重试」 |
| `E_REMOTE_NEWER` | 远端包更新 | 「远端有更新（10-23 09:00，来自 DEVICE-B），是否用远端覆盖本机？」 |
| `E_LOCAL_NEWER` | 本机更新 | 「本机比远端新（10-23 10:12），是否用本机覆盖远端？」 |
| `E_CLOCK_SKEW` | 两侧时间差 ≤ 5 分钟 | 「两侧时间过于接近（相差 2 分钟），无法判断谁更新，请手动选择」 |
| `E_REMOTE_AUTH` | 401/403 | 「远端认证失败（401），请检查账号或口令」 |
| `E_REMOTE_TIMEOUT` | 网络超时 | 「远端 30s 无响应，已重试 3 次」 |
| `E_APPLY_FAILED` | 写盘失败 | 「第 N 个文件写入失败，已还原到 pre-restore 快照」 |
| `E_OFFICIAL_HOST` | API 地址指向官方域名（G3） | 「该地址属于 DSH 官方服务器，已拒绝」 |
| `E_NOT_PRIVATE` | 公共仓库（仅自用模式） | 「该仓库是公开的，拒绝推送；请改用私有仓库」 |

空态：「首次使用：先登录账号，再创建首个备份。」加载态：按钮禁用 + 进度条。失败态：错误码 + 人话 + 下一步，不弹原生 alert。

### 9.5 文案

- 中文默认，`locale/zh.json` 提供 `meta.title`（设置页左栏显示名与市场卡一致）。
- 覆盖类操作（用远端覆盖本机、用本机覆盖远端、重置设备 ID）一律二次确认，确认按钮写动作名而不是「确定」。

---

## 10. 契约与工程规格

### 10.1 包结构

```text
dsh-user-sync/
  package.json
  cordis.patch.yml
  locale/zh.json
  lib/
    index.js        # { name, inject, apply }
    client.js       # __ModuleLoader__.load
    paths.js        # launchEnvironment + profileContext
    scan.js         # 模块扫描 + 白名单 + 凭据黑名单
    archive.js      # tar.gz + manifest + sha256
    diff.js         # LWW 判定（包级时间 + 哈希）
    apply.js        # 应用计划 + 快照 + 回滚
    transport/      # api.js（插件侧）/ folder.js、webdav.js（服务端或调试）
    scheduler.js    # 宿主进程内定时器
    state.js        # 同步状态 + 锁 + 审计
  test/
```

### 10.2 `package.json`

```json
{
  "name": "@pandablessing/dsh-user-sync",
  "version": "1.0.3",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml", "locale"],
  "engines": { "node": ">=22", "dsh": ">=0.2.0-rc.2 <0.3.0" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "inject": [], "platform": "web" }
  },
  "scripts": { "test": "node --test test/*.test.js" }
}
```

不写 `dependencies`：只用 `node:` 内置模块（`fs` `path` `os` `crypto` `zlib` `http` `https` `child_process`）。**tar 用 `zlib` + 手写 512 字节头**（2026-10-23 决定）；不探测系统 `tar`——跨平台参数差异会让降级分支比实现本身更重。需覆盖长文件名（`ustar` 前缀/PAX 头）、权限位、目录条目，并有单测。

### 10.3 宿主入口

```js
export const name = 'dsh-user-sync';
export const inject = [];              // 不硬依赖，避免停在 pending

export function apply(ctx) {
  const state = createState(ctx);
  const scheduler = createScheduler(ctx, state);

  ctx.effect(() => { scheduler.start(); return () => scheduler.stop(); }, 'dsh-user-sync: scheduler');

  ctx.inject(['connection'], (c) => {
    const register = c.get('connection')?.fetch?.register;
    if (typeof register !== 'function') return;
    for (const route of buildRoutes(ctx, state)) {
      c.effect(() => register(route), `dsh-user-sync: ${route.path}`);
    }
  });
}
```

路由前缀固定 `/api/dsh-user-sync/`，鉴权由宿主 `connection` 承担。`register` 接受对象：

```js
const route = {
  path: '/api/dsh-user-sync/packages',   // 前缀 + 资源
  methods: ['GET'],                       // 单方法或数组
  fetch: (request) => new Response(...),  // Web Fetch 语义；流式请求可用 requestBody: 'streaming'
};
```

出处：`dsh-client-file-upload/lib/index.js:170`、`dsh-client-ui-deliverables/lib/index.js:49-84`（asar 内）。返回 disposer，用 `c.effect` 注册。

### 10.4 路径解析

```js
const profile = ctx.get('profileContext', false);
const dshHome = profile?.home;        // harness home（~/.dsh）
const profileName = profile?.name;    // 'desktop'
const profileDir = profile?.dir;      // <dshHome>/profiles/<name>
```

`profileContext` 字段：`home`、`name`、`dir`、`patchPath`、`installAnchor`、`startedBundles`、`cwd`、`overlays`（`dsh/lib/profile-boot-C14i-8IN.js:290-301`，asar 内）。`launchEnvironment`（`launchEnvironmentOf(ctx).get('DSH_HOME')`）只用于读环境变量，不用于定位目录。

`profileContext` 取不到时回退 `process.env.DSH_HOME` 与 `'desktop'`，并在结果里标注 `resolvedBy: 'fallback'`（UI 概览页显示，便于排查）。

### 10.5 热重载与重启

- 宿主半边（路由、定时器）**不热重载**：装完/升级后必须重启 DSH，UI 明示。
- 客户端半边刷新页面即可。

### 10.6 配置持久化（契约核实结论）

**没有独立的「settings 写入服务」**：插件设置就是它自己的 Cordis Config，编辑走 `configEditor.edit(entry, change)`，写入当前 profile 的 `cordis.patch.yml`（原子替换、保留注释与 `!!js`、与 HMR 串行；`dsh-config-editor/lib/index.js:69-135`）。`settings.yaml` 只是旧版迁移源（§2 第 14 条）。

本插件的取舍：

- **本地偏好不进 patch**：模块勾选、自动同步开关/间隔属于「本机对同步的授权」，写 `user-sync/state.json`（§7.2），不随包跨机。否则 B 机应用 A 机的包会静默打开「会话级同步」这类高敏感项。
- **行为配置仍走 patch**：provider、默认模型、UI 设置等由「配置」模块整文件覆盖（§5.1），与偏好分离。
- **若将来要把偏好写进 patch**：调用 `ctx.configEditor.edit(ctx.fiber.entry, (current) => next)`；但 `entries()` 只接受「profile 根 Include 拥有且可唯一定位」的条目（`config-editor/lib/index.js:30-35`），本插件条目由 bundle patch 插入，是否满足需 M1 实测。

### 10.7 写 profile 文件的编码约束（2026-10-23 事故教训）

**事故**：安装脚本用 Windows PowerShell 5.1 的 `Set-Content -Encoding UTF8` 写 `~/.dsh/profiles/desktop/package.json`，该编码带 BOM；宿主 `readProfileManifest` 用 `JSON.parse` 读取，抛 `Unexpected token '\ufeff'` → `DesktopHostFatalError`，DSH 无法启动。用户在恢复对话框点「禁用插件」后，`disableAllPlugins()` 又把 `bundles` 重置为 web 模板，`worktree` / `plugin-market` 两个第三方 bundle 被移除。

硬约束：

1. **profile 下所有 JSON 文件必须 UTF-8 无 BOM**（`package.json`、`compatibility.json`、本插件的 `state.json`）。Node/PowerShell 写入一律用 `UTF8Encoding($false)` 或 `writeFileSync`；禁止 `Set-Content -Encoding UTF8`（PS 5.1 带 BOM）。
2. **`.ps1` 脚本反向要求**：Windows PowerShell 5.1 读「无 BOM 的 UTF-8」会把中文按 ANSI 解码导致语法错误。脚本文件存 UTF-8 with BOM，`edit` 工具重写后要复核首字节。
3. **写后自检三件事**：首字节非 `EF BB BF`、JSON 可解析、关键字段（如 `bundles`）含目标值；任一失败立即从备份回滚。
4. **改真实 profile 前先验副本**：在临时目录生成目标文件，用与宿主相同的 `JSON.parse` 口径验证通过后再落盘。`scripts/install-dev.ps1` 已按上述规则实现（备份 → 无 BOM 写入 → 自检 → 失败回滚）。
5. **恢复动作会丢 bundle**：启动失败后点「禁用插件」会把 `bundles` 重置为 web 模板。装第三方 bundle 前提醒用户：恢复后需重新添加自己的 bundle 项。

### 10.8 插件失败不得阻止启动（2026-10-23 事故教训）

**事故**：client 半边 `exports.inject` 写成 `[]`（正确值是服务名数组 `['slots']`），`ctx.slots` 为 `undefined`，client `apply` 抛 TypeError；web boot 的激活检查把该条目判为 `failed`，抛 `web boot: 1 entry did not activate`，DSH 无法启动。

硬约束：

1. **web boot 把任何非 `active` 条目当启动失败**（`pending` 也算）。因此条目只声明确定存在的服务依赖；client 的 `inject` 用服务名（`slots`），不是包名。
2. **宿主 `apply` 全包 try/catch**：错误写 `$DSH_HOME/user-sync/plugin-error.log`（只记文件与堆栈，不记录密钥）并 `console.error`，**不向外抛**。
3. **client `apply` 同样 try/catch**；factory 内 `require('react')` 失败时降级为空插件（面板消失，但应用可启动）。
4. **不用 `ctx.inject` 等待可能不存在的服务**：直接 `ctx.get(name, false)` 取，缺失就降级。`ctx.inject` 的子 fiber 若 `pending`，会污染启动诊断。
5. 验收：任何插件自身异常都只影响功能，不阻止 DSH 启动；`test/client.test.js` 与 `test/plugin.test.js` 钉住该行为。

---

## 11. 生命周期与定时

- 定时器跑在宿主进程内（`setInterval` 60 s 心跳），与 `connection` 解耦：没人开界面也能检查远端。
- **安装后首启（G6）**：自动执行一次「检查远端」——只读列表与 manifest，不下载。按 §9.3 三条分支引导；不自动应用。
- **自动同步（G2）**：启动后检查一次，之后每 N 小时（默认 6）检查远端元数据；发现更新只提醒，不写盘。
- DSH 未运行时不补跑（不装系统计划任务）。
- 失败不无限重试；下一次到点照常。
- 只清理自己产生的包（按文件名前缀 + `deviceId`），`keep <= 0` 表示不清理。
- 卸载时 `ctx.effect` 清理定时器与路由；遗留的 `state.json` / 包不自动删除（用户资产，需保留）。
- **服务端不可用**：自动检查失败只在设置页显示一次（原因 + 上次成功时间），不弹窗、不阻塞；本地打包与应用照常；上传失败保留本地包，可手动重试（网络错误 3 次退避，4xx 不重试）。

---

## 12. 测试与验收

> **用例清单是单一来源**：[test-cases.md](test-cases.md)（149 条，含 ID / 前置 / 预期 / 设计章节）。本节的 12.1 只写策略与覆盖目标，不重复列条目；运行结果只记录在 `docs/test-results/`，清单本身不写结果。

### 12.1 单测（`node --test`，目标 ≥ 60 条）

- 路径：Windows/Unix 双平台归一化；`launchEnvironment` 优先于 `process.env`；`profileContext` 优先于 `DSH_PROFILE`。
- 扫描：白名单命中/未命中；忽略规则；大小闸；符号链接；`.npmrc` 固定排除。
- 哈希：CRLF/LF 等价；BOM 保留；目录聚合顺序无关。
- LWW：7 种判定分支；包级时间比较；时钟偏差 ≤ 5 分钟转确认；内容等价不动 mtime。
- 敏感扫描：模式命中即拒绝打包并给出行号；大文件抽样标注；应用侧同样拒绝。
- 归档：manifest 首条目；sha256 篡改拒绝；v2 包兼容读取。
- 锁：僵死心跳抢占；活锁拒绝。
- 传输：插件侧 `api` 客户端（登录/列表/上传/下载/删除/导出）用本地假 API 服务器测；服务端 WebDAV 客户端用假 WebDAV 服务器测（含目录 403 容错）。

### 12.2 换机演练

**A. 自用调试模式（folder）**：两份 `DSH_HOME` + 临时目录，验证扫描、打包、LWW、应用；不经过服务端。

**B. 多用户模式（api）**：

```
假 API / 真实服务端就绪
A 机注册 → 上传包
B 机用同 accountKey 登录（取回同一 token）→ 检查远端 → 确认覆盖 → 应用
断言：四类都在、accountKey 与 A 相同、插件可加载
A 改配置 → 上传新包；B 再检查 → 确认覆盖 → 断言 B 拿到 A 的新值
隔离：用 C 的 token 访问 A 的包 → 404
```

### 12.3 验收标准

- [ ] 同一份配置在 Windows 与 macOS/Linux 上生成相同 `sha256`。
- [ ] **默认选中集不含 `memories/projects/` 与 `memories/daily/`；会话不参与同步**；勾选非用户级模块时出现一次提示（G1）。
- [ ] **同账号两台设备得到同一 `accountKey`**；换 profile 名不变；未登录时进入本地模式、不写远端（G5）。
- [ ] 含 `sk-`/私钥/`_authToken` 的样本包**打包失败**，并列出文件与行号；无「仍然继续」入口（G4）。
- [ ] 覆盖预览正确：新增/覆盖/跳过三态，按模块分组，带两侧时间（G2）。
- [ ] **较新包覆盖较旧包；反方向被拒绝**；两侧相差 ≤ 5 分钟转人工（G7）。
- [ ] 装完重启一次：出现「发现远端备份」或「创建首个备份」引导；不会静默写盘（G6）。
- [ ] 目标机缺插件时：覆盖确认列出缺失插件，确认后经 `pluginManager.installBundle` 装回；`link:` 包列入手工清单；非 bundle 包不尝试安装（§7.8）。
- [ ] 自动同步只读元数据：发现更新只提醒，不下载、不写盘（G2）。
- [ ] 覆盖动作未确认时零写盘；确认后先快照再应用，失败可整批还原。
- [ ] 内容等价的文件零写入（mtime 不变）。
- [ ] API 地址命中 `deepseek.com` 时拒绝（G3）；包名不匹配正则时请求前拒绝。
- [ ] 概览页有「上传用户配置」主按钮；点击后完成打包与上传，结果卡给出包 ID 与大小（G8）。
- [ ] 自动同步检查在无界面时照常执行，`history.jsonl` 有记录。
- [ ] 多用户隔离：用户 A 的 token 无法列出或读取用户 B 的包（服务端强制校验）。
- [ ] token 生命周期：注册 → `login` 取回同一 token → `reset` 后旧 token 返回 401；删除 `auth.json` 即登出。
- [ ] 服务端不可用时：本地打包与应用照常，自动检查给出明确失败提示。

---

## 13. 里程碑

| 阶段 | 内容 | 预估 |
|---|---|---|
| M1 | 骨架可装：package.json / patch / index / 空面板；扫描 + 打包 + 本机应用 | 2 天 |
| M2 | **api 客户端 + 服务端最小 API**（register/packages/quota）+ LWW + 覆盖确认 UI + 快照回滚 + 插件恢复（§7.8）+ 安装后引导 | 5 天 |
| M3 | 自动同步检查（启动 + 定时）+ 审计历史 + 导出 / 删除全部 + 双端一致性回归 | 2 天 |
| M4 | 发布：README / CHANGELOG / 市场收录 / 换机演练记录 | 1 天 |

---

## 14. 决策记录

### 14.1 已拍板（2026-10-23）

| 问题 | 决定 | 落点 |
|---|---|---|
| 新旧判定阈值 | 两侧包时间相差 **≤ 5 分钟**视为并发，转人工确认 | §7.3 |
| `daily/` 归属 | **项目级**，默认不选 | §5.1 |
| `.npmrc` | **固定不纳入**（不进勾选列表、不进包、不报错） | §5.4 |
| 实现顺序 | B 模型下先做 **api 客户端 + 服务端最小 API**；folder 只用于调试 | §6、§13 |
| 包名 | **`dsh-user-sync`**；`dsh-profile-sync` 在 npm 已被占用（0.1.3） | §10.2 |
| 主动上传入口 | 概览页固定「上传用户配置」主按钮，一键打包 + 上传 | §9.2、§9.3（G8） |
| 存储后端 | **坚果云**（服务端持有一套账号），按平台账号 id（`accountKey`）分区 | §17.1、§17.6 |
| 多用户产品决策 | 未登录限制、配额（1 份/10 MiB/50 MiB）、删除权、隐私同意、部署、计费、第二因子 → 见 §17.4 | §17.4 |
| `settings.yaml` | **不收录**（旧版迁移源；设置实际写在 `cordis.patch.yml`） | §2 第 14 条、§5.1 |
| 账号模型 | **一个 `accountKey` 一个账号一个 token**；新设备用 `login` 取回同一 token，不签发多设备 token；吊销只走 `reset` | §17.2、§17.5 |
| 目标机插件恢复 | 调用 `pluginManager.installBundle`，只装 bundle；`link:` 包单独手工处理 | §2 第 15/16 条、§7.8 |
| `link:` 依赖 | 列入手工清单，不自动安装、不内联打包（避免改写 `package.json` 破坏整文件覆盖原则） | §7.8 |
| 本地偏好存储 | 模块勾选、自动同步开关/间隔存 `user-sync/state.json`，**不进 patch、不跨机** | §10.6 |
| tar 实现 | `zlib` + 手写 512 字节头，不探测系统 `tar` | §10.2 |

### 14.2 尚未决定（不阻塞 M1）

- 是否发布到 npm：MVP 可先用 `github:` 安装，发布放到 M4。
- 市场收录时机：M4 之后再提交。

---

## 15. 与现有原型的差距

| 能力 | 原型脚本（现状） | 插件目标 |
|---|---|---|
| 同步范围 | profile 声明 4 件套 | 用户级四类 + 项目记忆可选（默认不选）；会话不参与同步 |
| 载体 | 手工拷 zip | 运营方 API（多用户）／同步目录（自用） |
| 冲突 | 差异预览 + 覆盖（二方） | 包级 LWW + 覆盖确认（不做合并） |
| 跨平台哈希 | 删 CR 后 SHA-256 | 沿用，并扩展到目录与二进制 |
| 幂等 | 内容等价跳过 | 沿用，且不改 mtime |
| 回滚 | 备份目录 | 写前快照 + 一键还原 |
| 凭据 | 导出时模式扫描 | 双端拦截 + 文件名黑名单 + 大小闸 |
| 界面 | 命令行 | 设置页面板 + 进度 + 结果卡 |

## 16. 不做的事

- 不自建 DSH 官方账号体系，不复用官方账号 token；账号只用于取 `accountKey`。
- 不在插件内内置共享存储凭据：共享凭据只允许存在于运营方服务端。
- 不同步会话，不把 `node_modules` 打进包。
- 不做实时文件监听（避免半新半旧状态与竞态）。
- 不做合并式同步；只按「新覆盖旧」，且每次覆盖前必须确认。

---

## 17. 多用户形态（B 模型）

> 2026-10-23 决定：插件面向多用户分发，数据经运营方 API 中转，最终落在运营方指定的第三方存储。

### 17.1 架构

```text
插件（HTTP 客户端） ──HTTPS──▶ 运营方 API ──WebDAV──▶ 坚果云（服务端持有一套应用密码）
      │                          │
      └─ 本地状态 state.json      └─ 鉴权 / 配额 / 隔离 / 审计 / 限流 / 清理
```

- **存储后端：坚果云（服务端持有一套账号与应用密码）**，插件侧不接触任何存储凭据。
- **按平台账号 id 分区**：WebDAV 路径 `/dav/dsh-user-sync/<accountKey>/<packageId>.tar.gz`；`accountKey = sha256(官方账号 id)[0..15]`，由服务端按 token 解析，客户端不能指定他人分区。
- **插件侧没有 WebDAV 客户端**：只实现 HTTP 客户端，§6 的 `Transport` 抽象保留，实现换成 `api`。
- **服务端是新的信任边界**：它能读所有用户数据，必须配套审计与最小权限。

### 17.2 接口草案（插件 ↔ 运营方 API）

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/v1/auth/register` | 用 DSH 官方 `accountKey` 注册：首次出现时建账号并签发**唯一 token**；已存在时返回 `409`（改用 `login`），不建第二个账号 |
| `POST` | `/v1/auth/login` | 用同一 `accountKey` 取回**同一个 token**（不签发新 token，不绑定设备）；账号被吊销时 `409` |
| `POST` | `/v1/auth/reset` | 作废旧 token + 删除我的全部数据 + 允许同一 `accountKey` 重新注册（二次确认） |
| `GET` | `/v1/packages` | 列出**我的**包：`{ id, size, createdAt, platform, deviceId, dshVersion }` |
| `GET` | `/v1/packages/:id/meta` | 只读 manifest（自动检查不下载整包） |
| `GET` | `/v1/packages/:id` | 下载包（`packageId` 校验、额度扣减） |
| `PUT` | `/v1/packages/:id` | 上传包（幂等；`id` 必须是 `packageId` 格式） |
| `DELETE` | `/v1/packages/:id` | 删除包（用户删除权） |
| `DELETE` | `/v1/me` | 删除我的全部包与账号数据（二次确认） |
| `GET` | `/v1/export` | 导出我的全部数据（当前即当前包 + 元数据）→ tar.gz |
| `GET` | `/v1/quota` | 已用/上限 |

服务端职责：token 鉴权、按 `accountKey` 分区、配额、限流、审计日志、旧包清理。`accountKey` 只出现在 `register` / `login` / `reset`，不进入其他请求与包内。

**账号模型（2026-10-23 决定）**：一个 `accountKey` 只对应**一个账号、一个 token**，不签发多设备 token。新设备用 `login` 取回同一个 token 即可 — 这正是「新设备登录同一账号即可看到同账号的包，无需手填配对」（§6.2）的实现方式。代价：token 无法单独轮换，泄露只能走 `reset`（清空数据后重注册）；`accountKey` 等同密码，公开分发前需加第二因子（邀请码/邮箱）。

**`register` / `login` 由插件自动调用，不是用户操作**：插件从 `deepseekAccount.getProfile().value.id` 派生 `accountKey` 后自动换 token；界面上只有「已配对 / 未登录官方账号」两种状态，**不提供注册、登录运营方账号的入口**。

### 17.3 版本记录（结论）

**要记录**（属于「插件」模块本体，不需要额外采集）：

- `package.json`：`dependencies` 声明版本 + `dsh.profile.bundles` 启用顺序
- `pnpm-lock.yaml`：精确版本与 integrity
- `cordis.patch.yml`：哪些插件被配置
- `manifest` 级：`dshVersion`、`platform`、`arch`
- 可选：每个插件 `node_modules/<pkg>/package.json` 的 `engines.dsh`，用于新机器上的兼容提示

**不记录**：设备名、系统用户名、绝对路径、插件使用次数、会话内容。

### 17.4 已定（2026-10-23）

| 事项 | 决定 |
|---|---|
| 未登录 | **必须登录官方账号才能用云端**；未登录仅本地模式（打包 + 本机应用） |
| 配额 | **1 份 / 单包 10 MiB / 总量 50 MiB** |
| 保留 | **远端只存 1 份**，上传即覆盖；回滚靠本地 `pre-restore` 快照 |
| 删除权 | 删单包 + **删除我的全部数据**（`DELETE /v1/me`，二次确认） |
| 隐私同意 | **首次使用弹窗确认**（上传目录、存储位置、保留策略），拒绝则保持本地模式 |
| 部署 | **国内云服务器**（需备案） |
| 计费 | **免费 + 邀请码** |
| 第二因子 | MVP **暂不加**；公开分发前再评估 |

### 17.5 `accountKey` 作为身份的残余风险

| 风险 | 说明 |
|---|---|
| 不可验证 | 服务端无法证明调用者真的持有该官方账号；知道 `accountKey` 即可访问 |
| 不可轮换 | `accountKey` 由官方账号 id 派生，泄露后只能更换官方账号；单 token 也无法单独吊销，只能 `reset` 清空数据后重注册 |
| 抢注 | 首次注册前，他人可抢先绑定该 `accountKey` |
| 泄露面 | 可能出现在截图、日志、错误报告、第三方插件里 |

缓解（全部要落地）：

1. **包内不写 `accountKey`**（§7.1 已落实）；日志与错误信息只显示前 6 位。
2. 注册后签发 token，后续请求只用 token；`accountKey` 只在 `register` / `login` / `reset` 出现。
3. **一个 `accountKey` 只对应一个账号与一个 token**：已注册的 accountKey 再次注册返回 `409`；新设备用 `login` 取回同一个 token，不签发新 token。吊销只能走 `reset`（清空数据后重注册）。
4. 全量读写审计；同一 `accountKey` 多 IP 高频访问告警。
5. 提供「重置身份」：清空远端数据并重新注册（用户主动，旧数据删除）。
6. 分发文档明示：`accountKey` 等同密码，不要外传、不要贴进对话。

**结论**：该方案适用于小范围可信分发；一旦公开分发，应增加邮箱或邀请码作为第二因子（可先预留字段，不改变接口）。

### 17.6 坚果云单账号的约束

| 约束 | 影响 | 缓解 |
|---|---|---|
| 流量配额 | 多用户共享会打满（免费版额度很小，专业版按 30GB/月起） | 每用户 1 份包、单包上限 10 MiB、每用户总量上限 50 MiB；超限拒绝上传并提示 |
| 并发/限流 | 多人同时上传可能 429 | 服务端写队列串行化 + 指数退避；同一账号同期限 1 并发 |
| 条款 | 把一个账号共享给多用户使用，可能违反个人版条款 | 分发前确认；用户量上来后换企业版或对象存储 |
| 目录删除 403 | 清理不能删目录（§2 第 12 条实测） | 只删文件；空 `accountKey` 目录保留 |
| 单点故障 | 账号被封或限流则全员不可用 | 接口与存储解耦（`Transport`），可切换后端 |

**容量估算**：每用户 1 份 × 2 MB 平均 = 2 MB；100 用户约 200 MB。按「每日上传一次 × 100 用户 × 2 MB」估算约 6 GB/月流量，需专业版容量并持续监控。

### 17.7 账号迁移与数据导出

- **导出**：设置页「导出我的数据」→ `GET /v1/export` 下载 tar.gz（当前包 + manifest + 状态摘要）。执行「删除我的全部数据」前，强制提示先导出。
- **换官方账号**：`accountKey` 随账号变化，旧数据无法用新身份访问；服务端**不提供跨账号转移**（防越权）。流程：旧账号登录 → 导出或删除 → 新账号登录 → 重新上传。
- **丢失官方账号**：没有第二因子，数据不可恢复。这是 §17.5 建议公开分发前加第二因子的直接原因。

---

## 18. 工程约定（2026-10-24 固化）

### 18.1 编程语言

- **插件与服务端源码统一 TypeScript**：插件 `src/*.ts` 经 `tsc` 构建为 `lib/*.js`；服务端 `server/src/*.ts` 构建为 `server/dist/*.js`；DSH 与 systemd 始终加载**构建产物**。
- **运行时零依赖不变**：`typescript` 与 `@types/node` 只进 devDependencies。
- **脚本语言**：跨平台辅助脚本用 Node ESM（`scripts/*.mjs`）；PowerShell（`scripts/*.ps1`）只用于 Windows 安装、卸载与冒烟。
- **不引入**：其他语言运行时、打包器、测试框架（测试用 `node:test` + `node:assert`）。

### 18.2 构建与产物

- `npm run build`（插件）、`npm run build:server`（服务端）；`tsc` 无额外构建工具。
- 源码 import 写 `.ts` 扩展名（`rewriteRelativeImportExtensions: true`），产物自动改写为 `.js`；源码因此可被 Node 24 直接运行（测试跑源码）。
- **构建产物提交进版本库**：`lib/`（junction 安装后 DSH 直接加载）、`server/dist/`（部署产物）；`node_modules/` 与锁文件忽略。
- 测试跑 `src/*.ts`（源码），不依赖构建；构建产物由 DSH 热重载与真实 API 验证。

### 18.3 自然语言

- 文档、代码注释、日志文案、提交信息、UI 文案：**中文**。
- 标识符、API 名、命令、报错原文：**英文，不翻译**。

**插件恢复的边界（2026-10-24 实测）**：同步只恢复声明文件（`package.json` / lock），真正的安装由 DSH 的 `pluginManager.installBundle` 完成；若 `node_modules` 被手动删除但 `node_modules/.modules.yaml` 仍记录该包，pnpm 会认为「已安装」，此时 `installBundle` 返回成功但不会重装，需要 `pnpm install --force` 或清理 `.modules.yaml` 记录。真实换机（新 profile 无该记录）不会遇到。

**发布约定**：npm 发布（`scripts/publish.mjs`）的时机由维护者决定，agent 只做准备（改版本、构建、dry-run），不自动发布；与 git 提交一样，发布前单独确认。

### 18.4 迁移状态

- 2026-10-24 完成类型化：`src/`（17 个）与 `server/src/`（7 个）的 `@ts-nocheck` 已**全部移除**，各模块补了显式类型（纯函数 → 同步编排 → 宿主入口 → client bundle → 服务端）。
- 宿主服务边界在 `src/host.ts` 定义最小接口：`ConnectionLike` / `PluginManagerLike` / `ConfigEditorLike` / `DeepseekAccountLike`，以及请求体与检查负载（`ConfigBody` / `ConsentBody` / `InstallBody` / `ApplyBody` / `CheckPayload`）。
- client 用 `ReactLike`（createElement/useState/useEffect）、`ChangeEventLike` / `ClickEventLike`、领域负载（`StatusPayload` / `ScanPayload` / `CheckPayload`）替代 `any`；`Window.__ModuleLoader__` 在文件内声明。
- archive 定义 `RawManifest` / `RawManifestFile`；服务端定义 `AccountInput`、`ServerJson` 与 `PackageMeta.manifest`。
- **`strict: true` 已开启**（插件与服务端均 0 错误）；**显式 `any` 已全部消除**（全仓 grep 0 处）。
