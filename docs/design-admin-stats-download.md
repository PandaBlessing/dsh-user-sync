# 管理后台设计文档：上传/下载统计、包列表性能、技能包下载（v3）

> 状态：设计阶段（未实现）。本版所有判断均**基于已实现代码核实**（标注 `文件:行`），不做猜测。
> 目标：`dsh-user-sync/server`（包与统计接口）+ `dsh-admin`（后端 `end/` + 前端 `front/`）。

## 0. 修订记录

| 版本 | 内容 |
|---|---|
| v1 | 初稿 |
| v2 | 评审修订（下载只算客户端、列可排序、中文标签、不做上传下载榜、分页 50、zip、不做下载全部） |
| v3 | **按实现核实重写**：统计直接同步进 MySQL（新表，不依赖 sys_user）；服务职责按实际代码归属；插件统计口径按 `manifest.dependencies`（admin.ts:75-120）；客户端未接管 `transport.get`（无 api.ts）→ 改为在 client 的 fetch 层加 header |
| v4 | **审查修正**：索引 `UNIQUE`→普通 `KEY`；统计数据源统一为扩展 `/v1/admin/usage`（删除 users-stats）；补同步包管理/首页/容量监控/插件统计四页展示设计（§5.1-5.4）+ 分页线框；zip 单包上限按 `quotaPackageBytes` 默认 10MB（原 200MB 错误）；补账号删除保留策略、列表行=账号（最新包）；测试用例独立为 `docs/test-cases-admin-stats.md` |

## 1. 上传/下载次数统计

### 1.1 定义（已核实落点）

- **上传次数**：客户端上传成功一次计 1 —— `PUT /v1/packages/:accountKey`（`server/src/index.ts` 的 packages 路由；空包拒绝在 `server/src/lib/archive.ts` 的 `E_EMPTY_PACKAGE`，不计）。
- **下载次数**：**仅客户端下载**计 1 —— 客户端 `apply` 拉取包时走的 `GET /v1/packages/:accountKey`（`server/src/index.ts`）；**后台下载不计**（后台走 `/v1/admin/packages/...`）。
- 客户端当前**没有 `api.ts`**（`transport.get` 在 `src/config.ts` 的 `apiFetch`），需在 `apiFetch` 加 `x-dsh-sync-client: 1` 头。

### 1.2 数据模型（MySQL，新表，不依赖 sys_user）

> 已核实：`dsh-admin` 的用户表是 `sys_user`（`end/app/admin/models/sys_user.go`，后台登录账号），与同步账号（accounts.json 的 `accountKey`，如 `5e15a3...`）**不是同一实体**——因此统计**不能塞进 sys_user**，新建独立表。

```sql
-- GORM 自动迁移：SyncAccountStat
CREATE TABLE sync_account_stats (
  account_key   VARCHAR(64) PRIMARY KEY,
  uploads       BIGINT NOT NULL DEFAULT 0,
  downloads     BIGINT NOT NULL DEFAULT 0,
  last_upload_at   DATETIME NULL,
  last_download_at DATETIME NULL,
  updated_at    DATETIME NOT NULL,
  KEY idx_sync_stats_uploads (uploads),
  KEY idx_sync_stats_downloads (downloads)
);
```

### 1.3 埋点（sync server，已核实路由）

| 动作 | 位置 | 计数 | 备注 |
|---|---|---|---|
| 上传成功 | `PUT /v1/packages/:accountKey` 成功分支（`server/src/index.ts`） | `uploads += 1`，`lastUploadAt = now` | 空包（E_EMPTY_PACKAGE）/哈希失败不计 |
| 客户端下载 | `GET /v1/packages/:accountKey` 成功分支（仅 `x-dsh-sync-client: 1`） | `downloads += 1`，`lastDownloadAt = now` | 后台下载（admin 路由）不计 |

统计持久化：写入 accounts.json 的账号对象（`stats` 字段），串行写盘（`store` 现有 save 机制，已核实 store.ts 的 put/save）。

### 1.4 统计同步进 MySQL（已定：定时 + 手动刷新）

- **统计归属的页面 = 同步包管理（`admin-sync` 页面的账号/包列表）**；本项目**没有独立的「用户管理」**（dsh-admin 的「用户管理」是后台登录用户 sys_user，与同步无关）；
- **数据源复用现有 `GET /v1/admin/usage`**（`server/src/index.ts`，已被首页/容量监控页使用）：账号项扩展 `uploads / downloads / lastUploadAt / lastDownloadAt`（来自内存索引 + accounts.json），不新增 users-stats 接口；
- **dsh-admin 后端**用定时任务（如每 5 分钟）调用 `GET /v1/admin/usage`，`UPSERT` 进 `sync_account_stats`；同步包管理页提供独立的「同步统计」按钮触发一次同步（与列表「刷新」分开）；
- 同步包管理页列表**读 `sync_account_stats`**（按 `accountKey` 展示），排序 `ORDER BY uploads/downloads`，包信息由现有同步包接口提供；
- 排序与分页在 **MySQL 原生完成**（性能可控，无需内存排序）；
- **账号删除策略（服务器账号被删）**：MySQL 旧行**保留**（页面仍可看到历史统计，标 `已删除`）；不自动删行。

### 1.5 后台展示（中文标签，位于同步包管理页）

- 同步包管理页（`admin-sync`）的账号/包列表新增两列：**上传次数**、**下载次数**（`sortable="custom"`，MySQL 排序）；
- 账号详情弹窗：
  - **上传次数**、**下载次数**、**最后上传时间**、**最后下载时间**（`fmtTime`）；
- 降级：统计同步失败时列显示 `—`，并提示「统计服务不可用」。

## 2. 同步包/列表性能（已核实）

### 2.1 瓶颈（代码事实）

- `listAdminPackages`（`server/src/admin.ts:98-122`）：遍历 `store.listAccounts()` → 每账号读包 → 计算 `pluginStats`（**每次请求全量**）；
- 无分页：前端 `getPackages()` 拿全量；
- 包数据在 accounts.json 单文件（大账号量下读写放大）。

### 2.2 优化

1. **内存索引**：sync server 启动构建 `packageIndex`（accountKey → 包摘要列表），上传/删除增量更新；`/v1/admin/packages` 读索引（不再逐包 IO）；
2. **分页 50**：`GET /v1/admin/packages?limit=50&offset=0&sort=createdAt_desc`，返回 `{ items, total }`；
3. **排序**：创建时间/大小/文件数（内存排序，50 条内无压力）。

### 2.3 插件统计排行（已核实口径）

- 口径（`server/src/admin.ts:75-120`）：`manifest.dependencies` 的键 = 插件包名；`accounts` = 引用该插件的不同账号数（`Set<accountKey>` 去重）；
- 新增 `GET /v1/admin/plugin-stats?limit=100&offset=0&sort=accounts_desc`：从内存索引聚合，分页 **100/页**，返回 `{ items, total }`；
- `/v1/admin/packages` **不再返回 pluginStats**；
- 前端插件统计页改调 `getPluginStats()`，分页 100/页 + 服务端排序；CSV 导出走全量（`limit=0`）。

## 3. 技能包下载（已核实）

### 3.1 详情页下载单个技能包（zip）

- 入口：同步包详情弹窗 → 「下载」；
- 接口：`GET /v1/admin/packages/:accountKey/download?format=zip`（**sync server**，admin key）→ zip；
- 实现：读取该账号最新包（tar.gz）→ 用 `server/src/lib/archive.ts` 的 `parseTarGz` 解出文件 → 逐文件写入 zip（按原目录结构：`skills/`、`dsh-skills/` 等）；
- 依赖：`archiver`（新增到 `server/package.json`）；
- 空包/不存在：404 + 「暂无同步包」；
- 文件名：`dsh-user-sync-<accountKey 前6位>-<packageId>.zip`。

### 3.2 不做

- **不做「下载所有技能包」**（v2 评审移除）。

## 4. 接口变更清单（按服务归属，已核实）

| 接口 | 服务 | 变更 |
|---|---|---|
| `PUT /v1/packages/:accountKey` | sync server | 计数 `uploads` |
| `GET /v1/packages/:accountKey` | sync server | 仅 `x-dsh-sync-client: 1` 计 `downloads` |
| `GET /v1/admin/packages` | sync server | 分页 50 + sort + 内存索引；**不再返回 pluginStats** |
| `GET /v1/admin/plugin-stats` | sync server | **新增**（100/页，缓存 60s） |
| `GET /v1/admin/usage` | sync server | **扩展**：账号项加 `uploads / downloads / lastUploadAt / lastDownloadAt`（首页/容量监控/MySQL 同步共用） |
| `GET /v1/admin/packages/:accountKey/download?format=zip` | sync server | **新增**（zip） |

## 5. 前端改动（dsh-admin）

| 页面 | 改动 |
|---|---|
| 同步包管理（`admin-sync`） | 列表新增「上传次数/下载次数」列（可排序，MySQL）；详情弹窗中文四项 + 「下载技能包」；刷新按钮；统计降级 `—`；包列表分页 50 |
| 首页（`dashboard`） | metric 区新增「上传次数（总）/下载次数（总）」两卡；服务监控表新增两列（可排序）——数据来自扩展后的 `/v1/admin/usage` |
| 容量监控（`monitor/usage`） | metric 区新增两卡；账号表新增两列（可排序，数据同上） |
| 插件统计（`plugin-stats`） | 改调 `getPluginStats()`，分页 100/页 + 服务端排序；CSV 全量 |
| 时间显示 | 统一 `fmtTime`（已有） |

## 5.1 展示效果设计（同步包管理页）

### 列表页（改造后）

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ 同步包管理                          [刷新] [同步统计] [导出 AGENTS.md]        │
│                                                                  统计 12:05 刷新│
├──────┬────────────┬──────────┬────────┬────────┬───────┬────────┬──────┤
│ 账号 ▲│上传次数 ⬍  │下载次数 ⬍│ 生成时间│ 大小   │文件数 │ 插件数 │ 操作 │
├──────┼────────────┼──────────┼────────┼────────┼───────┼────────┼──────┤
│5e15a3│    27      │    9     │11-12 09:│1.2 MB  │  38   │   9    │ 查看 │
│...   │    —       │    —     │...     │        │       │        │ 查看 │
└──────┴────────────┴──────────┴────────┴────────┴───────┴────────┴──────┘
┌──────────────────────────────────────────────────────────────────────────────┐
│ 共 12 条            ‹  1  2  3  ›           每页 [50 ▾]    跳至 [__] 页 [Go] │
└──────────────────────────────────────────────────────────────────────────────┘
```

- 列宽建议：账号 110、上传次数 100、下载次数 100、生成时间 170、大小 100、文件数 80、插件数 80、操作 80；
- **列表行 = 账号（显示该账号的最新包信息）**；账号有多个历史包时，列表仍一行（最新包），`uploads` 为累计次数；
- **分页栏**：`el-pagination`（`layout="total, prev, pager, next, sizes, jumper"`），默认 50/页；切页/改页大小 → 重新请求（服务端 `limit/offset`）；
- 「上传次数/下载次数」表头带排序箭头（`sortable="custom"`，点击 → 服务端 `sort=uploads_desc` 等）；
- 数值列右对齐、等宽字体；统计未同步成功时显示灰色 `—`，hover 提示「统计服务不可用，点击刷新」；
- 顶部右侧小字「统计 N 秒前刷新」（= `sync_account_stats.updated_at`）+ 两个按钮：\n  - **刷新**：只重拉列表（现有行为，不改语义）；\n  - **同步统计**：触发一次从 sync server 拉取并 upsert MySQL，完成后刷新列表与时间小字（loading 态）。

### 详情弹窗（改造后）

```
┌──────────────────────────── 同步包详情 ─────────────────────────────┐
│ 包 ID          pkg-abc123           生成时间   11-12 08:59        │
│ 大小           1.2 MB               文件数     38                   │
│ 上传次数        27                   下载次数   9                   │
│ 最后上传        11-12 08:59         最后下载   11-11 20:31         │
│                                              [下载技能包(zip)]      │
├─────────────────────────────────────────────────────────────────────┤
│ 模块               文件数      大小         操作                     │
│  skills/             12       420 KB       查看内容                  │
│  dsh-skills/          9       380 KB       查看内容                  │
│  ...                                                                │
└─────────────────────────────────────────────────────────────────────┘
```

- 统计四项放描述区**第一排右侧**（与现有包 ID/大小同区，`el-descriptions` 两列布局）；
- 「下载技能包(zip)」按钮在描述区右下角；点击触发 `GET /v1/admin/packages/:accountKey/download?format=zip`，浏览器下载；
- 空值：最后上传/下载为 `—`（从未发生）。

### 交互与状态

| 状态 | 表现 |
|---|---|
| 初次加载 | 骨架 loading（表格 loading） |
| 统计加载失败 | 两列 `—` + 顶部黄条提示「统计服务不可用，点击刷新重试」 |
| 排序 | 点击表头 → `sort` 参数并发请求（服务端 MySQL 排序），保持当前页 |
| 刷新（按钮） | 清空缓存 + 重新拉列表，不触发统计同步 |`r`n| 同步统计（按钮） | 拉取 `/v1/admin/usage` → upsert MySQL → 刷新列表与「统计 N 秒前」 |`r`n| 同步统计失败 | toast 错误 + 保留旧数据 + 顶部提示 |
| 无数据 | 空状态「暂无同步包」 |
| 下载中 | 按钮 loading，失败 toast 「下载失败：<原因>」 |

## 5.2 首页（dashboard）展示

现状（`front/src/views/dashboard/index.vue`）：8 个 metric 卡（已用容量/配额占用/账号数/服务状态/用户反馈/待处理/已完成/处理中已拒绝）+ 「服务监控」divider + 账号表（账号/占用/包数/状态/创建时间/最后更新）；数据来自 `getUsage()`（`/v1/admin/usage`）+ `getProbe()` + `getFeedbackStats()`。

改造：

```
┌──────────────────────────────────────────────────────────────────────┐
│ 已用容量   配额占用   账号数   服务状态   |  上传次数(总) 下载次数(总) │
│  1.2 GB     24%       12      在线        |     271          89        │
├──────────────────────────────────────────────────────────────────────┤
│ 服务监控                                                              │
├──────┬────────┬──────┬────────┬────────────────┬────────────────┬────┤
│账号  │占用    │包数  │状态    │上传次数⬍        │下载次数⬍       │创建│
├──────┼────────┼──────┼────────┼────────────────┼────────────────┼────┤
│5e15a3│320 KB  │  1   │已上传  │      27        │      9         │... │
└──────┴────────┴──────┴────────┴────────────────┴────────────────┴────┘
┌──────────────────────────────────────────────────────────────────────┐
│ 共 12 条           ‹ 1 ›           每页 [50 ▾]                       │
└──────────────────────────────────────────────────────────────────────┘
```

- metric 区新增 2 张卡：**上传次数（总计）**、**下载次数（总计）**（与容量卡同排，数值大号、标签小字；= 各账号 `uploads/downloads` 合计，前端对 usage 账号数组求和）；
- 服务监控表新增「上传次数/下载次数」两列（`sortable="custom"`，服务端排序）；
- 数据来源：扩展后的 `GET /v1/admin/usage`（账号项含 stats）；统计失败时卡显示 `—`、列显示 `—`。

## 5.3 容量监控页（monitor/usage.vue）展示

现状：标题「dsh-user-sync 服务监控」+ 存储状态 tag + 4 metric（已用容量/配额占用/账号数/单包上限）+ 账号表（账号/占用/包数/状态/创建时间/最后更新）。

改造：

```
┌──────────────────────────────────────────────────────────────────────┐
│ dsh-user-sync 服务监控                          [存储正常] [刷新]      │
├────────┬────────┬────────┬────────┬──────────────┬──────────────┬────┤
│已用容量│配额占用│账号数  │单包上限│上传次数(总)  │下载次数(总)  │    │
│1.2 GB  │ 24%    │  12    │ 50 MB  │    271       │    89        │    │
├────────┴────────┴────────┴────────┴──────────────┴──────────────┴────┤
│ 账号（前 6 位）│ 占用 │ 包数 │ 状态 │ 上传次数⬍ │ 下载次数⬍ │ 创建 │
└──────────────────────────────────────────────────────────────────────┘
```

- metric 区新增 **上传次数（总计）**、**下载次数（总计）** 两张卡（5-6 卡自适应栅格）；
- 账号表新增「上传次数/下载次数」列（`sortable="custom"`）；
- 与首页共用同一接口（`/v1/admin/usage`），数据一致。

## 5.4 插件统计页（plugin-stats）展示

现状（`front/src/views/plugin-stats/index.vue`）：排行表格 + 「导出 CSV」+ 空数据提示。

改造：

```
┌──────────────────────────────────────────────────────────────────────────┐
│ 插件统计排行                                      [导出 CSV] [刷新]       │
├──────┬────────────────────────────┬────────────┬────────────┬───────────┤
│ 排名 │ 插件包名                    │ 账号数 ⬍   │ 占比        │ 操作      │
├──────┼────────────────────────────┼────────────┼────────────┼───────────┤
│  1   │ @pandablessing/dsh-user-sync│    12      │  48.0%     │ 查看账号   │
│  2   │ @aiwayds/dsh-feishu         │     7      │  28.0%     │ 查看账号   │
│ ...  │                             │            │            │           │
└──────┴────────────────────────────┴────────────┴────────────┴───────────┘
┌──────────────────────────────────────────────────────────────────────────┐
│ 共 230 条           ‹ 1  2  3 ›            每页 [100 ▾]  跳至 [__] 页    │
└──────────────────────────────────────────────────────────────────────────┘
```

- **分页 100/页**（默认，`el-pagination layout="total, prev, pager, next, sizes, jumper"`）；
- 「账号数」列可排序（`sortable="custom"` → 服务端 `sort=accounts_desc`）；
- 点击行/「查看账号」→ 弹窗列出引用该插件的账号（`accountHint`，6 位前缀 + 平台 tag）；
- CSV 导出全量（`limit=0`），与页面分页无关；
- 空数据：`el-empty`「暂无插件统计」（保留现有空态提示）。

## 6. 测试用例清单

**单独文件：`docs/test-cases-admin-stats.md`**（覆盖正常/临界/异常，A-J 共 10 组）。执行结果记录在 `TESTREPORT.md`，本设计文档不记录结果。

## 7. 风险

1. 计数与包写入非原子（崩溃丢 1 次）——展示用途可接受；
2. zip 打包内存——流式写入；单包上限按 `quotaPackageBytes`（服务端默认 **10 MB**，`server/src/config.ts:55`），超过即打包失败返回错误；
3. 旧客户端（<1.0.35）不带 header → 下载不计数（发版说明注明）；
4. 统计同步为 5 分钟级延迟（页面刷新按钮可即时）；
5. 本项目无「用户管理」概念：统计归属**同步包管理页**（账号即同步账号）；dsh-admin 的 sys_user 是后台登录用户，与统计无关。
