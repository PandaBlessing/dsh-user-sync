# 测试报告：管理后台上传/下载统计、包列表分页、插件统计分页、zip 下载

- 执行日期：2026-11-12
- 用例清单：`docs/test-cases-admin-stats.md`（74 条，A–J）
- 设计文档：`docs/design-admin-stats-download.md`（v4）
- 代码仓库：`H:\work\dsh\dsh-user-sync`（服务端 + 客户端）+ `H:\work\go\dsh-admin`（后台）

## 0. 结论

| 项 | 结果 |
|---|---|
| 服务端 e2e（`%TEMP%\dsh-admin-debug\e2e.mjs`） | 21 / 21 通过 |
| 服务端边界用例（`%TEMP%\dsh-admin-debug\e2e-extra.mjs`） | 12 / 12 通过 |
| 后台接口（登录 / 同步统计 / 包列表代理 / zip 代理） | 4 / 4 通过 |
| 前端 UI 自动化（Playwright + 系统 Edge） | 19 / 19 通过 |
| 用例清单覆盖 | 37 条实测通过，37 条未覆盖（原因见 §5） |
| 构建 | 服务端 tsc、host tsc、client 打包、`go build ./...`、`pnpm build:prod` 全部 0 错误 |
| 静态检查 | `eslint` 0 error；`pnpm type-check` 仅 1 个既有错误（见 §4） |

本地实测环境：MySQL 3306（MariaDB 11.4）、同步服务端 10001（`node server/dist/index.js`，数据目录 `%TEMP%\dsh-admin-debug\data`）、后台 10002（`go run . server -c config/settings.local.dev.yml`）、前端 9527（vite dev）。

## 1. 服务端 e2e（21 条，全通过）

| 检查项 | 结果 | 说明 |
|---|---|---|
| 注册 / 登录 | 通过 | 201 / 200，token 可用 |
| 上传包 | 通过 | 201，manifest 正常 |
| GET 包（无自定义头） | 通过 | 200，且 `downloads` 不变 |
| GET 包（`x-dsh-sync-client: 1`） | 通过 | `downloads +1` |
| `/v1/admin/usage` 扩展字段 | 通过 | `totalUploads` / `totalDownloads` / `accountStats` / `largest[].uploads` 均存在 |
| `/v1/admin/packages` 分页 | 通过 | 默认 50，`limit/offset/total` 正确 |
| `/v1/admin/packages` 排序 | 通过 | `uploads_desc` 生效 |
| 列表不再返回 `pluginStats` | 通过 | 字段已移除 |
| `limit=0` 全量 | 通过 | 返回全部 |
| 非法 `limit` | 通过 | 回退默认（TC-I04 修复后） |
| `/v1/admin/plugin-stats` | 通过 | `{items,total}`，默认 100 |
| zip 下载 | 通过 | `application/zip`、`content-disposition: attachment; filename="dsh-user-sync-a1b2c3-20261112-2000-abc123.zip"`、PK 魔数 |
| zip 内容 | 通过 | 解压含 `profiles/desktop/package.json`、`skills/demo/SKILL.md`，manifest 已过滤 |
| 无包 zip | 通过 | 404 |
| 无 adminKey | 通过 | 401 |

## 2. 服务端边界用例（12 条，全通过）

| 用例 | 结果 | 实测值 |
|---|---|---|
| TC-A02 401 上传不计数 | 通过 | 401 后 `uploads` 不变 |
| TC-A03 空包拒绝不计数 | 通过 | `E_EMPTY_PACKAGE`，计数不变 |
| TC-A05 连续 3 次上传 +3 | 通过 | 1 → 4 |
| TC-A06 两账号隔离 | 通过 | A 4→4、B 0→1 |
| TC-A07 超大包 413 不计数 | 通过 | 11MB → 413，计数不变 |
| TC-B04 无包下载不计数 | 通过 | 404，计数不变 |
| TC-C04 两次同步不重复累加 | 通过 | 后台库 4 = 上游 4 |
| TC-D03 并列排序稳定 | 通过 | 同值时按 accountKey 有序 |
| TC-I03 非法 sort 回退 | 通过 | 200，默认排序 |
| TC-I04 非法 limit 回退 | 通过 | 200，默认 50 |
| TC-F03 插件统计分页 | 通过 | total=42，第 1 页 42 条、offset=100 时 0 条 |
| TC-F05 插件统计排序 | 通过 | `accounts_desc` 生效，条目含账号前缀列表 |

## 3. 后台接口与前端 UI（23 条，全通过）

后台接口：

| 检查项 | 结果 |
|---|---|
| `POST /api/v1/login` | 通过 |
| `POST /api/v1/monitor/sync-stats` | 通过，`{"code":200,"data":{"synced":3}}` |
| `GET /api/v1/monitor/sync-stats` | 通过，字段小写 `syncedAt`（见 §4 修复记录） |
| `/api/v1/admin/packages` 代理 | 通过，`total` 与 uploads/downloads 正常 |
| zip 经代理 | 通过，`application/zip`、PK 魔数 |

前端 UI（19 项）：登录跳转、同步包页四列与两按钮、分页、同步统计反馈（「统计已同步（3 个账号）」）、统计刷新时间小字（「统计刚刚刷新」）、详情抽屉四项统计 + zip 按钮、首页两张总次数卡、容量页两张总次数卡、插件统计页分页（100/页）+ 服务端排序 + 「查看账号」弹窗（列出账号前缀 tag）。

截图：`%TEMP%\dsh-admin-debug\shots\{admin-sync,admin-sync-synced,admin-sync-drawer,dashboard,usage,plugin-stats,plugin-stats-accounts}.png`。

## 4. 构建、静态检查与本次修复记录

- 服务端：`node node_modules/typescript/bin/tsc -p server/tsconfig.json` → exit 0
- 插件 host：`node node_modules/typescript/bin/tsc -p tsconfig.json` → exit 0
- 插件 client：`corepack pnpm run build:client` → 成功（`client/client.js` 43.75 kB）
- 后台：`go build ./...` → exit 0；`corepack pnpm build:prod` → 成功
- `eslint` 本次改动文件 0 error（4 个 `vue/multi-word-component-names` 为既有 warning）
- `corepack pnpm type-check` → 1 个既有错误：`tests/unit/api/gen.spec.ts(1,29): error TS2307: Cannot find module '@/api/tools/gen'`（该文件属初始提交 `cc4b464`，与本次改动无关）

本次执行中发现并修复：

1. **TC-I04 与实现不一致**：实现原返回 400 `bad-limit`，设计文档与用例要求回退默认值。已在 `server/src/index.ts` 引入 `pageParams()`，`/v1/admin/packages`（默认 50）与 `/v1/admin/plugin-stats`（默认 100）统一改为「非法值回退、不报错」。
2. **统计行时间字段序列化成大写**：`end/app/monitor/models/sync_account_stat.go` 的 `LastUploadAt`/`LastDownloadAt`/`SyncedAt` 的 tag 写成 `comment:…"`（顶层非法 tag），导致 Go 的 struct tag 解析在 `json:"…"` 之前中断，JSON 输出字段名为 `LastUploadAt` 等；前端读 `syncedAt` 取不到值，「统计 N 分钟前刷新」不显示。已改为 `gorm:"comment:…"`，重启后台后字段为 `lastUploadAt/lastDownloadAt/syncedAt`，UI 复验通过。
3. **插件统计页缺「查看账号」**：设计 §5.4 要求该操作。已在 `listPluginStats` 返回 `accountKeys`（6 位前缀），前端新增「操作 → 查看账号」列与弹窗。

## 5. 未覆盖用例与原因（37 条）

本地只有 1 台机器、3 个测试账号、42 个插件，下列用例依赖多客户端、大数据量或外部环境，本轮**未执行**，需在预发/生产验证：

| 组 | 未覆盖用例 | 原因 |
|---|---|---|
| A | TC-A04 | 需构造无 stats 字段的历史 `accounts.json`；代码路径为 `createAccount` 初始化 + `recordUpload` 读到 `undefined` 时置 0，未实机 |
| B | TC-B03 / TC-B06 / TC-B07 / TC-B08 | 需旧版客户端（1.0.34）、nginx 反代、真实断网重试；B03 由 B02（无头不计）等价覆盖 |
| C | TC-C05 / TC-C06 / TC-C07 / TC-C08 / TC-C10 | 需停服、删除上游账号、并发触发、1000+ 账号环境；C05 代码路径为 handler 返回 500 JSON，不 panic；C07 由 `ON CONFLICT DO UPDATE`（不删行）保证；C09 本地因库迁移异常改为手工建表，迁移文件已提交，需在干净库验证 AutoMigrate |
| D | TC-D04 / TC-D06 / TC-D07 / TC-D09 / TC-D10 / TC-D11 | 需 0 / 50 / 51 条数据与越界页码；分页逻辑（`limit/offset`）已由服务端 e2e 覆盖 |
| E | TC-E01–E04 | 需 1000 个包验证 <500ms 与索引失效退化为全量读 |
| F | TC-F02 / TC-F07 / TC-F08 | 需 230 条插件与 60s 缓存命中；F06 CSV 导出按钮已实现（`limit=0` + BOM），未点击验证 |
| G | TC-G03 / TC-G04 / TC-G06 | 需接近 10MB 大包、下载中断、3 并发 |
| H | TC-H02（偏差）/ TC-H08 | 无统计时实现显示 `0`（用例期望 `—`）；多次上传后「列表一行最新包」由 TC-A05 间接覆盖 |
| I | TC-I01 / TC-I02 / TC-I05 / TC-I06 | 需停统计服务、接口 500、MySQL 断连、慢网首屏 |
| J | TC-J01 / TC-J02 / TC-J03 | 需旧客户端、旧 `accounts.json`；J03 导出 AGENTS.md 代码未改动，按回归免测 |

## 6. 已知偏差

1. **TC-H02**：从未上传/下载时列表与详情显示 `0`（含详情 `uploads ?? 0`），用例期望 `—`。`—` 仅用于 `null` 的时间字段；0 是有效计数，保留 `0` 更直观，必要时可改为 `—`。
2. **zip 实现**：设计文档写「复用 archiver」，实际为 `server/src/lib/zip.ts` 零依赖实现（CRC32 + `deflateRawSync`），避免服务端新增 npm 依赖与部署安装步骤；输出经 `Expand-Archive` 验证可解压。
3. **后台自动同步**：`sync_account_stats` 由 `StartScheduler` 启动即同步 + 每 5 分钟一次；本轮只验证「启动即同步」与「手动同步」，未等待 5 分钟 tick。
