# 用户反馈（设计建议）功能设计

> 状态：设计稿（未实现）
> 目标：在插件面板「自动检查」卡片右侧提供「反馈」入口，提交到运营方，**不要求用户有 GitHub 账号**。
> 测试用例：[feedback-test-cases.md](feedback-test-cases.md)

## 1. 范围

| 项 | 说明 |
|---|---|
| 谁提 | 本插件使用者（插件面板内），匿名即可，不需要登录运营方/GitHub |
| 提什么 | 设计建议、功能建议、问题反馈、其他 |
| 存哪 | 坚果云 WebDAV：`<root>/feedback/<时间戳>-<6位随机>.json`，每条一个文件 |
| 谁看 | 运营方通过 adminKey 保护的运营方接口查看 |
| 不做什么 | 不做对话/回复（处理意见是运营方单向记录）；不做附件上传（第一版）；不收集完整账号 |

**显示条件**：入口始终显示（无论是否已点「同意并启用」、是否已配对账号）。未配对时 `accountHint` 为空。

## 2. 数据模型

```json
{
  "id": "20261027-1030-a1b2c3",
  "at": "2026-10-27T10:30:00.000Z",
  "type": "design | feature | bug | other",
  "content": "希望同步范围里能单独选某个技能包",
  "accountHint": "5e15a3",
  "pluginVersion": "1.0.26",
  "platform": "darwin-arm64",
  "contact": "",
  "context": { "modules": ["skills", "config"] },
  "status": "pending | processing | done | rejected",
  "note": "",
  "handledBy": "",
  "handledAt": ""
}
```

- `id`：`YYYYMMDD-HHmm-<6位随机>`，同一秒并发也不重名；
- `contact` 可选（用户自愿填写）；
- `accountHint` 只取账号前 6 位；未配对为空；**来源**：客户端提交时在 `context.accountHint` 里带上当前配对账号（`status.account.hint`），服务端优先取 `context.accountHint`，其次取宿主传入的 meta；
- `pluginVersion` 来自 `PLUGIN_VERSION`；`platform` 取 `navigator.platform`；
- `content` ≤2000 字符；单文件 ≤64KB。

**处理项（完整字段）：**

| 字段 | 说明 |
|---|---|
| `status` | `pending` 待处理 / `processing` 处理中 / `done` 已完成 / `rejected` 已拒绝；提交时默认 `pending` |
| `note` | 处理意见（运营方填写，≤1000 字，纯文本） |
| `handledBy` | 处理人（运营方操作者标识） |
| `handledAt` | 处理时间（ISO） |

## 3. 用户侧流程（插件面板）

**入口位置：面板「自动检查」卡片标题右侧**（与「自动检查」同一行，右对齐的小按钮「反馈」；窄屏时标题行 `flex-wrap`）。

1. 点按钮 → 弹窗：类型下拉（设计建议 / 功能建议 / 问题 / 其他）+ 内容多行输入 + 可选联系方式 + 「提交内容运营方可见，请勿填写密码/密钥」提示；
2. 内容为空时「提交」禁用；
3. 提交 → `POST /v1/feedback`；提交中按钮「提交中…」并禁用；
4. **成功（已实现）**：关闭反馈弹窗 + 弹出结果弹窗「提交成功 / 反馈已提交，感谢反馈。编号：xxx」+「知道了」；
5. **失败（已实现）**：关闭反馈弹窗 + 弹出结果弹窗「提交失败 / 原因」；输入内容已写入本地草稿，重开可恢复；
6. **草稿（已实现）**：输入内容实时写入 `localStorage`（`dsh-user-sync:feedback-draft`），提交成功后清空；
7. 离线/接口不可用不阻塞上传、同步、自动检查；
8. **错误卡「反馈此问题」入口（未实现，待定）**：计划在上传/同步失败的错误卡里加入口并预填类型与错误摘要。

## 4. 服务端接口

### 4.1 `POST /v1/feedback`（匿名）

- 请求体：`{ type, content, contact?, context? }`；`type` 枚举；`content` 非空 ≤2000 字；请求体 ≤16KB
- **限流**：按 `x-real-ip` / `x-forwarded-for` 首个地址，每分钟 ≤3 条、每小时 ≤20 条（内存计数）
- 写入：`storage.put('feedback', id, buffer)`；响应 `{ ok: true, id }`；失败 400/413/429/500
- 不记录 IP（只做内存限流）

### 4.2 `GET /v1/admin/feedback`（adminKey）

- 列出 `feedback/`（storage 增加 `list(prefix)`：PROPFIND depth 1 解析 href）
- 响应 `{ ok, total, items: [{ id, at, type, accountHint, content(截断 200), size, status, note(截断 100), handledBy, handledAt }] }`，按时间倒序
- `total` 为反馈总数（供展示）
- 一页最多 500 条（不做分页）

### 4.3 `GET /v1/admin/feedback/file?id=<id>`（adminKey）

- 返回单条完整 JSON；id 不匹配 `^[0-9]{8}-[0-9]{4}-[a-z0-9]{6}$` → 400（防路径穿越）

### 4.4 `POST /v1/admin/feedback/delete`（单条删除）

```json
{ "id": "20261027-1030-a1b2c3" }
```

- 校验 id；不存在 `{ok:true, deleted:0}`；`storage.remove('feedback', id)`
- 响应 `{ ok: true, deleted: 1 | 0 }`

### 4.5 `POST /v1/admin/feedback/delete-before`（批量清理）

```json
{ "before": "2026-10-01T00:00:00.000Z" }
```

- 列出 `at < before` 的条目 → 逐条 `storage.remove`
- 响应 `{ ok: true, deleted: N, failed: M }`；`before` 非法 → 400

### 4.6 `POST /v1/admin/feedback/status`（处理反馈）

```json
{ "id": "20261027-1030-a1b2c3", "status": "done", "note": "已记录，下个版本加", "operator": "admin" }
```

- `status` 枚举、`note` ≤1000 字
- **存储**：读-改-写该条反馈 JSON（坚果云 `feedback/<id>.json` → `storage.get` 读回 → 修改 `status/note/handledBy/handledAt` → `storage.put` 覆盖），处理意见与反馈原文存在同一个文件里，不另开文件
- 响应 `{ ok: true, item }`；不存在 404

### 4.7 `GET /v1/admin/feedback/stats`（adminKey，首页统计用）

- 列出 `feedback/` 后聚合，返回：
  ```json
  {
    "ok": true,
    "total": 12,
    "byStatus": { "pending": 5, "processing": 2, "done": 4, "rejected": 1 },
    "byType": { "design": 6, "feature": 3, "bug": 2, "other": 1 }
  }
  ```
- 轻量接口（只读 list，不读单条详情），给运营方汇总用

## 6. 安全与隐私

- 不收集完整账号、不持久化 IP；
- 内容长度校验；管理接口 adminKey；
- 内容/处理意见纯文本渲染，防 XSS；
- 弹窗提示「不要填写密码/密钥」；
- 删除（单条/批量）二次确认；处理意见单向记录（用户不可见）。

## 7. 风险与限制

| 风险 | 说明 | 缓解 |
|---|---|---|
| 垃圾/滥用 | 匿名接口可能被刷 | 内容长度 + 按真实 IP 限流 + 人工处理 |
| 反代后 IP 相同 | 直接用 socket IP 会让所有用户共用一个桶 | 用 `x-real-ip`/`x-forwarded-for` |
| 坚果云目录增长 | 每反馈一个文件 | 按时间清理（7/30/90 天或自定义） |
| 清理不可恢复 | 删除坚果云文件无法找回 | 二次确认 + 显示将删除条数 |
| 并发更新 | 单条状态读-改-写 | 单操作场景，冲突概率低；后写覆盖 |
| storage 无 list | 现有接口只有 put/get/remove | 增加 `list()`（PROPFIND） |
| 路由重名 | 目录/子页同名会报错（已踩过） | 名字分开（`FeedbackDir`/`FeedbackList`） |
| 自动检查卡片空间 | 标题右侧加按钮可能挤 | 小按钮 + 标题行 `flex-wrap` |

## 8. 工作量估算

| 部分 | 改动 | 估算 |
|---|---|---|
| 服务端 | `POST /v1/feedback`、`GET /v1/admin/feedback`、`GET .../file`、`POST .../delete`、`POST .../delete-before`、`POST .../status`、storage.list、限流 | ~400 行 |
| 插件面板 | 自动检查卡片 header 入口 + 表单弹窗 + 提交 + 编号展示 + 草稿 + 错误卡入口 | ~180 行 |
| 部署 | 服务端 dist | 一次 |

总计约 3 人日（含测试）。

## 9. 开发版服务端切换（已实现）

- **判定**：环境变量 `DSH_USER_SYNC_DEV=1`，或插件以链接/开发目录安装（真实路径不在 `node_modules` 下）→ 视为开发版；正式 npm 安装不显示；
- **控件**：面板「服务地址」行右侧小按钮，按当前地址显示「切到本地 / 切到远程」；
- **接口**：`POST /api/dsh-user-sync/switch-env { target: 'local' | 'remote' }`，仅开发版可用（否则 403）；
  - local → `http://127.0.0.1:10001`
  - remote → `DEFAULT_BASE_URL`（`https://dsh-user-sync-test.wenzhi.info`）
- **生效**：写入 `state.baseUrl` 后立即生效（下一次检查/上传/反馈即走新地址），并提示切换结果；
- **注意**：Panel 的 client bundle 变更仍需重启 DSH 才加载；host 路由变更热重载即可。

## 10. 部署状态（2026-10-29）

| 部分 | 位置 | 版本/内容 |
|---|---|---|
| 插件服务端 | 腾讯云 `/data/server/dsh-user-sync/app` | 1.0.27（含 `/v1/feedback` 全部后台接口） |
