# 变更记录

本文件记录设计文档与实现的可感知变化。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；首个实现发布前版本号保持 `0.x`。


### 1.0.28（2026-10-29）

- 发布版本号调整：1.0.27 在 npm 上处于 staged 未确认状态，改用 1.0.28 发布（内容与 1.0.27 相同）。

### 1.0.27（2026-10-29）

- 新增用户反馈：面板「自动检查」卡片右侧「反馈」按钮、匿名提交（类型/内容/联系方式，成功显示反馈编号，草稿本地保存）；服务端 `/v1/feedback` 与运营方接口（列表/详情/stats/单条删除/按时间清理/处理状态）。

### 1.0.26（2026-10-25）

- 服务端新增运营方接口（adminKey 鉴权）：`/v1/admin/packages`（账号包列表 + 模块分类汇总 + 全量插件使用统计）、`/v1/admin/package`（单账号详情与文件清单）、`/v1/admin/package/file`（单文件文本内容，配置/技能/用户记忆）。

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

- 运营方监控接口：服务端新增 `GET /v1/admin/usage`（`secrets.json` 的 `adminKey` 鉴权），返回总占用、账号数、Top 占用（accountHint 脱敏）与存储探活，供运营方监控坚果云容量。
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
