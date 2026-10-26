# 变更记录

本文件记录设计文档与实现的可感知变化。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；首个实现发布前版本号保持 `0.x`。

## 1.0.5（2026-10-24）

### 修复

- **修复安装后 web 启动失败**：`client-modules: duplicate factory registration for "dsh-user-sync"` → `web boot: 1 entry did not activate`。根因是 client bundle 的注册 id 用了旧名 `dsh-user-sync`，与 npm 包名 `@pandablessing/dsh-user-sync` 不一致；旧 junction 与 npm 包并存（或同一 bundle 被两个 owner 加载）时同一 id 注册两次，loader 直接抛错并让整个 web boot 失败。
  - client 注册 id 改为 npm 包名（`PACKAGE_NAME` 常量，module-loader 契约：id 必须等于包名）。
  - 入口对 `duplicate factory registration` 做容错：第二次注册只记一条 warn，绝不冒泡到 web boot；其它 loader 错误照常抛出。
  - 新增 PLUG-13（id === 包名）、PLUG-14（重复注册不抛）、PLUG-15（真实错误仍抛）三条测试。
- 安装注意：升级到 1.0.5 前先移除 profile 里旧的 `dsh-user-sync` 条目（junction 或 bundles 旧名），否则会同时注册两个面板（同一 `settings.section` id）。

## [未发布] - 2026-10-24（工具链）

### 新增

- **发布凭据位置**：`scripts/publish.mjs` 从环境变量 `NPM_TOKEN` 或仓库根 `.env.local` 读 token（模板 [.env.local.example](.env.local.example)），发布时写入 `0600` 临时 npmrc、结束即删除；token 不出现在命令行参数、日志与 git 历史。支持 `--dry-run`、`--otp=`、`--tag=`，入口 `npm run publish:npm` / `npm run publish:dry`。
- `.gitignore` 增加 `.env.local` / `.env` / `*.local.npmrc`，保证本地凭据不进版本库。

## [未发布] - 2026-10-23

### 新增

- 设计文档升到 v1.4：M0 宿主事实核实与阻塞项收口（见 [docs/design.md](docs/design.md) §2 第 14–16 条）。
- [§7.8 目标机插件恢复](docs/design.md#L374-L391)：经 `pluginManager.installBundle` 按组合包逐个装回；`link:` 本地包列入手工清单；补环境变量缺失提示（「插件装了但用不了」）。
- 恢复 `legacy/`：需求反馈稿（`requirements.md`）与两个原型脚本（`dsh-profile-sync.ps1` / `.sh`），设计文档与 README 的需求来源引用重新可追溯。
- 契约核实结论落进 [§9.1](docs/design.md#L414-L430)、[§10.3](docs/design.md#L553-L590)、[§10.6](docs/design.md#L601-L610)：`slots.register` 完整签名、`connection.fetch.register` 的对象结构、`configEditor.edit` 是配置持久化入口（无独立 settings 写入服务）。
- 概览面板接入扫描/上传/同步：状态卡、模块勾选（`state.json` 持久化）、「上传用户配置」、「从远端同步」含覆盖确认与结果卡；宿主侧新增 `scan` / `config` / `upload` / `check` / `apply` 路由，`check` 返回变化计划（新增/覆盖/跳过）。
- API 传输（`lib/transport/api.js`）：`register` / `login` / `reset` / `packages` / `quota` / `meta`，token 存 `auth.json`（0600），5xx 重试 3 次、4xx 不重试，官方域名构造时拒绝；配套内存假服务器（隔离 / 配额 / 故障注入）与 11 条 API 单测。
- 自动检查调度器（`lib/scheduler.js`）：启动检查一次、按间隔检查远端元数据，只记录 `lastCheckAt` / `lastDecision`，不下载不写盘；`autoCheck` 与 `intervalHours` 可配；失败记录 `lastCheckError` 不阻塞；定时器 `unref` 不阻止进程退出。
- 官方账号自动配对（`lib/auth.js` + `lib/index.js`）：`ctx.inject(['deepseekAccount'])` 取账号 id 派生 `accountKey`，配置了 api 传输时自动 `register`（409 自动转 `login`）换 token，**界面不提供运营方账号登录/注册入口**；补 `setTransport` 运行时切换与 `transport` / `baseUrl` 配置项；设计 §9.3、§17.2 同步修正表述。
- 隐私同意与非用户级提示：首次上传前必须 `POST /consent`（未同意时 `upload` 返回 403 `E_CONSENT_REQUIRED`，面板显示同意卡并禁用上传）；首次勾选 `projectMemory` / `sessions` 时 `config` 返回 `warning`，确认后带 `confirmNonUserLevel` 重发，已提示过的模块记入 `state.warnedModules`。
- 运营方 API 服务端（`server/`）：纯 `node:http` 实现 `register` / `login` / `reset` / `packages`（list/meta/get/put/delete）/ `quota` / `export` / `delete-me`；元数据 0600 + 审计；存储抽象支持坚果云 WebDAV（凭据缺失回退本地磁盘）；配额单包 10 MiB、总量 50 MiB。已部署到 Cicada-Tencent-Dev（`/data/server/dsh-user-sync`，systemd + nginx 反代 `dsh-user-sync-test.wenzhi.info`），见 [docs/deploy.md](docs/deploy.md)，全链路实测通过。
- 新增 [docs/test-cases.md](docs/test-cases.md)：120 条测试用例（ID / 级别 / 预期 / 设计章节 / 方式），约定清单与结果物理分离（结果只进 `docs/test-results/`）。
- 测试补强（针对 2026-10-23 的 UI 事故）：启动时序测试（connection 晚到时路由延迟注册）、客户端组件交互测试（极简 React 渲染器 + fetch mock：同意卡消失、非用户级确认条、保存请求体、localStorage 兜底、500/502 故障注入）、真实 DSH 冒烟脚本 [scripts/smoke.ps1](scripts/smoke.ps1)；全量 122 条（121 通过，1 跳过）。
- 插件恢复库 [lib/plugins.js](lib/plugins.js)：`planPluginRecovery`（缺失包与 `link:`/`file:` 本地包分类）与 `installMissing`（逐个 `installBundle`、单个失败不阻塞），配 6 条单测。
- 插件恢复接入 UI：`check` 经 `pluginManager.listBundles()` 返回缺失插件计划，覆盖确认卡列出 `name@spec` 并支持「先安装缺失插件」（`POST /install`）；`link:` 包列入手工清单。
- 自动检查提醒：面板顶部横幅（`scheduler.lastDecision.action === 'pull'` 时）显示更新来源与「立即同步」，点击直接进入同步流程。
- PLUG-07 探针：注入 `configEditor` 检查本插件条目是否在 `entries()` 可见，结果写入 `state.diagnostics`，状态卡显示「诊断」行。
- 发布材料：README 重写为可交付状态（功能 / 安装 / 使用 / 服务端 / 测试 / 已知限制），`package.json` 补 `license`（MulanPSL-2.0）与 `keywords`；E2E-06 标注由 HASH-01/06 替代覆盖。
- UI 组件测试补 3 条（UI-19/20/21）：加载态、覆盖确认三态计数、锁冲突错误；用例清单 125 条（P0 66），全量 126 条测试（125 通过，1 跳过）。
- 覆盖确认卡新增「取消」按钮；补 UI-04（取消后不发起 apply）与 UI-05（`E_HASH_MISMATCH` 详情）组件测试，全量 128 条（127 通过，1 跳过）。
- 非用户级模块确认改为**弹窗**：勾选 `projectMemory` / `sessions` 时弹出遮罩对话框（确认 / 取消），替换原来的底部结果卡；删除 `module-warning` 分支。
- 同步范围选项改为**胶囊按钮**（选中态实心背景、`user-select: none`），替代复选框；文字不可被选中。
- 模块计数改为扫描**全部模块**（`ALL_MODULES`），勾选只决定打包范围；修复「取消勾选插件清单后计数显示 0」的问题。`/scan` 路由补 try/catch，`status` 增加宿主探针（文件数与分模块计数）。
- 面板计数**双数据源降级**：优先用 `status.probe.counts`（宿主同路径扫描结果），`/scan` 失败时仍能显示数量；宿主启动时把扫描结果写入 `state.diagnostics.scanAtBoot`。
- 测试日志隔离：`logPluginError` 支持 `base` 参数，`apply` 内日志跟随 `paths.dshHome`；测试不再写入真实 `plugin-error.log`。
- **修复「同步范围统计为 0」**：`connection.fetch.register` 的路由缺省 `requestBody` 时，`requestBodyMode` 返回 `undefined`，bridge 走 streaming 分支（`Readable.toWeb(req)` + `duplex: 'half'`），GET 请求在该分支抛错并被 web 层转成 **400 空响应**——面板因此拿不到 `probe`/`counts`。全部 9 个路由补 `requestBody: 'buffered'`，新增 PLUG-09 单测防回归；实测修复后 `GET /status` 200、`probe.totalFiles=11`、`counts={config:2,plugins:4,sessions:5}`。设计事实新增第 18 条。
- 覆盖审计与补测：新增 ARCH-09（manifest 缺失拒绝）、PLUG-06（`apiKeyEnv` 缺失提示，含实现）、API-11（`exportPackage`）、BOUND-04（删除 `auth.json` 登出）、UI-06（空态）；BOUND-02 / E2E-04/05/06 标注由既有测试覆盖，ARCH-10/11 与 UI-10 标注未实现。审计脚本 [scripts/audit-cases.mjs](scripts/audit-cases.mjs) 固化，126 条用例全部有记录。
- 替代换机演练改为**本地模式**（默认）：临时启动 `server/dist/index.js`（本地磁盘存储）跑 A→B 恢复，不再向真实 WebDAV 写测试账号；`--remote <baseUrl>` 仍保留真实服务端模式（会在 WebDAV 留空账号目录，需手动清理）。
- 替代换机演练 [scripts/e2e-clone.mjs](scripts/e2e-clone.mjs)：A 上传真实资产 → B 清空为初始状态 → 从远端恢复并逐字节比对，演练结束清理远端测试账号；已对真实服务端验证通过（6 文件 / 11421 字节）。
- **源码迁移 TypeScript**（2026-10-24）：插件 `src/*.ts` 经 `tsc` 构建为 `lib/*.js`，服务端 `server/src/*.ts` 构建为 `server/dist/*.js`；`type: module` + `NodeNext` + `rewriteRelativeImportExtensions`（源码 import 写 `.ts`，产物自动改写 `.js`）；测试改为直接跑源码（Node 24 type stripping），构建产物由热重载与真实 API 验证。运行时零依赖不变（`typescript` 与 `@types/node` 仅 devDependencies）。工程约定见设计 [§18](docs/design.md)。
- **类型化收尾**（2026-10-24）：移除 `src/` 与 `server/src/` 全部 `@ts-nocheck`，补齐 23 个文件的显式类型；`strict: true` 已开启且插件与服务端均 0 错误；client 用 `interface Window { __ModuleLoader__ }` 声明宿主注入点，React 与宿主事件保留显式 `any`。
- 用户级记忆归位：`~/.dsh/AGENTS.md` 从「配置」移入「用户记忆」，配置只保留 `cordis.patch.yml`；临时 skills/memories 测试数据验证后已清理。
- 文案修正：用户记忆说明改为「AGENTS.md 与 memories/ 下的用户级记忆」；会话模块按钮改为「查看 N 个会话」并优先展示标题（此前 client 渲染仍用文件路径）。
- 操作提示自动消失：完成/已保存类结果卡 3 秒后自动关闭；覆盖确认与错误卡保留。
- 服务端落实「远端只保留 1 份」：PUT 新包后删除该账号旧包（此前只写新包，导致坚果云堆积多个包）；实测上传后 packages 与 WebDAV 各只剩 1 个。
- 服务端修复 webdav 配置兼容：`secrets.json` 的 `baseUrl` 与 `url` 两种写法都认，避免部署后启动即崩。
- 修复「上传没到坚果云」：传输选择不再读 state.transport（历史设置可能把正式环境切成 folder），改为「有服务地址就走 api，否则本地目录」；实测上传 11742 字节后 WebDAV 出现新包。
- 自动保存不闪烁：saveSettings 不再占用 busy（底部按钮不 disabled 切换），保存成功显示「自动检查设置已保存」提示。
- 自动保存：移除「保存设置」按钮，自动检查开关与间隔改动后 600ms 防抖自动提交 config（失败才提示）。
- 状态卡移除「诊断」行（configEditor 可见性 / 宿主探针 / 前端 scan 不再展示）。
- 「传输与自动检查」精简为「自动检查」：隐藏传输方式与服务地址（默认 API + 内置地址），只保留开关、间隔与保存；config 仅提交 autCheck/intervalHours。
- 会话不再参与同步（2026-10-24 用户决定）：`sync.getModules/setModules` 过滤 sessions，面板隐藏会话模块；扫描行「同步范围」统计不含会话（实测 6 个 / 19,974 B）。
- 空会话过滤：会话目录内容小于 2 KiB（只有元数据、UI 不显示的空会话）不纳入同步，记 `empty-session`；实测 sessions 从 6 降为 4，与 UI 列表一致。
- 会话模块：按 `storages/workspace.json` 的 `archivedSessionIds` 排除归档会话，标题取自 `storages/session_projcache/sessions/<id>.json` 的 `title.val`，面板展开显示标题（无标题时显示「（无标题）工作区」）。
- 面板改名：设置页入口与标题从「用户同步」改为「设置同步」（`locale/zh.json` 同步）。
- 插件清单语义：`scan` 返回 profile `dependencies` 解析出的插件列表，模块计数改为插件数，展开显示 `name@spec`（含用户安装的 `@linxin666/dsh-ssh`）。
- 体积口径：`scan` 增加 `selectedFiles`/`selectedBytes`（按已勾选模块），面板扫描行显示「已选 … （全部 …）」；已选体积超过 10 MiB 时提示上传会被拒绝。
- 同步范围**文件清单**：`scan` 返回 `files`（模块 + 路径 + 大小），面板每个模块下方「查看 N 个文件」可展开具体路径、再点收起。
- **消除显式 any**（2026-10-24）：新增 [src/host.ts](src/host.ts) 定义宿主服务接口（`ConnectionLike` / `PluginManagerLike` / `ConfigEditorLike` / `DeepseekAccountLike`）与请求体/负载类型；client 用 `ReactLike`、`ChangeEventLike` / `ClickEventLike`、`StatusPayload` / `ScanPayload` / `CheckPayload` 替代 `any`；archive 定义 `RawManifest`，服务端定义 `AccountInput` / `ServerJson`。全仓 `any` 已清零。

### 1.0.25（2026-10-25）

- 插件独立性：启动时自动把当前版本写入 profile 的 `minimumReleaseAgeExclude`（如 `@pandablessing/dsh-user-sync@1.0.25`），新版本刚发布时不会因为本插件让其他插件的安装/卸载被 pnpm 冷却期策略拦住。

### 1.0.24（2026-10-25）

- 更新按钮在开发安装（junction/link）下不再尝试 pnpm add（会与链接冲突、报命令退出码 1），改为提示「当前是开发安装（link），重启 DSH 即加载最新代码」。

### 1.0.23（2026-10-25）

- 上传/同步按钮：进行中两按钮同时禁用，按当前动作显示「上传中…」/「同步中…」，完成后还原。
- 处理结果改为弹窗：上传/检查/同步的成功与失败都用弹窗展示（含详情与「知道了」按钮），不再依赖底部状态行。

### 1.0.22（2026-10-25）

- 修复内置插件页报 `loaded without registering ... via __ModuleLoader__.load`：client bundle 在浏览器里找不到 `__ModuleLoader__` 时改为显式抛错（让 client-modules 重试），不再静默跳过注册；Node 侧预检仍安全。

### 1.0.21（2026-10-25）

- 状态卡调整：服务地址从页面底部移到「版本」下一行（只读展示内置/自定义来源）；底部不再重复显示。

### 1.0.20（2026-10-25）

- 同步范围新增「智能体」模块：同步 `~/.dsh/.agent-presets/<id>/` 下的用户级 agent 预设（preset.yml、agent.cordis.yml 等），默认勾选；新增 SCAN-AGENT-01 测试。

### 1.0.19（2026-10-25）

- 修复 1.0.17 引入的更新失败：pnpm v11 的 `add` 不认识 `--no-frozen-lockfile`（报 Unknown option），已移除；只保留 `--config.minimumReleaseAge=0`。

### 1.0.18（2026-10-25）

- 更新插件完成后的「请重启 DSH」提示从底部状态行改为**弹窗**（弹窗含「知道了」按钮，不会被页面滚动或底部遮挡）。

### 1.0.17（2026-10-25）

- 「更新插件」健壮性：pnpm add 增加 `--config.minimumReleaseAge=0`（新版本刚发布时不被最小发布年龄拒绝）与 `--no-frozen-lockfile`（避免锁文件冻结阻断）；失败时面板保留 pnpm 的 stderr（最多 800 字符），可直接看到失败原因。

### 1.0.16（2026-10-25）

- 面板状态卡移除「传输 / api」一行（传输方式不再作为用户可见信息展示）。

### 1.0.15（2026-10-25）

- 修复「更新插件」按钮不真正更新：`POST /api/dsh-user-sync/update` 原走 `installBundle`（只登记 bundle、不改安装包，实测传假版本也返回成功），改为在 profile 目录执行 `pnpm add @pandablessing/dsh-user-sync@<v>`，装完校验 node_modules 里的实际版本再返回。

### 1.0.14（2026-10-25）

- 容量监控：服务端新增 `GET /v1/admin/usage`（`secrets.json` 的 `adminKey` 鉴权），返回总占用、账号数、Top 占用（accountHint 脱敏）与存储探活，供 dsh-admin 等后台监控坚果云容量。
- 上传失败友好提示：服务端错误码透传到面板（quota-exceeded / package-too-large / E_LOCKED 等给出可操作文案；其他失败提示「远端存储可能空间不足或不可用，请联系维护者」）。
- deploy.md 补充监控接口契约与 `adminKey` 配置说明。

### 1.0.13（2026-10-25）

- 修复「上次检查」结论仍显示「发现更新」：状态行按时间判定结论新鲜度——检查时间早于最近一次上传/应用时，不再展示该结论（双保险，不依赖后台重算是否成功）。
- package.json description 改为「DSH用户级配置同步插件，更新需重启DSH」。
- 新增 UI-34（上传晚于检查时不显示过期结论）。

### 1.0.12（2026-10-25）

- 「插件有新版本」提示改为卡片 + **更新插件**按钮：点击调 `POST /api/dsh-user-sync/update`，由宿主用 DSH 官方安装器 `installBundle('@pandablessing/dsh-user-sync@<version>')` 更新（只允许本插件、版本号白名单校验），完成后提示「已更新到 vX，请重启 DSH 生效」。
- 新增 UI-33（点按钮调 /update 并提示重启）与路由断言（11 条）。

### 1.0.11（2026-10-25）

- 修复「上次检查」结论过期：上传/应用成功后立刻在后台重算一次检查结论（`scheduler.runOnce()`），底部状态行不再出现「上次上传比检查新却仍显示发现更新」。
- 实测：上传前 lastDecision=push（旧包）、上传后 0.6 秒重算为 skip / in-sync。

### 1.0.10（2026-10-25）

- 移除「远端有更新」卡片（自动检查提示 + 手动同步后的详情卡）：状态统一看底部「上次上传 / 上次应用 / 上次检查」，同步前由覆盖确认弹窗负责；结果卡只保留完成/错误/本地已是最新。
- 清理随之无用的 `onApply` / `onInstallPlugins` / `installPlugins`（apply 已自动安装缺失插件）。

### 1.0.9（2026-10-25）

- 插件内更新提示：新增 `GET /api/dsh-user-sync/update-check`（查 npm registry dist-tags，30 分钟缓存、5 秒超时、失败静默），面板顶部在发现更高版本时提示升级命令；只提示不自动安装。
- 版本比较用语义化 x.y.z（只比较数字段），本地比 registry 新时不会误报。
- 新增 UI-32（更新提示渲染）并更新路由数量断言；实测 `/update-check` 返回 current=latest=1.0.8、available=false。

### 1.0.8（2026-10-25）

- 修复自动安装不生效：pnpm-workspace.yaml 的 `patchedDependencies` 条目全被摘除后会留下空键（null），pnpm 直接报错；现在连空键一起删。
- 安装期间临时摘除 `link:` / `file:` 依赖与已经是 junction 的已装包（pnpm 重装 junction 会 EPERM），装完恢复并按原目标重建链接。
- `runCommand` 失败时把 pnpm 的 stderr 写进 `user-sync/plugin-error.log`，不再只有退出码。
- 实测：删掉 `dsh-better-sidebar` 后 apply，`installed` 全部 ok:true 且目录恢复。

### 1.0.7（2026-10-25）

- 覆盖确认改为弹窗：上传遇到远端更新（`E_REMOTE_NEWER`）与从远端同步（pull/confirm）都弹出确认框，确认后才执行覆盖；结果卡只保留详情与「先安装缺失插件」。

### 1.0.6（2026-10-24）

- 同步后自动安装：`apply` 恢复声明文件后，按 manifest 的 `dependencies` 真正安装插件（此前只恢复清单不安装）。
- `upload` 把 profile 的 `dependencies` 写进 manifest，换机应用时才知道该装什么。
- `plugins` 模块收录 `patches/*.patch`：`pnpm-workspace.yaml` 的 `patchedDependencies` 缺文件会让 `pnpm install` 整体失败（`ERR_PNPM_PATCH_NOT_FOUND`）。
- 安装兜底：`link:`/`file:` 指向不存在路径、`patchedDependencies` 缺 patch 时临时摘除再安装，装完原样恢复；`installed` 校验以 `node_modules` 实际落盘为准。
- 面板结果卡展示「已安装 N 个插件 / 失败 / 需手动放回」。

### 1.0.4（2026-10-24）

- **内置默认服务地址**：`DEFAULT_BASE_URL`（`https://dsh-user-sync-test.wenzhi.info`）生效；未配置 `state.baseUrl` 时直接走运营方 API 并自动配对，不再静默落到本地目录（此前全新机器装完既无配对也无云端，与 README 声称的「默认内置」不一致）。
- **上传前检查远端更新**（G2）：`upload()` 先只读 list + meta，远端是别的设备的更新包时返回 `E_REMOTE_NEWER` 并附包名与时间；面板结果卡新增「用本机覆盖远端」按钮，确认后带 `force: true` 重试；远端就是本机上次上传/应用的包时不拦截。
- `status` / `config` 返回实际生效的 `baseUrl`、`baseUrlSource`（`default` / `user`）与实际 `transport`；面板只读显示服务地址，不再用 `state.transport` 推断。
- 自动配对改为无条件使用生效地址（此前要求 `state.transport === 'api'` 且已配 `baseUrl`，内置地址用户永远配不上）。
- **快照目录每次独立**：`pre-restore-<时间戳>-<随机>` 不再在 `createSync` 时固定，同进程连续两次应用不会互相覆盖快照（§7.5）。
- **`/install` 不再阻塞宿主**：`pnpm install --force` 由 `execFileSync` 改为 `spawn` 异步执行（超时 300 s 仍生效），装插件期间界面不再卡死。
- `check()` 取远端最新包改为按 `modifiedAt` 排序（此前依赖列表顺序，历史多包时会取到最旧）。
- `api.register()` 内部改走独立 `loginWith()`，去掉对 `this` 的依赖，解构调用不再抛错。
- 清理 `server/*.mjs` 旧实现（`index/store/config/auth/storage/*/lib/archive`），`server/package.json` 的 `main` 指向 `dist/index.js`，避免误部署旧代码。
- 测试：新增 APPLY-10、UPL-01～04、PLUG-10～12；`resolveInside` 越界用例改为平台无关（原写法只在 Windows 成立）。全量 150 条，macOS 全绿。

### 1.0.3（2026-10-24）

- 修复 macOS 上 `web boot: 1 entry did not activate @pandablessing/dsh-user-sync: import failed`：client 入口加环境守卫，Node 侧预检 import 时不再因为 `window is not defined` 抛错，浏览器内仍由 `__ModuleLoader__` 正常注册面板。

### 1.0.2（2026-10-24）

- 修复 macOS / npm 安装后启用失败（`ERR_MODULE_NOT_FOUND: Cannot find package 'dsh-user-sync'`）：`cordis.patch.yml` 的 name 与 profile bundles 改用 npm 包名 `@pandablessing/dsh-user-sync`。
- `install-dev.ps1` / `uninstall-dev.ps1` 跟随 scope，并自动创建 `node_modules/@pandablessing` 父目录。
- 新增 PLUG-10 单测：patch 的 name 必须与 `package.json` 的 name 一致，防止再次漂移。

### 1.0.1（2026-10-24）

- 服务端：上传新包后删除旧包（落实「远端只保留 1 份」）；webdav 配置兼容 baseUrl / url 两种写法。
- 插件：install 在安装后校验 node_modules，缺失时用运行时 node 跑 pnpm install --force，避免「报告成功却没落盘」。
- 面板：显示插件版本（读 package.json）、诊断行移除、操作提示 3 秒自动消失、会话不参与同步。
- 文档：README 状态行与 design 示例同步为 1.0.1；README.en 重写为实际内容。

### 修复

- 安装脚本写 `profiles/desktop/package.json` 时误用带 BOM 的 UTF-8，宿主 `JSON.parse` 失败导致 DSH 无法启动（2026-10-23 实测事故）。脚本改为无 BOM 写入 + 写后自检 + 失败自动回滚；设计新增 [§10.7 编码约束](docs/design.md#L617)，§2 补事实 17。
- client 半边 `exports.inject` 补 `['slots']`：缺少 slots 服务时 `ctx.slots` 为 undefined，client `apply` 抛 TypeError，web boot 报 `dsh-user-sync: failed` 并阻止启动（2026-10-23 实测事故）。§9.1 补「client inject 是服务名」契约，新增 `test/client.test.js` 防线。
- 插件失败不再阻止 DSH 启动：宿主 `apply` 与 client `apply` 全包 try/catch，错误写 `$DSH_HOME/user-sync/plugin-error.log`；factory 内 react 加载失败降级为空插件；`connection` 改为直接 `ctx.get` 取、不用 `ctx.inject` 等待。设计新增 [§10.8](docs/design.md#L630)。

### 变更

- 账号模型：一个 `accountKey` 只对应一个账号、一个 token；新设备用 `login` 取回同一 token，不签发多设备 token；吊销只走 `reset`。
- `config` 模块不再收录 `settings.yaml`（旧版迁移源，启动时一次性导入；设置实际写在 `cordis.patch.yml`）。
- `manifest` v2 兼容补字段映射：`files[].name` → `path`，`exportedAt` → `createdAt`（LWW 回退）。
- `plugins` 模块恢复不再依赖用户逐个手动安装；`link:` 包明确不自动处理。
- 本地偏好（模块勾选、自动同步开关/间隔）明确存 `user-sync/state.json`，不写 patch、不跨机。
- 包格式确定为 `zlib` + 手写 512 字节头（不探测系统 `tar`）。
- 用例清单按评审补 16 条缺口（审计、清理策略、删除全部数据、导出、隐私同意、首启三分支、`configEditor.entries()` 可见性等），删除与 BOUND-02 重复的 API-08，总数 111 条。
- 新增「永不收录」清单：`storages/`、`.credentials.yaml`、`.anonymous-user-id`、`lock`、`pre-restore-*` 快照。

### 移除

- `POST /v1/auth/rotate`（由 `POST /v1/auth/login` 与 `POST /v1/auth/reset` 取代）。
